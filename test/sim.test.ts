import { describe, expect, it } from 'vitest'
import { HBF, stackBytes } from '../src/core/hbf-spec'
import { MODELS, activeBytesPerToken, weightBytesTouched } from '../src/sim/models'
import { BLOCKS, PAGES_PER_SB, SbState, createStore, domainDies } from '../src/sim/store'
import { TRACES, makeRng, planSession, sampleQuantiles } from '../src/sim/workload'
import { createSim, suggestedLoad } from '../src/sim/sim'

const B = 1e9
const deviceBytes = stackBytes() * HBF.stacksPerGpu

describe('model profiles rebuilt from public configs', () => {
  it('match the published parameter counts', () => {
    expect(MODELS['deepseek-v3'].weightBytes / B).toBeCloseTo(671, -1)
    expect(MODELS['qwen3-235b'].weightBytes / B).toBeCloseTo(235, -1)
    expect(activeBytesPerToken(MODELS['deepseek-v3']) / B).toBeGreaterThan(35)
    expect(activeBytesPerToken(MODELS['deepseek-v3']) / B).toBeLessThan(38)
    expect(activeBytesPerToken(MODELS['qwen3-235b']) / B).toBeGreaterThan(21)
    expect(activeBytesPerToken(MODELS['qwen3-235b']) / B).toBeLessThan(23)
    // Hunyuan3 has no published total here: pin the rebuild from its config
    expect(MODELS.hunyuan3.weightBytes / B).toBeCloseTo(295, 0)
    expect(activeBytesPerToken(MODELS.hunyuan3) / B).toBeCloseTo(20.1, 1)
  })

  it('give 8-bit KV bytes per token from the attention layout', () => {
    expect(MODELS['deepseek-v3'].kvBytesPerToken).toBe(35136)
    expect(MODELS['qwen3-235b'].kvBytesPerToken).toBe(96256)
    expect(MODELS.hunyuan3.kvBytesPerToken).toBe(163840)
  })

  it('put about 20 %, 7 % and 9 % of the device in weights', () => {
    expect(MODELS['deepseek-v3'].weightBytes / deviceBytes).toBeCloseTo(0.2, 1)
    expect(MODELS['qwen3-235b'].weightBytes / deviceBytes).toBeCloseTo(0.07, 1)
    expect(MODELS.hunyuan3.weightBytes / deviceBytes).toBeCloseTo(0.09, 1)
  })

  it('touches more experts with more tokens, but never more than all of them', () => {
    const m = MODELS['deepseek-v3']
    expect(weightBytesTouched(m, 1)).toBeCloseTo(activeBytesPerToken(m), -6)
    expect(weightBytesTouched(m, 64)).toBeGreaterThan(weightBytesTouched(m, 8))
    expect(weightBytesTouched(m, 1e6)).toBeLessThanOrEqual(m.weightBytes)
  })
})

describe('workload sampler', () => {
  it('reproduces each trace’s means within 20 %', () => {
    for (const t of Object.values(TRACES)) {
      const rng = makeRng(11)
      let root = 0
      let child = 0
      let nChild = 0
      let out = 0
      let nOut = 0
      let turns = 0
      const N = 20000
      for (let i = 0; i < N; i++) {
        const p = planSession(t, rng)
        turns += p.turns.length
        root += p.turns[0].newTokens
        for (let k = 0; k < p.turns.length; k++) {
          out += p.turns[k].outputTokens
          nOut++
          if (k > 0) {
            child += p.turns[k].newTokens
            nChild++
          }
        }
      }
      expect(root / N / t.means.rootNew).toBeGreaterThan(0.8)
      expect(root / N / t.means.rootNew).toBeLessThan(1.2)
      expect(out / nOut / t.means.output).toBeGreaterThan(0.8)
      expect(out / nOut / t.means.output).toBeLessThan(1.2)
      expect(turns / N / t.means.turns).toBeGreaterThan(0.8)
      expect(turns / N / t.means.turns).toBeLessThan(1.25)
      if (nChild > 100) {
        expect(child / nChild / t.means.childNew).toBeGreaterThan(0.75)
        expect(child / nChild / t.means.childNew).toBeLessThan(1.25)
      }
    }
  })

  it('interpolates through the quantile table', () => {
    const q = [10, 20, 30, 40, 50, 60, 70, 80]
    expect(sampleQuantiles(q, 0.5)).toBe(40)
    expect(sampleQuantiles(q, 0.375)).toBeCloseTo(35, 6)
  })
})

