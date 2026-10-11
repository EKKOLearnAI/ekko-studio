import { geminiToResponses, responsesToGemini } from '../antigravity/gemini-adapter'
import { isNativeCodingAgent } from '../../../studio/contracts/agents/native-coding-agents'
import { chatCompletionsToResponses, responsesToChatCompletion, responsesToChatCompletionSse } from '../../protocol/adapters/chat-completions'
import { Readable } from 'stream'
import type { Context } from 'koa'
import { config } from '../../../studio/public/config'
import {
  anthropicMessagesUrl as resolveAnthropicMessagesUrl,
  chatCompletionsUrl as resolveChatCompletionsUrl,
  responsesUrl as resolveResponsesUrl,
} from '../../protocol/endpoint-resolver'
import { sseEvent } from '../../protocol/sse'
import { AgentTargetRegistry, type AgentTargetInput, type RegisteredAgentTarget } from '../../protocol/target-registry'
import type { ApiMode } from '../../protocol/types'
import {
  anthropicMessageToResponses,
  openAiChatToResponses,
  responsesToAnthropicMessages,
  responsesToOpenAiChat,
  stripHistoricalResponsesInlineImages,
  truncateResponsesToolOutputs,
} from '../../protocol/adapters/responses'
import {
  anthropicMessagesSseToResponsesEvents,
  normalizeResponsesSseEvents,
  openAiChatSseToResponsesEvents,
  openAiResponsesSseToResponsesEvents,
  type CanonicalResponsesEvent,
} from '../../protocol/adapters/responses-stream'
import { agentRunGateway } from '../../protocol/gateway'
import { codingAgentRunManager } from '../runtime/run-manager'
import { codingAgentOutputLimit } from '../context-policy'
import { normalizeTokenUsage } from '../../../studio/public/usage'

export interface CodexProxyTargetInput extends AgentTargetInput {
  profile: string
}

type CodexProxyTarget = RegisteredAgentTarget<CodexProxyTargetInput>

const targetRegistry = new AgentTargetRegistry<CodexProxyTargetInput>(
  input => [input.profile.trim(), input.provider, input.model, input.apiMode, input.baseUrl, input.agentSessionId || '', input.chatSessionId || ''],
)

function localProxyBaseUrl(routeKey: string): string {
  return `http://127.0.0.1:${config.port}/api/codex-proxy/${routeKey}/v1`
}

export function registerCodexProxyTarget(input: CodexProxyTargetInput): { baseUrl: string; token: string; routeKey: string } {
  const target = targetRegistry.register({
    ...input,
    profile: input.profile.trim(),
  })

  return { baseUrl: localProxyBaseUrl(target.routeKey), token: target.token, routeKey: target.routeKey }
}

export function restoreCodexProxyTarget(
  input: CodexProxyTargetInput,
  token: string,
): { baseUrl: string; token: string; routeKey: string } {
  const target = targetRegistry.register({
    ...input,
    profile: input.profile.trim(),
  }, { token })

  return { baseUrl: localProxyBaseUrl(target.routeKey), token: target.token, routeKey: target.routeKey }
}

export function revokeCodexProxyTargets(profile: string, provider: string): number {
  const normalizedProfile = String(profile || '').trim()
  const normalizedProvider = String(provider || '').trim()
  return targetRegistry.removeWhere(target => (
    target.profile === normalizedProfile && target.provider === normalizedProvider
  ))
}

function findTarget(routeKey: string): CodexProxyTarget | null {
  return targetRegistry.find(routeKey)
}

function authToken(ctx: Context): string {
  const geminiKey = ctx.get('x-goog-api-key').trim()
  if (geminiKey && ctx.path.includes('/gemini/')) return geminiKey
  const apiKey = ctx.get('x-api-key').trim()
  if (apiKey) return apiKey
  const auth = ctx.get('authorization').trim()
  const match = auth.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || ''
}

export function isAuthorizedCodexProxyRequest(ctx: Context): boolean {
  const routeKey = /^\/api\/codex-proxy\/([^/]+)\/(?:v1\/responses|gemini\/v1beta\/models\/[^/]+)$/.exec(ctx.path)?.[1] || ''
  const target = findTarget(routeKey)
  return Boolean(target && authToken(ctx) === target.token)
}

