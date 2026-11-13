import type { TtsProviderId } from '@/api/studio/tts'
import type { SttProvider } from '@/api/studio/stt-settings'

export type VoiceApiKind = 'tts' | 'stt'

export type VoiceApiProvider = TtsProviderId | SttProvider
export type VoiceApiProviderCompatibility = 'openai-compatible' | 'manual'

export interface VoiceApiPreset {
  id: string
  kind: VoiceApiKind
  provider: VoiceApiProvider
  label: string
  labelKey?: string
  description?: string
  descriptionKey?: string
  baseUrl?: string
  defaultModel?: string
  defaultVoice?: string
  compatibility?: VoiceApiProviderCompatibility
  isBuiltin?: boolean
  isSecretRequired?: boolean
  capabilities?: {
    models?: boolean
    voices?: boolean
    rate?: boolean
    pitch?: boolean
    stylePrompt?: boolean
    voiceDesign?: boolean
    voiceClone?: boolean
    language?: boolean
    speed?: boolean
    sampleRate?: boolean
    bitRate?: boolean
    groupId?: boolean
    volume?: boolean
    emotion?: boolean
    diarize?: boolean
    format?: boolean
    tagAudioEvents?: boolean
  }
}

export interface VoiceApiConnection {
  id: string
  kind: VoiceApiKind
  provider: VoiceApiProvider
  label: string
  baseUrl?: string
  model?: string
  voice?: string
  settings: Record<string, unknown>
  hasSecret: boolean
  isBuiltin?: boolean
  active?: boolean
  available?: boolean
}

export interface VoiceApiSavePayload {
  settings?: Record<string, unknown>
  secrets?: Record<string, string>
}