describe('KV store', () => {
  it('stripes the weights over every die and never hands their blocks out', () => {
    const s = createStore('hbflex', MODELS['deepseek-v3'].weightBytes, 4)
    expect(s.weightRows).toBeGreaterThan(100)
    for (let d = 0; d < s.domains; d++) {
      expect(s.state[d * BLOCKS]).toBe(SbState.Weights)
      expect(s.state[d * BLOCKS + s.weightRows]).toBe(SbState.Free)
    }
    expect(s.kvPages).toBe(s.domains * (BLOCKS - s.weightRows) * PAGES_PER_SB)
  })

  it('splits every stack into domains whose dies cover it exactly once', () => {
    for (const w of [1, 4, 16] as const) {
      const seen = new Set<number>()
      for (let d = 0; d < 96 / w; d++) {
        const dies = domainDies(w, d)
        expect(dies).toHaveLength(w)
        // all dies of a domain sit in one stack
        expect(new Set(dies.map((x) => Math.floor(x / 16))).size).toBe(1)
        for (const x of dies) seen.add(x)
      }
      expect(seen.size).toBe(96)
    }
  })

  for (const policy of ['arrival', 'hbflex'] as const) {
    it(`${policy}: keeps runs, counts and free lists consistent under random traffic`, () => {
      const s = createStore(policy, MODELS['qwen3-235b'].weightBytes, 4)
      const rng = makeRng(3)
      const live: number[] = []
      let id = 0
      let t = 0
      for (let step = 0; step < 6000; step++) {
        t += 1
        if (live.length && (rng() < 0.45 || s.stats.validPages > 0.85 * s.kvPages)) {
          const k = Math.floor(rng() * live.length)
          s.invalidate(live[k], t)
          live.splice(k, 1)
        } else {
          const pages = 1 + Math.floor(rng() * 900)
          s.write(id, Math.floor(rng() * s.domains), Math.floor(t / 600), pages, t)
          live.push(id++)
        }
        s.reclaim(t)
        if (step % 1000 === 0) s.check()
      }
      s.check()
      let total = 0
      for (const r of live) total += s.pagesOf(r)
      expect(total).toBe(s.stats.validPages)
      for (let sb = 0; sb < s.state.length; sb++) {
        if (s.state[sb] === SbState.Weights) expect(s.erase[sb]).toBe(0)
      }
    })
  }

  it('arrival order copies other requests’ pages when it reclaims immediately', () => {
    const s = createStore('arrival', 0, 4)
    // two requests interleave in one domain, then the first is evicted
    s.write(1, 0, 0, 100, 0)
    s.write(2, 0, 0, 100, 1)
    s.invalidate(1, 2)
    expect(s.stats.gcPages).toBe(100)
    expect(s.stats.erases).toBe(1)
    expect(s.pagesOf(2)).toBe(100)
    s.check()
  })

  it('HBFlex marks pages invalid and leaves the erase for later', () => {
    const s = createStore('hbflex', 0, 4)
    s.write(1, 0, 0, 100, 0)
    s.write(2, 0, 0, 100, 1)
    s.invalidate(1, 2)
    expect(s.stats.gcPages).toBe(0)
    expect(s.stats.erases).toBe(0)
    expect(s.stats.validPages).toBe(100)
    s.check()
  })
})

