import type { PaletteKey } from './theme'
import type * as THREE from 'three'

/* ============================================================================
 * Contracts between the scene state, the world modules and the interface.
 *
 * Step 1 of HBFCity has no simulator yet. `SceneState` holds only what the
 * viewer controls (explode, scale, selection); the simulation state will join
 * it as a separate, three-free object in step 2.
 * ==========================================================================*/

export type ThemeMode = 'night' | 'day'

export type QualityLevel = 'low' | 'medium' | 'high'

export interface QualitySettings {
  level: QualityLevel
  pixelRatio: number
  bloom: boolean
  shadows: boolean
  ambientOcclusion: boolean
  antialias: boolean
}

/** Viewer-controlled presentation state. Written by the UI, read by the world. */
export interface SceneState {
  /** Target explode fraction per stack, 0 = bonded, 1 = fully opened. */
  explodeTarget: number[]
  /** Animated explode fraction per stack; the world reads this one. */
  explode: number[]
  /** Core die the reader asked to uncover, per stack; -1 = none. */
  liftedDieTarget: number[]
  /** Core die currently uncovered (follows the target once the old one has settled). */
  liftedDie: number[]
  /** Animated 0..1 uncovering of `liftedDie`. */
  lift: number[]
  /** Vertical exaggeration target; 1 = true proportions. */
  verticalScaleTarget: number
  verticalScale: number
  /** Show the GPU's bulk silicon above its active layer. */
  showBulkSilicon: boolean
  labels: boolean
  /** Currently selected stack index for stack-scoped controls. */
  focusStack: number
}

/* ---------------------------------------------------------------------------
 * Event bus.
 * -------------------------------------------------------------------------*/

export interface BusEvents {
  /** camera should frame a component */
  focus: { id: string | null; instant?: boolean }
  select: { id: string | null }
  hover: { id: string | null }
  toast: { text: string; kind?: 'info' | 'warn' | 'good'; ms?: number }
  theme: { mode: ThemeMode }
  'view:preset': { preset: 'home' | 'overview' | 'stack' }
  'scene:changed': Record<string, never>
}

export type BusHandler<K extends keyof BusEvents> = (payload: BusEvents[K]) => void

export interface Bus {
  on<K extends keyof BusEvents>(type: K, fn: BusHandler<K>): () => void
  once<K extends keyof BusEvents>(type: K, fn: BusHandler<K>): () => void
  off<K extends keyof BusEvents>(type: K, fn: BusHandler<K>): void
  emit<K extends keyof BusEvents>(type: K, payload: BusEvents[K]): void
}

/* ---------------------------------------------------------------------------
 * Components the reader can point at.
 * -------------------------------------------------------------------------*/

export type DistrictId = 'package' | 'gpu' | 'stack'

export type ComponentKind =
  | 'package'   // substrate, interposer
  | 'die'       // a whole die or stack
  | 'array'     // NAND planes, blocks
  | 'circuit'   // controllers, PHYs, logic
  | 'memory'    // SRAM
  | 'compute'   // SMs, GPCs
  | 'link'      // UCIe, TSVs

export interface FocusSpec {
  target: [number, number, number]
  distance: number
  /** preferred direction FROM target TO camera (need not be normalised) */
  dir?: [number, number, number]
}

export interface ComponentDef {
  id: string
  /** display name in the current language */
  name: () => string
  /** one-line subtitle in the current language */
  role: () => string
  kind: ComponentKind
  district: DistrictId
  /** Pickable root. When `instances` is set, the root is a shared InstancedMesh. */
  object: THREE.Object3D
  /** instance ids of `object` that belong to this component */
  instances?: readonly number[]
  /** extra gate on the floating label, e.g. only while a stack is open */
  labelWhen?: () => boolean
  /** label anchor override; defaults to the top centre of `bounds` */
  labelAt?: (out: THREE.Vector3) => THREE.Vector3
  /** Live world-space bounds; dies move when a stack opens. */
  bounds(out: THREE.Box3): THREE.Box3
  /** 0 = always labelled, 1 = landmark, 2 = detail */
  tier: 0 | 1 | 2
  /** key into ui/content.ts; defaults to the id's family */
  doc: string
  /** short live readout for the label and inspector header */
  readout?: () => string
  /** semantic colour for the label dot */
  /** palette role for the inspector's colour dot; follows the theme */
  color?: PaletteKey
  /** stack index for stack-scoped components */
  stack?: number
  /** core die index for die-scoped components */
  die?: number
}

/* ---------------------------------------------------------------------------
 * World modules.
 * -------------------------------------------------------------------------*/

export interface WorldContext {
  scene: THREE.Scene
  bus: Bus
  state: SceneState
  quality: QualitySettings
  register(def: ComponentDef): void
}

export interface WorldModule {
  id: string
  group: THREE.Object3D
  /** dt is real seconds since the last frame */
  update(dt: number, state: SceneState): void
  setTheme?(mode: ThemeMode): void
  dispose?(): void
}

/* ---------------------------------------------------------------------------
 * Inspector content.
 * -------------------------------------------------------------------------*/

export interface DocSection {
  heading: string
  /** tiny markdown subset: **bold**, `code` */
  body: string
}

export interface DocFact {
  label: string
  value: string
  /** source key from core/hbf-spec.ts SOURCES, or 'estimate' / 'derived' */
  source: string
}

export interface ComponentDoc {
  title: string
  subtitle: string
  tldr: string
  facts?: DocFact[]
  sections: DocSection[]
  /** honest limits of this part of the model */
  caveats?: string[]
  sources: { key: string; where: string }[]
}
