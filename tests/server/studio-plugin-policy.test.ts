import { describe, it, expect } from 'vitest'
import { pluginApiPath, publicConfig, mergeSecrets } from '../../packages/server/src/modules/studio/services/plugins/policy'
import { createStudioApi, type Schema } from '../../packages/plugin-sdk/src'
describe('Plugin API and configuration boundaries', () => {
  const identity = { userId: 1, profile: 'work' }
  it('pins authenticated API requests to the current profile', () => {
    expect(pluginApiPath('/api/studio/sessions?limit=5', identity, { query: { order: 'desc' } }).searchParams.get('profile')).toBe('work')
    for (const path of ['https://evil.test/api/studio/sessions', '//evil.test/api/x', '/api/../auth', '/api/%2e%2e/auth', '/api/studio/plugins/install', '/api/auth/login', '/api/studio/sessions?profile=other', '/api/hermes/profiles/other/config']) expect(() => pluginApiPath(path, identity, {})).toThrow()
    expect(() => pluginApiPath('/api/studio/sessions', identity, { method: 'POST', body: { profile: 'other' } })).toThrow(/profile/)
    expect(() => pluginApiPath('/api/studio/sessions', identity, { method: 'CONNECT' as any })).toThrow(/options/)
    for (const path of ['/api/studio/Plugins/install', '/api/studio/AUTH/users', '/api/studio/models/API-KEYS', '/api/hermes/Profiles/other/config']) expect(() => pluginApiPath(path, identity, {})).toThrow()
  })
  it('redacts nested secrets and preserves omitted values without retaining explicitly replaced values', () => {
    const schema: Schema = { type: 'object', properties: { nested: { type: 'object', properties: { token: { type: 'string', secret: true }, name: { type: 'string' } } }, list: { type: 'array', items: { type: 'object', properties: { password: { type: 'string', secret: true } } } } } }
    const original = { nested: { token: 'sensitive', name: 'name' }, list: [{ password: 'hidden' }] }
    const visible = publicConfig(original, schema)!
    expect(visible).toEqual({ nested: { name: 'name' }, list: [{}] })
    expect(mergeSecrets(visible, original, schema)).toEqual(original)
    expect(mergeSecrets({ nested: { token: '' } }, original, schema)).toEqual({ nested: { token: '' } })
  })
  it('uses existing backend paths for the shared frontend and server SDK', async () => {
    const calls: any[] = []
    const api = createStudioApi(async (path, options) => { calls.push({ path, options }); return null as any })
    await api.studio.sessions.get('a/b'); await api.models.respond({ model: 'demo', input: 'hello', stream: true })
    expect(calls).toEqual([{ path: '/api/studio/sessions/a%2Fb', options: undefined }, { path: '/api/ekko-studio/models/v1/responses', options: { method: 'POST', body: { model: 'demo', input: 'hello', stream: false } } }])
  })
})
