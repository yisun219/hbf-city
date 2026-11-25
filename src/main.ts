import * as THREE from 'three'
import './styles/app.css'

import { createBus } from './core/bus'
import { HBF } from './core/hbf-spec'
import { lang, onLang, setLang, t } from './core/i18n'
import { Registry } from './core/registry'
import { P, onThemeMode, setThemeMode, themeMode, themed, toggleThemeMode } from './core/theme'
import type { ComponentDef, FocusSpec, SceneState, WorldContext, WorldModule } from './core/types'
import { clamp, damp } from './core/util'
import { createCameraRig } from './engine/camera'
import { createLabels } from './engine/labels'
import { createPicker } from './engine/picker'
import { createBlockTip } from './ui/block-tip'
import { createRenderer } from './engine/renderer'
import { MODELS } from './sim/models'
import type { ModelId } from './sim/models'
import { createSim, suggestedLoad } from './sim/sim'
import type { Sim } from './sim/sim'
import { BLOCKS, POLICIES, SbState, WIDTHS } from './sim/store'
import type { InterleaveWidth, PolicyId } from './sim/store'
import { TRACES } from './sim/workload'
import type { WorkloadId } from './sim/workload'
import { el } from './ui/dom'
import { createHud } from './ui/hud'
import type { Hud } from './ui/hud'
import { createInspector } from './ui/panel'
import type { Inspector } from './ui/panel'
import { SPEEDS, createSimPanel } from './ui/sim-panel'
import type { Scenario, SimPanel } from './ui/sim-panel'
import { createTour } from './ui/tour'
import type { Tour } from './ui/tour'
import { createActivity } from './world/activity'
import { createGpu } from './world/gpu'
import { createStacks } from './world/hbf-stack'
import { DEFAULT_VERTICAL_SCALE, FEATURED_STACK, LIFT_BASE, STACK, STACK_SITES, VIEW } from './world/layout'
import { createOccupancyAtlas } from './world/occupancy'
import { createPackage } from './world/package'
import { createSimView } from './world/sim-view'
import type { BlockView } from './world/sim-view'
import { createSky } from './world/sky'

/* ============================================================================
 * HBFCity — boot.
 *
 * Order: renderer -> camera -> world -> simulator -> labels and picking ->
 * UI -> loop. The world reads SceneState and the simulator; the UI edits
 * SceneState and the scenario and talks over the bus. The UI is rebuilt from
 * that state whenever the language changes.
 *
 * URL parameters (for review and screenshots):
 *   lang=en|zh   theme=day|night   view=home|overview|stack   stack=0..5
 *   open=0..1    die=0..15   scale=1..12   labels=0|1   select=<id>  focus=<id>
 *   model=deepseek-v3|qwen3-235b|hunyuan3   workload=toC|toB|coding|thinking
 *   policy=hbflex|arrival   width=1|4|16   load=<x suggested>   speed=<sim s per s>
 *   play=0|1   skip=<hours simulated before the first frame>   blocks=state|wear
 *   tour=<stop 1..8>   settle=1 jumps animations to their targets
 * ==========================================================================*/

/**
 * A named view, pulled back on narrow or portrait screens so the package still
 * fits: the views are framed for a 16:10 window, and a narrower window sees
 * less horizontally at the same distance.
 */
function fitted(view: { target: readonly number[]; pos: readonly number[] }): { target: [number, number, number]; pos: [number, number, number] } {
  const aspect = window.innerWidth / Math.max(1, window.innerHeight)
  const k = Math.min(2.3, Math.max(1, Math.sqrt(1.6 / aspect)))
  const [tx, ty, tz] = view.target
  const [px, py, pz] = view.pos
  return { target: [tx, ty, tz], pos: [tx + (px - tx) * k, ty + (py - ty) * k, tz + (pz - tz) * k] }
}
const goHome = (rig: { setView(t: readonly number[], p: readonly number[]): void }) => {
  const v = fitted(VIEW.home)
  rig.setView(v.target, v.pos)
}
const goOverview = (rig: { setView(t: readonly number[], p: readonly number[]): void }) => {
  const v = fitted(VIEW.overview)
  rig.setView(v.target, v.pos)
}

