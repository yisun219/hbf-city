import { describe, expect, it } from 'vitest'
import { HBF } from '../src/core/hbf-spec'
import { ATLAS, BlockState, ILLUSTRATIVE_WEIGHT_SHARE, TOTAL_DIES, atlasTexel, illustrativeBlock } from '../src/world/occupancy'

describe('occupancy atlas', () => {
  it('fits every block of the package in a WebGL2-safe texture, one texel each', () => {
    expect(ATLAS.width).toBeLessThanOrEqual(2048)
    expect(ATLAS.height).toBeLessThanOrEqual(2048)
    expect(ATLAS.width * ATLAS.height).toBe(TOTAL_DIES * HBF.planesPerDie * HBF.blocksPerPlane)
  })

  it('maps distinct blocks to distinct texels', () => {
    const seen = new Set<number>()
    for (let s = 0; s < HBF.stacksPerGpu; s++) {
      for (let d = 0; d < HBF.diesPerStack; d++) {
        for (const p of [0, 15, 31]) {
          for (const b of [0, 255, 511]) {
            const [x, y] = atlasTexel(s, d, p, b)
            expect(x).toBeGreaterThanOrEqual(0)
            expect(x).toBeLessThan(ATLAS.width)
            expect(y).toBeLessThan(ATLAS.height)
            seen.add(y * ATLAS.width + x)
          }
        }
      }
    }
    expect(seen.size).toBe(HBF.stacksPerGpu * HBF.diesPerStack * 9)
  })

  it('stripes weights over every plane, as OCP §13.3.1 recommends', () => {
    const w = Math.round(HBF.blocksPerPlane * ILLUSTRATIVE_WEIGHT_SHARE)
    for (let p = 0; p < HBF.planesPerDie; p++) {
      expect(illustrativeBlock(2, 9, p, 0).state).toBe(BlockState.Weights)
      expect(illustrativeBlock(2, 9, p, w - 1).state).toBe(BlockState.Weights)
      expect(illustrativeBlock(2, 9, p, w).state).not.toBe(BlockState.Weights)
    }
  })

  it('leaves exactly one open KV block per plane, then free blocks', () => {
    for (let p = 0; p < HBF.planesPerDie; p++) {
      let open = 0
      let sawFree = false
      for (let b = 0; b < HBF.blocksPerPlane; b++) {
        const s = illustrativeBlock(4, 3, p, b).state
        if (s === BlockState.KvOpen) open++
        if (s === BlockState.Free) sawFree = true
        else if (sawFree) throw new Error(`plane ${p}: block ${b} is used after a free block`)
      }
      expect(open).toBe(1)
    }
  })
})
