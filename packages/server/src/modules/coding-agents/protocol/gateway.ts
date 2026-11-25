import type { Context } from 'koa'
import { fetchProviderHttp, isCodexInferenceRequest, type ProviderHttpRequest, type ProviderRequestAffinity } from '../../studio/public/provider-http'
import { openAiResponsesSseToResponsesEvents } from './adapters/responses-stream'
import { providerAccountId, providerRequestProfile } from '../../studio/public/provider-account'

/** A provider request issued by a Coding Agent proxy. */
export type AgentGatewayRequest = ProviderHttpRequest

/** Call after target authorization. A routeKey and a requestId identify requests, not sessions. */
export function providerRequestAffinity(ctx: Context, target: { chatSessionId?: string; agentSessionId?: string; agentId?: string }): ProviderRequestAffinity {
  const promptCacheKey = (ctx.request.body as { prompt_cache_key?: unknown } | undefined)?.prompt_cache_key
  const boundSession = ctx.state.modelGateway?.sessionId
  if (boundSession) return { scope: 'bridge', sessionId: boundSession, promptCacheKey }
  const underscored = ctx.get('session_id')
  const hyphenated = ctx.get('session-id')
  const claimed = underscored && hyphenated && underscored !== hyphenated ? '' : underscored || hyphenated
  const sessionId = /^[A-Za-z0-9._~:@/+\-=]{1,256}$/.test(claimed) ? claimed : undefined
  // Plugin targets use agentSessionId for the run. Native targets keep it across continuations.
  const nativeSession = target.agentId && !target.agentId.startsWith('plugin:') ? target.agentSessionId : undefined
  const targetSession = nativeSession || target.chatSessionId || target.agentSessionId
  if (targetSession) {
    return { scope: JSON.stringify(['scoped', target.agentId, target.chatSessionId, targetSession]),
      sessionId: sessionId || targetSession, promptCacheKey }
  }
  const scope = ctx.state.modelApiKey ? JSON.stringify(['share', ctx.state.modelApiKey.id])
    : ctx.state.modelGateway ? 'internal-client' : 'user-api'
  return { scope, sessionId, promptCacheKey }
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
    if (res.ok && isCodexInferenceRequest(request) && !/application\/json/i.test(res.headers.get('content-type') || '')) {
      if (!res.body) throw new Error('Codex returned an empty stream')
      for await (const event of openAiResponsesSseToResponsesEvents(res.body as any)) {
        if (event.type === 'response.completed') return event.data.response as T
        if (['response.failed', 'response.incomplete', 'error'].includes(event.type)) {
          const response = event.data.response as any
          throw new ProviderApiError(502, event.data, response?.error?.message || 'Codex response did not complete')
        }
      }
      throw new Error('Codex stream ended before completion')
    }
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

  private post(request: AgentGatewayRequest): Promise<Response> {
    return fetchProviderHttp({ ...request, ownerUserId: request.ownerUserId || providerAccountId(request.profile), profile: request.profile || providerRequestProfile() })
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
    data?.error?.message || (typeof data?.error === 'string' ? data.error : '') || data?.message || `Provider returned HTTP ${res.status}`,
  )
}

export const agentRunGateway = new AgentRunGateway()
