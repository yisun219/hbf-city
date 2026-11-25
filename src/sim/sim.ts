import { GPU_COMPUTE, HBF } from '../core/hbf-spec'
import { MODELS, activeBytesPerToken, weightBytesTouched } from './models'
import type { ModelId, ModelProfile } from './models'
import { LABEL_WINDOW, createStore } from './store'
import type { InterleaveWidth, PolicyId, Store } from './store'
import { TRACES, makeRng, nextArrival, planSession, sampleQuantiles } from './workload'
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
 * request flushes its last partial stripe padded. A stripe the store cannot
 * place yet stays in SRAM and is retried; nothing is dropped.
 *
 * At high speed the loop advances K identical iterations per step, so time
 * resolution coarsens but every byte written and erased is still counted.
 * While the batch has room, a step never runs past the next arrival, so
 * time to first token does not depend on playback speed.
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
 * Share of a trace's traffic one GPU sustains with HBFlex packing, with room
 * to spare. A small model of the same iteration the simulator runs, solved
 * for its fixed point at each candidate load:
 *   batch      decode requests in flight = request rate x output tokens x
 *              iteration time (Little's law); their mean context is biased
 *              toward long outputs, which stay in the batch longer
 *   iteration  the larger of compute and the slowest domain's work: its
 *              share of the weights, its sessions' KV reads and programs
 *              (the slowest domain carries more than the mean; fewer
 *              sessions per domain, more imbalance), the prefill chunk's KV
 *              programmed on one or two domains, and GC copies
 * The load is the largest that keeps the batch under 60 % of its slots and
 * prefill under 75 % of one chunk per iteration, counting re-prefill by
 * evicted sessions. The traces come from a fleet, not one GPU; the tests run
 * every model and workload at this load for eight hours.
 */
export function suggestedLoad(
  modelId: ModelId,
  workload: WorkloadId,
  width: InterleaveWidth = DEFAULT_SIM.width,
  maxBatch = DEFAULT_SIM.maxBatch,
): number {
  const m = MODELS[modelId]
  const tr = TRACES[workload]
  const kv = m.kvBytesPerToken
  const chunk = DEFAULT_SIM.prefillChunk
  const dies = HBF.stacksPerGpu * HBF.diesPerStack
  const domains = dies / width
  const domRead = width * DIE_READ_BPS
  const domProgram = width * DIE_PROGRAM_BPS
  const flops = GPU_COMPUTE.fp8Flops * GPU_COMPUTE.utilisation
  const active = activeBytesPerToken(m)
  const childPerSec = Math.max(0, tr.reqPerSec - tr.rootPerSec)
  const prefillPerReq = (tr.rootPerSec * tr.means.rootNew + childPerSec * tr.means.childNew) / tr.reqPerSec
  // Long outputs stay in the batch longer, so the batch's mean context is
  // length-biased: input + E[out^2] / (2 E[out]), from the trace's quantiles.
  let m1 = 0
  let m2 = 0
  for (let i = 0; i < 2000; i++) {
    const out = sampleQuantiles(tr.outputQ, (i + 0.5) / 2000)
    m1 += out
    m2 += out * out
  }
  const context = tr.means.input + m2 / (2 * m1)

  const fits = (load: number): boolean => {
    const lambda = tr.reqPerSec * load
    const prefillRate = lambda * prefillPerReq * REPREFILL_MARGIN
    let t = 0.1
    for (let k = 0; k < 60; k++) {
      const batch = lambda * tr.means.output * t
      const prefill = Math.min(chunk, prefillRate * t)
      const perDomain = Math.max(1, batch / domains)
      const imbalance = 1 + IMBALANCE / Math.sqrt(perDomain)
      // a chunk is one or two requests' prompts, landing on that many domains
      const chunkDomains = Math.max(1, Math.min(domains, prefill / prefillPerReq))
      const weights = weightBytesTouched(m, batch + prefill) / (dies * DIE_READ_BPS)
      const kvRead = ((batch / domains) * context * kv * imbalance) / domRead
      const program = ((batch / domains) * kv * imbalance + (prefill * kv) / chunkDomains) / domProgram
      const gc = ((GC_COPIES * (batch + prefill) * kv * imbalance) / domains) * (1 / domRead + 1 / domProgram)
      const next = Math.max((2 * active * (batch + prefill)) / flops, weights + kvRead + program + gc) + LAUNCH_S
      if (Math.abs(next - t) < 1e-6) break
      t = next
      if (t > 10) return false
    }
    return lambda * tr.means.output * t <= BATCH_SHARE * maxBatch && prefillRate * t <= 0.75 * chunk
  }
  let load = 1
  while (load > 0.05 && !fits(load)) load -= 0.01
  return Math.round(load * 100) / 100
}

/** Re-prefill by evicted sessions that return, on top of fresh prompts. */
const REPREFILL_MARGIN = 1.3
/** Slowest domain over the mean, scaled by 1 / sqrt(sessions per domain): contexts are heavy-tailed. */
const IMBALANCE = 4
/** GC bytes copied per KV byte written once the cache is full (HBFlex WAF up to about 1.7 here); each is read and programmed. */
const GC_COPIES = 0.7
/** Decode slots the steady state may fill: iterations slow as the cache fills, and the batch grows with them. */
const BATCH_SHARE = 0.6

/** Bytes per second one die (32 planes) senses at 4 µs per page. */
export const DIE_READ_BPS = (HBF.planesPerDie * HBF.pageBytes) / (HBF.readUs * 1e-6)
/** Bytes per second one die programs at 75 µs per page. */
export const DIE_PROGRAM_BPS = (HBF.planesPerDie * HBF.pageBytes) / (HBF.programUs * 1e-6)
const ERASE_S = HBF.eraseUs * 1e-6
const BLOCKS_PER_DOMAIN = HBF.blocksPerPlane
const LAUNCH_S = 0.0005
/**
 * Valid KV above this share of capacity triggers eviction down to the second.
 * HBFlex §5.4 evicts at 90 %; how far down is this simulator's choice. Evicting
 * in 5 % batches lets whole blocks go stale before GC at 95 %: stopping at
 * 89 % instead raised HBFlex's WAF from 1.33 to 1.63 on Qwen3 To-C at full
 * trace load. The cost is bursty GC, which the Live panel averages over
 * TAU_SLOW.
 */
export const EVICT_HIGH = 0.9
export const EVICT_LOW = 0.85
/** Arrivals beyond this queue length are turned away and counted. */
const MAX_QUEUE = 4000
/** Longest stretch of simulated time one batch step may cover. */
const MAX_STEP_S = 2
/** Smoothing of the bursty rates (GC copies, erases): a sustained rate, not the last burst. */
const TAU_SLOW = 300
/**
 * Wear projection: the hottest block's average erase rate since the KV cache
 * had been written over WEAR_SETTLE_TURNOVERS times (which leaves out the first
 * fill), shown once WEAR_MIN_S of that has passed. Checked every WEAR_SAMPLE_S.
 */
const WEAR_SETTLE_TURNOVERS = 2
const WEAR_MIN_S = 2 * 3600
const WEAR_SAMPLE_S = 300
/**
 * The hottest blocks' rate is measured on the mean of this many most-erased
 * blocks: a single maximum grows by one or two erases in a few hours, too
 * coarse to project from.
 */
const WEAR_TOP = 16

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
  /** EMAs over about 20 s of simulated time (GC copies and erases: about 5 minutes) */
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
  /** erases per second of the most-erased blocks (mean of the top WEAR_TOP) since the cache settled; NaN until WEAR_MIN_S after that */
  rate: number
  /** projected seconds until the most-erased block reaches the P/E limit; NaN without enough history */
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
  /**
   * Shares of KV capacity: valid pages; pages that need an erase before they
   * can be written again (invalid pages and the unwritten tails of closed
   * blocks); and free pages (erased blocks and open blocks' tails).
   */
  capacity(): { valid: number; reclaimable: number; free: number }
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
  /** simulated seconds the clock owes the wall clock; negative when ahead */
  let owed = 0
  let refusedSeen = 0
  /** finished requests whose last KV is still in SRAM because the store had no room */
  let stalled: Request[] = []
  /** when the wear projection starts, and the hottest blocks' mean erase count then */
  let wearStart = NaN
  let wearStartTop = 0
  let wearChecked = -Infinity
  const topBuf = new Float64Array(WEAR_TOP)
  /** mean erase count of the WEAR_TOP most-erased KV superblocks */
  function topMean(): number {
    topBuf.fill(0)
    const er = store.erase
    const weightRows = store.weightRows
    for (let sb = 0; sb < store.superblocks; sb++) {
      if (sb % BLOCKS_PER_DOMAIN < weightRows) continue
      const e = er[sb]
      if (e <= topBuf[WEAR_TOP - 1]) continue
      // insert into the descending top list
      let i = WEAR_TOP - 1
      while (i > 0 && topBuf[i - 1] < e) {
        topBuf[i] = topBuf[i - 1]
        i--
      }
      topBuf[i] = e
    }
    let sum = 0
    for (let i = 0; i < WEAR_TOP; i++) sum += topBuf[i]
    return sum / WEAR_TOP
  }

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
  /** Exponential average; early on it spans the time elapsed, so it starts near the true mean. */
  function ema(cur: number, sample: number, dt: number, tau = TAU): number {
    const a = 1 - Math.exp(-dt / Math.min(tau, Math.max(now, dt)))
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
    const left = store.write(r.id, r.s.domain, r.s.label, pages, now)
    const done = pages - left
    // a padded final stripe empties the buffer; refused stripes stay staged
    if (left === 0) r.pend = final ? 0 : r.pend - pages * stripe
    else r.pend -= done * stripe
    writeDom[r.s.domain] += done * stripe
  }

  /* ---- eviction ------------------------------------------------------------------- */
  function evict(): void {
    const cap = store.kvPages
    // A refused write means no domain could take it: GC cannot free space that
    // valid data hold, so evict a little more even below the high-water mark.
    const pressure = store.stats.refusedPages > refusedSeen || stalled.length > 0
    refusedSeen = store.stats.refusedPages
    if (store.stats.validPages <= EVICT_HIGH * cap && !pressure) return
    const target = pressure ? Math.min(EVICT_LOW * cap, store.stats.validPages - 0.005 * cap) : EVICT_LOW * cap
    for (const [id, s] of lru) {
      if (store.stats.validPages <= target) break
      if (s.running > 0) continue
      for (const rid of s.reqs) store.invalidate(rid, now)
      // KV of an evicted session that never reached flash is no longer needed
      for (const r of stalled) if (r.s === s) r.pend = 0
      s.reqs.length = 0
      s.resident = false
      lru.delete(id)
    }
    if (stalled.length) stalled = stalled.filter((r) => r.pend > 0)
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
    let K = Math.max(1, Math.min(4096, Math.floor(Math.min(maxSpan, MAX_STEP_S) / t)))
    if (running.length < o.maxBatch) {
      const next = Math.min(nextRoot, heap.length ? heap[0].t : Infinity)
      if (next > now) K = Math.max(1, Math.min(K, Math.ceil((next - now) / t)))
    }
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
        // the prefill pass produces the first output token, at the end of the
        // iteration that consumed this request's last prompt token
        r.firstAt = now + t * Math.ceil((K * chunk - budget) / Math.max(1, chunk))
        if (r.out > 0) outTok++
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

    // retry staged KV of finished requests first, oldest first
    if (stalled.length) {
      for (const r of stalled) flush(r, true)
      stalled = stalled.filter((r) => r.pend > 0)
    }
    for (const r of finished) {
      if (r.state === RState.Done) continue
      flush(r, true)
      if (r.pend > 0) stalled.push(r)
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
      const gcBytes = store.domGc[d] * stripe
      backlog[d] += gcBytes / domReadBps + gcBytes / domProgramBps + store.domErase[d] * ERASE_S
      // GC reads and programs occupy the dies too, so they show in their activity
      domRead[d] += gcBytes
      domWrite[d] += gcBytes
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
    metrics.gcBps = ema(metrics.gcBps, ((store.stats.gcPages - gcBefore) * stripe) / span, span, TAU_SLOW)
    metrics.erasesPerSec = ema(metrics.erasesPerSec, (store.stats.erases - erBefore) / span, span, TAU_SLOW)
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
      sampleWear()
    }
  }

  function sampleWear(): void {
    if (!Number.isNaN(wearStart) || now - wearChecked < WEAR_SAMPLE_S) return
    wearChecked = now
    if ((store.stats.hostPages + store.stats.gcPages) / store.kvPages >= WEAR_SETTLE_TURNOVERS) {
      wearStart = now
      wearStartTop = topMean()
    }
  }

  function refreshGauges(): void {
    metrics.batch = running.length
    metrics.queue = waiting.length
    metrics.dropped = dropped
    let sram = 0
    for (const r of running) sram += r.pend
    for (const r of stalled) sram += r.pend
    metrics.sramBytes = sram
  }

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
      // Whole iterations overshoot the frame; owing time back keeps 1x at 1x.
      // The cap stops a slow machine from piling up a debt it can never pay.
      owed = Math.min(owed + dtWall * speed, Math.max(2 * dtWall * speed, MAX_STEP_S))
      if (owed > 0) advanceTo(now + owed, performance.now() + budgetMs)
      owed -= now - start
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
      let freePages = store.openTailPages()
      for (let d = 0; d < domains; d++) freePages += store.freeCount(d) * store.pagesPerSuperblock
      const valid = store.stats.validPages / store.kvPages
      const free = freePages / store.kvPages
      return { valid, reclaimable: Math.max(0, 1 - valid - free), free }
    },
    wear() {
      const mean = store.stats.erases / Math.max(1, store.kvSuperblocks)
      const max = store.stats.maxErase
      // The first block to wear out is the most-erased one: project from how
      // fast the most-erased blocks have been erased since the cache settled.
      if (Number.isNaN(wearStart) || now - wearStart < WEAR_MIN_S) return { mean, max, rate: NaN, lifeSeconds: NaN }
      const rate = (topMean() - wearStartTop) / (now - wearStart)
      const lifeSeconds = rate > 0 ? Math.max(0, HBF.peCycles - max) / rate : Infinity
      return { mean, max, rate, lifeSeconds }
    },
    logicalBytes() {
      return logical
    },
  }
}

