import * as THREE from 'three'
import { HBF, THICKNESS_UM } from '../core/hbf-spec'
import { t } from '../core/i18n'
import { surface } from '../core/theme'
import type { SceneState, WorldContext, WorldModule } from '../core/types'
import { makeRng } from '../core/util'
import { BASE_PLAN, C4_UM, GPU_DIE, INTERPOSER, STACK, STACK_SITES, SUBSTRATE, stackV, umToY } from './layout'
import { addFlowAttributes, createFlowMaterial } from './flow-material'
import type { Activity } from './activity'

export interface PackageModule extends WorldModule {
  /** drive the UCIe pulses from per-die activity; call every frame */
  setActivity(activity: Activity, wallDt: number): void
}

/* ============================================================================
 * THE PACKAGE — the land the city stands on.
 *
 *   board        the module PCB, far below and mostly fogged out
 *   substrate    the organic package substrate, ringed by decoupling caps
 *   C4 layer     bumps in underfill between substrate and interposer
 *   interposer   silicon; its top surface is y = 0 and carries the wiring
 *   UCIe lanes   16 host channels per stack crossing the gap to the GPU
 *
 * Capacitors are 0201 parts (0.6 x 0.3 x 0.3 mm). Their height follows the
 * vertical exaggeration only up to 1.6x, so at 12x they do not stand like
 * fences around the package; the substrate's note says so.
 * ==========================================================================*/

const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _p = new THREE.Vector3()
const _s = new THREE.Vector3()

function traceTexture(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null
  const c = document.createElement('canvas')
  c.width = 1024
  c.height = 1024
  const g = c.getContext('2d')
  if (!g) return null
  g.fillStyle = '#808080'
  g.fillRect(0, 0, 1024, 1024)
  const rng = makeRng(0x1e7)
  // Fine RDL wiring: mostly orthogonal runs with short jogs.
  for (let i = 0; i < 420; i++) {
    const horizontal = rng() < 0.5
    const x = rng() * 1024
    const y = rng() * 1024
    const len = 60 + rng() * 380
    const shade = 150 + Math.floor(rng() * 90)
    g.strokeStyle = `rgb(${shade},${shade},${shade})`
    g.lineWidth = rng() < 0.15 ? 2.2 : 1
    g.beginPath()
    g.moveTo(x, y)
    if (horizontal) {
      g.lineTo(x + len, y)
      if (rng() < 0.4) g.lineTo(x + len + 12, y + 12)
    } else {
      g.lineTo(x, y + len)
      if (rng() < 0.4) g.lineTo(x + 12, y + len + 12)
    }
    g.stroke()
  }
  // Via landings.
  for (let i = 0; i < 900; i++) {
    const s = 170 + Math.floor(rng() * 70)
    g.fillStyle = `rgb(${s},${s},${s})`
    g.fillRect(Math.floor(rng() * 1024), Math.floor(rng() * 1024), 2, 2)
  }
  const t = new THREE.CanvasTexture(c)
  t.wrapS = THREE.RepeatWrapping
  t.wrapT = THREE.RepeatWrapping
  t.anisotropy = 8
  t.colorSpace = THREE.NoColorSpace
  return t
}

function solderMaskTexture(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null
  const c = document.createElement('canvas')
  c.width = 512
  c.height = 512
  const g = c.getContext('2d')
  if (!g) return null
  g.fillStyle = '#7f7f7f'
  g.fillRect(0, 0, 512, 512)
  const rng = makeRng(0x50d)
  for (let i = 0; i < 160; i++) {
    const v = 112 + Math.floor(rng() * 40)
    g.strokeStyle = `rgb(${v},${v},${v})`
    g.lineWidth = 3 + rng() * 5
    g.beginPath()
    const x = rng() * 512
    const y = rng() * 512
    g.moveTo(x, y)
    g.lineTo(x + (rng() - 0.5) * 300, y)
    g.lineTo(x + (rng() - 0.5) * 300, y + (rng() - 0.5) * 300)
    g.stroke()
  }
  const t = new THREE.CanvasTexture(c)
  t.wrapS = THREE.RepeatWrapping
  t.wrapT = THREE.RepeatWrapping
  t.repeat.set(4, 4)
  t.anisotropy = 8
  t.colorSpace = THREE.NoColorSpace
  return t
}

