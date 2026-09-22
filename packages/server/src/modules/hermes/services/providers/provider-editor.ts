import { openCodeSessionHeaders } from '../../../studio/public/opencode-session'
import { openRouterAttributionHeaders } from '../../../studio/public/openrouter-attribution'
import { createHash, randomBytes } from 'crypto'
import { chmod } from 'fs/promises'
import { join, resolve } from 'path'
import YAML from 'js-yaml'
import { normalizeCustomProviderEntry } from '../../../studio/contracts/provider-compat'
import { PROVIDER_PRESETS } from '../../../studio/contracts/providers'
import {
  ORCAROUTER_OAUTH_PROVIDER,
  ORCAROUTER_PROVIDER,
  filterOrcaRouterModels,
  normalizeOrcaRouterApiBase,
  normalizeOrcaRouterCatalogModels,
  orcaRouterModelsUrl,
  ORCAROUTER_BASE_URL_ENV,
  ORCAROUTER_CATALOG_MAX_BYTES,
  type OrcaRouterCapability,
} from '../../../studio/public/orcarouter-catalog'
import {
  appConfigFilePath,
  invalidateAppConfigCache,
  type AppConfig,
} from '../../../studio/public/app-config'
import { readProviderContextLengths, writeProviderContextLengths } from '../../../studio/public/provider-context'
import { getProfileDir, PROVIDER_ENV_MAP } from '../../../studio/public/profile-config'
import { safeFileStore, type MultiTextUpdate } from '../../../studio/public/safe-file-store'

export type ProviderApiMode = 'chat_completions' | 'codex_responses' | 'anthropic_messages' | 'bedrock_converse' | 'codex_app_server'
export type ProviderEditableField =
  | 'label'
  | 'base_url'
  | 'api_key'
  | 'api_mode'
  | 'preferred_model'
  | 'context_lengths'
  | 'discover_models'
  | 'rate_limit_delay'
  | 'request_timeout_seconds'
  | 'stale_timeout_seconds'
  | 'extra_body'
export type CredentialAction = 'keep' | 'replace' | 'clear'

export interface ProviderEditorDetail {
  id: string
  label: string
  builtin: boolean
  source: 'builtin_env' | 'custom_providers' | 'providers'
  source_key?: string
  base_url: string
  api_mode?: ProviderApiMode
  preferred_model: string
  credential_configured: boolean
  editable: boolean
  editable_fields: ProviderEditableField[]
  context_lengths: Record<string, number>
  discover_models?: boolean
  rate_limit_delay?: number
  request_timeout_seconds?: number
  stale_timeout_seconds?: number
  extra_body?: Record<string, unknown>
  connection_test_supported: boolean
  connection_test_reason?: string
  revision: string
}

export interface ProviderEditorPatch {
  revision?: string
  label?: string
  base_url?: string
  api_mode?: ProviderApiMode
  preferred_model?: string
  credential_action?: CredentialAction
  api_key?: string
  discover_models?: boolean
  rate_limit_delay?: number | null
  request_timeout_seconds?: number | null
  stale_timeout_seconds?: number | null
  extra_body?: Record<string, unknown> | null
}

export class ProviderEditorError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly current?: ProviderEditorDetail,
  ) {
    super(message)
  }
}

interface ProviderSource {
  id: string
  providerId: string
  builtin: boolean
  source: ProviderEditorDetail['source']
  sourceKey?: string
  configEntry?: Record<string, any>
  preset?: (typeof PROVIDER_PRESETS)[number]
  envMapping?: (typeof PROVIDER_ENV_MAP)[string]
}

function parseYaml(raw: string | undefined): Record<string, any> {
  if (!raw?.trim()) return {}
  return (YAML.load(raw, { json: true }) as Record<string, any>) || {}
}

function dumpYaml(data: Record<string, any>): string {
  return YAML.dump(data, { lineWidth: -1, noRefs: true, quotingType: '"' })
}

function parseJson(raw: string | undefined): Record<string, any> {
  if (!raw?.trim()) return {}
  try {
    const value = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON root must be an object')
    return value as Record<string, any>
  } catch {
    throw new ProviderEditorError('A stored JSON configuration file is invalid; repair it before editing providers', 500, 'INVALID_STORED_JSON')
  }
}

function providerKeyForCustomName(name: string): string {
  return `custom:${String(name || '').trim().toLowerCase().replace(/ /g, '-')}`
}

function parseEnv(raw: string | undefined): Map<string, string> {
  const values = new Map<string, string>()
  for (const line of String(raw || '').split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue
    let value = match[2]
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    values.set(match[1], value)
  }
  return values
}

