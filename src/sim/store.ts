import { HBF } from '../core/hbf-spec'

/* ============================================================================
 * KV STORE — where every KV page lives, on every block of the package.
 *
 * Allocation unit. OCP §11.2.2: "All banks within the same NAND die shall
 * have the same page number for maximum performance." A die therefore takes
 * a write as one multi-plane program across its 32 planes, and a block index
 * is used on all 32 planes together.
 *
 * Interleaving. OCP §4.6 and §13 leave it to the host how widely to spread
 * data over its host channels (one die per channel here). A session's KV is
 * interleaved over a *domain* of `width` dies in one stack, written in
 * lockstep, so a domain superblock is the same block index on width x 32
 * planes and a stripe-page is width x 32 x 4 KiB. Width 1 keeps a session on
 * one die; width 16 spreads it over the whole stack.
 *
 * Weights are striped over every die (OCP §13.3.1) and fill the first block
 * rows of every die. They are never erased.
 *
 * Policies (both published):
 *   arrival  all requests in a domain share one open superblock in arrival
 *            order; evicting a request reclaims every superblock it touched at
 *            once, copying the other requests' valid pages first. This is the
 *            per-request immediate reclamation HBFlex uses as its baseline.
 *   hbflex   HBFlex's lifetime-labelled packing (requests whose sessions
 *            started in the same window share superblocks) and delayed
 *            reclamation: eviction only marks pages invalid; a domain
 *            reclaims once 95 % of its KV superblocks are written, entirely
 *            invalid superblocks first, until 10 % are free.
 *
 * Free superblocks are taken in queue order and nothing here looks at erase
 * counts: this store shows what wear looks like without wear leveling.
 * ==========================================================================*/

export const DIES = HBF.stacksPerGpu * HBF.diesPerStack
export const BLOCKS = HBF.blocksPerPlane
export const PAGES_PER_SB = HBF.pagesPerBlock
/** One page on each of a die's 32 planes. */
export const DIE_STRIPE_BYTES = HBF.planesPerDie * HBF.pageBytes
/** Bytes of one block row on one die: 32 planes x 2 MiB. */
export const DIE_ROW_BYTES = PAGES_PER_SB * DIE_STRIPE_BYTES

export type InterleaveWidth = 1 | 4 | 16
export const WIDTHS: readonly InterleaveWidth[] = [1, 4, 16]

export enum SbState {
  Free = 0,
  Weights = 1,
  Open = 2,
  Closed = 3,
}

export type PolicyId = 'arrival' | 'hbflex'

export const POLICIES: Record<PolicyId, { name: string; short: string; detail: string }> = {
  arrival: {
    name: 'Arrival order, immediate reclaim',
    short: 'Arrival order',
    detail:
      'Requests share blocks in arrival order. Evicting a request erases every block it touched, copying other requests’ pages first (HBFlex’s baseline).',
  },
  hbflex: {
    name: 'HBFlex: lifetime packing, delayed reclaim',
    short: 'HBFlex packing',
    detail:
      'Sessions that started in the same 10-minute window share blocks. Eviction only invalidates pages; a domain erases once 95 % of its blocks are written (HBFlex).',
  },
}

/** HBFlex reclaim thresholds, as fractions of a domain's KV superblocks. */
export const RECLAIM_START_FREE = 0.05
export const RECLAIM_STOP_FREE = 0.1
/** Lifetime-label window for HBFlex packing, seconds. */
export const LABEL_WINDOW = 600
/**
 * Open superblocks per domain before the oldest label is closed. Sessions
 * last up to an hour, so about six 10-minute labels are live at once; fewer
 * slots close blocks nearly empty and then erase them for almost no data.
 */
export const MAX_OPEN = 8
const GC_LABEL = -1

/** Dies of a domain: stack-major, strided so a domain's dies interleave in the stack. */
export function domainDies(width: InterleaveWidth, domain: number): number[] {
  const perStack = HBF.diesPerStack / width
  const stack = Math.floor(domain / perStack)
  const k = domain % perStack
  const out: number[] = []
  for (let j = 0; j < width; j++) out.push(stack * HBF.diesPerStack + k + j * perStack)
  return out
}

export interface StoreStats {
  /** stripe-pages programmed for host KV writes (padding included) */
  hostPages: number
  /** stripe-pages programmed by garbage-collection copies */
  gcPages: number
  /** superblock erases */
  erases: number
  validPages: number
  writtenPages: number
}

