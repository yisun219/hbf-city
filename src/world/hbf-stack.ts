import * as THREE from 'three'
import { HBF, UCIE, channelOfDie } from '../core/hbf-spec'
import { t } from '../core/i18n'
import { signal, surface, type PaletteKey } from '../core/theme'
import type { SceneState, WorldContext, WorldModule } from '../core/types'
import { clamp, damp } from '../core/util'
import { createCoreDieMaterial } from './die-material'
import { addFlowAttributes, createFlowMaterial } from './flow-material'
import type { Activity } from './activity'
import {
  BASE_PLAN,
  DIE_PLAN,
  DRAWER_SLIDE,
  MM,
  STACK,
  STACK_SITES,
  createStackLayers,
  stackLayers,
  stackU,
  stackV,
} from './layout'
import type { StackLayers, StackSite } from './layout'
import type { OccupancyAtlas } from './occupancy'

/* ============================================================================
 * HBF STACKS — six towers, each a base die and sixteen core dies.
 *
 * Every die is an instance: one draw for all 96 core dies, one for their bond
 * layers, one per kind of base-die block, one per kind of TSV. Opening a stack
 * only rewrites instance matrices.
 *
 *   base die        logic die on the interposer (OCP Fig. 1): 16 UCIe PHY
 *                   modules on the GPU-facing edge, 16 channel controllers,
 *                   the NAND-side PHY / TSV landing strip, SRAM banks, and the
 *                   shared test blocks
 *   core dies       16 NAND dies, each an array wafer bonded to a CMOS wafer;
 *                   the floor plan is drawn by die-material.ts
 *   bond layers     microbump / hybrid-bond layer under each core die
 *   TSVs            a sample of the signal TSVs in the centre strip and the
 *                   power TSVs along the long edges, as columns through the
 *                   stack (real stacks carry thousands)
 * ==========================================================================*/

export interface StacksModule extends WorldModule {
  /** live layer heights, one per stack */
  readonly layers: readonly StackLayers[]
  coreDies: THREE.InstancedMesh
  baseDies: THREE.InstancedMesh
  setSelectedDie(stack: number, die: number): void
  /**
   * The NAND block under a ray hit on a core die's top face, by the same
   * floor-plan arithmetic as the die shader; null off the block array.
   */
  blockAt(hit: THREE.Intersection): BlockHit | null
  /** drive TSV pulses from per-die activity; call every frame */
  setActivity(activity: Activity, wallDt: number): void
}

const N_DIES = HBF.diesPerStack
const N_STACKS = HBF.stacksPerGpu

export interface BlockHit {
  stack: number
  /** die within its stack, 0 = bottom */
  die: number
  /** die index across the package, stack x 16 + die */
  global: number
  plane: number
  block: number
}

const _hitM = new THREE.Matrix4()
const _hitP = new THREE.Vector3()

/** Signal-TSV columns drawn per stack: two rows along the centre strip. */
const SIG_COLS = 24
/** Power-TSV columns per stack: one row along each long edge. */
const PWR_COLS = 12

const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _p = new THREE.Vector3()
const _s = new THREE.Vector3()

function setBox(mesh: THREE.InstancedMesh, i: number, x: number, y0: number, z: number, sx: number, sy: number, sz: number): void {
  _p.set(x, y0 + sy / 2, z)
  _s.set(sx, Math.max(sy, 1e-4), sz)
  _m.compose(_p, _q, _s)
  mesh.setMatrixAt(i, _m)
}

interface BaseBlock {
  stack: number
  /** footprint in world units */
  x: number
  z: number
  sx: number
  sz: number
  /** relative height, multiplied by the room above the base die */
  h: number
}

