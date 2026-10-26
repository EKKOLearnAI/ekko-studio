import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'

const mocks = vi.hoisted(() => ({ root: '', profiles: ['default', 'research', 'private'], listUserProfiles: vi.fn() }))
vi.mock('../../packages/server/src/modules/hermes/services/profiles/profile', () => ({
  getProfileDir: (profile: string) => join(mocks.root, profile),
  listProfileNamesFromDisk: () => mocks.profiles,
}))
vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({
  PROVIDER_ENV_MAP: { deepseek: { api_key_env: 'DEEPSEEK_API_KEY', base_url_env: 'DEEPSEEK_BASE_URL' } },
  readConfigYamlForProfile: async (profile: string) => yaml.load(readFileSync(join(mocks.root, profile, 'config.yaml'), 'utf8')) || {},
}))
vi.mock('../../packages/server/src/modules/studio/public/users', () => ({ listUserProfiles: mocks.listUserProfiles }))

import { apiRelayUsageEndpoint, extractApiRelayUsage, getApiRelayUsage } from '../../packages/server/src/modules/hermes/services/providers/api-relay-usage'
import { getRelayUsage as getUsage } from '../../packages/server/src/modules/hermes/controllers/api-relay'

function profile(name: string, config: object = {}, env = '') {
  const dir = join(mocks.root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.yaml'), yaml.dump(config))
  writeFileSync(join(dir, '.env'), env)
}

function provider(name: string, api_key: string, base_url = 'https://api.apikey.fan/v1') {
  return { name, api_key, base_url, model: 'test-model' }
}

beforeEach(() => {
  mocks.root = mkdtempSync(join(tmpdir(), 'api-relay-usage-'))
  vi.clearAllMocks()
  for (const name of mocks.profiles) profile(name)
})
afterEach(() => { vi.unstubAllGlobals(); rmSync(mocks.root, { recursive: true, force: true }) })

describe('API relay usage', () => {
  it('deduplicates the same key across profiles and provider schemas, keeping different keys separate', async () => {
    profile('default', { custom_providers: [provider('codex', 'shared-test-key', 'https://api.apikey.fan/')] })
    profile('research', { providers: {
      codex: { base_url: 'https://api.apikey.fan/v1/', key_env: 'CODEX_KEY', default_model: 'gpt-test' },
      deepseek: provider('deepseek', 'different-test-key'),
    } }, 'CODEX_KEY="shared-test-key"\n')
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ remaining: 0, isValid: true, usage: { today: { requests: 0, total_tokens: 0 } } })))
    vi.stubGlobal('fetch', fetcher)
    const result = await getApiRelayUsage(['default', 'research', 'research'])
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(result.accounts).toHaveLength(2)
    expect(result.accounts[0].sources).toEqual([
      { profile: 'default', provider: 'custom:codex', label: 'codex' },
      { profile: 'research', provider: 'custom:codex', label: 'codex' },
    ])
    expect(result.accounts[1].sources[0].label).toBe('deepseek')
    expect(result.accounts[0].usage?.remaining).toBe(0)
    expect(fetcher.mock.calls.every(([url]) => url === 'https://api.apikey.fan/v1/usage')).toBe(true)
    expect(fetcher).toHaveBeenCalledWith('https://api.apikey.fan/v1/usage', expect.objectContaining({
      method: 'GET', redirect: 'error', headers: { Authorization: 'Bearer shared-test-key', Accept: 'application/json' },
    }))
    expect(JSON.stringify(result)).not.toContain('shared-test-key')
    expect(JSON.stringify(result)).not.toContain('different-test-key')
  })

  it('reads builtin env and legacy inline credentials without conflating services', async () => {
    profile('research', { model: { provider: 'custom', base_url: 'https://api.apikey.fan', api_key: 'same-test-key' } },
      "DEEPSEEK_API_KEY='same-test-key'\nDEEPSEEK_BASE_URL=https://api.apikey.fan/v1\n")
    const fetcher = vi.fn(async () => new Response('{"balance":12}'))
    vi.stubGlobal('fetch', fetcher)
    const result = await getApiRelayUsage(['research'])
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(result.accounts[0].sources.map(source => source.provider)).toEqual(['deepseek', 'custom'])
    expect(result.accounts[0].usage).toMatchObject({ remaining: 12, unit: 'USD', isValid: true })
  })

  it('does not query when keys are absent or configured for a different provider domain', async () => {
    profile('research', { custom_providers: [provider('no-key', ''), provider('official-deepseek', 'official-key', 'https://api.deepseek.com/v1')] })
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    expect(await getApiRelayUsage(['research'])).toMatchObject({ configured: false, accounts: [] })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('normalizes the supplied extractor aliases and preserves false, zero, and missing values', () => {
    expect(extractApiRelayUsage({ is_active: false, remaining: 0, balance: 100, unit: 'CNY' })).toMatchObject({ isValid: false, remaining: 0, unit: 'CNY' })
    expect(extractApiRelayUsage({ quota: { remaining: '2.25', unit: 'USD' } })).toMatchObject({ isValid: true, remaining: 2.25, unit: 'USD' })
    expect(extractApiRelayUsage({ isValid: false })).toMatchObject({ isValid: false, remaining: null, unit: 'USD' })
    expect(() => extractApiRelayUsage({ error: 'failed' })).toThrow()
    expect(() => extractApiRelayUsage(null)).toThrow()
  })

  it('includes known request, token, cost, rate, and model fields while stripping other upstream fields', () => {
    const result = extractApiRelayUsage({ remaining: 1, secret: 'never-return-this', usage: {
      today: { requests: 3, total_tokens: 42, actual_cost: 0, cost: 4, api_key: 'hidden' },
      total: { requests: 11 }, rpm: 2, tpm: 17,
    }, model_stats: [{ model: 'deepseek-test', requests: 3, secret: 'hidden' }] })
    expect(result).toMatchObject({ today: { requests: 3, total_tokens: 42, actual_cost: 0 }, total: { requests: 11 }, rpm: 2, tpm: 17, modelStats: [{ model: 'deepseek-test', requests: 3 }] })
    expect(JSON.stringify(result)).not.toMatch(/secret|hidden|never-return/)
  })

  it('keeps partial successes and sanitizes authentication, timeout, and malformed responses', async () => {
    profile('research', { custom_providers: ['good', 'invalid', 'timeout', 'malformed'].map(name => provider(name, `${name}-test-key`)) })
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response('{"remaining":4}'))
      .mockResolvedValueOnce(new Response('invalid-test-key', { status: 401 }))
      .mockRejectedValueOnce(new DOMException('timeout-test-key', 'TimeoutError'))
      .mockResolvedValueOnce(new Response('{"error":"malformed-test-key"}')))
    const result = await getApiRelayUsage(['research'])
    expect(result.accounts.map(account => account.error ?? account.status)).toEqual(['ready', 'unauthorized', 'timeout', 'invalid_response'])
    expect(result.accounts[1].usage).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain('-test-key')
  })

  it('shares in-flight requests without retaining completed statistics', async () => {
    profile('research', { custom_providers: [provider('codex', 'concurrent-test-key')] })
    let complete!: (value: Response) => void
    const pending = new Promise<Response>(resolve => { complete = resolve })
    const fetcher = vi.fn().mockReturnValueOnce(pending).mockResolvedValue(new Response('{"remaining":3}'))
    vi.stubGlobal('fetch', fetcher)
    const first = getApiRelayUsage(['research'])
    const second = getApiRelayUsage(['research'])
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    complete(new Response('{"remaining":2}'))
    expect((await first).accounts[0].usage?.remaining).toBe(2)
    expect((await second).accounts[0].usage?.remaining).toBe(2)
    expect((await getApiRelayUsage(['research'])).accounts[0].usage?.remaining).toBe(3)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('handles a timeout while reading the response body as a timeout', async () => {
    profile('research', { custom_providers: [provider('codex', 'body-timeout-key')] })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.reject(new DOMException('Request timed out', 'TimeoutError')) }))
    expect((await getApiRelayUsage(['research'])).accounts[0]).toMatchObject({ status: 'error', error: 'timeout' })
  })

  it.each(['http://api.apikey.fan', 'https://apikey.fan.evil.test', 'https://api.apikey.fan:8443', 'https://user:pass@api.apikey.fan'])('rejects unsafe relay addresses: %s', baseUrl => {
    expect(apiRelayUsageEndpoint(baseUrl)).toBeNull()
  })
})

