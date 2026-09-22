/**
 * OrcaRouter endpoint and capability metadata.
 *
 * OrcaRouter splits its public surface across two origins:
 *
 * - authentication and code exchange: `https://www.orcarouter.ai`
 *   (consent screen `/auth`, exchange `POST /api/v1/auth/keys`)
 * - inference and model discovery: `https://api.orcarouter.ai/v1`
 *
 * The two must never be derived from one another: replacing the hostname or
 * appending `/v1` to the auth origin produces `https://api.orcarouter.ai/v1/auth/keys`,
 * which is a 404.
 */

export const ORCAROUTER_PROVIDER = 'orcarouter'
export const ORCAROUTER_OAUTH_PROVIDER = 'orcarouter-oauth'
export const ORCAROUTER_LABEL = 'OrcaRouter'
export const ORCAROUTER_OAUTH_LABEL = 'OrcaRouter - Auth'

export const ORCAROUTER_DEFAULT_AUTH_BASE = 'https://www.orcarouter.ai'
export const ORCAROUTER_DEFAULT_API_BASE = 'https://api.orcarouter.ai/v1'
/** Profile `.env` key holding the shared inference base URL override. */
export const ORCAROUTER_BASE_URL_ENV = 'ORCAROUTER_BASE_URL'
export const ORCAROUTER_AUTHORIZE_PATH = '/auth'
export const ORCAROUTER_EXCHANGE_PATH = '/api/v1/auth/keys'
export const ORCAROUTER_KEY_DASHBOARD_URL = 'https://www.orcarouter.ai/console/token'
export const ORCAROUTER_AUTHORIZED_APPS_URL = 'https://www.orcarouter.ai/console/authorized-apps'
export const ORCAROUTER_LOGO_URL = 'https://www.orcarouter.ai/orca-logo-classic.png'
export const ORCAROUTER_SCOPE = 'api'
export const ORCAROUTER_API_KEY_PREFIX = 'sk-orca-'
/** Label shown on the OrcaRouter consent screen. */
export const ORCAROUTER_APP_NAME = 'Ekko Studio'

/**
 * Capabilities this client can speak. Anything the catalog advertises outside
 * this set is dropped rather than offered as a route the client cannot call.
 */
export const ORCAROUTER_SUPPORTED_ENDPOINT_TYPES = ['openai', 'anthropic', 'gemini', 'openai-response'] as const
export const ORCAROUTER_TEXT_ENDPOINT_TYPES = new Set<string>(ORCAROUTER_SUPPORTED_ENDPOINT_TYPES)

/** Catalog capabilities accepted by `GET /v1/models?capability=`. */
export type OrcaRouterCapability = 'chat' | 'embedding' | 'image' | 'video' | 'rerank'

/** Non-text model families excluded from every text selector. */
const NON_TEXT_ENDPOINT_TYPES = new Set(['image-generation', 'openai-video', 'jina-rerank', 'embedding'])

export interface OrcaRouterCatalogModel {
  id: string
  supported_endpoint_types: string[]
  input_modalities: string[]
  context_length?: number
  reasoning_efforts: string[]
  max_completion_tokens?: number
}

export interface OrcaRouterCatalog {
  models: OrcaRouterCatalogModel[]
  source: 'live' | 'seed'
  capability: OrcaRouterCapability
  degraded: boolean
  reason?: string
}

/**
 * Bounded catalog read. A gateway catalog is remote input: cap the response
 * bytes, the item count, and the accepted item shape so a hostile or broken
 * response cannot consume unbounded memory or advertise routes we cannot call.
 */
export const ORCAROUTER_CATALOG_TIMEOUT_MS = 8000
export const ORCAROUTER_CATALOG_MAX_BYTES = 2 * 1024 * 1024
export const ORCAROUTER_CATALOG_MAX_MODELS = 10_000
export const ORCAROUTER_CATALOG_MAX_REDIRECTS = 3