function baseBlocks(site: StackSite): Record<'phy' | 'ctrl' | 'sram' | 'landing' | 'debug', BaseBlock[]> {
  const out = { phy: [] as BaseBlock[], ctrl: [] as BaseBlock[], sram: [] as BaseBlock[], landing: [] as BaseBlock[], debug: [] as BaseBlock[] }
  const s = site.index
  const ux = (a: number, b: number) => {
    const x0 = stackU(site, a)
    const x1 = stackU(site, b)
    return { x: (x0 + x1) / 2, sx: Math.abs(x1 - x0) }
  }

  // 16 UCIe-A x64 modules, each ~0.389 mm wide (DASH §IV-A), on the PHY edge.
  const phy = ux(BASE_PLAN.phyU[0], BASE_PLAN.phyU[1])
  const [pv0, pv1] = BASE_PLAN.phySpanV
  const pitchV = (pv1 - pv0) / HBF.channelsPerStack
  for (let c = 0; c < HBF.channelsPerStack; c++) {
    const v = pv0 + (c + 0.5) * pitchV
    out.phy.push({ stack: s, x: phy.x, z: stackV(site, v), sx: phy.sx, sz: UCIE.moduleWidthMm * MM * 0.82, h: 0.7 })
  }

  // One controller lane per channel, eight either side of the centre strip.
  const ctrl = ux(BASE_PLAN.ctrlU[0], BASE_PLAN.ctrlU[1])
  const laneSpan = 0.5 - DIE_PLAN.spineHalf - 0.06
  for (let c = 0; c < HBF.channelsPerStack; c++) {
    const north = c < 8
    const k = c % 8
    const v0 = north ? 0.06 + (k / 8) * laneSpan : 0.5 + DIE_PLAN.spineHalf + (k / 8) * laneSpan
    const vMid = v0 + laneSpan / 16
    out.ctrl.push({ stack: s, x: ctrl.x, z: stackV(site, vMid), sx: ctrl.sx, sz: (laneSpan / 8) * STACK.width * 0.72, h: 0.5 })
  }

  // NAND-side PHY: the TSV landing strip the core dies' signal TSVs stand on.
  const land = ux(BASE_PLAN.tsvU[0], BASE_PLAN.tsvU[1])
  out.landing.push({ stack: s, x: land.x, z: site.z, sx: land.sx, sz: DIE_PLAN.spineHalf * 2 * STACK.width * 0.8, h: 0.28 })

  // SRAM: 40 MB per stack (HBFlex §4.1), drawn as 2 x 6 x 4 banks.
  const sramCols = 6
  const sramRows = 4
  const [su0, su1] = BASE_PLAN.sramU
  for (let half = 0; half < 2; half++) {
    const v0 = half === 0 ? 0.06 : 0.5 + DIE_PLAN.spineHalf + 0.01
    const v1 = half === 0 ? 0.5 - DIE_PLAN.spineHalf - 0.01 : 0.94
    for (let i = 0; i < sramCols; i++) {
      for (let j = 0; j < sramRows; j++) {
        const ua = su0 + ((su1 - su0) * i) / sramCols
        const ub = su0 + ((su1 - su0) * (i + 1)) / sramCols
        const va = v0 + ((v1 - v0) * j) / sramRows
        const vb = v0 + ((v1 - v0) * (j + 1)) / sramRows
        const r = ux(ua, ub)
        out.sram.push({
          stack: s,
          x: r.x,
          z: stackV(site, (va + vb) / 2),
          sx: r.sx * 0.84,
          sz: (vb - va) * STACK.width * 0.8,
          h: 0.85,
        })
      }
    }
  }

  // Shared test and debug blocks (OCP Fig. 1): DA port, TSV repair,
  // IEEE 1500, IEEE 1149.1, BIST.
  const dbg = ux(BASE_PLAN.debugU[0], BASE_PLAN.debugU[1])
  for (let k = 0; k < 5; k++) {
    const v = 0.12 + (k / 4) * 0.76
    out.debug.push({ stack: s, x: dbg.x, z: stackV(site, v), sx: dbg.sx * 0.8, sz: 0.11 * STACK.width, h: 0.45 })
  }
  return out
}

