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