function updateEnv(raw: string | undefined, key: string, value: string | undefined): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new ProviderEditorError(`Invalid environment key: ${key}`, 400, 'INVALID_ENV_KEY')
  const lines = String(raw || '').split(/\r?\n/)
  const pattern = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`)
  const next: string[] = []
  let replaced = false
  for (const line of lines) {
    if (!pattern.test(line)) {
      next.push(line)
      continue
    }
    if (!replaced && value !== undefined) next.push(`${key}=${value}`)
    replaced = true
  }
  if (!replaced && value !== undefined) {
    if (next.length && next[next.length - 1] !== '') next.push('')
    next.push(`${key}=${value}`)
  }
  while (next.length > 1 && next[next.length - 1] === '' && next[next.length - 2] === '') next.pop()
  return `${next.join('\n').replace(/^\n+/, '')}${next.length ? '\n' : ''}`
}

/**
 * Environment key that holds a built-in provider's base URL override. Both
 * OrcaRouter entries share one override, and the Auth entry point has no
 * `base_url_env` of its own, so the mapping cannot be read straight off
 * `PROVIDER_ENV_MAP`.
 */
function builtinBaseUrlEnvKey(source: ProviderSource): string {
  if (isOrcaRouterProvider(source.providerId)) return ORCAROUTER_BASE_URL_ENV
  return source.envMapping?.base_url_env || ''
}

function findSource(config: Record<string, any>, providerId: string): ProviderSource | null {
  if (providerId.startsWith('custom:')) {
    if (Array.isArray(config.custom_providers)) {
      const entry = (config.custom_providers as any[]).find(item => providerKeyForCustomName(item?.name) === providerId)
      if (entry && typeof entry === 'object') {
        return { id: providerId, providerId, builtin: false, source: 'custom_providers', configEntry: entry }
      }
    }
    if (config.providers && typeof config.providers === 'object' && !Array.isArray(config.providers)) {
      for (const [key, value] of Object.entries(config.providers)) {
        const normalized = normalizeCustomProviderEntry(value, key, 'providers')
        if (normalized && providerKeyForCustomName(normalized.name) === providerId) {
          return { id: providerId, providerId, builtin: false, source: 'providers', sourceKey: key, configEntry: value as Record<string, any> }
        }
      }
    }
    return null
  }

  const envMapping = PROVIDER_ENV_MAP[providerId]
  const preset = PROVIDER_PRESETS.find(item => item.value === providerId)
  if (!envMapping || !preset) return null
  // Built-in providers are editable when they own an env credential, and the
  // OrcaRouter Auth entry point is editable through its auth.json key store.
  if (!envMapping.api_key_env && !isOrcaRouterProvider(providerId)) return null
  return { id: providerId, providerId, builtin: true, source: 'builtin_env', preset, envMapping }
}

function existingAlias(entry: Record<string, any>, aliases: string[], fallback: unknown = ''): any {
  for (const key of aliases) if (Object.hasOwn(entry, key)) return entry[key]
  return fallback
}

function setExistingAlias(entry: Record<string, any>, aliases: string[], value: unknown, canonical: string): void {
  const key = aliases.find(alias => Object.hasOwn(entry, alias)) || canonical
  entry[key] = value
}

function deleteAliases(entry: Record<string, any>, aliases: string[]): void {
  for (const key of aliases) delete entry[key]
}

function normalizeApiMode(value: unknown): ProviderApiMode | undefined {
  return value === 'chat_completions' || value === 'codex_responses' || value === 'anthropic_messages' ||
    value === 'bedrock_converse' || value === 'codex_app_server' ? value : undefined
}

function normalizeUrl(value: unknown): string {
  const raw = String(value || '').trim().replace(/\/+$/, '')
  if (!raw || /[\r\n]/.test(raw)) throw new ProviderEditorError('Base URL is required', 400, 'INVALID_BASE_URL')
  let url: URL
  try { url = new URL(raw) } catch { throw new ProviderEditorError('Base URL must be a valid HTTP or HTTPS URL', 400, 'INVALID_BASE_URL') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ProviderEditorError('Base URL must use HTTP or HTTPS', 400, 'INVALID_BASE_URL')
  }
  if (url.username || url.password) {
    throw new ProviderEditorError('Base URL must not contain embedded credentials', 400, 'INVALID_BASE_URL')
  }
  return raw
}

function stableObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableObject)
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      result[key] = stableObject((value as Record<string, unknown>)[key])
    }
    return result
  }
  return value
}

function revisionFor(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stableObject(value))).digest('hex')
}

function secretFingerprint(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 16)}`
}

function storedDurableKey(auth: Record<string, any>, providerId: string): string {
  const provider = auth?.providers?.[providerId]
  const pool = auth?.credential_pool?.[providerId]
  const poolEntry = Array.isArray(pool)
    ? pool.find((entry: any) => entry && typeof entry === 'object' && (entry.api_key || entry.access_token))
    : undefined
  return String(provider?.api_key || provider?.access_token || poolEntry?.api_key || poolEntry?.access_token || '').trim()
}

function credentialInfo(
  source: ProviderSource,
  env: Map<string, string>,
  auth: Record<string, any> = {},
): { configured: boolean; value: string; envKey?: string } {
  if (source.source === 'builtin_env') {
    const envKey = source.envMapping!.api_key_env
    // OrcaRouter's Auth entry point keeps its PKCE-issued key in auth.json.
    // That key still belongs on this seam: replaceable and clearable here.
    if (isOrcaRouterProvider(source.providerId)) {
      const value = storedDurableKey(auth, source.providerId)
      return { configured: !!value, value, ...(envKey ? { envKey } : {}) }
    }
    const value = env.get(envKey) || ''
    return { configured: !!value.trim(), value, envKey }
  }
  const normalized = normalizeCustomProviderEntry(source.configEntry, source.sourceKey || '', source.source === 'providers' ? 'providers' : 'custom_providers')
  const envKey = normalized?.key_env
  const value = envKey ? env.get(envKey) || '' : String(normalized?.api_key || '')
  return { configured: !!value.trim(), value, ...(envKey ? { envKey } : {}) }
}

const CUSTOM_PROVIDER_EDITABLE_FIELDS: ProviderEditableField[] = [
  'label',
  'base_url',
  'api_key',
  'api_mode',
  'preferred_model',
  'context_lengths',
  'discover_models',
  'rate_limit_delay',
  'request_timeout_seconds',
  'stale_timeout_seconds',
  'extra_body',
]

