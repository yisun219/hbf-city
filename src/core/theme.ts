import * as THREE from 'three'
import type { ThemeMode } from './types'

/* ============================================================================
 * THEME — two rendering models over one scene: dark ("night" in code) and
 * light ("day").
 *
 * DARK: structure is matte and dark; meaning is emissive. Only semantic
 * surfaces (data in blocks, SRAM, links, compute) glow, and gently, so a
 * glow always says something without glare.
 *
 * LIGHT: a clean bench-light render. Bloom is off; hue and value carry
 * meaning and the package reads as physical material: dark substrate, grey
 * silicon, copper vias.
 *
 * Colour is semantic everywhere and is never reused for decoration:
 *   weights amber · valid KV blue · KV being written light blue ·
 *   invalid KV pink · free grey · SRAM green · compute violet ·
 *   UCIe and other links copper-orange · signal TSVs steel · power TSVs
 *   copper · controllers violet-grey
 * The block-state colours were checked with a colour-vision validator in
 * both modes: every pair stays apart for deuteranopia, protanopia and
 * normal vision. Wear is a single-hue (orange) ramp, light to dark by day
 * and dark to bright by night.
 * ==========================================================================*/

export interface Palette {
  bg: number
  fog: number
  skyZenith: number
  skyHorizon: number
  skyGlow: number
  board: number
  boardTrace: number
  substrate: number
  substrateEdge: number
  pad: number
  capBody: number
  capEnd: number
  interposer: number
  interposerTrace: number
  underfill: number
  silicon: number
  siliconTop: number
  seal: number
  copper: number
  bond: number
  ghost: number
  ghostEdge: number
  weights: number
  kv: number
  kvTail: number
  invalid: number
  free: number
  sram: number
  compute: number
  computeDim: number
  tensor: number
  link: number
  tsv: number
  controller: number
  debug: number
  ink: number
  inkDim: number
}

export const PALETTES: Record<ThemeMode, Palette> = {
  night: {
    bg: 0x060a12,
    fog: 0x0a111e,
    skyZenith: 0x03060d,
    skyHorizon: 0x16223a,
    skyGlow: 0x231f38,
    board: 0x07100f,
    boardTrace: 0x0f2a24,
    substrate: 0x0f1d19,
    substrateEdge: 0x182c25,
    pad: 0x8a6a2a,
    capBody: 0x3a3226,
    capEnd: 0x9a9da3,
    interposer: 0x1c2433,
    interposerTrace: 0x2a3a52,
    underfill: 0x0a0c10,
    silicon: 0x1b212c,
    siliconTop: 0x111722,
    seal: 0x343d4c,
    copper: 0xb86b3c,
    bond: 0x07090d,
    ghost: 0x6f8cc0,
    ghostEdge: 0x5d7fb8,
    weights: 0xd89a2b,
    kv: 0x3d8be6,
    kvTail: 0x86bbf8,
    invalid: 0xe07aa8,
    free: 0x1c2433,
    sram: 0x22a477,
    compute: 0x8f84ea,
    computeDim: 0x1d1e38,
    tensor: 0xb6aef5,
    link: 0xe0703a,
    tsv: 0x9fb2cc,
    controller: 0x8781b5,
    debug: 0x5f6b80,
    ink: 0xe8eef8,
    inkDim: 0x93a3ba,
  },
  day: {
    bg: 0xd3dae2,
    fog: 0xccd4dc,
    skyZenith: 0x7a9bc0,
    skyHorizon: 0xdfe6ec,
    skyGlow: 0xffe6c4,
    board: 0x1d3a2e,
    boardTrace: 0x2c5a44,
    substrate: 0x263a32,
    substrateEdge: 0x3a5246,
    pad: 0xc9a046,
    capBody: 0x8a7350,
    capEnd: 0xd8dade,
    interposer: 0x6d7480,
    interposerTrace: 0xb07a4c,
    underfill: 0x2c2f33,
    silicon: 0x8a93a1,
    siliconTop: 0x4c5563,
    seal: 0xa7afba,
    copper: 0xb5703f,
    bond: 0x23262b,
    ghost: 0x8fa7c8,
    ghostEdge: 0x4d6a94,
    weights: 0xe3a21a,
    kv: 0x2a78d6,
    kvTail: 0x7fb3f2,
    invalid: 0xe87ba4,
    free: 0xc3c8cf,
    sram: 0x1baf7a,
    compute: 0x6250d6,
    computeDim: 0x6d7392,
    tensor: 0x8f82e6,
    link: 0xeb6834,
    tsv: 0x6f8296,
    controller: 0x6a62a0,
    debug: 0x7b8494,
    ink: 0x18222e,
    inkDim: 0x5d6b7a,
  },
}

