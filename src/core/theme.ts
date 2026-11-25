import * as THREE from 'three'
import type { ThemeMode } from './types'

/* ============================================================================
 * THEME — two rendering models over one scene.
 *
 * NIGHT: structure is matte and dark; meaning is emissive. Only semantic
 * surfaces (data in blocks, SRAM, links, compute) are allowed past the bloom
 * threshold, so a glow always says something.
 *
 * DAY: a clean bench-light render. Bloom is off; hue and value carry meaning
 * and the package reads as physical material: dark substrate, grey silicon,
 * copper vias.
 *
 * Colour is semantic everywhere and is never reused for decoration:
 *   weights amber · KV cache cyan · open KV block green · invalid pink ·
 *   free grey · SRAM teal · compute periwinkle · UCIe link blue ·
 *   TSV ice-blue · controllers violet-grey
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
    bg: 0x050913,
    fog: 0x0a1222,
    skyZenith: 0x03060f,
    skyHorizon: 0x1a2a46,
    skyGlow: 0x2e2445,
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
    weights: 0xffb03a,
    kv: 0x3fc8ff,
    kvTail: 0x7dffb2,
    invalid: 0xff4d8d,
    free: 0x1c2638,
    sram: 0x4fe3c1,
    compute: 0x6f7dff,
    computeDim: 0x1c2140,
    tensor: 0xb39cff,
    link: 0x6e8dff,
    tsv: 0xa9dcff,
    controller: 0x8c7ccf,
    debug: 0x5f6b80,
    ink: 0xe8f1ff,
    inkDim: 0x8fa5c4,
  },
  day: {
    bg: 0xc9d3de,
    fog: 0xc3ccd6,
    skyZenith: 0x6f93bb,
    skyHorizon: 0xd9e2ea,
    skyGlow: 0xffe1b8,
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
    weights: 0xd18a04,
    kv: 0x0b7fd1,
    kvTail: 0x1f9e5a,
    invalid: 0xd0306a,
    free: 0xb7bcc4,
    sram: 0x0e8f8c,
    compute: 0x4f5fd6,
    computeDim: 0x6d7392,
    tensor: 0x7a54d6,
    link: 0x3550c8,
    tsv: 0x3f6f9a,
    controller: 0x6a5aa8,
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
    bloomStrength: 0.7,
    bloomRadius: 0.5,
    bloomThreshold: 0.82,
    glow: 1.55,
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

function readStoredMode(): ThemeMode {
  try {
    const v = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY)
    return v === 'day' ? 'day' : 'night'
  } catch {
    return 'night'
  }
}

let mode: ThemeMode = readStoredMode()

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

export function setThemeMode(next: ThemeMode): void {
  if (next === mode) return
  mode = next
  Object.assign(P, PALETTES[next])
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    /* private mode: the choice simply does not persist */
  }
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = next
  const air = ATMOSPHERE[next]
  for (const p of painters) p(next, P, air)
  for (const l of listeners) l(next)
}

export function toggleThemeMode(): ThemeMode {
  setThemeMode(mode === 'night' ? 'day' : 'night')
  return mode
}

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

export function mixHex(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255
  const ag = (a >> 8) & 255
  const ab = a & 255
  const br = (b >> 16) & 255
  const bg = (b >> 8) & 255
  const bb = b & 255
  const r = Math.round(ar + (br - ar) * t)
  const g = Math.round(ag + (bg - ag) * t)
  const bl = Math.round(ab + (bb - ab) * t)
  return (r << 16) | (g << 8) | bl
}
