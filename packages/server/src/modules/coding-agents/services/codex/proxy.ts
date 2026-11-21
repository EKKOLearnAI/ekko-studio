import { geminiToResponses, responsesToGemini, responsesEventsToGemini } from '../antigravity/gemini-adapter'
import { portableResponsesRequest, portableResponsesResult, portableResponsesEvents } from '../../protocol/adapters/portable-responses'
import { isNativeCodingAgent } from '../../../studio/contracts/agents/native-coding-agents'
import { chatCompletionsToResponses, responsesToChatCompletion, responsesToChatCompletionSse } from '../../protocol/adapters/chat-completions'
import { Readable } from 'stream'
import type { Context } from 'koa'
import { config } from '../../../studio/public/config'
import { gatewayToken } from '../../../studio/public/model-gateway-adapters'
import type { CodexRequestAffinity } from '../../../studio/public/provider-http'
import {
  anthropicMessagesUrl as resolveAnthropicMessagesUrl,
  chatCompletionsUrl as resolveChatCompletionsUrl,
  responsesUrl as resolveResponsesUrl,
} from '../../protocol/endpoint-resolver'
import { sseEvent } from '../../protocol/sse'
import { AgentTargetRegistry, type AgentTargetInput, type RegisteredAgentTarget } from '../../protocol/target-registry'
import type { ApiMode } from '../../protocol/types'
import {
  responseMcpToolRoutes,
  anthropicMessageToResponses,
  openAiChatToResponses,
  responsesToAnthropicMessages,
  responsesToOpenAiChat,
  stripHistoricalResponsesInlineImages,
  targetReasoningEffort,
  truncateResponsesToolOutputs,
} from '../../protocol/adapters/responses'
import {
  anthropicMessagesSseToResponsesEvents,
  normalizeResponsesSseEvents,
  openAiChatSseToResponsesEvents,
  openAiResponsesSseToResponsesEvents,
  type CanonicalResponsesEvent,
} from '../../protocol/adapters/responses-stream'
import { agentRunGateway, codexRequestAffinity } from '../../protocol/gateway'
import { codingAgentRunManager } from '../runtime/run-manager'
import { codingAgentOutputLimit } from '../context-policy'
import { normalizeTokenUsage } from '../../../studio/public/usage'

export interface CodexProxyTargetInput extends AgentTargetInput {
  profile: string
}

type CodexProxyTarget = RegisteredAgentTarget<CodexProxyTargetInput> & { codexAffinity?: CodexRequestAffinity }

function recordTargetUsage(target: CodexProxyTarget, event: CanonicalResponsesEvent, apiDuration?: number, baseUrl?: string) {
  if (target.onUsageEvent) target.onUsageEvent(event, apiDuration, baseUrl)
  else codingAgentRunManager.handleProxyUsageEvent(target.agentSessionId, event, apiDuration, baseUrl)
}

const targetRegistry = new AgentTargetRegistry<CodexProxyTargetInput>(
  input => [input.profile.trim(), input.provider, input.model, input.apiMode, input.baseUrl, input.agentSessionId || '', input.chatSessionId || ''],
)

function localProxyBaseUrl(): string {
  return `http://127.0.0.1:${config.port}/api/ekko-studio/models/v1`
}

export function registerCodexProxyTarget(input: CodexProxyTargetInput, persisted?: { token: string }): { baseUrl: string; token: string; routeKey: string } {
  const target = targetRegistry.register({
    ...input,
    profile: input.profile.trim(),
  }, persisted)

  return { baseUrl: localProxyBaseUrl(), token: target.token, routeKey: target.routeKey }
}

export function revokeCodexProxyTarget(routeKey: string): number { return targetRegistry.removeWhere(target => target.routeKey === routeKey) }

export function isAuthorizedCodexProxyRequest(ctx: Context): boolean {
  return Boolean(targetRegistry.findByToken(gatewayToken(ctx)))
}

