import { HBF } from '../core/hbf-spec'
import { t } from '../core/i18n'
import { themeMode } from '../core/theme'
import type { Bus, SceneState } from '../core/types'
import { STACK_SITES } from '../world/layout'
import { trustNotes } from './content'
import { card, el } from './dom'

/* ============================================================================
 * HUD — brand, toolbar, the two side columns and toasts.
 *
 * Layout: brand top-left, toolbar top-right, a left column (explore, then the
 * serving scenario) and a right column (live metrics and the legend), and
 * only the playback bar along the bottom. Columns scroll on short screens and
 * their cards fold, so the scene keeps the middle.
 *
 * The HUD is rebuilt when the language changes; everything it shows comes
 * from SceneState, so a rebuild loses nothing. Nothing here touches three.js.
 * ==========================================================================*/

export interface HudActions {
  home(): void
  overview(): void
  toggleTheme(): void
  toggleLabels(): void
  toggleBulk(): void
  toggleScale(): void
  toggleLang(): void
  focusStack(s: number): void
  tour(): void
}

export interface Hud {
  sync(): void
  /** column containers other panels add their cards to */
  leftCol: HTMLElement
  rightCol: HTMLElement
  bottom: HTMLElement
  setRightVisible(v: boolean): void
  dispose(): void
}

function button(label: string, title: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = el('button', { type: 'button', class: `btn ${cls}`.trim(), title }, label)
  b.addEventListener('click', (e) => {
    e.stopPropagation()
    onClick()
  })
  return b
}

