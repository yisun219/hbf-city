import { GPU_COMPUTE, HBF } from '../core/hbf-spec'
import { MODELS, activeBytesPerToken, weightBytesTouched } from './models'
import type { ModelId, ModelProfile } from './models'
import { LABEL_WINDOW, SbState, createStore } from './store'
import type { InterleaveWidth, PolicyId, Store } from './store'
import { TRACES, makeRng, nextArrival, planSession } from './workload'
import type { SessionPlan, TraceStats, WorkloadId } from './workload'

/* ============================================================================
 * SERVING SIMULATOR — continuous batching on a GPU whose only memory is HBF.
 *
 * Each iteration decodes one token for every running request and prefills a
 * chunk of queued prompt tokens. Its time is the slowest of:
 *   compute    2 x active parameters x tokens / (FP8 peak x utilisation)
 *   each domain  its share of the weights (striped over every die) plus the
 *              KV of the sessions interleaved on it, read at 32 planes x
 *              4 KiB per 4 µs per die; plus its KV programs at 32 x 4 KiB per
 *              75 µs per die; plus garbage-collection copies and erases left
 *              over from earlier iterations. Reads and programs share the
 *              same planes, so they add.
 * The slowest domain sets the pace.
 *
 * KV bytes collect in base-die SRAM per request and are programmed one
 * stripe (one page on each plane of the domain's dies) at a time; a finished
 * request flushes its last partial stripe padded.
 *
 * At high speed the loop advances K identical iterations per step, so time
 * resolution coarsens but every byte written and erased is still counted.
 * ==========================================================================*/

export interface SimOptions {
  model: ModelId
  workload: WorkloadId
  policy: PolicyId
  /** arrival-rate multiplier on the trace's rate */
  load: number
  /** dies a session's KV is interleaved over */
  width: InterleaveWidth
  seed: number
  maxBatch: number
  prefillChunk: number
}

export const DEFAULT_SIM: SimOptions = {
  model: 'deepseek-v3',
  workload: 'toC',
  policy: 'hbflex',
  load: 1,
  width: 1,
  seed: 7,
  maxBatch: 1024,
  prefillChunk: 2048,
}

/**
 * Share of a trace's traffic one GPU can carry at about 70 % utilisation:
 * prefill and decode compute, one weight read per decode iteration at the
 * maximum batch, and every decoded token's read of its context's KV. The
 * traces come from a fleet, not one GPU.
 */
export function suggestedLoad(modelId: ModelId, workload: WorkloadId, maxBatch = DEFAULT_SIM.maxBatch): number {
  const m = MODELS[modelId]
  const t = TRACES[workload]
  const childPerSec = Math.max(0, t.reqPerSec - t.rootPerSec)
  const prefillTok = t.rootPerSec * t.means.rootNew + childPerSec * t.means.childNew
  const decodeTok = t.reqPerSec * t.means.output
  const flops = GPU_COMPUTE.fp8Flops * GPU_COMPUTE.utilisation
  const compute = (2 * activeBytesPerToken(m) * (prefillTok + decodeTok)) / flops
  const readBps = DIE_READ_BPS * HBF.stacksPerGpu * HBF.diesPerStack
  const context = t.means.input + t.means.output / 2
  const reads = ((decodeTok / maxBatch) * weightBytesTouched(m, maxBatch) + decodeTok * context * m.kvBytesPerToken) / readBps
  const util = compute + reads
  return Math.max(0.05, Math.min(1, Math.round((0.7 / util) * 100) / 100))
}

/** Bytes per second one die (32 planes) senses at 4 µs per page. */
export const DIE_READ_BPS = (HBF.planesPerDie * HBF.pageBytes) / (HBF.readUs * 1e-6)
/** Bytes per second one die programs at 75 µs per page. */
export const DIE_PROGRAM_BPS = (HBF.planesPerDie * HBF.pageBytes) / (HBF.programUs * 1e-6)
const ERASE_S = HBF.eraseUs * 1e-6
const LAUNCH_S = 0.0005
/** Valid KV above this share of capacity triggers eviction down to the second. */
export const EVICT_HIGH = 0.9
export const EVICT_LOW = 0.85
/** Arrivals beyond this queue length are turned away and counted. */
const MAX_QUEUE = 4000
/** Longest stretch of simulated time one batch step may cover. */
const MAX_STEP_S = 2
const TOTAL_SRAM = HBF.stacksPerGpu * HBF.baseDieSramMiB * 1024 * 1024

