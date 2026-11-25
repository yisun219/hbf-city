import {
  GPU,
  HBF,
  UCIE,
  blockBytes,
  dieBytes,
  planeBytes,
  planesPerStack,
  stackArrayProgramBps,
  stackArrayReadBps,
  stackBytes,
  ucieChannelRawBps,
  ucieStackEffectiveBps,
} from '../core/hbf-spec'
import { lang } from '../core/i18n'
import type { Lang } from '../core/i18n'
import type { ComponentDoc } from '../core/types'
import { fmtBytes, fmtRate } from '../core/util'

/* ============================================================================
 * INSPECTOR NOTES — what each component is, with every number sourced, in
 * English and 简体中文 side by side so the two cannot drift apart.
 *
 * Fact sources: OCP / HBFlex / Sandisk / FlashAccel / "HBF Sucks" / DASH /
 * GH100 (see core/hbf-spec.ts), 'derived' for arithmetic on sourced numbers,
 * and 'estimate' where no public document gives the value. A claim the model
 * cannot back is either absent or written as a caveat.
 * ==========================================================================*/

const n = (x: number) => x.toLocaleString('en-US')

function build(l: Lang): Record<string, ComponentDoc> {
  const L = (en: string, zh: string) => (l === 'zh' ? zh : en)
  const derived = L('derived', '推算')
  const estimate = L('estimate', '估计')
  const smTotal = GPU.gpcs * GPU.tpcsPerGpc * GPU.smsPerTpc

  return {
    stack: {
      title: L('HBF stack', 'HBF 堆叠'),
      subtitle: L('sixteen NAND dies on a logic base die', 'base die 上叠 16 层 NAND die'),
      tldr: L(
        'High Bandwidth Flash stacks NAND the way HBM stacks DRAM: core dies on a base die, joined by through-silicon vias, on the same interposer as the GPU. This GPU carries six.',
        '高带宽闪存（HBF）像 HBM 叠 DRAM 那样叠 NAND：core die 叠在 base die 上，用硅通孔（TSV）连起来，和 GPU 放在同一块中介层上。这颗 GPU 带六个堆叠。',
      ),
      facts: [
        { label: L('Capacity', '容量'), value: fmtBytes(stackBytes(), 0), source: derived },
        { label: L('Core dies', 'Core die 数'), value: `${HBF.diesPerStack}`, source: 'OCP §4.1' },
        { label: L('Host channels', '主机通道数'), value: `${HBF.channelsPerStack}`, source: 'OCP §4.1' },
        { label: L('Footprint', '尺寸'), value: `${HBF.footprintMm.width} × ${HBF.footprintMm.length} mm`, source: L('OCP §10.3 (approx.)', 'OCP §10.3（约）') },
        { label: L('Height', '高度'), value: `${HBF.heightUm} µm`, source: L('OCP §10.3 (nominal)', 'OCP §10.3（标称）') },
        { label: L('Effective link bandwidth', '链路有效带宽'), value: fmtRate(ucieStackEffectiveBps()), source: L('OCP Table 2', 'OCP 表 2') },
        { label: L('Array read bandwidth', '阵列读带宽'), value: fmtRate(stackArrayReadBps()), source: L('derived: planes × 4 KiB / tR', '推算：plane 数 × 4 KiB / tR') },
        { label: L('Array program bandwidth', '阵列编程带宽'), value: fmtRate(stackArrayProgramBps()), source: L('derived: planes × 4 KiB / tPROG', '推算：plane 数 × 4 KiB / tPROG') },
      ],
      sections: [
        {
          heading: L('How it is built', '结构与工艺'),
          body: L(
            'Each core die is made with CMOS bonded to array (CBA): the memory-array wafer is bonded directly to a CMOS wafer, which allows highly parallel arrays; Sandisk describes dozens of independent data planes per stack, and the HBFlex geometry used here has 32 per die, 512 per stack. Sixteen such dies sit on a logic die, connected by TSVs, and the stack sits beside the GPU on a silicon interposer.',
            '每层 core die 用 CBA（CMOS 与阵列键合）工艺：存储阵列晶圆直接键合在 CMOS 晶圆上，因此能做出高度并行的阵列；据 Sandisk 介绍，每个堆叠有几十个独立的数据 plane，这里采用的 HBFlex 几何是每 die 32 个、每堆叠 512 个。16 层这样的 die 叠在逻辑 die 上，用 TSV 连接，整个堆叠放在 GPU 旁边的硅中介层上。',
          ),
        },
        {
          heading: L('Why two bandwidths', '为什么有两个带宽'),
          body: L(
            `The UCIe interface can carry ${fmtRate(ucieStackEffectiveBps())} per stack. The NAND behind it senses ${n(planesPerStack())} planes × 4 KiB every ${HBF.readUs} µs at the timing used here, about ${fmtRate(stackArrayReadBps())}. Reaching even that needs every plane busy at once, which is why data are spread over all channels and planes.`,
            `UCIe 接口每个堆叠能传 ${fmtRate(ucieStackEffectiveBps())}。按这里用的时序，背后的 NAND 每 ${HBF.readUs} µs 只能读出 ${n(planesPerStack())} 个 plane × 4 KiB，大约 ${fmtRate(stackArrayReadBps())}。即便是这个数，也要所有 plane 同时工作才能达到，所以数据要分散到所有通道和 plane 上。`,
          ),
        },
        {
          heading: L('In LLM serving', '在推理服务中'),
          body: L(
            'Weights are written when the model is loaded and read for every token, so they are striped across all channels and planes (OCP §13.3.1). KV cache is written during prefill and decode and read back on every decode step; its layout is left to the host (OCP §13.3.2). The spec suggests keeping weights and KV cache in separate channel groups for endurance (OCP §13.3.3). This simulator does not: weights fill the first block rows of every die.',
            '权重在加载模型时写入、每个 token 都要读，所以条带化铺满所有通道和 plane（OCP §13.3.1）。KV 缓存在 prefill 和解码阶段写入，每个解码步都要读回，布局由主机决定（OCP §13.3.2）。规范建议出于寿命考虑，把权重和 KV 放在不同的通道组里（OCP §13.3.3）；本仿真没有这样做，权重占每层 die 最前面的若干 block 行。',
          ),
        },
      ],
      caveats: [
        L('Vertical scale is exaggerated 12× by default; the Height button in the toolbar (V) switches to true scale.', '竖直方向默认放大 12 倍，可用工具栏的“高度”按钮（V）切回真实比例。'),
        L('Opening a stack is a viewing aid. Real dies are bonded only microns apart.', '拆开堆叠只是为了看清楚，真实的 die 之间只隔几微米。'),
        L('The mold compound that encloses a real stack is not drawn.', '没有画包住真实堆叠的塑封料。'),
        L(
          'Data refresh is not simulated. OCP §11.5 calls for refreshing data, typically every 24–48 hours and after a product-specific number of reads, which also rewrites weights; here weight blocks never wear.',
          '没有仿真数据刷新。OCP §11.5 要求刷新数据，通常每 24–48 小时一次，读到产品规定的次数后也要刷新，权重也会因此重写；这里权重 block 不会磨损。',
        ),
      ],
      sources: [
        { key: 'SANDISK', where: L('Fig. 2 and text', '图 2 及正文') },
        { key: 'OCP', where: L('§4.1–4.4, §10.3, §11.5, §13.3, Table 2, Fig. 37', '§4.1–4.4、§10.3、§11.5、§13.3、表 2、图 37') },
        { key: 'HBFLEX', where: L('device geometry and timing', '器件几何与时序') },
      ],
    },

    base: {
      title: 'Base die',
      subtitle: L('the logic die under the NAND', 'NAND 底下的逻辑 die'),
      tldr: L(
        'Speaks UCIe to the GPU on one edge and drives the 16 core dies through TSVs. It runs ECC, keeps per-block read counters, manages bad blocks and TSV spares, and stages data in SRAM.',
        '它在朝 GPU 的一边用 UCIe 与 GPU 通信，并通过 TSV 驱动上方的 16 层 core die；还负责 ECC、按 block 统计读次数、管理坏块和备用 TSV，并用 SRAM 暂存数据。',
      ),
      facts: [
        { label: L('Host channels', '主机通道数'), value: `${HBF.channelsPerStack} × UCIe x${UCIE.lanesPerChannel}`, source: 'OCP §4.5' },
        { label: 'SRAM', value: `${HBF.baseDieSramMB} MB`, source: 'HBFlex §4.1' },
        { label: L('Write unit', '写入单位'), value: L('4 KiB, accumulated here', '4 KiB，在这里攒满'), source: 'OCP §5.4.1' },
        { label: L('Read size', '读取大小'), value: '64 B – 4 KiB', source: 'OCP §4.1' },
      ],
      sections: [
        {
          heading: L('Per channel', '每个通道'),
          body: L(
            'A UCIe controller and PHY, a base-die controller (the channel controllers drawn here), and a NAND-side PHY (OCP Fig. 1). The controller processes commands, moves data, encodes and decodes ECC, schedules transfers to the core dies, tracks read/write/erase status, maps TSV redundancy, and counts page reads per block so it can tell the host when a block needs refreshing (OCP §4.4).',
            '一个 UCIe 控制器和 PHY、一个 base die 控制器（即图中的通道控制器）、一个 NAND 侧 PHY（OCP 图 1）。控制器处理命令、搬移数据、做 ECC 编解码、调度到 core die 的传输、跟踪读写擦状态、维护 TSV 冗余映射，并按 block 统计页读次数，以便提醒主机哪个 block 需要刷新（OCP §4.4）。',
          ),
        },
        {
          heading: L('What it does not do', '它不做什么'),
          body: L(
            'HBF runs no garbage collection and never moves valid data on its own (OCP §11.4). For wear leveling the spec recommends enabling one of two options: base-die wear leveling, which is vendor-specific, or host-controlled zone remapping, where the host swaps a hot zone with a cold one once their data are invalid. Which data go where, and when blocks are reclaimed, is the serving software’s decision.',
            'HBF 不做垃圾回收，也不会自己搬有效数据（OCP §11.4）。磨损均衡方面，规范建议二选一开启：由厂商实现的 base die 磨损均衡，或由主机控制的 zone 重映射，即主机在数据变为无效后，把擦除次数多的热 zone 和擦除次数少的冷 zone 对调。数据放哪、什么时候回收 block，由推理服务软件决定。',
          ),
        },
      ],
      caveats: [
        L(
          'Module positions on the base die follow OCP Fig. 1 functionally, with the UCIe modules on the GPU-facing edge as in the bump map of OCP Fig. 37; the real floor plan is not public.',
          'base die 上各模块的位置按 OCP 图 1 的功能来画，UCIe 模块放在朝 GPU 的那条边上，与 OCP 图 37 的凸点图一致；真实布局没有公开。',
        ),
      ],
      sources: [
        { key: 'OCP', where: L('Fig. 1, Fig. 37, §4.1, §4.4, §5.4, §11.4', '图 1、图 37、§4.1、§4.4、§5.4、§11.4') },
        { key: 'HBFLEX', where: L('SRAM capacity', 'SRAM 容量') },
        { key: 'DASH', where: L('Fig. 4b, base-die SRAM and controller', '图 4b，base die 的 SRAM 和控制器') },
      ],
    },

    phy: {
      title: 'UCIe PHY',
      subtitle: L('sixteen x64 modules on the GPU-facing edge', '朝 GPU 那条边上的 16 个 x64 模块'),
      tldr: L(
        'One UCIe-A module per host channel. Each channel is independent: its own clock, its own NAND, and no access to another channel’s data.',
        '每个主机通道一个 UCIe-A 模块。各通道相互独立：时钟独立、NAND 独立，也访问不到别的通道的数据。',
      ),
      facts: [
        { label: L('Line rate', '线速率'), value: `${UCIE.gtPerS} GT/s`, source: L('OCP Table 2', 'OCP 表 2') },
        { label: L('Lanes', 'Lane 数'), value: L(`${UCIE.lanesPerChannel} each way`, `每个方向 ${UCIE.lanesPerChannel} 条`), source: 'OCP §4.5.1' },
        { label: L('Raw per channel', '每通道原始带宽'), value: fmtRate(ucieChannelRawBps()), source: L('OCP Table 2', 'OCP 表 2') },
        { label: L('Effective per stack', '每堆叠有效带宽'), value: fmtRate(ucieStackEffectiveBps()), source: L('OCP Table 2 (75% AXI efficiency)', 'OCP 表 2（AXI 效率 75%）') },
        { label: L('Module width', '模块宽度'), value: `≈ ${UCIE.moduleWidthMm} mm`, source: 'DASH §IV-A' },
        { label: L('Bump pitch', '凸点间距'), value: '45 µm', source: 'OCP §10.1' },
      ],
      sections: [
        {
          heading: L('Addressing', '寻址'),
          body: L(
            'The host splits its global address space over the 16 channels at an interleaving granularity it chooses, from 64 B to 4 KiB (OCP §4.6). Within a channel the base die maps addresses onto banks, dies and blocks.',
            '主机按自己选的交织粒度（64 B 到 4 KiB）把全局地址空间分到 16 个通道上（OCP §4.6）。通道内部再由 base die 把地址映射到 bank、die 和 block。',
          ),
        },
      ],
      sources: [
        { key: 'OCP', where: L('§4.5, §4.6, §10.1, Table 2, Fig. 37', '§4.5、§4.6、§10.1、表 2、图 37') },
        { key: 'DASH', where: '§IV-A' },
      ],
    },

    ctrl: {
      title: L('Channel controllers', '通道控制器'),
      subtitle: L('one per host channel', '每个主机通道一个'),
      tldr: L(
        'Queue commands, accumulate 4 KiB writes, run ECC, and schedule NAND reads and programs for their channel.',
        '为本通道排队命令、攒满 4 KiB 再写、做 ECC，并调度 NAND 的读和编程。',
      ),
      facts: [
        { label: L('Write completion', '写完成'), value: L('after the core die is programmed', '编程到 core die 之后才返回'), source: 'OCP §5.4.1' },
        { label: L('Erase', '擦除'), value: L('automatic on a write to page 0', '写 page 0 时自动擦'), source: 'OCP §5.4.1' },
        { label: L('Cache buffers', 'Cache buffer'), value: L('2 per bank, ≥ 2 pages', '每个 bank 2 个，至少 2 页'), source: 'OCP §5.3.1' },
      ],
      sections: [
        {
          heading: L('Reads', '读'),
          body: L(
            'Requests are 64 B granular. Senses to one bank run in order, and each bank holds at least two pages in cache buffers. A batch hint lets the controller schedule a group of reads together instead of waiting for its timer (OCP §5.3).',
            '请求粒度是 64 B。同一个 bank 的读按顺序进行，每个 bank 至少能在缓冲里存两页。batch 提示让控制器不等定时器，把一批读放在一起调度（OCP §5.3）。',
          ),
        },
        {
          heading: L('Writes', '写'),
          body: L(
            'Writes are non-posted. The controller gathers a full 4 KiB before programming, the host must write a block’s pages consecutively, and writing page 0 erases the block first (OCP §5.4.1).',
            '写是 non-posted 的。控制器攒满 4 KiB 才编程；主机必须按顺序写一个 block 里的页；写 page 0 时会先擦掉整个 block（OCP §5.4.1）。',
          ),
        },
      ],
      sources: [{ key: 'OCP', where: L('§5.3, §5.4', '§5.3、§5.4') }],
    },

    sram: {
      title: L('Base-die SRAM', 'Base die SRAM'),
      subtitle: L('staging and scratchpad', '暂存与 scratchpad'),
      tldr: L(
        'Fast on-stack memory between the GPU and the NAND. It hides flash latency by prefetching and collects small decode-time KV writes into full pages.',
        'GPU 和 NAND 之间的快速片上存储。它通过预取隐藏闪存延迟，并把解码时零碎的 KV 写攒成整页。',
      ),
      facts: [{ label: L('Capacity', '容量'), value: L(`${HBF.baseDieSramMB} MB per stack`, `每堆叠 ${HBF.baseDieSramMB} MB`), source: 'HBFlex §4.1' }],
      sections: [
        {
          heading: 'Scratchpad',
          body: L(
            'OCP defines an optional scratchpad that the host reads and writes at full channel bandwidth, for example for activations or layer-to-layer buffers. It is volatile and managed entirely by host software (OCP §11.3).',
            'OCP 定义了一个可选的 scratchpad，主机能以整条通道的带宽读写，比如放激活值或层间缓冲。它掉电即失，完全由主机软件管理（OCP §11.3）。',
          ),
        },
        {
          heading: L('Staging', '暂存'),
          body: L(
            'Serving designs use base-die SRAM to double-buffer reads ahead of use (DASH §IV-B) and to hold newly generated decode KV until it can be written in wide stripes during prefill (HBFlex §5.3).',
            '推理系统用 base die SRAM 提前双缓冲读取（DASH §IV-B），并先存着新生成的解码 KV，等到 prefill 时再整条带地写下去（HBFlex §5.3）。',
          ),
        },
      ],
      caveats: [L('The 48 SRAM banks drawn are an illustrative partition of the 40 MB.', '画出的 48 个 SRAM bank 只是对 40 MB 的示意划分。')],
      sources: [
        { key: 'OCP', where: L('§5.3.3, §5.4.2, §11.3', '§5.3.3、§5.4.2、§11.3') },
        { key: 'HBFLEX', where: L('SRAM capacity', 'SRAM 容量') },
        { key: 'DASH', where: '§IV-B' },
      ],
    },

    landing: {
      title: L('NAND-side PHY', 'NAND 侧 PHY'),
      subtitle: L('where the TSVs land', 'TSV 落在这里'),
      tldr: L(
        'The base die reaches the core dies through this strip. It also detects failed TSVs and maps them to spares.',
        'base die 通过这条 TSV 带连到各层 core die。它还检测失效的 TSV，并映射到备用 TSV 上。',
      ),
      sections: [
        {
          heading: L('Redundancy', '冗余'),
          body: L(
            'The base die supports failure detection and redundancy mapping of the TSVs between base and core dies (OCP §4.1, §4.4).',
            'base die 支持检测 base die 与 core die 之间 TSV 的故障，并做冗余映射（OCP §4.1、§4.4）。',
          ),
        },
      ],
      sources: [{ key: 'OCP', where: L('Fig. 1, §4.1, §4.4', '图 1、§4.1、§4.4') }],
    },

    debug: {
      title: L('Test & debug', '测试与调试'),
      subtitle: L('shared by all sixteen channels', '16 个通道共用'),
      tldr: L(
        'Direct-access test port, TSV repair, IEEE 1500 and IEEE 1149.1 ports, and built-in self-test.',
        '直接访问测试端口、TSV 修复、IEEE 1500 和 IEEE 1149.1 端口，以及内建自测。',
      ),
      sections: [
        {
          heading: L('Use', '用途'),
          body: L(
            'Manufacturing test, out-of-band register access, and firmware download over IEEE 1500 (OCP §4.3, §8), through a direct-access (DA) test port, TSV repair, IEEE 1500 and IEEE 1149.1 ports, and built-in self-test (BIST).',
            '量产测试、带外读写寄存器，以及通过 IEEE 1500 下载固件（OCP §4.3、§8）；用到直接访问（DA）测试端口、TSV 修复、IEEE 1500 和 IEEE 1149.1 端口，以及内建自测试（BIST）。',
          ),
        },
      ],
      sources: [{ key: 'OCP', where: L('Fig. 1, §4.3, §8', '图 1、§4.3、§8') }],
    },

    coreDie: {
      title: 'Core die',
      subtitle: L('one NAND die of sixteen', '16 层 NAND die 中的一层'),
      tldr: L(
        'Cut from an array wafer bonded to a CMOS wafer, with 32 independent planes. Each plane reads, programs and erases on its own.',
        '由阵列晶圆与 CMOS 晶圆键合后切割而成，有 32 个独立的 plane。每个 plane 各自读、编程和擦除。',
      ),
      facts: [
        { label: L('Planes', 'Plane 数'), value: `${HBF.planesPerDie}`, source: 'HBFlex' },
        { label: L('Blocks per plane', '每 plane 的 block 数'), value: `${HBF.blocksPerPlane}`, source: 'HBFlex' },
        { label: L('Pages per block', '每 block 的页数'), value: `${HBF.pagesPerBlock}`, source: 'HBFlex' },
        { label: L('Page', '页'), value: '4 KiB', source: 'OCP §4.1' },
        { label: 'Block', value: fmtBytes(blockBytes(), 0), source: derived },
        { label: 'Plane', value: fmtBytes(planeBytes(), 0), source: derived },
        { label: 'Die', value: fmtBytes(dieBytes(), 0), source: derived },
        { label: L('Read (tR)', '读（tR）'), value: `${HBF.readUs} µs`, source: 'HBFlex' },
        { label: L('Program (tPROG)', '编程（tPROG）'), value: `${HBF.programUs} µs`, source: 'HBFlex' },
        { label: L('Endurance', '寿命'), value: L(`${n(HBF.peCycles)} P/E (SLC)`, `${n(HBF.peCycles)} 次 P/E（SLC）`), source: L('HBFlex; FlashAccel §2.3', 'HBFlex；FlashAccel §2.3') },
      ],
      sections: [
        {
          heading: L('Floor plan', '平面布局'),
          body: L(
            'Signal TSVs run through a strip down the middle and power TSVs along the long edges; planes sit in two rows either side of the strip. Each plane has a word-line staircase at both ends and its 512 blocks between them.',
            '信号 TSV 走中间的 TSV 带，电源 TSV 沿两条长边分布；plane 分两排，位于 TSV 带两侧。每个 plane 两头是字线台阶，中间是 512 个 block。',
          ),
        },
        {
          heading: L('Pages and blocks', '页和 block'),
          body: L(
            'Reads and programs work on 4 KiB pages; an erase clears a whole block. A page cannot be rewritten until its block is erased, so invalid data stay until the host reclaims the block. In 3D NAND a block is a slice of the vertical array between two slits, and a page is addressed by word line and string (OCP §5.4.1 names page 0 as WL-0, STR-0).',
            '读和编程以 4 KiB 的页为单位，擦除则一次擦整个 block。页在所在 block 擦除之前不能重写，所以无效数据会一直留着，直到主机回收这个 block。3D NAND 里一个 block 是两道狭缝之间的一片竖直阵列，页按字线和 string 编址（OCP §5.4.1 把 page 0 写作 WL-0、STR-0）。',
          ),
        },
        {
          heading: L('Writing fast', '如何写得快'),
          body: L(
            'At this timing a program takes about 19 times longer than a read. The best write throughput comes from writing all banks in all channels together, with every bank of one die at the same page number (OCP §11.2.2).',
            '按这里的时序，编程耗时约为读的 19 倍。写吞吐最高的做法是所有通道的所有 bank 一起写，并且同一层 die 的各个 bank 用同一个页号（OCP §11.2.2）。',
          ),
        },
      ],
      caveats: [
        L(
          'Real HBF die floor plans are not public. This one follows published diagrams (FlashAccel Fig. 6c, “HBF Sucks” Fig. 2).',
          '真实的 HBF die 平面布局没有公开，这里按已发表的示意图画（FlashAccel 图 6c、“HBF Sucks”图 2）。',
        ),
        L(
          'Block colours come from the serving simulator. It programs a block index on all 32 planes of a die together, so the planes of one die always look alike.',
          'block 颜色来自推理服务仿真。仿真在一层 die 的 32 个 plane 上同时使用同一个 block 号，所以同一层 die 的各个 plane 看起来总是一样。',
        ),
        L(
          'The word-line staircases at the ends of each plane are generic 3D-NAND structure; the cited diagrams do not show them.',
          '每个 plane 两头的字线台阶是 3D NAND 的通用结构，所引的示意图里没有画。',
        ),
        L(
          'Data refresh (OCP §11.5) is not simulated, so weight blocks are never erased here.',
          '没有仿真数据刷新（OCP §11.5），所以这里权重 block 从不擦除。',
        ),
        L(
          'OCP Table 3 counts 16 banks per channel; this city uses HBFlex’s 32 planes per die. One host channel per die follows OCP §4.3; OCP Fig. 4 shows a channel spanning four dies instead.',
          'OCP 表 3 写的是每通道 16 个 bank；这里用 HBFlex 的每 die 32 个 plane。每个主机通道对应一层 die 是按 OCP §4.3 的说法，OCP 图 4 画的则是一个通道跨四层 die。',
        ),
      ],
      sources: [
        { key: 'HBFLEX', where: L('geometry and timing', '几何与时序') },
        { key: 'OCP', where: L('§4.1, §4.3, §5.4.1, §5.7, §11.2.2, §11.5', '§4.1、§4.3、§5.4.1、§5.7、§11.2.2、§11.5') },
        { key: 'FLASHACC', where: L('Fig. 3, Fig. 6c', '图 3、图 6c') },
        { key: 'HBFSUCKS', where: L('Fig. 2', '图 2') },
      ],
    },

    tsv: {
      title: L('Signal TSVs', '信号 TSV'),
      subtitle: L('the vertical data path', '竖直方向的数据通路'),
      tldr: L(
        'Copper vias through every die carry commands and data between the base die and each core die.',
        '穿过每层 die 的铜通孔，在 base die 和各层 core die 之间传命令和数据。',
      ),
      sections: [
        {
          heading: L('Drawing', '画法'),
          body: L(
            'Only a sample of columns is drawn. A real stack has thousands of TSVs, and the base die maps failed ones to spares (OCP §4.1). Light pulses running down them show the stack’s traffic, mostly reads.',
            '只画了一部分柱子。真实堆叠有数千个 TSV，失效的由 base die 映射到备用 TSV 上（OCP §4.1）。柱子上往下跑的光点表示这个堆叠的流量，以读为主。',
          ),
        },
      ],
      caveats: [L('Columns are sampled and widened for visibility.', '柱子是抽样画的，并且加粗了。')],
      sources: [
        { key: 'SANDISK', where: L('Fig. 2', '图 2') },
        { key: 'HBFSUCKS', where: L('Fig. 2', '图 2') },
        { key: 'OCP', where: '§4.1' },
      ],
    },

    tsvPower: {
      title: L('Power TSVs', '电源 TSV'),
      subtitle: L('supply columns along the long edges', '沿两条长边的供电柱'),
      tldr: L('Wide copper vias that deliver power to every core die.', '给每层 core die 供电的粗铜通孔。'),
      caveats: [L('Columns are sampled and widened for visibility; their placement follows “HBF Sucks” Fig. 2.', '柱子是抽样画的，并且加粗了；位置参照“HBF Sucks”图 2。')],
      sections: [],
      sources: [{ key: 'HBFSUCKS', where: L('Fig. 2', '图 2') }],
    },

    gpu: {
      title: L('GPU die', 'GPU 芯片'),
      subtitle: L('GH100-class, seen through its silicon', 'GH100 级，透过体硅看电路'),
      tldr: L(
        `${GPU.gpcs} GPCs of ${GPU.tpcsPerGpc * GPU.smsPerTpc} SMs (${GPU.enabledSms} of ${smTotal} enabled on H100 SXM5), ${GPU.l2MB} MB of L2 enabled (${GPU.l2FullMB} MB on the full die), and memory PHYs on both long edges, here facing six HBF stacks.`,
        `${GPU.gpcs} 个 GPC，每个 ${GPU.tpcsPerGpc * GPU.smsPerTpc} 个 SM（H100 SXM5 启用 ${smTotal} 个中的 ${GPU.enabledSms} 个），启用 ${GPU.l2MB} MB L2（整颗 die 有 ${GPU.l2FullMB} MB），两条长边上是存储 PHY，这里正对六个 HBF 堆叠。`,
      ),
      facts: [
        { label: L('SMs enabled', '启用的 SM'), value: `${GPU.enabledSms} / ${smTotal}`, source: L('GH100 whitepaper', 'GH100 白皮书') },
        { label: 'L2', value: L(`${GPU.l2MB} MB of ${GPU.l2FullMB} MB`, `${GPU.l2MB} MB（共 ${GPU.l2FullMB} MB）`), source: L('GH100 whitepaper', 'GH100 白皮书') },
        { label: L('Die drawn', '画的尺寸'), value: `${GPU.dieMm.width} × ${GPU.dieMm.length} mm`, source: L('estimate (GH100 ≈ 814 mm²)', '估计（GH100 约 814 mm²）') },
        {
          label: L('HBF per GPU', '每 GPU 的 HBF'),
          value: L(`${HBF.stacksPerGpu} stacks, ${fmtBytes(stackBytes() * HBF.stacksPerGpu, 0)}`, `${HBF.stacksPerGpu} 个堆叠，${fmtBytes(stackBytes() * HBF.stacksPerGpu, 0)}`),
          source: 'HBFlex',
        },
      ],
      sections: [
        {
          heading: L('Seen through the silicon', '透过体硅看电路'),
          body: L(
            'On the package the GPU is flip-chip mounted: its transistors face down onto the interposer and its top is bare silicon. The city keeps the circuits at the bottom, where they are, and draws the silicon above them as a ghost volume as tall as the stacks. The circuit blocks are drawn facing up so they can be seen from above; on the real die the transistors and wiring face the bumps below.',
            '在封装上 GPU 是倒装的：晶体管朝下贴着中介层，顶面是裸硅。这里把电路留在底部它本来的位置，把上面的硅画成半透明的体积，高度和堆叠一样。电路模块画成朝上，方便从上方看清；真实芯片上晶体管和布线朝下，对着下面的凸点。',
          ),
        },
        {
          heading: L('In LLM serving', '在推理服务中'),
          body: L(
            'Every decode step reads all the weights it uses and each request’s KV cache. With HBF those reads come from flash, so the GPU must request them ahead of use to hide microsecond read latency.',
            '每个解码步都要读它用到的全部权重和每个请求的 KV 缓存。用 HBF 时这些读都来自闪存，所以 GPU 必须提前发起读取，才能隐藏微秒级的读延迟。',
          ),
        },
      ],
      caveats: [
        L(
          'The floor plan is approximate, after the GH100 block diagram; it is not a die photo. Which SMs are disabled varies by chip; the pattern drawn is an example.',
          '平面布局是参照 GH100 框图的近似，不是 die 照片。哪些 SM 被熔断因芯片而异，画的只是一个例子。',
        ),
      ],
      sources: [
        { key: 'GH100', where: L('architecture overview', '架构概述') },
        { key: 'HBFLEX', where: L('six stacks per GPU', '每 GPU 六个堆叠') },
      ],
    },

    bulk: {
      title: L('Bulk silicon', '体硅'),
      subtitle: L('the back of a flip-chip die', '倒装芯片的背面'),
      tldr: L(
        'The GPU die’s bulk silicon, above its circuits. The GPU and the stacks end at about the same height so one lid or cold plate covers them.',
        'GPU die 电路上方的体硅。GPU 和堆叠的顶面大致齐平，这样一块盖板或冷板就能同时盖住它们。',
      ),
      sections: [],
      caveats: [L('Drawn translucent so the circuits beneath stay visible. Toggle it with Silicon in the toolbar (B).', '画成半透明，以便看清下面的电路；可用工具栏的“体硅”按钮（B）隐藏。')],
      sources: [{ key: 'OCP', where: L('§10.3 (stack height)', '§10.3（堆叠高度）') }],
    },

    gpc: {
      title: L('Graphics processing cluster', '图形处理簇（GPC）'),
      subtitle: L(`${GPU.tpcsPerGpc} TPCs × ${GPU.smsPerTpc} SMs`, `${GPU.tpcsPerGpc} 个 TPC × ${GPU.smsPerTpc} 个 SM`),
      tldr: L(
        'Each SM has four Tensor Cores, one per sub-partition, and a combined L1 cache and shared memory. Dark roofs are SMs fused off for yield, a whole TPC (two SMs) at a time.',
        '每个 SM 有四个 Tensor Core（每个子分区一个），以及合在一起的 L1 缓存和共享内存。暗色顶的 SM 是为了良率熔断掉的，每次熔断整个 TPC（两个 SM）。',
      ),
      sections: [],
      caveats: [L('SM blocks are raised for legibility; the real active layer is microns thick.', 'SM 方块抬高了，便于看清；真实的有源层只有几微米厚。')],
      sources: [{ key: 'GH100', where: L('GPC and SM structure', 'GPC 与 SM 结构') }],
    },

    l2: {
      title: L('L2 cache', 'L2 缓存'),
      subtitle: L(`${GPU.l2MB} MB enabled, in two partitions`, `启用 ${GPU.l2MB} MB，分两个分区`),
      tldr: L(
        'On-chip SRAM between the memory controllers and the SMs, split into two partitions joined by a crossbar.',
        '存储控制器和 SM 之间的片上 SRAM，分成两个分区，中间用交叉开关连接。',
      ),
      sections: [],
      sources: [{ key: 'GH100', where: L('memory hierarchy', '存储层次') }],
    },

    gpuPhy: {
      title: L('HBF PHY on the GPU', 'GPU 上的 HBF PHY'),
      subtitle: L('16 UCIe modules facing one stack', '正对一个堆叠的 16 个 UCIe 模块'),
      tldr: L(
        'The GPU end of one stack’s 16 host channels. Each module faces its partner on the stack’s base die across the interposer.',
        '一个堆叠的 16 个主机通道在 GPU 这一端的接口。每个模块隔着中介层正对 base die 上的对应模块。',
      ),
      sections: [],
      sources: [{ key: 'OCP', where: L('§4.3, §4.5', '§4.3、§4.5') }],
    },

    gpuMc: {
      title: L('Memory controller', '存储控制器'),
      subtitle: L('one per stack', '每个堆叠一个'),
      tldr: L(
        'Issues the AXI reads and writes for one stack. HBF runs no garbage collection, so the serving software decides placement and reclamation and the controller carries them out.',
        '为一个堆叠发出 AXI 读写。HBF 不做垃圾回收，所以由推理服务软件决定数据放哪、何时回收，控制器负责执行。',
      ),
      sections: [],
      caveats: [L('Drawn as one unit per stack; real controllers are split per channel.', '每个堆叠画成一个整体；真实的控制器按通道拆开。')],
      sources: [{ key: 'OCP', where: L('§5.2, §11.4', '§5.2、§11.4') }],
    },

    nvlink: {
      title: 'NVLink',
      subtitle: L('18 links to other GPUs', '连向其他 GPU 的 18 条链路'),
      tldr: L(
        'GPU-to-GPU links for tensor- and expert-parallel traffic when a model is served across several GPUs.',
        '模型跨多张 GPU 部署时，承载张量并行和专家并行流量的 GPU 间链路。',
      ),
      sections: [],
      sources: [{ key: 'GH100', where: 'NVLink' }],
    },

    host: {
      title: L('Host interface', '主机接口'),
      subtitle: L('PCIe to the CPU', '连 CPU 的 PCIe'),
      tldr: L('Where serving requests and their tokens enter the GPU from the host.', '推理请求和它们的 token 从主机进入 GPU 的地方。'),
      sections: [],
      sources: [{ key: 'GH100', where: L('host interface', '主机接口') }],
    },

    interposer: {
      title: L('Silicon interposer', '硅中介层'),
      subtitle: L('the ground level of the city', '城市的地面'),
      tldr: L(
        'A silicon slab carrying the fine wiring between the GPU and the six stacks. Its top surface is y = 0 in the city.',
        '承载 GPU 与六个堆叠之间细密走线的一块硅片。它的上表面就是城市里的 y = 0。',
      ),
      facts: [
        { label: L('Thickness drawn', '画的厚度'), value: '100 µm', source: estimate },
        { label: L('UCIe bump pitch', 'UCIe 凸点间距'), value: '45 µm', source: 'OCP §10.1' },
      ],
      sections: [],
      caveats: [
        L(
          'The gap between the GPU and each stack is drawn about 1.6 mm. No source gives the real gap; OCP limits the UCIe channel to under 2 mm, bump to bump (§5.1.1).',
          'GPU 与每个堆叠之间画成约 1.6 mm。没有资料给出真实间距；OCP 规定 UCIe 通道从凸点到凸点不超过 2 mm（§5.1.1）。',
        ),
      ],
      sources: [
        { key: 'SANDISK', where: L('Fig. 2', '图 2') },
        { key: 'OCP', where: L('§5.1.1, §10.1', '§5.1.1、§10.1') },
      ],
    },

    substrate: {
      title: L('Package substrate', '封装基板'),
      subtitle: L('organic substrate and decoupling capacitors', '有机基板与去耦电容'),
      tldr: L(
        'Carries the interposer on C4 bumps and spreads power and I/O to the board. The capacitors around the interposer steady the supply.',
        '通过 C4 凸点托住中介层，把电源和 I/O 分到电路板上。中介层周围的电容用来稳定供电。',
      ),
      sections: [],
      caveats: [
        L(
          'Substrate size, capacitor placement and C4 height are estimates. Capacitors are 0201 parts at near-true proportions; they are not exaggerated like the dies.',
          '基板尺寸、电容位置和 C4 高度都是估计。电容按 0201 器件、接近真实比例画，不像 die 那样竖直放大。',
        ),
      ],
      sources: [{ key: 'SANDISK', where: L('Fig. 2', '图 2') }],
    },

    ucie: {
      title: L('UCIe host channels', 'UCIe 主机通道'),
      subtitle: L('sixteen per stack', '每个堆叠 16 个'),
      tldr: L(
        'Sixteen independent x64 channels per stack at 32 GT/s, each separately clocked and not necessarily synchronous with the others. Each channel is drawn as one line; pulses running toward the GPU show that channel’s traffic.',
        '每个堆叠 16 个相互独立的 x64 通道，32 GT/s，各自有时钟，彼此不一定同步。每个通道画一条线，朝 GPU 跑的光点表示这个通道的流量。',
      ),
      facts: [
        { label: L('Raw per channel', '每通道原始带宽'), value: fmtRate(ucieChannelRawBps()), source: L('OCP Table 2', 'OCP 表 2') },
        { label: L('Effective per stack', '每堆叠有效带宽'), value: fmtRate(ucieStackEffectiveBps()), source: L('OCP Table 2 (75% AXI efficiency)', 'OCP 表 2（AXI 效率 75%）') },
      ],
      sections: [],
      sources: [{ key: 'OCP', where: L('§4.3, §4.5, Table 2', '§4.3、§4.5、表 2') }],
    },
  }
}

