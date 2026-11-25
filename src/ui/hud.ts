import { HBF } from '../core/hbf-spec'
import { cssHex, P, themeMode } from '../core/theme'
import type { Palette } from '../core/theme'
import type { Bus, SceneState } from '../core/types'
import { STACK_SITES } from '../world/layout'
import { TRUST_NOTES } from './content'
import { el } from './dom'

/* ============================================================================
 * HUD — brand, toolbar, the stack dock and the legend.
 *
 * The HUD only edits SceneState and emits on the bus; the world reads the
 * state on its next frame. Nothing here touches three.js.
 * ==========================================================================*/

export interface HudActions {
  home(): void
  overview(): void
  toggleTheme(): void
  toggleLabels(): void
  toggleBulk(): void
  toggleScale(): void
  focusStack(s: number): void
}

export interface Hud {
  sync(): void
}

const LEGEND: { key: keyof Palette; label: string }[] = [
  { key: 'weights', label: 'Weights' },
  { key: 'kv', label: 'KV, all pages valid' },
  { key: 'kvTail', label: 'Open block (being written)' },
  { key: 'invalid', label: 'KV, all pages invalid' },
  { key: 'free', label: 'Free (erased)' },
  { key: 'sram', label: 'SRAM' },
  { key: 'compute', label: 'Compute (SM)' },
  { key: 'link', label: 'UCIe / I/O link' },
  { key: 'tsv', label: 'Signal TSVs' },
]

function button(label: string, title: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = el('button', { type: 'button', class: `btn ${cls}`.trim(), title }, label)
  b.addEventListener('click', (e) => {
    e.stopPropagation()
    onClick()
  })
  return b
}

export function createHud(root: HTMLElement, state: SceneState, bus: Bus, act: HudActions): Hud {
  /* ---- brand ------------------------------------------------------------- */
  const trust = el('div', { class: 'sheet', hidden: '' })
  const trustList = el('ul', {})
  for (const t of TRUST_NOTES) trustList.append(el('li', {}, t))
  trust.append(el('h3', {}, 'How much to trust this'), trustList)
  const trustBtn = el('button', { type: 'button', class: 'chip chip--honest' }, 'Model · how much to trust this')
  trustBtn.addEventListener('click', () => {
    trust.hidden = !trust.hidden
  })
  const brand = el('div', { class: 'brand' },
    el('div', { class: 'brand__mark', 'aria-hidden': 'true' }, el('i'), el('i'), el('i'), el('i')),
    el('div', {},
      el('h1', { class: 'brand__title' }, 'HBFCity'),
      el('p', { class: 'brand__sub' }, 'A GPU package with High Bandwidth Flash, built for LLM serving'),
      trustBtn,
    ),
  )
  root.append(brand, trust)

  /* ---- toolbar ------------------------------------------------------------- */
  const themeBtn = button('', 'Night / day (N)', act.toggleTheme)
  const labelsBtn = button('Labels', 'Show labels (L)', act.toggleLabels)
  const bulkBtn = button('Silicon', 'Show the GPU’s bulk silicon (B)', act.toggleBulk)
  const scaleBtn = button('', 'Vertical exaggeration (T)', act.toggleScale)
  const toolbar = el('nav', { class: 'toolbar', 'aria-label': 'View' },
    themeBtn,
    labelsBtn,
    bulkBtn,
    scaleBtn,
    button('Overview', 'Top-down overview (O)', act.overview),
    button('Home', 'Back to the establishing shot (H)', act.home),
  )
  root.append(toolbar)

  /* ---- stack dock ----------------------------------------------------------- */
  const stackBtns: HTMLButtonElement[] = []
  const west = el('div', { class: 'mini__col' })
  const east = el('div', { class: 'mini__col' })
  for (const site of STACK_SITES) {
    const b = button(`${site.index}`, `HBF stack ${site.index} (${site.index + 1})`, () => act.focusStack(site.index), 'mini__stack')
    stackBtns.push(b)
    ;(site.side === 'west' ? west : east).append(b)
  }
  const mini = el('div', { class: 'mini', 'aria-label': 'Choose a stack' }, west, el('div', { class: 'mini__gpu' }, 'GPU'), east)

  const slider = el('input', { type: 'range', min: '0', max: '100', step: '1', class: 'dock__slider', 'aria-label': 'Open the stack' }) as HTMLInputElement
  slider.addEventListener('input', () => {
    state.explodeTarget[state.focusStack] = Number(slider.value) / 100
    bus.emit('scene:changed', {})
  })
  const sliderVal = el('span', { class: 'dock__val' })
  const dockTitle = el('div', { class: 'dock__title' })
  const openAll = button('Open all', 'Open every stack (A)', () => {
    const anyClosed = state.explodeTarget.some((e) => e < 0.3)
    for (let s = 0; s < HBF.stacksPerGpu; s++) state.explodeTarget[s] = anyClosed ? 0.65 : 0
    bus.emit('scene:changed', {})
    sync()
  })
  const dock = el('section', { class: 'dock' },
    el('div', { class: 'dock__head' }, dockTitle, openAll),
    mini,
    el('label', { class: 'dock__row' }, el('span', { class: 'dock__lab' }, 'Open stack'), slider, sliderVal),
    el('p', { class: 'dock__hint' }, 'Click a core die to slide it out. Drag to pan, Shift-drag to orbit, scroll to zoom.'),
  )
  root.append(dock)

  /* ---- legend ------------------------------------------------------------------ */
  const legendItems: { dot: HTMLElement; key: keyof Palette }[] = []
  const legend = el('section', { class: 'legend', 'aria-label': 'Colour legend' })
  for (const item of LEGEND) {
    const dot = el('i', { class: 'legend__dot' })
    legendItems.push({ dot, key: item.key })
    legend.append(el('span', { class: 'legend__item' }, dot, item.label))
  }
  root.append(legend)


  function sync(): void {
    const night = themeMode() === 'night'
    themeBtn.textContent = night ? 'Night' : 'Day'
    labelsBtn.classList.toggle('btn--on', state.labels)
    bulkBtn.classList.toggle('btn--on', state.showBulkSilicon)
    scaleBtn.textContent = state.verticalScaleTarget > 1.01 ? `Height ${Math.round(state.verticalScaleTarget)}×` : 'True scale'
    scaleBtn.classList.toggle('btn--on', state.verticalScaleTarget <= 1.01)
    stackBtns.forEach((b, i) => {
      b.classList.toggle('mini__stack--on', i === state.focusStack)
      b.classList.toggle('mini__stack--open', state.explodeTarget[i] > 0.05)
    })
    const s = state.focusStack
    dockTitle.textContent = `HBF stack ${s}`
    slider.value = String(Math.round(state.explodeTarget[s] * 100))
    sliderVal.textContent = `${Math.round(state.explodeTarget[s] * 100)}%`
    openAll.textContent = state.explodeTarget.some((e) => e < 0.3) ? 'Open all' : 'Close all'
    for (const { dot, key } of legendItems) dot.style.background = cssHex(P[key])
  }
  sync()
  return { sync }
}