export interface Atmosphere {
  toneMapping: 'aces' | 'neutral'
  exposure: number
  fogNear: number
  fogFar: number
  hemiSky: number
  hemiGround: number
  hemiIntensity: number
  keyColor: number
  keyIntensity: number
  keyPos: readonly [number, number, number]
  fillColor: number
  fillIntensity: number
  fillPos: readonly [number, number, number]
  shadows: boolean
  bloom: boolean
  bloomStrength: number
  bloomRadius: number
  bloomThreshold: number
  /** Multiplier on semantic emissive colour. Night drives it past 1 for bloom. */
  glow: number
  daylight: boolean
  stars: boolean
}

export const ATMOSPHERE: Record<ThemeMode, Atmosphere> = {
  night: {
    toneMapping: 'aces',
    exposure: 1.05,
    fogNear: 900,
    fogFar: 3400,
    hemiSky: 0x2f538a,
    hemiGround: 0x070a12,
    hemiIntensity: 1.0,
    keyColor: 0xa8c8ff,
    keyIntensity: 1.35,
    keyPos: [-520, 820, 380],
    fillColor: 0x4a6fa5,
    fillIntensity: 0.5,
    fillPos: [-620, 340, 560],
    shadows: false,
    bloom: true,
    bloomStrength: 0.5,
    bloomRadius: 0.45,
    bloomThreshold: 0.86,
    glow: 1.2,
    daylight: false,
    stars: true,
  },
  day: {
    toneMapping: 'neutral',
    exposure: 1.0,
    fogNear: 1300,
    fogFar: 4200,
    hemiSky: 0xd6e4f2,
    hemiGround: 0x6d7682,
    hemiIntensity: 1.05,
    keyColor: 0xfff1dc,
    keyIntensity: 2.5,
    keyPos: [-620, 980, 520],
    fillColor: 0x9fb8d6,
    fillIntensity: 0.5,
    fillPos: [700, 360, -420],
    shadows: true,
    bloom: false,
    bloomStrength: 0,
    bloomRadius: 0.35,
    bloomThreshold: 1.2,
    glow: 0,
    daylight: true,
    stars: false,
  },
}

/* ---------------------------------------------------------------------------
 * Mode state.
 * -------------------------------------------------------------------------*/

const STORAGE_KEY = 'hbfcity.theme'

/** The visitor's explicit choice, if any; 'day' | 'night', or null to follow the system. */
function readStoredMode(): ThemeMode | null {
  try {
    const v = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY)
    return v === 'day' || v === 'night' ? v : null
  } catch {
    return null
  }
}

const systemQuery =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: light)') : null
const systemMode = (): ThemeMode => (systemQuery?.matches ? 'day' : 'night')

let chosen = readStoredMode()
let mode: ThemeMode = chosen ?? systemMode()

/** Live palette. Mutated in place on a mode switch so holders keep a valid ref. */
export const P: Palette = { ...PALETTES[mode] }

export function themeMode(): ThemeMode {
  return mode
}

export function atmosphere(): Atmosphere {
  return ATMOSPHERE[mode]
}

type Painter = (m: ThemeMode, p: Palette, air: Atmosphere) => void
const painters = new Set<Painter>()
const listeners = new Set<(m: ThemeMode) => void>()

/**
 * Register a repaint closure for a material or uniform set and run it once.
 * Every themed thing in the scene goes through here, so a mode switch is a
 * walk over this set and never a rebuild.
 */
export function themed(paint: Painter): () => void {
  painters.add(paint)
  paint(mode, P, ATMOSPHERE[mode])
  return () => painters.delete(paint)
}