/**
 * Verified cold-start seed. Live discovery is authoritative; this list only
 * keeps a fresh installation usable while the catalog endpoint is slow or
 * unavailable. It is the campaign's verified generic seed, and the
 * `deepseek/deepseek-v4-pro` and `orcarouter/auto` entries were additionally
 * confirmed against `GET https://api.orcarouter.ai/v1/models?capability=chat`.
 * Metadata here is verified, never inferred from a model name.
 */
export const ORCAROUTER_SEED_MODELS: OrcaRouterCatalogModel[] = [
  {
    id: 'openai/gpt-5.5',
    supported_endpoint_types: ['openai', 'openai-response'],
    input_modalities: ['text'],
    context_length: 400_000,
    reasoning_efforts: ['low', 'medium', 'high', 'xhigh'],
  },
  {
    id: 'anthropic/claude-opus-4.8',
    supported_endpoint_types: ['anthropic', 'openai'],
    input_modalities: ['text'],
    context_length: 200_000,
    reasoning_efforts: ['low', 'medium', 'high'],
  },
  {
    id: 'google/gemini-3.5-flash',
    supported_endpoint_types: ['gemini', 'openai'],
    input_modalities: ['text'],
    context_length: 1_000_000,
    reasoning_efforts: [],
  },
  {
    id: 'deepseek/deepseek-v4-pro',
    supported_endpoint_types: ['openai', 'openai-response'],
    input_modalities: ['text'],
    context_length: 1_048_576,
    reasoning_efforts: [],
  },
  {
    id: 'orcarouter/auto',
    supported_endpoint_types: ['openai', 'openai-response', 'anthropic', 'gemini'],
    input_modalities: ['text'],
    reasoning_efforts: [],
  },
]

export interface OrcaRouterOrigins {
  authBase: string
  apiBase: string
}

export class OrcaRouterOriginError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OrcaRouterOriginError'
  }
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

/**
 * Remote origins must be HTTPS. Plain HTTP is permitted only for loopback
 * development, matching the repository's existing local-provider policy.
 */
export function normalizeOrcaRouterOrigin(raw: unknown, fallback: string): string {
  const value = String(raw ?? '').trim()
  if (!value) return fallback
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new OrcaRouterOriginError('OrcaRouter base URL must be an absolute http(s) URL')
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    throw new OrcaRouterOriginError('OrcaRouter base URL must use HTTPS (HTTP is allowed only for loopback)')
  }
  if (url.username || url.password) {
    throw new OrcaRouterOriginError('OrcaRouter base URL must not contain credentials')
  }
  return url.toString().replace(/\/+$/, '')
}

/**
 * Resolve the two origins independently. Explicit per-origin overrides win over
 * the shared self-hosted fallback, which in turn wins over the public defaults.
 */
export function resolveOrcaRouterOrigins(env: NodeJS.ProcessEnv = process.env): OrcaRouterOrigins {
  const shared = String(env.ORCA_BASE_URL ?? '').trim()
  const sharedAuth = shared ? normalizeOrcaRouterOrigin(shared, ORCAROUTER_DEFAULT_AUTH_BASE) : ''
  const sharedApi = shared ? normalizeOrcaRouterOrigin(shared, ORCAROUTER_DEFAULT_API_BASE) : ''
  const authBase = normalizeOrcaRouterOrigin(
    env.ORCA_AUTH_BASE_URL || sharedAuth,
    ORCAROUTER_DEFAULT_AUTH_BASE,
  )
  const apiBase = normalizeOrcaRouterOrigin(
    env.ORCA_API_BASE_URL || sharedApi,
    ORCAROUTER_DEFAULT_API_BASE,
  )
  return { authBase, apiBase }
}

/** The inference base the OpenAI-compatible adapter expects (`.../v1`). */
export function normalizeOrcaRouterApiBase(raw: string): string {
  const base = String(raw || '').trim().replace(/\/+$/, '')
  if (!base) return ORCAROUTER_DEFAULT_API_BASE
  return /\/v\d+$/.test(base) ? base : `${base}/v1`
}

export function orcaRouterAuthorizeUrl(authBase: string): string {
  return new URL(ORCAROUTER_AUTHORIZE_PATH, `${authBase.replace(/\/+$/, '')}/`).toString()
}