export interface Store {
  readonly policy: PolicyId
  readonly width: InterleaveWidth
  readonly domains: number
  readonly stripeBytes: number
  readonly superblocks: number
  readonly weightRows: number
  readonly kvSuperblocks: number
  readonly kvPages: number
  readonly state: Uint8Array
  readonly written: Uint16Array
  readonly valid: Uint16Array
  readonly erase: Uint32Array
  readonly stats: StoreStats
  /** per-domain counters since the last drain */
  readonly domProgram: Float64Array
  readonly domErase: Float64Array
  readonly domGc: Float64Array
  /** superblocks changed since the last drain */
  readonly dirty: Int32Array
  readonly dirtyCount: number
  freeCount(domain: number): number
  write(req: number, domain: number, label: number, pages: number, now: number): number
  /** Invalidate every page of a request. Immediate-reclaim policies erase here. */
  invalidate(req: number, now: number): void
  /** Background reclamation (HBFlex). Returns erases performed. */
  reclaim(now: number): number
  pagesOf(req: number): number
  clearDirty(): void
  /** for tests: verify every internal invariant */
  check(): void
}

export function createStore(policy: PolicyId, weightBytes: number, width: InterleaveWidth = 4): Store {
  const domains = DIES / width
  const N = domains * BLOCKS
  const stripeBytes = width * DIE_STRIPE_BYTES
  const state = new Uint8Array(N)
  const written = new Uint16Array(N)
  const valid = new Uint16Array(N)
  const erase = new Uint32Array(N)
  const closedAt = new Float64Array(N)

  const weightRows = Math.min(BLOCKS - 8, Math.ceil(weightBytes / (DIES * DIE_ROW_BYTES)))
  const kvPerDomain = BLOCKS - weightRows
  const kvSuperblocks = domains * kvPerDomain
  const kvPages = kvSuperblocks * PAGES_PER_SB

  const freeQ = new Int32Array(N)
  const freeHead = new Int32Array(domains)
  const freeLen = new Int32Array(domains)
  const open: Map<number, number>[] = Array.from({ length: domains }, () => new Map())

  const stats: StoreStats = { hostPages: 0, gcPages: 0, erases: 0, validPages: 0, writtenPages: 0 }
  const domProgram = new Float64Array(domains)
  const domErase = new Float64Array(domains)
  const domGc = new Float64Array(domains)
  const dirty = new Int32Array(N)
  const isDirty = new Uint8Array(N)
  let dirtyCount = 0

  function mark(sb: number): void {
    if (isDirty[sb]) return
    isDirty[sb] = 1
    dirty[dirtyCount++] = sb
  }

  for (let d = 0; d < domains; d++) {
    for (let b = 0; b < BLOCKS; b++) {
      const sb = d * BLOCKS + b
      if (b < weightRows) {
        state[sb] = SbState.Weights
        written[sb] = PAGES_PER_SB
        valid[sb] = PAGES_PER_SB
      } else {
        freeQ[d * BLOCKS + freeLen[d]++] = b
      }
      mark(sb)
    }
  }

  /* ---- runs: (request, superblock, pages), doubly linked both ways ------------ */
  let cap = 1 << 15
  let runReq = new Int32Array(cap)
  let runSb = new Int32Array(cap)
  let runPages = new Int32Array(cap)
  let nextR = new Int32Array(cap)
  let prevR = new Int32Array(cap)
  let nextB = new Int32Array(cap)
  let prevB = new Int32Array(cap)
  const freeRuns: number[] = []
  let used = 0
  const sbHead = new Int32Array(N).fill(-1)
  const reqHead = new Map<number, number>()

  function grow(): void {
    const n = cap * 2
    const g = (a: Int32Array) => {
      const b = new Int32Array(n)
      b.set(a)
      return b
    }
    runReq = g(runReq)
    runSb = g(runSb)
    runPages = g(runPages)
    nextR = g(nextR)
    prevR = g(prevR)
    nextB = g(nextB)
    prevB = g(prevB)
    cap = n
  }

  function newRun(req: number, sb: number, pages: number): void {
    let r: number
    if (freeRuns.length) r = freeRuns.pop()!
    else {
      if (used >= cap) grow()
      r = used++
    }
    runReq[r] = req
    runSb[r] = sb
    runPages[r] = pages
    const hr = reqHead.get(req) ?? -1
    prevR[r] = -1
    nextR[r] = hr
    if (hr >= 0) prevR[hr] = r
    reqHead.set(req, r)
    const hb = sbHead[sb]
    prevB[r] = -1
    nextB[r] = hb
    if (hb >= 0) prevB[hb] = r
    sbHead[sb] = r
  }

  function unlink(r: number): void {
    const req = runReq[r]
    if (prevR[r] >= 0) nextR[prevR[r]] = nextR[r]
    else if (nextR[r] >= 0) reqHead.set(req, nextR[r])
    else reqHead.delete(req)
    if (nextR[r] >= 0) prevR[nextR[r]] = prevR[r]
    const sb = runSb[r]
    if (prevB[r] >= 0) nextB[prevB[r]] = nextB[r]
    else sbHead[sb] = nextB[r]
    if (nextB[r] >= 0) prevB[nextB[r]] = prevB[r]
    runReq[r] = -1
    freeRuns.push(r)
  }

  /* ---- free superblocks ------------------------------------------------------- */
  function takeFree(d: number): number {
    if (freeLen[d] === 0) return -1
    const b = freeQ[d * BLOCKS + freeHead[d]]
    freeHead[d] = (freeHead[d] + 1) % BLOCKS
    freeLen[d]--
    return d * BLOCKS + b
  }

  function putFree(sb: number): void {
    const d = Math.floor(sb / BLOCKS)
    freeQ[d * BLOCKS + ((freeHead[d] + freeLen[d]) % BLOCKS)] = sb % BLOCKS
    freeLen[d]++
  }

  function closeSb(sb: number, now: number): void {
    if (state[sb] !== SbState.Open) return
    const m = open[Math.floor(sb / BLOCKS)]
    for (const [k, v] of m) {
      if (v === sb) {
        m.delete(k)
        break
      }
    }
    state[sb] = SbState.Closed
    closedAt[sb] = now
    mark(sb)
  }

  function eraseSb(sb: number): void {
    let r = sbHead[sb]
    while (r >= 0) {
      const n = nextB[r]
      unlink(r)
      r = n
    }
    stats.writtenPages -= written[sb]
    stats.validPages -= valid[sb]
    written[sb] = 0
    valid[sb] = 0
    erase[sb]++
    state[sb] = SbState.Free
    stats.erases++
    domErase[Math.floor(sb / BLOCKS)]++
    putFree(sb)
    mark(sb)
  }

  function openFor(d: number, lab: number, now: number): number {
    const m = open[d]
    const cur = m.get(lab)
    if (cur !== undefined) return cur
    if (m.size >= MAX_OPEN) {
      let oldest = Infinity
      for (const k of m.keys()) if (k !== GC_LABEL && k < oldest) oldest = k
      if (oldest !== Infinity) closeSb(m.get(oldest)!, now)
    }
    const sb = takeFree(d)
    if (sb < 0) return -1
    state[sb] = SbState.Open
    m.set(lab, sb)
    mark(sb)
    return sb
  }

  const reclaiming = new Uint8Array(domains)

  /** Append pages for a request in one domain. Returns pages that did not fit. */
  function program(req: number, d: number, lab: number, pages: number, now: number, gc: boolean): number {
    let left = pages
    while (left > 0) {
      let sb = openFor(d, lab, now)
      if (sb < 0 && policy === 'hbflex' && !reclaiming[d]) {
        reclaimDomain(d, now, true)
        sb = openFor(d, lab, now)
      }
      if (sb < 0) break
      const take = Math.min(left, PAGES_PER_SB - written[sb])
      written[sb] += take
      valid[sb] += take
      stats.writtenPages += take
      stats.validPages += take
      const head = reqHead.get(req) ?? -1
      if (head >= 0 && runSb[head] === sb) runPages[head] += take
      else newRun(req, sb, take)
      if (gc) {
        stats.gcPages += take
        domGc[d] += take
      } else stats.hostPages += take
      domProgram[d] += take
      left -= take
      if (written[sb] >= PAGES_PER_SB) closeSb(sb, now)
      mark(sb)
    }
    return left
  }

  function mostFree(except: number): number {
    let best = -1
    let bestLen = 0
    for (let d = 0; d < domains; d++) {
      if (d !== except && freeLen[d] > bestLen) {
        best = d
        bestLen = freeLen[d]
      }
    }
    return best
  }

  /** Copy every valid page out of `sb` (same domain where possible), then erase it. */
  function collect(sb: number, now: number): void {
    const d = Math.floor(sb / BLOCKS)
    if (state[sb] === SbState.Open) closeSb(sb, now)
    const lab = policy === 'hbflex' ? GC_LABEL : 0
    // Detach every run first: no copy may land back in this block.
    const reqs: number[] = []
    const pages: number[] = []
    let r = sbHead[sb]
    while (r >= 0) {
      const n = nextB[r]
      reqs.push(runReq[r])
      pages.push(runPages[r])
      valid[sb] -= runPages[r]
      stats.validPages -= runPages[r]
      unlink(r)
      r = n
    }
    for (let i = 0; i < reqs.length; i++) {
      const lost = program(reqs[i], d, lab, pages[i], now, true)
      if (lost > 0) {
        const alt = mostFree(d)
        if (alt >= 0) program(reqs[i], alt, lab, lost, now, true)
      }
    }
    eraseSb(sb)
  }

  function reclaimDomain(d: number, now: number, urgent: boolean): number {
    const startAt = Math.ceil(kvPerDomain * RECLAIM_START_FREE)
    const stopAt = Math.ceil(kvPerDomain * RECLAIM_STOP_FREE)
    if (reclaiming[d] || (!urgent && freeLen[d] >= startAt)) return 0
    reclaiming[d] = 1
    try {
      let n = 0
      while (freeLen[d] < stopAt) {
        // entirely invalid closed superblocks first, oldest first
        let pick = -1
        let pickT = Infinity
        for (let b = weightRows; b < BLOCKS; b++) {
          const sb = d * BLOCKS + b
          if (state[sb] === SbState.Closed && valid[sb] === 0 && closedAt[sb] < pickT) {
            pick = sb
            pickT = closedAt[sb]
          }
        }
        if (pick >= 0) {
          eraseSb(pick)
        } else {
          // otherwise the least-valid closed superblock, if at most half valid
          let best = PAGES_PER_SB / 2 + 1
          for (let b = weightRows; b < BLOCKS; b++) {
            const sb = d * BLOCKS + b
            if (state[sb] === SbState.Closed && valid[sb] < best) {
              pick = sb
              best = valid[sb]
            }
          }
          if (pick < 0) break
          collect(pick, now)
        }
        n++
      }
      return n
    } finally {
      reclaiming[d] = 0
    }
  }

  /* ---- public ------------------------------------------------------------------ */
  function write(req: number, d: number, lab: number, pages: number, now: number): number {
    const useLabel = policy === 'hbflex' ? lab : 0
    let left = program(req, d, useLabel, pages, now, false)
    if (left > 0) {
      const alt = mostFree(d)
      if (alt >= 0) left = program(req, alt, useLabel, left, now, false)
    }
    return left
  }

  function invalidate(req: number, now: number): void {
    const touched: number[] = []
    let r = reqHead.get(req) ?? -1
    while (r >= 0) {
      const n = nextR[r]
      const sb = runSb[r]
      valid[sb] -= runPages[r]
      stats.validPages -= runPages[r]
      touched.push(sb)
      mark(sb)
      unlink(r)
      r = n
    }
    if (policy === 'arrival') {
      for (const sb of touched) {
        if (state[sb] === SbState.Free) continue
        if (valid[sb] === 0) {
          if (state[sb] === SbState.Open) closeSb(sb, now)
          eraseSb(sb)
        } else collect(sb, now)
      }
    }
  }

  function reclaim(now: number): number {
    if (policy !== 'hbflex') return 0
    let n = 0
    for (let d = 0; d < domains; d++) n += reclaimDomain(d, now, false)
    return n
  }

  function pagesOf(req: number): number {
    let s = 0
    for (let r = reqHead.get(req) ?? -1; r >= 0; r = nextR[r]) s += runPages[r]
    return s
  }

  function check(): void {
    let v = 0
    let w = 0
    let free = 0
    for (let sb = 0; sb < N; sb++) {
      if (state[sb] === SbState.Weights) continue
      if (valid[sb] > written[sb]) throw new Error(`sb ${sb}: valid ${valid[sb]} > written ${written[sb]}`)
      if (written[sb] > PAGES_PER_SB) throw new Error(`sb ${sb}: overfull`)
      let s = 0
      for (let r = sbHead[sb]; r >= 0; r = nextB[r]) s += runPages[r]
      if (s !== valid[sb]) throw new Error(`sb ${sb}: runs ${s} != valid ${valid[sb]}`)
      if (state[sb] === SbState.Free) {
        free++
        if (written[sb] !== 0) throw new Error(`sb ${sb}: free but written`)
      }
      v += valid[sb]
      w += written[sb]
    }
    let queued = 0
    for (let d = 0; d < domains; d++) queued += freeLen[d]
    if (queued !== free) throw new Error(`free queue ${queued} != free blocks ${free}`)
    if (v !== stats.validPages) throw new Error(`validPages ${stats.validPages} != ${v}`)
    if (w !== stats.writtenPages) throw new Error(`writtenPages ${stats.writtenPages} != ${w}`)
  }

  return {
    policy,
    width,
    domains,
    stripeBytes,
    superblocks: N,
    weightRows,
    kvSuperblocks,
    kvPages,
    state,
    written,
    valid,
    erase,
    stats,
    domProgram,
    domErase,
    domGc,
    dirty,
    get dirtyCount() {
      return dirtyCount
    },
    freeCount: (d) => freeLen[d],
    write,
    invalidate,
    reclaim,
    pagesOf,
    clearDirty() {
      for (let i = 0; i < dirtyCount; i++) isDirty[dirty[i]] = 0
      dirtyCount = 0
    },
    check,
  }
}
