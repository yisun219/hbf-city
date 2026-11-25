import * as THREE from 'three'
import { GPU, HBF, UCIE } from '../core/hbf-spec'
import { t } from '../core/i18n'
import { lineMat, signal, surface, themed } from '../core/theme'
import type { SceneState, WorldContext, WorldModule } from '../core/types'
import { makeRng } from '../core/util'
import { BASE_PLAN, GPU_DIE, GPU_PLAN, MM, STACK, STACK_SITES, gpuHeight, stackV } from './layout'

/* ============================================================================
 * THE GPU — downtown. A GH100-class die drawn ACTIVE SIDE UP.
 *
 * On a real package the GPU is flip-chip mounted: its transistors face down
 * onto the interposer and the top of the die is bare silicon. The city keeps
 * the circuits at the bottom, where they really are, and draws the silicon
 * above them as a ghost volume whose top is coplanar with the HBF stacks.
 *
 * Floor plan (approximate, after the GH100 block diagram, not a die photo):
 *   west and east edges   memory-side PHYs, one strip per HBF stack, with a
 *                         UCIe module opposite each of the stack's 16 channels
 *   inside them           memory controllers
 *   centre band           L2 cache in two partitions, crossbar between them
 *   north and south       eight GPCs of 9 TPCs x 2 SMs (144 SMs; 132 enabled)
 *   north edge            host interface (PCIe)
 *   south edge            NVLink
 *
 * Circuit blocks are raised a few metres so they read as a city; the real
 * active layer is microns thick.
 * ==========================================================================*/

export interface GpuModule extends WorldModule {
  ghost: THREE.Mesh
  /** compute share and memory-read utilisation, 0..1, drive SM and L2 glow */
  setActivity(compute: number, read: number): void
}

const HX = GPU_DIE.width / 2
const HZ = GPU_DIE.length / 2

const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _p = new THREE.Vector3()
const _s = new THREE.Vector3()

function put(mesh: THREE.InstancedMesh, i: number, x: number, y0: number, z: number, sx: number, sy: number, sz: number): void {
  _p.set(x, y0 + sy / 2, z)
  _s.set(sx, sy, sz)
  _m.compose(_p, _q, _s)
  mesh.setMatrixAt(i, _m)
}

