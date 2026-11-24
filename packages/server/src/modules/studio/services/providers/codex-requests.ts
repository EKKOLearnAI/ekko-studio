import { createHash } from 'node:crypto'
import type { ProviderRequestAffinity } from '../../public/provider-http'

/** ChatGPT subscription inference differs from the public OpenAI API. */
export function withoutUnsupportedReasoning(body: Record<string, any>, reasoning: boolean): Record<string, any> {
  if (reasoning) return body
  const result = { ...body }
  for (const key of ['reasoning', 'reasoning_effort', 'thinking']) delete result[key]
  return result
}

export function isCodexInferenceRequest(input: { provider?: string; url: string }): boolean {
  if (input.provider === 'openai-codex') return true
  try { return /\/backend-api\/codex\/(?:v1\/)?responses\/?$/.test(new URL(input.url).pathname) }
  catch { return false }
}

export function isOfficialCodexResponses(url: string): boolean {
  try {
    const endpoint = new URL(url)
    return endpoint.origin === 'https://chatgpt.com' && !endpoint.username && !endpoint.password
      && /^\/backend-api\/codex\/(?:v1\/)?responses\/?$/.test(endpoint.pathname)
  } catch { return false }
}

function affinityHash(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('base64url')
}

/** Set both identifiers after applying all body and header overrides. */
export function applyCodexAffinity(
  input: { ownerUserId?: number; profile?: string; provider?: string; model?: string; affinity?: ProviderRequestAffinity },
  body: Record<string, unknown>,
  headers: Record<string, string>,
): void {
  for (const name of Object.keys(headers)) {
    if (['session_id', 'session-id', 'x-client-request-id'].includes(name.toLowerCase())) delete headers[name]
  }
  const { affinity } = input
  if (!input.ownerUserId || !affinity) return

  const scope = [input.ownerUserId, input.profile || 'default', input.provider, affinity.scope]
  const session = affinity.sessionId
  if (session) headers.session_id = `studio_s_${affinityHash([...scope, session])}`

  const configuredKey = typeof body.prompt_cache_key === 'string' ? body.prompt_cache_key.trim() : ''
  delete body.prompt_cache_key
  if (!session && !configuredKey) return

  // A caller-provided key still selects a cache affinity within its own account and session.
  // For clients without a key, append-only history and tool results do not affect the generated key.
  const keyParts = configuredKey ? ['explicit', configuredKey] : ['prefix', body.instructions, body.tools]
  const key = `studio_p_${affinityHash([...scope, session, input.model, ...keyParts])}`
  body.prompt_cache_key = key
  headers['x-client-request-id'] = key
}

export function codexInferenceBody(body: unknown): Record<string, any> {
  const request = { ...(body as Record<string, any>) }
  // Match the native Codex ModelClient: this backend is streaming-only and
  // does not accept sampling controls or max_output_tokens.
  for (const key of ['max_output_tokens', 'max_tokens', 'temperature', 'top_p']) delete request[key]
  return {
    ...request,
    input: typeof request.input === 'string'
      ? [{ role: 'user', content: [{ type: 'input_text', text: request.input }] }]
      : request.input,
    instructions: typeof request.instructions === 'string' ? request.instructions : '',
    include: [...new Set([...(Array.isArray(request.include) ? request.include : []), 'reasoning.encrypted_content'])],
    stream: true,
    store: false,
  }
}
