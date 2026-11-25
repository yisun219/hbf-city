/** Minimal element builder: attributes, then children (strings or nodes). */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v
    else node.setAttribute(k, v)
  }
  for (const c of children) {
    if (c === null || c === undefined) continue
    node.append(c)
  }
  return node
}

export interface Card {
  root: HTMLElement
  body: HTMLElement
  /** extra controls placed on the right of the header */
  tools: HTMLElement
  setCollapsed(v: boolean, remember?: boolean): void
}

/**
 * A titled card whose body folds away. The choice is remembered per card;
 * on a narrow screen cards start folded so the scene stays visible.
 */
export function card(key: string, title: string, cls = ''): Card {
  const storageKey = `hbfcity.card.${key}`
  const chevron = el('span', { class: 'card__chev', 'aria-hidden': 'true' })
  const toggle = el('button', { type: 'button', class: 'card__toggle', 'aria-expanded': 'true' }, chevron, el('span', { class: 'card__title' }, title))
  const tools = el('div', { class: 'card__tools' })
  const body = el('div', { class: 'card__body' })
  const root = el('section', { class: `card ${cls}`.trim(), 'aria-label': title }, el('header', { class: 'card__head' }, toggle, tools), body)

  function setCollapsed(v: boolean, remember = false): void {
    root.classList.toggle('card--folded', v)
    body.hidden = v
    toggle.setAttribute('aria-expanded', String(!v))
    if (!remember) return
    try {
      localStorage.setItem(storageKey, v ? '1' : '0')
    } catch {
      /* private mode: the choice does not persist */
    }
  }
  // only the reader's own clicks are remembered, never a screen-size default
  toggle.addEventListener('click', () => setCollapsed(!body.hidden, true))

  let stored: string | null = null
  try {
    stored = localStorage.getItem(storageKey)
  } catch {
    stored = null
  }
  const narrow = typeof window !== 'undefined' && window.innerWidth < 1180
  setCollapsed(stored === null ? narrow : stored === '1')
  return { root, body, tools, setCollapsed }
}
