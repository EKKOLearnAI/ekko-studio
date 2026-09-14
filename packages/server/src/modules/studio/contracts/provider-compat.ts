/**
 * Compatibility layer for the two `config.yaml` provider schemas used by Hermes Agent.
 *
 * Hermes Agent's v12 migration converts `custom_providers:` (a list of provider
 * entries) into `providers:` (a dict keyed by provider name) and deletes the list.
 * Agent itself ships a compatibility helper, `get_compatible_custom_providers()`,
 * so every consumer in core sees a unified list view across both schemas:
 *
 *   https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/config.py
 *
 * Studio historically only read the legacy `custom_providers:` list, which makes
 * v12+ dict-shaped providers invisible in the model picker, catalog, and context
 * lookups (Issue #1570). This helper mirrors Agent's behavior so Studio can read
 * both shapes; write paths intentionally still target the legacy list (that's
 * the canonical write surface Studio's UI manipulates today).
 */

const KNOWN_KEYS = new Set([
  'name', 'api', 'url', 'base_url',
  'api_key', 'key_env', 'api_key_env',
  'api_mode', 'transport',
  'model', 'default_model',
  'models',
  'context_length', 'rate_limit_delay',
  'request_timeout_seconds', 'stale_timeout_seconds',
  'discover_models', 'extra_body', 'extra_headers', 'preserve_client_identity', 'proxy_url', 'proxy',
])

const CAMEL_ALIASES: Record<string, string> = {
  apiKey: 'api_key',
  baseUrl: 'base_url',
  apiMode: 'api_mode',
  keyEnv: 'key_env',
  apiKeyEnv: 'key_env',
  defaultModel: 'default_model',
  contextLength: 'context_length',
  rateLimitDelay: 'rate_limit_delay',
  extraHeaders: 'extra_headers',
  preserveClientIdentity: 'preserve_client_identity',
  proxyUrl: 'proxy_url',
  proxy: 'proxy_url',
}

type ProviderApiMode = 'chat_completions' | 'codex_responses' | 'anthropic_messages' | 'bedrock_converse' | 'codex_app_server'

export interface NormalizedCustomProvider {
  name: string
  base_url: string
  source: 'custom_providers' | 'providers'
  provider_key?: string
  api_key?: string
  key_env?: string
  api_mode?: ProviderApiMode
  model?: string
  models?: Record<string, any>
  context_length?: number
  rate_limit_delay?: number
  discover_models?: boolean
  extra_body?: Record<string, any>
  extra_headers?: Record<string, string>
  preserve_client_identity?: boolean
  proxy_url?: string
}

function looksLikeUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return !!url.protocol && !!url.host
  } catch {
    return false
  }
}

function normalizeApiMode(value: unknown): ProviderApiMode | undefined {
  return value === 'chat_completions' ||
    value === 'codex_responses' ||
    value === 'anthropic_messages' ||
    value === 'bedrock_converse' ||
    value === 'codex_app_server'
    ? value
    : undefined
}

/**
 * Translate one provider entry (from either schema) into the unified record
 * shape Studio's read paths expect. Returns `null` if the entry has no usable
 * `base_url` or `name` — matching `_normalize_custom_provider_entry()`'s
 * silent-drop semantics in Agent.
 */