describe('serving simulator', () => {
  it('writes exactly the KV bytes it serves, rounded up to whole stripes', () => {
    const sim = createSim({ model: 'deepseek-v3', workload: 'toC', policy: 'hbflex', seed: 5 })
    sim.run(600)
    const physical = sim.store.stats.hostPages * sim.store.stripeBytes
    expect(sim.logicalBytes()).toBeGreaterThan(0)
    // whatever is not programmed yet is still buffered in base-die SRAM
    expect(physical + sim.metrics.sramBytes).toBeGreaterThanOrEqual(sim.logicalBytes())
    // padding is at most one stripe per request; requests here are tens of MB
    expect(physical / sim.logicalBytes()).toBeLessThan(1.02)
    sim.store.check()
  })

  it('keeps up with the suggested share of every trace without dropping requests', () => {
    for (const w of ['toC', 'toB', 'coding', 'thinking'] as const) {
      const load = suggestedLoad('deepseek-v3', w)
      expect(load).toBeGreaterThan(0)
      expect(load).toBeLessThanOrEqual(1)
      const sim = createSim({ model: 'deepseek-v3', workload: w, load, seed: 5 })
      // an hour: Thinking requests decode for many minutes before they finish
      sim.run(3600)
      const m = sim.metrics
      expect(m.dropped).toBe(0)
      expect(m.queue).toBeLessThan(200)
      // decode can never beat one full weight read per iteration
      expect(m.tpot).toBeGreaterThan(0.15)
      expect(m.tpot).toBeLessThan(1.5)
      const demand = TRACES[w].reqPerSec * load * TRACES[w].means.output
      expect(m.outputTokPerSec).toBeGreaterThan(demand * 0.6)
    }
  })

  it('evicts once the KV cache fills and keeps valid data under the high-water mark', () => {
    const sim = createSim({ model: 'qwen3-235b', workload: 'toC', policy: 'hbflex', load: 1, seed: 9 })
    sim.run(3 * 3600)
    const c = sim.capacity()
    expect(c.valid).toBeLessThanOrEqual(0.91)
    expect(sim.turnovers()).toBeGreaterThan(1)
    expect(sim.store.stats.erases).toBeGreaterThan(0)
    sim.store.check()
  })

  it('erases about one block per block of data written, not many nearly empty ones', () => {
    const sim = createSim({ model: 'deepseek-v3', workload: 'toC', policy: 'hbflex', load: suggestedLoad('deepseek-v3', 'toC'), seed: 7 })
    sim.run(8 * 3600)
    const w = sim.wear()
    expect(sim.turnovers()).toBeGreaterThan(1)
    // a block erased per turnover, give or take the first fill and GC
    expect(w.mean).toBeLessThan(1.5 * sim.turnovers() + 0.5)
    sim.store.check()
  })

  it('amplifies writes more with arrival order than with HBFlex packing on the same workload', () => {
    const arrival = createSim({ model: 'qwen3-235b', workload: 'toC', policy: 'arrival', load: 1, seed: 9 })
    const hbflex = createSim({ model: 'qwen3-235b', workload: 'toC', policy: 'hbflex', load: 1, seed: 9 })
    arrival.run(3 * 3600)
    hbflex.run(3 * 3600)
    expect(arrival.waf()).toBeGreaterThan(2 * hbflex.waf())
    // at full trace load, about twice what one GPU sustains, GC copies a third extra
    expect(hbflex.waf()).toBeLessThan(1.5)
    arrival.store.check()
    hbflex.store.check()
  })

  it('never loses a page when a domain runs out of room, so write amplification stays at least 1', () => {
    // Hunyuan3 Thinking over 16 dies used to deadlock reclaim and drop terabytes
    const sim = createSim({ model: 'hunyuan3', workload: 'thinking', policy: 'hbflex', width: 16, load: suggestedLoad('hunyuan3', 'thinking', 16), seed: 3 })
    sim.run(6 * 3600)
    const st = sim.store.stats
    const physical = (st.hostPages + st.gcPages) * sim.store.stripeBytes
    expect(physical + sim.metrics.sramBytes).toBeGreaterThanOrEqual(sim.logicalBytes() * 0.999)
    expect(sim.waf()).toBeGreaterThanOrEqual(0.99)
    sim.store.check()
  })

  it('runs 1x at one simulated second per wall second, whole iterations or not', () => {
    const sim = createSim({ model: 'deepseek-v3', workload: 'toC', load: suggestedLoad('deepseek-v3', 'toC'), seed: 5 })
    sim.run(1800)
    const start = sim.now
    for (let f = 0; f < 600; f++) sim.step(1 / 60, 1, 1e9)
    expect(sim.now - start).toBeGreaterThan(9.5)
    expect(sim.now - start).toBeLessThan(10.6)
    const s2 = sim.now
    for (let f = 0; f < 60; f++) sim.step(1 / 60, 600, 1e9)
    expect(sim.now - s2).toBeGreaterThan(590)
    expect(sim.now - s2).toBeLessThan(612)
  })

  it('splits capacity into valid, awaiting erase and free, which add up', () => {
    const sim = createSim({ model: 'hunyuan3', workload: 'thinking', load: suggestedLoad('hunyuan3', 'thinking'), seed: 4 })
    sim.run(2 * 3600)
    const c = sim.capacity()
    expect(c.valid + c.reclaimable + c.free).toBeCloseTo(1, 9)
    expect(c.free).toBeGreaterThanOrEqual(0)
    expect(c.reclaimable).toBeGreaterThanOrEqual(0)
  })

  it('projects first wear-out only once it has an hour of history, from the hottest block', () => {
    const sim = createSim({ model: 'qwen3-235b', workload: 'toC', policy: 'arrival', load: 1, seed: 9 })
    sim.run(1800)
    expect(sim.wear().lifeSeconds).toBeNaN()
    sim.run(3 * 3600)
    const w = sim.wear()
    expect(w.max).toBeGreaterThan(0)
    expect(Number.isFinite(w.lifeSeconds)).toBe(true)
    // the hottest block cannot wear faster than it was erased in the window
    expect(w.rate).toBeGreaterThan(0)
    expect(w.lifeSeconds).toBeCloseTo((HBF.peCycles - w.max) / w.rate, 3)
  })
})

describe('suggested load', () => {
  // The load the scenario card calls "what one GPU sustains" must be sustained
  // for every model and workload, through the cache filling and turning over.
  for (const model of ['deepseek-v3', 'qwen3-235b', 'hunyuan3'] as const) {
    it(`is sustained by ${model} on every workload for eight hours`, () => {
      for (const w of ['toC', 'toB', 'coding', 'thinking'] as const) {
        const load = suggestedLoad(model, w)
        const sim = createSim({ model, workload: w, load, seed: 11 })
        sim.run(8 * 3600)
        expect(sim.metrics.dropped, `${model} ${w} at ${load}`).toBe(0)
        expect(sim.metrics.queue, `${model} ${w} at ${load}`).toBeLessThan(200)
        sim.store.check()
      }
    }, 180_000)
  }
})
