import type { ModelClient, ModelProviderConfig, ModelUsage } from '../../../../../../ekko-agent/src/model/types'
import { getSessionAvailableModelGroups } from '../../public/session-agent-runtime'
import { resolveProviderCatalogApiMode } from '../../contracts/providers'
import {
  createChatEkkoAuthorizedProviderFetch, createChatEkkoModelClient,
  resolveChatEkkoModelProviderConfigs, resolveChatEkkoProviderRuntimeConfig,
} from '../../public/chat-agent-runtime'
import { logger } from '../../public/logging'
import { recordSessionUsage, type RecordedUsage } from '../usage/usage-recorder'
import { ModelApiError, modelApiErrorBody } from './errors'
import { responsesModelRequest, validateResponsesBody } from './input'
import { ResponsesOutput, type ResponsesEvent } from './output'
import { chatModelRequest, validateChatBody } from './chat'
import { ChatCompletionOutput, type ChatCompletionChunk } from './chat-output'
import { reasoningCodec } from './reasoning'
import { findModelApiKey } from './keys'
import { checkModelApiBudget, startModelApiKeyRequest } from './budget'

interface ModelGroup {
  provider: string
  models: string[]
  base_url?: string
  api_key?: string
  api_mode?: string
  api_mode_by_model?: Record<string, string>
  model_meta?: Record<string, { disabled?: boolean }>
}

function qualifiedId(provider: string, model: string): string {
  // Custom provider names may contain slashes; avoid colliding with a nested model ID.
  return `${provider.replaceAll('%', '%25').replaceAll('/', '%2F')}/${model}`
}

function apiMode(group: ModelGroup, model: string): string | undefined {
  return group.api_mode_by_model?.[model] || group.api_mode || resolveProviderCatalogApiMode(group.provider, model)
}

function supported(group: ModelGroup, model: string): boolean {
  return !['bedrock_converse', 'codex_app_server'].includes(apiMode(group, model) || '')
}

interface CatalogEntry { profile: string; group: ModelGroup; model: string }
function callable(entry: CatalogEntry): boolean {
  return supported(entry.group, entry.model) && !entry.group.model_meta?.[entry.model]?.disabled
}

function isSelfModelApi(group: ModelGroup): boolean {
  if (!group.base_url || !group.api_key) return false
  let url: URL
  try { url = new URL(group.base_url) } catch { return false }
  if (!['http:', 'https:'].includes(url.protocol) || !url.pathname.replace(/\/+$/, '').endsWith('/api/ekko-studio/models/v1')) return false
  // A locally issued key identifies this instance even behind a proxy or LAN URL.
  // Do not re-export the cached catalog of a provider pointing back to ourselves.
  return findModelApiKey(group.api_key.trim()) !== null
}

/** Keep the upstream cause in the server log; the API caller only sees its classification. */
function logUpstreamFailure(error: unknown, context: { requestId: string; provider: string; timeoutMs?: number }): void {
  if (error instanceof ModelApiError) return
  logger.warn({ err: error, ...context }, 'Model API provider request failed')
}

async function unifiedCatalog(profiles: string[]): Promise<Map<string, CatalogEntry>> {
  const names = [...new Set(profiles)]
  const groupsByProfile = await Promise.all(names.map(profile => getSessionAvailableModelGroups(profile) as Promise<ModelGroup[]>))
  const catalog = new Map<string, CatalogEntry>()
  for (const [index, groups] of groupsByProfile.entries()) {
    for (const group of groups) {
      // MoA presets require agent orchestration and are not public API models.
      if (group.provider === 'moa' || isSelfModelApi(group)) continue
      for (const model of group.models) {
        const id = qualifiedId(group.provider, model)
        const entry = { profile: names[index], group, model }
        const existing = catalog.get(id)
        // Keep a callable configuration over a disabled/unsupported duplicate.
        // Otherwise the caller's stable Profile order wins, independent of fetch timing.
        if (!existing || (!callable(existing) && callable(entry))) catalog.set(id, entry)
      }
    }
  }
  return catalog
}

