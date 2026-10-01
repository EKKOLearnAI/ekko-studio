import { describe, expect, it } from 'vitest'
import {
  assertScopedCodingAgentProviderAllowed,
  getCompatibleCustomProviders,
  normalizeCustomProviderEntry,
} from '../../packages/server/src/modules/studio/contracts/provider-compat'

describe('scoped coding-agent provider policy', () => {
  it('admits native OpenCode OpenAI Codex subscription auth', () => {
    expect(() => assertScopedCodingAgentProviderAllowed('scoped', 'openai-codex', 'opencode')).not.toThrow()
  })

  it.each([
    ['codex', 'openai-codex'],
    ['opencode', 'claude-oauth'],
    ['opencode', 'xai-oauth'],
  ])('rejects unsupported scoped OAuth/subscription path %s/%s', (agent, provider) => {
    expect(() => assertScopedCodingAgentProviderAllowed('scoped', provider, agent)).toThrow(
      'Coding agent scoped mode does not support OAuth/subscription providers',
    )
  })
})

describe('normalizeCustomProviderEntry', () => {
  it('returns null for non-objects', () => {
    expect(normalizeCustomProviderEntry(null)).toBeNull()
    expect(normalizeCustomProviderEntry('foo')).toBeNull()
    expect(normalizeCustomProviderEntry([])).toBeNull()
  })

  it('returns null when no usable URL is present', () => {
    expect(normalizeCustomProviderEntry({ name: 'foo' })).toBeNull()
    expect(normalizeCustomProviderEntry({ name: 'foo', base_url: 'not-a-url' })).toBeNull()
  })

  it('returns null when no name is present and no providerKey is supplied', () => {
    expect(normalizeCustomProviderEntry({ base_url: 'https://api.example.com' })).toBeNull()
  })

  it('falls back to providerKey when entry.name is missing', () => {
    const result = normalizeCustomProviderEntry(
      { base_url: 'https://api.example.com' },
      'volcengine-coding',
    )
    expect(result).not.toBeNull()
    expect(result!.name).toBe('volcengine-coding')
    expect(result!.provider_key).toBe('volcengine-coding')
  })

  it('accepts base_url, url, and api as URL aliases (first valid wins)', () => {
    const fromUrl = normalizeCustomProviderEntry({ name: 'a', url: 'https://example.com' })
    expect(fromUrl?.base_url).toBe('https://example.com')
    const fromApi = normalizeCustomProviderEntry({ name: 'a', api: 'https://api.example.com' })
    expect(fromApi?.base_url).toBe('https://api.example.com')
    const baseWins = normalizeCustomProviderEntry({
      name: 'a',
      base_url: 'https://primary.example.com',
      api: 'https://secondary.example.com',
    })
    expect(baseWins?.base_url).toBe('https://primary.example.com')
  })

  it('maps camelCase aliases to snake_case canonical fields', () => {
    const result = normalizeCustomProviderEntry({
      name: 'p',
      baseUrl: 'https://example.com',
      apiKey: 'secret',
      keyEnv: 'P_KEY',
      defaultModel: 'm-1',
    })
    expect(result?.base_url).toBe('https://example.com')
    expect(result?.api_key).toBe('secret')
    expect(result?.key_env).toBe('P_KEY')
    expect(result?.model).toBe('m-1')
  })

  it('treats api_key_env as a snake_case alias for key_env', () => {
    const result = normalizeCustomProviderEntry({
      name: 'p',
      base_url: 'https://example.com',
      api_key_env: 'P_KEY',
    })
    expect(result?.key_env).toBe('P_KEY')
  })

  it('preserves transport as api_mode', () => {
    const result = normalizeCustomProviderEntry({
      name: 'p',
      base_url: 'https://example.com',
      transport: 'chat_completions',
    })
    expect(result?.api_mode).toBe('chat_completions')
  })

  it('converts a list-of-strings models field into the dict shape', () => {
    const result = normalizeCustomProviderEntry({
      name: 'p',
      base_url: 'https://example.com',
      models: ['m-1', 'm-2', 'm-3'],
    })
    expect(result?.models).toEqual({ 'm-1': {}, 'm-2': {}, 'm-3': {} })
  })

  it('preserves a dict-shaped models field', () => {
    const result = normalizeCustomProviderEntry({
      name: 'p',
      base_url: 'https://example.com',
      models: { 'm-1': { context_length: 128_000 } },
    })
    expect(result?.models).toEqual({ 'm-1': { context_length: 128_000 } })
  })

  it('preserves discover_models, context_length, rate_limit_delay, extra_body', () => {
    const result = normalizeCustomProviderEntry({
      name: 'p',
      base_url: 'https://example.com',
      discover_models: false,
      context_length: 256_000,
      rate_limit_delay: 0.5,
      extra_body: { foo: 'bar' },
    })
    expect(result?.discover_models).toBe(false)
    expect(result?.context_length).toBe(256_000)
    expect(result?.rate_limit_delay).toBe(0.5)
    expect(result?.extra_body).toEqual({ foo: 'bar' })
  })

  it('drops invalid context_length / rate_limit_delay values silently', () => {
    const result = normalizeCustomProviderEntry({
      name: 'p',
      base_url: 'https://example.com',
      context_length: 0,
      rate_limit_delay: -1,
    })
    expect(result?.context_length).toBeUndefined()
    expect(result?.rate_limit_delay).toBeUndefined()
  })
})

