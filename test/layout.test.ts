import { describe, expect, it } from 'vitest'
import { HBF, THICKNESS_UM } from '../src/core/hbf-spec'
import {
  BASE_PLAN,
  DIE_PLAN,
  EXPLODE_GAP,
  GPU_DIE,
  INTERPOSER,
  LIFT_BASE,
  LIFT_RISE,
  BASE_RISE,
  MM,
  STACK,
  STACK_SITES,
  gpuHeight,
  planeRect,
  stackLayers,
  umToY,
} from '../src/world/layout'

describe('package plan', () => {
  it('draws the OCP footprint at 10 world units per mm', () => {
    expect(STACK.length).toBeCloseTo(HBF.footprintMm.length * MM, 6)
    expect(STACK.width).toBeCloseTo(HBF.footprintMm.width * MM, 6)
  })

  it('places three stacks on each side, PHY edge facing the GPU, none overlapping the GPU', () => {
    const west = STACK_SITES.filter((s) => s.side === 'west')
    const east = STACK_SITES.filter((s) => s.side === 'east')
    expect(west).toHaveLength(3)
    expect(east).toHaveLength(3)
    for (const s of STACK_SITES) {
      // PHY edge is the edge nearest the GPU
      expect(Math.abs(s.phyEdgeX)).toBeLessThan(Math.abs(s.x))
      // and it does not cross into the GPU die
      expect(Math.abs(s.phyEdgeX)).toBeGreaterThan(GPU_DIE.width / 2)
      // the whole stack sits on the interposer
      expect(Math.abs(s.x) + STACK.length / 2).toBeLessThanOrEqual(INTERPOSER.halfX)
      expect(Math.abs(s.z) + STACK.width / 2).toBeLessThanOrEqual(INTERPOSER.halfZ)
    }
  })

  it('keeps neighbouring stacks apart along the GPU edge', () => {
    for (const side of ['west', 'east'] as const) {
      const zs = STACK_SITES.filter((s) => s.side === side).map((s) => s.z).sort((a, b) => a - b)
      for (let i = 1; i < zs.length; i++) expect(zs[i] - zs[i - 1]).toBeGreaterThan(STACK.width)
    }
  })

  it('fits sixteen UCIe modules of ~0.389 mm along the stack edge', () => {
    const span = (BASE_PLAN.phySpanV[1] - BASE_PLAN.phySpanV[0]) * STACK.width
    expect(span / HBF.channelsPerStack).toBeCloseTo(0.389 * MM, 1)
  })
})

describe('stack layers', () => {
  it('stacks bonded dies contiguously to OCP height when closed', () => {
    const v = 12
    const L = stackLayers(v, 0, -1, 0)
    expect(L.baseBottom).toBe(0)
    expect(L.bondBottom[0]).toBeCloseTo(L.baseTop, 9)
    for (let d = 1; d < HBF.diesPerStack; d++) expect(L.bondBottom[d]).toBeCloseTo(L.dieTop[d - 1], 9)
    expect(L.top).toBeCloseTo(umToY(HBF.heightUm, v), 1)
    // the GPU is drawn coplanar with the stacks
    expect(gpuHeight(v)).toBeCloseTo(L.top, 1)
  })

  it('opens every gap by the same amount and never moves the base die', () => {
    const closed = stackLayers(12, 0, -1, 0)
    const open = stackLayers(12, 1, -1, 0)
    expect(open.baseTop).toBe(closed.baseTop)
    for (let d = 0; d < HBF.diesPerStack; d++) {
      expect(open.dieBottom[d] - closed.dieBottom[d]).toBeCloseTo((d + 1) * EXPLODE_GAP, 6)
      expect(open.dieTop[d] - open.dieBottom[d]).toBeCloseTo(umToY(THICKNESS_UM.coreDie, 12), 9)
    }
  })

  it('lifting a die raises only the dies above it', () => {
    const base = stackLayers(12, 0.5, -1, 0)
    const lifted = stackLayers(12, 0.5, 7, 1)
    for (let d = 0; d <= 7; d++) expect(lifted.dieBottom[d]).toBeCloseTo(base.dieBottom[d], 9)
    for (let d = 8; d < HBF.diesPerStack; d++) expect(lifted.dieBottom[d] - base.dieBottom[d]).toBeCloseTo(LIFT_RISE, 9)
  })

  it('uncovering the base die lifts all sixteen core dies together', () => {
    const base = stackLayers(12, 0.3, -1, 0)
    const up = stackLayers(12, 0.3, LIFT_BASE, 1)
    expect(up.baseTop).toBe(base.baseTop)
    for (let d = 0; d < HBF.diesPerStack; d++) expect(up.dieBottom[d] - base.dieBottom[d]).toBeCloseTo(BASE_RISE, 9)
  })

  it('true proportions shrink every layer by the exaggeration factor', () => {
    const one = stackLayers(1, 0, -1, 0)
    const twelve = stackLayers(12, 0, -1, 0)
    expect(twelve.top / one.top).toBeCloseTo(12, 6)
  })
})

describe('core-die floor plan', () => {
  it('puts 32 non-overlapping planes inside the die, clear of the TSV strip and power rows', () => {
    const rects = Array.from({ length: HBF.planesPerDie }, (_, p) => planeRect(p))
    for (const r of rects) {
      expect(r.u0).toBeGreaterThan(DIE_PLAN.seal)
      expect(r.u1).toBeLessThan(1 - DIE_PLAN.seal)
      expect(r.v0).toBeGreaterThanOrEqual(DIE_PLAN.powerRow[1])
      expect(r.v1).toBeLessThanOrEqual(1 - DIE_PLAN.powerRow[1])
      // planes never cross the centre strip
      const crosses = r.v0 < 0.5 + DIE_PLAN.spineHalf && r.v1 > 0.5 - DIE_PLAN.spineHalf
      expect(crosses).toBe(false)
    }
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]
        const b = rects[j]
        const overlap = a.u0 < b.u1 && b.u0 < a.u1 && a.v0 < b.v1 && b.v0 < a.v1
        expect(overlap).toBe(false)
      }
    }
  })
})