export async function listApiModels(profiles: string[], allowedModels?: readonly string[]) {
  const catalog = await unifiedCatalog(profiles)
  const allowed = allowedModels === undefined ? undefined : new Set(allowedModels)
  return { object: 'list', data: [...catalog].filter(([id]) => !allowed || allowed.has(id)).map(([id, entry]) => ({
    id, object: 'model', created: 0, owned_by: entry.group.provider,
    api_mode: apiMode(entry.group, entry.model) || null,
    responses_supported: callable(entry),
  })) }
}

/** Shared request context for every inference endpoint the Model API exposes. */
export interface ModelApiCall {
  profiles: string[]
  onUsage?: (usage: RecordedUsage) => void
  accountId?: string
  apiKeyId?: string
  allowedModels?: readonly string[]
  signal: AbortSignal
}

function budgetGuards(input: ModelApiCall) {
  const check = () => { if (input.apiKeyId && input.accountId) checkModelApiBudget(Number(input.accountId), input.apiKeyId) }
  const start = (id: string) => input.apiKeyId && input.accountId ? startModelApiKeyRequest(Number(input.accountId), input.apiKeyId, id) : () => {}
  return { check, start }
}

interface ResolvedTarget {
  profile: string
  group: ModelGroup
  model: string
  runtime: Awaited<ReturnType<typeof resolveChatEkkoProviderRuntimeConfig>>
  providerConfig: ModelProviderConfig
  client: ModelClient
}

/** One catalog lookup and one credential resolution, shared by every protocol. */
async function resolveTarget(input: ModelApiCall, modelId: unknown): Promise<ResolvedTarget> {
  if (typeof modelId !== 'string' || !modelId.trim()) throw new ModelApiError('Model must be provider/model.', 400, 'model')
  if (input.allowedModels && !input.allowedModels.includes(modelId)) throw new ModelApiError('Model is not available.', 404, 'model')
  const catalog = await unifiedCatalog(input.profiles)
  const selected = catalog.get(modelId)
  if (!selected || selected.group.model_meta?.[selected.model]?.disabled) throw new ModelApiError('Model is not available.', 404, 'model')
  const { profile, group, model } = selected
  if (!supported(group, model)) throw new ModelApiError('This provider requires a runtime that does not support direct model requests.', 501, 'model')
  const runtime = await resolveChatEkkoProviderRuntimeConfig({ profile, provider: group.provider, model, apiMode: apiMode(group, model) })
  const resolved: { providerConfig: ModelProviderConfig } = resolveChatEkkoModelProviderConfigs({
    ...runtime, provider: group.provider, model,
  })
  const client: ModelClient = createChatEkkoModelClient(resolved.providerConfig, { fetch: createChatEkkoAuthorizedProviderFetch({
    profile, provider: group.provider, model, accessToken: runtime.apiKey,
  }) })
  return { profile, group, model, runtime, providerConfig: resolved.providerConfig, client }
}

function usageRecorder(input: ModelApiCall, target: ResolvedTarget, runId: string, readUsage: () => ModelUsage | undefined) {
  let recorded = false
  return (startedAt: number) => {
    if (recorded) return
    recorded = true
    recordSessionUsage({
      onRecorded: input.onUsage,
      sessionId: '', runId, origin: 'external', accountId: input.accountId, modelApiKeyId: input.apiKeyId,
      source: 'model_api', agent: 'model_api', usageScope: 'model_call', apiCalls: 1,
      profile: target.profile, provider: target.group.provider, model: target.model, baseUrl: target.runtime.baseUrl,
      usage: readUsage(), apiDuration: (performance.now() - startedAt) / 1000,
    })
  }
}