export function createGpu(ctx: WorldContext): GpuModule {
  const group = new THREE.Group()
  group.name = 'gpu'
  const unit = new THREE.BoxGeometry(1, 1, 1)
  const ACTIVE = 1.4

  /* ---- active layer slab ------------------------------------------------- */
  const slab = new THREE.Mesh(unit, surface({ color: 'siliconTop', roughness: 0.6, metalness: 0.25 }))
  slab.scale.set(GPU_DIE.width, ACTIVE, GPU_DIE.length)
  slab.position.set(0, ACTIVE / 2, 0)
  slab.receiveShadow = true
  slab.name = 'gpu.active'
  group.add(slab)

  /* ---- GPCs and SMs ------------------------------------------------------- */
  const inner = HX - GPU_PLAN.phyDepth - GPU_PLAN.mcDepth - 4
  const halfZ0 = GPU_PLAN.l2Half + 4
  const halfZ1 = HZ - GPU_PLAN.ioDepth - 4
  const gpcW = (2 * inner - 8) / GPU_PLAN.gpcCols
  const gpcD = (halfZ1 - halfZ0 - 6) / GPU_PLAN.gpcRowsPerHalf
  const smCols = 6
  const smRows = 3
  const totalSms = GPU.gpcs * GPU.tpcsPerGpc * GPU.smsPerTpc

  // H100 SXM5 enables 66 of GH100's 72 TPCs, so SMs go dark in TPC pairs.
  // Which TPCs are fused off varies chip to chip; this pattern is an example.
  // SMs are numbered along each GPC's rows, so SMs 2k and 2k+1 form TPC k.
  const rng = makeRng(0x9100)
  const disabled = new Set<number>()
  const tpcsOff = (totalSms - GPU.enabledSms) / GPU.smsPerTpc
  const offTpcs = new Set<number>()
  while (offTpcs.size < tpcsOff) offTpcs.add(Math.floor(rng() * (totalSms / GPU.smsPerTpc)))
  for (const k of offTpcs) for (let m = 0; m < GPU.smsPerTpc; m++) disabled.add(k * GPU.smsPerTpc + m)

  const smBody = new THREE.InstancedMesh(unit, surface({ color: 'computeDim', roughness: 0.55, metalness: 0.25, nightRoughness: 0.6 }), totalSms)
  const roofMat = signal({ color: 'compute', glow: 0.42, nightBase: 0.3 })
  const smRoof = new THREE.InstancedMesh(unit, roofMat, GPU.enabledSms)
  const smOff = new THREE.InstancedMesh(unit, surface({ color: 'computeDim', roughness: 0.7 }), totalSms - GPU.enabledSms)
  const tensor = new THREE.InstancedMesh(unit, signal({ color: 'tensor', glow: 0.5, nightBase: 0.3 }), GPU.enabledSms * 4)
  const l1 = new THREE.InstancedMesh(unit, signal({ color: 'sram', glow: 0.32 }), GPU.enabledSms)
  const gpcPad = new THREE.InstancedMesh(unit, surface({ color: 'seal', roughness: 0.55, metalness: 0.4 }), GPU.gpcs)
  const gpcHub = new THREE.InstancedMesh(unit, surface({ color: 'controller', roughness: 0.6, metalness: 0.2 }), GPU.gpcs)
  for (const m of [smBody, smRoof, smOff, tensor, l1, gpcPad, gpcHub]) group.add(m)
  smBody.name = 'gpu.sm'

  const gpcCenters: [number, number, number, number][] = []
  let sm = 0
  let on = 0
  let off = 0
  for (let g = 0; g < GPU.gpcs; g++) {
    const south = g >= GPU.gpcs / 2
    const k = g % (GPU.gpcs / 2)
    const c = k % GPU_PLAN.gpcCols
    const r = Math.floor(k / GPU_PLAN.gpcCols)
    const x0 = -inner + 4 + c * gpcW
    const zSide = south ? 1 : -1
    const zNear = halfZ0 + r * (gpcD + 6)
    const z0 = zSide > 0 ? zNear : -(zNear + gpcD)
    gpcCenters.push([x0 + gpcW / 2, z0 + gpcD / 2, gpcW, gpcD])
    put(gpcPad, g, x0 + gpcW / 2, ACTIVE, z0 + gpcD / 2, gpcW - 2, 0.5, gpcD - 2)
    // GPC hub (raster engine, ROPs) along the edge nearer the L2.
    const hubZ = zSide > 0 ? z0 + 3.2 : z0 + gpcD - 3.2
    put(gpcHub, g, x0 + gpcW / 2, ACTIVE + 0.5, hubZ, gpcW - 8, 2.4, 3.6)
    const smZ0 = zSide > 0 ? z0 + 7 : z0 + 1.5
    const cellW = (gpcW - 4) / smCols
    const cellD = (gpcD - 8.5) / smRows
    for (let j = 0; j < smRows; j++) {
      for (let i = 0; i < smCols; i++) {
        const x = x0 + 2 + cellW * (i + 0.5)
        const z = smZ0 + cellD * (j + 0.5)
        const w = cellW * 0.8
        const d = cellD * 0.78
        // short enough that roofs and tensor cores stay inside the die's true
        // 775 µm thickness when heights are shown at true scale
        const h = 4.6
        put(smBody, sm, x, ACTIVE + 0.5, z, w, h, d)
        if (disabled.has(sm)) {
          put(smOff, off++, x, ACTIVE + 0.5 + h, z, w * 0.96, 0.4, d * 0.96)
        } else {
          put(smRoof, on, x, ACTIVE + 0.5 + h, z, w * 0.96, 0.35, d * 0.96)
          // four tensor cores per SM, one per SM sub-partition
          for (let t = 0; t < 4; t++) {
            const tx = x + (t % 2 === 0 ? -1 : 1) * w * 0.22
            const tz = z + (t < 2 ? -1 : 1) * d * 0.22
            put(tensor, on * 4 + t, tx, ACTIVE + 0.85 + h, tz, w * 0.3, 0.8, d * 0.3)
          }
          // L1 / shared memory along one side of the SM
          put(l1, on, x, ACTIVE + 0.5, z + d * 0.5 + 0.35, w * 0.9, 2.2, 0.7)
          on++
        }
        sm++
      }
    }
  }

  /* ---- L2 and crossbar ---------------------------------------------------- */
  const l2Cols = 10
  const l2Rows = 3
  const l2Mat = signal({ color: 'sram', glow: 0.3 })
  const l2 = new THREE.InstancedMesh(unit, l2Mat, 2 * l2Cols * l2Rows)
  let li = 0
  for (let half = 0; half < 2; half++) {
    const xa = half === 0 ? -inner : 6
    const xb = half === 0 ? -6 : inner
    for (let i = 0; i < l2Cols; i++) {
      for (let j = 0; j < l2Rows; j++) {
        const x = xa + ((xb - xa) * (i + 0.5)) / l2Cols
        const z = -GPU_PLAN.l2Half + ((2 * GPU_PLAN.l2Half) * (j + 0.5)) / l2Rows
        put(l2, li++, x, ACTIVE, z, ((xb - xa) / l2Cols) * 0.84, 3.2, ((2 * GPU_PLAN.l2Half) / l2Rows) * 0.8)
      }
    }
  }
  l2.name = 'gpu.l2'
  group.add(l2)
  const xbar = new THREE.Mesh(unit, surface({ color: 'seal', roughness: 0.4, metalness: 0.6 }))
  xbar.scale.set(9, 2, 2 * GPU_PLAN.l2Half + 6)
  xbar.position.set(0, ACTIVE + 1, 0)
  xbar.name = 'gpu.xbar'
  group.add(xbar)

  /* ---- memory side: PHYs and controllers --------------------------------- */
  const phy = new THREE.InstancedMesh(unit, signal({ color: 'link', glow: 1.1 }), HBF.stacksPerGpu * HBF.channelsPerStack)
  const mc = new THREE.InstancedMesh(unit, signal({ color: 'controller', glow: 0.5 }), HBF.stacksPerGpu)
  phy.name = 'gpu.phy'
  mc.name = 'gpu.mc'
  group.add(phy, mc)
  const [pv0, pv1] = BASE_PLAN.phySpanV
  for (const site of STACK_SITES) {
    const edge = site.side === 'west' ? -HX : HX
    const inward = site.side === 'west' ? 1 : -1
    for (let c = 0; c < HBF.channelsPerStack; c++) {
      const v = pv0 + ((pv1 - pv0) * (c + 0.5)) / HBF.channelsPerStack
      put(phy, site.index * HBF.channelsPerStack + c, edge + inward * (GPU_PLAN.phyDepth / 2), ACTIVE, stackV(site, v), GPU_PLAN.phyDepth - 1, 1.6, UCIE.moduleWidthMm * MM * 0.82)
    }
    put(mc, site.index, edge + inward * (GPU_PLAN.phyDepth + GPU_PLAN.mcDepth / 2), ACTIVE, site.z, GPU_PLAN.mcDepth - 2, 3.4, STACK.width * 0.72)
  }

  /* ---- I/O edges ------------------------------------------------------------ */
  const nvl = new THREE.InstancedMesh(unit, signal({ color: 'link', glow: 0.55 }), 18)
  for (let i = 0; i < 18; i++) {
    const x = -inner + ((2 * inner) * (i + 0.5)) / 18
    put(nvl, i, x, ACTIVE, HZ - GPU_PLAN.ioDepth / 2, ((2 * inner) / 18) * 0.7, 1.6, GPU_PLAN.ioDepth - 3)
  }
  nvl.name = 'gpu.nvlink'
  const host = new THREE.Mesh(unit, signal({ color: 'link', glow: 0.55 }))
  host.scale.set(inner * 1.1, 1.6, GPU_PLAN.ioDepth - 3)
  host.position.set(0, ACTIVE + 0.8, -HZ + GPU_PLAN.ioDepth / 2)
  host.name = 'gpu.host'
  const giga = new THREE.Mesh(unit, surface({ color: 'controller', roughness: 0.6 }))
  giga.scale.set(30, 2.6, 7)
  giga.position.set(inner * 0.55 + 18, ACTIVE + 1.3, -HZ + GPU_PLAN.ioDepth / 2)
  giga.name = 'gpu.gigathread'
  group.add(nvl, host, giga)

  for (const m of [smBody, smRoof, smOff, tensor, l1, gpcPad, gpcHub, l2, phy, mc, nvl]) {
    m.instanceMatrix.needsUpdate = true
    m.computeBoundingSphere()
  }

  /* ---- bulk silicon ghost ---------------------------------------------------- */
  const ghostMat = new THREE.MeshStandardMaterial({ transparent: true, depthWrite: false, roughness: 0.15, metalness: 0.6 })
  themed((mode, p) => {
    ghostMat.color.setHex(p.ghost)
    ghostMat.opacity = mode === 'night' ? 0.06 : 0.14
  })
  const ghost = new THREE.Mesh(unit, ghostMat)
  ghost.name = 'gpu.bulk'
  ghost.renderOrder = 2
  // Clicks go through the ghost to the circuits underneath.
  ghost.userData.noPick = true
  const ghostEdges = new THREE.LineSegments(new THREE.EdgesGeometry(unit), lineMat('ghostEdge', 0.55))
  ghostEdges.renderOrder = 3
  group.add(ghost, ghostEdges)

  function layoutGhost(state: SceneState): void {
    const top = gpuHeight(state.verticalScale)
    const h = Math.max(0.01, top - ACTIVE)
    ghost.scale.set(GPU_DIE.width, h, GPU_DIE.length)
    ghost.position.set(0, ACTIVE + h / 2, 0)
    ghostEdges.scale.copy(ghost.scale)
    ghostEdges.position.copy(ghost.position)
    ghost.visible = state.showBulkSilicon
    ghostEdges.visible = state.showBulkSilicon
  }
  layoutGhost(ctx.state)

  /* ---- components ------------------------------------------------------------ */
  const bb = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => (out: THREE.Box3) =>
    out.set(_p.set(x0, y0, z0), _s.set(x1, y1, z1))

  ctx.register({
    id: 'gpu',
    name: () => t('comp.gpu.name'),
    role: () => t('comp.gpu.role'),
    kind: 'compute',
    district: 'gpu',
    object: slab,
    bounds: (out) => out.set(_p.set(-HX, 0, -HZ), _s.set(HX, gpuHeight(ctx.state.verticalScale), HZ)),
    tier: 0,
    doc: 'gpu',
    color: 'compute',
  })
  ctx.register({
    id: 'gpu.bulk',
    name: () => t('comp.bulk.name'),
    role: () => t('comp.bulk.role'),
    kind: 'package',
    district: 'gpu',
    object: ghost,
    bounds: (out) => out.set(_p.set(-HX, ACTIVE, -HZ), _s.set(HX, gpuHeight(ctx.state.verticalScale), HZ)),
    tier: 2,
    doc: 'bulk',
    labelWhen: () => ctx.state.showBulkSilicon,
    // at a top corner, not on the GPU die's own label at the top centre
    labelAt: (out) => out.set(-HX * 0.7, gpuHeight(ctx.state.verticalScale), -HZ * 0.7),
  })
  const smPerGpc = GPU.tpcsPerGpc * GPU.smsPerTpc
  for (let g = 0; g < GPU.gpcs; g++) {
    const [cx, cz, w, d] = gpcCenters[g]
    ctx.register({
      id: `gpu.gpc.${g}`,
      name: () => t('comp.gpc.name', { g }),
      role: () => t('comp.gpc.role', { t: GPU.tpcsPerGpc, s: smPerGpc }),
      kind: 'compute',
      district: 'gpu',
      object: smBody,
      instances: Array.from({ length: smPerGpc }, (_, j) => g * smPerGpc + j),
      bounds: bb(cx - w / 2, 0, cz - d / 2, cx + w / 2, ACTIVE + 6.3, cz + d / 2),
      tier: 2,
      doc: 'gpc',
      color: 'compute',
    })
  }
  ctx.register({
    id: 'gpu.l2',
    name: () => t('comp.l2.name'),
    role: () => t('comp.l2.role', { m: GPU.l2MB }),
    kind: 'memory',
    district: 'gpu',
    object: l2,
    instances: Array.from({ length: li }, (_, j) => j),
    bounds: bb(-inner, 0, -GPU_PLAN.l2Half, inner, ACTIVE + 4, GPU_PLAN.l2Half),
    tier: 1,
    doc: 'l2',
    color: 'sram',
  })
  for (const site of STACK_SITES) {
    const edge = site.side === 'west' ? -HX : HX
    const inward = site.side === 'west' ? 1 : -1
    const xb = edge + inward * (GPU_PLAN.phyDepth + GPU_PLAN.mcDepth)
    ctx.register({
      id: `gpu.phy.${site.index}`,
      name: () => t('comp.gpuPhy.name', { s: site.index }),
      role: () => t('comp.gpuPhy.role', { s: site.index }),
      kind: 'link',
      district: 'gpu',
      object: phy,
      instances: Array.from({ length: HBF.channelsPerStack }, (_, c) => site.index * HBF.channelsPerStack + c),
      // the PHY strip: the outer phyDepth of the edge, over the span of the stack's modules
      bounds: bb(
        Math.min(edge, edge + inward * GPU_PLAN.phyDepth), 0, stackV(site, BASE_PLAN.phySpanV[0]),
        Math.max(edge, edge + inward * GPU_PLAN.phyDepth), ACTIVE + 4, stackV(site, BASE_PLAN.phySpanV[1]),
      ),
      tier: 2,
      doc: 'gpuPhy',
      color: 'link',
      stack: site.index,
      labelWhen: () => ctx.state.focusStack === site.index,
    })
    ctx.register({
      id: `gpu.mc.${site.index}`,
      name: () => t('comp.mc.name', { s: site.index }),
      role: () => t('comp.mc.role', { s: site.index }),
      kind: 'circuit',
      district: 'gpu',
      object: mc,
      instances: [site.index],
      // the controller sits just inside the PHY strip
      bounds: bb(
        Math.min(edge + inward * GPU_PLAN.phyDepth, xb), 0, site.z - STACK.width * 0.36,
        Math.max(edge + inward * GPU_PLAN.phyDepth, xb), ACTIVE + 4, site.z + STACK.width * 0.36,
      ),
      tier: 2,
      doc: 'gpuMc',
      color: 'controller',
      stack: site.index,
      labelWhen: () => ctx.state.focusStack === site.index,
    })
  }
  ctx.register({
    id: 'gpu.nvlink',
    name: () => t('comp.nvlink.name'),
    role: () => t('comp.nvlink.role'),
    kind: 'link',
    district: 'gpu',
    object: nvl,
    instances: Array.from({ length: 18 }, (_, i) => i),
    bounds: bb(-inner, 0, HZ - GPU_PLAN.ioDepth, inner, ACTIVE + 3, HZ),
    tier: 1,
    doc: 'nvlink',
    color: 'link',
  })
  ctx.register({
    id: 'gpu.host',
    name: () => t('comp.host.name'),
    role: () => t('comp.host.role'),
    kind: 'link',
    district: 'gpu',
    object: host,
    bounds: bb(-inner * 0.55, 0, -HZ, inner * 0.55, ACTIVE + 3, -HZ + GPU_PLAN.ioDepth),
    tier: 1,
    doc: 'host',
    color: 'link',
  })

  // Activity scales the themed glow; capture the themed values each frame.
  let roofBase = roofMat.emissiveIntensity
  let l2Base = l2Mat.emissiveIntensity
  themed(() => {
    roofBase = roofMat.emissiveIntensity
    l2Base = l2Mat.emissiveIntensity
  })

  return {
    id: 'gpu',
    group,
    ghost,
    update(_dt, state) {
      layoutGhost(state)
    },
    setActivity(compute, read) {
      roofMat.emissiveIntensity = roofBase * (0.35 + 1.1 * compute)
      l2Mat.emissiveIntensity = l2Base * (0.4 + 1.2 * read)
    },
  }
}
