import { HBF } from '../core/hbf-spec'
import type { Palette } from '../core/theme'
import type { ThemeMode } from '../core/types'
import { PAGES_PER_SB, SbState, domainDieTable } from '../sim/store'
import type { Store } from '../sim/store'
import type { OccupancyAtlas } from './occupancy'

/* ============================================================================
 * SIM VIEW — paints the block atlas from the simulator's store.
 *
 * A store superblock is one block index on every plane of a domain's dies,
 * so painting it writes width x 32 texels. Only superblocks the store marked
 * dirty are repainted, except in the wear view, where every colour depends on
 * the current maximum and the whole atlas is repainted a few times a second.
 *
 *   state view  weights amber · open block light blue · closed blocks from
 *               blue (all pages valid) to pink (all invalid) · free grey
 *   wear view   erase count on a single-hue orange ramp (log scale) from 0 to
 *               the most-erased KV block; weight blocks, which never erase,
 *               are neutral grey and sit outside the ramp
 *
 * An erase flashes the erased block row bright for a moment, so a storm of
 * reclamation is visible exactly where it happens.
 * ==========================================================================*/

export type BlockView = 'state' | 'wear'

export interface SimView {
  mode: BlockView
  /** apply the store's dirty list (and a periodic wear repaint) */
  update(store: Store, nowMs: number): void
  repaintAll(store: Store): void
  setPalette(mode: ThemeMode, p: Palette): void
  /** erase-count range of the last wear repaint, for the legend */
  readonly wearRange: { min: number; max: number }
}

/**
 * Wear ramps, one hue each: by day light to dark, by night dark to bright, so
 * "more erases" always means "further from the background". The CSS legend
 * (--wear-0..4 in styles/app.css) mirrors these stops.
 */
const WEAR_RAMP: Record<ThemeMode, [number, number, number][]> = {
  day: [0xf3dccb, 0xeaa36f, 0xd9622b, 0xa33d12, 0x6b2408].map((h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255]),
  night: [0x3b2418, 0x7a3a18, 0xc05a22, 0xf08a3c, 0xffc38a].map((h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255]),
}
/** Weight blocks in the wear view: neutral, outside the ramp. */
const WEAR_WEIGHTS: Record<ThemeMode, number> = { day: 0x8a919b, night: 0x121821 }

let RAMP = WEAR_RAMP.night

function ramp(t: number, out: number[]): void {
  const x = Math.min(0.9999, Math.max(0, t)) * (RAMP.length - 1)
  const i = Math.floor(x)
  const f = x - i
  const a = RAMP[i]
  const b = RAMP[i + 1]
  out[0] = a[0] + (b[0] - a[0]) * f
  out[1] = a[1] + (b[1] - a[1]) * f
  out[2] = a[2] + (b[2] - a[2]) * f
}

const rgb = (hex: number): [number, number, number] => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255]