const cache: Partial<Record<Lang, Record<string, ComponentDoc>>> = {}

function docs(l: Lang): Record<string, ComponentDoc> {
  if (!cache[l]) cache[l] = build(l)
  return cache[l]!
}

export function docFor(key: string): ComponentDoc | undefined {
  return docs(lang())[key]
}

/** Doc keys in one language, for the tests that check both languages match. */
export function docKeys(l: Lang): string[] {
  return Object.keys(docs(l))
}

export function docIn(l: Lang, key: string): ComponentDoc | undefined {
  return docs(l)[key]
}

/** Every simplification the city makes, for the "How much to trust this" sheet. */
export function trustNotes(): string[] {
  return lang() === 'zh'
    ? [
        '这是模型，不是 die 照片。堆叠内部的 HBF 平面布局没有公开，这里按已发表的示意图画。',
        '高度默认放大 12 倍（工具栏“高度”按钮或 V 键可切回真实比例），电路模块也抬高了，便于看清。',
        '拆开堆叠、把 die 抽出来，都只是为了看清楚；键合的 die 之间只隔几微米。',
        'block 颜色来自推理服务仿真，不是实测。请求是合成的，按公开的 Qwen-Bailian trace 算出的统计量生成。',
        '仿真在一层 die 的 32 个 plane 上同时使用同一个 block 号（block 号按 OCP §5.7，同一 die 用同一页号按 §11.2.2），所以它的 block 比 HBFlex 的单 plane block 粗，写放大也和 HBFlex 发表的数字不同。',
        '每次迭代的时间取两者中较大的：计算时间，以及最忙交织域的读、编程和遗留 GC 时间之和（它们共用 plane，所以相加）。专家路由按均匀分布假设。',
        '这里没有做磨损均衡。OCP §11.4 建议开启 base die 或主机控制的磨损均衡；仿真特意不做，让磨损视图显示没有它时的样子。',
        '没有仿真数据刷新（OCP §11.5：通常每 24–48 小时一次，读到产品规定的次数后也要刷新），所以这里权重 block 不会磨损。',
        '仿真不限制 base die SRAM 容量。每会话交织 16 层 die 时，暂存的 KV 可能超过整个封装的 240 MB；实时指标面板会把它标红，但仿真不会因此停顿。',
        'GPU 的电路和真实的倒装封装一样位于底部、朝向中介层；上面的体硅画成半透明，好让电路露出来，电路模块也画成朝上。',
      ]
    : [
        'This is a model, not a die photo. HBF floor plans inside the stack are not public; the ones drawn here follow published diagrams.',
        'Heights are exaggerated 12× by default (the Height button or V switches to true scale). Circuit blocks are raised for legibility.',
        'Opening a stack and sliding a die out are viewing aids; bonded dies sit microns apart.',
        'Block colours come from a serving simulator, not a measurement. Requests are synthetic, drawn from statistics computed from the published Qwen-Bailian traces.',
        'The simulator allocates a block index on all 32 planes of a die together (block number as in OCP §5.7, one page number per die as in §11.2.2), so its blocks are coarser than HBFlex’s per-plane blocks and its write amplification differs from HBFlex’s published numbers.',
        'Iteration time is the larger of compute and the busiest interleave domain’s reads + programs + leftover GC (they share planes, so they add). Routing assumes uniform expert selection.',
        'Nothing here levels wear. OCP §11.4 recommends enabling base-die or host-controlled wear leveling; the simulator leaves it out so the wear view shows wear without it.',
        'Data refresh is not simulated (OCP §11.5: typically every 24–48 hours, and after a product-specific number of reads), so weight blocks never wear here.',
        'Base-die SRAM capacity is not enforced. At 16 dies per session, staged KV can exceed the package’s 240 MB; the Live panel shows it in red, and the simulator does not stall for it.',
        'The GPU’s circuits sit at the bottom, facing the interposer, as on a real flip-chip package; the bulk silicon above them is drawn translucent so they show, and the circuit blocks are drawn facing up.',
      ]
}