export function createPackage(ctx: WorldContext): PackageModule {
  const group = new THREE.Group()
  group.name = 'package'
  const unit = new THREE.BoxGeometry(1, 1, 1)

  /* ---- board -------------------------------------------------------------- */
  const boardMat = surface({ color: 'board', roughness: 0.85, metalness: 0.05 })
  const board = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), boardMat)
  board.rotation.x = -Math.PI / 2
  board.name = 'package.board'
  board.receiveShadow = true
  group.add(board)

  /* ---- substrate ----------------------------------------------------------- */
  const subMat = surface({ color: 'substrate', roughness: 0.62, metalness: 0.08 })
  const mask = solderMaskTexture()
  if (mask) {
    subMat.bumpMap = mask
    subMat.bumpScale = 0.35
  }
  const subSide = surface({ color: 'substrateEdge', roughness: 0.8 })
  const substrate = new THREE.Mesh(unit, [subSide, subSide, subMat, subSide, subSide, subSide])
  substrate.name = 'package.substrate'
  substrate.receiveShadow = true
  substrate.castShadow = true
  group.add(substrate)

  /* ---- decoupling capacitors (0201: 0.6 x 0.3 x 0.3 mm) -------------------- */
  // Rows of small MLCCs hug the interposer outline, as on CoWoS-class packages;
  // a few larger groups sit further out. Placement is illustrative.
  const caps: { x: number; z: number; rot: boolean }[] = []
  {
    const rng = makeRng(0xcab)
    for (let row = 0; row < 3; row++) {
      const off = 16 + row * 11
      const hx = INTERPOSER.halfX + off
      const hz = INTERPOSER.halfZ + off
      for (let x = -hx; x <= hx; x += 9) {
        if (rng() < 0.82) caps.push({ x, z: -hz, rot: false })
        if (rng() < 0.82) caps.push({ x, z: hz, rot: false })
      }
      for (let z = -hz + 9; z <= hz - 9; z += 9) {
        if (rng() < 0.82) caps.push({ x: -hx, z, rot: true })
        if (rng() < 0.82) caps.push({ x: hx, z, rot: true })
      }
    }
    // Clusters near the substrate corners.
    for (const [cx, cz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
      for (let i = 0; i < 6; i++) {
        for (let j = 0; j < 4; j++) {
          caps.push({ x: cx * (SUBSTRATE.halfX - 70) + i * 10 - 25, z: cz * (SUBSTRATE.halfZ - 60) + j * 8 - 12, rot: false })
        }
      }
    }
  }
  const capBody = new THREE.InstancedMesh(unit, surface({ color: 'capBody', roughness: 0.55, metalness: 0.05 }), caps.length)
  const capEnd = new THREE.InstancedMesh(unit, surface({ color: 'capEnd', roughness: 0.25, metalness: 0.95 }), caps.length * 2)
  capBody.name = 'package.caps'
  capEnd.name = 'package.capEnds'
  group.add(capBody, capEnd)

  /* ---- C4 / underfill and interposer ---------------------------------------- */
  const underfill = new THREE.Mesh(unit, surface({ color: 'underfill', roughness: 0.75 }))
  underfill.name = 'package.underfill'
  group.add(underfill)

  const ipTop = surface({ color: 'interposer', roughness: 0.32, metalness: 0.55 })
  const traces = traceTexture()
  if (traces) {
    ipTop.roughnessMap = traces
    ipTop.bumpMap = traces
    ipTop.bumpScale = 0.12
    traces.repeat.set(3, 2)
  }
  const ipSide = surface({ color: 'silicon', roughness: 0.4, metalness: 0.5 })
  const interposer = new THREE.Mesh(unit, [ipSide, ipSide, ipTop, ipSide, ipSide, ipSide])
  interposer.name = 'package.interposer'
  interposer.receiveShadow = true
  group.add(interposer)

  /* ---- UCIe lanes: one per host channel, GPU PHY to base-die PHY ------------- */
  const laneCount = HBF.stacksPerGpu * HBF.channelsPerStack
  // Pulses run toward the GPU: reads dominate HBF traffic by orders of magnitude.
  const laneGeo = unit.clone()
  const laneFlow = addFlowAttributes(laneGeo, laneCount, (i) => STACK_SITES[Math.floor(i / HBF.channelsPerStack)].inward).flow
  const laneMat = createFlowMaterial({ base: 'link', pulse: 'tsv', axis: 'x', spacing: 7, speed: 30, nightBase: 0.35, dayGlow: 0.8 })
  const lanes = new THREE.InstancedMesh(laneGeo, laneMat.material, laneCount)
  lanes.name = 'package.ucie'
  group.add(lanes)
  {
    const [pv0, pv1] = BASE_PLAN.phySpanV
    for (const site of STACK_SITES) {
      const gpuEdge = site.side === 'west' ? -GPU_DIE.width / 2 : GPU_DIE.width / 2
      const x0 = Math.min(gpuEdge, site.phyEdgeX)
      const x1 = Math.max(gpuEdge, site.phyEdgeX)
      for (let c = 0; c < HBF.channelsPerStack; c++) {
        const v = pv0 + ((pv1 - pv0) * (c + 0.5)) / HBF.channelsPerStack
        _p.set((x0 + x1) / 2, 0.12, stackV(site, v))
        _s.set(x1 - x0 + 8, 0.24, 2.2)
        _m.compose(_p, _q, _s)
        lanes.setMatrixAt(site.index * HBF.channelsPerStack + c, _m)
      }
    }
    lanes.instanceMatrix.needsUpdate = true
    lanes.computeBoundingSphere()
  }

  /* ---- vertical layout (depends on the exaggeration) -------------------------- */
  let lastV = NaN
  function layout(state: SceneState): void {
    const v = state.verticalScale
    if (v === lastV) return
    lastV = v
    const ipH = umToY(THICKNESS_UM.interposer, v)
    const c4H = umToY(C4_UM, v)
    const subTop = -ipH - c4H
    interposer.scale.set(INTERPOSER.halfX * 2, ipH, INTERPOSER.halfZ * 2)
    interposer.position.set(0, -ipH / 2, 0)
    underfill.scale.set(INTERPOSER.halfX * 2 + 3, c4H, INTERPOSER.halfZ * 2 + 3)
    underfill.position.set(0, -ipH - c4H / 2, 0)
    substrate.scale.set(SUBSTRATE.halfX * 2, SUBSTRATE.thickness, SUBSTRATE.halfZ * 2)
    substrate.position.set(0, subTop - SUBSTRATE.thickness / 2, 0)
    board.position.y = subTop - SUBSTRATE.thickness - 0.5

    // Capacitors keep near-true proportions: exaggerated 12x, a 0.3 mm part
    // becomes a fence post. The caveat in the inspector says so.
    const capH = umToY(300, Math.min(v, 1.6))
    for (let i = 0; i < caps.length; i++) {
      const c = caps[i]
      const lx = c.rot ? 3 : 6
      const lz = c.rot ? 6 : 3
      _p.set(c.x, subTop + capH / 2, c.z)
      _s.set(c.rot ? lx : lx * 0.62, capH * 0.98, c.rot ? lz * 0.62 : lz)
      _m.compose(_p, _q, _s)
      capBody.setMatrixAt(i, _m)
      for (let e = 0; e < 2; e++) {
        const off = (e === 0 ? -1 : 1) * 0.4
        _p.set(c.x + (c.rot ? 0 : off * lx), subTop + capH / 2, c.z + (c.rot ? off * lz : 0))
        _s.set(c.rot ? lx * 1.02 : lx * 0.2, capH, c.rot ? lz * 0.2 : lz * 1.02)
        _m.compose(_p, _q, _s)
        capEnd.setMatrixAt(i * 2 + e, _m)
      }
    }
    capBody.instanceMatrix.needsUpdate = true
    capEnd.instanceMatrix.needsUpdate = true
    capBody.computeBoundingSphere()
    capEnd.computeBoundingSphere()
  }
  layout(ctx.state)

  /* ---- components ------------------------------------------------------------ */
  ctx.register({
    id: 'package.interposer',
    name: () => t('comp.interposer.name'),
    role: () => t('comp.interposer.role'),
    kind: 'package',
    district: 'package',
    object: interposer,
    bounds: (out) => out.set(_p.set(-INTERPOSER.halfX, interposer.position.y * 2, -INTERPOSER.halfZ), _s.set(INTERPOSER.halfX, 0, INTERPOSER.halfZ)),
    labelAt: (out) => out.set(INTERPOSER.halfX - 40, 0, INTERPOSER.halfZ - 4),
    tier: 1,
    doc: 'interposer',
  })
  ctx.register({
    id: 'package.substrate',
    name: () => t('comp.substrate.name'),
    role: () => t('comp.substrate.role'),
    kind: 'package',
    district: 'package',
    object: substrate,
    bounds: (out) => out.set(
      _p.set(-SUBSTRATE.halfX, substrate.position.y - SUBSTRATE.thickness / 2, -SUBSTRATE.halfZ),
      _s.set(SUBSTRATE.halfX, substrate.position.y + SUBSTRATE.thickness / 2, SUBSTRATE.halfZ),
    ),
    labelAt: (out) => out.set(SUBSTRATE.halfX - 90, substrate.position.y + SUBSTRATE.thickness / 2, SUBSTRATE.halfZ - 30),
    tier: 1,
    doc: 'substrate',
  })
  for (const site of STACK_SITES) {
    const gpuEdge = site.side === 'west' ? -GPU_DIE.width / 2 : GPU_DIE.width / 2
    ctx.register({
      id: `package.ucie.${site.index}`,
      name: () => t('comp.ucie.name', { s: site.index }),
      role: () => t('comp.ucie.role', { s: site.index }),
      kind: 'link',
      district: 'package',
      object: lanes,
      instances: Array.from({ length: HBF.channelsPerStack }, (_, c) => site.index * HBF.channelsPerStack + c),
      // the lanes overlap 4 units into each PHY (see the lane layout above)
      bounds: (out) => out.set(
        _p.set(Math.min(gpuEdge, site.phyEdgeX) - 4, 0, site.z - STACK.width * 0.3),
        _s.set(Math.max(gpuEdge, site.phyEdgeX) + 4, 2, site.z + STACK.width * 0.3),
      ),
      tier: 2,
      doc: 'ucie',
      color: 'link',
      stack: site.index,
      labelWhen: () => ctx.state.focusStack === site.index,
    })
  }

  return {
    id: 'package',
    group,
    update(_dt, state) {
      layout(state)
    },
    setActivity(act, wallDt) {
      laneMat.tick(wallDt)
      // lane c of a stack is host channel c, which owns core die c
      for (let i = 0; i < laneCount; i++) laneFlow.setX(i, Math.min(1, act.read[i] + act.program[i]))
      laneFlow.needsUpdate = true
    },
  }
}
