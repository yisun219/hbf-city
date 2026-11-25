import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js'
import { Pass } from 'three/examples/jsm/postprocessing/Pass.js'
import { P, atmosphere, onThemeMode } from '../core/theme'
import type { Atmosphere } from '../core/theme'
import type { QualityLevel, QualitySettings } from '../core/types'
import { GoldenHourOutputPass } from './color-grade'

/* ============================================================================
 * RENDERER — PGSimCity's colour pipeline, trimmed to what a package needs.
 *
 * Composer path: RenderPass into a HalfFloat target (linear HDR, no tone
 * mapping, because three only tone-maps the default framebuffer), optional
 * GTAO, UnrealBloom thresholding that linear buffer, SMAA, and one output
 * pass that applies the daylight grade, aerial haze, tone mapping and sRGB
 * encode exactly once. The renderer's tone-mapping settings are therefore
 * valid on both the composer path and the direct 'low' path.
 * ==========================================================================*/

export interface RendererApi {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  quality: QualitySettings
  dom: HTMLCanvasElement
  readonly fps: number
  render(rawDt: number): void
  resize(): void
  setQuality(level: QualityLevel): void
  /** Re-capture the sky for image-based lighting (after a theme change). */
  refreshEnvironment(): void
}

const DPR_CAP: Record<QualityLevel, number> = { low: 1, medium: 1.5, high: 2 }

export const QUALITY_PRESETS: Record<QualityLevel, QualitySettings> = {
  low: { level: 'low', pixelRatio: 1, bloom: false, shadows: false, ambientOcclusion: false, antialias: false },
  medium: { level: 'medium', pixelRatio: 1.5, bloom: true, shadows: true, ambientOcclusion: false, antialias: false },
  high: { level: 'high', pixelRatio: 2, bloom: true, shadows: true, ambientOcclusion: true, antialias: true },
}

/** Exposes the depth the beauty pass wrote, for the aerial-perspective haze. */
class DepthTap extends Pass {
  sceneDepthTexture: THREE.DepthTexture | null = null
  constructor() {
    super()
    this.needsSwap = false
  }
  override render(
    _renderer: THREE.WebGLRenderer,
    _writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    this.sceneDepthTexture = (readBuffer.depthTexture as THREE.DepthTexture | null) ?? null
  }
}

const toneMappingFor = (a: Atmosphere): THREE.ToneMapping =>
  a.toneMapping === 'neutral' ? THREE.NeutralToneMapping : THREE.ACESFilmicToneMapping

