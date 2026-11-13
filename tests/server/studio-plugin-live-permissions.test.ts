import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginRuntime } from '../../packages/server/src/modules/studio/services/plugins/runtime'
import { PluginStore } from '../../packages/server/src/modules/studio/services/plugins/store'
import type { HostSession, PluginPermission, SessionEvent, SessionListener } from '../../packages/plugin-sdk/src'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture(permissions: PluginPermission[]) {
  const home = await mkdtemp(join(tmpdir(), 'plugin-live-'))
  cleanup.push(() => rm(home, { recursive: true, force: true }))
  let listener: SessionListener = () => {}
  const raw: HostSession = { sessionId: 'chat', run: vi.fn(async () => {}), stop: vi.fn(async () => {}), resume: vi.fn(async () => {}), close: vi.fn(),
    queue: { insert: vi.fn(async () => {}), cancel: vi.fn(async () => {}) }, interactions: { approve: vi.fn(async () => {}), clarify: vi.fn(async () => {}) } }
  const authorize = vi.fn(), sessions = vi.fn(async (_identity, _id, notify: SessionListener) => { listener = notify; return raw })
  const runtime = new PluginRuntime({ directory: home, source: home, enabled: true, installedAt: 0, config: {},
    manifest: { id: 'live', name: 'Live', version: '1.0.0', apiVersion: 1, permissions } },
  { userId: 1, profile: 'default' }, new PluginStore(home), { authorize, sessions, api: async () => null, emit() {}, log() {} })
  cleanup.push(() => runtime.close())
  return { runtime, raw, authorize, sessions, emit: (event: SessionEvent) => listener(event) }
}

it('requires read permission for subscriptions and write permission for controls', async () => {
  const denied = await fixture([])
  await expect(denied.runtime.context().host.sessions.connect('chat', () => {})).rejects.toThrow('api.read')
  expect(denied.sessions).not.toHaveBeenCalled()
  const allowed = await fixture(['api.read'])
  const listener = vi.fn(), session = await allowed.runtime.context().host.bots.connect('person-main-bot', listener)
  expect(allowed.sessions.mock.calls[0]).toMatchObject([{ userId: 1, profile: 'default' }, 'person-main-bot', expect.any(Function), expect.any(AbortSignal), 'bot'])
  await session.resume()
  await expect(session.run('hello')).rejects.toThrow('api.write')
  await expect(session.stop()).rejects.toThrow('api.write')
  expect(allowed.raw.run).not.toHaveBeenCalled()
  allowed.emit({ event: 'message.delta', session_id: 'person-main-bot', delta: 'hello' })
  await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1))
  await session.close()
  allowed.emit({ event: 'message.delta', session_id: 'person-main-bot', delta: 'late' })
  await expect(session.resume()).rejects.toBeDefined()
  expect(listener).toHaveBeenCalledTimes(1)
})

it('binds real caller identity, rechecks authorization, and closes connections on plugin shutdown', async () => {
  const fixtureValue = await fixture(['api.read', 'api.write'])
  const { runtime, raw, authorize, sessions } = fixtureValue
  const caller = { userId: 7, profile: 'work', sessionId: 'source' }, controller = new AbortController()
  const session = await runtime.runContext(caller, controller.signal, runtime.effects).host.sessions.connect('target', () => {})
  expect(sessions.mock.calls[0][0]).toEqual(caller)
  await session.run('hello')
  authorize.mockImplementationOnce(() => { throw new Error('access revoked') })
  await expect(session.stop()).rejects.toThrow('access revoked')
  expect(raw.stop).not.toHaveBeenCalled()
  await runtime.close()
  expect(raw.close).toHaveBeenCalledTimes(1)
  await expect(session.run('late')).rejects.toBeDefined()
})
