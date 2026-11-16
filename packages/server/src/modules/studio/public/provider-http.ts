import { codexInferenceBody, isCodexInferenceRequest } from '../services/providers/codex-requests'
export { createProviderHttpTransport } from '../services/providers/http-transport'
export { codexInferenceBody, isCodexInferenceRequest, withoutUnsupportedReasoning } from '../services/providers/codex-requests'

export interface ProviderHttpRequest {
  url: string
  apiKey: string
  profile?: string
  ownerUserId?: number
  provider?: string
  model?: string
  sessionId?: string
  body: unknown
  headers?: Record<string, string>
  signal?: AbortSignal
}
let request: ((input: ProviderHttpRequest) => Promise<Response>) | undefined
export const configureProviderHttp = (next: NonNullable<typeof request>) => { request = next }
export function fetchProviderHttp(input: ProviderHttpRequest): Promise<Response> {
  if (!request) throw new Error('Provider HTTP adapter is not configured')
  return request(isCodexInferenceRequest(input) ? { ...input, body: codexInferenceBody(input.body) } : input)
}