export async function prepareModelResponse(input: ModelApiCall & { body: unknown }) {
  validateResponsesBody(input.body)
  const guards = budgetGuards(input)
  guards.check()
  const body = input.body
  const target = await resolveTarget(input, body.model)
  const { profile, group, model, providerConfig, client } = target
  const codec = await reasoningCodec(JSON.stringify([profile, group.provider, model, providerConfig.baseUrl, providerConfig.requestStyle]))
  const request = responsesModelRequest(body, model, codec, input.signal)
  if (request.messages.some(message => message.contentParts?.some(part => part.type === 'image')) && !client.capabilities.vision) {
    throw new ModelApiError('This model does not support images.', 400, 'input')
  }
  const output = new ResponsesOutput(body.model, codec, body, providerConfig.requestStyle !== 'openai-responses')
  const record = usageRecorder(input, target, output.id, () => output.usage)
  guards.check()
  return {
    id: output.id,
    stream: body.stream === true,
    async create() {
      guards.check()
      const release = guards.start(output.id)
      const startedAt = performance.now()
      try {
        const result = await client.create(request)
        const events = output.finish(result)
        return events[events.length - 1].response
      } catch (error) {
        logUpstreamFailure(error, { requestId: output.id, provider: group.provider, timeoutMs: providerConfig.timeoutMs })
        throw error
      } finally { try { record(startedAt) } finally { release() } }
    },
    async *events(): AsyncGenerator<ResponsesEvent> {
      const startedAt = performance.now()
      let admitted = false
      let release = () => {}
      try {
        guards.check()
        release = guards.start(output.id)
        admitted = true
        yield output.event('response.created', { response: output.response() })
        yield output.event('response.in_progress', { response: output.response() })
        for await (const event of client.stream(request)) {
          if (event.type === 'error') throw new Error(event.error)
          if (event.type === 'done') {
            yield* output.finish(event.response)
            return
          }
          yield* output.consume(event)
        }
        // An EOF without a terminal event is never a successful response.
        throw new Error('Provider stream ended before completion')
      } catch (error) {
        if (!input.signal.aborted) {
          logUpstreamFailure(error, { requestId: output.id, provider: group.provider, timeoutMs: providerConfig.timeoutMs })
          yield output.event('response.failed', {
            response: output.response('failed', modelApiErrorBody(error, { timeoutMs: providerConfig.timeoutMs }).body.error),
          })
        }
      } finally { try { if (admitted) record(startedAt) } finally { release() } }
    },
  }
}

/**
 * OpenAI Chat Completions for the same catalog. Clients that only speak
 * `/chat/completions` (Cline, Continue, the OpenAI SDKs) reach every configured
 * provider through this endpoint instead of failing on a missing route.
 */
export async function prepareChatCompletion(input: ModelApiCall & { body: unknown }) {
  validateChatBody(input.body)
  const guards = budgetGuards(input)
  guards.check()
  const body = input.body
  const target = await resolveTarget(input, body.model)
  const { group, model, providerConfig, client } = target
  const request = chatModelRequest(body, model, input.signal)
  if (request.messages.some(message => message.contentParts?.some(part => part.type === 'image')) && !client.capabilities.vision) {
    throw new ModelApiError('This model does not support images.', 400, 'messages')
  }
  const output = new ChatCompletionOutput(body.model)
  const record = usageRecorder(input, target, output.id, () => output.usage)
  const includeUsage = body.stream_options?.include_usage === true
  guards.check()
  return {
    id: output.id,
    stream: body.stream === true,
    includeUsage,
    async create() {
      guards.check()
      const release = guards.start(output.id)
      const startedAt = performance.now()
      try {
        return output.finish(await client.create(request)).body
      } catch (error) {
        logUpstreamFailure(error, { requestId: output.id, provider: group.provider, timeoutMs: providerConfig.timeoutMs })
        throw error
      } finally { try { record(startedAt) } finally { release() } }
    },
    /**
     * Yields deltas; the caller owns the SSE envelope. A provider failure after the
     * stream is open throws, so the caller can emit an error frame instead of a fake stop.
     */
    async *chunks(): AsyncGenerator<ChatCompletionChunk> {
      const startedAt = performance.now()
      let admitted = false
      let release = () => {}
      try {
        guards.check()
        release = guards.start(output.id)
        admitted = true
        yield output.open()
        for await (const event of client.stream(request)) {
          if (event.type === 'error') throw new Error(event.error)
          for (const chunk of output.consume(event)) yield chunk
          if (event.type === 'done') {
            yield output.finish(event.response).chunk
            if (includeUsage) {
              const usage = output.usageChunk()
              if (usage) yield usage
            }
            return
          }
        }
        // An EOF without a terminal event is never a successful response.
        throw new Error('Provider stream ended before completion')
      } catch (error) {
        if (!input.signal.aborted) {
          logUpstreamFailure(error, { requestId: output.id, provider: group.provider, timeoutMs: providerConfig.timeoutMs })
        }
        throw error
      } finally { try { if (admitted) record(startedAt) } finally { release() } }
    },
  }
}
