import { createServer } from 'http'
import { Server } from 'socket.io'
import { io } from 'socket.io-client'
import { RTCPeerConnection } from 'werift'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalAppRelayServer } from '../../packages/server/src/modules/studio/services/app-relay/server'
import { P2PRelaySessions } from '../../packages/server/src/modules/studio/services/app-relay/p2p'
import { P2PAssembler, encodeP2P, p2pFrames } from '../../packages/server/src/modules/studio/services/app-relay/p2p-wire'
import { inspectAppUserToken } from '../../packages/server/src/modules/studio/middleware/auth'
import { getP2PNetworkConfig } from '../../packages/server/src/modules/studio/services/app-relay/p2p-network'

vi.mock('../../packages/server/src/modules/studio/services/app-relay/p2p-network', async importOriginal => {
  const actual = await importOriginal<typeof import('../../packages/server/src/modules/studio/services/app-relay/p2p-network')>()
  return { ...actual, getP2PNetworkConfig: vi.fn(actual.getP2PNetworkConfig) }
})

vi.mock('../../packages/server/src/modules/studio/middleware/auth', () => ({
  authenticateUserToken: vi.fn(async () => ({ id: 1 })),
  inspectAppUserToken: vi.fn(async (token: string) => ['good', 'cloud-good'].includes(token) ? { status: 'active', user: { id: 1 }, deviceCode: 'phone', connectionType: token === 'cloud-good' ? 'cloud' : 'lan' } : { status: 'revoked' }),
}))
vi.mock('../../packages/server/src/modules/studio/public/config', () => ({ config: { port: 8648, appRelay: { entitlementRequired: false } } }))
vi.mock('../../packages/server/src/modules/studio/public/system-info', () => ({ getDeviceId: vi.fn(async () => 'machine') }))

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('real P2P transport', () => {
  it.each(['manual', 'cloud development'])('serves APIs, binary downloads and chat over %s P2P, with relay fallback', async mode => {
    vi.stubEnv('STUDIO_P2P_STUN_URLS', '')
    let writes = 0
    const http = createServer((request, response) => {
      if (request.url === '/api/file') { response.setHeader('content-type', 'application/octet-stream'); response.end(Buffer.alloc(200_000, 7)); return }
      if (request.url === '/api/write') writes++
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ok: true, authorization: request.headers.authorization }))
    })
    const server = new Server(http)
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
    const address = http.address() as { port: number }
    const url = `http://127.0.0.1:${address.port}`
    const local = new LocalAppRelayServer(server, { machineId: 'machine', localBaseUrl: url, entitlementRequired: false })
    local.init()
    const cloudP2P = new P2PRelaySessions(url)
    server.of('/chat-run').on('connection', socket => socket.on('run', () => socket.emit('message.done', { text: 'hello' })))
    const raw = io(`${url}/app-relay`, { forceNew: true, autoConnect: false, auth: { role: 'app', machineId: 'machine', deviceCode: 'phone', token: 'good' }, transports: ['websocket'] })
    const peer = new RTCPeerConnection({ iceServers: [] })
    const channel = peer.createDataChannel('ekko-relay-v1', { ordered: true })
    const assembler = new P2PAssembler()
    const pending = new Map<string, (message: any) => void>()
    let readyMessage: any
    let serial = 0
    const events: any[] = []
    channel.onMessage.subscribe(data => {
      const message = assembler.receive(typeof data === 'string' ? data : data.toString('utf8'))
      if (!message) return
      if (message.kind === 'ready') readyMessage = message
      else if (message.kind === 'event') events.push(...message.args)
      else if (message.kind === 'ack') pending.get(message.id)?.(message)
    })
    const request = (event: string, payload: any) => new Promise<any>((resolve, reject) => {
      const id = `request-${++serial}`
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('request_timeout')) }, 5000)
      pending.set(id, message => {
        clearTimeout(timer); pending.delete(id)
        if (message.error) reject(new Error(message.error)); else resolve(message.args[0])
      })
      for (const frame of p2pFrames(encodeP2P({ kind: 'request', id, event, args: [payload], timeout: 5000 }), id)) channel.send(frame)
    })
    try {
      const ready = new Promise<void>(resolve => raw.once('relay.ready', resolve))
      raw.connect(); await ready
      await peer.setLocalDescription(await peer.createOffer())
      const answer = mode === 'cloud development'
        ? await cloudP2P.offer('cloud-app', {
          type: 'offer', sdp: peer.localDescription!.sdp, studioUserId: 1,
          auth: { token: 'cloud-good', deviceCode: 'phone', machineId: 'separate-development-cloud-identity' },
        })
        : await new Promise<any>((resolve, reject) => raw.timeout(25_000).emit('p2p.offer', {
        type: 'offer', sdp: peer.localDescription!.sdp, auth: { token: 'client-cannot-override-auth' },
      }, (error: Error | null, result: any) => error ? reject(error) : resolve(result)))
      expect(answer.ok).toBe(true)
      await peer.setRemoteDescription({ type: 'answer', sdp: answer.sdp })
      await vi.waitFor(() => expect(readyMessage).toMatchObject({ transport: 'p2p-direct', cloudSpeedLimited: false }), { timeout: 20_000 })
      const api = await request('http.request', { id: 'get', method: 'GET', path: '/api/test' })
      expect(api.status).toBe(200); expect(JSON.parse(api.body).authorization).toBe(mode === 'cloud development' ? 'Bearer cloud-good' : 'Bearer good')
      const file = await request('http.request', { id: 'file', method: 'GET', path: '/api/file', streamBinary: true })
      const chunk = await request('http.download.chunk', { id: file.download.id })
      expect(new Uint8Array(chunk.bodyBytes).byteLength).toBeGreaterThan(0)
      expect(new Uint8Array(chunk.bodyBytes)[0]).toBe(7)
      const opened = await request('socket.open', { id: 'chat', namespace: '/chat-run', auth: { token: 'good' }, stream: true })
      expect(opened.ok).toBe(true)
      await vi.waitFor(() => expect(events.some(event => event.event === 'connect')).toBe(true), { timeout: 5000 })
      await request('socket.event', { id: 'chat', namespace: '/chat-run', event: 'run', payload: {}, stream: true })
      await vi.waitFor(() => expect(events.some(event => event.event === 'message.done' && event.payload.text === 'hello')).toBe(true))
      const write = await request('http.request', { id: 'write', method: 'POST', path: '/api/write' })
      expect(write.status).toBe(200); expect(writes).toBe(1)
      if (mode === 'cloud development') cloudP2P.close('cloud-app')
      else await new Promise<void>(resolve => raw.emit('p2p.close', {}, () => resolve()))
      const fallback = await new Promise<any>((resolve, reject) => raw.timeout(5000).emit('http.request', {
        id: 'fallback', method: 'GET', path: '/api/test',
      }, (error: Error | null, result: any) => error ? reject(error) : resolve(result)))
      expect(fallback.status).toBe(200)
      expect(writes).toBe(1)
    } finally { cloudP2P.closeAll(); raw.disconnect(); await peer.close(); await new Promise<void>(resolve => server.close(() => resolve())) }
  }, 30_000)

  it('rejects TURN offers, invalid credentials and oversized frames', async () => {
    const sessions = new P2PRelaySessions('http://127.0.0.1:1')
    expect(await sessions.offer('owner', { type: 'offer', sdp: 'a=candidate:1 1 udp 1 1.1.1.1 1 typ relay', auth: { token: 'good' } })).toMatchObject({ ok: false })
    expect(await sessions.offer('owner', { type: 'offer', sdp: 'sdp', auth: {} })).toMatchObject({ ok: false })
    const assembler = new P2PAssembler()
    let result
    for (const frame of p2pFrames(encodeP2P({ bytes: Buffer.from([1, 2]), text: '中文🙂'.repeat(10_000) }), 'id')) result = assembler.receive(frame)
    expect(result.bytes).toEqual(Buffer.from([1, 2]))
    expect(() => assembler.receive('x'.repeat(100_000))).toThrow('p2p_invalid_frame')
    sessions.closeAll()
  })

  it('cannot resurrect a peer when its owner disconnects during authorization', async () => {
    let authorize!: (value: any) => void
    vi.mocked(inspectAppUserToken).mockImplementationOnce(() => new Promise(resolve => { authorize = resolve }))
    const sessions = new P2PRelaySessions('http://127.0.0.1:1')
    const offer = sessions.offer('owner', { type: 'offer', sdp: 'sdp', studioUserId: 1, auth: { token: 'good', deviceCode: 'phone' } })
    sessions.closeAll()
    authorize({ status: 'active', user: { id: 1 }, deviceCode: 'phone', connectionType: 'cloud' })
    expect(await offer).toMatchObject({ ok: false, error: 'p2p_cancelled' })
    expect(sessions.keepalive('owner')).toEqual({ ok: false })
  })

  it('cannot resurrect a peer when its owner disconnects during network discovery', async () => {
    let discover!: (value: Awaited<ReturnType<typeof getP2PNetworkConfig>>) => void
    vi.mocked(getP2PNetworkConfig).mockImplementationOnce(() => new Promise(resolve => { discover = resolve }))
    const sessions = new P2PRelaySessions('http://127.0.0.1:1')
    const offer = sessions.offer('owner', { type: 'offer', sdp: 'sdp', auth: { token: 'good' } })
    await vi.waitFor(() => expect(discover).toBeTypeOf('function'))
    sessions.closeAll()
    discover({ peer: {}, advertiseAddresses: [] })
    expect(await offer).toEqual({ ok: false, error: 'p2p_cancelled' })
    expect(sessions.keepalive('owner')).toEqual({ ok: false })
  })

  it('rejects invalid network configuration without leaving a P2P session', async () => {
    vi.stubEnv('STUDIO_P2P_INTERFACE', 'missing-p2p-interface')
    const sessions = new P2PRelaySessions('http://127.0.0.1:1')
    expect(await sessions.offer('owner', { type: 'offer', sdp: 'sdp', auth: { token: 'good' } })).toEqual({ ok: false, error: 'p2p_invalid_network_config' })
    expect(sessions.keepalive('owner')).toEqual({ ok: false })
  })

  it.each([
    { status: 'revoked' },
    { status: 'active', user: { id: 2 }, deviceCode: 'phone', connectionType: 'cloud' },
    { status: 'active', user: { id: 1 }, deviceCode: 'other-phone', connectionType: 'cloud' },
    { status: 'active', user: { id: 1 }, deviceCode: 'phone', connectionType: 'lan' },
  ])('rejects cloud identity mismatch: %j', async token => {
    vi.mocked(inspectAppUserToken).mockResolvedValueOnce(token as any)
    const sessions = new P2PRelaySessions('http://127.0.0.1:1')
    expect(await sessions.offer('owner', { type: 'offer', sdp: 'sdp', studioUserId: 1,
      auth: { token: 'cloud', deviceCode: 'phone' } })).toEqual({ ok: false, error: 'p2p_unauthorized' })
    expect(sessions.keepalive('owner')).toEqual({ ok: false })
  })
})
