import { afterEach, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { Server, type Socket } from 'socket.io'
import { connectPluginSession } from '../../packages/server/src/modules/studio/services/plugins/session-transport'
import type { SessionEvent } from '../../packages/plugin-sdk/src'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

it('uses the core chat protocol for snapshots, streaming, controls and reconnect without replaying a run', async () => {
  const http = createServer(), io = new Server(http), namespace = io.of('/chat-run')
  cleanup.push(() => new Promise<void>(resolve => io.close(() => resolve())))
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${(http.address() as { port: number }).port}`
  let peer: Socket, connections = 0
  const commands: Array<{ event: string; payload: any }> = []
  namespace.use((socket, next) => { expect(socket.handshake.auth.token).toBe('fixture'); expect(socket.handshake.query.profile).toBe('work'); next() })
  namespace.on('connection', socket => {
    peer = socket; connections++
    socket.on('resume', input => socket.emit('resumed', { session_id: input.session_id, messages: [{ content: 'snapshot' }] }))
    socket.onAny((event, payload) => {
      commands.push({ event, payload })
      if (event === 'run') {
        socket.emit('message.delta', { session_id: 'other', delta: 'private' })
        socket.emit('message.delta', { session_id: payload.session_id, delta: 'hello' })
        socket.emit('run.completed', { session_id: payload.session_id, output: 'hello' })
      }
    })
  })
  const events: SessionEvent[] = [], controller = new AbortController()
  const session = await connectPluginSession({ baseUrl, sessionId: 'chat', profile: 'work', signal: controller.signal, token: async () => 'fixture', listener: event => events.push(event) })
  cleanup.push(() => session.close())
  await vi.waitFor(() => expect(events.some(event => event.event === 'resumed')).toBe(true))
  await session.run('input', { session_id: 'other', profile: 'wrong' })
  await vi.waitFor(() => expect(events.some(event => event.event === 'run.completed')).toBe(true))
  expect(events.find(event => event.event === 'message.delta')?.delta).toBe('hello')
  expect(events.every(event => event.session_id === 'chat')).toBe(true)
  await session.queue.insert('queued'); await session.queue.cancel('queued')
  await session.interactions.approve('approval', 'approve'); await session.interactions.clarify('question', 'answer')
  await session.stop()
  await vi.waitFor(() => expect(commands.some(command => command.event === 'abort')).toBe(true))
  expect(commands.map(command => command.event)).toEqual(expect.arrayContaining(['insert_queued_run', 'cancel_queued_run', 'approval.respond', 'clarify.respond']))
  expect(commands.every(command => command.payload.session_id === 'chat' && command.payload.profile === 'work')).toBe(true)
  peer!.conn.close()
  await vi.waitFor(() => expect(connections).toBe(2), { timeout: 5000 })
  await vi.waitFor(() => expect(events.filter(event => event.event === 'resumed')).toHaveLength(2))
  expect(commands.filter(command => command.event === 'run')).toHaveLength(1)
  await session.close()
  await expect(session.run('late')).rejects.toThrow('disconnected')
  expect(commands.filter(command => command.event === 'abort')).toHaveLength(1)
}, 10_000)

it('rejects a cancelled connection before creating a socket', async () => {
  const controller = new AbortController(); controller.abort(new Error('page closed'))
  await expect(connectPluginSession({ baseUrl: 'http://127.0.0.1:1', sessionId: 'chat', profile: 'work', signal: controller.signal, token: async () => 'fixture', listener() {} })).rejects.toThrow('page closed')
})
