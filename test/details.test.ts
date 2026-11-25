import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { createBus } from '../src/core/bus'
import { GPU, HBF } from '../src/core/hbf-spec'
import type { SceneState, WorldContext } from '../src/core/types'
import { createGpu, fusedOffSms } from '../src/world/gpu'
import { BASE_PLAN, DIE_PLAN, gpuHeight } from '../src/world/layout'

/** Details that were once drawn wrong: each test pins what the notes say. */
function ctxAt(verticalScale: number): WorldContext {
  const N = HBF.stacksPerGpu
  const state = {
    explodeTarget: new Array(N).fill(0),
    explode: new Array(N).fill(0),
    liftedDieTarget: new Array(N).fill(-1),
    liftedDie: new Array(N).fill(-1),
    lift: new Array(N).fill(0),
    verticalScaleTarget: verticalScale,
    verticalScale,
    showBulkSilicon: true,
    labels: true,
    focusStack: 3,
  } as unknown as SceneState
  return {
    scene: new THREE.Scene(),
    bus: createBus(),
    state,
    quality: { level: 'high', pixelRatio: 1, bloom: false, shadows: false, ambientOcclusion: false, antialias: false } as WorldContext['quality'],
    register: () => {},
  }
}

describe('drawn details', () => {
  it('fuses off whole TPCs, as H100 SXM5 does (66 of 72 enabled)', () => {
    const off = fusedOffSms()
    const total = GPU.gpcs * GPU.tpcsPerGpc * GPU.smsPerTpc
    expect(off.size).toBe(total - GPU.enabledSms)
    // SMs 2k and 2k+1 form TPC k: both or neither are dark
    for (const sm of off) expect(off.has(sm ^ 1), `SM ${sm}`).toBe(true)
  })

  it('stands the signal TSVs on the landing strip and in the core dies’ strip, clear of the PHYs and debug blocks', () => {
    const [a, b] = BASE_PLAN.sigTsvU
    expect(a).toBeGreaterThanOrEqual(BASE_PLAN.tsvU[0])
    expect(b).toBeLessThanOrEqual(BASE_PLAN.tsvU[1])
    expect(a).toBeGreaterThanOrEqual(DIE_PLAN.planeU[0])
    expect(b).toBeLessThanOrEqual(DIE_PLAN.planeU[1])
    expect(a).toBeGreaterThan(BASE_PLAN.phyU[1])
    expect(BASE_PLAN.tsvU[1]).toBeLessThan(BASE_PLAN.debugU[0])
  })

  it('keeps every GPU circuit inside the die’s true 775 µm at true scale', () => {
    const gpu = createGpu(ctxAt(1))
    gpu.group.updateMatrixWorld(true)
    const top = gpuHeight(1)
    const box = new THREE.Box3()
    let checked = 0
    gpu.group.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh || mesh === gpu.ghost) return
      if ((mesh as THREE.InstancedMesh).isInstancedMesh) (mesh as THREE.InstancedMesh).computeBoundingBox()
      else mesh.geometry.computeBoundingBox()
      box.copy((mesh as THREE.InstancedMesh).boundingBox ?? mesh.geometry.boundingBox!).applyMatrix4(mesh.matrixWorld)
      expect(box.max.y, mesh.name || mesh.type).toBeLessThanOrEqual(top + 1e-6)
      checked++
    })
    expect(checked).toBeGreaterThan(8)
  })
})
