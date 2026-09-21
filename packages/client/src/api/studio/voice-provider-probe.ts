import { request as defaultRequest } from '../client'
import type { VoiceApiKind, VoiceApiProviderCompatibility } from '@/types/voice-api'

export interface VoiceProviderProbeRequest {
  kind: VoiceApiKind
  provider: string
  compatibility: VoiceApiProviderCompatibility
  baseUrl: string
  apiKey: string
  signal?: AbortSignal
}

export interface VoiceProviderProbeModel {
  id: string
  label: string
  capability?: 'preferred' | 'other'
}

export interface VoiceProviderProbeResponse {
  ok: boolean
  models: VoiceProviderProbeModel[]
  recommendedModel: string
  errorSummary?: string
  errorDetails?: string
  manualModelAllowed: boolean
  normalizedBaseUrl?: string
}


export function createApi(request: typeof defaultRequest = (...args) => defaultRequest(...args)) {
  async function probeVoiceProvider(req: VoiceProviderProbeRequest): Promise<VoiceProviderProbeResponse> {
    return request<VoiceProviderProbeResponse>('/api/voice/providers/probe', {
      method: 'POST',
      signal: req.signal,
      body: JSON.stringify({
        kind: req.kind,
        provider: req.provider,
        compatibility: req.compatibility,
        baseUrl: req.baseUrl,
        apiKey: req.apiKey,
      }),
    })
  }

  return { probeVoiceProvider }
}

export const { probeVoiceProvider } = createApi()