export function orcaRouterExchangeUrl(authBase: string): string {
  return `${authBase.replace(/\/+$/, '')}${ORCAROUTER_EXCHANGE_PATH}`
}

export function orcaRouterModelsUrl(apiBase: string, capability: OrcaRouterCapability): string {
  const url = new URL(`${normalizeOrcaRouterApiBase(apiBase)}/models`)
  url.searchParams.set('capability', capability)
  return url.toString()
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map(item => String(item ?? '').trim().toLowerCase())
    .filter(Boolean)
}

function reasoningEfforts(value: unknown): string[] {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const efforts = asStringList(record.supported_efforts ?? record.efforts ?? record.supported_reasoning_efforts)
  return efforts
}

/**
 * Accept only records whose advertised routes the client can actually speak.
 * A model with no `supported_endpoint_types` fails closed: an undeclared
 * capability is not a capability.
 */
export function normalizeOrcaRouterCatalogModel(raw: unknown): OrcaRouterCatalogModel | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const id = String(record.id ?? '').trim()
  if (!id || id.length > 512) return null
  const architecture = record.architecture && typeof record.architecture === 'object' && !Array.isArray(record.architecture)
    ? record.architecture as Record<string, unknown>
    : {}
  const contextLength = Number(record.context_length)
  const maxCompletionTokens = Number(record.max_completion_tokens)
  return {
    id,
    supported_endpoint_types: asStringList(record.supported_endpoint_types),
    input_modalities: asStringList(architecture.input_modalities),
    ...(Number.isFinite(contextLength) && contextLength > 0 ? { context_length: contextLength } : {}),
    ...(Number.isFinite(maxCompletionTokens) && maxCompletionTokens > 0
      ? { max_completion_tokens: maxCompletionTokens }
      : {}),
    reasoning_efforts: reasoningEfforts(record.reasoning),
  }
}

export function normalizeOrcaRouterCatalogModels(raw: unknown): OrcaRouterCatalogModel[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown }).data)
      ? (raw as { data: unknown[] }).data
      : []
  const models: OrcaRouterCatalogModel[] = []
  const seen = new Set<string>()
  for (const item of list.slice(0, ORCAROUTER_CATALOG_MAX_MODELS)) {
    const model = normalizeOrcaRouterCatalogModel(item)
    if (!model || seen.has(model.id)) continue
    seen.add(model.id)
    models.push(model)
  }
  return models
}

/**
 * Capability filters. Each AI entry point gets its own filter: a model that
 * merely exists is not a model that can serve the request.
 */
export function filterOrcaRouterModels(
  models: OrcaRouterCatalogModel[],
  capability: OrcaRouterCapability,
): OrcaRouterCatalogModel[] {
  switch (capability) {
    case 'chat':
      return models.filter(model => isOrcaRouterChatModel(model))
    case 'embedding':
      return models.filter(model => model.supported_endpoint_types.includes('embedding'))
    case 'image':
      return models.filter(model => model.supported_endpoint_types.includes('image-generation'))
    case 'video':
      return models.filter(model => model.supported_endpoint_types.includes('openai-video'))
    case 'rerank':
      return models.filter(model => model.supported_endpoint_types.includes('jina-rerank'))
  }
}

export function isOrcaRouterChatModel(model: OrcaRouterCatalogModel): boolean {
  if (model.supported_endpoint_types.some(type => NON_TEXT_ENDPOINT_TYPES.has(type))) return false
  return model.supported_endpoint_types.some(type => ORCAROUTER_TEXT_ENDPOINT_TYPES.has(type))
}

/**
 * Multimodal understanding requires chat first, then an *explicit* declaration
 * of the modality the entry point uploads. Undeclared modalities fail closed.
 */
export function isOrcaRouterMultimodalModel(
  model: OrcaRouterCatalogModel,
  modality: 'image' | 'audio' | 'video',
): boolean {
  return isOrcaRouterChatModel(model) && model.input_modalities.includes(modality)
}

export function seedOrcaRouterCatalog(capability: OrcaRouterCapability): OrcaRouterCatalogModel[] {
  return filterOrcaRouterModels(ORCAROUTER_SEED_MODELS, capability)
}
