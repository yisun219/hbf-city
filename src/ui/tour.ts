import { t, tr } from '../core/i18n'
import type { BlockView } from '../world/sim-view'
import { el } from './dom'

/* ============================================================================
 * TOUR — eight stops from the package to the wear of a single block.
 *
 * Each stop sets up the scene through TourApi (camera, selection, playback)
 * and shows two or three sentences. The reader can leave at any time; the
 * scene stays where the tour left it.
 * ==========================================================================*/

export interface TourApi {
  home(): void
  overview(): void
  focus(id: string): void
  select(id: string | null): void
  setExplode(stack: number, v: number): void
  closeAll(): void
  /** frame a part as focus does, without opening its notes, so the Live panel stays in view */
  peek(id: string): void
  setBlockView(v: BlockView): void
  setSpeed(v: number): void
  setPlaying(v: boolean): void
  /** simulate until at least this many seconds have passed */
  ensureTime(seconds: number): void
}

interface Stop {
  title: { en: string; zh: string }
  body: { en: string; zh: string }
  enter(api: TourApi): void
}

const STOPS: Stop[] = [
  {
    title: { en: 'A GPU package', zh: '一颗 GPU 封装' },
    body: {
      en: 'In the middle is a GH100-class GPU, with three High Bandwidth Flash stacks on each side; the six hold 3 TiB in all. The ground is a silicon interposer; the dark land around it is the package substrate.',
      zh: '中间是一颗 GH100 级 GPU，两侧各有三个高带宽闪存（HBF）堆叠，六个加起来 3 TiB。地面是硅中介层，外围深色的一圈是封装基板。',
    },
    enter(api) {
      api.select(null)
      api.closeAll()
      api.setExplode(3, 0.62)
      api.setBlockView('state')
      api.home()
    },
  },
  {
    title: { en: 'Sixteen dies on a base die', zh: 'base die 上叠 16 层 die' },
    body: {
      en: 'Each stack is sixteen NAND core dies on a logic base die, joined by through-silicon vias. Here one stack is pulled apart so the layers show; in reality they sit microns apart, 775 µm tall in all.',
      zh: '每个堆叠是 16 层 NAND core die 叠在一层逻辑 base die 上，用硅通孔（TSV）连起来。这里把一个堆叠拆开了好看清分层；实际上层与层只隔几微米，整个堆叠 775 µm 高。',
    },
    enter(api) {
      api.select(null)
      api.setExplode(3, 0.85)
      api.focus('stack.3')
    },
  },
  {
    title: { en: 'Inside a core die', zh: '一层 core die 里面' },
    body: {
      en: 'A core die has 32 planes in two rows around a strip of signal TSVs. Each plane holds 512 blocks of 512 pages, 4 KiB each. A read takes 4 µs, a program 75 µs, and only a whole block can be erased.',
      zh: '一层 core die 有 32 个 plane，分两排排在中间那条信号 TSV 带的两侧。每个 plane 有 512 个 block，每个 block 512 页，每页 4 KiB。读一页 4 µs，编程 75 µs，擦除只能整个 block 一起擦。',
    },
    enter(api) {
      api.focus('stack.3.die.9')
    },
  },
  {
    title: { en: 'The base die', zh: 'Base die' },
    body: {
      en: 'Under the NAND, the base die talks to the GPU over 16 UCIe channels, runs ECC, stages data in 40 MB of SRAM and counts reads per block. It does not garbage-collect: the serving software decides where every page goes.',
      zh: 'NAND 底下的 base die 通过 16 条 UCIe 通道和 GPU 通信，做 ECC，用 40 MB SRAM 暂存数据，并按 block 记读次数。它不做垃圾回收：每一页放在哪，由推理服务软件决定。',
    },
    enter(api) {
      api.focus('stack.3.sram')
    },
  },
  {
    title: { en: 'Serving an LLM', zh: '跑大模型推理' },
    body: {
      en: 'Every decode step reads the weights it needs and each request’s KV cache from flash, then writes the new tokens’ KV. Pulses on the TSVs and UCIe lanes show that traffic. Reading weights is what sets the pace here.',
      zh: '每个解码步都要从闪存读出需要的权重和每个请求的 KV 缓存，再把新 token 的 KV 写回去。TSV 和 UCIe 线上跑的光点就是这些流量。这里限制速度的是读权重。',
    },
    enter(api) {
      api.select(null)
      api.setSpeed(1)
      api.setPlaying(true)
      api.focus('package.ucie.3')
    },
  },
  {
    title: { en: 'The cache fills', zh: 'KV 缓存逐渐写满' },
    body: {
      en: 'KV piles up block by block: blue blocks hold valid KV, pink ones stale KV, light-blue ones are still being written, amber ones hold weights. Once valid KV reaches 90% of capacity, the least recently used sessions are evicted, and their blocks must be erased before they can be written again.',
      zh: 'KV 一块一块地堆起来：蓝色是有效 KV，粉色是失效 KV，浅蓝是还在写的 block，琥珀色存的是权重。有效 KV 占到容量的 90% 时，最久没用的会话被淘汰，它们的 block 要先擦除才能再写。',
    },
    enter(api) {
      // close any notes so the Live panel shows capacity filling
      api.select(null)
      api.setBlockView('state')
      api.ensureTime(4 * 3600)
      api.setSpeed(3600)
      api.setPlaying(true)
      api.overview()
    },
  },
  {
    title: { en: 'Wear', zh: '磨损' },
    body: {
      en: 'Flash wears out as it is erased. Nothing here levels wear, and in this simulation the most-erased blocks run far ahead of the average. The Live panel projects when the first would reach 100,000 cycles at the current rates; a real base die would then retire it to a spare block (OCP §4.1, §11.5). The stronger the orange, the more erases; weight blocks, never erased here, show grey.',
      zh: '闪存每擦一次就磨损一点。这里没有做磨损均衡，仿真里擦得最多的 block 远远跑在平均值前面。实时面板按当前速率推算第一个 block 什么时候到 10 万次；到那时，真实的 base die 会用备用 block 顶替它（OCP §4.1、§11.5）。橙色越浓擦得越多；权重 block 在这里从不擦除，显示为灰色。',
    },
    enter(api) {
      api.ensureTime(24 * 3600)
      api.setBlockView('wear')
      api.peek('stack.3.die.9')
    },
  },
  {
    title: { en: 'Your turn', zh: '自己试试' },
    body: {
      en: 'Use the scenario card: switch to arrival-order allocation and watch write amplification and GC copies climb, or change the model or workload. Click anything to read what it is and where each number comes from.',
      zh: '用左边的场景卡试试：换成“按到达顺序”分配，看写放大和 GC 搬运怎么涨；也可以换模型或业务。点任何东西，都能看到它是什么、每个数字从哪来。',
    },
    enter(api) {
      api.select(null)
      api.setBlockView('state')
      api.setSpeed(600)
      api.home()
    },
  },
]

