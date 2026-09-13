import { openCodeSessionHeaders } from '../../studio/public/opencode-session'
import { fetchProvider, isRetriableProviderConnectFailure } from '../../studio/public/provider-network'
import { setTimeout as delay } from 'node:timers/promises'

/** A provider request issued by a Coding Agent proxy. */
export interface AgentGatewayRequest {
  url: string
  apiKey: string
  sessionId?: string
  provider?: string
  body: unknown
  headers?: Record<string, string>
  proxyUrl?: string
  signal?: AbortSignal
}

export class ProviderApiError extends Error {
  status: number
  providerError: unknown

  constructor(status: number, providerError: unknown, message: string) {
    super(message)
    this.name = 'ProviderApiError'
    this.status = status
    this.providerError = providerError
  }
}

export class AgentRunGateway {
  async completeJson<T = any>(request: AgentGatewayRequest): Promise<T> {
    const res = await this.post(request)
    const data = await readProviderJson(res)
    if (!res.ok) throwProviderError(res, data)
    return data as T
  }

  async streamBytes(request: AgentGatewayRequest): Promise<AsyncIterable<Uint8Array>> {
    const res = await this.post(request)
    if (!res.ok) {
      const data = await readProviderJson(res)
      throwProviderError(res, data)
    }
    const contentType = res.headers.get('content-type') || ''
    if (contentType && !/text\/event-stream|application\/x-ndjson|octet-stream/i.test(contentType)) {
      const data = await readProviderJson(res)
      throwProviderError(res, data)
    }
    if (!res.body) throw new Error('Provider returned an empty stream')
    return res.body as any
  }

  private async post(request: AgentGatewayRequest): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      request.signal?.throwIfAborted()
      try {
        return await this.postOnce(request)
      } catch (error) {
        request.signal?.throwIfAborted()
        // Only connection setup failures are safe to replay. Never retry a
        // response, a reset after writing, or an error matched by message text.
        if (attempt >= 3 || !isRetriableProviderConnectFailure(error)) throw error
        await delay(150 * (attempt + 1), undefined, { signal: request.signal })
      }
    }
  }

  private postOnce(request: AgentGatewayRequest): Promise<Response> {
    return fetchProvider(request.url, {
      method: 'POST',
      headers: {
        ...openCodeSessionHeaders(request.url, request.sessionId, request.provider),
        ...(request.apiKey ? { Authorization: `Bearer ${request.apiKey}` } : {}),
        'Content-Type': 'application/json',
        ...request.headers,
      },
      body: JSON.stringify(request.body),
      signal: request.signal,
    }, request.proxyUrl)
  }
}

export async function readProviderJson(res: Response): Promise<any> {
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return { error: { message: text || `Provider returned HTTP ${res.status}` } }
  }
}

export function throwProviderError(res: Response, data: any): never {
  throw new ProviderApiError(
    res.status,
    data,
    data?.error?.message || `Provider returned HTTP ${res.status}`,
  )
}

export const agentRunGateway = new AgentRunGateway()