export function createHud(root: HTMLElement, state: SceneState, bus: Bus, act: HudActions): Hud {
  const nodes: HTMLElement[] = []
  const put = (n: HTMLElement) => {
    root.append(n)
    nodes.push(n)
    return n
  }

  /* ---- brand ------------------------------------------------------------- */
  const trust = el('div', { class: 'sheet', hidden: '' })
  const trustList = el('ul', {})
  for (const line of trustNotes()) trustList.append(el('li', {}, line))
  const closeTrust = el('button', { type: 'button', class: 'sheet__close', 'aria-label': t('common.close') }, '×')
  closeTrust.addEventListener('click', () => (trust.hidden = true))
  const repo = el('a', { href: 'https://github.com/yisun219/hbf-city', target: '_blank', rel: 'noopener' }, t('trust.repo'))
  trust.append(el('div', { class: 'sheet__head' }, el('h3', {}, t('trust.title')), closeTrust), trustList, el('p', { class: 'sheet__foot' }, repo))
  const trustBtn = el('button', { type: 'button', class: 'chip chip--honest' }, t('brand.trust'))
  trustBtn.addEventListener('click', () => {
    trust.hidden = !trust.hidden
  })
  put(
    el('div', { class: 'brand' },
      el('div', { class: 'brand__mark', 'aria-hidden': 'true' }, el('i'), el('i'), el('i'), el('i')),
      el('div', { class: 'brand__text' },
        el('h1', { class: 'brand__title' }, 'HBFCity'),
        el('p', { class: 'brand__sub' }, t('brand.sub')),
        trustBtn,
      ),
    ),
  )
  put(trust)

  /* ---- toolbar ------------------------------------------------------------- */
  const themeOpt = (night: boolean, icon: string, label: string) => {
    const b = el('button', { type: 'button', class: 'seg__b', title: t('tb.theme.title') }, el('span', { class: 'seg__icon', 'aria-hidden': 'true' }, icon), label)
    b.addEventListener('click', () => {
      if ((themeMode() === 'night') !== night) act.toggleTheme()
    })
    return b
  }
  const lightBtn = themeOpt(false, '☀', t('tb.light'))
  const darkBtn = themeOpt(true, '☾', t('tb.dark'))
  const themeSeg = el('div', { class: 'seg seg--bar', role: 'group', 'aria-label': t('tb.theme.aria') }, lightBtn, darkBtn)
  const labelsBtn = button(t('tb.labels'), t('tb.labels.title'), act.toggleLabels)
  const bulkBtn = button(t('tb.silicon'), t('tb.silicon.title'), act.toggleBulk)
  const scaleBtn = button('', t('tb.scale.title'), act.toggleScale)
  put(
    el('nav', { class: 'toolbar', 'aria-label': t('tb.aria') },
      button(t('tb.tour'), t('tb.tour.title'), act.tour, 'btn--accent'),
      themeSeg,
      labelsBtn,
      bulkBtn,
      scaleBtn,
      button(t('tb.overview'), t('tb.overview.title'), act.overview),
      button(t('tb.home'), t('tb.home.title'), act.home),
      button(t('tb.lang'), t('tb.lang.title'), act.toggleLang, 'btn--lang'),
    ),
  )

  /* ---- columns ----------------------------------------------------------------- */
  const leftCol = put(el('div', { class: 'col col--left' }))
  const rightCol = put(el('div', { class: 'col col--right' }))
  const bottom = put(el('div', { class: 'bottom' }))

  /* ---- explore card ------------------------------------------------------------ */
  const explore = card('explore', t('explore.title'))
  const stackBtns: HTMLButtonElement[] = []
  const west = el('div', { class: 'mini__col' })
  const east = el('div', { class: 'mini__col' })
  for (const site of STACK_SITES) {
    const b = button(`${site.index}`, t('explore.stack.title', { s: site.index, k: site.index + 1 }), () => act.focusStack(site.index), 'mini__stack')
    stackBtns.push(b)
    ;(site.side === 'west' ? west : east).append(b)
  }
  const mini = el('div', { class: 'mini' }, west, el('div', { class: 'mini__gpu' }, 'GPU'), east)
  const slider = el('input', { type: 'range', min: '0', max: '100', step: '1', class: 'slider' }) as HTMLInputElement
  slider.addEventListener('input', () => {
    state.explodeTarget[state.focusStack] = Number(slider.value) / 100
    bus.emit('scene:changed', {})
  })
  const sliderVal = el('span', { class: 'row__val' })
  const openLab = el('span', { class: 'row__lab' })
  const openAll = button(t('explore.openAll'), t('explore.openAll.title'), () => {
    const anyClosed = state.explodeTarget.some((e) => e < 0.3)
    for (let s = 0; s < HBF.stacksPerGpu; s++) state.explodeTarget[s] = anyClosed ? 0.65 : 0
    bus.emit('scene:changed', {})
    sync()
  }, 'btn--small')
  explore.tools.append(openAll)
  explore.body.append(mini, el('label', { class: 'row' }, openLab, slider, sliderVal), el('p', { class: 'note' }, t('explore.note')))
  leftCol.append(explore.root)

  /* ---- toasts -------------------------------------------------------------------- */
  const toasts = put(el('div', { class: 'toasts', 'aria-live': 'polite' }))
  const offToast = bus.on('toast', ({ text, kind, ms }) => {
    const n = el('div', { class: `toast toast--${kind ?? 'info'}` }, text)
    toasts.append(n)
    window.setTimeout(() => n.classList.add('toast--out'), ms ?? 2200)
    window.setTimeout(() => n.remove(), (ms ?? 2200) + 400)
  })

  function sync(): void {
    const night = themeMode() === 'night'
    lightBtn.classList.toggle('seg__b--on', !night)
    darkBtn.classList.toggle('seg__b--on', night)
    lightBtn.setAttribute('aria-pressed', String(!night))
    darkBtn.setAttribute('aria-pressed', String(night))
    labelsBtn.classList.toggle('btn--on', state.labels)
    bulkBtn.classList.toggle('btn--on', state.showBulkSilicon)
    scaleBtn.textContent = state.verticalScaleTarget > 1.01 ? t('tb.height', { x: Math.round(state.verticalScaleTarget) }) : t('tb.trueScale')
    scaleBtn.classList.toggle('btn--on', state.verticalScaleTarget <= 1.01)
    stackBtns.forEach((b, i) => {
      b.classList.toggle('mini__stack--on', i === state.focusStack)
      b.classList.toggle('mini__stack--open', state.explodeTarget[i] > 0.05)
    })
    const s = state.focusStack
    openLab.textContent = t('explore.open', { s })
    slider.setAttribute('aria-label', t('explore.open', { s }))
    slider.value = String(Math.round(state.explodeTarget[s] * 100))
    sliderVal.textContent = `${Math.round(state.explodeTarget[s] * 100)}%`
    openAll.textContent = state.explodeTarget.some((e) => e < 0.3) ? t('explore.openAll') : t('explore.closeAll')
  }
  sync()
  return {
    sync,
    leftCol,
    rightCol,
    bottom,
    setRightVisible(v) {
      rightCol.hidden = !v
    },
    dispose() {
      offToast()
      for (const n of nodes) n.remove()
    },
  }
}