interface Session {
  id: number
  domain: number
  label: number
  start: number
  plan: SessionPlan
  /** index of the next turn to issue */
  next: number
  /** tokens of context the next turn extends */
  ctx: number
  /** its KV is still in HBF */
  resident: boolean
  /** requests that own KV pages */
  reqs: number[]
  running: number
}

const enum RState {
  Waiting,
  Prefill,
  Decode,
  Done,
}

interface Request {
  id: number
  s: Session
  turn: number
  arrival: number
  prefill: number
  out: number
  ctx: number
  /** KV bytes held in base-die SRAM, not yet programmed */
  pend: number
  firstAt: number
  state: RState
}

interface Arrival {
  t: number
  s: Session
  turn: number
}

export interface SimMetrics {
  /** EMAs over about 20 s of simulated time */
  completedPerSec: number
  outputTokPerSec: number
  prefillTokPerSec: number
  ttft: number
  tpot: number
  iterTime: number
  batch: number
  queue: number
  dropped: number
  readBps: number
  kvWriteBps: number
  gcBps: number
  erasesPerSec: number
  sramBytes: number
  /** iteration time spent waiting on the slowest die rather than compute */
  memoryBound: number
}

export interface WearStats {
  mean: number
  max: number
  /** erases per superblock per second, recent */
  rate: number
  /** projected seconds until the most-erased block reaches the P/E limit */
  lifeSeconds: number
}

export interface Sim {
  readonly options: SimOptions
  readonly model: ModelProfile
  readonly trace: TraceStats
  readonly store: Store
  readonly now: number
  readonly metrics: SimMetrics
  /** bytes read and programmed per domain since the last drain */
  readonly domRead: Float64Array
  readonly domWrite: Float64Array
  /** weight-read share of the last iteration, 0..1 per die, for the visuals */
  readonly lastIter: { t: number; compute: number; weightBytes: number; kvBytes: number; tokens: number }
  /** effective simulated seconds per wall second over the last step */
  readonly effectiveSpeed: number
  step(dtWall: number, speed: number, budgetMs?: number): void
  /** advance exactly `seconds` of simulated time (tests) */
  run(seconds: number): void
  waf(): number
  turnovers(): number
  capacity(): { valid: number; written: number; free: number }
  wear(): WearStats
  logicalBytes(): number
}