describe('getCompatibleCustomProviders', () => {
  it('returns an empty array for non-config inputs', () => {
    expect(getCompatibleCustomProviders(null)).toEqual([])
    expect(getCompatibleCustomProviders(undefined)).toEqual([])
    expect(getCompatibleCustomProviders('not config')).toEqual([])
  })

  it('reads entries from the legacy custom_providers list', () => {
    const config = {
      custom_providers: [
        { name: 'volc', base_url: 'https://volc.example.com', model: 'minimax-m3' },
      ],
    }
    const result = getCompatibleCustomProviders(config)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('volc')
    expect(result[0].source).toBe('custom_providers')
    expect(result[0].model).toBe('minimax-m3')
  })

  it('reads entries from the v12+ providers dict', () => {
    const config = {
      providers: {
        'volcengine-coding': {
          api: 'https://ark.cn-beijing.volces.com/api/coding/v3',
          key_env: 'ARK_CODING_API_KEY',
          default_model: 'minimax-m3',
          models: ['minimax-m3', 'kimi-k2.6', 'glm-5.1'],
          discover_models: false,
        },
      },
    }
    const result = getCompatibleCustomProviders(config)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('volcengine-coding')
    expect(result[0].source).toBe('providers')
    expect(result[0].provider_key).toBe('volcengine-coding')
    expect(result[0].base_url).toBe('https://ark.cn-beijing.volces.com/api/coding/v3')
    expect(result[0].key_env).toBe('ARK_CODING_API_KEY')
    expect(result[0].model).toBe('minimax-m3')
    expect(result[0].models).toEqual({ 'minimax-m3': {}, 'kimi-k2.6': {}, 'glm-5.1': {} })
    expect(result[0].discover_models).toBe(false)
  })

  it('merges entries from both schemas, list first', () => {
    const config = {
      custom_providers: [
        { name: 'legacy', base_url: 'https://legacy.example.com', model: 'm-l' },
      ],
      providers: {
        modern: { api: 'https://modern.example.com', default_model: 'm-m' },
      },
    }
    const result = getCompatibleCustomProviders(config)
    expect(result.map(p => p.name)).toEqual(['legacy', 'modern'])
  })

  it('deduplicates entries by provider_key (prefers list first)', () => {
    const config = {
      custom_providers: [
        { name: 'shared', base_url: 'https://list.example.com', model: 'list-model' },
      ],
      providers: {
        // Same provider_key as the list entry's name — list entry wins per Hermes Agent semantics.
        shared: { api: 'https://dict.example.com', default_model: 'dict-model' },
      },
    }
    const result = getCompatibleCustomProviders(config)
    // The dict entry has provider_key='shared'. The list entry has no provider_key
    // (its name is just 'shared'). Identity dedup uses (name, base_url, model)
    // triple — different base_urls, so both should appear.
    expect(result).toHaveLength(2)
    expect(result[0].base_url).toBe('https://list.example.com')
    expect(result[1].base_url).toBe('https://dict.example.com')
  })

  it('deduplicates true duplicates by name+base_url+model triple', () => {
    const config = {
      custom_providers: [
        { name: 'dup', base_url: 'https://dup.example.com', model: 'm-1' },
        { name: 'dup', base_url: 'https://dup.example.com/', model: 'm-1' }, // trailing slash
      ],
    }
    const result = getCompatibleCustomProviders(config)
    expect(result).toHaveLength(1)
  })

  it('returns empty array when custom_providers is malformed', () => {
    // Matches Hermes Agent: a non-list custom_providers value bails out entirely.
    expect(getCompatibleCustomProviders({ custom_providers: 'broken' })).toEqual([])
  })

  it('skips dict entries without a base_url silently', () => {
    const config = {
      providers: {
        'no-url': { default_model: 'foo' },
        'with-url': { api: 'https://valid.example.com', default_model: 'bar' },
      },
    }
    const result = getCompatibleCustomProviders(config)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('with-url')
  })

  it('handles the volcengine-coding example from issue #1570', () => {
    // This is the exact config shape from the bug report — Studio should now see
    // the provider with all 5 models.
    const config = {
      model: { default: 'minimax-m3', provider: 'volcengine-coding' },
      providers: {
        'volcengine-coding': {
          api: 'https://ark.cn-beijing.volces.com/api/coding/v3',
          key_env: 'ARK_CODING_API_KEY',
          default_model: 'minimax-m3',
          models: ['minimax-m3', 'kimi-k2.6', 'glm-5.1', 'deepseek-v4-pro', 'deepseek-v4-flash'],
          discover_models: false,
        },
      },
      custom_providers: [],
    }
    const result = getCompatibleCustomProviders(config)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('volcengine-coding')
    expect(Object.keys(result[0].models || {})).toEqual([
      'minimax-m3', 'kimi-k2.6', 'glm-5.1', 'deepseek-v4-pro', 'deepseek-v4-flash',
    ])
  })
})
