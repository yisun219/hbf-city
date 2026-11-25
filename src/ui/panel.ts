import { SOURCES } from '../core/hbf-spec'
import type { SourceKey } from '../core/hbf-spec'
import type { Registry } from '../core/registry'
import { cssHex } from '../core/theme'
import type { Bus, ComponentDef } from '../core/types'
import { docFor } from './content'
import { el } from './dom'

/* ============================================================================
 * INSPECTOR — the written explanation of whatever is selected.
 *
 * Every fact row carries its source; caveats are rendered as a visible list,
 * never collapsed away, because a simplification the reader cannot see is a
 * claim the city did not earn.
 * ==========================================================================*/

export interface Inspector {
  show(id: string | null): void
  /** extra live rows supplied by main (e.g. illustrative block counts) */
  setExtra(render: ((def: ComponentDef) => HTMLElement | null) | null): void
}

function md(text: string): DocumentFragment {
  // tiny subset: **bold** and `code`
  const frag = document.createDocumentFragment()
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g
  let last = 0
  for (const m of text.matchAll(re)) {
    if (m.index! > last) frag.append(text.slice(last, m.index))
    const tok = m[0]
    if (tok.startsWith('**')) frag.append(el('strong', {}, tok.slice(2, -2)))
    else frag.append(el('code', {}, tok.slice(1, -1)))
    last = m.index! + tok.length
  }
  if (last < text.length) frag.append(text.slice(last))
  return frag
}

export function createInspector(root: HTMLElement, registry: Registry, bus: Bus): Inspector {
  const panel = el('aside', { class: 'inspector', 'aria-live': 'polite', hidden: '' })
  root.append(panel)
  let extra: ((def: ComponentDef) => HTMLElement | null) | null = null
  let current: string | null = null

  function render(def: ComponentDef): void {
    const doc = docFor(def.doc)
    panel.replaceChildren()
    const close = el('button', { class: 'inspector__close', type: 'button', 'aria-label': 'Close' }, '×')
    close.addEventListener('click', () => bus.emit('select', { id: null }))
    const dot = el('span', { class: 'inspector__dot' })
    if (def.color !== undefined) dot.style.background = cssHex(def.color)
    panel.append(
      el('header', { class: 'inspector__head' },
        dot,
        el('div', { class: 'inspector__titles' },
          el('h2', {}, def.name),
          el('p', { class: 'inspector__role' }, def.role),
        ),
        close,
      ),
    )
    if (!doc) return
    const body = el('div', { class: 'inspector__body' })
    panel.append(body)
    body.append(el('p', { class: 'inspector__tldr' }, md(doc.tldr)))

    const x = extra?.(def)
    if (x) body.append(x)

    if (doc.facts?.length) {
      const table = el('dl', { class: 'facts' })
      for (const f of doc.facts) {
        table.append(
          el('div', { class: 'facts__row' },
            el('dt', {}, f.label),
            el('dd', {}, el('span', { class: 'facts__value' }, f.value), el('span', { class: 'facts__src' }, f.source)),
          ),
        )
      }
      body.append(table)
    }
    for (const s of doc.sections) {
      body.append(el('section', { class: 'inspector__section' }, el('h3', {}, s.heading), el('p', {}, md(s.body))))
    }
    if (doc.caveats?.length) {
      const list = el('ul', {})
      for (const c of doc.caveats) list.append(el('li', {}, md(c)))
      body.append(el('section', { class: 'inspector__caveats' }, el('h3', {}, 'Simplified here'), list))
    }
    if (doc.sources.length) {
      const list = el('ul', {})
      for (const s of doc.sources) {
        const ref = SOURCES[s.key as SourceKey]
        const name = ref?.url
          ? el('a', { href: ref.url, target: '_blank', rel: 'noopener' }, ref.label)
          : el('span', {}, ref?.label ?? s.key)
        list.append(el('li', {}, name, el('span', { class: 'inspector__where' }, ` — ${s.where}`)))
      }
      body.append(el('section', { class: 'inspector__sources' }, el('h3', {}, 'Sources'), list))
    }
  }

  return {
    show(id) {
      current = id
      const def = id ? registry.get(id) : undefined
      if (!def) {
        panel.hidden = true
        return
      }
      render(def)
      panel.hidden = false
    },
    setExtra(fn) {
      extra = fn
      if (current) this.show(current)
    },
  }
}