function editableFields(source: ProviderSource): ProviderEditableField[] {
  if (!source.builtin) return [...CUSTOM_PROVIDER_EDITABLE_FIELDS]
  // OrcaRouter's Auth entry point stores its key in auth.json rather than the
  // profile .env, but it is still user-replaceable and user-clearable.
  if (isOrcaRouterProvider(source.providerId)) {
    return ['label', 'base_url', 'api_key', 'preferred_model', 'context_lengths']
  }
  const fields: ProviderEditableField[] = ['label', 'api_key', 'preferred_model', 'context_lengths']
  if (source.envMapping?.base_url_env) fields.splice(1, 0, 'base_url')
  return fields
}

export function providerEditorCapabilities(providerId: string): {
  editable: boolean
  editable_fields: ProviderEditableField[]
} {
  if (providerId.startsWith('custom:')) {
    return { editable: true, editable_fields: [...CUSTOM_PROVIDER_EDITABLE_FIELDS] }
  }
  const envMapping = PROVIDER_ENV_MAP[providerId]
  if (isOrcaRouterProvider(providerId)) {
    return { editable: true, editable_fields: ['label', 'base_url', 'api_key', 'preferred_model', 'context_lengths'] }
  }
  if (!envMapping?.api_key_env) return { editable: false, editable_fields: [] }
  const fields: ProviderEditableField[] = ['label', 'api_key', 'preferred_model', 'context_lengths']
  if (envMapping.base_url_env) fields.splice(1, 0, 'base_url')
  return { editable: true, editable_fields: fields }
}

function contextLengths(profile: string, providerId: string): Record<string, number> {
  return readProviderContextLengths(profile, providerId)
}

function appProfileValue(appConfig: AppConfig, key: 'providerLabels' | 'providerPreferredModels', profile: string, providerId: string): string {
  const value = appConfig[key]?.[profile]?.[providerId]
  return typeof value === 'string' ? value.trim() : ''
}

function optionalPositiveNumber(entry: Record<string, any> | undefined, aliases: string[]): number | undefined {
  if (!entry) return undefined
  const value = Number(existingAlias(entry, aliases, Number.NaN))
  return Number.isFinite(value) && value > 0 ? value : undefined
}