function requireTarget(ctx: Context): CodexProxyTarget | null {
  const target = findTarget(String(ctx.params.key || ''))
  if (!target) {
    ctx.status = 404
    ctx.body = { error: { type: 'not_found_error', message: 'Codex proxy target not found' } }
    return null
  }
  if (authToken(ctx) !== target.token) {
    ctx.status = 401
    ctx.body = { error: { type: 'authentication_error', message: 'Invalid Codex proxy token' } }
    return null
  }
  return target
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

function nativeResponsesBody(target: CodexProxyTarget, body: any, stream?: boolean): any {
  const normalized = target.agentId === 'grok' ? normalizeGrokResponsesRequest(body) : body
  return truncateResponsesToolOutputs({
    ...normalized,
    model: target.model,
    ...(stream === undefined ? {} : { stream }),
  })
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
    sessionId: target.chatSessionId || target.agentSessionId || target.routeKey,
    provider: target.provider,
    body: chatBody,
    signal,
  })
  codingAgentRunManager.handleProxyUsageEvent(target.agentSessionId, { type: 'response.completed', data: { response } }, (performance.now() - startedAt) / 1000, target.baseUrl)
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
    sessionId: target.chatSessionId || target.agentSessionId || target.routeKey,
    provider: target.provider,
    headers: {
      ...(target.apiKey ? { 'x-api-key': target.apiKey } : {}),
      'anthropic-version': '2023-06-01',
    },
    body: anthropicBody,
    signal,
  })
  codingAgentRunManager.handleProxyUsageEvent(target.agentSessionId, { type: 'response.completed', data: { response } }, (performance.now() - startedAt) / 1000, target.baseUrl)
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
    sessionId: target.chatSessionId || target.agentSessionId || target.routeKey,
    provider: target.provider,
    body: responsesBody,
    signal,
  })
  codingAgentRunManager.handleProxyUsageEvent(target.agentSessionId, { type: 'response.completed', data: { response } }, (performance.now() - startedAt) / 1000, target.baseUrl)
  return response
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
      codingAgentRunManager.handleProxyUsageEvent(target.agentSessionId, event, (performance.now() - startedAt) / 1000, target.baseUrl)
      const clientEvent = responseEventForCodexClient(target, event)
      // Grok, OpenCode and DSH report the same model activity through their native
      // stdout streams. The proxy remains responsible for transport and usage
      // accounting, but must not become a second chat lifecycle source.
      if (!isNativeCodingAgent(target.agentId) && target.agentId !== 'grok' && target.agentId !== 'opencode' && target.agentId !== 'dsh' && target.agentId !== 'antigravity') {
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
    sessionId: target.chatSessionId || target.agentSessionId || target.routeKey,
    provider: target.provider,
    body: chatBody,
  })
  return responsesEventStream(observableResponsesEvents(target, openAiChatSseToResponsesEvents(stream, {
    ...target,
    annotateMcpToolNamespaces: true,
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
    sessionId: target.chatSessionId || target.agentSessionId || target.routeKey,
    provider: target.provider,
    headers: {
      ...(target.apiKey ? { 'x-api-key': target.apiKey } : {}),
      'anthropic-version': '2023-06-01',
    },
    body: anthropicBody,
  })
  return responsesEventStream(observableResponsesEvents(target, anthropicMessagesSseToResponsesEvents(stream, {
    ...target,
    annotateMcpToolNamespaces: true,
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
    sessionId: target.chatSessionId || target.agentSessionId || target.routeKey,
    provider: target.provider,
    body: responsesBody,
  })
  return responsesEventStream(observableResponsesEvents(target, openAiResponsesSseToResponsesEvents(stream), startedAt))
}

export async function codexProxyResponses(ctx: Context) {
  const target = requireTarget(ctx)
  if (!target) return
  try {
    // Sanitize once before API-mode dispatch so native Responses, Chat
    // Completions, and Anthropic adapters all receive the same bounded history.
    const sanitizedBody = stripHistoricalResponsesInlineImages(ctx.request.body || {})
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
        ? anthropicMessageToResponses(await callAnthropicMessages(target, requestBody), target)
        : target.apiMode === 'codex_responses'
          ? await callOpenAiResponses(target, requestBody)
          : openAiChatToResponses(await callOpenAiChat(target, requestBody), target))
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

export async function codexProxyModels(ctx: Context) {
  const target = requireTarget(ctx)
  if (!target) return
  ctx.body = {
    object: 'list',
    data: [{
      id: target.model,
      object: 'model',
      created: 0,
      owned_by: target.provider,
    }],
  }
}

export async function codingAgentProxyChatCompletions(ctx: Context) {
  const target = requireTarget(ctx)
  if (!target) return
  const requestBody = ctx.request.body as any || {}
  try {
    ctx.request.body = chatCompletionsToResponses(requestBody)
    await codexProxyResponses(ctx)
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
  if (target.agentId !== 'antigravity') { ctx.status = 403; ctx.body = { error: { message: 'Not an Antigravity target' } }; return }
  if (!/^[^/:]+:(?:streamGenerateContent|generateContent)$/.test(String(ctx.params.operation))) { ctx.status = 400; ctx.body = { error: { message: 'Unsupported Gemini operation' } }; return }
  const abort = new AbortController()
  const onClose = () => { if (!ctx.res.writableEnded) abort.abort() }
  ctx.res.once('close', onClose)
  const timeout = setTimeout(() => abort.abort(), 120_000)
  timeout.unref?.()
  try {
    const body = geminiToResponses(ctx.request.body || {})
    const response = responseForCodexClient(target, target.apiMode === 'anthropic_messages'
      ? anthropicMessageToResponses(await callAnthropicMessages(target, body, abort.signal), target)
      : target.apiMode === 'codex_responses'
        ? await callOpenAiResponses(target, body, abort.signal)
        : openAiChatToResponses(await callOpenAiChat(target, body, abort.signal), target))
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
