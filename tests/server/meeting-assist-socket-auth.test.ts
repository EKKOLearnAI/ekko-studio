import { createServer } from 'node:http'
import { Server } from 'socket.io'
import { io as connect, type Socket } from 'socket.io-client'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('../../packages/server/src/modules/studio/public/auth', () => ({
  authenticateUserToken: async (token: string) => token === 'first' ? { id: 1 } : token === 'second' ? { id: 2 } : null,
}))
vi.mock('../../packages/server/src/modules/studio/services/meeting-asr/direct-llm', () => ({
  analyzeViaDirectLLM: async () => ({ summary: 'Private analysis' }),
  streamDirectLLMReport: async function* () {},
}))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
import { realtimeAssistService as assist } from '../../packages/server/src/modules/studio/services/meeting-asr/realtime-assist'

const clients: Socket[] = []
let server: Server | undefined
async function fixture() {
  const http = createServer()
  server = new Server(http)
  assist.init(server)
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  const port = (http.address() as { port: number }).port
  return (token: string) => {
    const socket = connect(`http://127.0.0.1:${port}/meeting-assist`, { auth: { token }, transports: ['websocket'], reconnection: false, autoConnect: false })
    clients.push(socket)
    return socket
  }
}
afterEach(async () => {
  clients.splice(0).forEach(client => client.disconnect())
  assist.stopAllSessions()
  await server?.close()
})

it('requires a user token to open the meeting analysis namespace', async () => {
  const socket = (await fixture())('')
  const error = await new Promise<Error>(resolve => socket.once('connect_error', resolve).connect())
  expect(error.message).toBe('Authentication failed')
})

it('isolates both subscriptions and in-memory sessions when two users share a session ID', async () => {
  const client = await fixture()
  const first = client('first'), second = client('second')
  await Promise.all([first, second].map(socket => new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve).once('connect_error', reject).connect()
  })))
  expect(await first.emitWithAck('join', 'same-id')).toBe(true)
  expect(await second.emitWithAck('join', 'same-id')).toBe(true)
  await assist.startSession('same-id', 'general', 'default', undefined, 1)
  await assist.startSession('same-id', 'general', 'default', undefined, 2)
  const seenBySecond = vi.fn()
  second.on('analyzing', seenBySecond)
  const firstStarted = new Promise<boolean>(resolve => first.once('analyzing', resolve))
  assist.stopSession('same-id', 2)
  assist.pushSentence('same-id', { text: 'Private meeting text' }, 1)
  assist.flushNow('same-id', 1)
  expect(await firstStarted).toBe(true)
  expect(seenBySecond).not.toHaveBeenCalled()
})
