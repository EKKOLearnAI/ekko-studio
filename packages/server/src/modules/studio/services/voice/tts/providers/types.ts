export type TtsProviderId =
  | 'edge'
  | 'openai'
  | 'custom'
  | 'mimo'
  | 'doubao'
  | 'elevenlabs'
  | 'gemini'
  | 'xai'
  | 'mistral'
  | 'minimax'
  | 'deepinfra'
  | 'siliconflow'
  | 'zhipu'
  | 'fishaudio'
  | 'aliyun'
  | 'openrouter'

export interface TtsSynthesisRequest {
  text: string
  signal?: AbortSignal
  timeoutMs?: number
}

export interface TtsSynthesisResult {
  audio: Buffer
  contentType: string
  engine: string
  provider: TtsProviderId
}

export interface TtsProvider<TOptions extends object = Record<string, unknown>> {
  id: TtsProviderId
  synthesize(req: TtsSynthesisRequest, options: TOptions): Promise<TtsSynthesisResult>
}

export interface OpenaiTtsProviderOptions {
  baseUrl?: string
  apiKey?: string
  model?: string
  voice?: string
  rate?: string
  pitch?: string
  format?: string
  sampleRate?: number
  sample_rate?: number
}

export interface CloudTtsProviderOptions {
  baseUrl?: string
  apiKey?: string
  model?: string
  voice?: string
  language?: string
  sampleRate?: string | number
  bitRate?: string | number
  speed?: string | number
  volume?: string | number
  pitch?: string | number
  emotion?: string
  groupId?: string
  format?: string
}

export type MimoAuthMode = 'api-key' | 'bearer' | 'both'
export type MimoVoiceMode = 'preset' | 'voiceDesign' | 'voiceClone'

export interface MimoTtsProviderOptions {
  baseUrl: string
  apiKey: string
  authMode?: MimoAuthMode
  model: string
  voiceMode?: MimoVoiceMode
  voice?: string
  voiceDesignDesc?: string
  voiceCloneDataUri?: string
  voiceCloneFormat?: 'mp3' | 'wav'
  stylePrompt?: string
  format?: string
}

export interface DoubaoTtsProviderOptions {
  baseUrl?: string
  apiKey: string
  model?: string
  voice?: string
  stylePrompt?: string
  speed?: string | number
  format?: string
  sampleRate?: number
  sample_rate?: number
  mcuPlayback?: boolean
}

export type OpenaiTtsProvider = TtsProvider<OpenaiTtsProviderOptions>
export type MimoTtsProvider = TtsProvider<MimoTtsProviderOptions>
export type DoubaoTtsProvider = TtsProvider<DoubaoTtsProviderOptions>

/**
 * OpenRouter /api/v1/audio/speech（OpenAI 兼容）的 provider 选项。
 *
 * 与通用 openai 兼容 provider 的关键差异：OpenRouter 上不同 TTS 模型的音色语义
 * 完全相反——`deepgram/*` 必须显式传 voice，`fish-audio/*` 传 voice 反而 400。
 * 所以由 provider 内部按模型前缀决定是否附带 voice 字段。
 */
export interface OpenrouterTtsProviderOptions {
  baseUrl?: string
  apiKey?: string
  model?: string
  voice?: string
  speed?: number | string
  /** mp3（默认，浏览器可直接播放）| pcm */
  format?: string
  timeoutMs?: number
  /**
   * stateless 声音克隆的参考音频（data:audio/...;base64,...）。
   * 仅对 supports_voice_cloning=true 的模型生效（fish-audio/s2.1-pro 系）。
   */
  voiceCloneDataUri?: string
}

export type OpenrouterTtsProvider = TtsProvider<OpenrouterTtsProviderOptions>
