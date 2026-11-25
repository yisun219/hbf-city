import { GPU, HBF, THICKNESS_UM } from '../core/hbf-spec'

/* ============================================================================
 * THE PACKAGE PLAN — the single source of truth for geography.
 *
 * One coordinate system for everybody. Y is up; y = 0 is the top surface of
 * the silicon interposer. East is +X, south is +Z.
 *
 * Horizontal scale is uniform: 10 world units per millimetre, so a 16 mm HBF
 * stack is 160 units long. Vertical scale is exaggerated (default 12x) because
 * a 775 µm stack drawn at true proportion is a sheet of paper; the HUD can set
 * it back to 1x. Every height below is a function of that factor.
 *
 *                      ▲ -Z (north)
 *      s0  ┌──────┐ ┌───────────────┐ ┌──────┐  s3
 *      s1  │ HBF  │ │   GPU  die    │ │ HBF  │  s4
 *      s2  └──────┘ └───────────────┘ └──────┘  s5
 *                      ▼ +Z (south)
 *
 * Each stack's short edge faces the GPU: its UCIe PHYs sit on that edge and
 * the 16 host channels cross the gap to the GPU's matching PHY strip.
 * ==========================================================================*/

/** World units per millimetre, horizontally. */
export const MM = 10

/** Default vertical exaggeration; 1 = true proportions. */
export const DEFAULT_VERTICAL_SCALE = 12

/** World height of a physical thickness in µm at vertical scale `v`. */
export const umToY = (um: number, v: number): number => um * 1e-3 * MM * v

export const STACK = {
  /** along X, away from the GPU (16 mm) */
  length: HBF.footprintMm.length * MM,
  /** along Z, parallel to the GPU edge (10.975 mm) */
  width: HBF.footprintMm.width * MM,
} as const

export const GPU_DIE = {
  width: GPU.dieMm.width * MM,
  length: GPU.dieMm.length * MM,
} as const

/**
 * Gap between the GPU edge and a stack's PHY edge: 1.6 mm. No source gives the
 * real gap; OCP §5.1.1 keeps the UCIe channel under 2 mm bump to bump, and the
 * nearest drawn PHY edges are about 1.84 mm apart.
 */
export const GAP_GPU_STACK = 16
/** Gap between neighbouring stacks along the GPU edge. */
export const GAP_STACK_STACK = 4

export const INTERPOSER = {
  halfX: GPU_DIE.width / 2 + GAP_GPU_STACK + STACK.length + 12,
  halfZ: (3 * STACK.width + 2 * GAP_STACK_STACK) / 2 + 12,
} as const

export const SUBSTRATE = { halfX: 480, halfZ: 390, thickness: 26 } as const

/** Gap under the interposer: C4 bumps in underfill (~100 µm, estimate). */
export const C4_UM = 100

export interface StackSite {
  index: number
  /** 'west' stacks face east toward the GPU, 'east' stacks face west. */
  side: 'west' | 'east'
  /** centre of the footprint */
  x: number
  z: number
  /** +1 when the GPU lies toward +X from this stack, -1 otherwise */
  inward: 1 | -1
  /** x of the GPU-facing (PHY) edge */
  phyEdgeX: number
}

function makeSites(): StackSite[] {
  const sites: StackSite[] = []
  const cx = GPU_DIE.width / 2 + GAP_GPU_STACK + STACK.length / 2
  const dz = STACK.width + GAP_STACK_STACK
  for (let i = 0; i < HBF.stacksPerGpu; i++) {
    const west = i < 3
    const row = i % 3
    const x = west ? -cx : cx
    const inward: 1 | -1 = west ? 1 : -1
    sites.push({
      index: i,
      side: west ? 'west' : 'east',
      x,
      z: (row - 1) * dz,
      inward,
      phyEdgeX: x + inward * (STACK.length / 2),
    })
  }
  return sites
}

export const STACK_SITES: readonly StackSite[] = makeSites()

/** The stack the home view opens by default: behind and right of the GPU, so it never hides it. */
export const FEATURED_STACK = 3

/* ---------------------------------------------------------------------------
 * Vertical layout of one stack.
 * -------------------------------------------------------------------------*/

/** World units of extra air per die when a stack is fully opened. */
export const EXPLODE_GAP = 20
/** Extra rise of the dies above a lifted die, opening the slot it slides out of. */
export const LIFT_RISE = 16
/** `liftedDie` value that lifts every core die off the base die. */
export const LIFT_BASE = -2
/** How far the core dies rise when the base die is uncovered. */
export const BASE_RISE = 150
/** How far a selected die slides out of its stack, away from the GPU, like a drawer. */
export const DRAWER_SLIDE = STACK.length + 30

export interface StackLayers {
  baseBottom: number
  baseTop: number
  /** bottom of each core die's bond layer */
  bondBottom: Float64Array
  dieBottom: Float64Array
  dieTop: Float64Array
  top: number
}

export function createStackLayers(): StackLayers {
  const n = HBF.diesPerStack
  return {
    baseBottom: 0,
    baseTop: 0,
    bondBottom: new Float64Array(n),
    dieBottom: new Float64Array(n),
    dieTop: new Float64Array(n),
    top: 0,
  }
}

/**
 * Heights of every layer of one stack. Allocation-free when `out` is given.
 *
 *   verticalScale  1 = true proportions
 *   explode        0 = bonded stack, 1 = fully opened
 *   liftedDie      -1, a die whose floor plan is being uncovered, or LIFT_BASE
 *   lift           0..1 animation of that uncovering
 */