describe('API relay profile authorization', () => {
  it.each(['admin', 'member'])('queries only assigned profiles for a %s, including no inaccessible sources', async role => {
    profile('research', { custom_providers: [provider('codex', 'permitted-key')] })
    profile('private', { custom_providers: [provider('private', 'permitted-key'), provider('secret', 'forbidden-key')] })
    mocks.listUserProfiles.mockReturnValue([{ profile_name: 'research' }])
    const fetcher = vi.fn(async () => new Response('{"remaining":5}'))
    vi.stubGlobal('fetch', fetcher)
    const ctx = { state: { user: { id: 2, role } }, set: vi.fn() } as any
    await getUsage(ctx)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(ctx.body.accounts[0].sources).toEqual([{ profile: 'research', provider: 'custom:codex', label: 'codex' }])
    expect(JSON.stringify(ctx.body)).not.toContain('private')
    expect(ctx.set).toHaveBeenCalledWith('Cache-Control', 'no-store')
  })

  it('allows a super admin to deduplicate across all profiles and rejects unauthenticated callers', async () => {
    profile('research', { custom_providers: [provider('codex', 'admin-key')] })
    profile('private', { custom_providers: [provider('codex', 'admin-key')] })
    const fetcher = vi.fn(async () => new Response('{"remaining":5}'))
    vi.stubGlobal('fetch', fetcher)
    const ctx = { state: { user: { id: 1, role: 'super_admin' } }, set: vi.fn() } as any
    await getUsage(ctx)
    expect(ctx.body.accounts[0].sources).toHaveLength(2)
    expect(fetcher).toHaveBeenCalledTimes(1)
    const unauthenticated = { state: {} } as any
    await getUsage(unauthenticated)
    expect(unauthenticated.status).toBe(401)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
