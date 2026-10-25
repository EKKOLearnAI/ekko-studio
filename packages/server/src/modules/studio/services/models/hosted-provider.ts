import { StudioError, type ModelGatewayInput } from '../../contracts/plugins'
import { getModelRuntimeCapabilities } from '../../public/provider-runtime'
import { recordSessionUsage, type RecordSessionUsageInput } from '../usage/usage-recorder'
import type { ModelClient } from '../../../../../../ekko-agent/src/model/types'
import { getSessionAvailableModelGroups } from '../../public/session-agent-runtime'
import { resolveProviderCatalogApiMode } from '../../contracts/providers'
import { findModelApiKey } from '../model-api/keys'
import { canTranslateNative, translatedNativeRequest } from './native-adapter'
import {
  createChatEkkoAuthorizedProviderFetch, createChatEkkoModelClient,
  resolveChatEkkoModelProviderConfigs, resolveChatEkkoProviderRuntimeConfig,
} from '../../public/chat-agent-runtime'

export interface HostedModelGroup {
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

export function hostedModelApiMode(group: HostedModelGroup, model: string): string | undefined {
  return group.api_mode_by_model?.[model] || group.api_mode || resolveProviderCatalogApiMode(group.provider, model)
}

export function hostedModelSupported(group: HostedModelGroup, model: string): boolean {
  return !['bedrock_converse', 'codex_app_server'].includes(hostedModelApiMode(group, model) || '')
}

export interface HostedModelEntry { profile: string; group: HostedModelGroup; model: string; runtime?: { baseUrl: string; apiKey: string; apiMode?: string } }
export function hostedModelCallable(entry: HostedModelEntry): boolean {
  return hostedModelSupported(entry.group, entry.model) && !entry.group.model_meta?.[entry.model]?.disabled
}

function isSelfModelApi(group: HostedModelGroup): boolean {
  if (!group.base_url || !group.api_key) return false
  let url: URL
  try { url = new URL(group.base_url) } catch { return false }
  if (!['http:', 'https:'].includes(url.protocol) || !url.pathname.replace(/\/+$/, '').endsWith('/api/ekko-studio/models/v1')) return false
  // A locally issued key identifies this instance even behind a proxy or LAN URL.
  // Do not re-export the cached catalog of a provider pointing back to ourselves.
  return findModelApiKey(group.api_key.trim()) !== null
}

export async function hostedModelCatalog(profiles: string[]): Promise<Map<string, HostedModelEntry>> {
  const names = [...new Set(profiles)]
  const groupsByProfile = await Promise.all(names.map(profile => getSessionAvailableModelGroups(profile) as Promise<HostedModelGroup[]>))
  const catalog = new Map<string, HostedModelEntry>()
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
        if (!existing || (!hostedModelCallable(existing) && hostedModelCallable(entry))) catalog.set(id, entry)
      }
    }
  }
  return catalog
}

/** Internal provider closure: callers authorize the profile; credentials never leave the client factory. */
export async function resolveHostedModel(entry: HostedModelEntry, authorize: () => void = () => {}) {
  authorize()
  const { profile, group, model } = entry
  const runtime = await resolveChatEkkoProviderRuntimeConfig({ profile, provider: group.provider, model, apiMode: hostedModelApiMode(group, model), ...entry.runtime })
  authorize()
  const { providerConfig } = resolveChatEkkoModelProviderConfigs({ ...runtime, provider: group.provider, model })
  const fetch = createChatEkkoAuthorizedProviderFetch({ profile, provider: group.provider, model, accessToken: runtime.apiKey })
  const client: ModelClient = createChatEkkoModelClient(providerConfig, { fetch: (input: Parameters<typeof globalThis.fetch>[0], init: Parameters<typeof globalThis.fetch>[1]) => {
    authorize()
    return fetch(input, init)
  } })
  return { client, baseUrl: providerConfig.baseUrl, accountingBaseUrl: runtime.baseUrl, requestStyle: providerConfig.requestStyle }
}

export interface NativeModelTarget {
  transport?: 'native' | 'translated'
  images?: boolean
  request(body: Record<string, unknown>, signal: AbortSignal, sessionId: string): Promise<Response>
  record(input: Omit<RecordSessionUsageInput, 'profile' | 'provider' | 'model' | 'baseUrl'>): void
}

/** Resolve the CLI-facing protocol without exporting provider configuration or credentials. */
export async function resolveNativeModel(profileId: string, modelId: string, protocol: ModelGatewayInput['protocol'], authorize: () => void, selected?: HostedModelEntry): Promise<NativeModelTarget> {
  authorize()
  const entry = selected || (await hostedModelCatalog([profileId])).get(modelId)
  authorize()
  if (!entry || !hostedModelCallable(entry)) throw new StudioError('NOT_FOUND', 'Model is unavailable')
  const resolved = await resolveHostedModel(entry, authorize)
  authorize()
  const native = resolved.client.nativeRequest && resolved.requestStyle === { responses: 'openai-responses', anthropic: 'anthropic-messages', 'chat-completions': 'openai-chat' }[protocol]
  const images = resolved.client.capabilities.vision && getModelRuntimeCapabilities({ profile: entry.profile, provider: entry.group.provider, model: entry.model })?.input?.includes('image') === true
  if (!native && !canTranslateNative(resolved.client, protocol)) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Model does not support this protocol conversion')
  authorize()
  return {
    transport: native ? 'native' : 'translated', images,
    request: (body: Record<string, unknown>, signal: AbortSignal, sessionId: string) => {
      authorize()
      return native ? resolved.client.nativeRequest!(body, { model: entry.model, messages: [], signal, metadata: { session_id: sessionId } })
        : translatedNativeRequest({ client: resolved.client, protocol, model: entry.model, publicModel: modelId, body, baseUrl: resolved.baseUrl, signal, sessionId, authorize, images })
    },
    record: (input: Omit<RecordSessionUsageInput, 'profile' | 'provider' | 'model' | 'baseUrl'>) => recordSessionUsage({ ...input,
      profile: entry.profile, provider: entry.group.provider, model: entry.model, baseUrl: resolved.accountingBaseUrl }),
  }
}
