import { ModelProviderError, isRetryableStatus } from './errors'
import { randomUUID } from 'node:crypto'
import { openCodeSessionHeaders } from './opencode-session'
import { openRouterAttributionHeaders } from './openrouter-attribution'
import type { ModelProviderConfig, ModelRequest } from './types'

const requestSessions = new WeakMap<ModelRequest, string>()

export function modelRequestHeaders(
  config: ModelProviderConfig,
  request: ModelRequest,
  defaults: Record<string, string> = {},
): HeadersInit {
  let sessionId = typeof request.metadata?.session_id === 'string' ? request.metadata.session_id.trim() : ''
  if (!sessionId) {
    sessionId = requestSessions.get(request) || randomUUID()
    requestSessions.set(request, sessionId)
  }
  return requestHeaders(config, {
    ...openCodeSessionHeaders(config.baseUrl || '', sessionId, config.id),
    ...defaults,
  })
}

export function requestHeaders(config: ModelProviderConfig, defaults: Record<string, string> = {}): HeadersInit {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...openRouterAttributionHeaders(config.baseUrl || '', config.id),
    ...defaults,
    ...config.headers,
  }
  if (config.apiKey) {
    headers.authorization = `Bearer ${config.apiKey}`
  }
  return headers
}

export function abortSignal(timeoutMs?: number, signal?: AbortSignal): AbortSignal | undefined {
  const signals = [
    signal,
    timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
  ].filter(Boolean) as AbortSignal[]
  if (signals.length === 0) return undefined
  if (signals.length === 1) return signals[0]
  return AbortSignal.any(signals)
}

export function providerUrl(config: ModelProviderConfig, fallbackBaseUrl: string, path: string): string {
  const baseUrl = (config.baseUrl ?? fallbackBaseUrl).replace(/\/+$/, '')
  return `${baseUrl}/${path.replace(/^\/+/, '')}`
}

export async function parseResponseJson<T>(provider: string, response: Response): Promise<T> {
  try {
    return await response.json() as T
  } catch (error) {
    throw new ModelProviderError('Model provider returned invalid JSON.', {
      provider,
      statusCode: response.status,
      details: error,
    })
  }
}

const PROVIDER_ERROR_BODY_PREVIEW_CHARS = 500

function errorBodyPreview(body: string): string {
  const collapsed = body.replace(/\s+/g, ' ').trim()
  return collapsed.length > PROVIDER_ERROR_BODY_PREVIEW_CHARS
    ? `${collapsed.slice(0, PROVIDER_ERROR_BODY_PREVIEW_CHARS)}...`
    : collapsed
}

export async function providerHttpError(provider: string, response: Response): Promise<ModelProviderError> {
  // The body can only be read once; reading it twice used to throw inside the
  // catch block, which silently discarded the provider's message and left users
  // with a bare status line for every failure.
  const body = await response.text().catch(() => '')
  const parsed = parseJson<unknown>(body)
  let message = `Model provider request failed with HTTP ${response.status}.`
  if (isPlainRecord(parsed)) {
    if (typeof parsed.error === 'string') {
      message = parsed.error
    } else if (isPlainRecord(parsed.error) && typeof parsed.error.message === 'string') {
      message = parsed.error.message
    } else if (typeof parsed.detail === 'string') {
      message = parsed.detail
    } else if (typeof parsed.message === 'string') {
      message = parsed.message
    }
  } else if (body.trim()) {
    // Non-JSON error pages (gateways, proxies, HTML) still carry the real cause.
    message = `${message} ${errorBodyPreview(body)}`
  }

  return new ModelProviderError(message, {
    provider,
    statusCode: response.status,
    retryable: isRetryableStatus(response.status),
    details: parsed ?? (body || undefined),
  })
}

export async function postJson<TResponse>(
  config: ModelProviderConfig,
  fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>,
  url: string,
  payload: unknown,
  headers: HeadersInit = requestHeaders(config),
  signal?: AbortSignal,
): Promise<TResponse> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: abortSignal(config.timeoutMs, signal),
  })

  if (!response.ok) {
    throw await providerHttpError(config.id, response)
  }

  return parseResponseJson<TResponse>(config.id, response)
}

export async function postStream(
  config: ModelProviderConfig,
  fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>,
  url: string,
  payload: unknown,
  headers: HeadersInit = requestHeaders(config),
  signal?: AbortSignal,
): Promise<Response> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: abortSignal(config.timeoutMs, signal),
  })

  if (!response.ok) {
    throw await providerHttpError(config.id, response)
  }

  return response
}

export async function *readServerSentEvents(response: Response): AsyncIterable<string> {
  if (!response.body) return

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const event = parseServerSentEventLine(line)
        if (event) yield event
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export function parseServerSentEventLine(line: string): string | undefined {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return undefined
  return trimmed.slice(5).trim()
}

export function parseJson<T>(value: string): T | undefined {
  try {
    return JSON.parse(value) as T
  } catch {
    return undefined
  }
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
