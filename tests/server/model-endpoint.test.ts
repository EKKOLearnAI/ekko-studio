import { describe, expect, it } from 'vitest'
import { resolveConfiguredModelEndpoint } from '../../packages/server/src/modules/hermes/services/models/endpoint'

describe('configured model endpoint', () => {
  it('prefers provider configuration and reads both URL field spellings', () => {
    const config = { model: { provider: 'deepseek', base_url: 'https://default.test' }, providers: { DeepSeek: { baseUrl: 'https://selected.test' } } }
    expect(resolveConfiguredModelEndpoint(config, 'deepseek', 'model', 'DEEPSEEK_BASE_URL=https://env.test')).toBe('https://selected.test')
    config.providers.DeepSeek = { base_url: 'https://snake.test' } as any
    expect(resolveConfiguredModelEndpoint(config, 'deepseek', 'model')).toBe('https://snake.test')
  })

  it('reads named custom providers and the selected providerless default without borrowing an unrelated endpoint', () => {
    const config = { model: { default: 'model', base_url: 'https://default.test' }, custom_providers: [{ name: 'Work Gateway', model: 'model', base_url: 'https://work.test' }] }
    expect(resolveConfiguredModelEndpoint(config, 'custom:work-gateway', 'model')).toBe('https://work.test')
    expect(resolveConfiguredModelEndpoint(config, undefined, 'model')).toBe('https://default.test')
    expect(resolveConfiguredModelEndpoint(config, 'unknown', 'model')).toBeUndefined()
  })

  it('uses profile environment before official presets and handles missing or malformed config', () => {
    expect(resolveConfiguredModelEndpoint({}, 'deepseek', 'model', "DEEPSEEK_BASE_URL='https://env.test/v1'\n")).toBe('https://env.test/v1')
    expect(resolveConfiguredModelEndpoint({}, 'deepseek', 'model')).toBe('https://api.deepseek.com')
    expect(resolveConfiguredModelEndpoint({ model: { provider: 123 } }, 'unknown', 'model')).toBeUndefined()
    expect(resolveConfiguredModelEndpoint(undefined, '__proto__', 'model')).toBeUndefined()
  })

  it('respects the selected URL for unnamed custom providers and keeps multiple model matches unresolved', () => {
    const config: any = { model: { provider: 'custom', base_url: 'https://selected.test/' }, custom_providers: [
      { name: 'A', model: 'shared', base_url: 'https://a.test' },
      { name: 'B', model: 'shared', base_url: 'https://b.test' },
    ] }
    expect(resolveConfiguredModelEndpoint(config, 'custom', 'shared')).toBe('https://selected.test/')
    delete config.model.base_url
    expect(resolveConfiguredModelEndpoint(config, 'custom', 'shared')).toBeUndefined()
    expect(resolveConfiguredModelEndpoint({ providers: { work: { name: 'Display name', url: 'https://work.test' } } }, 'custom:work', 'shared')).toBe('https://work.test')
  })
})
