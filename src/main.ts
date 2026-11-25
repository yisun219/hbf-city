import * as THREE from 'three'
import './styles/app.css'

import { createBus } from './core/bus'
import { HBF } from './core/hbf-spec'
import { Registry } from './core/registry'
import { onThemeMode, setThemeMode, themeMode, toggleThemeMode } from './core/theme'
import type { ComponentDef, FocusSpec, SceneState, WorldContext, WorldModule } from './core/types'
import { clamp, damp } from './core/util'
import { createCameraRig } from './engine/camera'
import { createLabels } from './engine/labels'
import { createPicker } from './engine/picker'
import { createRenderer } from './engine/renderer'
import { el } from './ui/dom'
import { createHud } from './ui/hud'
import { createInspector } from './ui/panel'
import { createGpu } from './world/gpu'
import { createStacks } from './world/hbf-stack'
import { DEFAULT_VERTICAL_SCALE, FEATURED_STACK, LIFT_BASE, STACK_SITES, VIEW } from './world/layout'
import { BlockState, createOccupancyAtlas } from './world/occupancy'
import { createPackage } from './world/package'
import { createSky } from './world/sky'
import { P, themed } from './core/theme'

/* ============================================================================
 * HBFCity — boot.
 *
 * Order: renderer -> camera -> world -> labels and picking -> UI -> loop.
 * The world reads SceneState; the UI edits it and talks over the bus.
 *
 * URL parameters (for review and screenshots):
 *   theme=day|night   view=home|overview|stack   stack=0..5   open=0..1
 *   die=0..15         scale=1..12               labels=0|1  select=<id>
 * ==========================================================================*/

const params = new URLSearchParams(location.search)
/** Screenshot mode: animations jump to their targets. */
const settleMode = params.get('settle') === '1'
const bootFill = document.getElementById('boot-fill')
const bootStatus = document.getElementById('boot-status')

function progress(pct: number, label: string): Promise<void> {
  if (bootFill) bootFill.style.width = `${pct}%`
  if (bootStatus) bootStatus.textContent = label
  // Yield so the bar paints; a background tab never fires rAF, so race a timer.
  return new Promise((r) => {
    let done = false
    const go = () => {
      if (!done) {
        done = true
        r()
      }
    }
    requestAnimationFrame(go)
    setTimeout(go, 30)
  })
}

