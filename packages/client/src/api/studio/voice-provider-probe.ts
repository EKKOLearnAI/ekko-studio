import { request } from '../client'
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

export async function probeVoiceProvider(req: VoiceProviderProbeRequest): Promise<VoiceProviderProbeResponse> {
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