export function onThemeMode(fn: (m: ThemeMode) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * Switch mode. `remember` stores it as the visitor's choice (the toolbar);
 * otherwise the page keeps following the system setting.
 */
export function setThemeMode(next: ThemeMode, remember = true): void {
  if (remember) {
    chosen = next
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      /* private mode: the choice simply does not persist */
    }
  }
  if (next === mode) return
  mode = next
  Object.assign(P, PALETTES[next])
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = next
  const air = ATMOSPHERE[next]
  for (const p of painters) p(next, P, air)
  for (const l of listeners) l(next)
}

export function toggleThemeMode(): ThemeMode {
  setThemeMode(mode === 'night' ? 'day' : 'night')
  return mode
}

// Until the visitor picks a mode, follow the operating system live.
systemQuery?.addEventListener?.('change', () => {
  if (chosen === null) setThemeMode(systemMode(), false)
})

/* ---------------------------------------------------------------------------
 * Material helpers.
 * -------------------------------------------------------------------------*/

export type PaletteKey = keyof Palette

export interface SurfaceSpec {
  /** structure colour */
  color: PaletteKey
  roughness?: number
  metalness?: number
  /** night roughness/metalness override for a moodier read */
  nightRoughness?: number
  nightMetalness?: number
  transparent?: boolean
  opacity?: number
  side?: THREE.Side
}

/** A matte structural material. Never glows. */
export function surface(spec: SurfaceSpec): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    transparent: spec.transparent ?? false,
    opacity: spec.opacity ?? 1,
    side: spec.side ?? THREE.FrontSide,
  })
  themed((md, p) => {
    m.color.setHex(p[spec.color])
    m.roughness = md === 'night' ? (spec.nightRoughness ?? spec.roughness ?? 0.7) : (spec.roughness ?? 0.7)
    m.metalness = md === 'night' ? (spec.nightMetalness ?? spec.metalness ?? 0.1) : (spec.metalness ?? 0.1)
  })
  return m
}

export interface SignalSpec {
  color: PaletteKey
  /** night emissive strength relative to the atmosphere's glow */
  glow?: number
  /** night albedo darkening, 0..1 */
  nightBase?: number
  roughness?: number
  metalness?: number
  transparent?: boolean
  opacity?: number
}

/**
 * A semantic material: emissive at night, saturated albedo by day. Use only
 * for surfaces whose colour is a claim about state or function.
 */
export function signal(spec: SignalSpec): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    transparent: spec.transparent ?? false,
    opacity: spec.opacity ?? 1,
  })
  themed((md, p, air) => {
    const hex = p[spec.color]
    if (md === 'night') {
      m.color.setHex(hex).multiplyScalar(spec.nightBase ?? 0.22)
      m.emissive.setHex(hex)
      m.emissiveIntensity = air.glow * (spec.glow ?? 1)
      m.roughness = spec.roughness ?? 0.55
      m.metalness = spec.metalness ?? 0.05
    } else {
      m.color.setHex(hex)
      m.emissive.setHex(0x000000)
      m.emissiveIntensity = 0
      m.roughness = spec.roughness ?? 0.5
      m.metalness = spec.metalness ?? 0.05
    }
  })
  return m
}

/** Line material whose colour follows the palette. */
export function lineMat(color: PaletteKey, opacity = 1, nightBoost = 1): THREE.LineBasicMaterial {
  const m = new THREE.LineBasicMaterial({ transparent: opacity < 1, opacity, depthWrite: opacity >= 1 })
  themed((md, p) => {
    m.color.setHex(p[color])
    if (md === 'night' && nightBoost !== 1) m.color.multiplyScalar(nightBoost)
  })
  return m
}

export function cssHex(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`
}

/**
 * Mirror the live palette into CSS custom properties (--c-<role>), so DOM
 * swatches such as label and inspector dots follow the theme with no repaint.
 */
if (typeof document !== 'undefined') {
  themed((_m, p) => {
    const st = document.documentElement.style
    for (const k of Object.keys(p) as PaletteKey[]) st.setProperty(`--c-${k}`, cssHex(p[k]))
  })
}
