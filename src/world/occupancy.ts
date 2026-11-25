import * as THREE from 'three'
import { HBF } from '../core/hbf-spec'

/* ============================================================================
 * BLOCK ATLAS — one texel per NAND block, for every block on the package.
 *
 * 6 stacks x 16 dies x 32 planes x 512 blocks = 1,572,864 blocks, each its
 * own texel, so a die's floor plan shows all 16,384 of its blocks at once.
 * The simulator paints it (world/sim-view.ts); this module only owns the
 * texture and its layout.
 *
 * Layout (fits the WebGL2 2048 minimum texture size):
 *   global die g = stack * 16 + die          (0..95)
 *   x = (g % 32) * 32 + plane                (0..1023)
 *   y = floor(g / 32) * 512 + block          (0..1535)
 * Each texel holds the block's display colour (sRGB) and its night glow in
 * alpha, so mipmaps average colours correctly at distance.
 * ==========================================================================*/

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

/** Index of the first of a die's 32 plane texels in the row of `block`. */
export function rowStart(globalDie: number, block: number): number {
  const x = (globalDie % ATLAS.diesPerRow) * HBF.planesPerDie
  const y = Math.floor(globalDie / ATLAS.diesPerRow) * HBF.blocksPerPlane + block
  return y * ATLAS.width + x
}

export interface OccupancyAtlas {
  texture: THREE.DataTexture
  data: Uint8Array
  /** paint one block index on all 32 planes of a die */
  paintRow(globalDie: number, block: number, r: number, g: number, b: number, a: number): void
  /** schedule an upload; uploads are throttled because mipmaps rebuild each time */
  touch(): void
  flush(nowMs: number): void
}

const UPLOAD_EVERY_MS = 110

export function createOccupancyAtlas(): OccupancyAtlas {
  const { width, height } = ATLAS
  const data = new Uint8Array(width * height * 4)
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.UnsignedByteType)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.generateMipmaps = true
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.flipY = false
  texture.name = 'hbfcity.blocks'
  let pending = false
  let last = -Infinity

  return {
    texture,
    data,
    paintRow(globalDie, block, r, g, b, a) {
      let o = rowStart(globalDie, block) * 4
      for (let p = 0; p < HBF.planesPerDie; p++) {
        data[o] = r
        data[o + 1] = g
        data[o + 2] = b
        data[o + 3] = a
        o += 4
      }
    },
    touch() {
      pending = true
    },
    flush(nowMs) {
      if (!pending || nowMs - last < UPLOAD_EVERY_MS) return
      texture.needsUpdate = true
      pending = false
      last = nowMs
    },
  }
}
