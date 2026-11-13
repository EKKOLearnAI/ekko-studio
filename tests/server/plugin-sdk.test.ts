import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PluginRuntime } from '../../packages/server/src/modules/studio/services/plugins/runtime'
import { PluginStore } from '../../packages/server/src/modules/studio/services/plugins/store'
import { pluginApiPath } from '../../packages/server/src/modules/studio/services/plugins/policy'
import type { PluginPermission } from '../../packages/plugin-sdk/src'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture(permissions: PluginPermission[] = []) {
  const home = await mkdtemp(join(tmpdir(), 'plugin-sdk-'))
  cleanup.push(() => rm(home, { recursive: true, force: true }))
  const browser = vi.fn(async () => ({ result: { value: 'page title' } })), api = vi.fn(async () => null)
  const runtime = new PluginRuntime({ directory: home, source: home, enabled: true, installedAt: 0, config: {},
    manifest: { id: 'example', name: 'Example', version: '2.0.0', apiVersion: 1, permissions } },
  { userId: 1, profile: 'default' }, new PluginStore(home), { authorize() {}, browser, api, emit() {}, log() {} })
  cleanup.push(() => runtime.close())
  return { runtime, browser, api }
}
it('keeps declared permissions separate from host features and uses explicit state scopes', async () => {
  const { runtime } = await fixture()
  const first = runtime.runContext({ userId: 2, profile: 'work', sessionId: 'chat' }, new AbortController().signal)
  const second = runtime.runContext({ userId: 3, profile: 'work', sessionId: 'chat' }, new AbortController().signal)
  expect(first.permissions).toEqual([])
  expect(first.features).toContain('tools')
  await expect(first.tools.call('example/tool', {})).rejects.toThrow('requires tools')
  await first.state.plugin.set('shared', true)
  await first.state.profile.set('private', true)
  expect(await second.state.plugin.get('shared')).toBe(true)
  expect(await second.state.profile.get('private')).toBeUndefined()
  expect(first.state.session).toBeDefined()
  expect(first.state.agentSession).toBeUndefined()
  expect(runtime.context()).not.toHaveProperty('api')
  expect(runtime.context()).not.toHaveProperty('storage')
})
it('requires the browser permission independently of API writes, binds identity, and expires calls', async () => {
  const denied = await fixture(['api.write'])
  await expect(denied.runtime.context().host.browser.cdp.send('tab', 'Runtime.evaluate')).rejects.toThrow('browser.cdp')
  expect(denied.browser).not.toHaveBeenCalled()
  const allowed = await fixture(['browser.cdp'])
  const controller = new AbortController(), identity = { userId: 4, profile: 'work' }
  const run = allowed.runtime.runContext(identity, controller.signal)
  expect(await run.host.browser.cdp.send('tab', 'Runtime.evaluate', { expression: 'document.title' })).toEqual({ result: { value: 'page title' } })
  expect(allowed.browser).toHaveBeenCalledWith(identity, 'cdp.send', { tab_id: 'tab', method: 'Runtime.evaluate', params: { expression: 'document.title' } }, expect.any(String), controller.signal)
  expect(allowed.api).not.toHaveBeenCalled()
  allowed.browser.mockImplementationOnce(() => new Promise(() => {}))
  const pending = run.host.browser.cdp.attach('tab')
  await vi.waitFor(() => expect(allowed.browser).toHaveBeenCalledTimes(2))
  controller.abort(new Error('Stopped'))
  await expect(pending).rejects.toThrow('Stopped')
  expect(() => pluginApiPath('/api/studio/desktop-browser/request', identity, {})).toThrow()
})
it('cleans ordinary callback resources when the call finishes', async () => {
  const { runtime } = await fixture(), dispose = vi.fn()
  runtime.context().extensions.rpc.register('resource', async (_input, run) => {
    await run.lifecycle.acquire(async () => dispose)
    return true
  })
  expect(await runtime.invoke('rpc', 'resource', null, { userId: 1, profile: 'default' })).toBe(true)
  expect(dispose).toHaveBeenCalledTimes(1)
})
it('rejects malformed public results and API bodies before dispatch and leaves the plugin usable', async () => {
  const { runtime, api } = await fixture(['tools', 'api.write'])
  const ctx = runtime.context(), who = { userId: 1, profile: 'default' }
  ctx.extensions.rpc.register('invalid', async () => ({ count: NaN }))
  await expect(runtime.invoke('rpc', 'invalid', null, who)).rejects.toThrow(/JSON/)
  ctx.extensions.tools.register({ name: 'broken', description: 'Invalid envelope', inputSchema: { type: 'object' }, execute: async () => ({ content: 'missing ok' } as any) })
  await expect(runtime.invoke('tool', 'broken', {}, who)).rejects.toThrow(/missing ok/)
  await expect(ctx.host.models.respond({ model: 'native', input: { value: undefined } } as any)).rejects.toThrow(/JSON/)
  expect(api).not.toHaveBeenCalled()
  ctx.extensions.rpc.register('valid', async () => ({ count: 1 }))
  expect(await runtime.invoke('rpc', 'valid', null, who)).toEqual({ count: 1 })
})
