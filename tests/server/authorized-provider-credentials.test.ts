import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  AuthorizedProviderCredentialError,
  isAuthorizedRuntimeProvider,
  resolveAuthorizedProviderRuntimeCredentials,
} from '../../packages/server/src/modules/hermes/services/providers/authorized-provider-credentials'

const NOW = Date.parse('2026-08-27T08:00:00.000Z')
let hermesHome = ''

function jwt(exp: number, scope?: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ exp, ...(scope ? { scope } : {}) })).toString('base64url')
  return `${header}.${payload}.signature`
}

function writeAuth(auth: Record<string, unknown>, profile = 'default'): string {
  const dir = profile === 'default' ? hermesHome : join(hermesHome, 'profiles', profile)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'auth.json')
  writeFileSync(path, JSON.stringify(auth, null, 2))
  return path
}

function profileDir(profile: string): string {
  return profile === 'default' ? hermesHome : join(hermesHome, 'profiles', profile)
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('Studio authorized provider runtime credentials', () => {
  beforeEach(() => {
    hermesHome = mkdtempSync(join(tmpdir(), 'studio-provider-auth-'))
  })

  afterEach(() => {
    if (hermesHome) rmSync(hermesHome, { recursive: true, force: true })
    hermesHome = ''
  })

  it('reads a fresh profile-scoped token directly from Hermes auth.json', async () => {
    const accessToken = jwt(Math.floor((NOW + 6 * 60 * 60 * 1000) / 1000))
    writeAuth({
      providers: {
        'xai-oauth': {
          tokens: { access_token: accessToken, refresh_token: 'refresh-token', expires_in: 21600 },
          discovery: { token_endpoint: 'https://auth.x.ai/oauth/token' },
          last_refresh: new Date(NOW).toISOString(),
        },
      },
      credential_pool: {
        'xai-oauth': [{ access_token: accessToken, refresh_token: 'refresh-token', base_url: 'https://api.x.ai/v1/' }],
      },
    }, 'research')
    const fetcher = vi.fn<typeof fetch>()

    await expect(resolveAuthorizedProviderRuntimeCredentials({
      profile: 'research',
      provider: 'xai-oauth',
      model: 'grok-4.3',
    }, { profileDir, now: () => NOW, fetch: fetcher })).resolves.toMatchObject({
      provider: 'xai-oauth',
      apiKey: accessToken,
      baseUrl: 'https://api.x.ai/v1',
      apiMode: 'codex_responses',
      lastRefresh: new Date(NOW).toISOString(),
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('refreshes an expired xAI token in Studio and atomically updates provider and pool state', async () => {
    const expiredToken = jwt(Math.floor((NOW - 60_000) / 1000))
    const authPath = writeAuth({
      version: 1,
      providers: {
        'xai-oauth': {
          tokens: { access_token: expiredToken, refresh_token: 'old-refresh-token' },
          discovery: { token_endpoint: 'https://auth.x.ai/oauth/token' },
          last_refresh: '2026-08-26T00:00:00.000Z',
        },
      },
      credential_pool: {
        'xai-oauth': [{
          access_token: expiredToken,
          refresh_token: 'old-refresh-token',
          base_url: 'https://api.x.ai/v1',
          last_error_code: 401,
        }],
      },
    })
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      access_token: 'fresh-access-token',
      refresh_token: 'rotated-refresh-token',
      expires_in: 21600,
      token_type: 'Bearer',
    }))

    await expect(resolveAuthorizedProviderRuntimeCredentials({
      profile: 'default',
      provider: 'xai-oauth',
    }, { profileDir, now: () => NOW, fetch: fetcher })).resolves.toMatchObject({
      apiKey: 'fresh-access-token',
      expiresAtMs: NOW + 21600 * 1000,
    })

    expect(fetcher).toHaveBeenCalledTimes(1)
    const [, options] = fetcher.mock.calls[0]
    expect(String(options?.body)).toContain('refresh_token=old-refresh-token')
    const saved = JSON.parse(readFileSync(authPath, 'utf-8'))
    expect(saved.providers['xai-oauth'].tokens).toMatchObject({
      access_token: 'fresh-access-token',
      refresh_token: 'rotated-refresh-token',
    })
    expect(saved.credential_pool['xai-oauth'][0]).toMatchObject({
      access_token: 'fresh-access-token',
      refresh_token: 'rotated-refresh-token',
      last_status: null,
    })
    expect(saved.credential_pool['xai-oauth'][0].last_error_code).toBeUndefined()
  })

  it('refreshes xAI during its one-hour proactive refresh window', async () => {
    const expiringToken = jwt(Math.floor((NOW + 30 * 60 * 1000) / 1000))
    writeAuth({
      providers: {
        'xai-oauth': {
          tokens: { access_token: expiringToken, refresh_token: 'xai-refresh-token' },
          discovery: { token_endpoint: 'https://auth.x.ai/oauth/token' },
        },
      },
    })
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      access_token: 'refreshed-before-expiry',
      refresh_token: 'rotated-before-expiry',
      expires_in: 21600,
    }))

    await expect(resolveAuthorizedProviderRuntimeCredentials({
      profile: 'default',
      provider: 'xai-oauth',
    }, { profileDir, now: () => NOW, fetch: fetcher })).resolves.toMatchObject({
      apiKey: 'refreshed-before-expiry',
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('deduplicates concurrent refreshes for a rotating refresh token', async () => {
    writeAuth({
      providers: {
        'openai-codex': {
          tokens: {
            access_token: jwt(Math.floor((NOW - 1000) / 1000)),
            refresh_token: 'single-use-refresh-token',
          },
        },
      },
    })
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 10))
      return jsonResponse({ access_token: 'fresh-codex-token', refresh_token: 'rotated-token', expires_in: 3600 })
    })
    const dependencies = { profileDir, now: () => NOW, fetch: fetcher }

    const [first, second] = await Promise.all([
      resolveAuthorizedProviderRuntimeCredentials({ profile: 'default', provider: 'openai-codex' }, dependencies),
      resolveAuthorizedProviderRuntimeCredentials({ profile: 'default', provider: 'openai-codex' }, dependencies),
    ])

    expect(first.apiKey).toBe('fresh-codex-token')
    expect(second.apiKey).toBe('fresh-codex-token')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('preserves provider re-login metadata when Studio refresh is rejected', async () => {
    writeAuth({
      providers: {
        'minimax-oauth': {
          access_token: 'expired-token',
          refresh_token: 'invalid-refresh-token',
          expires_at: '2026-08-27T07:00:00.000Z',
          portal_base_url: 'https://api.minimax.io',
        },
      },
    })
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      error: 'invalid_grant',
      error_description: 'refresh token is invalid',
    }, 401))

    const promise = resolveAuthorizedProviderRuntimeCredentials({
      profile: 'default',
      provider: 'minimax-oauth',
    }, { profileDir, now: () => NOW, fetch: fetcher })
    await expect(promise).rejects.toMatchObject({
      provider: 'minimax-oauth',
      code: 'MINIMAX_REFRESH_FAILED',
      reloginRequired: true,
    })
  })

  it('refreshes Nous and synchronizes the profile pool plus Hermes shared state', async () => {
    const authPath = writeAuth({
      providers: {
        nous: {
          access_token: 'expired-access-token',
          refresh_token: 'old-nous-refresh',
          expires_at: '2026-08-27T07:00:00.000Z',
          agent_key: 'expired-agent-key',
          agent_key_expires_at: '2026-08-27T07:00:00.000Z',
          portal_base_url: 'https://portal.nousresearch.com',
          inference_base_url: 'https://inference-api.nousresearch.com/v1',
          client_id: 'hermes-cli',
        },
      },
      credential_pool: {
        nous: [{
          access_token: 'expired-access-token',
          refresh_token: 'old-nous-refresh',
          agent_key: 'expired-agent-key',
          agent_key_expires_at: '2026-08-27T07:00:00.000Z',
        }],
      },
    })
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      access_token: 'fresh-nous-invoke-token',
      refresh_token: 'rotated-nous-refresh',
      expires_in: 3600,
      scope: 'inference:invoke',
      inference_base_url: 'https://inference-api.nousresearch.com/v1',
    }))

    await expect(resolveAuthorizedProviderRuntimeCredentials({
      profile: 'default',
      provider: 'nous',
    }, {
      profileDir,
      hermesBaseDir: () => hermesHome,
      now: () => NOW,
      fetch: fetcher,
    })).resolves.toMatchObject({
      apiKey: 'fresh-nous-invoke-token',
      source: 'invoke_jwt',
    })

    const [, options] = fetcher.mock.calls[0]
    expect(new Headers(options?.headers).get('x-nous-refresh-token')).toBe('old-nous-refresh')
    const saved = JSON.parse(readFileSync(authPath, 'utf-8'))
    expect(saved.providers.nous).toMatchObject({
      access_token: 'fresh-nous-invoke-token',
      refresh_token: 'rotated-nous-refresh',
      agent_key: 'fresh-nous-invoke-token',
    })
    expect(saved.credential_pool.nous[0].agent_key).toBe('fresh-nous-invoke-token')
    const shared = JSON.parse(readFileSync(join(hermesHome, 'shared', 'nous_auth.json'), 'utf-8'))
    expect(shared.refresh_token).toBe('rotated-nous-refresh')
  })

  it('refreshes Claude and synchronizes both Hermes aliases and the OAuth sidecar', async () => {
    const authPath = writeAuth({
      providers: {
        'claude-oauth': {
          tokens: {
            access_token: 'expired-claude-token',
            refresh_token: 'old-claude-refresh',
            expires_at_ms: NOW - 1,
          },
          base_url: 'https://api.anthropic.com',
        },
      },
      credential_pool: {
        'claude-oauth': [{ access_token: 'expired-claude-token', refresh_token: 'old-claude-refresh', expires_at_ms: NOW - 1 }],
        anthropic: [{ access_token: 'expired-claude-token', refresh_token: 'old-claude-refresh', expires_at_ms: NOW - 1 }],
      },
    })
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      access_token: 'fresh-claude-token',
      refresh_token: 'rotated-claude-refresh',
      expires_in: 3600,
      token_type: 'Bearer',
    }))

    await expect(resolveAuthorizedProviderRuntimeCredentials({
      profile: 'default',
      provider: 'claude-oauth',
    }, { profileDir, now: () => NOW, fetch: fetcher })).resolves.toMatchObject({
      apiKey: 'fresh-claude-token',
      apiMode: 'anthropic_messages',
    })

    const saved = JSON.parse(readFileSync(authPath, 'utf-8'))
    expect(saved.providers['claude-oauth'].tokens.refresh_token).toBe('rotated-claude-refresh')
    expect(saved.providers.anthropic.tokens.refresh_token).toBe('rotated-claude-refresh')
    expect(saved.credential_pool['claude-oauth'][0].access_token).toBe('fresh-claude-token')
    expect(saved.credential_pool.anthropic[0].access_token).toBe('fresh-claude-token')
    const sidecar = JSON.parse(readFileSync(join(hermesHome, '.anthropic_oauth.json'), 'utf-8'))
    expect(sidecar).toMatchObject({
      accessToken: 'fresh-claude-token',
      refreshToken: 'rotated-claude-refresh',
      expiresAt: NOW + 3600 * 1000,
    })
  })

  it('refreshes MiniMax and preserves its region-specific routing state', async () => {
    const authPath = writeAuth({
      providers: {
        'minimax-oauth': {
          access_token: 'expired-minimax-token',
          refresh_token: 'old-minimax-refresh',
          expires_at: '2026-08-27T07:00:00.000Z',
          client_id: '78257093-7e40-4613-99e0-527b14b39113',
          portal_base_url: 'https://api.minimaxi.com',
          inference_base_url: 'https://api.minimaxi.com/anthropic',
          region: 'cn',
        },
      },
    })
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      status: 'success',
      access_token: 'fresh-minimax-token',
      refresh_token: 'rotated-minimax-refresh',
      expired_in: 3600,
    }))

    await expect(resolveAuthorizedProviderRuntimeCredentials({
      profile: 'default',
      provider: 'minimax-oauth',
    }, { profileDir, now: () => NOW, fetch: fetcher })).resolves.toMatchObject({
      apiKey: 'fresh-minimax-token',
      baseUrl: 'https://api.minimaxi.com/anthropic',
      apiMode: 'anthropic_messages',
    })
    expect(fetcher.mock.calls[0][0]).toBe('https://api.minimaxi.com/oauth/token')
    const saved = JSON.parse(readFileSync(authPath, 'utf-8'))
    expect(saved.providers['minimax-oauth']).toMatchObject({
      access_token: 'fresh-minimax-token',
      refresh_token: 'rotated-minimax-refresh',
      region: 'cn',
    })
  })

  it('refreshes Qwen through its Hermes-compatible CLI credential file', async () => {
    const qwenPath = join(hermesHome, 'qwen', 'oauth_creds.json')
    mkdirSync(join(hermesHome, 'qwen'), { recursive: true })
    writeFileSync(qwenPath, JSON.stringify({
      access_token: 'expired-qwen-token',
      refresh_token: 'qwen-refresh-token',
      expiry_date: NOW - 1,
    }))
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      access_token: 'fresh-qwen-token',
      refresh_token: 'rotated-qwen-token',
      expires_in: 3600,
    }))

    await expect(resolveAuthorizedProviderRuntimeCredentials({
      profile: 'default',
      provider: 'qwen-oauth',
    }, {
      qwenAuthPath: () => qwenPath,
      now: () => NOW,
      fetch: fetcher,
    })).resolves.toMatchObject({
      apiKey: 'fresh-qwen-token',
      source: 'qwen-cli',
    })
    const saved = JSON.parse(readFileSync(qwenPath, 'utf-8'))
    expect(saved.refresh_token).toBe('rotated-qwen-token')
    expect(saved.expiry_date).toBe(NOW + 3600 * 1000)
  })

  it('rejects providers outside the Hermes authorization store before reading credentials', async () => {
    expect(isAuthorizedRuntimeProvider('deepseek')).toBe(false)
    await expect(resolveAuthorizedProviderRuntimeCredentials({
      profile: 'default',
      provider: 'deepseek',
    }, { profileDir })).rejects.toBeInstanceOf(AuthorizedProviderCredentialError)
  })
})
