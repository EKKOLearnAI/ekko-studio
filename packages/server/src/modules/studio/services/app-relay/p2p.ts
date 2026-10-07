import { randomUUID } from 'crypto'
import { io, type Socket } from 'socket.io-client'
import type { RTCPeerConnection, RTCDataChannel } from 'werift'
import { inspectAppUserToken } from '../../middleware/auth'
import { getDeviceId } from '../../public/system-info'
import { logger } from '../../public/logging'
import { P2PAssembler, P2P_EVENTS, encodeP2P, p2pFrames } from './p2p-wire'
import { addP2PAdvertiseCandidates, getP2PNetworkConfig } from './p2p-network'
import { resolveP2PSTUN } from './p2p-stun'

export const P2P_STUN_URLS = ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302']
type Session = { pc: RTCPeerConnection; socket: Socket; timer: NodeJS.Timeout; expires: number; channel?: RTCDataChannel; queue: string[]; queued: number; serial: number; assembler: P2PAssembler; inflight: number; drain?: NodeJS.Timeout }

function candidateCounts(sdp: string) {
  const candidates = sdp.split(/\r?\n/).filter(line => line.startsWith('a=candidate:'))
  return { total: candidates.length, host: candidates.filter(line => /\btyp host\b/.test(line)).length,
    srflx: candidates.filter(line => /\btyp srflx\b/.test(line)).length,
    relay: candidates.filter(line => /\btyp relay\b/.test(line)).length }
}

// The existing local relay performs every API/namespace authorization check.
// P2P replaces the network hop; it does not introduce a second API dispatcher.
export class P2PRelaySessions {
  private sessions = new Map<string, Session>()
  private offers = new Map<string, symbol>()
  constructor(private readonly localBaseUrl: string) {}

  async offer(owner: string, input: Record<string, any>): Promise<Record<string, unknown>> {
    this.close(owner)
    if (process.env.STUDIO_P2P_ENABLED === '0') return { ok: false, error: 'p2p_disabled' }
    if (!owner || this.sessions.size + this.offers.size >= 32 || input.type !== 'offer' || typeof input.sdp !== 'string' || input.sdp.length > 128 * 1024
      || /\btyp relay\b/.test(input.sdp) || !input.auth?.token) return { ok: false, error: 'p2p_invalid_offer' }
    const attempt = Symbol(owner)
    this.offers.set(owner, attempt)
    try { return await this.negotiate(owner, input, attempt) }
    finally { if (this.offers.get(owner) === attempt) this.offers.delete(owner) }
  }