export function createRenderer(container: HTMLElement, initial: QualityLevel = 'high'): RendererApi {
  const quality: QualitySettings = { ...QUALITY_PRESETS[initial] }
  let air = atmosphere()

  const renderer = new THREE.WebGLRenderer({
    antialias: false,
    powerPreference: 'high-performance',
    stencil: false,
    alpha: false,
    preserveDrawingBuffer: false,
  })
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = toneMappingFor(air)
  renderer.toneMappingExposure = air.exposure
  renderer.shadowMap.type = THREE.PCFShadowMap
  renderer.shadowMap.enabled = quality.shadows && air.shadows
  const dom = renderer.domElement
  dom.style.display = 'block'
  dom.style.touchAction = 'none'
  dom.style.outline = 'none'
  dom.tabIndex = 0
  container.appendChild(dom)

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(P.bg)
  const fog = new THREE.Fog(P.fog, air.fogNear, air.fogFar)
  scene.fog = fog

  const camera = new THREE.PerspectiveCamera(42, 1, 1.5, 24000)

  /* ---- lights ------------------------------------------------------------- */
  const hemi = new THREE.HemisphereLight(air.hemiSky, air.hemiGround, air.hemiIntensity)
  scene.add(hemi)
  const key = new THREE.DirectionalLight(air.keyColor, air.keyIntensity)
  key.position.set(...air.keyPos)
  key.target.position.set(0, 0, 0)
  scene.add(key, key.target)
  key.castShadow = quality.shadows && air.shadows
  key.shadow.mapSize.set(2048, 2048)
  key.shadow.bias = -0.0004
  key.shadow.normalBias = 0.35
  key.shadow.radius = 2
  const sc = key.shadow.camera
  sc.left = -560
  sc.right = 560
  sc.top = 560
  sc.bottom = -560
  sc.near = 100
  sc.far = 3400
  sc.updateProjectionMatrix()
  const fill = new THREE.DirectionalLight(air.fillColor, air.fillIntensity)
  fill.position.set(...air.fillPos)
  scene.add(fill)

  /* ---- environment (image-based light from the sky) ------------------------- */
  let pmrem: THREE.PMREMGenerator | null = null
  let envTarget: THREE.WebGLRenderTarget | null = null
  const envScene = new THREE.Scene()
  function refreshEnvironment(): void {
    const sky = scene.getObjectByName('sky')
    if (!sky?.parent) return
    if (!pmrem) pmrem = new THREE.PMREMGenerator(renderer)
    const parent = sky.parent
    envScene.add(sky)
    let next: THREE.WebGLRenderTarget
    try {
      next = pmrem.fromScene(envScene, 0, 1, 20000)
    } finally {
      parent.add(sky)
    }
    envTarget?.dispose()
    envTarget = next
    scene.environment = next.texture
    scene.environmentIntensity = air.daylight ? 0.42 : 0.5
  }

  /* ---- composer ------------------------------------------------------------- */
  let viewW = 1
  let viewH = 1
  let composer: EffectComposer | null = null
  let gtao: GTAOPass | null = null
  let bloom: UnrealBloomPass | null = null
  let smaa: SMAAPass | null = null
  let output: GoldenHourOutputPass | null = null
  const depthTap = new DepthTap()

  function buildComposer(): void {
    if (composer) return
    const target = new THREE.WebGLRenderTarget(viewW, viewH, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
      depthTexture: new THREE.DepthTexture(viewW, viewH, THREE.UnsignedIntType),
    })
    composer = new EffectComposer(renderer, target)
    // The second ping-pong target needs its own depth texture for the haze.
    composer.renderTarget2.depthTexture = new THREE.DepthTexture(viewW, viewH, THREE.UnsignedIntType)
    composer.addPass(new RenderPass(scene, camera))
    composer.addPass(depthTap)
    gtao = new GTAOPass(scene, camera, viewW, viewH)
    gtao.updateGtaoMaterial({ radius: 6, distanceExponent: 1.4, thickness: 3, scale: 1.1 })
    gtao.blendIntensity = 0.6
    composer.addPass(gtao)
    bloom = new UnrealBloomPass(new THREE.Vector2(viewW, viewH), air.bloomStrength, air.bloomRadius, air.bloomThreshold)
    composer.addPass(bloom)
    smaa = new SMAAPass()
    composer.addPass(smaa)
    output = new GoldenHourOutputPass(camera, depthTap)
    composer.addPass(output)
    applyPassToggles()
    sizeComposer()
  }

  function applyPassToggles(): void {
    if (gtao) {
      gtao.enabled = quality.ambientOcclusion
      gtao.blendIntensity = air.daylight ? 0.8 : 0.45
    }
    if (bloom) {
      bloom.enabled = quality.bloom && air.bloom
      bloom.strength = air.bloomStrength
      bloom.radius = air.bloomRadius
      bloom.threshold = air.bloomThreshold
    }
    if (smaa) smaa.enabled = quality.antialias
    if (output) {
      output.setDaylight(air.daylight)
      output.setAerialPerspective(P.fog, air.daylight ? 0.00022 : 0.00028, air.daylight ? 0.012 : 0.02, 1)
    }
  }

  function sizeComposer(): void {
    if (!composer) return
    composer.setPixelRatio(quality.pixelRatio)
    composer.setSize(viewW, viewH)
    if (bloom) {
      const w = Math.max(1, Math.round((viewW * quality.pixelRatio) / 2))
      const h = Math.max(1, Math.round((viewH * quality.pixelRatio) / 2))
      bloom.setSize(w, h)
    }
    if (gtao) {
      gtao.setSize(Math.max(1, Math.round(viewW * quality.pixelRatio * 0.5)), Math.max(1, Math.round(viewH * quality.pixelRatio * 0.5)))
    }
  }

  function useComposer(): boolean {
    return quality.level !== 'low' || air.daylight
  }

  /* ---- theme ------------------------------------------------------------------- */
  onThemeMode(() => {
    air = atmosphere()
    renderer.toneMapping = toneMappingFor(air)
    renderer.toneMappingExposure = air.exposure
    ;(scene.background as THREE.Color).setHex(P.bg)
    fog.color.setHex(P.fog)
    fog.near = air.fogNear
    fog.far = air.fogFar
    hemi.color.setHex(air.hemiSky)
    hemi.groundColor.setHex(air.hemiGround)
    hemi.intensity = air.hemiIntensity
    key.color.setHex(air.keyColor)
    key.intensity = air.keyIntensity
    key.position.set(...air.keyPos)
    fill.color.setHex(air.fillColor)
    fill.intensity = air.fillIntensity
    fill.position.set(...air.fillPos)
    applyShadows()
    applyPassToggles()
    refreshEnvironment()
  })

  function applyShadows(): void {
    const on = quality.shadows && air.shadows
    if (renderer.shadowMap.enabled !== on) {
      renderer.shadowMap.enabled = on
      // shadow defines are compiled into every program
      scene.traverse((o) => {
        const m = (o as THREE.Mesh).material
        if (!m) return
        for (const mm of Array.isArray(m) ? m : [m]) mm.needsUpdate = true
      })
    }
    key.castShadow = on
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      const flags = mesh.userData as { noShadow?: boolean }
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      const opaque = mats.every((m) => !m.transparent)
      const ok = on && opaque && !flags.noShadow && !mesh.name.startsWith('sky')
      mesh.castShadow = ok
      mesh.receiveShadow = ok
    })
  }

  /* ---- sizing ------------------------------------------------------------------ */
  function resize(): void {
    const w = Math.max(1, Math.floor(container.clientWidth || window.innerWidth || 1))
    const h = Math.max(1, Math.floor(container.clientHeight || window.innerHeight || 1))
    quality.pixelRatio = Math.min(DPR_CAP[quality.level], window.devicePixelRatio || 1)
    viewW = w
    viewH = h
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    renderer.setPixelRatio(quality.pixelRatio)
    renderer.setSize(w, h, false)
    dom.style.width = `${w}px`
    dom.style.height = `${h}px`
    sizeComposer()
  }

  function setQuality(level: QualityLevel): void {
    Object.assign(quality, QUALITY_PRESETS[level])
    resize()
    applyShadows()
    applyPassToggles()
  }

  /* ---- frame ---------------------------------------------------------------------- */
  let fps = 60
  let slowFor = 0
  let warm = 0
  function render(rawDt: number): void {
    if (rawDt > 0) fps = fps * 0.94 + (1 / Math.max(rawDt, 1e-3)) * 0.06
    warm += rawDt
    // Adaptive quality: step down once if the frame rate stays low.
    if (warm > 4 && quality.level !== 'low') {
      slowFor = fps < 34 ? slowFor + rawDt : 0
      if (slowFor > 4) {
        setQuality(quality.level === 'high' ? 'medium' : 'low')
        slowFor = 0
        warm = 0
      }
    }
    if (useComposer()) {
      if (!composer) buildComposer()
      composer!.render(rawDt)
    } else {
      renderer.render(scene, camera)
    }
  }

  window.addEventListener('resize', resize)
  resize()
  applyShadows()

  return {
    renderer,
    scene,
    camera,
    quality,
    dom,
    get fps() {
      return fps
    },
    render,
    resize,
    setQuality,
    refreshEnvironment() {
      refreshEnvironment()
      applyShadows()
    },
  }
}