async function boot(): Promise<void> {
  const canvasRoot = document.getElementById('canvas-root')!
  const labelsRoot = document.getElementById('labels-root')!
  const hudRoot = document.getElementById('hud')!

  const probe = document.createElement('canvas').getContext('webgl2')
  if (!probe) {
    if (bootStatus) bootStatus.textContent = 'This browser has no WebGL2. Try a recent Chrome, Edge, Firefox or Safari.'
    return
  }
  probe.getExtension('WEBGL_lose_context')?.loseContext()

  const themeParam = params.get('theme')
  if (themeParam === 'day' || themeParam === 'night') setThemeMode(themeParam)
  document.documentElement.dataset.theme = themeMode()

  const N = HBF.stacksPerGpu
  const state: SceneState = {
    explodeTarget: new Array(N).fill(0),
    explode: new Array(N).fill(0),
    liftedDieTarget: new Array(N).fill(-1),
    liftedDie: new Array(N).fill(-1),
    lift: new Array(N).fill(0),
    verticalScaleTarget: DEFAULT_VERTICAL_SCALE,
    verticalScale: DEFAULT_VERTICAL_SCALE,
    showBulkSilicon: true,
    labels: params.get('labels') !== '0',
    focusStack: FEATURED_STACK,
  }
  const pStack = params.has('stack') ? Number(params.get('stack')) : NaN
  if (Number.isInteger(pStack) && pStack >= 0 && pStack < N) state.focusStack = pStack
  const pOpen = params.has('open') ? clamp(Number(params.get('open')), 0, 1) : 0.62
  state.explodeTarget[state.focusStack] = pOpen
  const pScale = params.has('scale') ? Number(params.get('scale')) : NaN
  if (pScale >= 1 && pScale <= 24) {
    state.verticalScale = pScale
    state.verticalScaleTarget = pScale
  }

  const bus = createBus()
  const registry = new Registry()

  await progress(10, 'Renderer')
  const gfx = createRenderer(canvasRoot)
  const { scene, camera } = gfx

  await progress(20, 'Camera')
  const rig = createCameraRig(camera, gfx.dom)
  camera.position.set(...VIEW.home.pos)
  rig.controls.target.set(...VIEW.home.target)
  rig.controls.update()

  const ctx: WorldContext = {
    scene,
    bus,
    state,
    quality: gfx.quality,
    register: (def: ComponentDef) => registry.register(def),
  }

  await progress(30, 'Sky')
  scene.add(createSky())

  const modules: WorldModule[] = []
  const add = <T extends WorldModule>(m: T): T => {
    modules.push(m)
    scene.add(m.group)
    return m
  }

  await progress(45, 'Package and interposer')
  add(createPackage(ctx))

  await progress(60, 'GPU die')
  add(createGpu(ctx))

  await progress(72, 'NAND block atlas (1.57 M blocks)')
  const occupancy = createOccupancyAtlas()
  themed((mode, palette) => occupancy.repaint(mode, palette))

  await progress(84, 'HBF stacks')
  const stacks = add(createStacks(ctx, occupancy))

  await progress(92, 'Labels')
  const labels = createLabels(labelsRoot, registry, bus)
  const picker = createPicker({ dom: gfx.dom, camera, registry, bus })
  scene.add(picker.group)
  gfx.refreshEnvironment()

  /* ---- interaction --------------------------------------------------------- */
  const inspector = createInspector(hudRoot, registry, bus)
  let selected: string | null = null
  const box = new THREE.Box3()
  const center = new THREE.Vector3()
  const size = new THREE.Vector3()

  function focusFor(def: ComponentDef): FocusSpec {
    def.bounds(box)
    box.getCenter(center)
    box.getSize(size)
    const r = Math.max(size.x, size.z, size.y * 0.6)
    const site = def.stack !== undefined ? STACK_SITES[def.stack] : null
    let dir: [number, number, number] = [0.42, 0.78, 0.62]
    let distance = clamp(r * 2.1 + 40, 50, 2400)
    if (site && def.die !== undefined) {
      center.y = box.max.y
      // from above and beyond the drawer, so the stack stays at the edge of frame
      dir = [-site.inward * 0.55, 1.1, 0.62]
      distance = clamp(r * 1.15 + 20, 60, 600)
    } else if (site && def.district === 'stack' && def.id !== `stack.${def.stack}`) {
      // base-die parts: look down into the opened gap from outside the stack
      center.y = box.max.y
      dir = [-site.inward * 0.7, 1.2, 0.6]
      distance = clamp(Math.max(size.x, size.z) * 2.1 + 60, 80, 620)
    } else if (site) {
      dir = [-site.inward * 0.7, 0.62, 0.62]
    } else if (def.district === 'gpu') {
      dir = [0.3, 1, 0.55]
    }
    return { target: [center.x, center.y, center.z], distance, dir }
  }

  function select(id: string | null): void {
    selected = id
    picker.setSelected(id)
    labels.setHighlight(id)
    inspector.show(id)
    // keep the subject clear of the inspector on wide screens
    rig.setRightInset(id && window.innerWidth > 900 ? Math.min(400, window.innerWidth * 0.3) : 0, settleMode)
    const def = id ? registry.get(id) : undefined
    stacks.setSelectedDie(def?.stack ?? -1, def?.die ?? -1)
    if (def?.stack !== undefined) state.focusStack = def.stack
    const baseParts = new Set(['base', 'phy', 'ctrl', 'sram', 'landing', 'debug'])
    if (def?.die !== undefined && def.stack !== undefined) {
      const s = def.stack
      if (state.explodeTarget[s] < 0.3) state.explodeTarget[s] = 0.45
      for (let k = 0; k < N; k++) if (k !== s) state.liftedDieTarget[k] = -1
      state.liftedDieTarget[s] = def.die
    } else if (def?.stack !== undefined && baseParts.has(def.doc)) {
      // uncover the base die: lift the whole core-die stack off it
      const s = def.stack
      for (let k = 0; k < N; k++) state.liftedDieTarget[k] = k === s ? LIFT_BASE : -1
    } else {
      for (let k = 0; k < N; k++) state.liftedDieTarget[k] = -1
    }
    hud.sync()
  }

  bus.on('select', ({ id }) => select(id))
  bus.on('hover', ({ id }) => picker.setHovered(id))
  bus.on('focus', ({ id }) => {
    const def = id ? registry.get(id) : undefined
    if (!def) return
    if (selected !== id) select(id)
    // let a lifted die finish rising before framing it
    window.setTimeout(() => rig.flyTo(focusFor(def)), def.die !== undefined ? 650 : 0)
  })
  bus.on('scene:changed', () => hud.sync())

  inspector.setExtra((def) => {
    if (def.stack === undefined || (def.doc !== 'coreDie' && def.doc !== 'stack')) return null
    const c = occupancy.counts(def.stack, def.die)
    const total = c[BlockState.Free] + c[BlockState.Weights] + c[BlockState.Kv] + c[BlockState.KvOpen] + c[BlockState.Invalid]
    const rows: [string, number, keyof typeof P][] = [
      ['Weights', c[BlockState.Weights], 'weights'],
      ['KV cache', c[BlockState.Kv], 'kv'],
      ['Open KV blocks', c[BlockState.KvOpen], 'kvTail'],
      ['Invalid', c[BlockState.Invalid], 'invalid'],
      ['Free', c[BlockState.Free], 'free'],
    ]
    const bar = el('div', { class: 'occ__bar' })
    const list = el('div', { class: 'occ__list' })
    for (const [label, count, key] of rows) {
      const seg = el('i', {})
      seg.style.flexGrow = String(count)
      seg.style.background = `#${P[key].toString(16).padStart(6, '0')}`
      bar.append(seg)
      list.append(el('span', {}, `${label} ${((100 * count) / total).toFixed(1)}%`))
    }
    return el('section', { class: 'occ' },
      el('h3', {}, `${total.toLocaleString('en-US')} blocks`),
      bar,
      list,
      el('p', { class: 'occ__note' }, 'Illustrative state — no simulator is connected yet.'),
    )
  })

  function focusStack(s: number): void {
    state.focusStack = s
    bus.emit('focus', { id: `stack.${s}` })
    hud.sync()
  }

  const hud = createHud(hudRoot, state, bus, {
    home: () => rig.setView(VIEW.home.target, VIEW.home.pos),
    overview: () => rig.setView(VIEW.overview.target, VIEW.overview.pos),
    toggleTheme: () => {
      toggleThemeMode()
    },
    toggleLabels: () => {
      state.labels = !state.labels
      hud.sync()
    },
    toggleBulk: () => {
      state.showBulkSilicon = !state.showBulkSilicon
      hud.sync()
    },
    toggleScale: () => {
      state.verticalScaleTarget = state.verticalScaleTarget > 1.01 ? 1 : DEFAULT_VERTICAL_SCALE
      hud.sync()
    },
    focusStack,
  })

  onThemeMode(() => {
    gfx.refreshEnvironment()
    document.documentElement.dataset.theme = themeMode()
    hud.sync()
    inspector.show(selected)
  })

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return
    const k = e.key.toLowerCase()
    if (k === 'x') {
      const s = state.focusStack
      state.explodeTarget[s] = state.explodeTarget[s] > 0.05 ? 0 : 0.65
      if (state.explodeTarget[s] === 0) state.liftedDieTarget[s] = -1
      hud.sync()
    } else if (k === 'a') {
      const anyClosed = state.explodeTarget.some((v) => v < 0.3)
      for (let s = 0; s < N; s++) state.explodeTarget[s] = anyClosed ? 0.65 : 0
      hud.sync()
    } else if (k === 'h') rig.setView(VIEW.home.target, VIEW.home.pos)
    else if (k === 'o') rig.setView(VIEW.overview.target, VIEW.overview.pos)
    else if (k === 'n') toggleThemeMode()
    else if (k === 'l') {
      state.labels = !state.labels
      hud.sync()
    } else if (k === 'b') {
      state.showBulkSilicon = !state.showBulkSilicon
      hud.sync()
    } else if (k === 't') {
      state.verticalScaleTarget = state.verticalScaleTarget > 1.01 ? 1 : DEFAULT_VERTICAL_SCALE
      hud.sync()
    } else if (k === 'escape') select(null)
    else if (k >= '1' && k <= '6') focusStack(Number(k) - 1)
  })

  /* ---- start-up view from the URL ---------------------------------------------- */
  const view = params.get('view')
  if (view === 'overview') {
    camera.position.set(...VIEW.overview.pos)
    rig.controls.target.set(...VIEW.overview.target)
    rig.controls.update()
  }
  const pDie = Number(params.get('die'))
  if (params.has('die') && Number.isInteger(pDie) && pDie >= 0 && pDie < HBF.diesPerStack) {
    select(`stack.${state.focusStack}.die.${pDie}`)
  }
  const pSelect = params.get('select')
  if (pSelect && registry.get(pSelect)) select(pSelect)
  if (view === 'stack') {
    const def = registry.get(`stack.${state.focusStack}`)
    if (def) {
      state.explode[state.focusStack] = state.explodeTarget[state.focusStack]
      stacks.update(0, state)
      const f = focusFor(def)
      rig.flyTo(f, 0.001)
    }
  }
  const pFocus = params.get('focus')
  if (settleMode) {
    // screenshot mode: jump animations to their targets
    for (let s = 0; s < N; s++) {
      state.explode[s] = state.explodeTarget[s]
      state.liftedDie[s] = state.liftedDieTarget[s]
      state.lift[s] = state.liftedDie[s] !== -1 ? 1 : 0
    }
    stacks.update(0, state)
  }
  if (pFocus && registry.get(pFocus)) {
    const f = focusFor(registry.get(pFocus)!)
    rig.flyTo(f, 0.001)
  }

  ;(window as unknown as { HBFCITY: unknown }).HBFCITY = { state, registry, bus, rig, gfx, select, P }

  await progress(100, 'Ready')
  if (settleMode) document.getElementById('boot')?.remove()
  else {
    document.getElementById('boot')?.classList.add('boot--done')
    window.setTimeout(() => document.getElementById('boot')?.remove(), 900)
  }

  /* ---- loop ------------------------------------------------------------------ */
  let last = performance.now()
  function frame(now: number): void {
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000))
    last = now
    if (Math.abs(state.verticalScale - state.verticalScaleTarget) > 1e-3) {
      state.verticalScale = damp(state.verticalScale, state.verticalScaleTarget, 4, dt)
    } else state.verticalScale = state.verticalScaleTarget
    for (const m of modules) m.update(dt, state)
    rig.update(dt)
    picker.update()
    labels.update(camera, state.labels)
    gfx.render(dt)
    labels.render(scene, camera)
    requestAnimationFrame(frame)
  }
  labels.resize(window.innerWidth, window.innerHeight)
  window.addEventListener('resize', () => labels.resize(window.innerWidth, window.innerHeight))
  requestAnimationFrame(frame)
}

boot().catch((err) => {
  console.error('[HBFCity]', err)
  if (bootStatus) bootStatus.textContent = `Failed to start: ${err instanceof Error ? err.message : String(err)}`
})
