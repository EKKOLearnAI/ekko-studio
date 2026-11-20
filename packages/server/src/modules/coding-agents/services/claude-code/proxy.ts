import { Readable } from 'stream'
import { isNativeCodingAgent } from '../../../studio/contracts/agents/native-coding-agents'
import type { Context } from 'koa'
import { config } from '../../../studio/public/config'
import { gatewayToken } from '../../../studio/public/model-gateway-adapters'
import type { CodexRequestAffinity } from '../../../studio/public/provider-http'
import {
  anthropicMessagesUrl as resolveAnthropicMessagesUrl,
  chatCompletionsUrl as resolveChatCompletionsUrl,
  responsesUrl as resolveResponsesUrl,
} from '../../protocol/endpoint-resolver'
import { parseSseFrame, readSseFrameTexts, sseEvent } from '../../protocol/sse'
import { AgentTargetRegistry, type AgentTargetInput, type RegisteredAgentTarget } from '../../protocol/target-registry'
import type { ApiMode } from '../../protocol/types'
import {
  anthropicToOpenAiChat,
  anthropicToOpenAiResponses,
  openAiResponsesToAnthropicMessage,
  openAiToAnthropicMessage,
} from '../../protocol/adapters/anthropic'
import {
  openAiChatSseToAnthropicEvents,
  openAiResponsesSseToAnthropicEvents,
  type AnthropicStreamEvent,
} from '../../protocol/adapters/anthropic-stream'
import {
  anthropicMessagesSseToResponsesEvents,
  openAiChatSseToResponsesEvents,
  openAiResponsesSseToResponsesEvents,
  type CanonicalResponsesEvent,
} from '../../protocol/adapters/responses-stream'
import { agentRunGateway, codexRequestAffinity, ProviderApiError } from '../../protocol/gateway'
import { teeAsyncIterable } from '../../protocol/stream-tee'
import { codingAgentRunManager } from '../runtime/run-manager'
import { logger } from '../../../studio/public/logging'

export interface ClaudeCodeProxyTargetInput extends AgentTargetInput {}

type ClaudeCodeProxyTarget = RegisteredAgentTarget<ClaudeCodeProxyTargetInput> & { codexAffinity?: CodexRequestAffinity }

function recordTargetUsage(target: ClaudeCodeProxyTarget, event: CanonicalResponsesEvent, apiDuration?: number, baseUrl?: string) {
  if (target.onUsageEvent) target.onUsageEvent(event, apiDuration, baseUrl)
  else codingAgentRunManager.handleProxyUsageEvent(target.agentSessionId, event, apiDuration, baseUrl)
}

const targetRegistry = new AgentTargetRegistry<ClaudeCodeProxyTargetInput>(
  input => [input.provider, input.model, input.apiMode, input.baseUrl, input.agentSessionId || '', input.chatSessionId || ''],
)
function localProxyBaseUrl(): string {
  return `http://127.0.0.1:${config.port}/api/ekko-studio/models`
}

export function revokeClaudeCodeProxyTarget(routeKey: string): number { return targetRegistry.removeWhere(target => target.routeKey === routeKey) }

export function registerClaudeCodeProxyTarget(input: ClaudeCodeProxyTargetInput, persisted?: { token: string }): { baseUrl: string; token: string; routeKey: string } {
  const target = targetRegistry.register(input, persisted)

  return { baseUrl: localProxyBaseUrl(), token: target.token, routeKey: target.routeKey }
}

function requireTarget(ctx: Context): ClaudeCodeProxyTarget | null {
  const target = targetRegistry.find(String(ctx.params.key || '')) || targetRegistry.findByToken(gatewayToken(ctx))
  if (!target) {
    ctx.status = 404
    ctx.body = { type: 'error', error: { type: 'not_found_error', message: 'Claude proxy target not found' } }
    return null
  }
  if (gatewayToken(ctx) !== target.token && (ctx.state as any).modelGatewayTarget !== target.routeKey) {
    ctx.status = 401
    ctx.body = { type: 'error', error: { type: 'authentication_error', message: 'Invalid Claude proxy token' } }
    return null
  }
  return { ...target, reasoningCodec: (ctx.state as any).modelGatewayReasoningCodec, requestHeaders: { ...(ctx.get('anthropic-beta') ? { 'anthropic-beta': ctx.get('anthropic-beta') } : {}), ...(ctx.get('anthropic-version') ? { 'anthropic-version': ctx.get('anthropic-version') } : {}) }, signal: (ctx.state as any).modelGatewaySignal || target.signal,
    codexAffinity: target.apiMode === 'codex_responses' ? codexRequestAffinity(ctx, target) : undefined }
}