export function createSimView(atlas: OccupancyAtlas): SimView {
  let night = true
  let weights = rgb(0)
  let kv = rgb(0)
  let invalid = rgb(0)
  let openC = rgb(0)
  let free = rgb(0)
  let wearWeights = rgb(0)
  const wearRange = { min: 0, max: 0 }
  let lastWear = -Infinity
  const tmp = [0, 0, 0]
  /** erase counts as last painted, to notice erases */
  let seen = new Uint32Array(0)
  /** superblocks flashing, and when each flash ends (ms) */
  const flashing = new Map<number, number>()
  const FLASH_MS = 650
  let flashRgb = rgb(0)

  function paint(store: Store, sb: number, flash = false): void {
    const domain = Math.floor(sb / HBF.blocksPerPlane)
    const block = sb % HBF.blocksPerPlane
    const st = store.state[sb]
    let r: number
    let g: number
    let b: number
    let glow: number
    if (flash) {
      r = flashRgb[0]
      g = flashRgb[1]
      b = flashRgb[2]
      glow = 1
    } else if (view.mode === 'wear' && st !== SbState.Weights) {
      // log scale: a few hot blocks would otherwise squash everything else to blue
      const t = Math.log1p(store.erase[sb]) / Math.log1p(Math.max(1, wearRange.max))
      ramp(t, tmp)
      r = tmp[0]
      g = tmp[1]
      b = tmp[2]
      glow = 0.1 + 0.25 * t
    } else if (st === SbState.Weights) {
      const c = view.mode === 'wear' ? wearWeights : weights
      r = c[0]
      g = c[1]
      b = c[2]
      glow = view.mode === 'wear' ? 0 : 0.3
    } else if (st === SbState.Free) {
      r = free[0]
      g = free[1]
      b = free[2]
      glow = 0.015
    } else if (st === SbState.Open) {
      r = openC[0]
      g = openC[1]
      b = openC[2]
      glow = 0.7
    } else {
      // closed: fraction of its written pages still valid
      const w = Math.max(1, store.written[sb])
      const v = store.valid[sb] / w
      r = invalid[0] + (kv[0] - invalid[0]) * v
      g = invalid[1] + (kv[1] - invalid[1]) * v
      b = invalid[2] + (kv[2] - invalid[2]) * v
      // a closed block that was never filled shows as partly free
      const filled = store.written[sb] / PAGES_PER_SB
      r = free[0] + (r - free[0]) * (0.35 + 0.65 * filled)
      g = free[1] + (g - free[1]) * (0.35 + 0.65 * filled)
      b = free[2] + (b - free[2]) * (0.35 + 0.65 * filled)
      glow = 0.26 + (1 - v) * 0.1
    }
    const a = night ? Math.round(glow * 255) : 0
    const dies = domainDieTable(store.width)[domain]
    for (let j = 0; j < dies.length; j++) atlas.paintRow(dies[j], block, r, g, b, a)
  }

  function syncSeen(store: Store): void {
    if (seen.length !== store.superblocks) seen = new Uint32Array(store.superblocks)
    seen.set(store.erase)
    flashing.clear()
  }

  function refreshWearRange(store: Store): void {
    let min = Infinity
    let max = 0
    for (let sb = 0; sb < store.superblocks; sb++) {
      if (store.state[sb] === SbState.Weights) continue
      const e = store.erase[sb]
      if (e < min) min = e
      if (e > max) max = e
    }
    wearRange.min = Number.isFinite(min) ? min : 0
    wearRange.max = max
  }

  const view: SimView = {
    mode: 'state',
    wearRange,
    update(store, nowMs) {
      if (seen.length !== store.superblocks) syncSeen(store)
      if (view.mode === 'wear' && nowMs - lastWear > 500) {
        lastWear = nowMs
        refreshWearRange(store)
        for (let sb = 0; sb < store.superblocks; sb++) paint(store, sb)
        seen.set(store.erase)
        store.clearDirty()
        atlas.touch()
      } else if (store.dirtyCount > 0) {
        const n = store.dirtyCount
        for (let i = 0; i < n; i++) {
          const sb = store.dirty[i]
          const erased = store.erase[sb] !== seen[sb]
          seen[sb] = store.erase[sb]
          if (erased && view.mode === 'state') {
            flashing.set(sb, nowMs + FLASH_MS)
            paint(store, sb, true)
          } else if (!flashing.has(sb)) paint(store, sb)
        }
        store.clearDirty()
        atlas.touch()
      }
      if (flashing.size) {
        for (const [sb, until] of flashing) {
          if (nowMs >= until) {
            flashing.delete(sb)
            paint(store, sb)
            atlas.touch()
          }
        }
      }
      atlas.flush(nowMs)
    },
    repaintAll(store) {
      refreshWearRange(store)
      syncSeen(store)
      for (let sb = 0; sb < store.superblocks; sb++) paint(store, sb)
      store.clearDirty()
      atlas.touch()
      lastWear = -Infinity
    },
    setPalette(mode, p) {
      night = mode === 'night'
      flashRgb = rgb(mode === 'night' ? 0xff6b5a : 0xe0442f)
      weights = rgb(p.weights)
      kv = rgb(p.kv)
      invalid = rgb(p.invalid)
      openC = rgb(p.kvTail)
      free = rgb(p.free)
      wearWeights = rgb(WEAR_WEIGHTS[mode])
      RAMP = WEAR_RAMP[mode]
    },
  }
  return view
}
