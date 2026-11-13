import { join } from 'path'
import { getCompatibleCustomProviders } from '../../studio/contracts/provider-compat'
import { PROVIDER_PRESETS, assertProviderAvailable } from '../../studio/contracts/providers'
import {
  getProfileDir,
  PROVIDER_ENV_MAP,
  readConfigYamlForProfile,
  safeReadFile,
} from '../../studio/public/profile-config'
import {
  resolveEkkoAuthorizedProviderCredentials,
  type EkkoAuthorizedProviderCredentials,
} from './auth-providers'
import { isAuthorizedRuntimeProvider } from '../../studio/public/authorized-provider-runtime'

export interface EkkoProviderRuntimeConfig {
  provider: string
  baseUrl?: string
  apiKey?: string
  apiMode?: string
}

export async function resolveEkkoProviderRuntimeConfig(input: {
  profile: string
  provider: string
  model?: string
  baseUrl?: string
  apiKey?: string
  apiMode?: string
  forceRefresh?: boolean
}): Promise<EkkoProviderRuntimeConfig> {
  const provider = String(input.provider || '').trim()
  if (!provider) throw new Error('Ekko model provider is required')

  assertProviderAvailable(provider)

  const profile = String(input.profile || '').trim() || 'default'
  const providerKey = providerKeyWithoutCustomPrefix(provider.toLowerCase())
  const authorized = await resolveEkkoAuthorizedProviderCredentials(
    profile,
    provider,
    input.model,
    input.forceRefresh === true,
  )
  const authorizedValuesFirst = !!authorized.apiKey
  let baseUrl = String(
    authorizedValuesFirst
      ? authorized.baseUrl || input.baseUrl || ''
      : input.baseUrl || authorized.baseUrl || '',
  ).trim()
  let apiKey = String(
    authorizedValuesFirst
      ? authorized.apiKey || input.apiKey || ''
      : input.apiKey || authorized.apiKey || '',
  ).trim()
  let apiMode = String(
    authorizedValuesFirst
      ? authorized.apiMode || input.apiMode || ''
      : input.apiMode || authorized.apiMode || '',
  ).trim()

  let config: Record<string, any> = {}
  try {
    config = await readConfigYamlForProfile(profile)
  } catch {}
  const envContent = await safeReadFile(join(getProfileDir(profile), '.env')) || ''

  const customEntry = getCompatibleCustomProviders(config).find((entry) => {
    const entryKeys = [entry.name, entry.provider_key]
      .filter(Boolean)
      .flatMap(value => providerLookupCandidates(String(value)))
    return providerLookupCandidates(provider).some(candidate => entryKeys.includes(candidate))
  })
  if (customEntry) {
    if (!baseUrl) baseUrl = String(customEntry.base_url || '').trim()
    if (!apiKey) apiKey = String(customEntry.api_key || '').trim()
    if (!apiKey && customEntry.key_env) apiKey = parseEnvValue(envContent, customEntry.key_env)
    if (!apiMode) apiMode = String(customEntry.api_mode || '').trim()
  }

  const preset = PROVIDER_PRESETS.find(entry => entry.value === providerKey)
  const envMapping = PROVIDER_ENV_MAP[providerKey]
  if (!baseUrl) {
    baseUrl = envMapping?.base_url_env
      ? parseEnvValue(envContent, envMapping.base_url_env) || preset?.base_url || ''
      : preset?.base_url || ''
  }
  if (!apiKey && envMapping?.api_key_env) {
    apiKey = parseEnvValue(envContent, envMapping.api_key_env)
  }
  if (!apiMode) apiMode = String(preset?.api_mode || '').trim()

  return {
    provider,
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(apiMode ? { apiMode } : {}),
  }
}

/**
 * Studio-owned 401 recovery for OAuth providers. Ekko only receives a fetch
 * implementation and never reads refresh tokens or mutates Hermes auth state.
 */
export function createEkkoAuthorizedProviderFetch(input: {
  profile: string
  provider: string
  model?: string
  accessToken?: string
}, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)): typeof fetch {
  if (!isAuthorizedRuntimeProvider(input.provider)) return fetchImpl

  let accessToken = String(input.accessToken || '').trim()
  let refresh: Promise<EkkoAuthorizedProviderCredentials> | null = null
  const wrapped = async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const [resource, init] = args
    const retryResource = typeof Request !== 'undefined' && resource instanceof Request
      ? resource.clone()
      : resource
    const baseHeaders = init?.headers || (
      typeof Request !== 'undefined' && resource instanceof Request ? resource.headers : undefined
    )
    const headers = new Headers(baseHeaders)
    if (accessToken) headers.set('authorization', `Bearer ${accessToken}`)
    const response = await fetchImpl(resource, { ...init, headers })
    if (response.status !== 401) return response

    await response.body?.cancel().catch(() => undefined)
    refresh ||= resolveEkkoAuthorizedProviderCredentials(
      input.profile,
      input.provider,
      input.model,
      true,
    ).finally(() => { refresh = null })
    const credentials = await refresh
    accessToken = String(credentials.apiKey || '').trim()
    if (!accessToken) return response

    const retryHeaders = new Headers(baseHeaders)
    retryHeaders.set('authorization', `Bearer ${accessToken}`)
    return fetchImpl(retryResource, { ...init, headers: retryHeaders })
  }
  return wrapped as typeof fetch
}

function providerKeyWithoutCustomPrefix(provider: string): string {
  if (provider.startsWith('custom:')) return provider.slice('custom:'.length)
  if (provider.startsWith('custom_')) return provider.slice('custom_'.length)
  return provider
}

function providerLookupCandidates(provider: string): string[] {
  const normalized = String(provider || '').trim().toLowerCase().replace(/ /g, '-')
  const withoutCustom = providerKeyWithoutCustomPrefix(normalized)
  return [...new Set([
    normalized,
    withoutCustom,
    withoutCustom ? `custom:${withoutCustom}` : '',
    withoutCustom ? `custom_${withoutCustom}` : '',
  ].filter(Boolean))]
}

function parseEnvValue(envContent: string, key: string): string {
  for (const line of envContent.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf('=')
    if (separator < 0 || trimmed.slice(0, separator).trim() !== key) continue
    const raw = trimmed.slice(separator + 1).trim()
    if (
      (raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))
    ) {
      return raw.slice(1, -1)
    }
    return raw
  }
  return ''
}
