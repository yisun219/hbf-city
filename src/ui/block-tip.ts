import { HBF } from '../core/hbf-spec'
import { lang, t } from '../core/i18n'
import { el } from './dom'

/* ============================================================================
 * BLOCK TIP — what one NAND block under the cursor holds.
 *
 * Shown while the pointer is over the block array of a core die and the
 * camera is close enough for blocks to matter. The simulator manages a block
 * index on all 32 planes of a die (or of every die in an interleave domain)
 * as one superblock, so the state, the page counts and the erase count are
 * the superblock's, and the same for every plane of it.
 * ==========================================================================*/

export interface BlockInfo {
  stack: number
  die: number
  plane: number
  block: number
  state: 'weights' | 'free' | 'open' | 'closed'
  /** pages programmed in this block, 0..512 */
  written: number
  /** of those, pages still holding live KV */
  valid: number
  erases: number
  /** dies that share the superblock: the interleave width */
  width: number
}

export interface BlockTip {
  show(x: number, y: number, info: BlockInfo): void
  hide(): void
}

export function createBlockTip(root: HTMLElement): BlockTip {
  const where = el('div', { class: 'blocktip__where' })
  const what = el('div', { class: 'blocktip__what' })
  const wear = el('div', { class: 'blocktip__wear' })
  const unit = el('div', { class: 'blocktip__unit' })
  const node = el('div', { class: 'blocktip', role: 'tooltip', hidden: '' }, where, what, wear, unit)
  root.append(node)
  let key = ''

  return {
    show(x, y, b) {
      const k = `${lang()}|${b.stack}.${b.die}.${b.plane}.${b.block}|${b.state}.${b.written}.${b.valid}.${b.erases}.${b.width}`
      if (k !== key) {
        key = k
        where.textContent = t('tip.where', { s: b.stack, d: b.die, p: b.plane, b: b.block })
        what.textContent =
          b.state === 'weights'
            ? t('tip.weights')
            : b.state === 'free'
              ? t('tip.free')
              : b.state === 'open'
                ? t('tip.open', { w: b.written, n: HBF.pagesPerBlock })
                : t('tip.closed', { v: b.valid, w: b.written })
        what.dataset.state = b.state
        wear.textContent = b.state === 'weights' ? t('tip.never') : t('tip.erases', { n: b.erases, k: HBF.peCycles / 1000 })
        unit.textContent = b.width === 1 ? t('tip.unit1', { b: b.block }) : t('tip.unitN', { b: b.block, w: b.width })
      }
      node.hidden = false
      // beside the cursor, flipped to stay on screen
      const pad = 16
      const w = node.offsetWidth
      const h = node.offsetHeight
      const left = x + pad + w > window.innerWidth ? x - pad - w : x + pad
      const top = y + pad + h > window.innerHeight ? y - pad - h : y + pad
      node.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`
    },
    hide() {
      node.hidden = true
    },
  }
}
