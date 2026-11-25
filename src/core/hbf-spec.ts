/* ============================================================================
 * HBF SPEC — every device number the city draws or prints, with its source.
 *
 * One rule: a number that appears in geometry, a label or the inspector comes
 * from this file, and this file says where it came from. Values the public
 * documents do not give are marked `estimate` and the inspector says so.
 *
 * Sources (short keys used in `SOURCES` below and in the inspector):
 *   OCP       OCP HBF Architecture Specification v0.7.0 (03 Aug 2026)
 *   HBFLEX    HBFlex, arXiv 2609.18675 (device geometry and timing)
 *   SANDISK   Ilkbahar, Ramanujan, Coughlin, "High Bandwidth Flash", IEEE
 *             Computer, May 2026 (CBA, 16-die stack, TSVs, logic die)
 *   FLASHACC  FlashAccel, arXiv 2607.10186 (array die over circuit die,
 *             per-plane R/W circuits, TSV strip, base-die controller + SRAM)
 *   HBFSUCKS  "HBF Sucks!", arXiv 2608.11668 (centre signal TSVs, edge power
 *             TSVs, distributed NAND subarrays)
 *   DASH      Kim et al., arXiv 2608.14333 (UCIe-A x64 module width, base-die
 *             scheduler/controller/SRAM)
 * ==========================================================================*/

export type SourceKey = 'OCP' | 'HBFLEX' | 'SANDISK' | 'FLASHACC' | 'HBFSUCKS' | 'DASH' | 'GH100' | 'BAILIAN'

export interface SourceRef {
  key: SourceKey
  label: string
  /** Public URL when one exists. Omitted rather than guessed. */
  url?: string
}

export const SOURCES: Record<SourceKey, SourceRef> = {
  OCP: { key: 'OCP', label: 'OCP HBF Architecture Specification v0.7.0 (Aug 2026)' },
  HBFLEX: { key: 'HBFLEX', label: 'HBFlex, arXiv 2609.18675', url: 'https://arxiv.org/abs/2609.18675' },
  SANDISK: {
    key: 'SANDISK',
    label: 'Ilkbahar et al., "High Bandwidth Flash", IEEE Computer, May 2026',
  },
  FLASHACC: { key: 'FLASHACC', label: 'FlashAccel, arXiv 2607.10186', url: 'https://arxiv.org/abs/2607.10186' },
  HBFSUCKS: { key: 'HBFSUCKS', label: '"HBF Sucks!", arXiv 2608.11668', url: 'https://arxiv.org/abs/2608.11668' },
  DASH: { key: 'DASH', label: 'DASH, arXiv 2608.14333', url: 'https://arxiv.org/abs/2608.14333' },
  GH100: { key: 'GH100', label: 'NVIDIA H100 Tensor Core GPU Architecture whitepaper (GH100)' },
  BAILIAN: {
    key: 'BAILIAN',
    label: 'Wang et al., "KVCache Cache in the Wild", USENIX ATC 2025 (Qwen-Bailian usage traces)',
  },
}

/* ---------------------------------------------------------------------------
 * The stack.
 * -------------------------------------------------------------------------*/

export const HBF = {
  /** HBFlex's H200-class GPU carries six stacks (three per side). */
  stacksPerGpu: 6,
  /** OCP §4.1 "Supports 16 NAND die stack"; §4.3 "The Core die contains 16 NAND dies". */
  diesPerStack: 16,
  /** OCP §4.1 / §4.5: 16 independent host channels per stack. */
  channelsPerStack: 16,
  /** HBFlex geometry. OCP Table 3 instead lists 16 banks per channel. */
  planesPerDie: 32,
  /** HBFlex geometry. */
  blocksPerPlane: 512,
  /** HBFlex geometry. */
  pagesPerBlock: 512,
  /** OCP §4.1 "4KiB NAND page size". */
  pageBytes: 4096,
  /** HBFlex: 4 µs page read (tR). */
  readUs: 4,
  /** HBFlex: 75 µs page program (tPROG). */
  programUs: 75,
  /** SLC endurance assumed by HBFlex and FlashAccel §2.3. */
  peCycles: 100_000,
  /** estimate: block erase time, typical of SLC NAND */
  eraseUs: 1_500,
  /** HBFlex: 40 MiB of base-die SRAM per stack. */
  baseDieSramMiB: 40,
  /** OCP §10.3: approximate footprint and nominal height. */
  footprintMm: { width: 10.975, length: 16 },
  heightUm: 775,
} as const

