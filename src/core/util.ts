/** Small math / formatting helpers shared across the whole app. */

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

export const easeInOutCubic = (t: number) => {
  const x = clamp(t, 0, 1)
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2
}

/** Frame-rate independent exponential approach. `rate` ~ how much closes per second. */
export const damp = (current: number, target: number, rate: number, dt: number) =>
  current + (target - current) * (1 - Math.exp(-rate * dt))

/** Deterministic 32-bit PRNG (mulberry32): the same package every reload. */
export function makeRng(seed = 0x5eed1e) {
  let a = seed >>> 0
  return function rng(): number {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/* ------------------------------ accessibility ---------------------------- */

/**
 * Live "the visitor asked for less motion" flag.
 *
 * CSS already honours the preference for transitions, but the camera flights
 * and the tour's fly-throughs are JavaScript. Read once, kept current by the
 * media query's change event, so callers can consult it every frame for free.
 */
let _reduceMotion = false
if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
  _reduceMotion = mq.matches
  const onChange = (e: MediaQueryListEvent) => {
    _reduceMotion = e.matches
  }
  if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange)
}

export const reduceMotion = (): boolean => _reduceMotion

/* ------------------------------ formatting ------------------------------ */

export function fmtBytes(b: number, digits = 1): string {
  const neg = b < 0
  let v = Math.abs(b)
  // Binary units: the arithmetic below is 1024-based, so the names must be too.
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${neg ? '-' : ''}${v.toFixed(i === 0 ? 0 : digits)} ${units[i]}`
}

/** Decimal rate, e.g. 524.3 GB/s or 3.07 TB/s. */
export function fmtRate(bytesPerSec: number): string {
  if (bytesPerSec >= 1e12) return `${(bytesPerSec / 1e12).toFixed(2)} TB/s`
  if (bytesPerSec >= 1e9) return `${(bytesPerSec / 1e9).toFixed(1)} GB/s`
  return `${(bytesPerSec / 1e6).toFixed(0)} MB/s`
}
