/* ============================================================================
 * MODEL PROFILES — derived from the models' public Hugging Face configs.
 *
 * Weights and KV cache take one byte per element (8-bit, as HBFlex assumes),
 * with no scale factors. Parameter counts are rebuilt from the config fields
 * (attention projections, dense and expert FFNs, embeddings and LM head;
 * norms and routers are ignored, < 0.1 %). Tests pin DeepSeek-V3 and Qwen3 to
 * their published sizes and Hunyuan3 to its rebuilt 295 B total, 20.1 B active.
 * ==========================================================================*/

export type ModelId = 'deepseek-v3' | 'qwen3-235b' | 'hunyuan3'

export interface ModelProfile {
  id: ModelId
  name: string
  /** where the numbers come from */
  source: string
  layers: number
  hidden: number
  /** FP8 KV-cache bytes per token, all layers */
  kvBytesPerToken: number
  /** all weight bytes (FP8) */
  weightBytes: number
  /** bytes every token touches: attention, dense FFN, shared experts, LM head */
  alwaysActiveBytes: number
  /** bytes of one routed expert in one layer */
  expertBytes: number
  moeLayers: number
  routedExperts: number
  expertsPerToken: number
}

interface MoeConfig {
  hidden: number
  layers: number
  denseLayers: number
  denseIntermediate: number
  moeIntermediate: number
  routedExperts: number
  sharedExperts: number
  expertsPerToken: number
  vocab: number
  /** attention parameters per layer */
  attentionParams: number
  kvElementsPerTokenPerLayer: number
}

function build(id: ModelId, name: string, source: string, c: MoeConfig): ModelProfile {
  const expert = 3 * c.hidden * c.moeIntermediate
  const moeLayers = c.layers - c.denseLayers
  const attention = c.attentionParams * c.layers
  const dense = c.denseLayers * 3 * c.hidden * c.denseIntermediate
  const shared = moeLayers * c.sharedExperts * expert
  const routed = moeLayers * c.routedExperts * expert
  const embedding = c.vocab * c.hidden
  return {
    id,
    name,
    source,
    layers: c.layers,
    hidden: c.hidden,
    kvBytesPerToken: c.kvElementsPerTokenPerLayer * c.layers,
    weightBytes: attention + dense + shared + routed + 2 * embedding,
    // the input embedding is a row lookup; the LM head is read in full
    alwaysActiveBytes: attention + dense + shared + embedding,
    expertBytes: expert,
    moeLayers,
    routedExperts: c.routedExperts,
    expertsPerToken: c.expertsPerToken,
  }
}

/* DeepSeek-V3: MLA attention. Per layer: q_a 7168x1536, q_b 1536x(128x192),
 * kv_a 7168x(512+64), kv_b 512x(128x256), o (128x128)x7168. KV cache holds the
 * compressed latent (512) plus the decoupled RoPE key (64) per layer. */
const DEEPSEEK_V3 = build('deepseek-v3', 'DeepSeek-V3', 'deepseek-ai/DeepSeek-V3 config.json', {
  hidden: 7168,
  layers: 61,
  denseLayers: 3,
  denseIntermediate: 18432,
  moeIntermediate: 2048,
  routedExperts: 256,
  sharedExperts: 1,
  expertsPerToken: 8,
  vocab: 129280,
  attentionParams: 7168 * 1536 + 1536 * 128 * 192 + 7168 * 576 + 512 * 128 * 256 + 128 * 128 * 7168,
  kvElementsPerTokenPerLayer: 512 + 64,
})

/* Qwen3-235B-A22B: GQA with 64 query heads, 4 KV heads, head dim 128. */
const QWEN3_235B = build('qwen3-235b', 'Qwen3-235B-A22B', 'Qwen/Qwen3-235B-A22B config.json', {
  hidden: 4096,
  layers: 94,
  denseLayers: 0,
  denseIntermediate: 0,
  moeIntermediate: 1536,
  routedExperts: 128,
  sharedExperts: 0,
  expertsPerToken: 8,
  vocab: 151936,
  attentionParams: 4096 * 64 * 128 + 2 * 4096 * 4 * 128 + 64 * 128 * 4096,
  kvElementsPerTokenPerLayer: 2 * 4 * 128,
})

/* Hunyuan3 (hy_v3): GQA with 64 query heads, 8 KV heads; first layer dense. */
const HUNYUAN3 = build('hunyuan3', 'Hunyuan3', 'Tencent Hy3 (hy_v3) config.json, huggingface.co/tencent/Hy3', {
  hidden: 4096,
  layers: 80,
  denseLayers: 1,
  denseIntermediate: 13312,
  moeIntermediate: 1536,
  routedExperts: 192,
  sharedExperts: 1,
  expertsPerToken: 8,
  vocab: 120832,
  attentionParams: 4096 * 64 * 128 + 2 * 4096 * 8 * 128 + 64 * 128 * 4096,
  kvElementsPerTokenPerLayer: 2 * 8 * 128,
})

export const MODELS: Record<ModelId, ModelProfile> = {
  'deepseek-v3': DEEPSEEK_V3,
  'qwen3-235b': QWEN3_235B,
  hunyuan3: HUNYUAN3,
}

/** Bytes a forward pass over `tokens` routed tokens reads from the weights. */
export function weightBytesTouched(m: ModelProfile, tokens: number): number {
  if (tokens <= 0) return 0
  // Expected distinct experts per layer when each token picks k of E uniformly.
  const pMiss = Math.pow(1 - m.expertsPerToken / m.routedExperts, tokens)
  const experts = m.routedExperts * (1 - pMiss)
  return m.alwaysActiveBytes + m.moeLayers * experts * m.expertBytes
}

/** Parameters (= FP8 bytes) used per token: the always-active part plus k experts per MoE layer. */
export function activeBytesPerToken(m: ModelProfile): number {
  return m.alwaysActiveBytes + m.moeLayers * m.expertsPerToken * m.expertBytes
}
