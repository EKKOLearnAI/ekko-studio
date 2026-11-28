import type {
  StoredSttProvider,
  SttStoredSecrets,
  SttStoredSettings,
} from '../../../repositories/stt-settings-store'

export interface SttTranscribeInput {
  provider: StoredSttProvider
  audio: Buffer
  fileName: string
  mimeType: string
  settings: SttStoredSettings
  secrets: SttStoredSecrets
  signal?: AbortSignal
}

export interface SttTranscribeResult {
  text: string
  provider: StoredSttProvider
  model: string
  language?: string
  durationMs: number
}

export class SttNoSpeechDetectedError extends Error {}

/** Provider HTTP failures retain status without parsing a human-facing message. */
export class SttProviderHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'SttProviderHttpError'
  }
}