function anthropicMessagesUrl(target: ClaudeCodeProxyTarget): string {
  return resolveAnthropicMessagesUrl(target.baseUrl)
}

function anthropicRequestBody(body: any, target: ClaudeCodeProxyTarget): any {
  return {
    ...body,
    model: target.model,
  }
}

const OPAQUE_THINKING_BLOCK_TYPES = new Set(['thinking', 'redacted_thinking'])

type OpaqueThinkingSanitization = {
  body: any
  removedBlocks: number
  removedMessages: number
}

function withoutOpaqueThinkingHistory(body: any): OpaqueThinkingSanitization | null {
  if (!Array.isArray(body?.messages)) return null
  let removedBlocks = 0
  let removedMessages = 0
  const messages: any[] = []

  for (const message of body.messages) {
    if (!Array.isArray(message?.content)) {
      messages.push(message)
      continue
    }
    const content = message.content.filter((block: any) => {
      const strip = OPAQUE_THINKING_BLOCK_TYPES.has(String(block?.type || ''))
      if (strip) removedBlocks += 1
      return !strip
    })
    if (content.length === 0 && message.content.length > 0) {
      removedMessages += 1
      continue
    }
    messages.push(content.length === message.content.length ? message : { ...message, content })
  }

  if (removedBlocks === 0 || messages.length === 0) return null
  return {
    body: { ...body, messages },
    removedBlocks,
    removedMessages,
  }
}

const ENCRYPTED_CONTENT_MESSAGE = /^Encrypted content could not be decrypted or parsed\.?$/i
const ENCRYPTED_CONTENT_VERIFICATION_MESSAGE = /^The encrypted content [^\r\n]+ could not be verified\. Reason: Encrypted content could not be decrypted or parsed\.?$/i

function isCustomEncryptedContentFailure(target: ClaudeCodeProxyTarget, error: unknown): error is ProviderApiError {
  if (!target.provider.startsWith('custom:') || !(error instanceof ProviderApiError) || error.status !== 400) return false
  return isEncryptedContentProviderError(error.providerError)
}

function isEncryptedContentProviderError(providerError: unknown): boolean {
  const typedProviderError = providerError as any
  if (typedProviderError?.error?.code === 'invalid_encrypted_content') return true
  const message = String(typedProviderError?.error?.message || '')
  return ENCRYPTED_CONTENT_MESSAGE.test(message) || ENCRYPTED_CONTENT_VERIFICATION_MESSAGE.test(message)
}

function opaqueThinkingRetryBody(
  target: ClaudeCodeProxyTarget,
  body: any,
  status: number,
): any | null {
  const sanitization = withoutOpaqueThinkingHistory(body)
  if (!sanitization) {
    loggerLikeWarn({
      provider: target.provider,
      status,
      retryStarted: false,
    }, '[claude-code-proxy] encrypted-thinking compatibility retry skipped')
    return null
  }
  loggerLikeWarn({
    provider: target.provider,
    status,
    removedBlocks: sanitization.removedBlocks,
    removedMessages: sanitization.removedMessages,
    retryStarted: true,
  }, '[claude-code-proxy] retrying without historical opaque thinking')
  return sanitization.body
}

function logEncryptedContentRetryFailure(target: ClaudeCodeProxyTarget, retryError: unknown) {
  const providerError = retryError instanceof ProviderApiError ? retryError.providerError as any : null
  loggerLikeWarn({
    provider: target.provider,
    status: retryError instanceof ProviderApiError ? retryError.status : null,
    code: String(providerError?.error?.code || ''),
    retryFailed: true,
  }, '[claude-code-proxy] encrypted-thinking compatibility retry failed')
}

async function withCustomEncryptedContentRetry<T>(
  target: ClaudeCodeProxyTarget,
  body: any,
  request: (nextBody: any) => Promise<T>,
): Promise<{ value: T; retried: boolean }> {
  try {
    return { value: await request(body), retried: false }
  } catch (error) {
    if (!isCustomEncryptedContentFailure(target, error)) throw error
    const retryBody = opaqueThinkingRetryBody(target, body, error.status)
    if (!retryBody) throw error
    try {
      return { value: await request(retryBody), retried: true }
    } catch (retryError) {
      logEncryptedContentRetryFailure(target, retryError)
      throw retryError
    }
  }
}

type SseProbeResult = {
  stream: AsyncIterable<Uint8Array> | null
  encryptedContentError: boolean
}