export interface Tour {
  start(): void
  stop(): void
  readonly active: boolean
  /** the open stop, or -1 */
  readonly index: number
  /** show stop `k` without re-entering it: the scene is already set up (a language switch) */
  show(k: number): void
  /** handle a key while the tour is open; returns true if used */
  key(k: string): boolean
}

export function createTour(root: HTMLElement, api: TourApi): Tour {
  let i = -1
  const box = el('section', { class: 'tour', hidden: '', 'aria-live': 'polite' })
  root.append(box)

  function render(): void {
    const s = STOPS[i]
    const back = el('button', { type: 'button', class: 'btn btn--small' }, t('tour.prev'))
    back.disabled = i === 0
    back.addEventListener('click', () => go(i - 1))
    const last = i === STOPS.length - 1
    const next = el('button', { type: 'button', class: 'btn btn--small btn--accent' }, last ? t('tour.done') : t('tour.next'))
    next.addEventListener('click', () => (last ? stop() : go(i + 1)))
    const end = el('button', { type: 'button', class: 'tour__end', 'aria-label': t('tour.end'), title: t('tour.end') }, '×')
    end.addEventListener('click', () => stop())
    const dots = el('div', { class: 'tour__dots' })
    for (let k = 0; k < STOPS.length; k++) dots.append(el('i', { class: k === i ? 'on' : '' }))
    box.replaceChildren(
      el('header', { class: 'tour__head' }, el('span', { class: 'tour__step' }, t('tour.step', { i: i + 1, n: STOPS.length })), end),
      el('h3', { class: 'tour__title' }, tr(s.title)),
      el('p', { class: 'tour__body' }, tr(s.body)),
      el('footer', { class: 'tour__foot' }, dots, el('div', { class: 'tour__btns' }, back, next)),
    )
  }

  function go(k: number): void {
    if (k < 0 || k >= STOPS.length) return
    i = k
    STOPS[i].enter(api)
    render()
    box.hidden = false
  }

  function stop(): void {
    i = -1
    box.hidden = true
  }

  return {
    start() {
      go(0)
    },
    stop,
    get active() {
      return i >= 0
    },
    get index() {
      return i
    },
    show(k) {
      if (k < 0 || k >= STOPS.length) return
      i = k
      render()
      box.hidden = false
    },
    key(k) {
      if (i < 0) return false
      if (k === 'arrowright') go(i + 1)
      else if (k === 'arrowleft') go(i - 1)
      else if (k === 'escape') stop()
      else return false
      return true
    },
  }
}
