import { describe, expect, it } from 'vitest'
import { HBF } from '../src/core/hbf-spec'
import { PALETTES } from '../src/core/theme'
import { createStore, domainDies } from '../src/sim/store'
import { ATLAS, TOTAL_DIES, atlasTexel, createOccupancyAtlas, rowStart } from '../src/world/occupancy'
import { createSimView } from '../src/world/sim-view'

describe('block atlas', () => {
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
            expect(x).toBeLessThan(ATLAS.width)
            expect(y).toBeLessThan(ATLAS.height)
            seen.add(y * ATLAS.width + x)
          }
        }
      }
    }
    expect(seen.size).toBe(HBF.stacksPerGpu * HBF.diesPerStack * 9)
  })

  it('puts a die’s 32 plane texels for one block in one contiguous row', () => {
    const [x0, y0] = atlasTexel(3, 7, 0, 100)
    const [x31, y31] = atlasTexel(3, 7, 31, 100)
    expect(y31).toBe(y0)
    expect(x31 - x0).toBe(31)
    expect(rowStart(3 * 16 + 7, 100)).toBe(y0 * ATLAS.width + x0)
  })
})

describe('sim view', () => {
  it('paints a superblock onto every plane of every die in its domain, and nowhere else', () => {
    const atlas = createOccupancyAtlas()
    const view = createSimView(atlas)
    view.setPalette('day', PALETTES.day)
    const store = createStore('hbflex', 0, 4)
    view.repaintAll(store)
    // write one superblock's worth into domain 5 and repaint only what changed
    store.write(1, 5, 0, 512, 0)
    const before = atlas.data.slice()
    view.update(store, 1e9)
    const changed = new Set<number>()
    for (let i = 0; i < atlas.data.length; i += 4) {
      if (atlas.data[i] !== before[i] || atlas.data[i + 1] !== before[i + 1] || atlas.data[i + 2] !== before[i + 2]) {
        changed.add(i / 4)
      }
    }
    const dies = domainDies(4, 5)
    expect(changed.size).toBe(dies.length * HBF.planesPerDie)
    for (const t of changed) {
      const x = t % ATLAS.width
      const y = Math.floor(t / ATLAS.width)
      const die = Math.floor(y / HBF.blocksPerPlane) * ATLAS.diesPerRow + Math.floor(x / HBF.planesPerDie)
      expect(dies).toContain(die)
    }
  })
})
