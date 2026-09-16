/**
 * OpenRouter TTS 常量（/api/v1/audio/speech，OpenAI 兼容，返回原始音频字节流）。
 *
 * 音色语义按模型分裂——这是接入时最容易踩的坑：
 *   - fish-audio/s2.1-pro-free:free  → 音色由服务端内置，voice 必须留空（填了会 400）
 *   - deepgram/flux-tts:free          → 必须从 FLUX 音色表中选一个（36 个英文音色）
 * 所以 UI 的音色控件必须跟着模型走，不能给一个固定音色下拉。
 *
 * 数据来源：GET https://openrouter.ai/api/v1/models?output_modalities=speech
 * 模型字段仍是可自由输入的（NSelect tag），填任意 OpenRouter TTS 模型 id 都能用，
 * 只是内置推荐的音色表只覆盖下面登记过的模型。
 */

export interface OpenrouterTtsModel {
  id: string
  label: string
  /** 是否需要显式指定 voice */
  requiresVoice: boolean
  /** 是否支持 stateless 声音克隆（依据 endpoints API 的 supports_voice_cloning） */
  supportsVoiceCloning?: boolean
  free?: boolean
}

export const OPENROUTER_TTS_MODELS: OpenrouterTtsModel[] = [
  {
    id: 'fish-audio/s2.1-pro-free:free',
    label: 'Fish Audio S2.1 Pro Free（免费 · 内置音色 · 支持克隆）',
    requiresVoice: false,
    supportsVoiceCloning: true,
    free: true,
  },
  {
    id: 'deepgram/flux-tts:free',
    label: 'Deepgram Flux TTS（免费 · 需选音色 · 不支持克隆）',
    requiresVoice: true,
    supportsVoiceCloning: false,
    free: true,
  },
]

export const OPENROUTER_DEFAULT_MODEL = 'fish-audio/s2.1-pro-free:free'
export const OPENROUTER_DEFAULT_FLUX_VOICE = 'flux-alexis-en'

/** deepgram/flux-tts:free 的全部音色（英文） */
export const OPENROUTER_FLUX_VOICES: string[] = [
  'flux-alexis-en',
  'flux-bree-en',
  'flux-brittany-en',
  'flux-brooke-en',
  'flux-bruce-en',
  'flux-cliff-en',
  'flux-cole-en',
  'flux-colin-en',
  'flux-conor-en',
  'flux-donovan-en',
  'flux-drew-en',
  'flux-elise-en',
  'flux-gemma-en',
  'flux-haley-en',
  'flux-hannah-en',
  'flux-heather-en',
  'flux-jack-en',
  'flux-kai-en',
  'flux-kelsey-en',
  'flux-kit-en',
  'flux-maeve-en',
  'flux-marcelo-en',
  'flux-marcus-en',
  'flux-meena-en',
  'flux-meghan-en',
  'flux-miles-en',
  'flux-naveen-en',
  'flux-paige-en',
  'flux-priya-en',
  'flux-rufus-en',
  'flux-sean-en',
  'flux-sharon-en',
  'flux-sienna-en',
  'flux-tanner-en',
  'flux-wade-en',
  'flux-wes-en',
]

/** 已知模型的音色表；未登记模型返回 null，UI 退回自由输入 */
const OPENROUTER_VOICE_SETS: Record<string, string[]> = {
  'deepgram/flux-tts:free': OPENROUTER_FLUX_VOICES,
}

export function openrouterVoiceSetForModel(modelId: string): string[] | null {
  return OPENROUTER_VOICE_SETS[modelId.trim()] || null
}

/**
 * 该模型是否需要显式 voice。
 * 未登记的模型按"需要"处理（让服务端/OpenRouter 给出明确报错，而不是静默失败）。
 */
export function openrouterModelRequiresVoice(modelId: string): boolean {
  const found = OPENROUTER_TTS_MODELS.find(m => m.id === modelId.trim())
  if (found) return found.requiresVoice
  return !modelId.trim().startsWith('fish-audio/')
}

/**
 * 是否支持 stateless 声音克隆。
 * 未登记模型按前缀猜（与服务端 VOICE_CLONING_MODEL_PREFIXES 保持一致）：
 * 只有 fish-audio/s2.1-pro 系支持（s2-pro 不支持）。
 */
export function openrouterModelSupportsCloning(modelId: string): boolean {
  const model = modelId.trim()
  const found = OPENROUTER_TTS_MODELS.find(m => m.id === model)
  if (found) return found.supportsVoiceCloning === true
  return model.startsWith('fish-audio/s2.1-pro')
}

/** 参考音频大小上限：与 mimo 克隆一致取 10MiB（OpenRouter 硬上限为解码后 15MiB） */
export const OPENROUTER_CLONE_AUDIO_MAX_BYTES = 10 * 1024 * 1024
export const OPENROUTER_CLONE_AUDIO_ACCEPT = 'audio/mpeg,audio/mp3,audio/wav,audio/x-wav,.mp3,.wav'
