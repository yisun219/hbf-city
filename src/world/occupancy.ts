import * as THREE from 'three'
import { HBF } from '../core/hbf-spec'
import type { Palette } from '../core/theme'
import type { ThemeMode } from '../core/types'

/* ============================================================================
 * BLOCK OCCUPANCY — one texel per NAND block, for every block on the package.
 *
 * 6 stacks x 16 dies x 32 planes x 512 blocks = 1,572,864 blocks. They are
 * not sampled: each block owns one texel, so a die's floor plan shows all
 * 16,384 of its blocks at once.
 *
 * STEP 1 STATE IS ILLUSTRATIVE. No simulator drives this texture yet. The
 * pattern only follows the layout rules the city will later simulate:
 * weights striped over every plane (OCP §13.3.1), KV blocks after them, and
 * free blocks last. The HUD says so wherever this texture is visible.
 *
 * Atlas layout (fits the WebGL2 2048 minimum texture size):
 *   global die g = stack * 16 + die          (0..95)
 *   x = (g % 32) * 32 + plane                (0..1023)
 *   y = floor(g / 32) * 512 + block          (0..1535)
 * Each texel stores the block's display colour (sRGB) and its night glow in
 * alpha, so mipmaps average colours correctly at distance.
 * ==========================================================================*/

export enum BlockState {
  Free = 0,
  Weights = 1,
  Kv = 2,
  KvOpen = 3,
  Invalid = 4,
}

export const ATLAS = {
  diesPerRow: 32,
  width: 32 * HBF.planesPerDie,
  height: 3 * HBF.blocksPerPlane,
} as const

export const TOTAL_DIES = HBF.stacksPerGpu * HBF.diesPerStack

export function atlasTexel(stack: number, die: number, plane: number, block: number): [number, number] {
  const g = stack * HBF.diesPerStack + die
  return [(g % ATLAS.diesPerRow) * HBF.planesPerDie + plane, Math.floor(g / ATLAS.diesPerRow) * HBF.blocksPerPlane + block]
}

/** Integer hash; the same city on every load. */
function hash(a: number, b: number, c: number, d: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b)
  h = Math.imul(h ^ (b + 0x632be5ab), 0xc2b2ae35)
  h = Math.imul(h ^ (c + 0x27d4eb2f), 0x165667b1)
  h = Math.imul(h ^ (d + 0x9e3779b1), 0x85ebca77)
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d)
  h ^= h >>> 12
  return (h >>> 0) / 4294967296
}

/** Share of every plane's blocks that hold weights in the illustration. */
export const ILLUSTRATIVE_WEIGHT_SHARE = 0.2

export interface BlockSample {
  state: BlockState
  /** pages programmed, 0..1; meaningful for KvOpen */
  fill: number
}

/** Illustrative state of one block. Pure and deterministic. */
export function illustrativeBlock(stack: number, die: number, plane: number, block: number): BlockSample {
  const n = HBF.blocksPerPlane
  const weightEnd = Math.round(n * ILLUSTRATIVE_WEIGHT_SHARE)
  if (block < weightEnd) return { state: BlockState.Weights, fill: 1 }
  // KV occupancy varies by die and plane the way a packing policy's
  // round-robin cursor would leave it: a smooth front with a ragged edge.
  const front =
    0.62 +
    0.12 * Math.sin((stack * 1.7 + die * 0.61 + plane * 0.23) * 1.3) +
    0.05 * (hash(stack, die, plane, 7) - 0.5)
  const kvEnd = weightEnd + Math.round((n - weightEnd) * front)
  if (block >= kvEnd) {
    if (block === kvEnd) return { state: BlockState.KvOpen, fill: 0.15 + 0.8 * hash(stack, die, plane, 11) }
    return { state: BlockState.Free, fill: 0 }
  }
  const r = hash(stack, die, plane, block)
  // Invalid blocks cluster: evicted sessions free runs of neighbouring blocks.
  const run = hash(stack, die, plane, block >> 3)
  if (run < 0.16 && r < 0.85) return { state: BlockState.Invalid, fill: 1 }
  if (r < 0.03) return { state: BlockState.Invalid, fill: 1 }
  return { state: BlockState.Kv, fill: 1 }
}

export interface OccupancyAtlas {
  texture: THREE.DataTexture
  /** state codes, one byte per block, same layout as the texture */
  codes: Uint8Array
  /** programmed fraction for open blocks, 0..255 */
  fills: Uint8Array
  repaint(mode: ThemeMode, palette: Palette): void
  counts(stack: number, die?: number): Record<BlockState, number>
}

/* Night glow per state. Blocks cover most of every die, so their glow stays
 * below the bloom threshold; only open blocks (where writes land) bloom. */
const GLOW: Record<BlockState, number> = {
  [BlockState.Free]: 0.015,
  [BlockState.Weights]: 0.3,
  [BlockState.Kv]: 0.26,
  [BlockState.KvOpen]: 1,
  [BlockState.Invalid]: 0.34,
}

export function createOccupancyAtlas(): OccupancyAtlas {
  const { width, height } = ATLAS
  const codes = new Uint8Array(width * height)
  const fills = new Uint8Array(width * height)
  for (let s = 0; s < HBF.stacksPerGpu; s++) {
    for (let d = 0; d < HBF.diesPerStack; d++) {
      for (let p = 0; p < HBF.planesPerDie; p++) {
        for (let b = 0; b < HBF.blocksPerPlane; b++) {
          const [x, y] = atlasTexel(s, d, p, b)
          const sample = illustrativeBlock(s, d, p, b)
          const i = y * width + x
          codes[i] = sample.state
          fills[i] = Math.round(sample.fill * 255)
        }
      }
    }
  }

  const data = new Uint8Array(width * height * 4)
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.UnsignedByteType)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.generateMipmaps = true
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.flipY = false
  texture.name = 'hbfcity.occupancy'

  function repaint(mode: ThemeMode, palette: Palette): void {
    const table: [number, number, number, number][] = []
    const keys: Record<BlockState, keyof Palette> = {
      [BlockState.Free]: 'free',
      [BlockState.Weights]: 'weights',
      [BlockState.Kv]: 'kv',
      [BlockState.KvOpen]: 'kvTail',
      [BlockState.Invalid]: 'invalid',
    }
    for (let st = 0; st <= BlockState.Invalid; st++) {
      const hex = palette[keys[st as BlockState]]
      const glow = mode === 'night' ? GLOW[st as BlockState] : 0
      table[st] = [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255, Math.round(glow * 255)]
    }
    for (let i = 0; i < codes.length; i++) {
      const c = table[codes[i]]
      const o = i * 4
      data[o] = c[0]
      data[o + 1] = c[1]
      data[o + 2] = c[2]
      data[o + 3] = c[3]
    }
    texture.needsUpdate = true
  }

  function counts(stack: number, die?: number): Record<BlockState, number> {
    const out: Record<BlockState, number> = {
      [BlockState.Free]: 0,
      [BlockState.Weights]: 0,
      [BlockState.Kv]: 0,
      [BlockState.KvOpen]: 0,
      [BlockState.Invalid]: 0,
    }
    const d0 = die ?? 0
    const d1 = die === undefined ? HBF.diesPerStack : die + 1
    for (let d = d0; d < d1; d++) {
      for (let p = 0; p < HBF.planesPerDie; p++) {
        for (let b = 0; b < HBF.blocksPerPlane; b++) {
          const [x, y] = atlasTexel(stack, d, p, b)
          out[codes[y * width + x] as BlockState]++
        }
      }
    }
    return out
  }

  return { texture, codes, fills, repaint, counts }
}