function requireTarget(ctx: Context): CodexProxyTarget | null {
  const target = targetRegistry.find(String(ctx.params.key || '')) || targetRegistry.findByToken(gatewayToken(ctx))
  if (!target) {
    ctx.status = 404
    ctx.body = { error: { type: 'not_found_error', message: 'Codex proxy target not found' } }
    return null
  }
  if (gatewayToken(ctx) !== target.token && (ctx.state as any).modelGatewayTarget !== target.routeKey) {
    ctx.status = 401
    ctx.body = { error: { type: 'authentication_error', message: 'Invalid Codex proxy token' } }
    return null
  }
  return { ...target, reasoningCodec: (ctx.state as any).modelGatewayReasoningCodec, requestHeaders: { ...(ctx.get('anthropic-beta') ? { 'anthropic-beta': ctx.get('anthropic-beta') } : {}), ...(ctx.get('anthropic-version') ? { 'anthropic-version': ctx.get('anthropic-version') } : {}) }, signal: (ctx.state as any).modelGatewaySignal || target.signal,
    codexAffinity: target.apiMode === 'codex_responses' ? codexRequestAffinity(ctx, target) : undefined }
}

function chatCompletionsUrl(target: CodexProxyTarget): string {
  return resolveChatCompletionsUrl(target.baseUrl)
}

function anthropicMessagesUrl(target: CodexProxyTarget): string {
  return resolveAnthropicMessagesUrl(target.baseUrl)
}

export function normalizeGrokResponsesRequest(body: any): any {
  if (!body || typeof body !== 'object') return body
  let changed = false
  const input = Array.isArray(body.input) ? body.input.map((item: any) => {
    if (!item || typeof item !== 'object' || item.role !== 'system') return item
    changed = true
    return { ...item, role: 'developer' }
  }) : body.input
  const normalized = changed ? { ...body, input } : body
  if (!Object.prototype.hasOwnProperty.call(normalized, 'max_output_tokens')) return normalized
  const { max_output_tokens: _maxOutputTokens, ...withoutMaxOutputTokens } = normalized
  return withoutMaxOutputTokens
}

function needsPortableResponses(target: CodexProxyTarget): boolean {
  return target.provider === 'xai-oauth' || /^https:\/\/api\.x\.ai(?:\/|$)/i.test(target.baseUrl)
}

function withoutNullReasoningContent(body: any): any {
  if (!Array.isArray(body?.input)) return body
  const input = body.input.map((item: any) => {
    if (item?.type !== 'reasoning' || item.content !== null) return item
    // Grok rejects encrypted reasoning replay when the optional content field is null.
    const { content: _content, ...reasoning } = item
    return reasoning
  })
  return { ...body, input }
}

function nativeResponsesBody(target: CodexProxyTarget, body: any, stream?: boolean): any {
  const original = target.agentId === 'grok' ? normalizeGrokResponsesRequest(body) : body
  const portable = needsPortableResponses(target)
  const grok = portable || target.provider === 'xai' || /(?:^|\/)grok-[^/]+$/i.test(target.model)
  const upstreamBody = grok ? withoutNullReasoningContent(original) : original
  const normalized = portable ? portableResponsesRequest(upstreamBody) : upstreamBody
  const reasoningEffort = targetReasoningEffort(target)
  const routed = {
    ...normalized,
    model: target.model,
    // Scoped clients such as OpenCode may omit effort from their native request.
    ...(reasoningEffort ? { reasoning: { ...normalized?.reasoning, effort: reasoningEffort } } : {}),
    ...(stream === undefined ? {} : { stream }),
  }
  return target.agentId ? truncateResponsesToolOutputs(routed) : routed
}