function optionalObject(entry: Record<string, any> | undefined, aliases: string[]): Record<string, unknown> | undefined {
  if (!entry) return undefined
  const value = existingAlias(entry, aliases, undefined)
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function connectionTestCapability(apiMode: ProviderApiMode | undefined): { supported: boolean; reason?: string } {
  if (apiMode === 'bedrock_converse' || apiMode === 'codex_app_server') {
    return { supported: false, reason: `Connection testing is not available for ${apiMode}` }
  }
  return { supported: true }
}

function buildDetailFromRaw(
  profile: string,
  providerId: string,
  rawConfig: string | undefined,
  rawEnv: string | undefined,
  rawAppConfig: string | undefined,
  rawAuthConfig?: string,
): ProviderEditorDetail {
  const config = parseYaml(rawConfig)
  const appConfig = parseJson(rawAppConfig) as AppConfig
  const source = findSource(config, providerId)
  if (!source) throw new ProviderEditorError(`Provider "${providerId}" is not editable`, 404, 'PROVIDER_NOT_EDITABLE')
  const env = parseEnv(rawEnv)
  const auth = parseJson(rawAuthConfig)
  const credential = credentialInfo(source, env, auth)
  const normalized = source.builtin
    ? null
    : normalizeCustomProviderEntry(source.configEntry, source.sourceKey || '', source.source === 'providers' ? 'providers' : 'custom_providers')
  const fallbackLabel = source.builtin ? source.preset!.label : normalized!.name
  const label = appProfileValue(appConfig, 'providerLabels', profile, providerId) || fallbackLabel
  const baseUrl = source.builtin
    ? (builtinBaseUrlEnvKey(source) ? env.get(builtinBaseUrlEnvKey(source)) : '') || source.preset!.base_url
    : normalized!.base_url
  const apiMode = source.builtin ? source.preset!.api_mode : normalized!.api_mode
  const preferredModel = appProfileValue(appConfig, 'providerPreferredModels', profile, providerId) ||
    (!source.builtin ? String(normalized!.model || '') : '')
  const fields = editableFields(source)
  const contexts = contextLengths(profile, providerId)
  const entry = source.configEntry
  const discoverModels = !source.builtin && typeof existingAlias(entry!, ['discover_models', 'discoverModels'], undefined) === 'boolean'
    ? Boolean(existingAlias(entry!, ['discover_models', 'discoverModels'], undefined))
    : undefined
  const rateLimitDelay = optionalPositiveNumber(entry, ['rate_limit_delay', 'rateLimitDelay'])
  const requestTimeoutSeconds = optionalPositiveNumber(entry, ['request_timeout_seconds', 'requestTimeoutSeconds'])
  const staleTimeoutSeconds = optionalPositiveNumber(entry, ['stale_timeout_seconds', 'staleTimeoutSeconds'])
  const extraBody = optionalObject(entry, ['extra_body', 'extraBody'])
  const testCapability = connectionTestCapability(apiMode)
  const revision = revisionFor({
    providerId,
    profile,
    source: source.source,
    sourceKey: source.sourceKey || '',
    entry: source.configEntry || null,
    envCredential: credential.value,
    envBaseUrl: builtinBaseUrlEnvKey(source) ? env.get(builtinBaseUrlEnvKey(source)) || '' : '',
    label,
    preferredModel,
    contexts,
  })
  return {
    id: providerId,
    label,
    builtin: source.builtin,
    source: source.source,
    ...(source.sourceKey ? { source_key: source.sourceKey } : {}),
    base_url: baseUrl,
    ...(apiMode ? { api_mode: apiMode } : {}),
    preferred_model: preferredModel,
    credential_configured: credential.configured,
    editable: fields.length > 0,
    editable_fields: fields,
    context_lengths: contexts,
    ...(discoverModels !== undefined ? { discover_models: discoverModels } : {}),
    ...(rateLimitDelay !== undefined ? { rate_limit_delay: rateLimitDelay } : {}),
    ...(requestTimeoutSeconds !== undefined ? { request_timeout_seconds: requestTimeoutSeconds } : {}),
    ...(staleTimeoutSeconds !== undefined ? { stale_timeout_seconds: staleTimeoutSeconds } : {}),
    ...(extraBody !== undefined ? { extra_body: extraBody } : {}),
    connection_test_supported: testCapability.supported,
    ...(testCapability.reason ? { connection_test_reason: testCapability.reason } : {}),
    revision,
  }
}

function profilePaths(profile: string) {
  const dir = getProfileDir(profile)
  return {
    config: resolve(join(dir, 'config.yaml')),
    env: resolve(join(dir, '.env')),
    auth: resolve(join(dir, 'auth.json')),
    app: resolve(appConfigFilePath()),
  }
}

export async function getProviderEditorDetail(profile: string, providerId: string): Promise<ProviderEditorDetail> {
  const paths = profilePaths(profile)
  const [rawConfig, rawEnv, rawApp, rawAuth] = await Promise.all([
    safeFileStore.readText(paths.config).catch(() => ''),
    safeFileStore.readText(paths.env).catch(() => ''),
    safeFileStore.readText(paths.app).catch(() => ''),
    safeFileStore.readText(paths.auth).catch(() => ''),
  ])
  return buildDetailFromRaw(profile, providerId, rawConfig, rawEnv, rawApp, rawAuth)
}

const PROVIDER_TEST_TIMEOUT_MS = 8_000
const PROVIDER_TEST_MAX_BYTES = 2 * 1024 * 1024
const PROVIDER_TEST_MAX_MODELS = 10_000

function providerModelsEndpoint(baseUrl: string, apiMode: ProviderApiMode | undefined): { url: URL; protocol: 'openai' | 'anthropic' | 'gemini' } {
  const base = new URL(baseUrl.replace(/\/+$/, ''))
  const isGeminiNative = base.hostname === 'generativelanguage.googleapis.com' && !base.pathname.endsWith('/openai')
  if (isGeminiNative) {
    base.pathname = `${base.pathname.replace(/\/+$/, '')}/models`
    return { url: base, protocol: 'gemini' }
  }
  const suffix = /\/(?:v\d+(?:beta)?|openai)\/?$/.test(base.pathname) ? '/models' : '/v1/models'
  base.pathname = `${base.pathname.replace(/\/+$/, '')}${suffix}`
  return { url: base, protocol: apiMode === 'anthropic_messages' ? 'anthropic' : 'openai' }
}

async function readLimitedResponse(response: Response): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > PROVIDER_TEST_MAX_BYTES) throw new ProviderEditorError('Provider response exceeded 2 MiB', 422, 'PROVIDER_RESPONSE_TOO_LARGE')
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

/**
 * OrcaRouter's catalog must be read per capability. The generic `/v1/models`
 * probe would happily return image, video, embedding and rerank models, and a
 * text selector must never be offered a route this client cannot speak.
 */