/** OCP Table 2: UCIe host interface. */
export const UCIE = {
  gtPerS: 32,
  lanesPerChannel: 64,
  efficiency: 0.75,
  /** DASH §IV-A: one UCIe-A x64 module is about 0.389 mm wide. */
  moduleWidthMm: 0.389,
} as const

/* ---------------------------------------------------------------------------
 * Physical thicknesses. Only the total is published; the split is an estimate
 * that sums to OCP's 775 µm.
 * -------------------------------------------------------------------------*/

export const THICKNESS_UM = {
  /** estimate */
  baseDie: 60,
  /** estimate: array wafer + CMOS wafer bonded face to face (CBA) */
  coreDie: 36,
  /** estimate: microbump / hybrid-bond layer under each core die */
  bond: 8.7,
  /** typical CoWoS-class silicon interposer; estimate */
  interposer: 100,
} as const

/* ---------------------------------------------------------------------------
 * The GPU (GH100-class; the floor plan is approximate, not a die photo).
 * -------------------------------------------------------------------------*/

/** H200 dense FP8 tensor throughput (NVIDIA datasheet) and an assumed utilisation. */
export const GPU_COMPUTE = { fp8Flops: 1979e12, utilisation: 0.5 } as const

export const GPU = {
  /** Reticle-class die, approximately GH100's 814 mm². */
  dieMm: { width: 26, length: 32 },
  gpcs: 8,
  tpcsPerGpc: 9,
  smsPerTpc: 2,
  /** H100/H200 SXM enable 132 of GH100's 144 SMs. */
  enabledSms: 132,
  l2MiB: 50,
} as const

/* ---------------------------------------------------------------------------
 * Derived quantities. Pure functions so tests can pin the arithmetic.
 * -------------------------------------------------------------------------*/

export const blockBytes = (): number => HBF.pagesPerBlock * HBF.pageBytes
export const planeBytes = (): number => HBF.blocksPerPlane * blockBytes()
export const dieBytes = (): number => HBF.planesPerDie * planeBytes()
export const stackBytes = (): number => HBF.diesPerStack * dieBytes()
export const planesPerStack = (): number => HBF.diesPerStack * HBF.planesPerDie
export const blocksPerStack = (): number => planesPerStack() * HBF.blocksPerPlane

/** Array-limited read bandwidth: every plane senses one page per tR. Bytes/s. */
export const stackArrayReadBps = (): number =>
  (planesPerStack() * HBF.pageBytes) / (HBF.readUs * 1e-6)

/** Array-limited program bandwidth: every plane programs one page per tPROG. */
export const stackArrayProgramBps = (): number =>
  (planesPerStack() * HBF.pageBytes) / (HBF.programUs * 1e-6)

/** OCP Table 2: 32 GT/s x 64 bit = 256 GB/s per channel, raw. */
export const ucieChannelRawBps = (): number => (UCIE.gtPerS * 1e9 * UCIE.lanesPerChannel) / 8

/** OCP Table 2: 16 channels x 256 GB/s x 75 % = 3,072 GB/s effective per stack. */
export const ucieStackEffectiveBps = (): number =>
  ucieChannelRawBps() * HBF.channelsPerStack * UCIE.efficiency

/** Sum of the estimated layer thicknesses; tests pin it to OCP's 775 µm. */
export const stackHeightUm = (): number =>
  THICKNESS_UM.baseDie + HBF.diesPerStack * (THICKNESS_UM.coreDie + THICKNESS_UM.bond)

/**
 * Host channel that owns a core die. OCP §4.3 says each host channel connects
 * to "an independent NAND die"; OCP Fig. 4 shows an alternative where one
 * channel spans four dies. The city draws the first reading.
 */
export const channelOfDie = (die: number): number => die % HBF.channelsPerStack

/** Plane numbering on a die: row 0 is the north half, columns run outward from the GPU. */
export const PLANE_GRID = { rows: 2, cols: 16 } as const
