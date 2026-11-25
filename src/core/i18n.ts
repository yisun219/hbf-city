/* ============================================================================
 * I18N — English and 简体中文.
 *
 * Every string the reader sees goes through `t(key, vars)`. Technical terms
 * that Chinese hardware papers keep in English (die, plane, block, page, KV,
 * TSV, UCIe, PHY, SRAM, GC, WAF, P/E, TTFT, TPOT) stay in English inside the
 * Chinese text. Placeholders are written {name}.
 *
 * The choice is remembered; without one, the browser language decides.
 * ==========================================================================*/

export type Lang = 'en' | 'zh'

const STORAGE_KEY = 'hbfcity.lang'

function initialLang(): Lang {
  try {
    const q = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('lang') : null
    if (q === 'zh' || q === 'en') return q
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
    if (v === 'zh' || v === 'en') return v
  } catch {
    /* fall through */
  }
  const nav = typeof navigator !== 'undefined' ? navigator.language || '' : ''
  return nav.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

let current: Lang = initialLang()
const listeners = new Set<(l: Lang) => void>()

export function lang(): Lang {
  return current
}

export function setLang(l: Lang): void {
  if (l === current) return
  current = l
  try {
    localStorage.setItem(STORAGE_KEY, l)
  } catch {
    /* private mode */
  }
  if (typeof document !== 'undefined') document.documentElement.lang = l === 'zh' ? 'zh-CN' : 'en'
  for (const fn of listeners) fn(l)
}

export function onLang(fn: (l: Lang) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Pick the string for the current language from an inline pair. */
export function tr(pair: { en: string; zh: string }): string {
  return pair[current]
}

type Vars = Record<string, string | number>

function fill(s: string, vars?: Vars): string {
  if (!vars) return s
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m))
}

export function t(key: string, vars?: Vars): string {
  const e = STRINGS[key]
  if (!e) return key
  return fill(current === 'zh' ? e[1] : e[0], vars)
}

