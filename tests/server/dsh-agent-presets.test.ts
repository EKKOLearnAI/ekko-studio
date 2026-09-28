import { afterEach, expect, it, vi } from 'vitest'
import { DshAgentPresetService } from '../../packages/server/src/modules/coding-agents/services/dsh/agent-presets'
import type { DshManagement } from '../../packages/server/src/modules/coding-agents/services/dsh/management'
const open = vi.fn(async () => ({ endpoint: 'http://127.0.0.1:12345', cookie: 'native-secret', generation: 'fixture' }))
const service = new DshAgentPresetService({ open } as unknown as DshManagement)
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })
it('rejects invalid identifiers and payloads before starting the native host', async () => {
  await expect(service.read('../outside')).rejects.toMatchObject({ status: 400 })
  await expect(service.copy({ from: 'standard', id: 'safe', name: {} })).rejects.toMatchObject({ status: 400 })
  await expect(service.remove('/absolute')).rejects.toMatchObject({ status: 400 })
  expect(open).not.toHaveBeenCalled()
})
it('uses native correlation and keeps credentials in the backend request', async () => {
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    const message = JSON.parse(String(init.body))
    expect(init.headers).toMatchObject({ cookie: 'native-secret', origin: 'http://127.0.0.1:12345' })
    expect(message).toMatchObject({ type: 'client-request', method: 'agentPresets/read', payload: { args: { agentPreset: 'standard' } } })
    return Response.json({ type: 'server-response', rpcId: message.rpcId, result: { ok: true, value: { content: '- name: native-tool' } } })
  })
  vi.stubGlobal('fetch', fetcher)
  expect(await service.read('standard')).toEqual({ content: '- name: native-tool' })
  expect(fetcher.mock.calls[0][0]).toBe('http://127.0.0.1:12345/api/agentPresets/read')
})
it('refuses mismatched native responses and unavailable defaults', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ type: 'server-response', rpcId: 'wrong', result: { ok: true, value: {} } })))
  await expect(service.list()).rejects.toMatchObject({ status: 502, code: 'DSH_PRESET_UNAVAILABLE' })
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => Response.json({ type: 'server-response', rpcId: JSON.parse(String(init.body)).rpcId, result: { ok: true, value: { presets: [{ id: 'broken', broken: 'Cannot resolve plugin' }], authorable: true } } })))
  await expect(service.makeDefault('missing')).rejects.toMatchObject({ status: 422 })
  await expect(service.makeDefault('broken')).rejects.toMatchObject({ status: 422 })
})

it('fixes a session preset independently of the global default and rejects unavailable choices', async () => {
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body))
    expect(request.method).toBe('agentPresets/list')
    return Response.json({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: { presets: [
      { id: 'standard', name: 'Standard', isDefault: true }, { id: 'minimal', name: 'Minimal', isDefault: false },
      { id: 'broken', isDefault: false, broken: '/private/plugin.mjs failed' },
    ], authorable: true } } })
  })
  vi.stubGlobal('fetch', fetcher)
  expect(await service.forSession('minimal')).toBe('minimal')
  expect(await service.forSession(undefined)).toBe('standard')
  await expect(service.forSession('missing')).rejects.toMatchObject({ status: 422 })
  await expect(service.forSession('broken')).rejects.toMatchObject({ status: 422 })
  await expect(service.forSession('../bad')).rejects.toMatchObject({ status: 400 })
  const calls = fetcher.mock.calls.length
  expect(await service.forSession('standard', 'minimal')).toBe('minimal')
  expect(fetcher).toHaveBeenCalledTimes(calls)
  expect(await service.choices()).toEqual({ presets: [
    { id: 'standard', name: 'Standard', isDefault: true }, { id: 'minimal', name: 'Minimal', isDefault: false },
    { id: 'broken', isDefault: false, unavailable: true },
  ] })
})

it.each([true, false, undefined])('uses the native default settings format with authorable=%s', async authorable => {
  const calls: Array<{ method: string; payload: { args: unknown } }> = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const message = JSON.parse(String(init.body)); calls.push(message)
    return Response.json({ type: 'server-response', rpcId: message.rpcId, result: { ok: true, value: {
      presets: [{ id: 'standard', isDefault: true }], ...(authorable === undefined ? {} : { authorable }),
    } } })
  }))
  expect(await service.makeDefault('standard')).toEqual({ authorable: authorable === true, presets: [{ id: 'standard', isDefault: true }] })
  expect(calls.find(call => call.method === 'settings/update')?.payload.args).toEqual(authorable === undefined
    ? { ns: 'agent-preset-registry', patch: { selectedDefault: 'standard' } }
    : { ns: 'agent-presets', patch: { default: 'standard' } })
  if (authorable === undefined) {
    await expect(service.copy({ from: 'standard', id: 'custom' })).rejects.toMatchObject({ status: 422, code: 'DSH_CAPABILITY_UNSUPPORTED' })
    await expect(service.remove('standard')).rejects.toMatchObject({ status: 422 })
    await expect(service.openLocation('standard')).rejects.toMatchObject({ status: 422 })
    expect(calls.some(call => ['agentPresets/copy', 'agentPresets/deletePreset', 'settings/openAgentPresetDirectory'].includes(call.method))).toBe(false)
  }
})
