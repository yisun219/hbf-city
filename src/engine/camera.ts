import * as THREE from 'three'
import { MapControls } from 'three/examples/jsm/controls/MapControls.js'
import type { FocusSpec } from '../core/types'
import { clamp, easeInOutCubic, reduceMotion } from '../core/util'

/* ============================================================================
 * CAMERA — map-style navigation over the package.
 *
 * Drag pans the ground, Shift/Ctrl-drag or right-drag orbits, the wheel zooms
 * toward the cursor. `flyTo` animates target and position together so a
 * focus never swings the camera through the scene.
 * ==========================================================================*/

export interface CameraRig {
  controls: MapControls
  update(dt: number): void
  flyTo(spec: FocusSpec, seconds?: number): void
  setView(target: readonly number[], position: readonly number[], seconds?: number): void
  /** true while a scripted flight owns the camera */
  readonly flying: boolean
  /**
   * Pixels of the right edge covered by a panel. The frame centre shifts left
   * by half of it, so whatever the camera targets stays in the visible part.
   */
  setRightInset(px: number, immediate?: boolean): void
}

const _dir = new THREE.Vector3()

export function createCameraRig(camera: THREE.PerspectiveCamera, dom: HTMLElement): CameraRig {
  const controls = new MapControls(camera, dom)
  controls.enableDamping = true
  controls.dampingFactor = 0.085
  controls.zoomToCursor = true
  controls.screenSpacePanning = false
  controls.minDistance = 6
  controls.maxDistance = 3200
  controls.maxPolarAngle = Math.PI * 0.485
  controls.rotateSpeed = 0.6
  controls.panSpeed = 1.0
  controls.zoomSpeed = 1.1
  controls.keyPanSpeed = 28
  controls.listenToKeyEvents(window)

  const fromPos = new THREE.Vector3()
  const fromTarget = new THREE.Vector3()
  const toPos = new THREE.Vector3()
  const toTarget = new THREE.Vector3()
  let t = 1
  let duration = 1

  function begin(target: THREE.Vector3, position: THREE.Vector3, seconds: number): void {
    fromPos.copy(camera.position)
    fromTarget.copy(controls.target)
    toTarget.copy(target)
    toPos.copy(position)
    duration = reduceMotion() ? 0.001 : Math.max(0.001, seconds)
    t = 0
  }

  function flyTo(spec: FocusSpec, seconds = 1.1): void {
    const target = new THREE.Vector3(...spec.target)
    if (spec.dir) _dir.set(...spec.dir).normalize()
    else _dir.copy(camera.position).sub(controls.target).normalize()
    // keep a sane elevation so the camera never ends below the interposer
    if (_dir.y < 0.18) {
      _dir.y = 0.18
      _dir.normalize()
    }
    const position = target.clone().addScaledVector(_dir, clamp(spec.distance, controls.minDistance, controls.maxDistance))
    begin(target, position, seconds)
  }

  function setView(target: readonly number[], position: readonly number[], seconds = 1.3): void {
    begin(new THREE.Vector3(target[0], target[1], target[2]), new THREE.Vector3(position[0], position[1], position[2]), seconds)
  }

  // A user gesture cancels a flight instead of fighting it.
  controls.addEventListener('start', () => {
    t = 1
  })

  let insetTarget = 0
  let inset = 0
  function applyInset(dt: number): void {
    if (Math.abs(inset - insetTarget) < 0.5) inset = insetTarget
    else inset += (insetTarget - inset) * (1 - Math.exp(-8 * dt))
    const w = dom.clientWidth || window.innerWidth
    const h = dom.clientHeight || window.innerHeight
    if (inset === 0) {
      if (camera.view && camera.view.enabled) camera.clearViewOffset()
      return
    }
    camera.setViewOffset(w, h, inset / 2, 0, w, h)
  }

  function update(dt: number): void {
    applyInset(dt)
    if (t < 1) {
      t = Math.min(1, t + dt / duration)
      const k = easeInOutCubic(t)
      controls.target.lerpVectors(fromTarget, toTarget, k)
      camera.position.lerpVectors(fromPos, toPos, k)
      camera.lookAt(controls.target)
      if (t >= 1) controls.update()
      return
    }
    controls.update(dt)
  }

  return {
    controls,
    update,
    flyTo,
    setView,
    get flying() {
      return t < 1
    },
    setRightInset(px: number, immediate = false) {
      insetTarget = Math.max(0, px)
      if (immediate || reduceMotion()) inset = insetTarget
    },
  }
}
