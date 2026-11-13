import { transcribeDoubaoFile } from './doubao'
import { transcribeOpenAiCompatible } from './openai'
import { transcribeElevenLabs, transcribeXai } from './hermes-cloud'
import { transcribeWithLocalStt } from './local-model-manager'
import type { SttTranscribeInput, SttTranscribeResult } from './types'

export * from './doubao'
export * from './openai'
export * from './types'

export async function transcribeWithProvider(input: SttTranscribeInput): Promise<SttTranscribeResult> {
  switch (input.provider) {
    case 'local':
      return transcribeWithLocalStt(input)
    case 'openai':
    case 'custom':
    case 'groq':
    case 'mistral':
    case 'deepinfra':
      return transcribeOpenAiCompatible(input)
    case 'xai':
      return transcribeXai(input)
    case 'elevenlabs':
      return transcribeElevenLabs(input)
    case 'doubao':
      return transcribeDoubaoFile(input)
    default:
      throw new Error(`Unsupported STT provider: ${String(input.provider)}`)
  }
}