export function createStacks(ctx: WorldContext, occupancy: OccupancyAtlas, activity: Activity): StacksModule {
  const group = new THREE.Group()
  group.name = 'stacks'
  const unit = new THREE.BoxGeometry(1, 1, 1)

  /* ---- base dies ------------------------------------------------------- */
  const baseSide = surface({ color: 'silicon', roughness: 0.4, metalness: 0.5 })
  const baseTop = surface({ color: 'siliconTop', roughness: 0.55, metalness: 0.3 })
  const baseBottom = surface({ color: 'bond', roughness: 0.9 })
  const baseDies = new THREE.InstancedMesh(unit, [baseSide, baseSide, baseTop, baseBottom, baseSide, baseSide], N_STACKS)
  baseDies.name = 'stacks.base'
  group.add(baseDies)

  /* ---- base-die blocks -------------------------------------------------- */
  const blocks = { phy: [] as BaseBlock[], ctrl: [] as BaseBlock[], sram: [] as BaseBlock[], landing: [] as BaseBlock[], debug: [] as BaseBlock[] }
  for (const site of STACK_SITES) {
    const b = baseBlocks(site)
    for (const k of Object.keys(blocks) as (keyof typeof blocks)[]) blocks[k].push(...b[k])
  }
  const blockMeshes = {
    phy: new THREE.InstancedMesh(unit, signal({ color: 'link', glow: 1.1 }), blocks.phy.length),
    ctrl: new THREE.InstancedMesh(unit, signal({ color: 'controller', glow: 0.55 }), blocks.ctrl.length),
    sram: new THREE.InstancedMesh(unit, signal({ color: 'sram', glow: 0.6 }), blocks.sram.length),
    landing: new THREE.InstancedMesh(unit, surface({ color: 'copper', roughness: 0.3, metalness: 0.9 }), blocks.landing.length),
    debug: new THREE.InstancedMesh(unit, surface({ color: 'debug', roughness: 0.6, metalness: 0.2 }), blocks.debug.length),
  }
  for (const [k, mesh] of Object.entries(blockMeshes)) {
    mesh.name = `stacks.base.${k}`
    group.add(mesh)
  }

  /* ---- core dies -------------------------------------------------------- */
  const dieGeo = unit.clone()
  const aDie = new Float32Array(N_STACKS * N_DIES)
  const aFlip = new Float32Array(N_STACKS * N_DIES)
  for (let s = 0; s < N_STACKS; s++) {
    for (let d = 0; d < N_DIES; d++) {
      aDie[s * N_DIES + d] = s * N_DIES + d
      // u = 0.5 + flip * x puts u = 0 on the GPU-facing edge.
      aFlip[s * N_DIES + d] = -STACK_SITES[s].inward
    }
  }
  dieGeo.setAttribute('aDie', new THREE.InstancedBufferAttribute(aDie, 1))
  dieGeo.setAttribute('aFlip', new THREE.InstancedBufferAttribute(aFlip, 1))
  const coreMat = createCoreDieMaterial(occupancy.texture, activity.texture)
  const coreDies = new THREE.InstancedMesh(dieGeo, coreMat.material, N_STACKS * N_DIES)
  coreDies.name = 'stacks.core'
  group.add(coreDies)

  const bonds = new THREE.InstancedMesh(unit, surface({ color: 'bond', roughness: 0.85, metalness: 0.1 }), N_STACKS * N_DIES)
  bonds.name = 'stacks.bond'
  group.add(bonds)

  /* ---- TSV columns ------------------------------------------------------ */
  const col = new THREE.CylinderGeometry(0.5, 0.5, 1, 10, 1, false)
  // Signal TSVs carry reads down to the base die: pulses run downward.
  const sigGeo = col.clone()
  const tsvFlow = addFlowAttributes(sigGeo, N_STACKS * SIG_COLS * 2, () => -1).flow
  const tsvMat = createFlowMaterial({ base: 'tsv', pulse: 'tsv', axis: 'y', spacing: 9, speed: 26, nightBase: 0.45, dayGlow: 0.7 })
  const sigTsv = new THREE.InstancedMesh(sigGeo, tsvMat.material, N_STACKS * SIG_COLS * 2)
  const pwrTsv = new THREE.InstancedMesh(col, surface({ color: 'copper', roughness: 0.28, metalness: 0.95 }), N_STACKS * PWR_COLS * 2)
  sigTsv.name = 'stacks.tsv.signal'
  pwrTsv.name = 'stacks.tsv.power'
  group.add(sigTsv, pwrTsv)

  for (const mesh of [baseDies, coreDies, bonds, sigTsv, pwrTsv, ...Object.values(blockMeshes)]) {
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    mesh.frustumCulled = false
  }

  /* ---- layout ----------------------------------------------------------- */
  const layers = STACK_SITES.map(() => createStackLayers())
  const lastKey = new Float64Array(N_STACKS * 4).fill(NaN)
  /** World-x offset of each stack's drawer die (the selected die, slid out). */
  const slideX = new Float64Array(N_STACKS)

  function layoutStack(s: number, state: SceneState): void {
    const site = STACK_SITES[s]
    const L = stackLayers(state.verticalScale, state.explode[s], state.liftedDie[s], state.lift[s], layers[s])
    const drawer = state.liftedDie[s] >= 0 ? state.liftedDie[s] : -1
    // ease the slide so the die leaves the slot smoothly
    const t = state.lift[s]
    slideX[s] = drawer >= 0 ? -site.inward * DRAWER_SLIDE * t * t * (3 - 2 * t) : 0
    setBox(baseDies, s, site.x, L.baseBottom, site.z, STACK.length, L.baseTop - L.baseBottom, STACK.width)
    for (let d = 0; d < N_DIES; d++) {
      const i = s * N_DIES + d
      const x = d === drawer ? site.x + slideX[s] : site.x
      setBox(coreDies, i, x, L.dieBottom[d], site.z, STACK.length, L.dieTop[d] - L.dieBottom[d], STACK.width)
      setBox(bonds, i, x, L.bondBottom[d], site.z, STACK.length * 0.996, L.dieBottom[d] - L.bondBottom[d], STACK.width * 0.996)
    }

    // Base-die blocks grow into the room the opening stack makes above them.
    const room = L.bondBottom[0] - L.baseTop
    const hMax = clamp(room * 0.55, 0.04, 6)
    for (const [k, mesh] of Object.entries(blockMeshes) as [keyof typeof blocks, THREE.InstancedMesh][]) {
      const list = blocks[k]
      const per = list.length / N_STACKS
      for (let j = 0; j < per; j++) {
        const i = s * per + j
        const b = list[i]
        setBox(mesh, i, b.x, L.baseTop, b.z, b.sx, hMax * b.h, b.sz)
      }
    }

    // TSV columns: from the base die up through every core die but the top one.
    const y0 = L.baseTop
    const y1 = L.dieBottom[N_DIES - 1] + (L.dieTop[N_DIES - 1] - L.dieBottom[N_DIES - 1]) * 0.5
    for (let r = 0; r < 2; r++) {
      const v = r === 0 ? 0.5 - DIE_PLAN.spineHalf * 0.5 : 0.5 + DIE_PLAN.spineHalf * 0.5
      for (let c = 0; c < SIG_COLS; c++) {
        const u = 0.08 + (c / (SIG_COLS - 1)) * 0.86
        const i = (s * 2 + r) * SIG_COLS + c
        setBox(sigTsv, i, stackU(site, u), y0, stackV(site, v), 0.55, y1 - y0, 0.55)
      }
      const pv = r === 0 ? (DIE_PLAN.powerRow[0] + DIE_PLAN.powerRow[1]) / 2 : 1 - (DIE_PLAN.powerRow[0] + DIE_PLAN.powerRow[1]) / 2
      for (let c = 0; c < PWR_COLS; c++) {
        const u = 0.06 + (c / (PWR_COLS - 1)) * 0.88
        const i = (s * 2 + r) * PWR_COLS + c
        setBox(pwrTsv, i, stackU(site, u), y0, stackV(site, pv), 0.75, y1 - y0, 0.75)
      }
    }
  }

  function markAll(): void {
    for (const mesh of [baseDies, coreDies, bonds, sigTsv, pwrTsv, ...Object.values(blockMeshes)]) {
      mesh.instanceMatrix.needsUpdate = true
      // Raycasting culls against a cached sphere; dies move when a stack opens.
      mesh.boundingSphere = null
      mesh.boundingBox = null
    }
  }

  for (let s = 0; s < N_STACKS; s++) layoutStack(s, ctx.state)
  markAll()

  /* ---- components ------------------------------------------------------- */
  for (const site of STACK_SITES) {
    const s = site.index
    const L = layers[s]
    const minX = site.x - STACK.length / 2
    const maxX = site.x + STACK.length / 2
    const minZ = site.z - STACK.width / 2
    const maxZ = site.z + STACK.width / 2
    const focused = () => ctx.state.focusStack === s
    const opened = () => focused() && ctx.state.explode[s] > 0.25
    const baseShown = () => focused() && L.bondBottom[0] - L.baseTop > 40

    ctx.register({
      id: `stack.${s}`,
      name: () => t('comp.stack.name', { s }),
      role: () => t('comp.stack.role', { side: t(`side.${site.side}`) }),
      kind: 'die',
      district: 'stack',
      object: coreDies,
      instances: [],
      bounds: (out) => out.set(_p.set(minX, 0, minZ), _s.set(maxX, L.top, maxZ)),
      tier: 0,
      doc: 'stack',
      color: 'kv',
      stack: s,
    })
    ctx.register({
      id: `stack.${s}.base`,
      name: () => t('comp.base.name'),
      role: () => t('comp.base.role', { s }),
      kind: 'circuit',
      district: 'stack',
      object: baseDies,
      instances: [s],
      bounds: (out) => out.set(_p.set(minX, L.baseBottom, minZ), _s.set(maxX, L.baseTop, maxZ)),
      tier: 2,
      doc: 'base',
      stack: s,
      labelWhen: opened,
    })
    const per = (k: keyof typeof blocks) => blocks[k].length / N_STACKS
    const range = (k: keyof typeof blocks) => Array.from({ length: per(k) }, (_, j) => s * per(k) + j)
    const blockBounds = (k: keyof typeof blocks) => (out: THREE.Box3) => {
      out.makeEmpty()
      const list = blocks[k]
      for (const i of range(k)) {
        const b = list[i]
        out.expandByPoint(_p.set(b.x - b.sx / 2, L.baseTop, b.z - b.sz / 2))
        out.expandByPoint(_p.set(b.x + b.sx / 2, L.baseTop + Math.max(1, (L.bondBottom[0] - L.baseTop) * 0.55), b.z + b.sz / 2))
      }
      return out
    }
    const parts: [keyof typeof blocks, PaletteKey][] = [
      ['phy', 'link'],
      ['ctrl', 'controller'],
      ['sram', 'sram'],
      ['landing', 'copper'],
      ['debug', 'debug'],
    ]
    for (const [k, color] of parts) {
      const doc = k
      ctx.register({
        id: `stack.${s}.${k}`,
        name: () => t(`comp.${k}.name`),
        role: () => t(`comp.${k}.role`, { s }),
        kind: k === 'sram' ? 'memory' : 'circuit',
        district: 'stack',
        object: blockMeshes[k],
        instances: range(k),
        bounds: blockBounds(k),
        tier: 2,
        doc,
        color,
        stack: s,
        labelWhen: baseShown,
      })
    }
    for (let d = 0; d < N_DIES; d++) {
      ctx.register({
        id: `stack.${s}.die.${d}`,
        name: () => t('comp.die.name', { d }),
        role: () => t('comp.die.role', { s, c: channelOfDie(d) }),
        kind: 'array',
        district: 'stack',
        object: coreDies,
        instances: [s * N_DIES + d],
        bounds: (out) => {
          const dx = ctx.state.liftedDie[s] === d ? slideX[s] : 0
          return out.set(_p.set(minX + dx, L.dieBottom[d], minZ), _s.set(maxX + dx, L.dieTop[d], maxZ))
        },
        tier: 2,
        doc: 'coreDie',
        color: 'kv',
        stack: s,
        die: d,
        labelWhen: () => focused() && (ctx.state.explode[s] > 0.55 || ctx.state.liftedDie[s] === d),
      })
    }
    ctx.register({
      id: `stack.${s}.tsv`,
      name: () => t('comp.tsv.name'),
      role: () => t('comp.tsv.role', { s }),
      kind: 'link',
      district: 'stack',
      object: sigTsv,
      instances: Array.from({ length: SIG_COLS * 2 }, (_, j) => s * SIG_COLS * 2 + j),
      bounds: (out) => out.set(_p.set(minX, L.baseTop, site.z - 4), _s.set(maxX, L.top, site.z + 4)),
      tier: 2,
      doc: 'tsv',
      color: 'tsv',
      stack: s,
      labelWhen: opened,
    })
    ctx.register({
      id: `stack.${s}.tsvPower`,
      name: () => t('comp.tsvPower.name'),
      role: () => t('comp.tsvPower.role', { s }),
      kind: 'link',
      district: 'stack',
      object: pwrTsv,
      instances: Array.from({ length: PWR_COLS * 2 }, (_, j) => s * PWR_COLS * 2 + j),
      bounds: (out) => out.set(_p.set(minX, L.baseTop, minZ), _s.set(maxX, L.top, maxZ)),
      tier: 2,
      doc: 'tsvPower',
      color: 'copper',
      stack: s,
    })
  }

  /* ---- per frame ---------------------------------------------------------- */
  function update(dt: number, state: SceneState): void {
    let any = false
    for (let s = 0; s < N_STACKS; s++) {
      // Explode follows its target.
      state.explode[s] = Math.abs(state.explodeTarget[s] - state.explode[s]) < 1e-3
        ? state.explodeTarget[s]
        : damp(state.explode[s], state.explodeTarget[s], 5.5, dt)

      // Uncovering a die: settle the old one before raising the new one.
      const want = state.liftedDieTarget[s]
      if (want !== state.liftedDie[s]) {
        state.lift[s] = damp(state.lift[s], 0, 9, dt)
        if (state.lift[s] < 0.02 || state.liftedDie[s] === -1) {
          state.lift[s] = 0
          state.liftedDie[s] = want
        }
      } else {
        const goal = want !== -1 ? 1 : 0
        state.lift[s] = Math.abs(goal - state.lift[s]) < 1e-3 ? goal : damp(state.lift[s], goal, 6, dt)
      }

      const k = s * 4
      if (
        lastKey[k] !== state.explode[s] ||
        lastKey[k + 1] !== state.lift[s] ||
        lastKey[k + 2] !== state.liftedDie[s] ||
        lastKey[k + 3] !== state.verticalScale
      ) {
        lastKey[k] = state.explode[s]
        lastKey[k + 1] = state.lift[s]
        lastKey[k + 2] = state.liftedDie[s]
        lastKey[k + 3] = state.verticalScale
        layoutStack(s, state)
        any = true
      }
    }
    if (any) markAll()
  }

  return {
    id: 'stacks',
    group,
    layers,
    coreDies,
    baseDies,
    update,
    setSelectedDie(stack: number, die: number) {
      coreMat.setSelectedDie(stack < 0 || die < 0 ? -1 : stack * N_DIES + die)
    },
    blockAt(hit) {
      const i = hit.instanceId
      if (hit.object !== coreDies || i === undefined || !hit.face || hit.face.normal.y < 0.5) return null
      // into the unit box the shader works in
      coreDies.getMatrixAt(i, _hitM)
      _hitM.premultiply(coreDies.matrixWorld).invert()
      _hitP.copy(hit.point).applyMatrix4(_hitM)
      const u = 0.5 + aFlip[i] * _hitP.x
      const v = _hitP.z + 0.5
      const [pu0, pu1] = DIE_PLAN.planeU
      if (u < pu0 || u >= pu1) return null
      const cols = HBF.planesPerDie / 2
      const uu = ((u - pu0) / (pu1 - pu0)) * cols
      const col = Math.floor(uu)
      const pu = uu - col
      const g = DIE_PLAN.gutter
      if (pu < g || pu > 1 - g) return null
      const ap = (pu - g) / (1 - 2 * g)
      if (ap < DIE_PLAN.staircase || ap > 1 - DIE_PLAN.staircase) return null
      const row = v < 0.5 ? 0 : 1
      const [r0, r1] = DIE_PLAN.rowV[row]
      // blocks count outward from the TSV strip in both rows, as in the shader
      const pv = row === 0 ? (r1 - v) / (r1 - r0) : (v - r0) / (r1 - r0)
      if (pv < 0 || pv >= 1) return null
      return { stack: Math.floor(i / N_DIES), die: i % N_DIES, global: i, plane: row * cols + col, block: Math.floor(pv * HBF.blocksPerPlane) }
    },
    setActivity(act, wallDt) {
      tsvMat.tick(wallDt)
      for (let s = 0; s < N_STACKS; s++) {
        let v = 0
        for (let d = 0; d < N_DIES; d++) v += act.read[s * N_DIES + d] + act.program[s * N_DIES + d]
        v /= N_DIES
        for (let j = 0; j < SIG_COLS * 2; j++) tsvFlow.setX(s * SIG_COLS * 2 + j, v)
      }
      tsvFlow.needsUpdate = true
    },
  }
}