async function fetchOrcaRouterCapabilityCatalogForTest(
  baseUrl: string,
  apiKey: string,
  capability: OrcaRouterCapability,
): Promise<string[]> {
  const url = orcaRouterModelsUrl(normalizeOrcaRouterApiBase(baseUrl), capability)
  const response = await fetch(url, {
    headers: { Accept: 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    signal: AbortSignal.timeout(PROVIDER_TEST_TIMEOUT_MS),
  })
  if (!response.ok) {
    const code = response.status === 404 || response.status === 405 ? 'PROVIDER_CATALOG_UNAVAILABLE' : 'PROVIDER_TEST_FAILED'
    throw new ProviderEditorError(`Provider models endpoint returned HTTP ${response.status}`, 422, code)
  }
  const text = await response.text()
  if (text.length > ORCAROUTER_CATALOG_MAX_BYTES) {
    throw new ProviderEditorError('Provider returned more than 2 MiB of model metadata', 422, 'PROVIDER_MODEL_LIMIT_EXCEEDED')
  }
  let body: unknown
  try { body = JSON.parse(text) } catch { throw new ProviderEditorError('Provider returned invalid JSON', 422, 'PROVIDER_TEST_FAILED') }
  const models = filterOrcaRouterModels(normalizeOrcaRouterCatalogModels(body), capability)
  if (models.length === 0) throw new ProviderEditorError('Provider returned an empty model catalog', 422, 'PROVIDER_EMPTY_CATALOG')
  return models.map(model => model.id)
}

export function isOrcaRouterProvider(providerId: unknown): boolean {
  const id = String(providerId || '').trim().toLowerCase()
  return id === ORCAROUTER_PROVIDER || id === ORCAROUTER_OAUTH_PROVIDER
}

export async function fetchProviderCatalogForTest(baseUrl: string, apiKey: string, apiMode?: ProviderApiMode): Promise<string[]> {
  const endpoint = providerModelsEndpoint(baseUrl, apiMode)
  let current = endpoint.url
  const headers: Record<string, string> = {
    ...openCodeSessionHeaders(current.toString()),
    ...openRouterAttributionHeaders(current.toString()),
    Accept: 'application/json',
  }
  if (apiKey) {
    if (endpoint.protocol === 'anthropic') {
      headers['x-api-key'] = apiKey
      headers['anthropic-version'] = '2023-06-01'
    } else if (endpoint.protocol === 'gemini') {
      headers['x-goog-api-key'] = apiKey
    } else {
      headers.Authorization = `Bearer ${apiKey}`
    }
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TEST_TIMEOUT_MS)
  try {
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      const response = await fetch(current, { headers, redirect: 'manual', signal: controller.signal })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (!location || redirects === 3) throw new ProviderEditorError('Provider returned too many redirects', 422, 'PROVIDER_REDIRECT_REJECTED')
        const next = new URL(location, current)
        if (next.origin !== current.origin || next.protocol !== current.protocol) {
          throw new ProviderEditorError('Cross-origin provider redirects are not allowed', 422, 'PROVIDER_REDIRECT_REJECTED')
        }
        current = next
        continue
      }
      const text = await readLimitedResponse(response)
      if (!response.ok) {
        // A provider that simply never implements a model catalog answers this
        // probe with 404 or 405. The chat path it is actually used for can be
        // perfectly healthy, so the caller gets to decide what that means.
        const code = response.status === 404 || response.status === 405 ? 'PROVIDER_CATALOG_UNAVAILABLE' : 'PROVIDER_TEST_FAILED'
        throw new ProviderEditorError(`Provider models endpoint returned HTTP ${response.status}`, 422, code)
      }
      let body: any
      try { body = JSON.parse(text) } catch { throw new ProviderEditorError('Provider returned invalid JSON', 422, 'PROVIDER_TEST_FAILED') }
      const rawModels = endpoint.protocol === 'gemini' ? body?.models : body?.data
      if (!Array.isArray(rawModels)) throw new ProviderEditorError('Provider returned an unsupported model catalog', 422, 'PROVIDER_TEST_FAILED')
      if (rawModels.length > PROVIDER_TEST_MAX_MODELS) throw new ProviderEditorError('Provider returned more than 10,000 models', 422, 'PROVIDER_MODEL_LIMIT_EXCEEDED')
      const models = rawModels.map((item: any) => String(item?.id || item?.name || '').replace(/^models\//, '').trim()).filter(Boolean)
      if (models.length === 0) throw new ProviderEditorError('Provider returned an empty model catalog', 422, 'PROVIDER_EMPTY_CATALOG')
      return [...new Set(models)]
    }
    throw new ProviderEditorError('Provider redirect failed', 422, 'PROVIDER_REDIRECT_REJECTED')
  } catch (error: any) {
    if (error instanceof ProviderEditorError) throw error
    if (error?.name === 'AbortError') throw new ProviderEditorError('Provider test timed out after 8 seconds', 422, 'PROVIDER_TEST_TIMEOUT')
    throw new ProviderEditorError(error?.message || 'Provider connection test failed', 422, 'PROVIDER_TEST_FAILED')
  } finally {
    clearTimeout(timeout)
  }
}

export async function testProviderEditorDraft(
  profile: string,
  providerId: string,
  patch: ProviderEditorPatch,
): Promise<{ models: string[]; model_count: number; catalog_unavailable?: boolean }> {
  const paths = profilePaths(profile)
  const [rawConfig, rawEnv, rawApp, rawAuth] = await Promise.all([
    safeFileStore.readText(paths.config).catch(() => ''),
    safeFileStore.readText(paths.env).catch(() => ''),
    safeFileStore.readText(paths.app).catch(() => ''),
    safeFileStore.readText(paths.auth).catch(() => ''),
  ])
  const detail = buildDetailFromRaw(profile, providerId, rawConfig, rawEnv, rawApp, rawAuth)
  validatePatch(detail, patch)
  const config = parseYaml(rawConfig)
  const source = findSource(config, providerId)!
  const existingCredential = credentialInfo(source, parseEnv(rawEnv), parseJson(rawAuth)).value
  const apiKey = patch.credential_action === 'replace' ? String(patch.api_key || '') : existingCredential
  if (patch.credential_action === 'clear') throw new ProviderEditorError('Cannot test a cleared credential', 422, 'PROVIDER_TEST_NO_CREDENTIAL')
  const baseUrl = patch.base_url !== undefined ? normalizeUrl(patch.base_url) : detail.base_url
  const apiMode = patch.api_mode || detail.api_mode
  const capability = connectionTestCapability(apiMode)
  if (!capability.supported) {
    throw new ProviderEditorError(capability.reason || 'Provider connection testing is not supported', 422, 'PROVIDER_TEST_UNSUPPORTED')
  }
  try {
    const models = isOrcaRouterProvider(providerId)
      ? await fetchOrcaRouterCapabilityCatalogForTest(baseUrl, apiKey, 'chat')
      : await fetchProviderCatalogForTest(baseUrl, apiKey, apiMode)
    return { models: models.slice(0, 100), model_count: models.length }
  } catch (error) {
    // No catalog is not a failed connection. Report it as its own outcome so
    // the editor can warn and move on instead of blocking a working provider.
    if (error instanceof ProviderEditorError && error.code === 'PROVIDER_CATALOG_UNAVAILABLE') {
      return { models: [], model_count: 0, catalog_unavailable: true }
    }
    throw error
  }
}

function setNestedProfileValue(
  appConfig: Record<string, any>,
  key: 'providerLabels' | 'providerPreferredModels',
  profile: string,
  providerId: string,
  value: string,
): void {
  const root = appConfig[key] && typeof appConfig[key] === 'object' && !Array.isArray(appConfig[key]) ? appConfig[key] : {}
  const profileValues = root[profile] && typeof root[profile] === 'object' && !Array.isArray(root[profile]) ? root[profile] : {}
  profileValues[providerId] = value
  root[profile] = profileValues
  appConfig[key] = root
}

function syncAuthMetadata(
  auth: Record<string, any>,
  source: ProviderSource,
  providerId: string,
  baseUrl: string,
  credentialAction: CredentialAction,
  apiKey: string,
): void {
  auth.providers = auth.providers && typeof auth.providers === 'object' ? auth.providers : {}
  auth.credential_pool = auth.credential_pool && typeof auth.credential_pool === 'object' ? auth.credential_pool : {}
  if (credentialAction === 'clear') {
    delete auth.providers[providerId]
    delete auth.credential_pool[providerId]
    return
  }

  const entries = Array.isArray(auth.credential_pool[providerId]) ? auth.credential_pool[providerId] : []
  if (credentialAction === 'keep' && entries.length === 0) return
  const first = entries.find((entry: unknown) => entry && typeof entry === 'object') || {}
  const envKey = source.source === 'builtin_env' ? source.envMapping!.api_key_env : undefined
  const sourceLabel = source.source === 'builtin_env'
    ? `env:${envKey}`
    : `config:${source.sourceKey || String(source.configEntry?.name || providerId.replace(/^custom:/, ''))}`
  const next = {
    ...first,
    id: String(first.id || randomBytes(3).toString('hex')),
    label: String(first.label || (envKey || providerId.replace(/^custom:/, ''))),
    auth_type: 'api_key',
    base_url: baseUrl,
    source: sourceLabel,
    ...(credentialAction === 'replace' ? { secret_fingerprint: secretFingerprint(apiKey) } : {}),
  }
  delete next.last_error_code
  delete next.last_error_message
  delete next.last_error_reason
  delete next.last_error_reset_at
  next.last_status = 'unknown'
  next.last_status_at = Date.now()
  auth.credential_pool[providerId] = [next, ...entries.filter((entry: unknown) => entry !== first)]
  delete auth.providers[providerId]
}

function changedFields(before: ProviderEditorDetail, patch: ProviderEditorPatch): string[] {
  const fields: string[] = []
  if (patch.label !== undefined && patch.label.trim() !== before.label) fields.push('label')
  if (patch.base_url !== undefined && patch.base_url.replace(/\/+$/, '') !== before.base_url.replace(/\/+$/, '')) fields.push('base_url')
  if (patch.api_mode !== undefined && patch.api_mode !== before.api_mode) fields.push('api_mode')
  if (patch.preferred_model !== undefined && patch.preferred_model.trim() !== before.preferred_model) fields.push('preferred_model')
  if (patch.discover_models !== undefined && patch.discover_models !== before.discover_models) fields.push('discover_models')
  if (patch.rate_limit_delay !== undefined && patch.rate_limit_delay !== (before.rate_limit_delay ?? null)) fields.push('rate_limit_delay')
  if (patch.request_timeout_seconds !== undefined && patch.request_timeout_seconds !== (before.request_timeout_seconds ?? null)) fields.push('request_timeout_seconds')
  if (patch.stale_timeout_seconds !== undefined && patch.stale_timeout_seconds !== (before.stale_timeout_seconds ?? null)) fields.push('stale_timeout_seconds')
  if (patch.extra_body !== undefined && JSON.stringify(stableObject(patch.extra_body)) !== JSON.stringify(stableObject(before.extra_body ?? null))) fields.push('extra_body')
  if (patch.credential_action === 'replace') fields.push('api_key_replaced')
  if (patch.credential_action === 'clear') fields.push('api_key_cleared')
  return fields
}

function validateOptionalRuntimeNumber(value: number | null | undefined, field: string): void {
  if (value === undefined || value === null) return
  if (!Number.isFinite(value) || value <= 0 || value > 86_400) {
    throw new ProviderEditorError(`${field} must be a positive number no greater than 86400`, 400, 'INVALID_RUNTIME_SETTING')
  }
}

function validatePatch(before: ProviderEditorDetail, patch: ProviderEditorPatch): void {
  const allowed = new Set(before.editable_fields)
  if (patch.label !== undefined && !allowed.has('label')) throw new ProviderEditorError('Provider label is read-only', 400, 'FIELD_READ_ONLY')
  if (patch.base_url !== undefined && !allowed.has('base_url')) throw new ProviderEditorError('Provider base URL is read-only', 400, 'FIELD_READ_ONLY')
  if (patch.api_mode !== undefined && !allowed.has('api_mode')) throw new ProviderEditorError('Provider API mode is read-only', 400, 'FIELD_READ_ONLY')
  if (patch.preferred_model !== undefined && !allowed.has('preferred_model')) throw new ProviderEditorError('Preferred model is read-only', 400, 'FIELD_READ_ONLY')
  if (patch.discover_models !== undefined && !allowed.has('discover_models')) throw new ProviderEditorError('Model discovery is read-only', 400, 'FIELD_READ_ONLY')
  if (patch.rate_limit_delay !== undefined && !allowed.has('rate_limit_delay')) throw new ProviderEditorError('Rate limit delay is read-only', 400, 'FIELD_READ_ONLY')
  if (patch.request_timeout_seconds !== undefined && !allowed.has('request_timeout_seconds')) throw new ProviderEditorError('Request timeout is read-only', 400, 'FIELD_READ_ONLY')
  if (patch.stale_timeout_seconds !== undefined && !allowed.has('stale_timeout_seconds')) throw new ProviderEditorError('Stale timeout is read-only', 400, 'FIELD_READ_ONLY')
  if (patch.extra_body !== undefined && !allowed.has('extra_body')) throw new ProviderEditorError('Extra request body is read-only', 400, 'FIELD_READ_ONLY')
  if (patch.credential_action && patch.credential_action !== 'keep' && !allowed.has('api_key')) throw new ProviderEditorError('Provider credential is read-only', 400, 'FIELD_READ_ONLY')
  if (patch.label !== undefined && (!patch.label.trim() || patch.label.trim().length > 100)) throw new ProviderEditorError('Provider label must contain 1-100 characters', 400, 'INVALID_LABEL')
  if (patch.base_url !== undefined) normalizeUrl(patch.base_url)
  if (patch.api_mode !== undefined && !normalizeApiMode(patch.api_mode)) throw new ProviderEditorError('Invalid API mode', 400, 'INVALID_API_MODE')
  if (patch.preferred_model !== undefined && (!patch.preferred_model.trim() || /[\r\n]/.test(patch.preferred_model))) throw new ProviderEditorError('Preferred model is invalid', 400, 'INVALID_MODEL')
  if (patch.credential_action === 'replace' && (!String(patch.api_key || '').trim() || /[\r\n]/.test(String(patch.api_key)))) throw new ProviderEditorError('A non-empty API key is required', 400, 'INVALID_API_KEY')
  validateOptionalRuntimeNumber(patch.rate_limit_delay, 'rate_limit_delay')
  validateOptionalRuntimeNumber(patch.request_timeout_seconds, 'request_timeout_seconds')
  validateOptionalRuntimeNumber(patch.stale_timeout_seconds, 'stale_timeout_seconds')
  if (patch.extra_body !== undefined && patch.extra_body !== null) {
    if (typeof patch.extra_body !== 'object' || Array.isArray(patch.extra_body)) {
      throw new ProviderEditorError('extra_body must be a JSON object', 400, 'INVALID_EXTRA_BODY')
    }
    if (JSON.stringify(patch.extra_body).length > 65_536) {
      throw new ProviderEditorError('extra_body must not exceed 64 KiB', 400, 'INVALID_EXTRA_BODY')
    }
  }
}

export async function updateProviderEditorDetail(
  profile: string,
  providerId: string,
  patch: ProviderEditorPatch,
  expectedRevision: string,
): Promise<{ before: ProviderEditorDetail; detail: ProviderEditorDetail; changed: string[] }> {
  const paths = profilePaths(profile)
  let before!: ProviderEditorDetail
  let nextDetail!: ProviderEditorDetail
  let changed: string[] = []
  await safeFileStore.updateTexts([paths.config, paths.env, paths.auth, paths.app], (current) => {
    before = buildDetailFromRaw(profile, providerId, current[paths.config], current[paths.env], current[paths.app], current[paths.auth])
    if (!expectedRevision || expectedRevision.replace(/^W\//, '').replace(/^"|"$/g, '') !== before.revision) {
      throw new ProviderEditorError('Provider configuration changed; reload before saving', 412, 'REVISION_CONFLICT', before)
    }
    validatePatch(before, patch)
    changed = changedFields(before, patch)
    if (changed.length === 0) return { files: {}, result: undefined }

    const config = parseYaml(current[paths.config])
    const appConfig = parseJson(current[paths.app])
    const auth = parseJson(current[paths.auth])
    const source = findSource(config, providerId)!
    let env = String(current[paths.env] || '')
    const credentialAction = patch.credential_action || 'keep'
    const apiKey = String(patch.api_key || '')

    if (patch.label !== undefined) setNestedProfileValue(appConfig, 'providerLabels', profile, providerId, patch.label.trim())
    if (patch.preferred_model !== undefined) {
      setNestedProfileValue(appConfig, 'providerPreferredModels', profile, providerId, patch.preferred_model.trim())
      if (!source.builtin) setExistingAlias(source.configEntry!, ['model', 'default_model', 'defaultModel'], patch.preferred_model.trim(), source.source === 'providers' ? 'default_model' : 'model')
    }

    let baseUrl = before.base_url
    if (patch.base_url !== undefined) {
      baseUrl = normalizeUrl(patch.base_url)
      if (source.source === 'builtin_env') {
        const key = builtinBaseUrlEnvKey(source)
        const presetUrl = source.preset!.base_url.replace(/\/+$/, '')
        env = updateEnv(env, key, baseUrl === presetUrl ? undefined : baseUrl)
      } else {
        setExistingAlias(source.configEntry!, ['base_url', 'url', 'api', 'baseUrl'], baseUrl, 'base_url')
      }
    }
    if (patch.api_mode !== undefined && !source.builtin) {
      setExistingAlias(source.configEntry!, ['api_mode', 'transport', 'apiMode'], patch.api_mode, 'api_mode')
    }
    if (!source.builtin) {
      if (patch.discover_models !== undefined) {
        setExistingAlias(source.configEntry!, ['discover_models', 'discoverModels'], patch.discover_models, 'discover_models')
      }
      const applyOptionalNumber = (value: number | null | undefined, aliases: string[], canonical: string) => {
        if (value === undefined) return
        if (value === null) deleteAliases(source.configEntry!, aliases)
        else setExistingAlias(source.configEntry!, aliases, value, canonical)
      }
      applyOptionalNumber(patch.rate_limit_delay, ['rate_limit_delay', 'rateLimitDelay'], 'rate_limit_delay')
      applyOptionalNumber(patch.request_timeout_seconds, ['request_timeout_seconds', 'requestTimeoutSeconds'], 'request_timeout_seconds')
      applyOptionalNumber(patch.stale_timeout_seconds, ['stale_timeout_seconds', 'staleTimeoutSeconds'], 'stale_timeout_seconds')
      if (patch.extra_body !== undefined) {
        if (patch.extra_body === null) deleteAliases(source.configEntry!, ['extra_body', 'extraBody'])
        else setExistingAlias(source.configEntry!, ['extra_body', 'extraBody'], patch.extra_body, 'extra_body')
      }
    }

    if (credentialAction !== 'keep') {
      if (source.source === 'builtin_env' && isOrcaRouterProvider(source.providerId)) {
        // The Auth entry point's key is a durable API key, not a token pair.
        if (credentialAction === 'replace') {
          auth.providers = auth.providers && typeof auth.providers === 'object' ? auth.providers : {}
          auth.providers[providerId] = {
            ...(auth.providers[providerId] || {}),
            api_key: apiKey,
            auth_mode: 'oauth_pkce',
            last_refresh: new Date().toISOString(),
          }
        } else {
          delete auth.providers?.[providerId]
        }
      } else if (source.source === 'builtin_env') {
        env = updateEnv(env, source.envMapping!.api_key_env, credentialAction === 'replace' ? apiKey : undefined)
      } else {
        const normalized = normalizeCustomProviderEntry(source.configEntry, source.sourceKey || '', source.source === 'providers' ? 'providers' : 'custom_providers')
        if (normalized?.key_env) {
          env = updateEnv(env, normalized.key_env, credentialAction === 'replace' ? apiKey : undefined)
        } else if (credentialAction === 'replace') {
          setExistingAlias(source.configEntry!, ['api_key', 'apiKey'], apiKey, 'api_key')
        } else {
          deleteAliases(source.configEntry!, ['api_key', 'apiKey'])
        }
      }
    }
    if (!isOrcaRouterProvider(source.providerId)) {
      syncAuthMetadata(auth, source, providerId, baseUrl, credentialAction, apiKey)
    }

    const files: MultiTextUpdate = {
      [paths.config]: dumpYaml(config),
      [paths.env]: env,
      [paths.auth]: JSON.stringify(auth, null, 2) + '\n',
      [paths.app]: JSON.stringify(appConfig, null, 2) + '\n',
    }
    nextDetail = buildDetailFromRaw(profile, providerId, files[paths.config], files[paths.env], files[paths.app], files[paths.auth])
    return { files, result: undefined }
  }, { backup: true })

  invalidateAppConfigCache()
  await Promise.all([
    chmod(paths.auth, 0o600).catch(() => undefined),
    chmod(paths.app, 0o600).catch(() => undefined),
  ])
  if (!nextDetail) nextDetail = before
  return { before, detail: nextDetail, changed }
}

export async function updateProviderContextLengths(
  profile: string,
  providerId: string,
  input: Record<string, number | null>,
  expectedRevision: string,
): Promise<{ before: ProviderEditorDetail; detail: ProviderEditorDetail; changed: string[] }> {
  const paths = profilePaths(profile)
  const result = await safeFileStore.updateTexts(
    [paths.config, paths.env, paths.auth, paths.app],
    (current) => {
      const before = buildDetailFromRaw(profile, providerId, current[paths.config], current[paths.env], current[paths.app], current[paths.auth])
      const normalizedExpected = String(expectedRevision || '').replace(/^W\//, '').replace(/^"|"$/g, '')
      if (!normalizedExpected || normalizedExpected !== before.revision) {
        throw new ProviderEditorError('Provider configuration changed; reload before saving', 412, 'REVISION_CONFLICT', before)
      }
      if (!before.editable_fields.includes('context_lengths')) {
        throw new ProviderEditorError('Provider context lengths are read-only', 400, 'FIELD_READ_ONLY')
      }

      const updates = Object.entries(input || {})
      if (updates.length === 0) return { files: {}, result: { before, detail: before, changed: [] } }
      for (const [model, value] of updates) {
        if (!model.trim() || /[\r\n]/.test(model)) throw new ProviderEditorError('Model id is invalid', 400, 'INVALID_MODEL')
        if (value !== null && (!Number.isSafeInteger(value) || value <= 0 || value > 100_000_000)) {
          throw new ProviderEditorError(`Context length for "${model}" must be a positive integer`, 400, 'INVALID_CONTEXT_LENGTH')
        }
      }

      const written = writeProviderContextLengths(
        profile,
        providerId,
        updates.map(([model, value]) => [model.trim(), value]),
      )
      if (!written) throw new ProviderEditorError('Database is not available', 500, 'DATABASE_UNAVAILABLE')
      const detail = buildDetailFromRaw(profile, providerId, current[paths.config], current[paths.env], current[paths.app], current[paths.auth])
      return {
        files: {},
        result: { before, detail, changed: updates.map(([model]) => `context_lengths.${model}`) },
      }
    },
    { backup: false },
  )
  if (!result) throw new ProviderEditorError('Provider context update failed', 500, 'CONTEXT_UPDATE_FAILED')
  return result
}
