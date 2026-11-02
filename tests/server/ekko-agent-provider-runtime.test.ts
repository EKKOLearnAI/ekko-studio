import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readConfigYamlForProfile: vi.fn(),
  safeReadFile: vi.fn(),
  resolveAuthorized: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({
  PROVIDER_ENV_MAP: {
    'openai-api': { api_key_env: 'OPENAI_API_KEY', base_url_env: 'OPENAI_BASE_URL' },
  },
  getProfileDir: (profile: string) => `/profiles/${profile}`,
  readConfigYamlForProfile: mocks.readConfigYamlForProfile,
  safeReadFile: mocks.safeReadFile,
}))

vi.mock('../../packages/server/src/modules/ekko/services/auth-providers', () => ({
  resolveEkkoAuthorizedProviderCredentials: mocks.resolveAuthorized,
}))

vi.mock('../../packages/server/src/modules/studio/public/authorized-provider-runtime', () => ({
  isAuthorizedRuntimeProvider: (provider: string) => provider === 'openai-codex',
}))

describe('resolveEkkoProviderRuntimeConfig', () => {
  beforeEach(() => {
    mocks.readConfigYamlForProfile.mockReset()
    mocks.safeReadFile.mockReset()
    mocks.resolveAuthorized.mockReset()
    mocks.readConfigYamlForProfile.mockResolvedValue({})
    mocks.safeReadFile.mockResolvedValue('')
    mocks.resolveAuthorized.mockResolvedValue({})
  })

  it('rejects retired OpenCode Free before resolving credentials', async () => {
    const { resolveEkkoProviderRuntimeConfig } = await import('../../packages/server/src/modules/ekko/services/provider-runtime')
    await expect(resolveEkkoProviderRuntimeConfig({
      profile: 'default', provider: 'opencode-free', model: 'muse-spark-free',
      apiKey: 'stale-key', baseUrl: 'https://stale.example/v1', apiMode: 'chat_completions',
    })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('OpenCode Free is no longer supported') })
    expect(mocks.readConfigYamlForProfile).not.toHaveBeenCalled()
    expect(mocks.resolveAuthorized).not.toHaveBeenCalled()
  })

  it('resolves a built-in provider from the profile env and preset', async () => {
    mocks.safeReadFile.mockResolvedValue([
      'OPENAI_API_KEY="profile-openai-key"',
      'OPENAI_BASE_URL=https://gateway.example/v1',
    ].join('\n'))
    const { resolveEkkoProviderRuntimeConfig } = await import(
      '../../packages/server/src/modules/ekko/services/provider-runtime'
    )

    await expect(resolveEkkoProviderRuntimeConfig({
      profile: 'work',
      provider: 'openai-api',
    })).resolves.toEqual({
      provider: 'openai-api',
      baseUrl: 'https://gateway.example/v1',
      apiKey: 'profile-openai-key',
      apiMode: 'codex_responses',
    })
    expect(mocks.safeReadFile).toHaveBeenCalledWith(join('/profiles/work', '.env'))
  })

  it('resolves custom provider credentials and protocol from profile config', async () => {
    mocks.readConfigYamlForProfile.mockResolvedValue({
      custom_providers: [{
        name: 'Summary Proxy',
        base_url: 'https://summary.example/v1',
        key_env: 'SUMMARY_PROXY_KEY',
        api_mode: 'anthropic_messages',
      }],
    })
    mocks.safeReadFile.mockResolvedValue("SUMMARY_PROXY_KEY='custom-key'")
    const { resolveEkkoProviderRuntimeConfig } = await import(
      '../../packages/server/src/modules/ekko/services/provider-runtime'
    )

    await expect(resolveEkkoProviderRuntimeConfig({
      profile: 'default',
      provider: 'custom:summary-proxy',
    })).resolves.toEqual({
      provider: 'custom:summary-proxy',
      baseUrl: 'https://summary.example/v1',
      apiKey: 'custom-key',
      apiMode: 'anthropic_messages',
    })
  })

  it('prefers Studio-refreshed OAuth credentials over stale explicit values', async () => {
    mocks.resolveAuthorized.mockResolvedValue({
      baseUrl: 'https://stored.example/v1',
      apiKey: 'stored-key',
    })
    const { resolveEkkoProviderRuntimeConfig } = await import(
      '../../packages/server/src/modules/ekko/services/provider-runtime'
    )

    await expect(resolveEkkoProviderRuntimeConfig({
      profile: 'default',
      provider: 'openai-codex',
      baseUrl: 'https://explicit.example/v1',
      apiKey: 'explicit-key',
      apiMode: 'codex_responses',
    })).resolves.toEqual({
      provider: 'openai-codex',
      baseUrl: 'https://stored.example/v1',
      apiKey: 'stored-key',
      apiMode: 'codex_responses',
    })
  })

  it('expands ${VAR} references in custom provider credentials instead of sending the placeholder', async () => {
    mocks.readConfigYamlForProfile.mockResolvedValue({
      providers: {
        'uge-proxy': {
          api: 'https://${UGE_PROXY_HOST}/v1',
          name: 'uge-proxy',
          api_key: '${UGE_PROXY_KEY}',
        },
      },
    })
    mocks.safeReadFile.mockResolvedValue([
      'UGE_PROXY_KEY="real-gateway-key"',
      'UGE_PROXY_HOST=gw.example',
    ].join('\n'))
    const { resolveEkkoProviderRuntimeConfig } = await import(
      '../../packages/server/src/modules/ekko/services/provider-runtime'
    )

    await expect(resolveEkkoProviderRuntimeConfig({
      profile: 'default',
      provider: 'custom:uge-proxy',
    })).resolves.toEqual({
      provider: 'custom:uge-proxy',
      baseUrl: 'https://gw.example/v1',
      apiKey: 'real-gateway-key',
    })
  })

  it('prefers process.env over the profile .env when expanding references', async () => {
    const key = 'EKKO_TEST_PROCESS_ENV_KEY'
    process.env[key] = 'from-process-env'
    try {
      mocks.readConfigYamlForProfile.mockResolvedValue({
        providers: {
          'env-proxy': {
            api: 'https://gw.example/v1',
            name: 'env-proxy',
            api_key: `\${${key}}`,
          },
        },
      })
      mocks.safeReadFile.mockResolvedValue(`${key}=from-profile-env`)
      const { resolveEkkoProviderRuntimeConfig } = await import(
        '../../packages/server/src/modules/ekko/services/provider-runtime'
      )

      await expect(resolveEkkoProviderRuntimeConfig({
        profile: 'default',
        provider: 'custom:env-proxy',
      })).resolves.toMatchObject({ apiKey: 'from-process-env' })
    } finally {
      delete process.env[key]
    }
  })

  it('falls back to key_env when a referenced variable is not defined anywhere', async () => {
    mocks.readConfigYamlForProfile.mockResolvedValue({
      providers: {
        'missing-proxy': {
          api: 'https://gw.example/v1',
          name: 'missing-proxy',
          api_key: '${DEFINITELY_UNDEFINED_EKKO_KEY}',
          key_env: 'MISSING_PROXY_FALLBACK_KEY',
        },
      },
    })
    mocks.safeReadFile.mockResolvedValue("MISSING_PROXY_FALLBACK_KEY='fallback-key'")
    const { resolveEkkoProviderRuntimeConfig } = await import(
      '../../packages/server/src/modules/ekko/services/provider-runtime'
    )

    await expect(resolveEkkoProviderRuntimeConfig({
      profile: 'default',
      provider: 'custom:missing-proxy',
    })).resolves.toMatchObject({ apiKey: 'fallback-key' })
  })

  it('forces a Studio refresh and retries once when an opaque token receives 401', async () => {
    mocks.resolveAuthorized.mockResolvedValue({
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      apiKey: 'fresh-token',
      apiMode: 'codex_responses',
    })
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    const { createEkkoAuthorizedProviderFetch } = await import(
      '../../packages/server/src/modules/ekko/services/provider-runtime'
    )
    const wrapped = createEkkoAuthorizedProviderFetch({
      profile: 'research',
      provider: 'openai-codex',
      model: 'gpt-5.5',
      accessToken: 'opaque-token-without-expiry',
    }, fetcher)

    await expect(wrapped('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST',
      body: '{}',
    })).resolves.toMatchObject({ status: 200 })

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer opaque-token-without-expiry')
    expect(new Headers(fetcher.mock.calls[1][1]?.headers).get('authorization')).toBe('Bearer fresh-token')
    expect(mocks.resolveAuthorized).toHaveBeenCalledWith('research', 'openai-codex', 'gpt-5.5', true)
  })

  it('uses the authorized MiniMax region and fresh token over stale explicit values', async () => {
    mocks.resolveAuthorized.mockResolvedValue({
      baseUrl: 'https://api.minimaxi.com/anthropic',
      apiKey: 'fresh-minimax-token',
      apiMode: 'anthropic_messages',
    })
    const { resolveEkkoProviderRuntimeConfig } = await import(
      '../../packages/server/src/modules/ekko/services/provider-runtime'
    )

    await expect(resolveEkkoProviderRuntimeConfig({
      profile: 'default',
      provider: 'minimax-oauth',
      baseUrl: 'https://api.minimax.io/anthropic',
      apiKey: 'stale-minimax-token',
      apiMode: 'chat_completions',
    })).resolves.toEqual({
      provider: 'minimax-oauth',
      baseUrl: 'https://api.minimaxi.com/anthropic',
      apiKey: 'fresh-minimax-token',
      apiMode: 'anthropic_messages',
    })
  })
})