/** [English, 中文] */
export const STRINGS: Record<string, [string, string]> = {
  /* ---- boot ---- */
  'boot.renderer': ['Renderer', '渲染器'],
  'boot.camera': ['Camera', '相机'],
  'boot.sky': ['Sky', '天空'],
  'boot.package': ['Package and interposer', '封装与中介层'],
  'boot.gpu': ['GPU die', 'GPU 芯片'],
  'boot.atlas': ['NAND block atlas (1.57 M blocks)', 'NAND block 图集（157 万个 block）'],
  'boot.stacks': ['HBF stacks', 'HBF 堆叠'],
  'boot.sim': ['Serving simulator', '推理服务仿真'],
  'boot.skip': ['Simulating {h} h of serving', '正在仿真 {h} 小时的推理服务'],
  'boot.labels': ['Labels', '标签'],
  'boot.ready': ['Ready', '就绪'],
  'boot.noWebgl': ['This browser has no WebGL2. Try a recent Chrome, Edge, Firefox or Safari.', '这个浏览器不支持 WebGL2，请换用较新的 Chrome、Edge、Firefox 或 Safari。'],
  'boot.failed': ['Failed to start: {msg}', '启动失败：{msg}'],
  'doc.title': ['HBFCity — a GPU package with High Bandwidth Flash', 'HBFCity — 带高带宽闪存（HBF）的 GPU 封装'],

  /* ---- brand and toolbar ---- */
  'brand.sub': ['A GPU package with High Bandwidth Flash, serving LLMs', '带 HBF 的 GPU 封装，正在跑大模型推理'],
  'brand.trust': ['A model · how much to trust it', '这是模型 · 可信程度'],
  'trust.title': ['How much to trust this', '可信程度说明'],
  'tip.where': ['Stack {s} · die {d} · plane {p} · block {b}', '堆叠 {s} · die {d} · plane {p} · block {b}'],
  'tip.weights': ['Model weights, written at load', '模型权重，加载时写入'],
  'tip.free': ['Free: erased, ready to program', '空闲：已擦除，可以编程'],
  'tip.open': ['Being written: {w} of {n} pages programmed', '正在写：{n} 页里已编程 {w} 页'],
  'tip.closed': ['KV cache: {v} of {w} written pages still valid', 'KV 缓存：已写的 {w} 页里还有 {v} 页有效'],
  'tip.erases': ['Erased {n} times (rated for {k}k)', '已擦除 {n} 次（额定 {k}k 次）'],
  'tip.never': ['Not erased in this simulation (no refresh modelled)', '仿真中不擦除（未建模数据刷新）'],
  'tip.unit1': ['Block {b} on all 32 planes of this die is written and erased as one unit', '这层 die 32 个 plane 上的 block {b} 作为一个整体写入和擦除'],
  'tip.unitN': ['Block {b} on all 32 planes of {w} dies is written and erased as one unit', '{w} 层 die、各 32 个 plane 上的 block {b} 作为一个整体写入和擦除'],
  'trust.repo': ['Code, sources and method on GitHub →', '代码、资料来源和方法见 GitHub →'],
  'tb.tour': ['Tour', '导览'],
  'tb.tour.title': ['A guided tour in eight stops (T)', '分八站的导览（T）'],
  'tb.light': ['Light', '浅色'],
  'tb.dark': ['Dark', '深色'],
  'tb.theme.title': ['Light or dark mode (N)', '浅色或深色模式（N）'],
  'tb.theme.aria': ['Colour mode', '配色模式'],
  'tb.labels': ['Labels', '标签'],
  'tb.labels.title': ['Show labels (L)', '显示标签（L）'],
  'tb.silicon': ['Silicon', '硅体'],
  'tb.silicon.title': ['Show the GPU’s bulk silicon (B)', '显示 GPU 的体硅（B）'],
  'tb.height': ['Height {x}×', '高度 ×{x}'],
  'tb.trueScale': ['True scale', '真实比例'],
  'tb.scale.title': ['Vertical exaggeration (V)', '竖直放大（V）'],
  'tb.overview': ['Overview', '俯视'],
  'tb.overview.title': ['Top-down plan (O)', '从正上方看（O）'],
  'tb.home': ['Home', '初始视角'],
  'tb.home.title': ['Back to the establishing shot (H)', '回到初始视角（H）'],
  'tb.lang': ['中文', 'EN'],
  'tb.lang.title': ['切换到中文', 'Switch to English'],
  'common.close': ['Close', '关闭'],

  /* ---- explore ---- */
  'explore.title': ['Explore the stacks', '拆开看堆叠'],
  'explore.stack.title': ['HBF stack {s} (key {k})', 'HBF 堆叠 {s}（按键 {k}）'],
  'explore.open': ['Open stack {s}', '拆开堆叠 {s}'],
  'explore.openAll': ['Open all', '全部拆开'],
  'explore.closeAll': ['Close all', '全部合上'],
  'explore.openAll.title': ['Open or close every stack (A)', '拆开或合上全部堆叠（A）'],
  'explore.note': [
    'Click a core die to slide it out of its stack, or a base-die block to lift the dies off it. Up close, hover over a die to read the block under the cursor. Drag to pan, Shift-drag to orbit, scroll to zoom.',
    '点一层 core die，它会从堆叠里滑出来；点 base die 上的模块，上面的 die 会整体抬起。凑近后把鼠标停在 die 上，可以看到光标下那个 block 的详情。拖动平移，Shift 加拖动旋转，滚轮缩放。',
  ],

  /* ---- playback ---- */
  'play.title': ['Play / pause (Space)', '播放 / 暂停（空格）'],
  'play.play': ['Play', '播放'],
  'play.pause': ['Pause', '暂停'],
  'speed.1': ['1×', '1×'],
  'speed.1.title': ['Real time: one simulated second per second', '真实速度：每秒仿真 1 秒'],
  'speed.60': ['1 min/s', '1 分钟/秒'],
  'speed.60.title': ['One simulated minute per second', '每秒仿真 1 分钟'],
  'speed.600': ['10 min/s', '10 分钟/秒'],
  'speed.600.title': ['Ten simulated minutes per second', '每秒仿真 10 分钟'],
  'speed.3600': ['1 h/s', '1 小时/秒'],
  'speed.3600.title': ['One simulated hour per second', '每秒仿真 1 小时'],
  'speed.21600': ['6 h/s', '6 小时/秒'],
  'speed.21600.title': ['Six simulated hours per second, as fast as the CPU allows', '每秒仿真 6 小时，受 CPU 速度限制'],
  'clock.title': ['Simulated time since the KV cache was empty', '从 KV 缓存为空起的仿真时间'],
  'rate.cpu': ['CPU-limited · {x}×', 'CPU 跟不上 · 实际 {x}×'],
  'rate.paused': ['paused', '已暂停'],

  /* ---- scenario ---- */
  'sc.title': ['Scenario', '推理场景'],
  'sc.skip': ['+6 h', '+6 小时'],
  'sc.skip.title': ['Simulate six hours at once', '一次仿真 6 小时'],
  'sc.restart': ['Restart', '重新开始'],
  'sc.restart.title': ['Restart from an empty KV cache', '清空 KV 缓存，从头开始'],
  'f.model': ['Model', '模型'],
  'f.workload': ['Workload', '业务'],
  'f.blocks': ['Allocation', '分配策略'],
  'f.interleave': ['Interleave', '交织'],
  'f.load': ['Load', '流量'],
  'width.one': ['1 die per session', '每会话 1 个 die'],
  'width.n': ['{n} dies per session', '每会话 {n} 个 die'],
  'load.note': [
    '{p}% of the trace’s traffic, {r} requests/s: about what one GPU sustains.',
    '取 trace 流量的 {p}%，每秒 {r} 个请求，大致是一张 GPU 撑得住的量。',
  ],
  'load.noteX': [
    '{p}% of the trace’s traffic, {r} requests/s: {x}× what one GPU sustains.',
    '取 trace 流量的 {p}%，每秒 {r} 个请求，是一张 GPU 撑得住的量的 {x} 倍。',
  ],
  'wl.toC.name': ['To-C chat', 'To-C 聊天'],
  'wl.toC.desc': ['Consumer chat, multi-turn.', '面向个人用户的聊天，多轮对话。'],
  'wl.toB.name': ['To-B API', 'To-B API'],
  'wl.toB.desc': ['Business API calls, single turn.', '面向企业的 API 调用，单轮。'],
  'wl.coding.name': ['Coding', '编程'],
  'wl.coding.desc': ['Coding assistant, long prompts.', '编程助手，提示很长。'],
  'wl.thinking.name': ['Thinking', '思考模式'],
  'wl.thinking.desc': ['Reasoning turned on, long outputs.', '开启深度思考的请求，输出很长。'],
  'pol.arrival.short': ['Arrival order', '按到达顺序'],
  'pol.arrival.detail': [
    'Requests share blocks in arrival order. Evicting a request reclaims every block it touched at once, copying other requests’ valid pages out first. A stand-in for the baseline HBFlex compares against, which the paper does not define.',
    '各请求按到达顺序混写在同一批 block 里。淘汰一个请求时，立刻回收它碰过的每个 block，先把别的请求的有效页搬走。用来近似 HBFlex 所比较的基线（论文没有给出它的定义）。',
  ],
  'pol.hbflex.short': ['HBFlex packing', 'HBFlex 打包'],
  'pol.hbflex.detail': [
    'Sessions whose first request arrived in the same 10-minute window share blocks: HBFlex labels blocks by root-request start time; the window length is this simulator’s choice. Eviction only invalidates pages; a domain reclaims once 95% of its blocks are written (HBFlex §5.4).',
    '首个请求落在同一个 10 分钟窗口里的会话共用 block：HBFlex 按根请求的开始时间给 block 打标签，窗口长度是本仿真自己定的。淘汰只把页标成失效，一个交织域写满 95% 时才回收（HBFlex §5.4）。',
  ],

  /* ---- metrics ---- */
  'mc.title': ['Live', '实时指标'],
  'seg.aria': ['Block colours show', 'block 颜色表示'],
  'seg.state': ['State', '状态'],
  'seg.wear': ['Wear', '磨损'],
  'sec.serving': ['Serving', '服务'],
  'sec.traffic': ['HBF traffic', 'HBF 流量'],
  'sec.capacity': ['KV capacity', 'KV 容量'],
  'sec.endurance': ['Endurance', '寿命'],
  'tile.tpot': ['TPOT', 'TPOT'],
  'tile.tpot.title': ['Time per output token: one decode iteration', '每个输出 token 的时间，即一次解码迭代'],
  'tile.ttft': ['TTFT', 'TTFT'],
  'tile.ttft.title': ['Time to first token, including queueing', '首个 token 的时间，含排队'],
  'tile.decode': ['Decode', '解码'],
  'tile.decode.title': ['Output tokens generated per second', '每秒生成的输出 token'],
  'tile.reqs': ['Requests', '请求'],
  'tile.reqs.title': ['Requests completed per second', '每秒完成的请求'],
  'tile.reads': ['Reads', '读'],
  'tile.reads.title': ['Bytes sensed from NAND per second: weights and KV', '每秒从 NAND 读出的字节，含权重和 KV'],
  'tile.writes': ['KV writes', 'KV 写'],
  'tile.writes.title': ['New KV bytes per second, before stripe padding; below it, KV staged in base-die SRAM (red when it exceeds the SRAM, which the simulator does not stall for)', '每秒新写入的 KV 字节（不含条带填充）；下方是暂存在 base die SRAM 里的 KV（超出 SRAM 容量时变红，仿真不会因此停顿）'],
  'tile.gc': ['GC copies', 'GC 搬运'],
  'tile.gc.title': ['Valid pages copied out before erases, per second, averaged over about 5 simulated minutes', '擦除前搬走的有效页，每秒，按约 5 分钟仿真时间平均'],
  'tile.erases': ['Erases', '擦除'],
  'tile.erases.title': ['Block rows erased per second, averaged over about 5 simulated minutes; a block row is one block on all 32 planes of a die', '每秒擦除的 block 行数，按约 5 分钟仿真时间平均；一个 block 行是一层 die 上 32 个 plane 的同号 block'],
  'tile.waf': ['Write amp.', '写放大'],
  'tile.waf.title': ['Physical bytes programmed per KV byte, including padding', '每写入 1 字节 KV 实际编程的字节，含页尾填充'],
  'tile.turn': ['Turnovers', '容量周转'],
  'tile.turn.title': ['Times the KV capacity has been written', 'KV 容量被写满的次数'],
  'tile.wear': ['Erases/block', '每块擦除'],
  'tile.wear.title': ['Most-erased KV block, and the mean', '擦除最多的 KV block，以及平均值'],
  'tile.life': ['First wear-out', '首块失效'],
  'tile.life.title': ['When the most-erased block would reach its P/E limit, at the rate the highest erase count has grown since the KV cache was written over twice; shown 2 simulated hours after that', '按 KV 缓存被写满两遍之后最大擦除次数的增长速度，推算擦除最多的 block 到达 P/E 上限的时间；从那之后 2 小时仿真时间才开始显示'],
  'sub.batch': ['batch {n}', 'batch {n}'],
  'sub.queue': ['queue {n}', '排队 {n}'],
  'sub.noQueue': ['no queue', '无排队'],
  'sub.prefill': ['prefill {n}/s', 'prefill {n}/s'],
  'sub.dropped': ['{n} turned away', '拒绝 {n} 个'],
  'sub.reads': ['weights + KV', '权重 + KV'],
  'sub.sram': ['SRAM {a} / {b} MB', 'SRAM {a} / {b} MB'],
  'sub.rows': ['block rows', 'block 行'],
  'sub.waf': ['GC + padding', 'GC + 填充'],
  'sub.turn': ['KV capacity written', '写满 KV 容量的次数'],
  'sub.mean': ['mean {x}', '平均 {x}'],
  'sub.life': ['at {k}k P/E', '按 {k}k P/E 算'],
  'sub.lifeNone': ['no erases yet', '还没有擦除'],
  'sub.lifeWait': ['after the cache settles', '等缓存进入稳态'],
  'sub.lifeIdle': ['no recent erases', '最近没有擦除'],
  'unit.max': ['max', '最多'],
  'unit.years': ['years', '年'],
  'unit.days': ['days', '天'],
  'unit.hours': ['hours', '小时'],
  'cap.line': ['{v}% valid · {i}% awaiting erase · {f}% free', '有效 {v}% · 待擦除 {i}% · 空闲 {f}%'],
  'legend.blocks': ['Blocks', 'Block'],
  'legend.structure': ['Structure', '结构'],
  'legend.weights': ['Weights', '权重'],
  'legend.valid': ['Valid KV', '有效 KV'],
  'legend.invalid': ['Invalid KV', '失效 KV'],
  'legend.writing': ['Being written', '正在写'],
  'legend.free': ['Free', '空闲'],
  'legend.compute': ['Compute', '计算'],
  'legend.sram': ['SRAM', 'SRAM'],
  'legend.ucie': ['UCIe link', 'UCIe 链路'],
  'legend.tsv': ['Signal TSV', '信号 TSV'],
  'legend.wearTitle': ['Erases per block (log scale)', '每块擦除次数（对数刻度）'],
  'legend.wearNote': ['Weight blocks are not erased in this simulation (refresh is not modelled) and are shown grey.', '仿真不含数据刷新，权重 block 不会被擦除，显示为灰色。'],
  'mc.note': ['Simulated, not measured. Rates are per simulated second.', '仿真结果，不是实测。速率按仿真时间计。'],

  /* ---- inspector ---- */
  'insp.simplified': ['Simplified here', '这里做了简化'],
  'insp.sources': ['Sources', '出处'],
  'insp.focus': ['Focus', '对准'],
  'occ.pages.die': ['Pages on this die', '这层 die 上的页'],
  'occ.pages.dieN': ['Pages on this die and the {n} it is interleaved with', '这层 die 及与它交织的 {n} 层上的页'],
  'occ.pages.stack': ['Pages on this stack', '这个堆叠上的页'],
  'occ.weights': ['Weights', '权重'],
  'occ.valid': ['Valid KV', '有效 KV'],
  'occ.invalid': ['Awaiting erase', '待擦除'],
  'occ.free': ['Free', '空闲'],
  'occ.sub': ['{open} open block rows · erases per block: mean {mean}, max {max}', '{open} 个 block 行在写 · 每块擦除：平均 {mean}，最多 {max}'],
  'occ.note': ['Simulated: {model}, {workload}, {policy}.', '仿真条件：{model}，{workload}，{policy}。'],
  'toast.skipped': ['Simulated {h} hours', '已仿真 {h} 小时'],

  /* ---- components ---- */
  'side.west': ['west', '西侧'],
  'side.east': ['east', '东侧'],
  'comp.stack.name': ['HBF stack {s}', 'HBF 堆叠 {s}'],
  'comp.stack.role': ['{side} side · 16 core dies on a base die', '{side} · base die 上叠 16 层 core die'],
  'comp.base.name': ['Base die', 'Base die'],
  'comp.base.role': ['stack {s} · logic die on the interposer', '堆叠 {s} · 中介层上的逻辑 die'],
  'comp.phy.name': ['UCIe PHY (16 modules)', 'UCIe PHY（16 个模块）'],
  'comp.phy.role': ['stack {s} · one x64 module per host channel', '堆叠 {s} · 每个主机通道一个 x64 模块'],
  'comp.ctrl.name': ['Channel controllers', '通道控制器'],
  'comp.ctrl.role': ['stack {s} · scheduling, ECC, write accumulation', '堆叠 {s} · 调度、ECC、写入攒页'],
  'comp.sram.name': ['Base-die SRAM', 'Base die SRAM'],
  'comp.sram.role': ['stack {s} · 40 MB staging and scratchpad', '堆叠 {s} · 40 MB 暂存与 scratchpad'],
  'comp.landing.name': ['NAND-side PHY', 'NAND 侧 PHY'],
  'comp.landing.role': ['stack {s} · TSV landing for the core dies', '堆叠 {s} · core die 的 TSV 落点'],
  'comp.debug.name': ['Test & debug', '测试与调试'],
  'comp.debug.role': ['stack {s} · DA port, TSV repair, IEEE 1500/1149.1, BIST', '堆叠 {s} · DA 端口、TSV 修复、IEEE 1500/1149.1、BIST'],
  'comp.die.name': ['Core die {d}', 'Core die {d}'],
  'comp.die.role': ['stack {s} · host channel {c} · 32 planes', '堆叠 {s} · 主机通道 {c} · 32 个 plane'],
  'comp.tsv.name': ['Through-silicon vias', '硅通孔（TSV）'],
  'comp.tsv.role': ['stack {s} · signal strip and power rows (sampled)', '堆叠 {s} · 信号带与电源排（抽样画）'],
  'comp.tsvPower.name': ['Power TSVs', '电源 TSV'],
  'comp.tsvPower.role': ['stack {s} · supply columns along both long edges (sampled)', '堆叠 {s} · 沿两条长边的供电柱（抽样画）'],
  'comp.gpu.name': ['GPU die', 'GPU 芯片'],
  'comp.gpu.role': ['GH100-class · drawn active side up', 'GH100 级 · 主动面朝上画'],
  'comp.bulk.name': ['Bulk silicon', '体硅'],
  'comp.bulk.role': ['the back of a flip-chip die', '倒装芯片的背面'],
  'comp.gpc.name': ['GPC {g}', 'GPC {g}'],
  'comp.gpc.role': ['{t} TPCs · {s} SMs', '{t} 个 TPC · {s} 个 SM'],
  'comp.l2.name': ['L2 cache', 'L2 缓存'],
  'comp.l2.role': ['{m} MB enabled, in two partitions', '启用 {m} MB，分两个分区'],
  'comp.gpuPhy.name': ['HBF PHY {s}', 'HBF PHY {s}'],
  'comp.gpuPhy.role': ['16 UCIe modules facing stack {s}', '16 个 UCIe 模块，正对堆叠 {s}'],
  'comp.mc.name': ['Memory controller {s}', '存储控制器 {s}'],
  'comp.mc.role': ['drives stack {s}’s 16 host channels', '驱动堆叠 {s} 的 16 个主机通道'],
  'comp.nvlink.name': ['NVLink', 'NVLink'],
  'comp.nvlink.role': ['18 links to other GPUs', '连向其他 GPU 的 18 条链路'],
  'comp.host.name': ['Host interface', '主机接口'],
  'comp.host.role': ['PCIe · where requests enter', 'PCIe · 请求从这里进来'],
  'comp.interposer.name': ['Silicon interposer', '硅中介层'],
  'comp.interposer.role': ['wiring between the GPU and six HBF stacks', 'GPU 与六个 HBF 堆叠之间的走线'],
  'comp.substrate.name': ['Package substrate', '封装基板'],
  'comp.substrate.role': ['organic substrate with decoupling capacitors', '有机基板与去耦电容'],
  'comp.ucie.name': ['UCIe links {s}', 'UCIe 链路 {s}'],
  'comp.ucie.role': ['16 host channels · GPU to stack {s}', '16 个主机通道 · GPU 到堆叠 {s}'],

  /* ---- tour ---- */
  'tour.prev': ['Back', '上一站'],
  'tour.next': ['Next', '下一站'],
  'tour.end': ['End tour', '结束导览'],
  'tour.done': ['Done', '完成'],
  'tour.step': ['{i} of {n}', '第 {i} / {n} 站'],
}