async function callOpenAiChat(target: CodexProxyTarget, body: any, signal?: AbortSignal): Promise<any> {
  const startedAt = performance.now()
  if (target.apiMode !== 'chat_completions') {
    const err = new Error(`Codex proxy only supports chat_completions targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }
  // Keep the adapter's system role: Chat Completions providers such as
  // DeepSeek reject developer messages, regardless of the originating agent.
  const chatBody = responsesToOpenAiChat(body, target)
  const response = await agentRunGateway.completeJson({
    url: chatCompletionsUrl(target),
    apiKey: target.apiKey,
    ownerUserId: target.ownerUserId, profile: target.profile, model: target.model,
    sessionId: target.chatSessionId || target.agentSessionId || target.routeKey,
    provider: target.provider,
    body: chatBody,
    signal: signal || target.signal,
  })
  recordTargetUsage(target, { type: 'response.completed', data: { response } }, (performance.now() - startedAt) / 1000, target.baseUrl)
  return response
}

async function callAnthropicMessages(target: CodexProxyTarget, body: any, signal?: AbortSignal): Promise<any> {
  const startedAt = performance.now()
  if (target.apiMode !== 'anthropic_messages') {
    const err = new Error(`Codex proxy Anthropic adapter only supports anthropic_messages targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }
  const anthropicBody = responsesToAnthropicMessages(body, anthropicAdapterTarget(target))
  const response = await agentRunGateway.completeJson({
    url: anthropicMessagesUrl(target),
    apiKey: target.apiKey,
    ownerUserId: target.ownerUserId, profile: target.profile, model: target.model,
    sessionId: target.chatSessionId || target.agentSessionId || target.routeKey,
    provider: target.provider,
    headers: {
      ...(target.apiKey ? { 'x-api-key': target.apiKey } : {}),
      'anthropic-version': '2023-06-01',
      ...target.requestHeaders,
    },
    body: anthropicBody,
    signal: signal || target.signal,
  })
  recordTargetUsage(target, { type: 'response.completed', data: { response } }, (performance.now() - startedAt) / 1000, target.baseUrl)
  return response
}

async function callOpenAiResponses(target: CodexProxyTarget, body: any, signal?: AbortSignal): Promise<any> {
  const startedAt = performance.now()
  if (target.apiMode !== 'codex_responses') {
    const err = new Error(`Codex proxy Responses adapter only supports codex_responses targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }
  const responsesBody = nativeResponsesBody(target, body)
  const response = await agentRunGateway.completeJson({
    url: resolveResponsesUrl(target.baseUrl),
    apiKey: target.apiKey,
    ownerUserId: target.ownerUserId, profile: target.profile, model: target.model,
    sessionId: target.chatSessionId || target.agentSessionId || target.routeKey,
    codexAffinity: target.codexAffinity,
    provider: target.provider,
    body: responsesBody,
    signal: signal || target.signal,
  })
  recordTargetUsage(target, { type: 'response.completed', data: { response } }, (performance.now() - startedAt) / 1000, target.baseUrl)
  return needsPortableResponses(target) ? portableResponsesResult(response, body) : response
}

function responsesEventStream(events: AsyncIterable<CanonicalResponsesEvent>): Readable {
  async function* generate() {
    for await (const event of events) {
      yield sseEvent(event.type, event.data)
    }
  }
  return Readable.from(generate())
}

/** Anthropic Messages requires max_tokens; use the model output budget rather
 * than a fixed small cap when the Responses client did not send one. */
function anthropicAdapterTarget(target: CodexProxyTarget): CodexProxyTarget & { outputLimit?: number } {
  try {
    return { ...target, outputLimit: codingAgentOutputLimit(target) }
  } catch {
    return target
  }
}

/** Responses clients (Codex auto-compaction, OpenCode, chat/Gemini bridges)
 * read canonical usage, where input_tokens includes cached prompt tokens.
 * Emit only the standard fields so vendor extras cannot break strict parsers. */
function responsesClientUsage(target: CodexProxyTarget, usage: unknown): Record<string, unknown> | undefined {
  if (!usage || typeof usage !== 'object') return undefined
  const normalized = normalizeTokenUsage(usage, {}, { inputIncludesCache: target.apiMode !== 'anthropic_messages' })
  if (normalized.isEstimated) return undefined
  const inputTokens = normalized.inputTokens + normalized.cacheReadTokens + normalized.cacheWriteTokens
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: normalized.cacheReadTokens },
    output_tokens: normalized.outputTokens,
    output_tokens_details: { reasoning_tokens: normalized.reasoningTokens },
    total_tokens: inputTokens + normalized.outputTokens,
  }
}

function responseForCodexClient(target: CodexProxyTarget, response: any): any {
  if (!response || typeof response !== 'object') return response
  if (target.apiMode === 'codex_responses' && target.agentId !== 'opencode') return response
  const { usage: rawUsage, ...responseWithoutUsage } = response
  const usage = target.apiMode === 'codex_responses' ? rawUsage : responsesClientUsage(target, rawUsage)
  if (usage) return { ...responseWithoutUsage, usage }
  // OpenCode's OpenAI Responses provider validates `response.completed`
  // usage before it accepts the terminal event. Chat-compatible upstreams
  // are allowed to omit usage, so emit the minimum valid shape. Without this
  // terminal frame OpenCode reports an `unknown` finish reason and starts
  // another agent step forever.
  if (target.agentId === 'opencode') {
    return { ...responseWithoutUsage, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } }
  }
  return responseWithoutUsage
}

function responseEventForCodexClient(target: CodexProxyTarget, event: CanonicalResponsesEvent): CanonicalResponsesEvent {
  if (event.type !== 'response.completed') return event
  return {
    ...event,
    data: {
      ...event.data,
      response: responseForCodexClient(target, (event.data as any).response),
    },
  }
}

function observableResponsesEvents(target: CodexProxyTarget, events: AsyncIterable<CanonicalResponsesEvent>, startedAt: number): AsyncIterable<CanonicalResponsesEvent> {
async function* observe() {
    for await (const event of normalizeResponsesSseEvents(events)) {
      recordTargetUsage(target, event, (performance.now() - startedAt) / 1000, target.baseUrl)
      const clientEvent = responseEventForCodexClient(target, event)
      // Grok, OpenCode and DSH report the same model activity through their native
      // stdout streams. The proxy remains responsible for transport and usage
      // accounting, but must not become a second chat lifecycle source.
      if (target.agentSessionId && !isNativeCodingAgent(target.agentId) && target.agentId !== 'grok' && target.agentId !== 'opencode' && target.agentId !== 'dsh' && target.agentId !== 'antigravity') {
        codingAgentRunManager.handleResponseEvent(target.agentSessionId, clientEvent)
      }
      yield clientEvent
    }
  }
  return observe()
}

async function openAiChatToResponsesSseStream(target: CodexProxyTarget, body: any, startedAt = performance.now()): Promise<Readable> {
  if (target.apiMode !== 'chat_completions') {
    const err = new Error(`Codex proxy only supports chat_completions targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }

  const chatBody = responsesToOpenAiChat(body, target, true)
  const stream = await agentRunGateway.streamBytes({
    url: chatCompletionsUrl(target),
    apiKey: target.apiKey,
    ownerUserId: target.ownerUserId, profile: target.profile, model: target.model,
    sessionId: target.chatSessionId || target.agentSessionId || target.routeKey,
    provider: target.provider,
    body: chatBody,
    signal: target.signal,
  })
  return responsesEventStream(observableResponsesEvents(target, openAiChatSseToResponsesEvents(stream, {
    ...target,
    annotateMcpToolNamespaces: true,
    mcpToolRoutes: responseMcpToolRoutes(body),
  }), startedAt))
}

async function anthropicMessagesToResponsesSseStream(target: CodexProxyTarget, body: any, startedAt = performance.now()): Promise<Readable> {
  if (target.apiMode !== 'anthropic_messages') {
    const err = new Error(`Codex proxy Anthropic adapter only supports anthropic_messages targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }

  const anthropicBody = responsesToAnthropicMessages(body, anthropicAdapterTarget(target), true)
  const stream = await agentRunGateway.streamBytes({
    url: anthropicMessagesUrl(target),
    apiKey: target.apiKey,
    ownerUserId: target.ownerUserId, profile: target.profile, model: target.model,
    sessionId: target.chatSessionId || target.agentSessionId || target.routeKey,
    provider: target.provider,
    headers: {
      ...(target.apiKey ? { 'x-api-key': target.apiKey } : {}),
      'anthropic-version': '2023-06-01',
      ...target.requestHeaders,
    },
    body: anthropicBody,
    signal: target.signal,
  })
  return responsesEventStream(observableResponsesEvents(target, anthropicMessagesSseToResponsesEvents(stream, {
    ...target,
    annotateMcpToolNamespaces: true,
    mcpToolRoutes: responseMcpToolRoutes(body),
  }), startedAt))
}

async function openAiResponsesSseStream(target: CodexProxyTarget, body: any, startedAt = performance.now()): Promise<Readable> {
  if (target.apiMode !== 'codex_responses') {
    const err = new Error(`Codex proxy Responses adapter only supports codex_responses targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }

  const responsesBody = nativeResponsesBody(target, body, true)
  const stream = await agentRunGateway.streamBytes({
    url: resolveResponsesUrl(target.baseUrl),
    apiKey: target.apiKey,
    ownerUserId: target.ownerUserId, profile: target.profile, model: target.model,
    sessionId: target.chatSessionId || target.agentSessionId || target.routeKey,
    codexAffinity: target.codexAffinity,
    provider: target.provider,
    body: responsesBody,
    signal: target.signal,
  })
  const events = openAiResponsesSseToResponsesEvents(stream)
  return responsesEventStream(observableResponsesEvents(target, needsPortableResponses(target) ? portableResponsesEvents(events, body) : events, startedAt))
}

export async function codexProxyResponses(ctx: Context) {
  const target = requireTarget(ctx)
  if (target) await respondWithCodexTarget(ctx, target)
}

async function respondWithCodexTarget(ctx: Context, target: CodexProxyTarget) {
  try {
    // Sanitize once before API-mode dispatch so native Responses, Chat
    // Completions, and Anthropic adapters all receive the same bounded history.
    const sanitizedBody = target.agentId ? stripHistoricalResponsesInlineImages(ctx.request.body || {}) : ctx.request.body || {}
    const requestBody = target.agentId === 'grok'
      ? normalizeGrokResponsesRequest(sanitizedBody)
      : sanitizedBody
    if ((requestBody as any).stream === true) {
      const stream = target.apiMode === 'anthropic_messages'
        ? await anthropicMessagesToResponsesSseStream(target, requestBody)
        : target.apiMode === 'codex_responses'
          ? await openAiResponsesSseStream(target, requestBody)
          : await openAiChatToResponsesSseStream(target, requestBody)
      ctx.set('Content-Type', 'text/event-stream; charset=utf-8')
      ctx.set('Cache-Control', 'no-cache')
      ctx.body = stream
    } else {
      ctx.body = responseForCodexClient(target, target.apiMode === 'anthropic_messages'
        ? anthropicMessageToResponses(await callAnthropicMessages(target, requestBody), { ...target, mcpToolRoutes: responseMcpToolRoutes(requestBody) })
        : target.apiMode === 'codex_responses'
          ? await callOpenAiResponses(target, requestBody)
          : openAiChatToResponses(await callOpenAiChat(target, requestBody), { ...target, mcpToolRoutes: responseMcpToolRoutes(requestBody) }))
    }
  } catch (err: any) {
    ctx.status = err.status || 502
    ctx.body = {
      error: {
        type: 'api_error',
        message: err?.message || 'Codex proxy request failed',
        provider_error: err?.providerError,
      },
    }
  }
}

export async function codingAgentProxyChatCompletions(ctx: Context) {
  const target = requireTarget(ctx)
  if (!target) return
  const requestBody = ctx.request.body as any || {}
  try {
    if (target.apiMode === 'chat_completions') {
      const started = performance.now()
      const nativeBody = { ...requestBody, model: target.model }
      const request = { url: chatCompletionsUrl(target), apiKey: target.apiKey,
        ownerUserId: target.ownerUserId, profile: target.profile, model: target.model, provider: target.provider,
        sessionId: target.chatSessionId || target.agentSessionId || target.routeKey,
        body: nativeBody, signal: target.signal }
      if (requestBody.stream === true) {
        const source = await agentRunGateway.streamBytes(request)
        ctx.set('Content-Type', 'text/event-stream; charset=utf-8')
        ctx.set('Cache-Control', 'no-cache')
        ctx.body = Readable.from((async function* () {
          const decoder = new TextDecoder()
          let buffer = ''
          let usage: unknown
          try {
            for await (const chunk of source) {
              buffer += decoder.decode(chunk, { stream: true })
              let boundary: RegExpExecArray | null
              while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
                for (const line of buffer.slice(0, boundary.index).split(/\r?\n/)) if (line.startsWith('data:')) {
                  try { const data = JSON.parse(line.slice(5)); if (data.usage) usage = data.usage } catch { /* SSE control frame */ }
                }
                buffer = buffer.slice(boundary.index + boundary[0].length)
              }
              if (buffer.length > 32 * 1024 * 1024) throw new Error('Provider SSE event exceeds the gateway limit')
              yield chunk
            }
          } finally {
            if (usage) recordTargetUsage(target, { type: 'response.completed', data: { response: { model: target.model, usage } } }, (performance.now() - started) / 1000, target.baseUrl)
          }
        })())
      } else {
        ctx.body = await agentRunGateway.completeJson(request)
        recordTargetUsage(target, { type: 'response.completed', data: { response: ctx.body } }, (performance.now() - started) / 1000, target.baseUrl)
      }
      return
    }
    ctx.request.body = chatCompletionsToResponses(requestBody)
    await respondWithCodexTarget(ctx, target)
    if (ctx.status >= 400) return
    if (requestBody.stream === true) {
      const source = ctx.body as AsyncIterable<Uint8Array | string>
      async function* bytes() { for await (const chunk of source) yield typeof chunk === 'string' ? Buffer.from(chunk) : chunk }
      const stream = bytes()
      ctx.body = Readable.from(responsesToChatCompletionSse(openAiResponsesSseToResponsesEvents(stream), target.model,
        requestBody.stream_options?.include_usage === true))
    } else ctx.body = responsesToChatCompletion(ctx.body, target.model)
  } catch (err: any) {
    ctx.status = err.status || 502
    ctx.body = { error: { type: 'api_error', message: err.message || 'Coding agent proxy request failed' } }
  } finally {
    ctx.request.body = requestBody
  }
}

/** Antigravity issues Gemini requests (including auxiliary title models). The
 * registered scoped target always selects the Studio model, never the URL model. */
export async function antigravityProxyGenerate(ctx: Context) {
  const target = requireTarget(ctx)
  if (!target) return
  if (!/^.+:(?:streamGenerateContent|generateContent)$/.test(String(ctx.params.operation))) { ctx.status = 400; ctx.body = { error: { message: 'Unsupported Gemini operation' } }; return }
  const abort = new AbortController()
  const onClose = () => { if (!ctx.res.writableEnded) abort.abort() }
  ctx.res.once('close', onClose)
  const timeout = setTimeout(() => abort.abort(), 120_000)
  timeout.unref?.()
  try {
    const body = geminiToResponses(ctx.request.body || {})
    if (String(ctx.params.operation).includes('streamGenerateContent')) {
      body.stream = true
      const stream = target.apiMode === 'anthropic_messages'
        ? await anthropicMessagesToResponsesSseStream(target, body)
        : target.apiMode === 'codex_responses' ? await openAiResponsesSseStream(target, body)
          : await openAiChatToResponsesSseStream(target, body)
      ctx.set('Cache-Control', 'no-cache')
      ctx.set('Content-Type', 'text/event-stream; charset=utf-8')
      ctx.body = Readable.from(responsesEventsToGemini(openAiResponsesSseToResponsesEvents(stream)))
      return
    }
    const response = responseForCodexClient(target, target.apiMode === 'anthropic_messages'
      ? anthropicMessageToResponses(await callAnthropicMessages(target, body, abort.signal), { ...target, mcpToolRoutes: responseMcpToolRoutes(body) })
      : target.apiMode === 'codex_responses'
        ? await callOpenAiResponses(target, body, abort.signal)
        : openAiChatToResponses(await callOpenAiChat(target, body, abort.signal), { ...target, mcpToolRoutes: responseMcpToolRoutes(body) }))
    const payload = responsesToGemini(response)
    ctx.set('Cache-Control', 'no-cache')
    if (String(ctx.params.operation).includes('streamGenerateContent')) {
      ctx.set('Content-Type', 'text/event-stream; charset=utf-8')
      ctx.body = Readable.from([`data: ${JSON.stringify(payload)}\n\n`])
    } else ctx.body = payload
  } catch (err: any) {
    ctx.status = err.status || 502
    ctx.body = { error: { message: err.message || 'Antigravity provider request failed' } }
  } finally { clearTimeout(timeout); ctx.res.off('close', onClose) }
}

export const findCodexProxyByToken = (token: string) => targetRegistry.findByToken(token)

export const findCodexGatewayTarget = (routeKey: string) => targetRegistry.find(routeKey)
