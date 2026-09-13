import { Readable } from 'stream'
import { proxyRequestOptions, type ProxyRequestOptions } from '../../protocol/proxy-request'
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
  const apiKey = ctx.get('x-api-key').trim()
  if (apiKey) return apiKey
  const auth = ctx.get('authorization').trim()
  const match = auth.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || ''
}

export function isAuthorizedCodexProxyRequest(ctx: Context): boolean {
  const routeKey = /^\/api\/codex-proxy\/([^/]+)\/v1\/responses$/.exec(ctx.path)?.[1] || ''
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

export function normalizeGrokChatCompletionsRequest(body: any): any {
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) return body
  let changed = false
  const messages = body.messages.map((message: any) => {
    if (!message || typeof message !== 'object' || message.role !== 'system') return message
    changed = true
    return { ...message, role: 'developer' }
  })
  return changed ? { ...body, messages } : body
}

function nativeResponsesBody(target: CodexProxyTarget, body: any, stream?: boolean): any {
  const normalized = target.agentId === 'grok' ? normalizeGrokResponsesRequest(body) : body
  return truncateResponsesToolOutputs({
    ...normalized,
    model: target.model,
    ...(stream === undefined ? {} : { stream }),
  })
}

async function callOpenAiChat(target: CodexProxyTarget, body: any, options: ProxyRequestOptions): Promise<any> {
  if (target.apiMode !== 'chat_completions') {
    const err = new Error(`Codex proxy only supports chat_completions targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }
  const adapted = responsesToOpenAiChat(body, target)
  const chatBody = target.agentId === 'grok' ? normalizeGrokChatCompletionsRequest(adapted) : adapted
  return agentRunGateway.completeJson({
    ...options,
    url: chatCompletionsUrl(target),
    apiKey: target.apiKey,
    sessionId: target.chatSessionId || target.agentSessionId || target.routeKey,
    provider: target.provider,
    body: chatBody,
  })
}

async function callAnthropicMessages(target: CodexProxyTarget, body: any, options: ProxyRequestOptions): Promise<any> {
  if (target.apiMode !== 'anthropic_messages') {
    const err = new Error(`Codex proxy Anthropic adapter only supports anthropic_messages targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }
  const anthropicBody = responsesToAnthropicMessages(body, target)
  return agentRunGateway.completeJson({
    ...options,
    url: anthropicMessagesUrl(target),
    apiKey: target.apiKey,
    sessionId: target.chatSessionId || target.agentSessionId || target.routeKey,
    provider: target.provider,
    headers: {
      ...(target.apiKey ? { 'x-api-key': target.apiKey } : {}),
      'anthropic-version': '2023-06-01',
      ...options.headers,
    },
    body: anthropicBody,
  })
}

async function callOpenAiResponses(target: CodexProxyTarget, body: any, options: ProxyRequestOptions): Promise<any> {
  if (target.apiMode !== 'codex_responses') {
    const err = new Error(`Codex proxy Responses adapter only supports codex_responses targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }
  const responsesBody = nativeResponsesBody(target, body)
  return agentRunGateway.completeJson({
    ...options,
    url: resolveResponsesUrl(target.baseUrl),
    apiKey: target.apiKey,
    sessionId: target.chatSessionId || target.agentSessionId || target.routeKey,
    provider: target.provider,
    body: responsesBody,
  })
}

function responsesEventStream(events: AsyncIterable<CanonicalResponsesEvent>): Readable {
  async function* generate() {
    for await (const event of events) {
      yield sseEvent(event.type, event.data)
    }
  }
  return Readable.from(generate())
}

function responseEventForCodexClient(target: CodexProxyTarget, event: CanonicalResponsesEvent): CanonicalResponsesEvent {
  if (event.type !== 'response.completed') return event
  const response = (event.data as any).response
  if (target.agentId === 'opencode') {
    // OpenCode's OpenAI Responses provider validates `response.completed`
    // usage before it accepts the terminal event. Chat-compatible upstreams
    // are allowed to omit usage, so keep real usage when available and emit
    // the minimum valid shape otherwise. Without this terminal frame OpenCode
    // reports an `unknown` finish reason and starts another agent step forever.
    return {
      ...event,
      data: {
        ...event.data,
        response: {
          ...response,
          usage: response?.usage || {
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
          },
        },
      },
    }
  }
  if (target.apiMode === 'codex_responses') return event
  if (!response?.usage) return event
  const { usage: _usage, ...responseWithoutUsage } = response
  return {
    ...event,
    data: {
      ...event.data,
      response: responseWithoutUsage,
    },
  }
}

function observableResponsesEvents(target: CodexProxyTarget, events: AsyncIterable<CanonicalResponsesEvent>): AsyncIterable<CanonicalResponsesEvent> {
async function* observe() {
    for await (const event of normalizeResponsesSseEvents(events)) {
      codingAgentRunManager.handleProxyUsageEvent(target.agentSessionId, event)
      const clientEvent = responseEventForCodexClient(target, event)
      // Grok, OpenCode and DSH report the same model activity through their native
      // stdout streams. The proxy remains responsible for transport and usage
      // accounting, but must not become a second chat lifecycle source.
      if (target.agentId !== 'grok' && target.agentId !== 'opencode' && target.agentId !== 'dsh') {
        codingAgentRunManager.handleResponseEvent(target.agentSessionId, clientEvent)
      }
      yield clientEvent
    }
  }
  return observe()
}

async function openAiChatToResponsesSseStream(target: CodexProxyTarget, body: any, options: ProxyRequestOptions): Promise<Readable> {
  if (target.apiMode !== 'chat_completions') {
    const err = new Error(`Codex proxy only supports chat_completions targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }

  const adapted = responsesToOpenAiChat(body, target, true)
  const chatBody = target.agentId === 'grok' ? normalizeGrokChatCompletionsRequest(adapted) : adapted
  const stream = await agentRunGateway.streamBytes({
    ...options,
    url: chatCompletionsUrl(target),
    apiKey: target.apiKey,
    sessionId: target.chatSessionId || target.agentSessionId || target.routeKey,
    provider: target.provider,
    body: chatBody,
  })
  return responsesEventStream(observableResponsesEvents(target, openAiChatSseToResponsesEvents(stream, {
    ...target,
    annotateMcpToolNamespaces: true,
  })))
}

async function anthropicMessagesToResponsesSseStream(target: CodexProxyTarget, body: any, options: ProxyRequestOptions): Promise<Readable> {
  if (target.apiMode !== 'anthropic_messages') {
    const err = new Error(`Codex proxy Anthropic adapter only supports anthropic_messages targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }

  const anthropicBody = responsesToAnthropicMessages(body, target, true)
  const stream = await agentRunGateway.streamBytes({
    ...options,
    url: anthropicMessagesUrl(target),
    apiKey: target.apiKey,
    sessionId: target.chatSessionId || target.agentSessionId || target.routeKey,
    provider: target.provider,
    headers: {
      ...(target.apiKey ? { 'x-api-key': target.apiKey } : {}),
      'anthropic-version': '2023-06-01',
      ...options.headers,
    },
    body: anthropicBody,
  })
  return responsesEventStream(observableResponsesEvents(target, anthropicMessagesSseToResponsesEvents(stream, {
    ...target,
    annotateMcpToolNamespaces: true,
  })))
}

async function openAiResponsesSseStream(target: CodexProxyTarget, body: any, options: ProxyRequestOptions): Promise<Readable> {
  if (target.apiMode !== 'codex_responses') {
    const err = new Error(`Codex proxy Responses adapter only supports codex_responses targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }

  const responsesBody = nativeResponsesBody(target, body, true)
  const stream = await agentRunGateway.streamBytes({
    ...options,
    url: resolveResponsesUrl(target.baseUrl),
    apiKey: target.apiKey,
    sessionId: target.chatSessionId || target.agentSessionId || target.routeKey,
    provider: target.provider,
    body: responsesBody,
  })
  return responsesEventStream(observableResponsesEvents(target, openAiResponsesSseToResponsesEvents(stream)))
}

export async function codexProxyResponses(ctx: Context) {
  const target = requireTarget(ctx)
  if (!target) return
  try {
    const options = proxyRequestOptions(ctx, target, 'codex')
    // Sanitize once before API-mode dispatch so native Responses, Chat
    // Completions, and Anthropic adapters all receive the same bounded history.
    const sanitizedBody = stripHistoricalResponsesInlineImages(ctx.request.body || {})
    const requestBody = target.agentId === 'grok'
      ? normalizeGrokResponsesRequest(sanitizedBody)
      : sanitizedBody
    if ((requestBody as any).stream === true) {
      const stream = target.apiMode === 'anthropic_messages'
        ? await anthropicMessagesToResponsesSseStream(target, requestBody, options)
        : target.apiMode === 'codex_responses'
          ? await openAiResponsesSseStream(target, requestBody, options)
          : await openAiChatToResponsesSseStream(target, requestBody, options)
      ctx.set('Content-Type', 'text/event-stream; charset=utf-8')
      ctx.set('Cache-Control', 'no-cache')
      ctx.body = stream
    } else {
      ctx.body = target.apiMode === 'anthropic_messages'
        ? anthropicMessageToResponses(await callAnthropicMessages(target, requestBody, options), target)
        : target.apiMode === 'codex_responses'
          ? await callOpenAiResponses(target, requestBody, options)
          : openAiChatToResponses(await callOpenAiChat(target, requestBody, options), target)
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
