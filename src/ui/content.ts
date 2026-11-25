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
import type { ComponentDoc } from '../core/types'
import { fmtBytes, fmtRate } from '../core/util'

/* ============================================================================
 * INSPECTOR NOTES — what each component is, with every number sourced.
 *
 * Fact sources: OCP / HBFLEX / SANDISK / FLASHACC / HBFSUCKS / DASH / GH100
 * (see core/hbf-spec.ts), 'derived' for arithmetic on sourced numbers, and
 * 'estimate' where no public document gives the value. A claim the model
 * cannot back is either absent or written as a caveat.
 * ==========================================================================*/

const n = (x: number) => x.toLocaleString('en-US')

export const DOCS: Record<string, ComponentDoc> = {
  stack: {
    title: 'HBF stack',
    subtitle: 'sixteen NAND dies on a logic base die',
    tldr:
      'High Bandwidth Flash stacks NAND the way HBM stacks DRAM: core dies on a base die, joined by through-silicon vias, on the same interposer as the GPU. This GPU carries six.',
    facts: [
      { label: 'Capacity', value: fmtBytes(stackBytes(), 0), source: 'derived' },
      { label: 'Core dies', value: `${HBF.diesPerStack}`, source: 'OCP §4.1' },
      { label: 'Host channels', value: `${HBF.channelsPerStack}`, source: 'OCP §4.1' },
      { label: 'Footprint', value: `${HBF.footprintMm.width} × ${HBF.footprintMm.length} mm`, source: 'OCP §10.3 (approx.)' },
      { label: 'Height', value: `${HBF.heightUm} µm`, source: 'OCP §10.3 (nominal)' },
      { label: 'Link bandwidth', value: fmtRate(ucieStackEffectiveBps()), source: 'OCP Table 2' },
      { label: 'Array read bandwidth', value: fmtRate(stackArrayReadBps()), source: 'derived: planes × 4 KiB / tR' },
      { label: 'Array program bandwidth', value: fmtRate(stackArrayProgramBps()), source: 'derived: planes × 4 KiB / tPROG' },
    ],
    sections: [
      {
        heading: 'How it is built',
        body:
          'Each core die is made with CMOS bonded to array (CBA): the memory-array wafer is bonded directly to a CMOS wafer, which allows highly parallel arrays; Sandisk describes dozens of independent data planes per stack. Sixteen such dies sit on a logic die, connected by TSVs, and the stack sits beside the GPU on a silicon interposer.',
      },
      {
        heading: 'Why two bandwidths',
        body:
          `The UCIe interface can carry ${fmtRate(ucieStackEffectiveBps())} per stack. The NAND behind it senses ${n(planesPerStack())} planes × 4 KiB every ${HBF.readUs} µs at the timing used here, about ${fmtRate(stackArrayReadBps())}. Reaching even that needs every plane busy at once, which is why data are spread over all channels and planes.`,
      },
      {
        heading: 'In LLM serving',
        body:
          'Weights are written once and read for every token, so they are striped across all channels and planes (OCP §13.3.1). KV cache is written during prefill and decode and read back on every decode step; its layout is left to the host (OCP §13.3.2). The spec suggests keeping weights and KV cache in separate channel groups for endurance (OCP §13.3.3).',
      },
    ],
    caveats: [
      'Vertical scale is exaggerated 12× by default; the toolbar can show true proportions.',
      'Opening a stack is a viewing aid. The real dies are bonded with microns between them.',
      'The mold compound that encloses a real stack is not drawn.',
    ],
    sources: [
      { key: 'SANDISK', where: 'Fig. 2 and text' },
      { key: 'OCP', where: '§4.1–4.4, §10.3, §13.3, Table 2' },
      { key: 'HBFLEX', where: 'device geometry and timing' },
    ],
  },

  base: {
    title: 'Base die',
    subtitle: 'the logic die under the NAND',
    tldr:
      'Speaks UCIe to the GPU on one edge and drives the sixteen core dies through TSVs. It runs ECC, keeps per-block read counters, manages bad blocks and TSV spares, and stages data in SRAM.',
    facts: [
      { label: 'Host channels', value: `${HBF.channelsPerStack} × UCIe x${UCIE.lanesPerChannel}`, source: 'OCP §4.5' },
      { label: 'SRAM', value: `${HBF.baseDieSramMiB} MiB`, source: 'HBFlex' },
      { label: 'Write unit', value: '4 KiB, accumulated here', source: 'OCP §5.4.1' },
      { label: 'Read size', value: '64 B – 4 KiB', source: 'OCP §4.1' },
    ],
    sections: [
      {
        heading: 'Per channel',
        body:
          'A UCIe controller and PHY, a base-die controller, and a NAND-side PHY (OCP Fig. 1). The controller processes commands, moves data, encodes and decodes ECC, schedules transfers to the core dies, tracks read/write/erase status, maps TSV redundancy, and counts page reads per block so it can tell the host when a block needs refreshing (OCP §4.4).',
      },
      {
        heading: 'What it does not do',
        body:
          'HBF runs no garbage collection and never moves live data on its own. It can remap a zone of a channel to new physical blocks for wear leveling, under host or vendor control (OCP §11.4). Which data go where, and when blocks are reclaimed, is the serving software’s decision.',
      },
    ],
    caveats: ['Block positions on the base die follow OCP Fig. 1 functionally; the real floor plan is not public.'],
    sources: [
      { key: 'OCP', where: 'Fig. 1, §4.1, §4.4, §5.4, §11.4' },
      { key: 'HBFLEX', where: 'SRAM capacity' },
      { key: 'DASH', where: 'Fig. 4b, base-die SRAM and controller' },
    ],
  },

  phy: {
    title: 'UCIe PHY',
    subtitle: 'sixteen x64 modules on the GPU-facing edge',
    tldr: 'One UCIe-A module per host channel. Each channel is independent: its own clock, its own NAND, and no access to another channel’s data.',
    facts: [
      { label: 'Line rate', value: `${UCIE.gtPerS} GT/s`, source: 'OCP Table 2' },
      { label: 'Lanes', value: `${UCIE.lanesPerChannel} each way`, source: 'OCP §4.5.1' },
      { label: 'Raw per channel', value: fmtRate(ucieChannelRawBps()), source: 'OCP Table 2' },
      { label: 'Effective per stack', value: fmtRate(ucieStackEffectiveBps()), source: 'OCP Table 2 (75 % AXI efficiency)' },
      { label: 'Module width', value: `≈ ${UCIE.moduleWidthMm} mm`, source: 'DASH §IV-A' },
      { label: 'Bump pitch', value: '45 µm', source: 'OCP §10.1' },
    ],
    sections: [
      {
        heading: 'Addressing',
        body:
          'The host splits its global address space over the 16 channels at an interleaving granularity it chooses, from 64 B to 4 KiB (OCP §4.6). Within a channel the base die maps addresses onto banks, dies and blocks.',
      },
    ],
    sources: [
      { key: 'OCP', where: '§4.5, §4.6, §10.1, Table 2' },
      { key: 'DASH', where: '§IV-A' },
    ],
  },

  ctrl: {
    title: 'Channel controllers',
    subtitle: 'one per host channel',
    tldr: 'Queue commands, accumulate 4 KiB writes, run ECC, and schedule NAND reads and programs for their channel.',
    facts: [
      { label: 'Write completion', value: 'after the core die is programmed', source: 'OCP §5.4.1' },
      { label: 'Erase', value: 'automatic on a write to page 0', source: 'OCP §5.4.1' },
      { label: 'Page buffers', value: '2 per bank', source: 'OCP §5.3.1' },
    ],
    sections: [
      {
        heading: 'Reads',
        body:
          'Requests are 64 B granular. Senses to one bank run in order, and each bank holds at least two pages in cache buffers. A batch hint lets the controller schedule a group of reads together instead of waiting for its timer (OCP §5.3).',
      },
      {
        heading: 'Writes',
        body:
          'Writes are non-posted. The controller gathers a full 4 KiB before programming, the host must write a block’s pages consecutively, and writing page 0 erases the block first (OCP §5.4.1).',
      },
    ],
    sources: [{ key: 'OCP', where: '§5.3, §5.4' }],
  },

  sram: {
    title: 'Base-die SRAM',
    subtitle: 'staging and scratchpad',
    tldr:
      'Fast on-stack memory between the GPU and the NAND. It hides flash latency by prefetching and collects small decode-time KV writes into full pages.',
    facts: [{ label: 'Capacity', value: `${HBF.baseDieSramMiB} MiB per stack`, source: 'HBFlex' }],
    sections: [
      {
        heading: 'Scratchpad',
        body:
          'OCP defines an optional scratchpad that the host reads and writes at full channel bandwidth, for example for activations or layer-to-layer buffers. It is volatile and managed entirely by host software (OCP §11.3).',
      },
      {
        heading: 'Staging',
        body:
          'Serving designs use base-die SRAM to double-buffer reads ahead of use and to hold decode KV until a page is full (HBFlex; DASH §IV-B).',
      },
    ],
    caveats: ['The 48 banks drawn are an illustrative partition of the 40 MiB.'],
    sources: [
      { key: 'OCP', where: '§5.3.3, §5.4.2, §11.3' },
      { key: 'HBFLEX', where: 'SRAM capacity' },
      { key: 'DASH', where: '§IV-B' },
    ],
  },

  landing: {
    title: 'NAND-side PHY',
    subtitle: 'where the TSVs land',
    tldr: 'The base die reaches the core dies through this strip. It also detects failed TSVs and maps them to spares.',
    sections: [
      {
        heading: 'Redundancy',
        body: 'The base die supports failure detection and redundancy mapping of the TSVs between base and core dies (OCP §4.1, §4.4).',
      },
    ],
    sources: [{ key: 'OCP', where: 'Fig. 1, §4.1, §4.4' }],
  },

  debug: {
    title: 'Test & debug',
    subtitle: 'shared by all sixteen channels',
    tldr: 'Direct-access test port, TSV repair, IEEE 1500 and IEEE 1149.1 ports, and built-in self-test.',
    sections: [
      {
        heading: 'Use',
        body: 'Manufacturing test, out-of-band register access, and firmware download over IEEE 1500 (OCP §8).',
      },
    ],
    sources: [{ key: 'OCP', where: 'Fig. 1, §8' }],
  },

  coreDie: {
    title: 'Core die',
    subtitle: 'one NAND die of sixteen',
    tldr: 'An array wafer bonded to a CMOS wafer, with 32 independent planes. Each plane reads, programs and erases on its own.',
    facts: [
      { label: 'Planes', value: `${HBF.planesPerDie}`, source: 'HBFlex' },
      { label: 'Blocks per plane', value: `${HBF.blocksPerPlane}`, source: 'HBFlex' },
      { label: 'Pages per block', value: `${HBF.pagesPerBlock}`, source: 'HBFlex' },
      { label: 'Page', value: '4 KiB', source: 'OCP §4.1' },
      { label: 'Block', value: fmtBytes(blockBytes(), 0), source: 'derived' },
      { label: 'Plane', value: fmtBytes(planeBytes(), 0), source: 'derived' },
      { label: 'Die', value: fmtBytes(dieBytes(), 0), source: 'derived' },
      { label: 'Read (tR)', value: `${HBF.readUs} µs`, source: 'HBFlex' },
      { label: 'Program (tPROG)', value: `${HBF.programUs} µs`, source: 'HBFlex' },
      { label: 'Endurance', value: `${n(HBF.peCycles)} P/E (SLC)`, source: 'HBFlex; FlashAccel §2.3' },
    ],
    sections: [
      {
        heading: 'Floor plan',
        body:
          'Signal TSVs run through a strip down the middle and power TSVs along the long edges; planes sit in two rows either side of the strip. Each plane has a word-line staircase at both ends and its 512 blocks between them.',
      },
      {
        heading: 'Pages and blocks',
        body:
          'Reads and programs work on 4 KiB pages; an erase clears a whole block. A page cannot be rewritten until its block is erased, so stale data stay until the host reclaims the block. In 3D NAND a block is a slice of the vertical array between two slits, and a page is addressed by word line and string (OCP §5.4.1 names page 0 as WL-0, STR-0).',
      },
      {
        heading: 'Writing fast',
        body:
          'At this timing a program takes about 19 times longer than a read. The best write throughput comes from writing all banks in all channels together, with every bank of one die at the same page number (OCP §11.2.2).',
      },
    ],
    caveats: [
      'Real HBF die floor plans are not public. This one follows published diagrams (FlashAccel Fig. 6c, “HBF Sucks” Fig. 2).',
      'Block colours are illustrative until the simulator is connected.',
      'OCP Table 3 counts 16 banks per channel; this city uses HBFlex’s 32 planes per die. One host channel per die follows OCP §4.3; OCP Fig. 4 shows a channel spanning four dies instead.',
    ],
    sources: [
      { key: 'HBFLEX', where: 'geometry and timing' },
      { key: 'OCP', where: '§4.1, §4.3, §5.4.1, §11.2.2' },
      { key: 'FLASHACC', where: 'Fig. 3, Fig. 6c' },
      { key: 'HBFSUCKS', where: 'Fig. 2' },
    ],
  },

  tsv: {
    title: 'Signal TSVs',
    subtitle: 'the vertical data path',
    tldr: 'Copper vias through every die carry commands and data between the base die and each core die.',
    sections: [
      {
        heading: 'Drawing',
        body: 'Only a sample of columns is drawn. A real stack has thousands of TSVs, and the base die maps failed ones to spares (OCP §4.1).',
      },
    ],
    caveats: ['Columns are sampled and widened for visibility.'],
    sources: [
      { key: 'SANDISK', where: 'Fig. 2' },
      { key: 'HBFSUCKS', where: 'Fig. 2' },
      { key: 'OCP', where: '§4.1' },
    ],
  },

  tsvPower: {
    title: 'Power TSVs',
    subtitle: 'supply columns along the long edges',
    tldr: 'Wide copper vias that deliver power to every core die.',
    caveats: ['Columns are sampled and widened for visibility; their placement follows “HBF Sucks” Fig. 2.'],
    sections: [],
    sources: [{ key: 'HBFSUCKS', where: 'Fig. 2' }],
  },

  gpu: {
    title: 'GPU die',
    subtitle: 'GH100-class, drawn active side up',
    tldr: `${GPU.gpcs} GPCs of ${GPU.tpcsPerGpc * GPU.smsPerTpc} SMs (${GPU.enabledSms} of ${GPU.gpcs * GPU.tpcsPerGpc * GPU.smsPerTpc} enabled on H100/H200 SXM), a ${GPU.l2MiB} MB L2, and memory PHYs on both long edges, here facing six HBF stacks.`,
    facts: [
      { label: 'SMs enabled', value: `${GPU.enabledSms} of ${GPU.gpcs * GPU.tpcsPerGpc * GPU.smsPerTpc}`, source: 'GH100 whitepaper' },
      { label: 'L2', value: `${GPU.l2MiB} MB`, source: 'GH100 whitepaper' },
      { label: 'Die drawn', value: `${GPU.dieMm.width} × ${GPU.dieMm.length} mm`, source: 'estimate (GH100 ≈ 814 mm²)' },
      { label: 'HBF per GPU', value: `${HBF.stacksPerGpu} stacks, ${fmtBytes(stackBytes() * HBF.stacksPerGpu, 0)}`, source: 'HBFlex' },
    ],
    sections: [
      {
        heading: 'Active side up',
        body:
          'On the package the GPU is flip-chip mounted: its transistors face down onto the interposer and its top is bare silicon. The city keeps the circuits at the bottom, where they are, and draws the silicon above them as a ghost volume as tall as the stacks.',
      },
      {
        heading: 'In LLM serving',
        body:
          'Every decode step reads all the weights it uses and each request’s KV cache. With HBF those reads come from flash, so the GPU must request them ahead of use to hide microsecond read latency.',
      },
    ],
    caveats: ['The floor plan is approximate, after the GH100 block diagram; it is not a die photo. Which SMs are disabled varies by chip; the pattern drawn is an example.'],
    sources: [
      { key: 'GH100', where: 'architecture overview' },
      { key: 'HBFLEX', where: 'six stacks per GPU' },
    ],
  },

  bulk: {
    title: 'Bulk silicon',
    subtitle: 'the back of a flip-chip die',
    tldr: 'The GPU’s substrate silicon above its circuits. The GPU and the stacks end at about the same height so one lid or cold plate covers them.',
    sections: [],
    caveats: ['Drawn translucent so the circuits beneath stay visible. Toggle it in the toolbar.'],
    sources: [{ key: 'OCP', where: '§10.3 (stack height)' }],
  },

  gpc: {
    title: 'Graphics processing cluster',
    subtitle: `${GPU.tpcsPerGpc} TPCs × ${GPU.smsPerTpc} SMs`,
    tldr: 'Each SM has four tensor cores, one per sub-partition, and a combined L1 cache and shared memory. Dark roofs are SMs fused off for yield.',
    sections: [],
    caveats: ['SM blocks are raised for legibility; the real active layer is microns thick.'],
    sources: [{ key: 'GH100', where: 'GPC and SM structure' }],
  },

  l2: {
    title: 'L2 cache',
    subtitle: `${GPU.l2MiB} MB in two partitions`,
    tldr: 'On-chip SRAM between the memory controllers and the SMs, split into two partitions joined by a crossbar.',
    sections: [],
    sources: [{ key: 'GH100', where: 'memory hierarchy' }],
  },

  gpuPhy: {
    title: 'HBF PHY on the GPU',
    subtitle: '16 UCIe modules facing one stack',
    tldr: 'The GPU end of one stack’s sixteen host channels. Each module faces its partner on the stack’s base die across the interposer.',
    sections: [],
    sources: [{ key: 'OCP', where: '§4.3, §4.5' }],
  },

  gpuMc: {
    title: 'Memory controller',
    subtitle: 'one per stack',
    tldr:
      'Issues the AXI reads and writes for one stack. HBF runs no garbage collection, so the serving software decides placement and reclamation and the controller carries them out.',
    sections: [],
    caveats: ['Drawn as one block per stack; real controllers are split per channel.'],
    sources: [{ key: 'OCP', where: '§5.2, §11.4' }],
  },

  nvlink: {
    title: 'NVLink',
    subtitle: '18 links to other GPUs',
    tldr: 'GPU-to-GPU links for tensor- and expert-parallel traffic when a model is served across several GPUs.',
    sections: [],
    sources: [{ key: 'GH100', where: 'NVLink' }],
  },

  host: {
    title: 'Host interface',
    subtitle: 'PCIe to the CPU',
    tldr: 'Where serving requests and their tokens enter the GPU from the host.',
    sections: [],
    sources: [{ key: 'GH100', where: 'host interface' }],
  },

  interposer: {
    title: 'Silicon interposer',
    subtitle: 'the ground level of the city',
    tldr: 'A silicon slab carrying the fine wiring between the GPU and the six stacks. Its top surface is y = 0 in the city.',
    facts: [
      { label: 'Thickness drawn', value: '100 µm', source: 'estimate' },
      { label: 'UCIe bump pitch', value: '45 µm', source: 'OCP §10.1' },
    ],
    sections: [],
    caveats: ['The gap between the GPU and each stack is drawn about 1.6 mm; real parts sit roughly 1 mm apart.'],
    sources: [
      { key: 'SANDISK', where: 'Fig. 2' },
      { key: 'OCP', where: '§10.1' },
    ],
  },

  substrate: {
    title: 'Package substrate',
    subtitle: 'organic substrate and decoupling capacitors',
    tldr: 'Carries the interposer on C4 bumps and spreads power and I/O to the board. The capacitors around the interposer steady the supply.',
    sections: [],
    caveats: ['Substrate size, cap placement and C4 height are estimates. Cap heights follow 0201 parts and scale with the vertical exaggeration.'],
    sources: [{ key: 'SANDISK', where: 'Fig. 2' }],
  },

  ucie: {
    title: 'UCIe host channels',
    subtitle: 'sixteen per stack',
    tldr: 'Sixteen independent x64 channels per stack at 32 GT/s, not synchronous with one another. One lane is drawn per channel.',
    facts: [
      { label: 'Raw per channel', value: fmtRate(ucieChannelRawBps()), source: 'OCP Table 2' },
      { label: 'Effective per stack', value: fmtRate(ucieStackEffectiveBps()), source: 'OCP Table 2' },
    ],
    sections: [],
    sources: [{ key: 'OCP', where: '§4.3, §4.5, Table 2' }],
  },
}

export function docFor(key: string): ComponentDoc | undefined {
  return DOCS[key]
}

/** Every simplification the city makes, for the "How much to trust this" sheet. */
export const TRUST_NOTES: readonly string[] = [
  'This is a model, not a die photo. HBF floor plans inside the stack are not public; they follow published diagrams.',
  'Heights are exaggerated 12× by default (toolbar: true proportions). Circuit blocks are raised for legibility.',
  'Opening a stack and lifting a die are viewing aids; bonded dies sit microns apart.',
  'Block colours are illustrative. No simulator drives them yet.',
  'The GPU is drawn active side up; on a real package it faces down onto the interposer.',
  'Gaps between dies on the interposer are widened slightly; mold compound is not drawn.',
]