export function normalizeCustomProviderEntry(
  entry: any,
  providerKey: string = '',
  source: 'custom_providers' | 'providers' = providerKey ? 'providers' : 'custom_providers',
): NormalizedCustomProvider | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null

  const e: Record<string, any> = { ...entry }

  // `api_key_env` is a documented snake_case alias for `key_env` (see
  // upstream guide for Azure Foundry). Normalize before applying camelCase
  // aliases so the canonical field always wins.
  if ('api_key_env' in e && !('key_env' in e)) {
    e.key_env = e.api_key_env
  }

  for (const [camel, snake] of Object.entries(CAMEL_ALIASES)) {
    if (camel in e && !(snake in e)) {
      e[snake] = e[camel]
    }
  }

  // base_url: try base_url, then url, then api — accept first valid URL.
  let baseUrl = ''
  for (const key of ['base_url', 'url', 'api'] as const) {
    const raw = e[key]
    if (typeof raw === 'string' && raw.trim()) {
      const candidate = raw.trim()
      if (looksLikeUrl(candidate)) {
        baseUrl = candidate
        break
      }
    }
  }
  if (!baseUrl) return null

  // name: prefer entry.name, fall back to dict key.
  let name = ''
  if (typeof e.name === 'string' && e.name.trim()) {
    name = e.name.trim()
  } else if (providerKey && providerKey.trim()) {
    name = providerKey.trim()
  }
  if (!name) return null

  const normalized: NormalizedCustomProvider = { name, base_url: baseUrl, source }

  if (providerKey && providerKey.trim()) {
    normalized.provider_key = providerKey.trim()
  }

  if (typeof e.api_key === 'string' && e.api_key.trim()) {
    normalized.api_key = e.api_key.trim()
  }
  if (typeof e.key_env === 'string' && e.key_env.trim()) {
    normalized.key_env = e.key_env.trim()
  }

  const apiMode = e.api_mode || e.transport
  if (typeof apiMode === 'string' && apiMode.trim()) {
    normalized.api_mode = normalizeApiMode(apiMode.trim())
  }

  const modelName = e.model || e.default_model
  if (typeof modelName === 'string' && modelName.trim()) {
    normalized.model = modelName.trim()
  }

  // models: accept dict (v12+ canonical) or list (hand-edited / legacy).
  if (e.models && typeof e.models === 'object' && !Array.isArray(e.models)) {
    if (Object.keys(e.models).length > 0) {
      normalized.models = e.models
    }
  } else if (Array.isArray(e.models) && e.models.length > 0) {
    const dict: Record<string, any> = {}
    for (const m of e.models) {
      if (typeof m === 'string' && m.trim()) {
        dict[m] = {}
      }
    }
    if (Object.keys(dict).length > 0) {
      normalized.models = dict
    }
  }

  if (typeof e.context_length === 'number' && Number.isInteger(e.context_length) && e.context_length > 0) {
    normalized.context_length = e.context_length
  }
  if (typeof e.rate_limit_delay === 'number' && e.rate_limit_delay >= 0) {
    normalized.rate_limit_delay = e.rate_limit_delay
  }
  if (typeof e.discover_models === 'boolean') {
    normalized.discover_models = e.discover_models
  }
  if (e.extra_body && typeof e.extra_body === 'object' && !Array.isArray(e.extra_body)) {
    normalized.extra_body = { ...e.extra_body }
  }
  if (e.extra_headers && typeof e.extra_headers === 'object' && !Array.isArray(e.extra_headers)) {
    normalized.extra_headers = Object.fromEntries(Object.entries(e.extra_headers)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .map(([name, value]) => [name.toLowerCase(), value]))
  }
  if (typeof e.preserve_client_identity === 'boolean') normalized.preserve_client_identity = e.preserve_client_identity
  if (typeof e.proxy_url === 'string' && e.proxy_url.trim()) normalized.proxy_url = e.proxy_url.trim()

  // Surface unknown keys in the logs — same intent as Agent's warning, kept
  // soft so unfamiliar fields don't break callers.
  const unknown = Object.keys(e).filter(k => !KNOWN_KEYS.has(k) && !(k in CAMEL_ALIASES))
  if (unknown.length > 0) {
    // Use console here to avoid the logger import cycle; this branch is rare
    // and only fires for hand-edited configs.
    // eslint-disable-next-line no-console
    console.warn(
      `[config-helpers] providers.${providerKey || '?'}: unknown config keys ignored: ${unknown.join(', ')}`,
    )
  }

  return normalized
}

/**
 * Return the full set of custom providers visible to Studio, drawn from both
 * schemas with name/base_url/model deduplication. Mirrors Hermes Agent's
 * `get_compatible_custom_providers()`.
 *
 * Order: legacy list entries first, then v12+ dict entries — matching Agent's
 * traversal order so a hand-written list entry takes precedence over a
 * dict entry with the same identity.
 */
export function getCompatibleCustomProviders(config: any): NormalizedCustomProvider[] {
  if (!config || typeof config !== 'object') return []

  const out: NormalizedCustomProvider[] = []
  const seenProviderKeys = new Set<string>()
  const seenIdentityTriples = new Set<string>()

  const appendIfNew = (entry: NormalizedCustomProvider | null): void => {
    if (!entry) return
    const providerKey = (entry.provider_key || '').trim().toLowerCase()
    const name = entry.name.trim().toLowerCase()
    const baseUrl = entry.base_url.trim().replace(/\/+$/, '').toLowerCase()
    const model = (entry.model || '').trim().toLowerCase()
    const triple = `${name}|${baseUrl}|${model}`

    if (providerKey && seenProviderKeys.has(providerKey)) return
    if (name && baseUrl && seenIdentityTriples.has(triple)) return

    out.push(entry)
    if (providerKey) seenProviderKeys.add(providerKey)
    if (name && baseUrl) seenIdentityTriples.add(triple)
  }

  const legacy = config.custom_providers
  if (legacy !== undefined) {
    if (!Array.isArray(legacy)) return [] // matches Agent: malformed legacy block bails out entirely
    for (const entry of legacy) {
      appendIfNew(normalizeCustomProviderEntry(entry, '', 'custom_providers'))
    }
  }

  const dict = config.providers
  if (dict && typeof dict === 'object' && !Array.isArray(dict)) {
    for (const [key, entry] of Object.entries(dict)) {
      appendIfNew(normalizeCustomProviderEntry(entry, key, 'providers'))
    }
  }

  return out
}

const SCOPED_CODING_AGENT_AUTH_PROVIDERS = new Set([
  'openai-codex',
  'copilot',
  'xai-oauth',
  'qwen-oauth',
  'nous',
  'claude-oauth',
  'minimax-oauth',
])

export function isScopedCodingAgentAuthProvider(provider: unknown): boolean {
  return SCOPED_CODING_AGENT_AUTH_PROVIDERS.has(String(provider || '').trim().toLowerCase())
}

export function assertScopedCodingAgentProviderAllowed(mode: 'scoped' | 'global', provider: unknown): void {
  if (mode === 'global' || !isScopedCodingAgentAuthProvider(provider)) return
  const error = new Error('Coding agent scoped mode does not support OAuth/subscription providers. Use global mode or select an API-key provider.')
  ;(error as any).status = 400
  throw error
}
