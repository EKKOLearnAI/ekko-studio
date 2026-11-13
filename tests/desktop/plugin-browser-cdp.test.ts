import { afterEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CdpTabState } from '../../packages/desktop/src/main/browser/browser-cdp'
import { BrowserBroker } from '../../packages/desktop/src/main/browser/browser-broker'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
it('routes tab CDP commands, validates frame sessions, bounds events and cleans listeners', async () => {
  const debuggerApi = Object.assign(new EventEmitter(), { sendCommand: vi.fn(async () => ({ result: { value: 'title' } })) })
  const state = new CdpTabState({ debugger: debuggerApi } as any)
  state.listen()
  expect(await state.pluginSend('Runtime.evaluate', { expression: 'document.title' })).toEqual({ result: { value: 'title' } })
  await expect(state.pluginSend('Browser.close', {})).rejects.toThrow('Unsupported')
  await expect(state.pluginSend('Target.getTargets', {})).rejects.toThrow('Unsupported')
  await expect(state.pluginSend('Runtime.evaluate', {}, 'other-tab')).rejects.toThrow('session')
  for (let i = 0; i < 70; i++) debuggerApi.emit('message', {}, 'Runtime.consoleAPICalled', { i })
  const batch = state.pluginEvents(0, 32)
  expect(batch.dropped).toBe(true)
  expect(batch.events).toHaveLength(32)
  expect(state.pluginEvents(batch.cursor, 64).events).toHaveLength(32)
  debuggerApi.emit('message', {}, 'Network.dataReceived', { data: 'a'.repeat(17000) })
  expect(state.pluginEvents(70, 1).events[0]).toMatchObject({ truncated: true, params: {} })
  state.dispose()
  expect(debuggerApi.listenerCount('message')).toBe(0)
})
it('uses separate relay-client leases and fences CDP requests after a user takeover', async () => {
  const home = await mkdtemp(join(tmpdir(), 'browser-cdp-'))
  cleanup.push(() => rm(home, { recursive: true, force: true }))
  let complete!: (value: unknown) => void
  const manager = { state: () => ({ tabs: [{ id: 'tab', title: 'page', url: 'https://example.com' }] }),
    setAgentControl: vi.fn(), cancelAgentOperation: vi.fn(), revokeAgentControl: vi.fn(),
    attachPluginCdp: vi.fn(async () => ({ cursor: 0, sessions: [] })),
    sendPluginCdp: vi.fn(() => new Promise(resolve => { complete = resolve })),
  }
  const broker = new BrowserBroker(manager as any, home), descriptor = await broker.start()
  cleanup.push(() => broker.stop())
  const registration = await fetch(descriptor.endpoint + '/session', { method: 'POST', headers: { Authorization: `Bearer ${descriptor.token}` }, body: '{}' })
  const client = await registration.json() as any
  const request = async (scope: string, method: string) => {
    const response = await fetch(descriptor.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${client.session_token}`, 'X-Hermes-Browser-Client': client.client_id },
      body: JSON.stringify({ client_scope: scope, method, params: { tab_id: 'tab', method: 'Runtime.evaluate' } }) })
    return { status: response.status, body: await response.json() as any }
  }
  expect((await request('plugin-a', 'cdp.attach')).status).toBe(200)
  expect((await request('plugin-b', 'cdp.attach')).status).toBe(409)
  const pending = request('plugin-a', 'cdp.send')
  await vi.waitFor(() => expect(manager.sendPluginCdp).toHaveBeenCalledTimes(1))
  broker.revokeTab('tab'); complete({ result: 'late' })
  expect((await pending).status).toBe(409)
  expect((await request('plugin-b', 'cdp.attach')).status).toBe(200)
  broker.revokeClient(client.client_id)
  expect((await request('plugin-b', 'cdp.attach')).status).toBe(401)
})
