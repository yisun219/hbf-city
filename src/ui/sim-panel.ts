import { HBF } from '../core/hbf-spec'
import { t } from '../core/i18n'
import { cssHex, P } from '../core/theme'
import type { Palette } from '../core/theme'
import { MODELS } from '../sim/models'
import type { ModelId } from '../sim/models'
import { POLICIES, WIDTHS } from '../sim/store'
import type { InterleaveWidth, PolicyId } from '../sim/store'
import type { Sim } from '../sim/sim'
import { TRACES } from '../sim/workload'
import type { WorkloadId } from '../sim/workload'
import type { BlockView } from '../world/sim-view'
import { card, el } from './dom'

/* ============================================================================
 * SIMULATION PANELS — playback bar, scenario card, live metrics and legend.
 *
 * Metrics are tiles: one number, its unit and a short caption, so they read
 * at a glance and never wrap mid-value. The legend follows what the blocks
 * show right now: their state, or their wear. Changing the scenario restarts
 * the simulation from an empty KV cache.
 * ==========================================================================*/

export interface Scenario {
  model: ModelId
  workload: WorkloadId
  policy: PolicyId
  width: InterleaveWidth
  /** multiplier on the suggested share of the trace */
  loadScale: number
}

export const SPEEDS = [1, 60, 600, 3600, 21600] as const

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
  setView(v: BlockView): void
  /** re-read palette colours into the legend and capacity bar */
  repaint(): void
  dispose(): void
}

/* ---- formatting ------------------------------------------------------------------ */

