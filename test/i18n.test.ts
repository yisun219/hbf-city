import { describe, expect, it } from 'vitest'
import { STRINGS } from '../src/core/i18n'
import { POLICIES } from '../src/sim/store'
import { TRACES } from '../src/sim/workload'
import { docIn, docKeys } from '../src/ui/content'
import { SPEEDS } from '../src/ui/sim-panel'

/** Every source file as text, through Vite's glob import. */
const SOURCES = import.meta.glob('../src/**/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

describe('translations', () => {
  it('give every string both an English and a Chinese text', () => {
    for (const [key, [en, zh]] of Object.entries(STRINGS)) {
      expect(en.trim(), key).not.toBe('')
      expect(zh.trim(), key).not.toBe('')
    }
  })

  it('keep the same placeholders in both languages', () => {
    const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
    for (const [key, [en, zh]] of Object.entries(STRINGS)) expect(holes(zh), key).toEqual(holes(en))
  })

  it('define every key the code looks up', () => {
    const used = new Set<string>()
    expect(Object.keys(SOURCES).length).toBeGreaterThan(20)
    for (const text of Object.values(SOURCES)) {
      for (const m of text.matchAll(/\bt\('([\w.]+)'/g)) used.add(m[1])
    }
    // keys built from ids at run time
    for (const id of Object.keys(TRACES)) used.add(`wl.${id}.name`).add(`wl.${id}.desc`)
    for (const id of Object.keys(POLICIES)) used.add(`pol.${id}.short`).add(`pol.${id}.detail`)
    for (const v of SPEEDS) used.add(`speed.${v}`).add(`speed.${v}.title`)
    for (const k of ['phy', 'ctrl', 'sram', 'landing', 'debug']) used.add(`comp.${k}.name`).add(`comp.${k}.role`)
    for (const s of ['west', 'east']) used.add(`side.${s}`)
    for (const k of ['tpot', 'ttft', 'decode', 'reqs', 'reads', 'writes', 'gc', 'erases', 'waf', 'turn', 'wear', 'life']) {
      used.add(`tile.${k}`).add(`tile.${k}.title`)
    }
    const missing = [...used].filter((k) => !(k in STRINGS))
    expect(missing).toEqual([])
  })
})

describe('inspector notes', () => {
  it('cover the same components in both languages', () => {
    expect(docKeys('zh').sort()).toEqual(docKeys('en').sort())
  })

  it('have the same facts, sections, caveats and sources in both languages', () => {
    for (const key of docKeys('en')) {
      const en = docIn('en', key)!
      const zh = docIn('zh', key)!
      expect(zh.facts?.length ?? 0, key).toBe(en.facts?.length ?? 0)
      expect(zh.sections.length, key).toBe(en.sections.length)
      expect(zh.caveats?.length ?? 0, key).toBe(en.caveats?.length ?? 0)
      expect(zh.sources.map((s) => s.key), key).toEqual(en.sources.map((s) => s.key))
      // numbers must agree: a translated fact may not change a value's digits
      for (let i = 0; i < (en.facts?.length ?? 0); i++) {
        const digits = (s: string) => s.replace(/[^\d.]/g, '')
        expect(digits(zh.facts![i].value), `${key} fact ${i}`).toBe(digits(en.facts![i].value))
      }
    }
  })
})