const params = new URLSearchParams(location.search)
/** Screenshot mode: animations jump to their targets. */
const settleMode = params.get('settle') === '1'
const bootFill = document.getElementById('boot-fill')
const bootStatus = document.getElementById('boot-status')
document.documentElement.lang = lang() === 'zh' ? 'zh-CN' : 'en'
document.title = t('doc.title')

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

function pick<T extends string | number>(name: string, allowed: readonly T[], fallback: T): T {
  const v = params.get(name)
  if (v === null) return fallback
  const hit = allowed.find((a) => String(a) === v)
  return hit ?? fallback
}

const BASE_PARTS = new Set(['base', 'phy', 'ctrl', 'sram', 'landing', 'debug'])

async function boot(): Promise<void> {
  const canvasRoot = document.getElementById('canvas-root')!
  const labelsRoot = document.getElementById('labels-root')!
  const hudRoot = document.getElementById('hud')!

  const probe = document.createElement('canvas').getContext('webgl2')
  if (!probe) {
    if (bootStatus) bootStatus.textContent = t('boot.noWebgl')
    return
  }
  probe.getExtension('WEBGL_lose_context')?.loseContext()

  const themeParam = params.get('theme')
  // a link's mode applies to this visit only; it does not overwrite the visitor's choice
  if (themeParam === 'day' || themeParam === 'light') setThemeMode('day', false)
  else if (themeParam === 'night' || themeParam === 'dark') setThemeMode('night', false)
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

  await progress(10, t('boot.renderer'))
  const gfx = createRenderer(canvasRoot)
  const { scene, camera } = gfx

  await progress(20, t('boot.camera'))
  const rig = createCameraRig(camera, gfx.dom)
  camera.position.set(...fitted(VIEW.home).pos)
  rig.controls.target.set(...VIEW.home.target)
  rig.controls.update()

  const ctx: WorldContext = {
    scene,
    bus,
    state,
    quality: gfx.quality,
    register: (def: ComponentDef) => registry.register(def),
  }

  await progress(30, t('boot.sky'))
  scene.add(createSky())

  const modules: WorldModule[] = []
  const add = <T extends WorldModule>(m: T): T => {
    modules.push(m)
    scene.add(m.group)
    return m
  }

  await progress(42, t('boot.package'))
  const pkg = add(createPackage(ctx))

  await progress(55, t('boot.gpu'))
  const gpu = add(createGpu(ctx))

  await progress(66, t('boot.atlas'))
  const occupancy = createOccupancyAtlas()
  const activity = createActivity()
  const simView = createSimView(occupancy)

  await progress(76, t('boot.stacks'))
  const stacks = add(createStacks(ctx, occupancy, activity))

  /* ---- simulator ------------------------------------------------------------- */
  await progress(84, t('boot.sim'))
  const modelIds = Object.keys(MODELS) as ModelId[]
  const workloadIds = Object.keys(TRACES) as WorkloadId[]
  const policyIds = Object.keys(POLICIES) as PolicyId[]
  let scenario: Scenario = {
    model: pick('model', modelIds, 'deepseek-v3'),
    workload: pick('workload', workloadIds, 'toC'),
    policy: pick('policy', policyIds, 'hbflex'),
    width: pick<InterleaveWidth>('width', WIDTHS, 1),
    loadScale: params.has('load') ? clamp(Number(params.get('load')) || 1, 0.25, 1.5) : 1,
  }
  let speed = params.has('speed') ? Number(params.get('speed')) || 600 : 600
  if (!(SPEEDS as readonly number[]).includes(speed)) speed = 600
  let playing = params.get('play') !== '0'
  let load = 0
  let sim: Sim = makeSim(scenario)

  function makeSim(s: Scenario): Sim {
    load = Math.min(1.5, suggestedLoad(s.model, s.workload, s.width) * s.loadScale)
    return createSim({ model: s.model, workload: s.workload, policy: s.policy, width: s.width, load, seed: 7 })
  }

  themed((mode, palette) => {
    simView.setPalette(mode, palette)
    simView.repaintAll(sim.store)
  })

  const skipHours = params.has('skip') ? clamp(Number(params.get('skip')) || 0, 0, 72) : 0
  if (skipHours > 0) {
    await progress(88, t('boot.skip', { h: skipHours }))
    sim.run(skipHours * 3600)
    simView.repaintAll(sim.store)
  }

  await progress(92, t('boot.labels'))
  const labels = createLabels(labelsRoot, registry, bus)
  // the NAND block under the cursor, once the camera is close enough for blocks to matter
  const blockTip = createBlockTip(document.body)
  const picker = createPicker({
    dom: gfx.dom,
    camera,
    registry,
    bus,
    onHoverHit: (hit, x, y) => {
      const b = hit && hit.distance < 600 ? stacks.blockAt(hit) : null
      if (!b) return blockTip.hide()
      const store = sim.store
      const w = store.width
      const perStack = HBF.diesPerStack / w
      // the die's interleave domain, as in domainDies(): dies k, k + 16/w, ...
      const sb = (b.stack * perStack + (b.die % perStack)) * BLOCKS + b.block
      const st = store.state[sb]
      blockTip.show(x, y, {
        ...b,
        state: st === SbState.Weights ? 'weights' : st === SbState.Free ? 'free' : st === SbState.Open ? 'open' : 'closed',
        written: store.written[sb],
        valid: store.valid[sb],
        erases: store.erase[sb],
        width: w,
      })
    },
  })
  scene.add(picker.group)
  gfx.refreshEnvironment()

  /* ---- camera framing ------------------------------------------------------- */
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
    } else if (site && def.district === 'package') {
      // a stack's UCIe link: side-on from outside the package, so the GPU's
      // PHY edge sits on one side of the lanes and the opened stack, with its
      // TSVs, on the other; the generic stack direction would put the camera
      // inside the opened stack
      const out = site.z === 0 ? 1 : Math.sign(site.z)
      // centre a little inside the stack: the GPU is wider than a stack and would fill the frame
      center.x = site.phyEdgeX - site.inward * STACK.length * 0.35
      center.y = 50
      dir = [0, 0.5, out]
      distance = clamp(r * 4 + 140, 300, 700)
    } else if (site && def.district === 'stack' && def.id !== `stack.${def.stack}`) {
      // base-die parts: look down into the opened gap from outside the stack
      center.y = box.max.y
      dir = [-site.inward * 0.7, 1.2, 0.6]
      distance = clamp(Math.max(size.x, size.z) * 2.1 + 60, 80, 620)
    } else if (site) {
      dir = [-site.inward * 0.7, 0.62, 0.62]
    } else if (def.district === 'gpu') {
      dir = [0.3, 1, 0.55]
    } else if (def.district === 'package') {
      dir = [0.5, 0.9, 0.7]
      distance = clamp(r * 1.4 + 60, 60, 2400)
    }
    return { target: [center.x, center.y, center.z], distance, dir }
  }

  function flyToId(id: string): void {
    const def = registry.get(id)
    if (!def) return
    // let a die or the base finish moving before framing it
    const wait = def.die !== undefined || BASE_PARTS.has(def.doc) ? 650 : 0
    if (settleMode) rig.flyTo(focusFor(def), 0.001)
    else window.setTimeout(() => rig.flyTo(focusFor(def)), wait)
  }

  /* ---- selection --------------------------------------------------------------- */
  /** Open the stack and slide out the die, or lift the cores off a base part, as selecting `def` does. */
  function stage(def: ComponentDef | undefined): void {
    if (def?.stack !== undefined) state.focusStack = def.stack
    if (def?.die !== undefined && def.stack !== undefined) {
      const s = def.stack
      if (state.explodeTarget[s] < 0.3) state.explodeTarget[s] = 0.45
      for (let k = 0; k < N; k++) if (k !== s) state.liftedDieTarget[k] = -1
      state.liftedDieTarget[s] = def.die
    } else if (def?.stack !== undefined && BASE_PARTS.has(def.doc)) {
      // uncover the base die: lift the whole core-die stack off it
      const s = def.stack
      for (let k = 0; k < N; k++) state.liftedDieTarget[k] = k === s ? LIFT_BASE : -1
    } else {
      for (let k = 0; k < N; k++) state.liftedDieTarget[k] = -1
    }
    if (settleMode) {
      for (let k = 0; k < N; k++) {
        state.explode[k] = state.explodeTarget[k]
        state.liftedDie[k] = state.liftedDieTarget[k]
        state.lift[k] = state.liftedDie[k] !== -1 ? 1 : 0
      }
      stacks.update(0, state)
    }
  }

  function select(id: string | null): void {
    selected = id
    picker.setSelected(id)
    labels.setHighlight(id)
    inspector.show(id)
    hud.setRightVisible(!id)
    // keep the subject clear of the inspector on wide screens
    rig.setRightInset(id && window.innerWidth > 900 ? Math.min(400, window.innerWidth * 0.3) : 0, settleMode)
    const def = id ? registry.get(id) : undefined
    stacks.setSelectedDie(def?.stack ?? -1, def?.die ?? -1)
    stage(def)
    hud.sync()
  }

  /** Frame a part as a selection would, but keep its notes closed so the Live panel stays in view. */
  function peek(id: string): void {
    select(null)
    const def = registry.get(id)
    if (!def) return
    stage(def)
    rig.setRightInset(window.innerWidth > 900 ? 330 : 0, settleMode)
    hud.sync()
    flyToId(id)
  }

  bus.on('select', ({ id }) => select(id))
  bus.on('hover', ({ id }) => picker.setHovered(id))
  bus.on('focus', ({ id }) => {
    if (!id || !registry.get(id)) return
    if (selected !== id) select(id)
    flyToId(id)
  })
  bus.on('scene:changed', () => hud.sync())

  /** Live block statistics of one die (its interleave domain) or a whole stack. */
  function blockStats(def: ComponentDef): HTMLElement | null {
    if (def.stack === undefined || (def.doc !== 'coreDie' && def.doc !== 'stack')) return null
    const store = sim.store
    const w = store.width
    const perStack = HBF.diesPerStack / w
    const doms =
      def.die !== undefined
        ? [def.stack * perStack + (def.die % perStack)]
        : Array.from({ length: perStack }, (_, k) => def.stack! * perStack + k)
    let weights = 0
    let open = 0
    let validPages = 0
    let invalidPages = 0
    let eraseSum = 0
    let eraseMax = 0
    let kvBlocks = 0
    for (const d of doms) {
      for (let b = 0; b < BLOCKS; b++) {
        const sb = d * BLOCKS + b
        const st = store.state[sb]
        if (st === SbState.Weights) {
          weights++
          continue
        }
        kvBlocks++
        eraseSum += store.erase[sb]
        eraseMax = Math.max(eraseMax, store.erase[sb])
        if (st === SbState.Open) open++
        validPages += store.valid[sb]
        invalidPages += store.written[sb] - store.valid[sb]
        // a closed block's unwritten tail cannot be used until the block is erased
        if (st === SbState.Closed) invalidPages += 512 - store.written[sb]
      }
    }
    const total = (weights + kvBlocks) * 512
    const freePages = total - weights * 512 - validPages - invalidPages
    const rows: [string, number, keyof typeof P][] = [
      [t('occ.weights'), weights * 512, 'weights'],
      [t('occ.valid'), validPages, 'kv'],
      [t('occ.invalid'), invalidPages, 'invalid'],
      [t('occ.free'), freePages, 'free'],
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
    const heading =
      def.die !== undefined ? (w > 1 ? t('occ.pages.dieN', { n: w - 1 }) : t('occ.pages.die')) : t('occ.pages.stack')
    return el('section', { class: 'occ' },
      el('h3', {}, heading),
      bar,
      list,
      el('p', { class: 'occ__sub' }, t('occ.sub', { open, mean: (eraseSum / Math.max(1, kvBlocks)).toFixed(1), max: eraseMax })),
      el('p', { class: 'occ__note' }, t('occ.note', {
        model: MODELS[scenario.model].name,
        workload: t(`wl.${scenario.workload}.name`),
        policy: t(`pol.${scenario.policy}.short`),
      })),
    )
  }

  /* ---- actions shared by the UI and the tour -------------------------------------- */
  function focusStack(s: number): void {
    state.focusStack = s
    bus.emit('focus', { id: `stack.${s}` })
    hud.sync()
  }

  function setView(v: BlockView): void {
    simView.mode = v
    panel.setView(v)
    simView.repaintAll(sim.store)
  }

  function setScenario(s: Scenario): void {
    scenario = s
    sim = makeSim(s)
    activity.reset()
    simView.repaintAll(sim.store)
    panel.sync()
    inspector.show(selected)
  }

  /**
   * Simulate ahead in slices of about 30 ms, so the page stays responsive and
   * the blocks visibly fill while it runs. A new scenario cancels it.
   */
  let skipping: Sim | null = null
  function skip(seconds: number, toast = true): void {
    if (skipping === sim) return
    const target = sim.now + seconds
    const s = (skipping = sim)
    const slice = () => {
      if (s !== sim) return
      const t0 = performance.now()
      while (s.now < target && performance.now() - t0 < 30) s.run(Math.min(600, target - s.now))
      simView.update(s.store, performance.now())
      if (s.now < target) {
        window.setTimeout(slice, 0)
        return
      }
      skipping = null
      simView.repaintAll(s.store)
      activity.resync(s)
      if (toast) bus.emit('toast', { text: t('toast.skipped', { h: (seconds / 3600).toFixed(0) }), ms: 1800 })
    }
    slice()
  }

  function closeAll(): void {
    for (let s = 0; s < N; s++) state.explodeTarget[s] = 0
    hud.sync()
  }

  /* ---- UI, rebuilt on a language change -------------------------------------------- */
  let hud!: Hud
  let inspector!: Inspector
  let panel!: SimPanel
  let tour!: Tour

  function buildUi(): void {
    hud = createHud(hudRoot, state, bus, {
      home: () => goHome(rig),
      overview: () => goOverview(rig),
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
      toggleLang: () => setLang(lang() === 'zh' ? 'en' : 'zh'),
      focusStack,
      tour: () => tour.start(),
    })
    panel = createSimPanel(hud.bottom, hud.leftCol, hud.rightCol, scenario, {
      togglePlay: () => {
        playing = !playing
      },
      setSpeed: (v) => {
        speed = v
        playing = true
      },
      setScenario,
      skip,
      setView,
    })
    panel.setView(simView.mode)
    panel.sync()
    inspector = createInspector(hudRoot, registry, bus)
    inspector.setExtra(blockStats)
    inspector.onFocus((id) => flyToId(id))
    tour = createTour(hud.bottom, {
      home: () => goHome(rig),
      overview: () => goOverview(rig),
      focus: (id) => {
        select(id)
        flyToId(id)
      },
      peek,
      select,
      setExplode: (s, v) => {
        state.explodeTarget[s] = v
        hud.sync()
      },
      closeAll,
      setBlockView: setView,
      setSpeed: (v) => {
        speed = v
      },
      setPlaying: (v) => {
        playing = v
      },
      ensureTime: (seconds) => {
        if (sim.now < seconds) skip(seconds - sim.now, false)
      },
    })
    inspector.show(selected)
    hud.setRightVisible(!selected)
    hud.sync()
  }
  buildUi()

  onLang(() => {
    document.title = t('doc.title')
    const at = tour.index
    tour.stop()
    inspector.dispose()
    hud.dispose()
    buildUi()
    labels.relabel()
    // an open tour carries on at the same stop, in the new language
    if (at >= 0) tour.show(at)
  })

  onThemeMode(() => {
    gfx.refreshEnvironment()
    document.documentElement.dataset.theme = themeMode()
    hud.sync()
    panel.repaint()
    inspector.show(selected)
  })

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.metaKey || e.ctrlKey || e.altKey) return
    const k = e.key.toLowerCase()
    if (tour.key(k)) {
      e.preventDefault()
      return
    }
    if (k === ' ') {
      e.preventDefault()
      playing = !playing
    } else if (k === 'x') {
      const s = state.focusStack
      state.explodeTarget[s] = state.explodeTarget[s] > 0.05 ? 0 : 0.65
      if (state.explodeTarget[s] === 0) state.liftedDieTarget[s] = -1
      hud.sync()
    } else if (k === 'a') {
      const anyClosed = state.explodeTarget.some((v) => v < 0.3)
      for (let s = 0; s < N; s++) state.explodeTarget[s] = anyClosed ? 0.65 : 0
      hud.sync()
    } else if (k === 'h') goHome(rig)
    else if (k === 'o') goOverview(rig)
    else if (k === 'n') toggleThemeMode()
    else if (k === 't') tour.start()
    else if (k === 'w') setView(simView.mode === 'wear' ? 'state' : 'wear')
    else if (k === 'l') {
      state.labels = !state.labels
      hud.sync()
    } else if (k === 'b') {
      state.showBulkSilicon = !state.showBulkSilicon
      hud.sync()
    } else if (k === 'v') {
      state.verticalScaleTarget = state.verticalScaleTarget > 1.01 ? 1 : DEFAULT_VERTICAL_SCALE
      hud.sync()
    } else if (k === 'escape') select(null)
    else if (k >= '1' && k <= '6') focusStack(Number(k) - 1)
  })

  /* ---- start-up view from the URL ---------------------------------------------- */
  const view = params.get('view')
  if (view === 'overview') {
    camera.position.set(...fitted(VIEW.overview).pos)
    rig.controls.target.set(...VIEW.overview.target)
    rig.controls.update()
  }
  if (params.get('blocks') === 'wear') setView('wear')
  const pDie = Number(params.get('die'))
  if (params.has('die') && Number.isInteger(pDie) && pDie >= 0 && pDie < HBF.diesPerStack) {
    select(`stack.${state.focusStack}.die.${pDie}`)
  }
  const pSelect = params.get('select')
  if (pSelect && registry.get(pSelect)) select(pSelect)
  if (settleMode) {
    for (let s = 0; s < N; s++) {
      state.explode[s] = state.explodeTarget[s]
      state.liftedDie[s] = state.liftedDieTarget[s]
      state.lift[s] = state.liftedDie[s] !== -1 ? 1 : 0
    }
    stacks.update(0, state)
  }
  if (view === 'stack') flyToId(`stack.${state.focusStack}`)
  const pFocus = params.get('focus')
  if (pFocus && registry.get(pFocus)) flyToId(pFocus)
  const pTour = params.has('tour') ? Number(params.get('tour')) : NaN
  if (Number.isInteger(pTour) && pTour >= 1 && pTour <= 8) {
    tour.start()
    for (let i = 1; i < pTour; i++) tour.key('arrowright')
  }

  ;(window as unknown as { HBFCITY: unknown }).HBFCITY = {
    state,
    registry,
    bus,
    rig,
    gfx,
    select,
    get sim() {
      return sim
    },
  }

  await progress(100, t('boot.ready'))
  if (settleMode) document.getElementById('boot')?.remove()
  else {
    document.getElementById('boot')?.classList.add('boot--done')
    window.setTimeout(() => document.getElementById('boot')?.remove(), 900)
  }

  /* ---- loop ------------------------------------------------------------------ */
  let last = performance.now()
  let lastPanel = 0
  function frame(now: number): void {
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000))
    last = now
    if (Math.abs(state.verticalScale - state.verticalScaleTarget) > 1e-3) {
      state.verticalScale = damp(state.verticalScale, state.verticalScaleTarget, 4, dt)
    } else state.verticalScale = state.verticalScaleTarget

    const before = sim.now
    if (playing) sim.step(dt, speed)
    const simDt = sim.now - before
    activity.update(sim, simDt, dt)
    simView.update(sim.store, now)
    stacks.setActivity(activity, dt)
    pkg.setActivity(activity, dt)
    gpu.setActivity(activity.compute, activity.readMean)
    if (now - lastPanel > 200) {
      lastPanel = now
      panel.update(sim, playing, speed, load, simView.wearRange)
    }

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
  if (bootStatus) bootStatus.textContent = t('boot.failed', { msg: err instanceof Error ? err.message : String(err) })
})
