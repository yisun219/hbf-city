import { HBF } from '../core/hbf-spec'
import type { Palette } from '../core/theme'
import type { ThemeMode } from '../core/types'
import { PAGES_PER_SB, SbState, domainDies } from '../sim/store'
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
 *   state view  weights amber · open block green · closed blocks from cyan
 *               (all pages valid) to pink (all invalid) · free grey
 *   wear view   erase count on a log heat ramp from 0 to the most-erased KV
 *               block; weight blocks, which never erase, stay dim amber
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

/* Heat ramp: deep blue -> teal -> yellow -> orange -> red. */
const RAMP: [number, number, number][] = [
  [24, 40, 92],
  [22, 150, 170],
  [240, 220, 80],
  [245, 140, 40],
  [230, 50, 50],
]

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
  const wearRange = { min: 0, max: 0 }
  let lastWear = -Infinity
  const tmp = [0, 0, 0]

  function paint(store: Store, sb: number): void {
    const domain = Math.floor(sb / HBF.blocksPerPlane)
    const block = sb % HBF.blocksPerPlane
    const st = store.state[sb]
    let r: number
    let g: number
    let b: number
    let glow: number
    if (view.mode === 'wear' && st !== SbState.Weights) {
      // log scale: a few hot blocks would otherwise squash everything else to blue
      const t = Math.log1p(store.erase[sb]) / Math.log1p(Math.max(1, wearRange.max))
      ramp(t, tmp)
      r = tmp[0]
      g = tmp[1]
      b = tmp[2]
      glow = 0.12 + 0.3 * t
    } else if (st === SbState.Weights) {
      const k = view.mode === 'wear' ? 0.45 : 1
      r = weights[0] * k
      g = weights[1] * k
      b = weights[2] * k
      glow = view.mode === 'wear' ? 0.05 : 0.3
    } else if (st === SbState.Free) {
      r = free[0]
      g = free[1]
      b = free[2]
      glow = 0.015
    } else if (st === SbState.Open) {
      r = openC[0]
      g = openC[1]
      b = openC[2]
      glow = 0.95
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
    for (const die of domainDies(store.width, domain)) atlas.paintRow(die, block, r, g, b, a)
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
      if (view.mode === 'wear' && nowMs - lastWear > 500) {
        lastWear = nowMs
        refreshWearRange(store)
        for (let sb = 0; sb < store.superblocks; sb++) paint(store, sb)
        store.clearDirty()
        atlas.touch()
      } else if (store.dirtyCount > 0) {
        const n = store.dirtyCount
        for (let i = 0; i < n; i++) paint(store, store.dirty[i])
        store.clearDirty()
        atlas.touch()
      }
      atlas.flush(nowMs)
    },
    repaintAll(store) {
      refreshWearRange(store)
      for (let sb = 0; sb < store.superblocks; sb++) paint(store, sb)
      store.clearDirty()
      atlas.touch()
      lastWear = -Infinity
    },
    setPalette(mode, p) {
      night = mode === 'night'
      weights = rgb(p.weights)
      kv = rgb(p.kv)
      invalid = rgb(p.invalid)
      openC = rgb(p.kvTail)
      free = rgb(p.free)
    },
  }
  return view
}
