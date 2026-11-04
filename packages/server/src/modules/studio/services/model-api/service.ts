import type { ModelClient, ModelProviderConfig } from '../../../../../../ekko-agent/src/model/types'
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

export async function prepareModelResponse(input: {
  profiles: string[]
  onUsage?: (usage: RecordedUsage) => void
  accountId?: string
  apiKeyId?: string
  allowedModels?: readonly string[]
  body: unknown
  signal: AbortSignal
}) {
  validateResponsesBody(input.body)
  const checkBudget = () => { if (input.apiKeyId && input.accountId) checkModelApiBudget(Number(input.accountId), input.apiKeyId) }
  const startAccounting = (id: string) => input.apiKeyId && input.accountId ? startModelApiKeyRequest(Number(input.accountId), input.apiKeyId, id) : () => {}
  checkBudget()
  const body = input.body
  if (input.allowedModels && !input.allowedModels.includes(body.model)) throw new ModelApiError('Model is not available.', 404, 'model')
  const catalog = await unifiedCatalog(input.profiles)
  const selected = catalog.get(body.model)
  if (!selected || selected.group.model_meta?.[selected.model]?.disabled) throw new ModelApiError('Model is not available.', 404, 'model')
  const { profile, group, model } = selected
  if (!supported(group, model)) throw new ModelApiError('This provider requires a runtime that does not support direct model requests.', 501, 'model')
  const runtime = await resolveChatEkkoProviderRuntimeConfig({ profile, provider: group.provider, model, apiMode: apiMode(group, model) })
  const resolved: { providerConfig: ModelProviderConfig } = resolveChatEkkoModelProviderConfigs({
    ...runtime, provider: group.provider, model,
  })
  const codec = await reasoningCodec(JSON.stringify([profile, group.provider, model, resolved.providerConfig.baseUrl, resolved.providerConfig.requestStyle]))
  const request = responsesModelRequest(body, model, codec, input.signal)
  const client: ModelClient = createChatEkkoModelClient(resolved.providerConfig, { fetch: createChatEkkoAuthorizedProviderFetch({
    profile, provider: group.provider, model, accessToken: runtime.apiKey,
  }) })
  if (request.messages.some(message => message.contentParts?.some(part => part.type === 'image')) && !client.capabilities.vision) {
    throw new ModelApiError('This model does not support images.', 400, 'input')
  }
  const output = new ResponsesOutput(body.model, codec, body, resolved.providerConfig.requestStyle !== 'openai-responses')
  let recorded = false
  const record = (startedAt: number) => {
    if (recorded) return
    recorded = true
    recordSessionUsage({
      onRecorded: input.onUsage,
      sessionId: '', runId: output.id, origin: 'external', accountId: input.accountId, modelApiKeyId: input.apiKeyId,
      source: 'model_api', agent: 'model_api', usageScope: 'model_call', apiCalls: 1,
      profile, provider: group.provider, model, baseUrl: runtime.baseUrl,
      usage: output.usage, apiDuration: (performance.now() - startedAt) / 1000,
    })
  }
  checkBudget()
  return {
    id: output.id,
    stream: body.stream === true,
    async create() {
      checkBudget()
      const release = startAccounting(output.id)
      const startedAt = performance.now()
      try {
        const result = await client.create(request)
        const events = output.finish(result)
        return events[events.length - 1].response
      } finally { try { record(startedAt) } finally { release() } }
    },
    async *events(): AsyncGenerator<ResponsesEvent> {
      const startedAt = performance.now()
      let admitted = false
      let release = () => {}
      try {
        checkBudget()
        release = startAccounting(output.id)
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
          logger.warn({ requestId: output.id, provider: group.provider }, 'Model API stream failed')
          yield output.event('response.failed', { response: output.response('failed', modelApiErrorBody(error).body.error) })
        }
      } finally { try { if (admitted) record(startedAt) } finally { release() } }
    },
  }
}