const SSE_ERROR_PROBE_LIMIT = 64 * 1024

function replayAsyncIterator(
  chunks: Uint8Array[],
  iterator: AsyncIterator<Uint8Array>,
): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      try {
        for (const chunk of chunks) yield chunk
        while (true) {
          const next = await iterator.next()
          if (next.done) return
          yield next.value
        }
      } finally {
        await iterator.return?.()
      }
    },
  }
}

function isEncryptedContentSseFrame(rawFrame: string): boolean {
  const frame = parseSseFrame(rawFrame)
  if (!frame) return false
  let data: any
  try {
    data = JSON.parse(frame.data)
  } catch {
    return false
  }
  if (frame.event !== 'error' && data?.type !== 'error') return false
  return isEncryptedContentProviderError(data)
}

function isIgnorableSsePreludeFrame(rawFrame: string): boolean {
  const frame = parseSseFrame(rawFrame)
  return !frame || frame.event === 'ping'
}

async function probeSseEncryptedContentError(
  stream: AsyncIterable<Uint8Array>,
): Promise<SseProbeResult> {
  const iterator = stream[Symbol.asyncIterator]()
  const decoder = new TextDecoder()
  const chunks: Uint8Array[] = []
  let decoded = ''
  let byteLength = 0

  while (byteLength <= SSE_ERROR_PROBE_LIMIT) {
    const next = await iterator.next()
    if (next.done) {
      decoded += decoder.decode()
      if (decoded && isEncryptedContentSseFrame(decoded)) {
        await iterator.return?.()
        return { stream: null, encryptedContentError: true }
      }
      return { stream: replayAsyncIterator(chunks, iterator), encryptedContentError: false }
    }

    chunks.push(next.value)
    byteLength += next.value.byteLength
    decoded += decoder.decode(next.value, { stream: true })
    const parsed = readSseFrameTexts(decoded)
    decoded = parsed.rest

    let hasBusinessFrame = false
    for (const rawFrame of parsed.frames) {
      if (isEncryptedContentSseFrame(rawFrame)) {
        await iterator.return?.()
        return { stream: null, encryptedContentError: true }
      }
      if (!isIgnorableSsePreludeFrame(rawFrame)) hasBusinessFrame = true
    }
    if (hasBusinessFrame) {
      return { stream: replayAsyncIterator(chunks, iterator), encryptedContentError: false }
    }
  }

  return { stream: replayAsyncIterator(chunks, iterator), encryptedContentError: false }
}

