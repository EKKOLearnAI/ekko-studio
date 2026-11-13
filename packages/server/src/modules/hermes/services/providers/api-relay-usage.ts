import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { getCompatibleCustomProviders } from '../../../studio/contracts/provider-compat'
import { PROVIDER_PRESETS } from '../../../studio/contracts/providers'
import type { ApiRelayAccount, ApiRelayPeriodUsage, ApiRelaySource, ApiRelayUsage, ApiRelayUsageResult } from '../../../studio/contracts/api-relay'
import { PROVIDER_ENV_MAP, readConfigYamlForProfile } from '../../../studio/public/profile-config'
import { getProfileDir } from '../profiles/profile'

interface CredentialTarget {
  endpoint: string
  apiKey: string
  sources: ApiRelaySource[]
}

// Secrets and their fingerprints remain on the server. Only statistics are shared.
const inflight = new Map<string, Promise<Pick<ApiRelayAccount, 'status' | 'usage' | 'error'>>>()

export function apiRelayUsageEndpoint(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl)
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null
    if (url.hostname !== 'apikey.fan' && !url.hostname.endsWith('.apikey.fan')) return null
    url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '') + '/v1/usage'
    url.search = ''
    url.hash = ''
    return url.href
  } catch { return null }
}

function credentialIdentity(endpoint: string, apiKey: string): string {
  return createHash('sha256').update(JSON.stringify([endpoint, apiKey])).digest('hex')
}

async function collectTargets(profiles: string[]): Promise<CredentialTarget[]> {
  const targets = new Map<string, CredentialTarget>()
  const add = (baseUrl: string, credential: string, source: ApiRelaySource) => {
    const endpoint = apiRelayUsageEndpoint(baseUrl)
    const apiKey = credential.trim()
    if (!endpoint || !apiKey || /[\r\n]/.test(apiKey)) return
    const identity = credentialIdentity(endpoint, apiKey)
    let target = targets.get(identity)
    if (!target) {
      target = { endpoint, apiKey, sources: [] }
      targets.set(identity, target)
    }
    if (!target.sources.some(item => item.profile === source.profile && item.provider === source.provider)) {
      target.sources.push(source)
    }
  }

  for (const profile of [...new Set(profiles)].sort()) {
    let rawEnv = ''
    try { rawEnv = await readFile(join(getProfileDir(profile), '.env'), 'utf8') } catch (error: any) {
      if (error.code !== 'ENOENT') throw error
    }
    const env = parseEnv(rawEnv)
    const config = await readConfigYamlForProfile(profile)
    for (const preset of PROVIDER_PRESETS) {
      const mapping = PROVIDER_ENV_MAP[preset.value]
      if (!mapping?.api_key_env) continue
      add(
        (mapping.base_url_env && env[mapping.base_url_env]) || preset.base_url,
        env[mapping.api_key_env] || '',
        { profile, provider: preset.value, label: preset.label },
      )
    }
    for (const provider of getCompatibleCustomProviders(config)) {
      add(provider.base_url, (provider.key_env ? env[provider.key_env] : provider.api_key) || '', {
        profile,
        provider: `custom:${provider.name.trim().toLowerCase().replace(/ /g, '-')}`,
        label: provider.name,
      })
    }
    // Legacy inline custom model credentials may predate the provider editor.
    if (config.model && typeof config.model === 'object' && config.model.base_url && config.model.api_key) {
      const provider = String(config.model.provider || 'custom')
      add(String(config.model.base_url), String(config.model.api_key), { profile, provider, label: provider })
    }
  }
  return [...targets.values()]
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function numeric(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function periodUsage(value: unknown): ApiRelayPeriodUsage | undefined {
  const data = record(value)
  if (!data) return undefined
  const result: ApiRelayPeriodUsage = {}
  for (const key of ['requests', 'total_tokens', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'cost', 'actual_cost'] as const) {
    const value = numeric(data[key])
    if (value !== undefined) result[key] = value
  }
  return Object.keys(result).length ? result : undefined
}

export function extractApiRelayUsage(response: unknown): ApiRelayUsage {
  const data = record(response)
  if (!data || !['remaining', 'quota', 'balance', 'is_active', 'isValid', 'usage'].some(key => key in data)) {
    throw new Error('Invalid usage response')
  }
  const quota = record(data.quota)
  const usage = record(data.usage)
  const active = data.is_active ?? data.isValid ?? true
  const unit = data.unit ?? quota?.unit ?? 'USD'
  return {
    isValid: active !== false && active !== 0 && active !== 'false',
    remaining: numeric(data.remaining ?? quota?.remaining ?? data.balance) ?? null,
    unit: typeof unit === 'string' && unit.trim() ? unit.slice(0, 32) : 'USD',
    ...(typeof data.planName === 'string' ? { planName: data.planName.slice(0, 256) } : {}),
    today: periodUsage(usage?.today),
    total: periodUsage(usage?.total),
    rpm: numeric(usage?.rpm),
    tpm: numeric(usage?.tpm),
    modelStats: Array.isArray(data.model_stats) ? data.model_stats.slice(0, 1000).flatMap(item => {
      const model = record(item)
      return model && typeof model.model === 'string'
        ? [{ ...periodUsage(model), model: model.model.slice(0, 256) }]
        : []
    }) : [],
  }
}

async function queryTarget(target: CredentialTarget): Promise<Pick<ApiRelayAccount, 'status' | 'usage' | 'error'>> {
  const identity = credentialIdentity(target.endpoint, target.apiKey)
  const pending = inflight.get(identity)
  if (pending) return pending
  const request = (async (): Promise<Pick<ApiRelayAccount, 'status' | 'usage' | 'error'>> => {
    try {
      const response = await fetch(target.endpoint, {
        method: 'GET',
        headers: { Authorization: `Bearer ${target.apiKey}`, Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) {
        return { status: 'error', error: response.status === 401 || response.status === 403 ? 'unauthorized' : 'unavailable' }
      }
      const body = await response.json().catch((error: unknown) => {
        if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw error
        return null
      })
      try { return { status: 'ready', usage: extractApiRelayUsage(body) } } catch {
        return { status: 'error', error: 'invalid_response' }
      }
    } catch (error: any) {
      return { status: 'error', error: error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'unavailable' }
    }
  })()
  inflight.set(identity, request)
  try { return await request } finally { inflight.delete(identity) }
}

export async function getApiRelayUsage(profiles: string[]): Promise<ApiRelayUsageResult> {
  const targets = await collectTargets(profiles)
  const accounts: ApiRelayAccount[] = []
  // Limit outbound concurrency when a user has many separate keys.
  for (let offset = 0; offset < targets.length; offset += 4) {
    accounts.push(...await Promise.all(targets.slice(offset, offset + 4).map(async (target, index) => ({
      id: `credential-${offset + index + 1}`,
      endpoint: target.endpoint,
      sources: target.sources,
      ...await queryTarget(target),
    }))))
  }
  return { configured: accounts.length > 0, checkedAt: new Date().toISOString(), accounts }
}
