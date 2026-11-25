/* ============================================================================
 * WORKLOAD — synthetic LLM-serving sessions calibrated to production traces.
 *
 * The statistics below were computed from the anonymized Qwen-Bailian usage
 * traces released with Wang et al., "KVCache Cache in the Wild" (USENIX ATC
 * 2025): four 2-hour traces of consumer chat (To-C), business API calls
 * (To-B), coding and reasoning ("thinking") requests. Only summary statistics
 * are embedded, not trace records.
 *
 *   rootPerSec   sessions started per second
 *   turns        follow-up turns form a session; quantiles of turns/session
 *   rootNew      prompt tokens of a session's first request
 *   childNew     new prompt tokens of a follow-up (its input minus the
 *                parent's input and output, which the child extends)
 *   output       generated tokens per request
 *   gap          seconds from a parent request's arrival to its follow-up
 *
 * Quantiles are at P = 5, 10, 25, 50, 75, 90, 95, 99 %. Sampling inverts a
 * piecewise-linear CDF through them, so the synthetic workload matches the
 * trace's distribution shapes, not its exact sequence.
 * ==========================================================================*/

export type WorkloadId = 'toC' | 'toB' | 'coding' | 'thinking'

export const QUANTILE_P = [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99] as const

export interface TraceStats {
  id: WorkloadId
  name: string
  description: string
  rootPerSec: number
  reqPerSec: number
  turnsQ: readonly number[]
  rootNewQ: readonly number[]
  childNewQ: readonly number[]
  outputQ: readonly number[]
  gapQ: readonly number[]
  /** trace means; `input` is the whole prompt including reused context */
  means: { rootNew: number; childNew: number; output: number; turns: number; input: number }
}

export const TRACES: Record<WorkloadId, TraceStats> = {
  toC: {
    id: 'toC',
    name: 'To-C chat',
    description: 'consumer chat, multi-turn',
    rootPerSec: 3.209,
    reqPerSec: 5.981,
    turnsQ: [1, 1, 1, 1, 2, 4, 5, 8],
    rootNewQ: [71, 76, 163, 749, 1488, 5468, 8085, 13193],
    childNewQ: [13, 14, 17, 23, 48, 201, 439, 1750],
    outputQ: [51, 81, 209, 375, 551, 808, 1032, 1641],
    gapQ: [19.2, 27.1, 50.3, 110.6, 291.1, 718.5, 1151.7, 2207.3],
    means: { rootNew: 1737, childNew: 109, output: 430, turns: 1.86, input: 2331 },
  },
  toB: {
    id: 'toB',
    name: 'To-B API',
    description: 'business API calls, single turn',
    rootPerSec: 24.0,
    reqPerSec: 24.0,
    turnsQ: [1, 1, 1, 1, 1, 1, 1, 1],
    rootNewQ: [115, 172, 281, 574, 1195, 1720, 2491, 6294],
    childNewQ: [0, 0, 0, 0, 0, 0, 0, 0],
    outputQ: [1, 3, 12, 39, 94, 180, 328, 1006],
    gapQ: [0, 0, 0, 0, 0, 0, 0, 0],
    means: { rootNew: 915, childNew: 0, output: 92, turns: 1, input: 915 },
  },
  coding: {
    id: 'coding',
    name: 'Coding',
    description: 'coding assistant, long prompts',
    rootPerSec: 3.668,
    reqPerSec: 5.975,
    turnsQ: [1, 1, 1, 1, 2, 3, 4, 9],
    rootNewQ: [58, 170, 801, 4157, 11536, 12951, 13458, 14172],
    childNewQ: [14, 16, 23, 55, 290, 1142, 2034, 5212],
    outputQ: [32, 53, 139, 469, 995, 1789, 2699, 5835],
    gapQ: [2.6, 6.1, 42.9, 117.7, 348.0, 941.8, 1608.8, 3483.7],
    means: { rootNew: 5678, childNew: 418, output: 808, turns: 1.63, input: 5748 },
  },
  thinking: {
    id: 'thinking',
    name: 'Thinking',
    description: 'reasoning, long outputs',
    rootPerSec: 1.337,
    reqPerSec: 1.503,
    turnsQ: [1, 1, 1, 1, 1, 1, 2, 5],
    rootNewQ: [100, 293, 751, 3287, 3704, 12492, 14296, 24167],
    childNewQ: [0, 0, 0, 34, 192, 2411, 5839, 10562],
    outputQ: [197, 433, 958, 1665, 3443, 9156, 12666, 34529],
    gapQ: [3.5, 5.0, 10.6, 28.6, 90.0, 254.9, 448.7, 1532.2],
    means: { rootNew: 4311, childNew: 793, output: 3651, turns: 1.12, input: 4763 },
  },
}

/** Inverse CDF through the quantile table; tails extend to 0.6x / 1.3x the outer quantiles. */
export function sampleQuantiles(q: readonly number[], u: number): number {
  const p = QUANTILE_P
  if (u <= p[0]) return q[0] * (0.6 + 0.4 * (u / p[0]))
  for (let i = 1; i < p.length; i++) {
    if (u <= p[i]) {
      const t = (u - p[i - 1]) / (p[i] - p[i - 1])
      return q[i - 1] + (q[i] - q[i - 1]) * t
    }
  }
  const t = (u - p[p.length - 1]) / (1 - p[p.length - 1])
  const last = q[q.length - 1]
  return last + last * 0.3 * t
}

/** Deterministic 32-bit PRNG (mulberry32). */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface SessionPlan {
  /** new prompt tokens and output tokens per turn; turn 0 is the root */
  turns: { newTokens: number; outputTokens: number; gap: number }[]
}

export function planSession(stats: TraceStats, rng: () => number): SessionPlan {
  const n = Math.max(1, Math.round(sampleQuantiles(stats.turnsQ, rng())))
  const turns: SessionPlan['turns'] = []
  for (let i = 0; i < n; i++) {
    const newTokens = Math.max(1, Math.round(sampleQuantiles(i === 0 ? stats.rootNewQ : stats.childNewQ, rng())))
    const outputTokens = Math.max(1, Math.round(sampleQuantiles(stats.outputQ, rng())))
    const gap = i === 0 ? 0 : Math.max(0.5, sampleQuantiles(stats.gapQ, rng()))
    turns.push({ newTokens, outputTokens, gap })
  }
  return { turns }
}

/** Exponential inter-arrival time for a Poisson process. */
export function nextArrival(ratePerSec: number, rng: () => number): number {
  return ratePerSec <= 0 ? Infinity : -Math.log(1 - rng()) / ratePerSec
}