export function createSim(opts: Partial<SimOptions> = {}): Sim {
  const o: SimOptions = { ...DEFAULT_SIM, ...opts }
  const model = MODELS[o.model]
  const trace = TRACES[o.workload]
  const store = createStore(o.policy, model.weightBytes, o.width)
  const domains = store.domains
  const stripe = store.stripeBytes
  const domReadBps = o.width * DIE_READ_BPS
  const domProgramBps = o.width * DIE_PROGRAM_BPS
  const rng = makeRng(o.seed)
  const kv = model.kvBytesPerToken
  const rootRate = trace.rootPerSec * o.load
  const flopsPerSec = GPU_COMPUTE.fp8Flops * GPU_COMPUTE.utilisation
  const activeBytes = activeBytesPerToken(model)

  let now = 0
  let nextRoot = nextArrival(rootRate, rng)
  let nextSessionId = 0
  let nextReqId = 0
  let domainCursor = 0
  let logical = 0
  let dropped = 0
  let effectiveSpeed = 0

  const heap: Arrival[] = []
  const waiting: Request[] = []
  let running: Request[] = []
  /** resident sessions in least-recently-used order (Map keeps insertion order) */
  const lru = new Map<number, Session>()
  const backlog = new Float64Array(domains)
  const domRead = new Float64Array(domains)
  const domWrite = new Float64Array(domains)
  const kvReadDom = new Float64Array(domains)
  const writeDom = new Float64Array(domains)
  const lastIter = { t: 0, compute: 0, weightBytes: 0, kvBytes: 0, tokens: 0 }

  const metrics: SimMetrics = {
    completedPerSec: 0,
    outputTokPerSec: 0,
    prefillTokPerSec: 0,
    ttft: 0,
    tpot: 0,
    iterTime: 0,
    batch: 0,
    queue: 0,
    dropped: 0,
    readBps: 0,
    kvWriteBps: 0,
    gcBps: 0,
    erasesPerSec: 0,
    sramBytes: 0,
    memoryBound: 0,
  }
  const TAU = 20
  function ema(cur: number, sample: number, dt: number): number {
    const a = 1 - Math.exp(-dt / TAU)
    return cur + (sample - cur) * a
  }

  /* ---- arrivals --------------------------------------------------------------- */
  function heapPush(a: Arrival): void {
    heap.push(a)
    let i = heap.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (heap[p].t <= heap[i].t) break
      ;[heap[p], heap[i]] = [heap[i], heap[p]]
      i = p
    }
  }
  function heapPop(): Arrival {
    const top = heap[0]
    const last = heap.pop()!
    if (heap.length) {
      heap[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < heap.length && heap[l].t < heap[m].t) m = l
        if (r < heap.length && heap[r].t < heap[m].t) m = r
        if (m === i) break
        ;[heap[m], heap[i]] = [heap[i], heap[m]]
        i = m
      }
    }
    return top
  }

  function spawnSessions(until: number): void {
    while (nextRoot <= until) {
      const s: Session = {
        id: nextSessionId++,
        domain: domainCursor,
        label: Math.floor(nextRoot / LABEL_WINDOW),
        start: nextRoot,
        plan: planSession(trace, rng),
        next: 0,
        ctx: 0,
        resident: true,
        reqs: [],
        running: 0,
      }
      domainCursor = (domainCursor + 1) % domains
      heapPush({ t: nextRoot, s, turn: 0 })
      nextRoot += nextArrival(rootRate, rng)
    }
  }

  function admitArrivals(until: number): void {
    spawnSessions(until)
    while (heap.length && heap[0].t <= until) {
      const a = heapPop()
      const s = a.s
      const turn = s.plan.turns[a.turn]
      if (waiting.length >= MAX_QUEUE) {
        dropped++
        continue
      }
      // A follow-up reuses the session's KV if it is still resident;
      // otherwise the whole context is prefilled (and written) again.
      const prefill = s.resident || a.turn === 0 ? turn.newTokens : s.ctx + turn.newTokens
      if (!s.resident) {
        s.resident = true
        s.ctx = 0
      }
      const r: Request = {
        id: nextReqId++,
        s,
        turn: a.turn,
        arrival: a.t,
        prefill,
        out: turn.outputTokens,
        ctx: s.ctx,
        pend: 0,
        firstAt: -1,
        state: RState.Waiting,
      }
      s.next = a.turn + 1
      s.running++
      s.reqs.push(r.id)
      lru.delete(s.id)
      lru.set(s.id, s)
      waiting.push(r)
    }
    while (running.length < o.maxBatch && waiting.length) {
      const r = waiting.shift()!
      r.state = RState.Prefill
      running.push(r)
    }
  }

  /* ---- KV programming --------------------------------------------------------------- */
  function flush(r: Request, final: boolean): void {
    let pages = Math.floor(r.pend / stripe)
    if (final && r.pend - pages * stripe > 0) pages++
    if (pages <= 0) return
    store.write(r.id, r.s.domain, r.s.label, pages, now)
    r.pend = Math.max(0, r.pend - pages * stripe)
    writeDom[r.s.domain] += pages * stripe
  }

  /* ---- eviction ------------------------------------------------------------------- */
  function evict(): void {
    const cap = store.kvPages
    if (store.stats.validPages <= EVICT_HIGH * cap) return
    for (const [id, s] of lru) {
      if (store.stats.validPages <= EVICT_LOW * cap) break
      if (s.running > 0) continue
      for (const rid of s.reqs) store.invalidate(rid, now)
      s.reqs.length = 0
      s.resident = false
      lru.delete(id)
    }
  }

  /* ---- one batch of K identical iterations -------------------------------------------- */
  function iterate(maxSpan: number): void {
    kvReadDom.fill(0)
    writeDom.fill(0)
    let decode = 0
    for (const r of running) {
      if (r.state === RState.Decode) {
        decode++
        kvReadDom[r.s.domain] += r.ctx * kv
        writeDom[r.s.domain] += kv
      }
    }
    // The prefill chunk is shared first-come among prefilling requests; each
    // reads its prefix KV once and writes the KV of the tokens it gets.
    let chunk = 0
    for (const r of running) {
      if (chunk >= o.prefillChunk) break
      if (r.state !== RState.Prefill) continue
      const n = Math.min(o.prefillChunk - chunk, r.prefill)
      chunk += n
      kvReadDom[r.s.domain] += r.ctx * kv
      writeDom[r.s.domain] += n * kv
    }
    const tokens = decode + chunk
    const wBytes = weightBytesTouched(model, tokens)
    const wPerDom = wBytes / domains
    let slowest = 0
    let kvBytes = 0
    for (let d = 0; d < domains; d++) {
      const t = (wPerDom + kvReadDom[d]) / domReadBps + writeDom[d] / domProgramBps + backlog[d]
      if (t > slowest) slowest = t
      kvBytes += kvReadDom[d]
    }
    const compute = (2 * activeBytes * tokens) / flopsPerSec
    const t = Math.max(compute, slowest) + LAUNCH_S
    // domains drain their backlog in the time the iteration leaves them
    for (let d = 0; d < domains; d++) {
      const busy = (wPerDom + kvReadDom[d]) / domReadBps + writeDom[d] / domProgramBps
      backlog[d] = Math.max(0, backlog[d] - Math.max(0, t - busy))
    }

    // K identical iterations: bounded by the frame, and by MAX_STEP_S so that
    // arrivals are admitted and finished requests leave the batch promptly.
    const K = Math.max(1, Math.min(4096, Math.floor(Math.min(maxSpan, MAX_STEP_S) / t)))
    const span = K * t
    writeDom.fill(0)

    let outTok = 0
    let preTok = 0
    let completed = 0
    let ttftSum = 0
    const finished: Request[] = []
    for (const r of running) {
      if (r.state === RState.Decode) {
        const n = Math.min(K, r.out)
        r.out -= n
        r.ctx += n
        r.pend += n * kv
        logical += n * kv
        outTok += n
        flush(r, false)
        if (r.out === 0) finished.push(r)
      }
    }
    let budget = K * chunk
    for (const r of running) {
      if (budget <= 0) break
      if (r.state !== RState.Prefill) continue
      const n = Math.min(budget, r.prefill)
      budget -= n
      r.prefill -= n
      r.ctx += n
      r.pend += n * kv
      logical += n * kv
      preTok += n
      flush(r, false)
      if (r.prefill === 0) {
        r.state = RState.Decode
        // the prefill pass produces the first output token
        r.firstAt = now + span * (1 - budget / Math.max(1, K * chunk))
        r.out = Math.max(0, r.out - 1)
        r.ctx += 1
        if (r.out === 0) finished.push(r)
      }
    }

    now += span
    for (let d = 0; d < domains; d++) {
      domRead[d] += K * (wPerDom + kvReadDom[d])
      domWrite[d] += writeDom[d]
    }

    for (const r of finished) {
      if (r.state === RState.Done) continue
      flush(r, true)
      r.state = RState.Done
      completed++
      ttftSum += Math.max(0, r.firstAt - r.arrival)
      const s = r.s
      s.running--
      s.ctx = r.ctx
      lru.delete(s.id)
      lru.set(s.id, s)
      if (s.next < s.plan.turns.length) {
        const gap = s.plan.turns[s.next].gap
        heapPush({ t: Math.max(r.arrival + gap, now + 0.05), s, turn: s.next })
      }
    }
    if (finished.length) running = running.filter((r) => r.state !== RState.Done)

    // GC copies and erases occupy the dies they happen on.
    const gcBefore = store.stats.gcPages
    const erBefore = store.stats.erases
    evict()
    store.reclaim(now)
    for (let d = 0; d < domains; d++) {
      backlog[d] += (store.domGc[d] * stripe) / domReadBps + (store.domGc[d] * stripe) / domProgramBps + store.domErase[d] * ERASE_S
      store.domGc[d] = 0
      store.domErase[d] = 0
    }

    metrics.iterTime = t
    metrics.tpot = ema(metrics.tpot, t, span)
    metrics.completedPerSec = ema(metrics.completedPerSec, completed / span, span)
    metrics.outputTokPerSec = ema(metrics.outputTokPerSec, outTok / span, span)
    metrics.prefillTokPerSec = ema(metrics.prefillTokPerSec, preTok / span, span)
    if (completed) metrics.ttft = ema(metrics.ttft, ttftSum / completed, span)
    metrics.readBps = ema(metrics.readBps, (K * (wBytes + kvBytes)) / span, span)
    metrics.kvWriteBps = ema(metrics.kvWriteBps, ((outTok + preTok) * kv) / span, span)
    metrics.gcBps = ema(metrics.gcBps, ((store.stats.gcPages - gcBefore) * stripe) / span, span)
    metrics.erasesPerSec = ema(metrics.erasesPerSec, (store.stats.erases - erBefore) / span, span)
    metrics.memoryBound = slowest > compute ? 1 : 0
    lastIter.t = t
    lastIter.compute = compute
    lastIter.weightBytes = wBytes
    lastIter.kvBytes = kvBytes
    lastIter.tokens = tokens
  }

  function advanceTo(target: number, deadline: number): void {
    while (now < target) {
      if (deadline && performance.now() > deadline) return
      admitArrivals(now)
      if (running.length === 0) {
        // idle: jump to the next arrival
        const next = Math.min(nextRoot, heap.length ? heap[0].t : Infinity)
        now = Math.min(target, Math.max(now, next))
        if (now >= target) break
        continue
      }
      iterate(Math.max(1e-6, (target - now) / 6))
    }
  }

  function refreshGauges(): void {
    metrics.batch = running.length
    metrics.queue = waiting.length
    metrics.dropped = dropped
    let sram = 0
    for (const r of running) sram += r.pend
    metrics.sramBytes = sram
  }

  let wearPrevTime = 0
  let wearPrevErases = 0
  let wearRate = 0

  return {
    options: o,
    model,
    trace,
    store,
    get now() {
      return now
    },
    metrics,
    domRead,
    domWrite,
    lastIter,
    get effectiveSpeed() {
      return effectiveSpeed
    },
    step(dtWall, speed, budgetMs = 12) {
      if (dtWall <= 0 || speed <= 0) return
      const start = now
      advanceTo(now + dtWall * speed, performance.now() + budgetMs)
      refreshGauges()
      effectiveSpeed = (now - start) / dtWall
    },
    run(seconds) {
      advanceTo(now + seconds, 0)
      refreshGauges()
    },
    waf() {
      return logical > 0 ? ((store.stats.hostPages + store.stats.gcPages) * stripe) / logical : 1
    },
    turnovers() {
      return (store.stats.hostPages + store.stats.gcPages) / store.kvPages
    },
    capacity() {
      return {
        valid: store.stats.validPages / store.kvPages,
        written: store.stats.writtenPages / store.kvPages,
        free: 1 - store.stats.writtenPages / store.kvPages,
      }
    },
    wear() {
      let sum = 0
      let max = 0
      let n = 0
      for (let sb = 0; sb < store.superblocks; sb++) {
        if (store.state[sb] === SbState.Weights) continue
        const e = store.erase[sb]
        sum += e
        if (e > max) max = e
        n++
      }
      const mean = n ? sum / n : 0
      const dt = now - wearPrevTime
      if (dt > 5) {
        const perSb = (store.stats.erases - wearPrevErases) / Math.max(1, n) / dt
        wearRate = wearRate === 0 ? perSb : wearRate + (perSb - wearRate) * 0.3
        wearPrevTime = now
        wearPrevErases = store.stats.erases
      }
      // The most-erased block wears at about max/mean times the average rate.
      const hot = mean > 0 ? max / mean : 1
      const life = wearRate > 0 ? (HBF.peCycles - max) / (wearRate * hot) : Infinity
      return { mean, max, rate: wearRate, lifeSeconds: life }
    },
    logicalBytes() {
      return logical
    },
  }
}

export const SRAM_BYTES = TOTAL_SRAM
