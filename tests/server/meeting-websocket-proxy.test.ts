import { createServer, type Server } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import { afterEach, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({
  asrPort: 0, diarizePort: 0,
  ensureReady: vi.fn(async () => {}), pushKey: vi.fn(async () => {}),
}))
vi.mock('../../packages/server/src/modules/studio/public/auth', () => ({
  isAuthEnabled: async () => true,
  authenticateUserToken: async (token: string) => token === 'meeting-user' ? { id: 1 } : null,
  getToken: async () => 'meeting-server-token',
}))
vi.mock('../../packages/server/src/modules/studio/services/meeting-asr', () => ({
  meetingASRService: {
    getASRPort: () => runtime.asrPort,
    getDiarizePort: () => runtime.diarizePort,
    useTls: false,
    ensureDashScopeKeyPushed: runtime.pushKey,
  },
}))
vi.mock('../../packages/server/src/modules/studio/services/realtime-backend', () => ({
  ensureRealtimeBackendReady: runtime.ensureReady,
}))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }))
import { setupMeetingWebSocketProxy } from '../../packages/server/src/bootstrap/meeting-websocket'

const servers: Server[] = []
const sockets: WebSocket[] = []
const backends: WebSocketServer[] = []
async function listen(server: Server): Promise<number> {
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as { port: number }).port
}
async function backend(label: string) {
  const server = createServer()
  const ws = new WebSocketServer({ server })
  backends.push(ws)
  ws.on('connection', (socket, req) => {
    sockets.push(socket)
    expect(req.headers.authorization).toBeUndefined()
    expect(req.headers.cookie).toBeUndefined()
    socket.send(`${label}:${req.url}`)
  })
  return listen(server)
}
afterEach(async () => {
  sockets.splice(0).forEach(socket => socket.terminate())
  backends.splice(0).forEach(server => server.close())
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  vi.clearAllMocks()
})

it.each(['/ws/asr', '/ws/diarize', '/ws/omni-realtime'])('forwards %s upgrades, retaining query parameters and selecting the managed child', async path => {
  runtime.asrPort = await backend('asr')
  runtime.diarizePort = await backend('diarize')
  const proxy = createServer()
  setupMeetingWebSocketProxy([proxy])
  const port = await listen(proxy)
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}?profile=default`)
  sockets.push(socket)
  const message = await new Promise<string>((resolve, reject) => {
    socket.once('message', value => resolve(String(value)))
    socket.once('error', reject)
  })
  expect(message).toBe(`${path === '/ws/diarize' ? 'diarize' : 'asr'}:${path}?profile=default`)
  expect(runtime.ensureReady).toHaveBeenCalledTimes(path === '/ws/omni-realtime' ? 1 : 0)
  expect(runtime.pushKey).toHaveBeenCalledTimes(path === '/ws/omni-realtime' ? 1 : 0)
})

async function proxyServer() {
  runtime.asrPort = await backend('asr')
  const proxy = createServer()
  setupMeetingWebSocketProxy([proxy])
  return listen(proxy)
}

it.each([
  { token: '', expected: 401, origin: '' },
  { token: '?token=meeting-user', expected: 403, origin: 'https://untrusted.invalid' },
])('rejects browser upgrades with HTTP $expected before starting ASR', async ({ token, expected, origin }) => {
  const port = await proxyServer()
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/omni-realtime${token}`, { origin: origin || `http://127.0.0.1:${port}` })
  sockets.push(socket)
  const status = await new Promise<number | undefined>((resolve, reject) => {
    socket.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode) })
    socket.on('error', reject)
  })
  expect(status).toBe(expected)
  expect(runtime.ensureReady).not.toHaveBeenCalled()
})

it.each(['meeting-user', 'meeting-server-token'])('accepts valid credentials without forwarding them to Python', async token => {
  const port = await proxyServer()
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/asr?profile=default&token=${token}`, {
    origin: `http://127.0.0.1:${port}`,
    headers: { Authorization: `Bearer ${token}`, Cookie: 'session=private' },
  })
  sockets.push(socket)
  const message = await new Promise<string>((resolve, reject) => {
    socket.once('message', value => resolve(String(value)))
    socket.once('error', reject)
  })
  expect(message).toBe('asr:/ws/asr?profile=default')
})