function clock(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${d > 0 ? `${t('clock.days', { d })} ` : ''}${two(h)}:${two(m)}:${two(s)}`
}

/** [value, unit] for a duration */
function dur(s: number): [string, string] {
  if (!Number.isFinite(s) || s <= 0) return ['—', '']
  if (s < 1) return [(s * 1000).toFixed(0), 'ms']
  if (s < 120) return [s.toFixed(1), 's']
  return [(s / 60).toFixed(1), 'min']
}

/** [value, unit] for a byte rate */
function rate(bps: number): [string, string] {
  if (bps >= 1e12) return [(bps / 1e12).toFixed(2), 'TB/s']
  if (bps >= 1e9) return [(bps / 1e9).toFixed(1), 'GB/s']
  if (bps >= 1e6) return [(bps / 1e6).toFixed(0), 'MB/s']
  return [(bps / 1e3).toFixed(0), 'kB/s']
}

function count(n: number): string {
  if (n >= 1e4) return `${(n / 1e3).toFixed(0)}k`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return n.toFixed(n < 10 ? 2 : 0)
}

function life(s: number): [string, string] {
  if (!Number.isFinite(s) || s <= 0) return ['—', '']
  const y = s / (365 * 86400)
  if (y >= 100) return ['>100', t('unit.years')]
  if (y >= 1) return [y.toFixed(1), t('unit.years')]
  const d = s / 86400
  if (d >= 1.5) return [d.toFixed(0), t('unit.days')]
  if (d >= 1) return ['1', t('unit.day')]
  return [(s / 3600).toFixed(1), t('unit.hours')]
}

/* ---- small builders ------------------------------------------------------------------ */

interface Tile {
  root: HTMLElement
  set(value: string, unit: string, sub?: string, tone?: 'warn' | 'bad' | ''): void
}

function tile(key: string): Tile {
  const v = el('span', { class: 'tile__v' })
  const u = el('span', { class: 'tile__u' })
  const sub = el('span', { class: 'tile__sub' })
  const root = el('div', { class: 'tile', title: t(`${key}.title`) }, el('span', { class: 'tile__lab' }, t(key)), el('span', { class: 'tile__num' }, v, u), sub)
  return {
    root,
    set(value, unit, s = '', tone = '') {
      if (v.textContent !== value) v.textContent = value
      if (u.textContent !== unit) u.textContent = unit
      if (sub.textContent !== s) sub.textContent = s
      root.dataset.tone = tone
    },
  }
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

const STATE_LEGEND: { key: keyof Palette; label: string }[] = [
  { key: 'weights', label: 'legend.weights' },
  { key: 'kv', label: 'legend.valid' },
  { key: 'invalid', label: 'legend.invalid' },
  { key: 'kvTail', label: 'legend.writing' },
  { key: 'free', label: 'legend.free' },
]
const STRUCTURE_LEGEND: { key: keyof Palette; label: string }[] = [
  { key: 'compute', label: 'legend.compute' },
  { key: 'sram', label: 'legend.sram' },
  { key: 'link', label: 'legend.ucie' },
  { key: 'tsv', label: 'legend.tsv' },
]

export function createSimPanel(
  bottom: HTMLElement,
  leftCol: HTMLElement,
  rightCol: HTMLElement,
  scenario: Scenario,
  act: SimPanelActions,
): SimPanel {
  /* ---- playback bar ------------------------------------------------------- */
  const play = el('button', { type: 'button', class: 'btn play', title: t('play.title') })
  play.addEventListener('click', () => act.togglePlay())
  const speedBtns = SPEEDS.map((v) => {
    const b = el('button', { type: 'button', class: 'btn speed', title: t(`speed.${v}.title`) }, t(`speed.${v}`))
    b.addEventListener('click', () => act.setSpeed(v))
    return { b, v: v as number }
  })
  const clockEl = el('span', { class: 'clock', title: t('clock.title') })
  const rateEl = el('span', { class: 'rate' })
  bottom.append(
    el('section', { class: 'playbar' },
      play,
      el('div', { class: 'speeds' }, ...speedBtns.map((x) => x.b)),
      el('div', { class: 'clockbox' }, clockEl, rateEl),
    ),
  )

  /* ---- scenario card -------------------------------------------------------- */
  const cur = { ...scenario }
  const apply = () => act.setScenario({ ...cur })
  const fModel = select(t('f.model'), Object.values(MODELS).map((m) => ({ value: m.id, label: m.name })), () => cur.model, (v) => {
    cur.model = v
    apply()
  })
  const fWork = select(t('f.workload'), Object.values(TRACES).map((tr) => ({ value: tr.id, label: t(`wl.${tr.id}.name`) })), () => cur.workload, (v) => {
    cur.workload = v
    apply()
  })
  const fPolicy = select(t('f.blocks'), (Object.keys(POLICIES) as PolicyId[]).map((p) => ({ value: p, label: t(`pol.${p}.short`) })), () => cur.policy, (v) => {
    cur.policy = v
    apply()
  })
  const fWidth = select(t('f.interleave'), WIDTHS.map((w) => ({ value: w, label: w === 1 ? t('width.one') : t('width.n', { n: w }) })), () => cur.width, (v) => {
    cur.width = v as InterleaveWidth
    apply()
  })
  const loadIn = el('input', { type: 'range', min: '0.25', max: '1.5', step: '0.05', class: 'slider', 'aria-label': t('f.load') }) as HTMLInputElement
  const loadVal = el('span', { class: 'row__val' })
  loadIn.addEventListener('change', () => {
    cur.loadScale = Number(loadIn.value)
    apply()
  })
  loadIn.addEventListener('input', () => {
    loadVal.textContent = `${Number(loadIn.value).toFixed(2)}×`
  })
  const workNote = el('p', { class: 'note' })
  const policyNote = el('p', { class: 'note' })
  const loadNote = el('p', { class: 'note' })
  const skip = el('button', { type: 'button', class: 'btn btn--small', title: t('sc.skip.title') }, t('sc.skip'))
  skip.addEventListener('click', (e) => {
    e.stopPropagation()
    act.skip(6 * 3600)
  })
  const reset = el('button', { type: 'button', class: 'btn btn--small', title: t('sc.restart.title') }, t('sc.restart'))
  reset.addEventListener('click', (e) => {
    e.stopPropagation()
    apply()
  })
  const sc = card('scenario', t('sc.title'))
  sc.tools.append(skip, reset)
  sc.body.append(
    fModel.root,
    fWork.root,
    workNote,
    fPolicy.root,
    policyNote,
    fWidth.root,
    el('label', { class: 'row' }, el('span', { class: 'row__lab' }, t('f.load')), loadIn, loadVal),
    loadNote,
  )
  leftCol.append(sc.root)

  /* ---- metrics card ------------------------------------------------------------- */
  const tl = {
    tpot: tile('tile.tpot'),
    ttft: tile('tile.ttft'),
    tokens: tile('tile.decode'),
    reqs: tile('tile.reqs'),
    reads: tile('tile.reads'),
    writes: tile('tile.writes'),
    gc: tile('tile.gc'),
    erases: tile('tile.erases'),
    waf: tile('tile.waf'),
    turn: tile('tile.turn'),
    wear: tile('tile.wear'),
    life: tile('tile.life'),
  }
  const grid = (...ts: Tile[]) => el('div', { class: 'tiles' }, ...ts.map((x) => x.root))
  const capValid = el('i', {})
  const capInvalid = el('i', {})
  const capFree = el('i', {})
  const capLine = el('p', { class: 'cap__line' })
  const capTotal = el('span', { class: 'sec__aside' })
  const viewState = el('button', { type: 'button', class: 'seg__b' }, t('seg.state'))
  const viewWear = el('button', { type: 'button', class: 'seg__b' }, t('seg.wear'))
  viewState.addEventListener('click', (e) => {
    e.stopPropagation()
    act.setView('state')
  })
  viewWear.addEventListener('click', (e) => {
    e.stopPropagation()
    act.setView('wear')
  })

  const legendState = el('div', { class: 'legend' })
  const dots: { dot: HTMLElement; key: keyof Palette }[] = []
  const legendGroup = (title: string, items: { key: keyof Palette; label: string }[]) => {
    const g = el('div', { class: 'legend__group' }, el('span', { class: 'legend__title' }, title))
    for (const it of items) {
      const dot = el('i', { class: 'legend__dot' })
      dots.push({ dot, key: it.key })
      g.append(el('span', { class: 'legend__item' }, dot, t(it.label)))
    }
    return g
  }
  legendState.append(legendGroup(t('legend.blocks'), STATE_LEGEND), legendGroup(t('legend.structure'), STRUCTURE_LEGEND))
  const wearLo = el('span', {})
  const wearHi = el('span', {})
  const legendWear = el('div', { class: 'legend legend--wear', hidden: '' },
    el('span', { class: 'legend__title' }, t('legend.wearTitle')),
    el('div', { class: 'ramp' }, wearLo, el('i', { class: 'ramp__bar' }), wearHi),
    el('span', { class: 'legend__note' }, t('legend.wearNote')),
  )

  const mc = card('metrics', t('mc.title'))
  mc.tools.append(el('div', { class: 'seg', role: 'group', 'aria-label': t('seg.aria'), title: t('seg.title') }, viewState, viewWear))
  mc.body.append(
    el('h4', { class: 'sec' }, t('sec.serving')),
    grid(tl.tpot, tl.ttft, tl.tokens, tl.reqs),
    el('h4', { class: 'sec' }, t('sec.traffic')),
    grid(tl.reads, tl.writes, tl.gc, tl.erases),
    el('h4', { class: 'sec sec--split' }, el('span', {}, t('sec.capacity')), capTotal),
    el('div', { class: 'cap' }, capValid, capInvalid, capFree),
    capLine,
    el('h4', { class: 'sec' }, t('sec.endurance')),
    grid(tl.waf, tl.turn, tl.wear, tl.life),
    legendState,
    legendWear,
    el('p', { class: 'note' }, t('mc.note')),
  )
  // On narrow screens the right column is hidden: the Live card joins the left
  // column, under the scenario, so the metrics the tour refers to stay reachable.
  const narrow = typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 900px)') : null
  const place = () => (narrow?.matches ? leftCol : rightCol).append(mc.root)
  place()
  narrow?.addEventListener?.('change', place)

  let view: BlockView = 'state'
  let lastWear = 0
  let wearCache = { mean: 0, max: 0, lifeSeconds: Infinity, rate: 0 }

  function repaint(): void {
    for (const { dot, key } of dots) dot.style.background = cssHex(P[key])
    capValid.style.background = cssHex(P.kv)
    capInvalid.style.background = cssHex(P.invalid)
    capFree.style.background = cssHex(P.free)
  }
  repaint()

  return {
    dispose() {
      narrow?.removeEventListener?.('change', place)
    },
    sync() {
      fModel.sync()
      fWork.sync()
      fPolicy.sync()
      fWidth.sync()
      loadIn.value = String(cur.loadScale)
      loadVal.textContent = `${cur.loadScale.toFixed(2)}×`
      policyNote.textContent = t(`pol.${cur.policy}.detail`)
      workNote.textContent = t(`wl.${cur.workload}.desc`)
    },
    update(sim, playing, speed, load, wearRange) {
      play.textContent = playing ? '❚❚' : '▶'
      play.classList.toggle('btn--on', playing)
      play.setAttribute('aria-label', playing ? t('play.pause') : t('play.play'))
      for (const s of speedBtns) s.b.classList.toggle('btn--on', s.v === speed)
      clockEl.textContent = clock(sim.now)
      const eff = sim.effectiveSpeed
      rateEl.textContent = !playing ? t('rate.paused') : eff > 0 && eff < speed * 0.8 ? t('rate.cpu', { x: count(eff) }) : ''
      const loadVars = { p: (load * 100).toFixed(0), r: (sim.trace.reqPerSec * load).toFixed(2), x: cur.loadScale.toFixed(2) }
      loadNote.textContent = Math.abs(cur.loadScale - 1) < 0.005 ? t('load.note', loadVars) : t('load.noteX', loadVars)

      const x = sim.metrics
      const [tpV, tpU] = dur(x.tpot)
      const [ttV, ttU] = dur(x.ttft)
      tl.tpot.set(tpV, tpU, t('sub.batch', { n: x.batch }))
      tl.ttft.set(ttV, ttU, x.queue ? t('sub.queue', { n: x.queue }) : t('sub.noQueue'), x.queue > 200 ? 'warn' : '')
      tl.tokens.set(count(x.outputTokPerSec), 'tok/s', t('sub.prefill', { n: count(x.prefillTokPerSec) }))
      tl.reqs.set(x.completedPerSec.toFixed(2), '/s', x.dropped ? t('sub.dropped', { n: x.dropped }) : '', x.dropped ? 'bad' : '')
      const [rdV, rdU] = rate(x.readBps)
      const [wrV, wrU] = rate(x.kvWriteBps)
      const [gcV, gcU] = rate(x.gcBps)
      tl.reads.set(rdV, rdU, t('sub.reads'))
      // staging beyond the base dies' SRAM is shown, not stalled for: say so in red
      const sramCap = HBF.stacksPerGpu * HBF.baseDieSramMB
      const sramMB = x.sramBytes / 1e6
      tl.writes.set(wrV, wrU, t('sub.sram', { a: sramMB.toFixed(0), b: sramCap }), sramMB > sramCap ? 'bad' : '')
      tl.gc.set(gcV, gcU, '', x.gcBps > x.kvWriteBps ? 'bad' : '')
      // the store counts superblock erases; a superblock spans one block row on each die of its domain
      const rows = x.erasesPerSec * sim.store.width
      tl.erases.set(rows.toFixed(rows < 10 ? 2 : 0), '/s', t('sub.rows'))

      const c = sim.capacity()
      const inv = c.reclaimable
      capValid.style.width = `${(c.valid * 100).toFixed(1)}%`
      capInvalid.style.width = `${(inv * 100).toFixed(1)}%`
      capFree.style.width = `${(c.free * 100).toFixed(1)}%`
      capLine.textContent = t('cap.line', {
        v: (c.valid * 100).toFixed(0),
        i: (inv * 100).toFixed(0),
        f: (c.free * 100).toFixed(0),
      })
      capTotal.textContent = `${((sim.store.kvPages * sim.store.stripeBytes) / 2 ** 40).toFixed(2)} TiB`

      const now = performance.now()
      if (now - lastWear > 400) {
        wearCache = sim.wear()
        lastWear = now
      }
      const waf = sim.waf()
      tl.waf.set(waf.toFixed(2), '×', t('sub.waf'), waf > 2 ? 'bad' : waf > 1.3 ? 'warn' : '')
      tl.turn.set(sim.turnovers().toFixed(2), '×', t('sub.turn'))
      tl.wear.set(String(wearCache.max), t('unit.max'), t('sub.mean', { x: wearCache.mean.toFixed(1) }))
      const ls = wearCache.lifeSeconds
      if (wearCache.max === 0) tl.life.set('—', '', t('sub.lifeNone'))
      else if (Number.isNaN(ls)) tl.life.set('—', '', t('sub.lifeWait'))
      else if (!Number.isFinite(ls)) tl.life.set('—', '', t('sub.lifeIdle'))
      else {
        const [lV, lU] = life(ls)
        const years = ls / (365 * 86400)
        tl.life.set(lV, lU, t('sub.life', { k: HBF.peCycles / 1000 }), years < 1 ? 'bad' : years < 5 ? 'warn' : '')
      }

      viewState.classList.toggle('seg__b--on', view === 'state')
      viewWear.classList.toggle('seg__b--on', view === 'wear')
      legendState.hidden = view !== 'state'
      legendWear.hidden = view !== 'wear'
      wearLo.textContent = '0'
      wearHi.textContent = String(wearRange.max)
    },
    setView(v) {
      view = v
    },
    repaint,
  }
}
