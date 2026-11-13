import { afterEach, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { Server } from 'socket.io'
import { io as connect } from 'socket.io-client'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PluginRuntime } from '../../packages/server/src/modules/studio/services/plugins/runtime'
import { PluginStore } from '../../packages/server/src/modules/studio/services/plugins/store'
import { connectPluginSession } from '../../packages/server/src/modules/studio/services/plugins/session-transport'
import { registerPluginSessions } from '../../packages/server/src/modules/studio/sockets/plugin-sessions'

const state = vi.hoisted(() => ({ runtime: undefined as any }))
vi.mock('../../packages/server/src/modules/studio/public/auth', () => ({ authenticateUserToken: async (token: string) => token === 'account' ? { id: 1, role: 'admin' } : null }))
vi.mock('../../packages/server/src/modules/studio/public/users', () => ({ userCanAccessProfile: (_id: number, profile: string) => profile === 'work' }))
vi.mock('../../packages/server/src/modules/studio/services/plugins/host', () => ({
  getPluginManager: () => ({ runtime: (_who: unknown, id: string) => { if (id !== 'live') throw new Error('Plugin unavailable'); return state.runtime } }),
  resolvePluginIdentity: (who: any) => { if (who.sessionId !== 'owned') throw new Error('Session unavailable'); return who },
}))
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

it('bridges authenticated plugin subscriptions to core streaming and closes them when the plugin stops', async () => {
  const http = createServer(), server = new Server(http)
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`
  const core = server.of('/chat-run'), runs = vi.fn()
  let coreConnections = 0
  core.on('connection', socket => {
    coreConnections++
    socket.on('resume', () => socket.emit('resumed', { session_id: 'owned', messages: [] }))
    socket.on('run', input => { runs(input); socket.emit('message.delta', { session_id: 'owned', delta: 'live' }); socket.emit('run.completed', { session_id: 'owned', output: 'live' }) })
  })
  const home = await mkdtemp(join(tmpdir(), 'plugin-session-bridge-')); cleanup.push(() => rm(home, { recursive: true, force: true }))
  const runtime = new PluginRuntime({ directory: home, source: home, enabled: true, installedAt: 0, config: {},
    manifest: { id: 'live', name: 'Live', version: '1.0.0', apiVersion: 1, permissions: ['api.read', 'api.write'] } },
  { userId: 1, profile: 'work' }, new PluginStore(home), {
    authorize(who) { if (who.userId !== 1 || who.profile !== 'work' || who.sessionId !== 'owned') throw new Error('Scope unavailable') },
    sessions: (who, id, listener, signal) => connectPluginSession({ baseUrl: url, sessionId: id, profile: who.profile, listener, signal, token: async () => 'core' }),
    api: async () => null, emit() {}, log() {},
  })
  state.runtime = runtime; cleanup.push(() => runtime.close())
  registerPluginSessions(server)
  const socket = connect(url + '/plugins', { auth: { token: 'account', profile: 'work' }, transports: ['websocket'] })
  cleanup.push(() => { socket.disconnect() })
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject) })
  const events: any[] = []; socket.on('session.event', event => events.push(event))
  const request = (event: string, input: unknown) => socket.timeout(2000).emitWithAck(event, input)
  expect(await request('session.open', { id: 'denied', pluginId: 'live', sessionId: 'private', kind: 'chat' })).toMatchObject({ error: 'Session unavailable' })
  expect(coreConnections).toBe(0)
  expect(await request('session.open', { id: 'stream', pluginId: 'live', sessionId: 'owned', kind: 'chat' })).toEqual({ ok: true })
  await vi.waitFor(() => expect(events.some(value => value.event.event === 'resumed')).toBe(true))
  expect(await request('session.command', { id: 'stream', method: 'run', args: { input: 'hello', options: { session_id: 'private', profile: 'wrong' } } })).toEqual({ ok: true })
  await vi.waitFor(() => expect(events.some(value => value.event.event === 'message.delta' && value.event.delta === 'live')).toBe(true))
  expect(runs).toHaveBeenCalledWith(expect.objectContaining({ session_id: 'owned', profile: 'work', input: 'hello' }))
  await runtime.close()
  await vi.waitFor(() => expect(events.some(value => value.event.event === 'transport.closed')).toBe(true))
  expect(await request('session.command', { id: 'stream', method: 'run', args: { input: 'late' } })).toHaveProperty('error')
  expect(runs).toHaveBeenCalledTimes(1)
})
