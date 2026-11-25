import { HBF } from '../core/hbf-spec'
import { cssHex, P } from '../core/theme'
import { fmtRate } from '../core/util'
import { MODELS } from '../sim/models'
import type { ModelId } from '../sim/models'
import { POLICIES, WIDTHS } from '../sim/store'
import type { InterleaveWidth, PolicyId } from '../sim/store'
import type { Sim } from '../sim/sim'
import { TRACES } from '../sim/workload'
import type { WorkloadId } from '../sim/workload'
import type { BlockView } from '../world/sim-view'
import { el } from './dom'

/* ============================================================================
 * SIMULATION PANELS — playback, scenario and live metrics.
 *
 * Playback runs simulated time at a chosen rate; the clock shows simulated
 * time and, when the CPU cannot keep up, the rate actually achieved. Changing
 * the scenario restarts the simulation from an empty KV cache.
 * ==========================================================================*/

export interface Scenario {
  model: ModelId
  workload: WorkloadId
  policy: PolicyId
  width: InterleaveWidth
  /** multiplier on the suggested share of the trace */
  loadScale: number
}

export const SPEEDS: { label: string; value: number; title: string }[] = [
  { label: '1×', value: 1, title: 'real time: one decode iteration every few hundred ms' },
  { label: '1 min/s', value: 60, title: 'one simulated minute per second' },
  { label: '10 min/s', value: 600, title: 'ten simulated minutes per second' },
  { label: '1 h/s', value: 3600, title: 'one simulated hour per second' },
  { label: '6 h/s', value: 21600, title: 'six simulated hours per second, as fast as the CPU allows' },
]

export interface SimPanelActions {
  togglePlay(): void
  setSpeed(v: number): void
  setScenario(s: Scenario): void
  skip(seconds: number): void
  setView(v: BlockView): void
}

export interface SimPanel {
  sync(): void
  update(sim: Sim, playing: boolean, speed: number, load: number, wearRange: { min: number; max: number }): void
  setMetricsVisible(v: boolean): void
  setView(v: BlockView): void
}

function select<T extends string | number>(
  label: string,
  options: { value: T; label: string }[],
  get: () => T,
  set: (v: T) => void,
): { root: HTMLElement; sync(): void } {
  const s = el('select', { 'aria-label': label })
  for (const o of options) s.append(el('option', { value: String(o.value) }, o.label))
  s.addEventListener('change', () => {
    const o = options.find((x) => String(x.value) === s.value)
    if (o) set(o.value)
  })
  return {
    root: el('label', { class: 'field' }, el('span', { class: 'field__lab' }, label), s),
    sync() {
      s.value = String(get())
    },
  }
}

