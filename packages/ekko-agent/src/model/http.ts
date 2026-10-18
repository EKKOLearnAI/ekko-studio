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

export async function providerHttpError(provider: string, response: Response): Promise<ModelProviderError> {
  let details: unknown
  let message = `Model provider request failed with HTTP ${response.status}.`
  try {
    details = await response.json()
    if (isPlainRecord(details) && typeof details.error === 'string') {
      message = details.error
    } else if (isPlainRecord(details) && isPlainRecord(details.error) && typeof details.error.message === 'string') {
      message = details.error.message
    } else if (isPlainRecord(details) && typeof details.detail === 'string') {
      message = details.detail
    } else if (isPlainRecord(details) && typeof details.message === 'string') {
      message = details.message
    }
  } catch {
    details = await response.text().catch(() => undefined)
  }

  return new ModelProviderError(message, {
    provider,
    statusCode: response.status,
    retryable: isRetryableStatus(response.status),
    details,
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