async function callAnthropicMessages(target: ClaudeCodeProxyTarget, body: any): Promise<any> {
  const startedAt = performance.now()
  if (target.apiMode !== 'anthropic_messages') {
    const err = new Error(`Claude proxy Anthropic adapter only supports anthropic_messages targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }
  const result = await withCustomEncryptedContentRetry(target, body, nextBody => agentRunGateway.completeJson({
    url: anthropicMessagesUrl(target),
    apiKey: target.apiKey,
    ownerUserId: target.ownerUserId, profile: target.profile, model: target.model, signal: target.signal,
    sessionId: target.chatSessionId || target.agentSessionId || target.routeKey,
    provider: target.provider,
    headers: {
      ...(target.apiKey ? { 'x-api-key': target.apiKey } : {}),
      'anthropic-version': '2023-06-01',
      ...target.requestHeaders,
    },
    body: anthropicRequestBody(nextBody, target),
  }))
  recordTargetUsage(target, { type: 'response.completed', data: { response: result.value } }, (performance.now() - startedAt) / 1000, target.baseUrl)
  return result.value
}

async function callOpenAiChat(target: ClaudeCodeProxyTarget, body: any): Promise<any> {
  const startedAt = performance.now()
  if (target.apiMode !== 'chat_completions') {
    const err = new Error(`Claude proxy MVP only supports chat_completions targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }
  const response = await agentRunGateway.completeJson({
    url: resolveChatCompletionsUrl(target.baseUrl),
    apiKey: target.apiKey,
    ownerUserId: target.ownerUserId, profile: target.profile, model: target.model, signal: target.signal,
    sessionId: target.chatSessionId || target.agentSessionId || target.routeKey,
    provider: target.provider,
    body: anthropicToOpenAiChat(body, target),
  })
  recordTargetUsage(target, { type: 'response.completed', data: { response } }, (performance.now() - startedAt) / 1000, target.baseUrl)
  return response
}

async function callOpenAiResponses(target: ClaudeCodeProxyTarget, body: any): Promise<any> {
  const startedAt = performance.now()
  if (target.apiMode !== 'codex_responses') {
    const err = new Error(`Claude proxy responses adapter only supports codex_responses targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }
  const response = await agentRunGateway.completeJson({
    url: resolveResponsesUrl(target.baseUrl),
    apiKey: target.apiKey,
    ownerUserId: target.ownerUserId, profile: target.profile, model: target.model, signal: target.signal,
    sessionId: target.chatSessionId || target.agentSessionId || target.routeKey,
    codexAffinity: target.codexAffinity,
    provider: target.provider,
    body: anthropicToOpenAiResponses(body, target),
  })
  recordTargetUsage(target, { type: 'response.completed', data: { response } }, (performance.now() - startedAt) / 1000, target.baseUrl)
  return response
}

function anthropicEventStream(events: AsyncIterable<AnthropicStreamEvent>): Readable {
  async function* generate() {
    for await (const event of events) {
      yield sseEvent(event.type, event.data)
    }
  }
  return Readable.from(generate())
}

function observeResponsesEvents(target: ClaudeCodeProxyTarget, events: AsyncIterable<CanonicalResponsesEvent>, startedAt: number) {
  void (async () => {
    try {
      for await (const event of events) {
        recordTargetUsage(target, event, (performance.now() - startedAt) / 1000, target.baseUrl)
        if (!isNativeCodingAgent(target.agentId)) codingAgentRunManager.handleResponseEvent(target.agentSessionId, event)
      }
    } catch (err) {
      loggerLikeWarn(err, '[claude-code-proxy] failed to observe provider stream')
    }
  })()
}

function loggerLikeWarn(err: unknown, message: string) {
  logger.warn(err, message)
}

async function openAiChatToAnthropicSseStream(target: ClaudeCodeProxyTarget, body: any, startedAt = performance.now()): Promise<Readable> {
  if (target.apiMode !== 'chat_completions') {
    const err = new Error(`Claude proxy MVP only supports chat_completions targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }

  const stream = await agentRunGateway.streamBytes({
    url: resolveChatCompletionsUrl(target.baseUrl),
    apiKey: target.apiKey,
    ownerUserId: target.ownerUserId, profile: target.profile, model: target.model, signal: target.signal,
    sessionId: target.chatSessionId || target.agentSessionId || target.routeKey,
    provider: target.provider,
    body: anthropicToOpenAiChat(body, target, true),
  })
  const [clientStream, observerStream] = teeAsyncIterable(stream)
  observeResponsesEvents(target, openAiChatSseToResponsesEvents(observerStream, target), startedAt)
  return anthropicEventStream(openAiChatSseToAnthropicEvents(clientStream, target))
}

async function anthropicMessagesSseStream(target: ClaudeCodeProxyTarget, body: any, startedAt = performance.now()): Promise<Readable> {
  if (target.apiMode !== 'anthropic_messages') {
    const err = new Error(`Claude proxy Anthropic adapter only supports anthropic_messages targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }

  const request = (nextBody: any) => agentRunGateway.streamBytes({
    url: anthropicMessagesUrl(target),
    apiKey: target.apiKey,
    ownerUserId: target.ownerUserId, profile: target.profile, model: target.model, signal: target.signal,
    sessionId: target.chatSessionId || target.agentSessionId || target.routeKey,
    provider: target.provider,
    headers: {
      ...(target.apiKey ? { 'x-api-key': target.apiKey } : {}),
      'anthropic-version': '2023-06-01',
      ...target.requestHeaders,
    },
    body: anthropicRequestBody(nextBody, target),
  })
  const initial = await withCustomEncryptedContentRetry(target, body, request)
  const stream = initial.value
  // Only retry before a business event reaches Claude Code; replaying a partially
  // delivered response would duplicate Anthropic stream events.
  const canRetrySseError = target.provider.startsWith('custom:')
    && !initial.retried
    && withoutOpaqueThinkingHistory(body) !== null
  if (canRetrySseError) {
    const probe = await probeSseEncryptedContentError(stream)
    if (probe.encryptedContentError) {
      const retryBody = opaqueThinkingRetryBody(target, body, 200)
      if (retryBody) {
        try {
          const retryStream = await request(retryBody)
          const [clientStream, observerStream] = teeAsyncIterable(retryStream)
          observeResponsesEvents(target, anthropicMessagesSseToResponsesEvents(observerStream, target), startedAt)
          return Readable.from(clientStream)
        } catch (retryError) {
          logEncryptedContentRetryFailure(target, retryError)
          throw retryError
        }
      }
    }
    if (probe.stream) {
      const [clientStream, observerStream] = teeAsyncIterable(probe.stream)
      observeResponsesEvents(target, anthropicMessagesSseToResponsesEvents(observerStream, target), startedAt)
      return Readable.from(clientStream)
    }
  }
  const [clientStream, observerStream] = teeAsyncIterable(stream)
  observeResponsesEvents(target, anthropicMessagesSseToResponsesEvents(observerStream, target), startedAt)
  return Readable.from(clientStream)
}

async function openAiResponsesToAnthropicSseStream(target: ClaudeCodeProxyTarget, body: any, startedAt = performance.now()): Promise<Readable> {
  if (target.apiMode !== 'codex_responses') {
    const err = new Error(`Claude proxy responses adapter only supports codex_responses targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }

  const stream = await agentRunGateway.streamBytes({
    url: resolveResponsesUrl(target.baseUrl),
    apiKey: target.apiKey,
    ownerUserId: target.ownerUserId, profile: target.profile, model: target.model, signal: target.signal,
    sessionId: target.chatSessionId || target.agentSessionId || target.routeKey,
    codexAffinity: target.codexAffinity,
    provider: target.provider,
    body: anthropicToOpenAiResponses(body, target, true),
  })
  const [clientStream, observerStream] = teeAsyncIterable(stream)
  observeResponsesEvents(target, openAiResponsesSseToResponsesEvents(observerStream), startedAt)
  return anthropicEventStream(openAiResponsesSseToAnthropicEvents(clientStream, target, body?.tools))
}

export async function claudeProxyMessages(ctx: Context) {
  const target = requireTarget(ctx)
  if (!target) return
  try {
    const requestBody = ctx.request.body || {}
    if ((requestBody as any).stream === true) {
      const stream = target.apiMode === 'anthropic_messages'
        ? await anthropicMessagesSseStream(target, requestBody)
        : target.apiMode === 'codex_responses'
          ? await openAiResponsesToAnthropicSseStream(target, requestBody)
          : await openAiChatToAnthropicSseStream(target, requestBody)
      ctx.set('Content-Type', 'text/event-stream; charset=utf-8')
      ctx.set('Cache-Control', 'no-cache')
      ctx.body = stream
    } else {
      const message = target.apiMode === 'anthropic_messages'
        ? await callAnthropicMessages(target, requestBody)
        : target.apiMode === 'codex_responses'
          ? openAiResponsesToAnthropicMessage(await callOpenAiResponses(target, requestBody), target, requestBody?.tools)
          : openAiToAnthropicMessage(await callOpenAiChat(target, requestBody), target)
      ctx.body = message
    }
  } catch (err: any) {
    ctx.status = err.status || 502
    ctx.body = {
      type: 'error',
      error: {
        type: 'api_error',
        message: err?.message || 'Claude proxy request failed',
        provider_error: err?.providerError,
      },
    }
  }
}

export const findClaudeProxyByToken = (token: string) => targetRegistry.findByToken(token)

export async function claudeProxyCountTokens(ctx: Context) {
  const target = requireTarget(ctx)
  if (!target) return
  const body = ctx.request.body as any
  if (!Array.isArray(body?.messages)) { ctx.status = 400; ctx.body = { type: 'error', error: { type: 'invalid_request_error', message: 'messages must be an array' } }; return }
  if (target.apiMode === 'anthropic_messages') {
    try {
      ctx.body = await agentRunGateway.completeJson({
        url: `${anthropicMessagesUrl(target)}/count_tokens`,
        ownerUserId: target.ownerUserId, profile: target.profile, provider: target.provider, model: target.model,
        apiKey: target.apiKey, signal: target.signal,
        headers: { 'x-api-key': target.apiKey, 'anthropic-version': '2023-06-01', ...target.requestHeaders },
        body: anthropicRequestBody(body, target),
      })
    } catch (error: any) { ctx.status = error.status || 502; ctx.body = { type: 'error', error: { type: 'api_error', message: error.message } } }
    return
  }
  // Other vendors do not expose an Anthropic tokenizer. Label the local
  // conservative estimate so callers can distinguish it from native counting.
  ctx.set('x-studio-token-count-estimated', 'true')
  ctx.body = { input_tokens: Math.max(1, Buffer.byteLength(JSON.stringify({ messages: body.messages, system: body.system, tools: body.tools }), 'utf8')) }
}

export const findClaudeGatewayTarget = (routeKey: string) => targetRegistry.find(routeKey)