function clock(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${d > 0 ? `${d} d ` : ''}${two(h)}:${two(m)}:${two(s)}`
}

function fmtTime(s: number): string {
  if (!Number.isFinite(s)) return '—'
  if (s < 1) return `${(s * 1000).toFixed(0)} ms`
  if (s < 120) return `${s.toFixed(1)} s`
  return `${(s / 60).toFixed(1)} min`
}

function fmtLife(s: number): string {
  if (!Number.isFinite(s) || s <= 0) return 'not yet measurable'
  const y = s / (365 * 86400)
  if (y >= 100) return '> 100 years'
  if (y >= 1) return `≈ ${y.toFixed(1)} years`
  const d = s / 86400
  if (d >= 1) return `≈ ${d.toFixed(0)} days`
  return `≈ ${(s / 3600).toFixed(1)} hours`
}

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n.toFixed(0))

export function createSimPanel(root: HTMLElement, scenario: Scenario, act: SimPanelActions): SimPanel {
  /* ---- playback bar ------------------------------------------------------- */
  const play = el('button', { type: 'button', class: 'btn play', title: 'Play / pause (Space)' })
  play.addEventListener('click', () => act.togglePlay())
  const speedBtns = SPEEDS.map((s) => {
    const b = el('button', { type: 'button', class: 'btn speed', title: s.title }, s.label)
    b.addEventListener('click', () => act.setSpeed(s.value))
    return { b, v: s.value }
  })
  const clockEl = el('span', { class: 'clock' })
  const rateEl = el('span', { class: 'rate' })
  const bar = el('section', { class: 'playbar', 'aria-label': 'Simulation playback' },
    play,
    el('div', { class: 'speeds' }, ...speedBtns.map((x) => x.b)),
    el('div', { class: 'clockbox' }, clockEl, rateEl),
  )
  root.append(bar)

  /* ---- scenario card -------------------------------------------------------- */
  const cur = { ...scenario }
  const apply = () => act.setScenario({ ...cur })
  const fModel = select('Model', Object.values(MODELS).map((m) => ({ value: m.id, label: m.name })), () => cur.model, (v) => {
    cur.model = v
    apply()
  })
  const fWork = select('Workload', Object.values(TRACES).map((t) => ({ value: t.id, label: `${t.name} — ${t.description}` })), () => cur.workload, (v) => {
    cur.workload = v
    apply()
  })
  const fPolicy = select('Block policy', (Object.keys(POLICIES) as PolicyId[]).map((p) => ({ value: p, label: POLICIES[p].name })), () => cur.policy, (v) => {
    cur.policy = v
    apply()
  })
  const fWidth = select('Interleave', WIDTHS.map((w) => ({ value: w, label: w === 1 ? '1 die per session' : `${w} dies per session` })), () => cur.width, (v) => {
    cur.width = v as InterleaveWidth
    apply()
  })
  const loadIn = el('input', { type: 'range', min: '0.25', max: '1.5', step: '0.05', class: 'dock__slider', 'aria-label': 'Load' }) as HTMLInputElement
  const loadVal = el('span', { class: 'dock__val' })
  loadIn.addEventListener('change', () => {
    cur.loadScale = Number(loadIn.value)
    apply()
  })
  loadIn.addEventListener('input', () => {
    loadVal.textContent = `${Number(loadIn.value).toFixed(2)}×`
  })
  const policyNote = el('p', { class: 'card__note' })
  const loadNote = el('p', { class: 'card__note' })
  const skip = el('button', { type: 'button', class: 'btn btn--small', title: 'Simulate six hours at once' }, 'Skip 6 h')
  skip.addEventListener('click', () => act.skip(6 * 3600))
  const reset = el('button', { type: 'button', class: 'btn btn--small', title: 'Restart with an empty KV cache' }, 'Restart')
  reset.addEventListener('click', () => apply())
  const card = el('section', { class: 'card scenario', 'aria-label': 'Scenario' },
    el('div', { class: 'card__head' }, el('h3', {}, 'LLM serving on HBF'), el('div', { class: 'card__btns' }, skip, reset)),
    fModel.root,
    fWork.root,
    fPolicy.root,
    policyNote,
    fWidth.root,
    el('label', { class: 'dock__row' }, el('span', { class: 'dock__lab' }, 'Load'), loadIn, loadVal),
    loadNote,
  )
  root.append(card)

  /* ---- metrics card ----------------------------------------------------------- */
  const m = {
    serving: el('dl', { class: 'mx' }),
    hbf: el('dl', { class: 'mx' }),
    capBar: el('div', { class: 'cap' }),
    cap: el('p', { class: 'mx__line' }),
    wear: el('dl', { class: 'mx' }),
  }
  const capValid = el('i', { class: 'cap__valid' })
  const capInvalid = el('i', { class: 'cap__invalid' })
  const capFree = el('i', { class: 'cap__free' })
  m.capBar.append(capValid, capInvalid, capFree)
  const viewState = el('button', { type: 'button', class: 'btn btn--small' }, 'Block state')
  const viewWear = el('button', { type: 'button', class: 'btn btn--small' }, 'Wear')
  viewState.addEventListener('click', () => act.setView('state'))
  viewWear.addEventListener('click', () => act.setView('wear'))
  const wearLegend = el('div', { class: 'wearlegend', hidden: '' }, el('span', { class: 'wearlegend__lo' }), el('i', { class: 'wearlegend__ramp' }), el('span', { class: 'wearlegend__hi' }))
  const metrics = el('section', { class: 'card metrics', 'aria-label': 'Live metrics' },
    el('h3', {}, 'Serving'),
    m.serving,
    el('h3', {}, 'HBF traffic'),
    m.hbf,
    el('h3', {}, 'KV capacity'),
    m.capBar,
    m.cap,
    el('div', { class: 'card__head' }, el('h3', {}, 'Endurance'), el('div', { class: 'card__btns' }, viewState, viewWear)),
    wearLegend,
    m.wear,
    el('p', { class: 'card__note' }, 'Simulated, not measured. Rates are in simulated time.'),
  )
  root.append(metrics)

  function rows(dl: HTMLElement, items: [string, string][]): void {
    if (dl.childElementCount !== items.length * 2) {
      dl.replaceChildren()
      for (const [a] of items) dl.append(el('dt', {}, a), el('dd', {}))
    }
    for (let i = 0; i < items.length; i++) {
      ;(dl.children[i * 2] as HTMLElement).textContent = items[i][0]
      ;(dl.children[i * 2 + 1] as HTMLElement).textContent = items[i][1]
    }
  }

  let view: BlockView = 'state'
  let lastWear = 0
  let wearCache = { mean: 0, max: 0, lifeSeconds: Infinity, rate: 0 }

  return {
    sync() {
      fModel.sync()
      fWork.sync()
      fPolicy.sync()
      fWidth.sync()
      loadIn.value = String(cur.loadScale)
      loadVal.textContent = `${cur.loadScale.toFixed(2)}×`
      policyNote.textContent = POLICIES[cur.policy].detail
    },
    update(sim, playing, speed, load, wearRange) {
      play.textContent = playing ? '❚❚' : '▶'
      play.classList.toggle('btn--on', playing)
      for (const s of speedBtns) s.b.classList.toggle('btn--on', s.v === speed)
      clockEl.textContent = clock(sim.now)
      const eff = sim.effectiveSpeed
      rateEl.textContent = playing && eff > 0 && eff < speed * 0.8 ? `CPU-limited: ${k(eff)}×` : ''
      const t = sim.trace
      loadNote.textContent = `${(load * 100).toFixed(0)} % of the ${t.name} trace’s traffic (${(t.reqPerSec * load).toFixed(2)} requests/s): about what one GPU sustains.`

      const x = sim.metrics
      rows(m.serving, [
        ['Requests', `${x.completedPerSec.toFixed(2)}/s · batch ${x.batch} · queue ${x.queue}${x.dropped ? ` · ${x.dropped} turned away` : ''}`],
        ['Latency', `TTFT ${fmtTime(x.ttft)} · TPOT ${fmtTime(x.tpot)}`],
        ['Tokens', `decode ${k(x.outputTokPerSec)}/s · prefill ${k(x.prefillTokPerSec)}/s`],
      ])
      rows(m.hbf, [
        ['Reads', `${fmtRate(x.readBps)} (weights + KV)`],
        ['KV writes', `${fmtRate(x.kvWriteBps)} · GC copies ${fmtRate(x.gcBps)}`],
        ['Erases', `${x.erasesPerSec.toFixed(2)} blocks/s`],
        ['SRAM staging', `${(x.sramBytes / 1048576).toFixed(1)} MiB of ${HBF.stacksPerGpu * HBF.baseDieSramMiB} MiB`],
      ])
      const c = sim.capacity()
      capValid.style.width = `${(c.valid * 100).toFixed(1)}%`
      capInvalid.style.width = `${(Math.max(0, c.written - c.valid) * 100).toFixed(1)}%`
      capFree.style.width = `${(c.free * 100).toFixed(1)}%`
      capValid.style.background = cssHex(P.kv)
      capInvalid.style.background = cssHex(P.invalid)
      capFree.style.background = cssHex(P.free)
      m.cap.textContent = `valid ${(c.valid * 100).toFixed(0)} % · invalid ${(Math.max(0, c.written - c.valid) * 100).toFixed(0)} % · free ${(c.free * 100).toFixed(0)} % of ${((sim.store.kvPages * sim.store.stripeBytes) / 2 ** 40).toFixed(2)} TiB`
      const now = performance.now()
      if (now - lastWear > 400) {
        wearCache = sim.wear()
        lastWear = now
      }
      rows(m.wear, [
        ['Write amp.', `${sim.waf().toFixed(2)} (GC copies + page padding)`],
        ['Turnovers', `${sim.turnovers().toFixed(2)} × the KV capacity written`],
        ['Erases/block', `mean ${wearCache.mean.toFixed(1)} · max ${wearCache.max}`],
        ['First wear-out', `${fmtLife(wearCache.lifeSeconds)} at current rates (${HBF.peCycles.toLocaleString('en-US')} P/E)`],
      ])
      viewState.classList.toggle('btn--on', view === 'state')
      viewWear.classList.toggle('btn--on', view === 'wear')
      wearLegend.hidden = view !== 'wear'
      if (view === 'wear') {
        ;(wearLegend.children[0] as HTMLElement).textContent = '0'
        ;(wearLegend.children[2] as HTMLElement).textContent = `${wearRange.max} erases (log)`
      }
    },
    setMetricsVisible(v) {
      metrics.hidden = !v
    },
    setView(v) {
      view = v
    },
  }
}