export function stackLayers(
  verticalScale: number,
  explode: number,
  liftedDie: number,
  lift: number,
  out: StackLayers = createStackLayers(),
): StackLayers {
  const base = umToY(THICKNESS_UM.baseDie, verticalScale)
  const bond = umToY(THICKNESS_UM.bond, verticalScale)
  const core = umToY(THICKNESS_UM.coreDie, verticalScale)
  const gap = Math.max(0, explode) * EXPLODE_GAP
  const riseAt = liftedDie === LIFT_BASE ? 0 : liftedDie >= 0 ? liftedDie + 1 : -1
  const rise = liftedDie === LIFT_BASE ? BASE_RISE : LIFT_RISE
  out.baseBottom = 0
  out.baseTop = base
  let y = base
  for (let i = 0; i < HBF.diesPerStack; i++) {
    y += gap
    if (i === riseAt) y += Math.max(0, lift) * rise
    out.bondBottom[i] = y
    y += bond
    out.dieBottom[i] = y
    y += core
    out.dieTop[i] = y
  }
  out.top = y
  return out
}

/** Height of the GPU die; coplanar with the stacks, as on a real package. */
export const gpuHeight = (verticalScale: number): number => umToY(HBF.heightUm, verticalScale)

/* ---------------------------------------------------------------------------
 * Core-die floor plan, in fractions of the die footprint.
 *
 * u runs along the stack's long axis from the GPU-facing edge (0) to the far
 * edge (1); v runs north (0) to south (1). The layout follows the published
 * diagrams — a centre strip of signal TSVs, power TSVs along both long edges,
 * and planes in two rows either side of the strip (FlashAccel Fig. 6c,
 * "HBF Sucks" Fig. 2). Real HBF die floor plans are not public.
 * -------------------------------------------------------------------------*/

export const DIE_PLAN = {
  seal: 0.008,
  /** power TSV rows along both long edges */
  powerRow: [0.014, 0.046] as const,
  /** half-width of the centre signal-TSV strip, in v */
  spineHalf: 0.04,
  /** plane columns occupy this u range */
  planeU: [0.022, 0.978] as const,
  /** plane rows: north and south of the spine */
  rowV: [
    [0.052, 0.455],
    [0.545, 0.948],
  ] as const,
  /** fraction of each plane column given to the gutter on either side */
  gutter: 0.045,
  /** fraction of each plane, at each u-end, taken by the word-line staircase */
  staircase: 0.085,
} as const

export interface PlaneRect {
  plane: number
  row: number
  col: number
  /** fractions of the die footprint */
  u0: number
  u1: number
  v0: number
  v1: number
}

/** Rectangle of one plane on the die, in footprint fractions. */
export function planeRect(plane: number): PlaneRect {
  const cols = HBF.planesPerDie / 2
  const row = Math.floor(plane / cols)
  const col = plane % cols
  const [ua, ub] = DIE_PLAN.planeU
  const colW = (ub - ua) / cols
  const u0 = ua + col * colW + colW * DIE_PLAN.gutter
  const u1 = ua + (col + 1) * colW - colW * DIE_PLAN.gutter
  const [v0, v1] = DIE_PLAN.rowV[row]
  return { plane, row, col, u0, u1, v0, v1 }
}

/** World x of a footprint fraction u for a stack (u = 0 at the PHY edge). */
export function stackU(site: StackSite, u: number): number {
  return site.phyEdgeX - site.inward * u * STACK.length
}

/** World z of a footprint fraction v (v = 0 at the north edge). */
export function stackV(site: StackSite, v: number): number {
  return site.z - STACK.width / 2 + v * STACK.width
}

/* ---------------------------------------------------------------------------
 * Base-die floor plan (fractions of the footprint, same u/v convention).
 *
 * OCP Fig. 1 per channel: UCIe PHY -> Base Die Controller -> NAND-side PHY,
 * plus shared DA port, TSV repair, IEEE 1500, IEEE 1149.1 and BIST blocks.
 * HBFlex's 40 MB of SRAM is drawn as banks either side of the TSV strip.
 * -------------------------------------------------------------------------*/

export const BASE_PLAN = {
  /** 16 UCIe PHY modules along the GPU-facing edge */
  phyU: [0.012, 0.085] as const,
  /** the modules span this much of the edge (16 x 0.389 mm of 10.975 mm) */
  phySpanV: [0.2165, 0.7835] as const,
  /** per-channel controller lanes */
  ctrlU: [0.105, 0.43] as const,
  /** NAND-side PHY / TSV landing strip along the centre, ending before the debug blocks */
  tsvU: [0.105, 0.905] as const,
  /** SRAM banks */
  sramU: [0.46, 0.9] as const,
  /** shared test and debug blocks at the far edge */
  debugU: [0.915, 0.985] as const,
} as const

/* ---------------------------------------------------------------------------
 * GPU floor plan (GH100-class, approximate).
 * -------------------------------------------------------------------------*/

export const GPU_PLAN = {
  /** memory-side PHY strips along west and east edges */
  phyDepth: 9,
  /** memory controllers just inside the PHYs */
  mcDepth: 12,
  /** central L2 band, half-depth in z */
  l2Half: 22,
  /** host interface and NVLink strips on the north and south edges */
  ioDepth: 12,
  /** GPC grid: 2 columns x 2 rows on each side of the L2 band */
  gpcCols: 2,
  gpcRowsPerHalf: 2,
} as const

/* ---------------------------------------------------------------------------
 * Camera anchors.
 * -------------------------------------------------------------------------*/

export const VIEW = {
  home: { target: [40, 70, -30] as [number, number, number], pos: [522, 417, 687] as [number, number, number] },
  overview: { target: [0, 0, 0] as [number, number, number], pos: [0, 1150, 24] as [number, number, number] },
} as const