  private async negotiate(owner: string, input: Record<string, any>, attempt: symbol): Promise<Record<string, unknown>> {
    const localAuth = { ...input.auth, role: 'app' }
    if (input.studioUserId) {
      const token = await inspectAppUserToken(String(input.auth.token))
      if (token?.status !== 'active' || token.deviceCode !== input.auth.deviceCode || token.user?.id !== input.studioUserId || token.connectionType !== 'cloud') return { ok: false, error: 'p2p_unauthorized' }
      // Development uses a separate cloud relay identity. The authenticated
      // loopback dispatcher still expects this Studio's local device identity.
      localAuth.machineId = await getDeviceId()
    }
    if (this.offers.get(owner) !== attempt) return { ok: false, error: 'p2p_cancelled' }
    const { RTCPeerConnection: PeerConnection } = await import('werift')
    if (this.offers.get(owner) !== attempt) return { ok: false, error: 'p2p_cancelled' }
    const stun = process.env.STUDIO_P2P_STUN_URLS === undefined ? P2P_STUN_URLS : process.env.STUDIO_P2P_STUN_URLS.split(',').map(url => url.trim()).filter(Boolean)
    if (stun.some(url => !url.startsWith('stun:'))) return { ok: false, error: 'p2p_invalid_stun_config' }
    let network: Awaited<ReturnType<typeof getP2PNetworkConfig>>
    try { network = await getP2PNetworkConfig() }
    catch { return { ok: false, error: 'p2p_invalid_network_config' } }
    if (this.offers.get(owner) !== attempt) return { ok: false, error: 'p2p_cancelled' }
    const endpoints = await resolveP2PSTUN(stun)
    if (this.offers.get(owner) !== attempt) return { ok: false, error: 'p2p_cancelled' }
    const attemptId = randomUUID()
    logger.info({ attemptId, stage: 'offer', candidates: candidateCounts(input.sdp), stun: endpoints.diagnostics }, '[app-p2p] negotiation')
    const pc = new PeerConnection({ iceServers: endpoints.urls.map(url => ({ urls: url })), ...network.peer })
    const socket = io(`${this.localBaseUrl}/app-relay`, { auth: localAuth, transports: ['websocket'], forceNew: true, autoConnect: false, reconnection: false, timeout: 8000 })
    const session: Session = { pc, socket, timer: setInterval(() => { if (this.sessions.get(owner) === session && Date.now() > session.expires) this.close(owner) }, 5000), expires: Date.now() + 45_000, queue: [], queued: 0, serial: 0, assembler: new P2PAssembler(), inflight: 0 }
    session.timer.unref()
    this.sessions.set(owner, session)
    this.offers.delete(owner)
    const current = () => this.sessions.get(owner) === session
    const close = () => { if (current()) this.close(owner) }
    socket.on('disconnect', close)
    socket.onAny((event: string, ...args: unknown[]) => {
      if (!current()) return
      if (event === 'socket.event') this.send(owner, { kind: 'event', event, args })
      if (event === 'relay.connection.deleted' || event === 'relay.access.revoked') close()
    })
    pc.connectionStateChange.subscribe(state => {
      if (!current()) return
      logger.info({ attemptId, stage: 'connection', state }, '[app-p2p] negotiation')
      if (state === 'failed' || state === 'closed' || state === 'disconnected') close()
    })
    pc.onDataChannel.subscribe(channel => {
      if (!current() || channel.label !== 'ekko-relay-v1' || session.channel) { channel.close(); return }
      session.channel = channel
      channel.bufferedAmountLowThreshold = 256 * 1024
      channel.bufferedAmountLow.subscribe(() => { if (current()) this.drain(owner) })
      channel.stateChange.subscribe(state => {
        if (!current()) return
        if (state === 'open') {
          if (!this.direct(pc)) { close(); return }
          this.send(owner, { kind: 'ready', transport: 'p2p-direct', cloudSpeedLimited: false })
        }
        if (state === 'closed') close()
      })
      channel.onMessage.subscribe(data => { if (current()) void this.receive(owner, data) })
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('p2p_auth_timeout')), 8000)
        socket.once('relay.ready', () => { clearTimeout(timer); resolve() })
        socket.once('connect_error', error => { clearTimeout(timer); reject(error) })
        socket.connect()
      })
      if (this.sessions.get(owner) !== session) throw new Error('p2p_cancelled')
      await pc.setRemoteDescription({ type: 'offer', sdp: input.sdp })
      await pc.setLocalDescription(await pc.createAnswer())
      if (this.sessions.get(owner) !== session) throw new Error('p2p_cancelled')
      const sdp = addP2PAdvertiseCandidates(pc.localDescription!.sdp, network.advertiseAddresses)
      logger.info({ attemptId, stage: 'answer', candidates: candidateCounts(sdp) }, '[app-p2p] negotiation')
      return { ok: true, type: 'answer', sdp }
    } catch {
      logger.warn({ attemptId, stage: 'failed' }, '[app-p2p] negotiation')
      if (this.sessions.get(owner) === session) this.close(owner)
      return { ok: false, error: 'p2p_unavailable' }
    }
  }

  keepalive(owner: string): { ok: boolean } {
    const session = this.sessions.get(owner)
    if (session) session.expires = Date.now() + 45_000
    return { ok: Boolean(session) }
  }
  close(owner: string): { ok: true } {
    this.offers.delete(owner)
    const session = this.sessions.get(owner)
    if (session) {
      this.sessions.delete(owner); clearInterval(session.timer); clearTimeout(session.drain)
      session.assembler.clear(); session.queue.length = 0
      session.socket.disconnect(); void session.pc.close().catch(() => undefined)
    }
    return { ok: true }
  }
  closeAll(): void { for (const owner of new Set([...this.sessions.keys(), ...this.offers.keys()])) this.close(owner) }

  private direct(pc: RTCPeerConnection): boolean {
    const pairs = pc.iceTransports.map(transport => transport.getSelectedCandidatePair())
    return pairs.length > 0 && pairs.every(pair => pair && /\btyp (host|srflx|prflx)\b/.test(pair.local.candidate) && /\btyp (host|srflx|prflx)\b/.test(pair.remote.candidate))
  }
  private async receive(owner: string, raw: string | Buffer): Promise<void> {
    const session = this.sessions.get(owner)
    if (!session || !this.direct(session.pc)) { this.close(owner); return }
    try {
      const message = session.assembler.receive(typeof raw === 'string' ? raw : raw.toString('utf8'))
      if (!message) return
      if (message.kind !== 'request' || typeof message.id !== 'string' || message.id.length > 128 || !P2P_EVENTS.has(message.event) || !Array.isArray(message.args) || message.args.length > 1 || session.inflight >= 32) throw new Error('p2p_invalid_request')
      session.inflight++
      const timeout = Math.max(1000, Math.min(Number(message.timeout) || 30_000, 330_000))
      session.socket.timeout(timeout).emit(message.event, ...message.args, (error: Error | null, ...args: unknown[]) => {
        session.inflight--
        if (this.sessions.get(owner) !== session) return
        this.send(owner, { kind: 'ack', id: message.id, ...(error ? { error: 'p2p_request_timeout' } : { args }) })
      })
    } catch { this.close(owner) }
  }
  private send(owner: string, message: unknown): void {
    const session = this.sessions.get(owner)
    if (!session?.channel || session.channel.readyState !== 'open') return
    try {
      const frames = p2pFrames(encodeP2P(message), `${++session.serial}-${randomUUID()}`)
      const size = frames.reduce((n, frame) => n + frame.length, 0)
      if (session.queued + size > 48 * 1024 * 1024) throw new Error('p2p_backpressure')
      session.queue.push(...frames); session.queued += size; this.drain(owner)
    } catch { this.close(owner) }
  }
  private drain(owner: string): void {
    const session = this.sessions.get(owner)
    if (!session?.channel || session.channel.readyState !== 'open') return
    clearTimeout(session.drain)
    try {
      while (session.queue.length && session.channel.bufferedAmount < 512 * 1024) {
        const frame = session.queue.shift()!; session.queued -= frame.length; session.channel.send(frame)
      }
      if (session.queue.length) session.drain = setTimeout(() => this.drain(owner), 10)
    } catch { this.close(owner) }
  }
}
