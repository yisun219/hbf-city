import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { createBus } from '../src/core/bus'
import { HBF } from '../src/core/hbf-spec'
import type { SceneState, WorldContext } from '../src/core/types'
import { createActivity } from '../src/world/activity'
import { createStacks } from '../src/world/hbf-stack'
import { DIE_PLAN, STACK_SITES } from '../src/world/layout'
import { createOccupancyAtlas } from '../src/world/occupancy'

/**
 * The block under the cursor must be the block the shader draws there. Build
 * the stacks, put a hit at a known point of a die's floor plan, and check the
 * plane and block that come back against the floor-plan arithmetic.
 */
function build() {
  const N = HBF.stacksPerGpu
  const state: SceneState = {
    explodeTarget: new Array(N).fill(0),
    explode: new Array(N).fill(0),
    liftedDieTarget: new Array(N).fill(-1),
    liftedDie: new Array(N).fill(-1),
    lift: new Array(N).fill(0),
    verticalScaleTarget: 12,
    verticalScale: 12,
    showBulkSilicon: true,
    labels: true,
    focusStack: 3,
  } as unknown as SceneState
  const ctx: WorldContext = {
    scene: new THREE.Scene(),
    bus: createBus(),
    state,
    quality: { level: 'high', pixelRatio: 1, bloom: false, shadows: false, ambientOcclusion: false, antialias: false } as WorldContext['quality'],
    register: () => {},
  }
  const stacks = createStacks(ctx, createOccupancyAtlas(), createActivity())
  stacks.group.updateMatrixWorld(true)
  return stacks
}

/** A hit on the top face of die `i` at floor-plan coordinates (u, v). */
function hitAt(mesh: THREE.InstancedMesh, i: number, u: number, v: number): THREE.Intersection {
  const s = Math.floor(i / HBF.diesPerStack)
  const flip = -STACK_SITES[s].inward
  const m = new THREE.Matrix4()
  mesh.getMatrixAt(i, m)
  m.premultiply(mesh.matrixWorld)
  const local = new THREE.Vector3((u - 0.5) / flip, 0.5, v - 0.5)
  return {
    object: mesh,
    instanceId: i,
    distance: 100,
    point: local.applyMatrix4(m),
    face: { a: 0, b: 0, c: 0, normal: new THREE.Vector3(0, 1, 0), materialIndex: 0 },
  } as THREE.Intersection
}

/** Floor-plan (u, v) of the middle of a plane's array zone, at a block. */
function planBlock(plane: number, block: number): [number, number] {
  const cols = HBF.planesPerDie / 2
  const row = plane < cols ? 0 : 1
  const col = plane % cols
  const [pu0, pu1] = DIE_PLAN.planeU
  const u = pu0 + ((col + 0.5) / cols) * (pu1 - pu0)
  const [r0, r1] = DIE_PLAN.rowV[row]
  const pv = (block + 0.5) / HBF.blocksPerPlane
  const v = row === 0 ? r1 - pv * (r1 - r0) : r0 + pv * (r1 - r0)
  return [u, v]
}

describe('block under the cursor', () => {
  const stacks = build()

  it('finds the plane and block the shader draws at that point, on both sides of the GPU', () => {
    for (const i of [0, 9, 3 * 16 + 9, 5 * 16 + 15]) {
      for (const [plane, block] of [
        [0, 0],
        [7, 255],
        [15, 511],
        [16, 0],
        [23, 300],
        [31, 511],
      ]) {
        const [u, v] = planBlock(plane, block)
        const got = stacks.blockAt(hitAt(stacks.coreDies, i, u, v))
        expect(got, `die ${i} plane ${plane} block ${block}`).toEqual({
          stack: Math.floor(i / 16),
          die: i % 16,
          global: i,
          plane,
          block,
        })
      }
    }
  })

  it('reports nothing off the block array: seal ring, TSV strip, gutters, staircases, side faces', () => {
    const mesh = stacks.coreDies
    expect(stacks.blockAt(hitAt(mesh, 9, 0.004, 0.3))).toBeNull() // seal ring
    expect(stacks.blockAt(hitAt(mesh, 9, 0.5, 0.5))).toBeNull() // signal-TSV strip
    const [pu0, pu1] = DIE_PLAN.planeU
    const colW = (pu1 - pu0) / (HBF.planesPerDie / 2)
    expect(stacks.blockAt(hitAt(mesh, 9, pu0 + colW * 1.001, 0.3))).toBeNull() // gutter between planes
    expect(stacks.blockAt(hitAt(mesh, 9, pu0 + colW * 0.06, 0.3))).toBeNull() // word-line staircase
    const side = hitAt(mesh, 9, 0.3, 0.3)
    side.face!.normal.set(1, 0, 0)
    expect(stacks.blockAt(side)).toBeNull()
  })
})
