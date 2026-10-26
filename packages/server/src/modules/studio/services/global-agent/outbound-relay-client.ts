import { randomUUID } from 'crypto'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { io, type Socket } from 'socket.io-client'
import { config } from '../../public/config'
import { clearSessionMessages } from '../../repositories/session-store'
import { getChatRunServer } from '../../public/chat-run'
import { logger } from '../../public/logging'
import { transcodeToPcmS16le } from '../voice/stt/audio-convert'
import { encodeMcuImaAdpcm } from '../voice/mcu/adpcm'
import { MCU_TTS_SAMPLE_RATE, mcuPromptText, mcuPromptUrl } from '../voice/mcu/prompts'
import { createMcuSpeechSegmenter, normalizeMcuSpeechText } from './mcu-speech-segmenter'
import {
  DEFAULT_MCU_AGENT_RUNTIME,
  mcuChatRunFields,
  normalizeMcuAgentRuntime,
  type McuAgentRuntime,
} from './mcu-agent-runtime'

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const MAX_REQUEST_TIMEOUT_MS = 120_000
const MAX_REQUEST_BODY_BYTES = 5 * 1024 * 1024
const MAX_RESPONSE_BODY_BYTES = 10 * 1024 * 1024
const GLOBAL_AGENT_NAMESPACE = '/global-agent'

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])
const ALLOWED_REQUEST_HEADERS = new Set([
  'accept',
  'accept-language',
  'authorization',
  'content-type',
  'x-hermes-profile',
  'x-request-id',
])
const TEXTUAL_RESPONSE_TYPES = [
  'application/json',
  'application/problem+json',
  'application/x-ndjson',
  'application/javascript',
  'application/xml',
  'application/x-www-form-urlencoded',
  'text/',
]
const ALLOWED_SOCKET_NAMESPACES = new Set(['/chat-run'])
const ALLOWED_CHAT_RUN_CLIENT_EVENTS = new Set([
  'run',
  'resume',
  'abort',
  'cancel_queued_run',
  'insert_queued_run',
  'approval.respond',
  'clarify.respond',
])
const CHAT_RUN_SERVER_EVENTS = [
  'run.started',
  'message.delta',
  'message.interim',
  'reasoning.delta',
  'thinking.delta',
  'reasoning.available',
  'tool.started',
  'tool.completed',
  'tool.failed',
  'workspace.diff.completed',
  'run.completed',
  'run.failed',
  'compression.started',
  'compression.completed',
  'abort.started',
  'abort.timeout',
  'abort.completed',
  'usage.updated',
  'agent.event',
  'subagent.event',
  'session.command',
  'session.title.updated',
  'run.queued',
  'run.queue_insertion.updated',
  'approval.requested',
  'approval.resolved',
  'clarify.requested',
  'clarify.resolved',
  'peer.user.message',
  'resumed',
]
const NON_STREAMING_SUPPRESSED_EVENTS = new Set([
  'message.delta',
  'message.interim',
  'reasoning.delta',
  'thinking.delta',
  'reasoning.available',
])
const SOCKET_IO_RESERVED_EVENTS = new Set([
  'connect',
  'connect_error',
  'disconnect',
  'disconnecting',
  'newListener',
  'removeListener',
])
const MCU_TTS_OPTIONS = {
  mcuPlayback: true,
  sampleRate: MCU_TTS_SAMPLE_RATE,
} as const
const MCU_INTERRUPT_DEBOUNCE_MS = 280

function resolveGlobalAgentSocketIoUrl(input: string): string {
  const url = new URL(input)
  const path = url.pathname.replace(/\/+$/, '')
  if (!path) {
    url.pathname = GLOBAL_AGENT_NAMESPACE
  } else if (path !== GLOBAL_AGENT_NAMESPACE && !path.endsWith(GLOBAL_AGENT_NAMESPACE)) {
    url.pathname = `${path}${GLOBAL_AGENT_NAMESPACE}`
  }
  return url.toString()
}

function chooseMcuApprovalChoice(event: Record<string, unknown>): 'once' | 'session' | 'always' | null {
  const rawChoices = Array.isArray(event.choices) ? event.choices.map(choice => String(choice)) : []
  const choices = rawChoices.length > 0 ? rawChoices : ['once', 'session', 'deny']
  if (choices.includes('session')) return 'session'
  if (choices.includes('once')) return 'once'
  if (choices.includes('always')) return 'always'
  return null
}

export interface RelayHttpRequest {
  id?: string
  method?: string
  path?: string
  headers?: Record<string, string | string[] | undefined>
  body?: unknown
  bodyBase64?: string
  timeoutMs?: number
}

export interface RelayHttpResponse {
  id?: string
  status?: number
  headers?: Record<string, string>
  body?: string
  bodyBase64?: string
  truncated?: boolean
  error?: {
    code: string
    message: string
  }
}

export interface RelaySocketOpenRequest {
  id?: string
  namespace?: string
  auth?: Record<string, unknown>
  query?: Record<string, string | number | boolean | undefined>
  stream?: boolean
}

export interface RelaySocketEventRequest {
  id?: string
  event?: string
  payload?: unknown
  stream?: boolean
}

export interface RelaySocketCloseRequest {
  id?: string
}

export interface RelaySocketResponse {
  id?: string
  ok?: boolean
  namespace?: string
  event?: string
  stream?: boolean
  payload?: unknown
  error?: {
    code: string
    message: string
  }
}

interface StartOutboundRelayClientOptions {
  connectionId?: string
  relayUrl?: string
  relayToken?: string
  userToken?: string
  instanceId?: string
  deviceCode?: string
  localBaseUrl?: string
  machineInfo?: Record<string, unknown>
  fetchImpl?: typeof fetch
  relayProtocol?: 'socket.io' | 'mcu-socket.io'
}

type OutboundRelayClientOptions =
  Required<Omit<StartOutboundRelayClientOptions, 'connectionId' | 'relayProtocol' | 'userToken' | 'machineInfo'>> &
  Pick<StartOutboundRelayClientOptions, 'userToken'>
  & { machineInfo?: Record<string, unknown> }
type RelayClient = Pick<OutboundRelayClient, 'start' | 'stop' | 'isConnected' | 'waitForConnected'> | McuSocketIoRelayClient

interface LocalSocketBridge {
  id: string
  namespace: string
  socket: Socket
  stream: boolean
  output: string
  reasoning: string
}

interface McuVoiceMeta {
  interactionId: string
  mimeType: string
  bytes: number
  profile: string
  agentRuntime: McuAgentRuntime
}

interface RelayMcuBackgroundListener {
  socket: Socket
  close: () => void
}

interface PendingRelayMcuBackgroundSpeech {
  profile: string
  delegationId?: string
  text: string
}

interface EnqueuedMcuSpeechSegment {
  playbackDone: Promise<void>
}

type McuSpeechSynthesisResult =
  | { ok: true; audio: { url: string; mimeType: string } }
  | { ok: false; err: unknown; aborted: boolean }

class McuSocketIoRelayClient {
  private socket: Socket | null = null
  private localAgentSocket: Socket | null = null
  private stopped = false
  private reconnectBlockedReason = ''
  private pendingVoice: McuVoiceMeta | null = null
  private pendingVoiceStream: (McuVoiceMeta & {
    sampleRate: number
    channels: number
    bitsPerSample: number
    chunks: Buffer[]
  }) | null = null
  private localMcuForwardQueue = Promise.resolve()
  private readonly audioWaiters = new Map<string, { resolve: () => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>()
  private readonly activeRuns = new Map<string, { socket: Socket; sessionId: string }>()
  private readonly sessionRuns = new Map<string, { interactionId: string; socket: Socket }>()
  private readonly backgroundListeners = new Map<string, RelayMcuBackgroundListener>()
  private readonly pendingBackgroundSpeech = new Map<string, PendingRelayMcuBackgroundSpeech[]>()
  private readonly backgroundSpeechRuns = new Set<string>()
  private readonly interruptedInteractions = new Set<string>()
  private readonly ttsAbortControllers = new Map<string, Set<AbortController>>()
  private readonly recentlyInterruptedSessions = new Map<string, number>()
  private readonly pendingInterrupts = new Map<string, { profile: string; interactionId: string; timer: NodeJS.Timeout }>()
  private audioUploadToken = ''
  private audioUploadPath = '/global-agent/audio'
  private remoteMcuUserToken = ''
  private mcuWebhookSubscription: Record<string, unknown> | null = null

  constructor(private readonly options: OutboundRelayClientOptions) {}

  start(): void {
    if (this.socket) return
    this.stopped = false
    this.reconnectBlockedReason = ''
    this.connect()
  }

  stop(): void {
    this.stopped = true
    this.mcuWebhookSubscription = null
    for (const listener of [...this.backgroundListeners.values()]) listener.close()
    this.backgroundListeners.clear()
    this.pendingBackgroundSpeech.clear()
    this.socket?.disconnect()
    this.socket = null
    this.localAgentSocket?.disconnect()
    this.localAgentSocket = null
    this.cancelPendingInterrupts()
    this.rejectAudioWaiters(new Error('MCU Socket.IO relay stopped'))
  }

  isConnected(): boolean {
    return Boolean(this.socket?.connected)
  }

  waitForConnected(timeoutMs = 5000): Promise<boolean> {
    const socket = this.socket
    if (!socket) return Promise.resolve(false)
    if (socket.connected) return Promise.resolve(true)
    return new Promise(resolve => {
      const cleanup = () => {
        clearTimeout(timer)
        socket.off('connect', onConnect)
        socket.off('connect_error', onFailure)
      }
      const onConnect = () => {
        cleanup()
        resolve(true)
      }
      const onFailure = () => {
        cleanup()
        resolve(false)
      }
      const timer = setTimeout(() => {
        cleanup()
        resolve(false)
      }, timeoutMs)
      socket.once('connect', onConnect)
      socket.once('connect_error', onFailure)
    })
  }

  private connect(): void {
    if (this.stopped) return
    const authPayload: Record<string, unknown> = {
      token: this.options.relayToken || undefined,
      instanceId: this.options.instanceId || undefined,
      role: 'hermes-studio',
      clientRole: 'web',
      relayRole: 'web',
      machine: this.options.machineInfo || undefined,
    }
    if (this.options.deviceCode) {
      authPayload.deviceCode = this.options.deviceCode
      authPayload.device_code = this.options.deviceCode
    }
    const relaySocketUrl = resolveGlobalAgentSocketIoUrl(this.options.relayUrl)
    const socket: Socket = io(relaySocketUrl, {
      auth: authPayload,
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30_000,
      timeout: 30_000,
    })
    this.socket = socket

    socket.on('connect', () => {
      logger.info({ relayUrl: this.redactedRelayUrl() }, '[outbound-relay:mcu-sio] connected')
      this.connectLocalAgentSocket()
      for (const sessionId of this.pendingBackgroundSpeech.keys()) void this.flushBackgroundSpeech(sessionId)
    })

    socket.on('connect_error', (err: Error) => {
      logger.warn({ err, relayUrl: this.redactedRelayUrl() }, '[outbound-relay:mcu-sio] connection error')
      if (err.message === 'device_code_not_allowed' || err.message.includes('非官方设备码')) {
        this.stopped = true
        this.reconnectBlockedReason = err.message
        socket.io.opts.reconnection = false
      }
    })

    socket.on('disconnect', (reason: string) => {
      this.localAgentSocket?.disconnect()
      this.localAgentSocket = null
      this.rejectAudioWaiters(new Error('MCU Socket.IO relay disconnected'))
      logger.info({
        reason,
        reconnectBlockedReason: this.reconnectBlockedReason || undefined,
        relayUrl: this.redactedRelayUrl(),
      }, '[outbound-relay:mcu-sio] disconnected')
    })

    socket.on('http.request', (request: RelayHttpRequest, ack?: (response: RelayHttpResponse) => void) => {
      void this.handleHttpRequest(request)
        .then((response) => this.respond(response, ack))
        .catch((err) => this.respond(relayError(request?.id, 'relay_internal_error', err instanceof Error ? err.message : String(err), 500), ack))
    })

    socket.onAny((eventName: string, payload: unknown) => {
      if (SOCKET_IO_RESERVED_EVENTS.has(eventName)) return
      if (eventName === 'http.request') return
      this.handleRemoteEvent(eventName, payload)
    })
  }

  private async handleHttpRequest(request: RelayHttpRequest): Promise<RelayHttpResponse> {
    const method = normalizeMethod(request.method)
    if (!method) {
      return relayError(request.id, 'method_not_allowed', 'Relay request method is not allowed', 405)
    }

    const path = normalizeRelayPath(request.path)
    if (!path) {
      return relayError(request.id, 'path_not_allowed', 'Relay request path is not allowed', 403)
    }
    if (path !== '/api/auth/mcu-login') {
      return relayError(request.id, 'path_not_allowed', 'MCU relay only allows the MCU login endpoint', 403)
    }

    const headers = normalizeHeaders(request.headers)
    const normalizedBody = normalizeRequestBody(request, method, headers)
    if (isRelayHttpResponse(normalizedBody)) return normalizedBody
    if (normalizedBody.contentType) headers.set('content-type', normalizedBody.contentType)
    if (path === '/api/auth/mcu-login') {
      headers.set('x-hermes-relay-forwarded', 'mcu-socket.io')
    }

    const timeoutMs = normalizeTimeout(request.timeoutMs)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await this.options.fetchImpl(`${this.options.localBaseUrl.replace(/\/$/, '')}${path}`, {
        method,
        headers,
        body: normalizedBody.body,
        signal: controller.signal,
      })
      const body = await readResponseBody(response)
      if (path === '/api/auth/mcu-login' && response.ok && typeof body.body === 'string') {
        this.rememberRemoteMcuLoginToken(body.body)
      }
      return {
        id: request.id,
        status: response.status,
        headers: responseHeaders(response),
        ...body,
      }
    } catch (err) {
      const aborted = controller.signal.aborted
      return relayError(
        request.id,
        aborted ? 'request_timeout' : 'local_request_failed',
        aborted ? `Local relay request timed out after ${timeoutMs}ms` : err instanceof Error ? err.message : String(err),
        aborted ? 504 : 502,
      )
    } finally {
      clearTimeout(timeout)
    }
  }

  private respond(response: RelayHttpResponse, ack?: (response: RelayHttpResponse) => void): void {
    if (ack) {
      ack(response)
      return
    }
    this.socket?.emit('http.response', response)
  }

  private connectLocalAgentSocket(): void {
    const userToken = this.options.userToken || ''
    if (this.localAgentSocket || !userToken) return
    const localBaseUrl = this.options.localBaseUrl.replace(/\/$/, '')
    const socket: Socket = io(`${localBaseUrl}/global-agent`, {
      auth: {
        token: userToken,
        role: 'hermes-studio',
        instanceId: this.options.instanceId || this.options.deviceCode || undefined,
      },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30_000,
      timeout: 30_000,
    })
    this.localAgentSocket = socket
    socket.on('connect', () => {
      logger.info({
        relayUrl: this.redactedRelayUrl(),
        localBaseUrl,
        instanceId: this.options.instanceId || this.options.deviceCode || undefined,
      }, '[outbound-relay:mcu-sio] local global-agent bridge connected')
      if (this.mcuWebhookSubscription) socket.emit('mcu.events.subscribe', this.mcuWebhookSubscription)
    })
    socket.on('connect_error', (err: Error) => {
      logger.warn({ err, localBaseUrl }, '[outbound-relay:mcu-sio] local global-agent bridge connection failed')
    })
    socket.on('disconnect', (reason: string) => {
      logger.info({ reason, localBaseUrl }, '[outbound-relay:mcu-sio] local global-agent bridge disconnected')
    })
    socket.onAny((eventName: string, payload: unknown) => {
      if (SOCKET_IO_RESERVED_EVENTS.has(eventName)) return
      if (['mcu.webhook.event', 'mcu.events.subscribed', 'mcu.events.unsubscribed'].includes(eventName) && isRecord(payload)) {
        if (this.localAgentSocket !== socket || eventName === 'mcu.webhook.event' && !this.mcuWebhookSubscription) return
        this.sendJson(payload)
        return
      }
      this.localMcuForwardQueue = this.localMcuForwardQueue
        .then(() => this.forwardLocalMcuEventToRelay(eventName, payload))
        .catch((err) => {
          logger.warn({
            err,
            relayUrl: this.redactedRelayUrl(),
            eventName,
          }, '[outbound-relay:mcu-sio] failed to forward local MCU event to relay')
        })
    })
  }

  private emitLocalMcuEvent(eventName: string, payload: Record<string, unknown>): void {
    this.connectLocalAgentSocket()
    this.localAgentSocket?.emit(eventName, this.payloadForLocalMcuSocket(payload))
  }

  private payloadForLocalMcuSocket(payload: Record<string, unknown>): Record<string, unknown> {
    const userToken = this.options.userToken || ''
    if (!this.remoteMcuUserToken || !userToken) return payload
    const next: Record<string, unknown> = { ...payload, apiToken: userToken }
    delete next.api_token
    delete next.authorization
    return next
  }

  private rememberRemoteMcuLoginToken(body: string): void {
    let token = ''
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>
      token = typeof parsed.token === 'string' ? parsed.token.trim() : ''
    } catch {
      return
    }
    if (!token || token === this.remoteMcuUserToken) return
    if (this.mcuWebhookSubscription) {
      this.mcuWebhookSubscription = null
      // Close the old recipient's channel, including events already in flight.
      this.localAgentSocket?.disconnect()
      this.localAgentSocket = null
    }
    this.remoteMcuUserToken = token
  }

  private async forwardLocalMcuEventToRelay(eventName: string, payload: unknown): Promise<void> {
    if (this.stopped) return
    const body = isRecord(payload)
      ? { ...payload, type: typeof payload.type === 'string' && payload.type ? payload.type : eventName }
      : { type: eventName, payload }
    const out = await this.prepareMcuRelayPayload(body)
    this.sendJson(out)
  }

  private async prepareMcuRelayPayload(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (payload.type !== 'audio.enqueue') return payload
    const url = typeof payload.url === 'string' ? payload.url.trim() : ''
    if (!url) return payload
    const remoteUrl = await this.uploadMcuAudioUrlToRelay(url).catch((err) => {
      logger.warn({
        err,
        relayUrl: this.redactedRelayUrl(),
        url,
        interactionId: typeof payload.interactionId === 'string' ? payload.interactionId : undefined,
        segmentId: typeof payload.segmentId === 'string' ? payload.segmentId : undefined,
      }, '[outbound-relay:mcu-sio] failed to upload local MCU audio URL to relay')
      return ''
    })
    return remoteUrl ? { ...payload, url: remoteUrl } : payload
  }

  private sendJson(payload: Record<string, unknown>): void {
    if (!this.socket?.connected || this.stopped) return
    const type = typeof payload.type === 'string' && payload.type.trim() ? payload.type.trim() : 'mcu.event'
    if (type === 'mcu.webhook.event') this.socket.volatile.emit(type, payload)
    else this.socket.emit(type, payload)
  }

  private rejectAudioWaiters(error: Error): void {
    for (const [segmentId, waiter] of this.audioWaiters.entries()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
      this.audioWaiters.delete(segmentId)
    }
  }

  private remoteMcuApiToken(event: Record<string, unknown>): string {
    const raw = typeof event.apiToken === 'string'
      ? event.apiToken
      : typeof event.api_token === 'string'
        ? event.api_token
        : typeof event.authorization === 'string'
          ? event.authorization
          : ''
    const trimmed = raw.trim()
    return trimmed.toLowerCase().startsWith('bearer ') ? trimmed.slice(7).trim() : trimmed
  }

  private authorizeRemoteMcuEvent(event: Record<string, unknown>): boolean {
    const expectedToken = this.remoteMcuUserToken || this.options.userToken || ''
    const providedToken = this.remoteMcuApiToken(event)
    if (!expectedToken || !providedToken || providedToken !== expectedToken) {
      logger.warn({
        relayUrl: this.redactedRelayUrl(),
        type: typeof event.type === 'string' ? event.type : undefined,
        interactionId: typeof event.interactionId === 'string' ? event.interactionId : undefined,
      }, '[outbound-relay:mcu-sio] rejected remote MCU event with invalid API token')
      void this.sendTokenInvalidPrompt(event)
      return false
    }
    return true
  }

  private async sendTokenInvalidPrompt(event: Record<string, unknown>): Promise<void> {
    let url = mcuPromptUrl('token-invalid')
    try {
      const relayUrl = await this.uploadMcuAudioUrlToRelay(url)
      if (relayUrl) url = relayUrl
    } catch (err) {
      logger.warn({ err, relayUrl: this.redactedRelayUrl() }, '[outbound-relay:mcu-sio] failed to upload token invalid prompt')
    }
    this.sendJson({
      type: 'auth.invalid',
      event: typeof event.type === 'string' ? event.type : undefined,
      interactionId: typeof event.interactionId === 'string' ? event.interactionId : undefined,
      text: mcuPromptText('token-invalid'),
      url,
      mimeType: 'audio/x-pcm',
      channels: 1,
      sampleRate: MCU_TTS_SAMPLE_RATE,
    })
  }

  private handleRemoteEvent(eventName: string, payload: unknown): void {
    const event: Record<string, unknown> = isRecord(payload)
      ? { ...payload, type: typeof payload.type === 'string' && payload.type ? payload.type : eventName }
      : { type: eventName, payload }
    logger.info({
      relayUrl: this.redactedRelayUrl(),
      type: typeof event.type === 'string' ? event.type : undefined,
      status: typeof event.status === 'string' ? event.status : undefined,
      text: typeof event.text === 'string' ? event.text.slice(0, 300) : undefined,
      interactionId: typeof event.interactionId === 'string' ? event.interactionId : undefined,
    }, '[outbound-relay:mcu-sio] event')
    if (event.type === 'mcu.auth.ok') {
      const audioUpload = isRecord(event.audioUpload) ? event.audioUpload : null
      const token = typeof audioUpload?.token === 'string' ? audioUpload.token.trim() : ''
      if (token) {
        this.audioUploadToken = token
        this.audioUploadPath = typeof audioUpload?.url === 'string' && audioUpload.url.trim()
          ? audioUpload.url.trim()
          : '/global-agent/audio'
      }
      return
    }
    if (event.type === 'relay.replaced') {
      this.mcuWebhookSubscription = null
      this.reconnectBlockedReason = 'replaced'
      this.stopped = true
      logger.warn({
        relayUrl: this.redactedRelayUrl(),
        deviceCode: typeof event.deviceCode === 'string' ? event.deviceCode : undefined,
        role: typeof event.role === 'string' ? event.role : undefined,
      }, '[outbound-relay:mcu-sio] remote relay connection replaced; relay left connected but inactive')
      this.localAgentSocket?.disconnect()
      this.localAgentSocket = null
      this.cancelPendingInterrupts()
      this.rejectAudioWaiters(new Error('remote relay connection replaced'))
      return
    }
    if (!this.authorizeRemoteMcuEvent(event)) return
    if (event.type === 'mcu.events.subscribe') {
      this.mcuWebhookSubscription = { ...event }
      this.connectLocalAgentSocket()
      if (this.localAgentSocket?.connected) this.localAgentSocket.emit('mcu.events.subscribe', event)
      return
    }
    if (event.type === 'mcu.events.unsubscribe') {
      this.mcuWebhookSubscription = null
      this.connectLocalAgentSocket()
      this.localAgentSocket?.emit('mcu.events.unsubscribe', event)
      return
    }
    if (event.type === 'voice.recorded') {
      this.pendingVoice = {
        interactionId: typeof event.interactionId === 'string' && event.interactionId.trim() ? event.interactionId.trim() : `mcu-voice-${Date.now()}`,
        mimeType: typeof event.mimeType === 'string' && event.mimeType.trim() ? event.mimeType.trim() : 'audio/wav',
        bytes: Number.isFinite(Number(event.bytes)) ? Number(event.bytes) : 0,
        profile: typeof event.profile === 'string' && event.profile.trim() ? event.profile.trim() : 'default',
        agentRuntime: normalizeMcuAgentRuntime(event.agentRuntime),
      }
      return
    }
    if (event.type === 'voice.stream.start') {
      this.pendingVoice = null
      this.pendingVoiceStream = {
        interactionId: typeof event.interactionId === 'string' && event.interactionId.trim() ? event.interactionId.trim() : `mcu-voice-${Date.now()}`,
        mimeType: typeof event.mimeType === 'string' && event.mimeType.trim() ? event.mimeType.trim() : 'audio/pcm',
        bytes: 0,
        profile: typeof event.profile === 'string' && event.profile.trim() ? event.profile.trim() : 'default',
        agentRuntime: normalizeMcuAgentRuntime(event.agentRuntime),
        sampleRate: Number.isFinite(Number(event.sampleRate)) ? Number(event.sampleRate) : MCU_TTS_SAMPLE_RATE,
        channels: Number(event.channels) === 1 ? 1 : 2,
        bitsPerSample: Number(event.bitsPerSample) === 16 ? 16 : 16,
        chunks: [],
      }
      this.emitLocalMcuEvent('voice.stream.start', event)
      return
    }
    if (event.type === 'voice.stream.chunk') {
      const data = event.data
      let audio: Buffer
      if (typeof data === 'string') {
        audio = Buffer.from(data, 'base64')
      } else if (Buffer.isBuffer(data)) {
        audio = Buffer.from(data)
      } else if (data instanceof Uint8Array) {
        audio = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
      } else if (data instanceof ArrayBuffer) {
        audio = Buffer.from(data)
      } else {
        return
      }
      if (!audio.length) return
      if (this.pendingVoiceStream) {
        const chunkInteractionId = typeof event.interactionId === 'string' ? event.interactionId.trim() : ''
        if (chunkInteractionId && chunkInteractionId !== this.pendingVoiceStream.interactionId) {
          logger.warn({
            relayUrl: this.redactedRelayUrl(),
            streamInteractionId: this.pendingVoiceStream.interactionId,
            chunkInteractionId,
          }, '[outbound-relay:mcu-sio] ignoring stale voice stream chunk')
          return
        }
        const eventOffset = Number(event.offset)
        const offset = Number.isFinite(eventOffset) && eventOffset >= 0
          ? Math.floor(eventOffset)
          : this.pendingVoiceStream.bytes
        this.pendingVoiceStream.chunks.push(audio)
        this.pendingVoiceStream.bytes += audio.length
        this.emitLocalMcuEvent('voice.stream.chunk', {
          ...event,
          interactionId: this.pendingVoiceStream.interactionId,
          offset,
          bytes: audio.length,
          seq: Number.isFinite(Number(event.seq)) ? Math.floor(Number(event.seq)) : undefined,
          crc32: Number.isFinite(Number(event.crc32)) ? Math.floor(Number(event.crc32)) >>> 0 : undefined,
          data: audio,
        })
        return
      }
      logger.info({
        relayUrl: this.redactedRelayUrl(),
        bytes: audio.length,
        interactionId: this.pendingVoice?.interactionId,
      }, '[outbound-relay:mcu-sio] voice chunk received without stream metadata')
      void this.handleVoiceAudio(audio)
      return
    }
    if (event.type === 'voice.stream.end') {
      const stream = this.pendingVoiceStream
      if (!stream) {
        this.sendJson({ type: 'interaction.status', status: 'failed', text: 'missing voice stream metadata' })
        return
      }
      const endInteractionId = typeof event.interactionId === 'string' ? event.interactionId.trim() : ''
      if (endInteractionId && endInteractionId !== stream.interactionId) {
        logger.warn({
          relayUrl: this.redactedRelayUrl(),
          streamInteractionId: stream.interactionId,
          endInteractionId,
        }, '[outbound-relay:mcu-sio] ignoring stale voice stream end')
        return
      }
      this.pendingVoiceStream = null
      logger.info({
        relayUrl: this.redactedRelayUrl(),
        bytes: stream.bytes,
        interactionId: stream.interactionId,
      }, '[outbound-relay:mcu-sio] voice stream completed')
      this.emitLocalMcuEvent('voice.stream.end', event)
      return
    }
    if (event.type === 'voice.stream.abort') {
      this.pendingVoiceStream = null
      this.emitLocalMcuEvent('voice.stream.abort', event)
      return
    }
    if (event.type === 'audio.done' || event.type === 'audio.interrupted' || event.type === 'audio.dropped') {
      this.emitLocalMcuEvent(event.type, event)
      if (event.type === 'audio.interrupted' && typeof event.interactionId === 'string') {
        this.abortActiveRun(event.interactionId)
      }
      const segmentId = typeof event.segmentId === 'string' ? event.segmentId : ''
      if (!segmentId) return
      const waiter = this.audioWaiters.get(segmentId)
      if (!waiter) return
      clearTimeout(waiter.timer)
      this.audioWaiters.delete(segmentId)
      if (event.type === 'audio.done') {
        waiter.resolve()
      } else {
        waiter.reject(new Error(event.type))
      }
      return
    }
    if (event.type === 'mcu.interrupt') {
      this.emitLocalMcuEvent('mcu.interrupt', event)
      return
    }
    if (event.type === 'mcu.session.clear') {
      this.emitLocalMcuEvent('mcu.session.clear', event)
      return
    }
    if (typeof event.type === 'string' && event.type.trim()) {
      this.emitLocalMcuEvent(event.type.trim(), event)
    }
  }

  private wrapPcmAsWav(pcm: Buffer, sampleRate: number, channels: number, bitsPerSample: number): Buffer {
    const header = Buffer.alloc(44)
    const byteRate = sampleRate * channels * bitsPerSample / 8
    const blockAlign = channels * bitsPerSample / 8
    header.write('RIFF', 0, 'ascii')
    header.writeUInt32LE(36 + pcm.length, 4)
    header.write('WAVE', 8, 'ascii')
    header.write('fmt ', 12, 'ascii')
    header.writeUInt32LE(16, 16)
    header.writeUInt16LE(1, 20)
    header.writeUInt16LE(channels, 22)
    header.writeUInt32LE(sampleRate, 24)
    header.writeUInt32LE(byteRate, 28)
    header.writeUInt16LE(blockAlign, 32)
    header.writeUInt16LE(bitsPerSample, 34)
    header.write('data', 36, 'ascii')
    header.writeUInt32LE(pcm.length, 40)
    return Buffer.concat([header, pcm], 44 + pcm.length)
  }

  private async handleVoiceAudio(audio: Buffer, voiceOverride?: McuVoiceMeta): Promise<void> {
    const voice = voiceOverride || this.pendingVoice
    if (!voiceOverride) this.pendingVoice = null
    if (!voice) {
      this.sendJson({ type: 'interaction.status', status: 'failed', text: 'missing voice metadata' })
      return
    }
    if (!this.options.userToken) {
      this.sendJson({
        type: 'interaction.status',
        interactionId: voice.interactionId,
        status: 'failed',
        text: 'missing Web UI auth token',
      })
      return
    }

    this.sendJson({ type: 'interaction.status', interactionId: voice.interactionId, status: 'transcribing' })
    try {
      const response = await this.options.fetchImpl(`${this.options.localBaseUrl.replace(/\/$/, '')}/api/studio/mcu/voice-turn`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.userToken}`,
          'Content-Type': voice.mimeType,
          'X-Hermes-Mcu-Interaction-Id': voice.interactionId,
          'X-Hermes-Mcu-Agent-Runtime': voice.agentRuntime,
          'X-Hermes-Profile': voice.profile,
        },
        body: new Uint8Array(audio),
      })
      const text = await response.text()
      let payload: Record<string, unknown> = {}
      try {
        payload = text ? JSON.parse(text) as Record<string, unknown> : {}
      } catch {
        payload = { error: text }
      }
      if (!response.ok || payload.ok === false) {
        if (payload.ok === false && await this.enqueuePromptAudioFromVoiceTurn(voice.interactionId, payload)) {
          return
        }
        this.sendJson({
          type: 'interaction.status',
          interactionId: voice.interactionId,
          status: 'failed',
          text: typeof payload.error === 'string' ? payload.error : `voice turn failed: ${response.status}`,
        })
        return
      }
      if (payload.accepted === true) return
      const transcript = typeof payload.transcript === 'string' ? payload.transcript : ''
      if (!transcript.trim()) {
        this.sendJson({
          type: 'interaction.status',
          interactionId: voice.interactionId,
          status: 'completed',
          text: '',
        })
        return
      }
      this.sendJson({ type: 'interaction.status', interactionId: voice.interactionId, status: 'thinking', text: transcript })
      await this.runChatFromTranscript(voice, transcript)
    } catch (err) {
      this.sendJson({
        type: 'interaction.status',
        interactionId: voice.interactionId,
        status: 'failed',
        text: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private async runChatFromTranscript(
    voice: { interactionId: string; profile: string; agentRuntime: McuAgentRuntime },
    transcript: string,
  ): Promise<void> {
    await new Promise<void>((resolve) => {
      const sessionId = this.mcuSessionId(voice.profile, voice.agentRuntime)
      const primaryQueueId = `mcu_${randomUUID()}`
      this.interruptedInteractions.delete(voice.interactionId)
      const socket: Socket = io(`${this.options.localBaseUrl.replace(/\/$/, '')}/chat-run`, {
        auth: this.options.userToken ? { token: this.options.userToken } : {},
        query: { profile: voice.profile },
        transports: ['websocket', 'polling'],
        reconnection: false,
        timeout: 30_000,
      })
      let output = ''
      let segmentIndex = 0
      let ttsQueue = Promise.resolve()
      const playbackQueue: Promise<void>[] = []
      let previousPlaybackDone = Promise.resolve()
      let settled = false
      let primaryFinished = false
      let primaryResolved = false
      let primaryTerminalReceived = false
      let currentRunPrimary = false
      let currentRunAutonomous = false
      let currentDelegationId: string | undefined
      let backgroundOutput = ''
      let backgroundPending = 0
      const speechSegmenter = createMcuSpeechSegmenter()
      const ownsBackgroundEvents = () => {
        const listener = this.backgroundListeners.get(sessionId)
        return primaryTerminalReceived || listener?.socket === socket
      }
      const enqueueSpeech = (text: string) => {
        if (this.interruptedInteractions.has(voice.interactionId)) return
        const segmentText = normalizeMcuSpeechText(text)
        if (!segmentText) return
        const segmentId = `${voice.interactionId}-tts-${++segmentIndex}`
        this.sendJson({
          type: 'interaction.status',
          interactionId: voice.interactionId,
          status: 'speaking',
          text: segmentText,
        })
        const controller = this.registerTtsAbortController(voice.interactionId)
        const audioResult: Promise<McuSpeechSynthesisResult> = this.synthesizeMcuSpeech(
          segmentText,
          voice.profile,
          controller.signal,
        )
          .then(audio => ({ ok: true as const, audio }))
          .catch(err => ({ ok: false as const, err, aborted: controller.signal.aborted }))
          .finally(() => {
            this.releaseTtsAbortController(voice.interactionId, controller)
          })
        ttsQueue = ttsQueue.then(async () => {
          await previousPlaybackDone
          const audio = await this.enqueueMcuSpeechSegment(voice.interactionId, segmentId, segmentText, audioResult)
          previousPlaybackDone = audio.playbackDone
          playbackQueue.push(audio.playbackDone)
        })
          .catch((err) => {
            if (err instanceof Error && err.message === 'audio.interrupted') {
              this.interruptedInteractions.add(voice.interactionId)
              logger.info({
                interactionId: voice.interactionId,
                segmentId,
              }, '[outbound-relay:ws] MCU speech interrupted by user')
              return
            }
            logger.warn({
              err,
              interactionId: voice.interactionId,
              segmentId,
            }, '[outbound-relay:ws] failed to enqueue MCU speech')
            this.sendJson({
              type: 'interaction.status',
              interactionId: voice.interactionId,
              status: 'failed',
              text: err instanceof Error ? err.message : String(err),
            })
            this.sendJson({
              type: 'audio.enqueue',
              interactionId: voice.interactionId,
              segmentId: `${segmentId}-failed-prompt`,
              text: mcuPromptText('tts-failed'),
              url: mcuPromptUrl('tts-failed'),
              mimeType: 'audio/x-pcm',
              format: 's16le',
              channels: 1,
              sampleRate: MCU_TTS_SAMPLE_RATE,
            })
          })
      }
      const flushCompletedAssistantMessage = () => {
        const text = speechSegmenter.flush()
        if (text) enqueueSpeech(text)
      }
      const resolvePrimary = () => {
        if (primaryResolved) return
        primaryResolved = true
        resolve()
      }
      const releasePrimaryRun = () => {
        if (primaryFinished) return
        primaryFinished = true
        this.activeRuns.delete(voice.interactionId)
        const sessionRun = this.sessionRuns.get(sessionId)
        if (sessionRun?.socket === socket) this.sessionRuns.delete(sessionId)
        this.interruptedInteractions.delete(voice.interactionId)
        clearTimeout(timer)
        resolvePrimary()
        void this.flushBackgroundSpeech(sessionId)
      }
      const finish = () => {
        if (settled) return
        settled = true
        releasePrimaryRun()
        const listener = this.backgroundListeners.get(sessionId)
        if (listener?.socket === socket) this.backgroundListeners.delete(sessionId)
        socket.removeAllListeners()
        socket.disconnect()
      }
      const keepBackgroundListener = () => {
        if (settled) return
        releasePrimaryRun()
        const existing = this.backgroundListeners.get(sessionId)
        if (existing && existing.socket !== socket) existing.close()
        this.backgroundListeners.set(sessionId, { socket, close: finish })
        logger.info({
          interactionId: voice.interactionId,
          sessionId,
          backgroundPending,
        }, '[outbound-relay:ws] keeping MCU session listener for background delivery')
      }
      const finishPrimaryRun = () => {
        if (backgroundPending > 0) keepBackgroundListener()
        else finish()
      }
      const fail = (message: string) => {
        this.sendJson({
          type: 'interaction.status',
          interactionId: voice.interactionId,
          status: 'failed',
          text: message,
        })
        finish()
      }
      const timer = setTimeout(() => {
        fail('chat-run timed out')
      }, 300_000)

      socket.on('connect_error', (err: Error) => {
        fail(err.message || 'chat-run connection failed')
      })
      socket.on('disconnect', (reason: string) => {
        if (settled) return
        if (primaryFinished) {
          logger.warn({ sessionId, reason }, '[outbound-relay:ws] MCU background session listener disconnected')
          finish()
          return
        }
        fail(`chat-run disconnected: ${reason}`)
      })
      socket.on('connect', () => {
        logger.info({
          interactionId: voice.interactionId,
          sessionId,
          profile: voice.profile,
          transcriptLength: transcript.length,
        }, '[outbound-relay:ws] starting chat-run')
        this.activeRuns.set(voice.interactionId, { socket, sessionId })
        this.sessionRuns.set(sessionId, { interactionId: voice.interactionId, socket })
        const runPayload = {
          input: transcript,
          session_id: sessionId,
          queue_id: primaryQueueId,
          profile: voice.profile,
          ...mcuChatRunFields(voice.agentRuntime),
        }
        const interruptedAt = this.recentlyInterruptedSessions.get(sessionId) || 0
        if (Date.now() - interruptedAt < 10_000) {
          socket.emit('abort', { session_id: sessionId })
          setTimeout(() => socket.emit('run', runPayload), 800)
          this.recentlyInterruptedSessions.delete(sessionId)
          return
        }
        socket.emit('run', runPayload)
      })
      socket.on('run.started', (event: Record<string, unknown> = {}) => {
        const queueId = typeof event.queue_id === 'string' ? event.queue_id : undefined
        const autonomous = event.autonomous === true
        currentRunPrimary = !autonomous && queueId === primaryQueueId
        currentRunAutonomous = autonomous && ownsBackgroundEvents()
        currentDelegationId = currentRunAutonomous && typeof event.delegation_id === 'string' && event.delegation_id.trim()
          ? event.delegation_id.trim()
          : undefined
        backgroundOutput = ''
        if (!currentRunPrimary) return
        this.sendJson({ type: 'interaction.status', interactionId: voice.interactionId, status: 'thinking' })
      })
      socket.on('run.queued', (event: Record<string, unknown> = {}) => {
        const queuedMessages = Array.isArray(event.queued_messages) ? event.queued_messages : []
        const ownsQueueEvent = event.dequeued_queue_id === primaryQueueId || queuedMessages.some((message) => (
          typeof message === 'object' && message !== null && (message as Record<string, unknown>).id === primaryQueueId
        ))
        if (!ownsQueueEvent) return
        currentRunPrimary = false
        this.sendJson({ type: 'interaction.status', interactionId: voice.interactionId, status: 'thinking' })
      })
      socket.on('tool.started', (event: Record<string, unknown> = {}) => {
        if (!currentRunPrimary) return
        flushCompletedAssistantMessage()
        output = ''
        const tool = typeof event.tool === 'string' ? event.tool : typeof event.name === 'string' ? event.name : 'tool'
        this.sendJson({ type: 'tool.started', interactionId: voice.interactionId, tool })
      })
      const handleToolFinished = (event: Record<string, unknown> = {}, failed = false) => {
        if (!currentRunPrimary) return
        const tool = typeof event.tool === 'string' ? event.tool : typeof event.name === 'string' ? event.name : 'tool'
        const error = failed ? 'tool.failed' : undefined
        this.sendJson({ type: 'tool.completed', interactionId: voice.interactionId, tool, error })
      }
      socket.on('tool.completed', (event: Record<string, unknown> = {}) => handleToolFinished(event))
      socket.on('tool.failed', (event: Record<string, unknown> = {}) => handleToolFinished(event, true))
      socket.on('message.delta', (event: Record<string, unknown> = {}) => {
        if (typeof event.delta === 'string') {
          if (currentRunAutonomous) {
            backgroundOutput += event.delta
            return
          }
          if (!currentRunPrimary) return
          output += event.delta
          for (const segment of speechSegmenter.pushDelta(event.delta)) {
            enqueueSpeech(segment)
          }
        }
      })
      socket.on('run.completed', (event: Record<string, unknown> = {}) => {
        backgroundPending = Math.max(0, Number(event.background_pending) || 0)
        const autonomous = event.autonomous === true || currentRunAutonomous
        if (autonomous) {
          const text = typeof event.output === 'string' && event.output.trim()
            ? event.output
            : backgroundOutput
          if (ownsBackgroundEvents() && text.trim()) {
            this.queueBackgroundSpeech(sessionId, {
              profile: voice.profile,
              delegationId: typeof event.delegation_id === 'string' && event.delegation_id.trim()
                ? event.delegation_id.trim()
                : currentDelegationId,
              text,
            })
          }
          currentRunAutonomous = false
          currentRunPrimary = false
          currentDelegationId = undefined
          backgroundOutput = ''
          if (primaryFinished && backgroundPending === 0) finish()
          return
        }
        const queueId = typeof event.queue_id === 'string' ? event.queue_id : undefined
        const isPrimary = currentRunPrimary || queueId === primaryQueueId
        if (!isPrimary || primaryTerminalReceived) {
          if (primaryFinished && backgroundPending === 0) finish()
          return
        }
        primaryTerminalReceived = true
        currentRunPrimary = false
        if (typeof event.output === 'string' && event.output.trim()) {
          if (!output) {
            output = event.output
            for (const segment of speechSegmenter.pushDelta(event.output)) {
              enqueueSpeech(segment)
            }
          } else if (event.output.startsWith(output) && event.output.length > output.length) {
            const tail = event.output.slice(output.length)
            output = event.output
            for (const segment of speechSegmenter.pushDelta(tail)) {
              enqueueSpeech(segment)
            }
          }
        }
        flushCompletedAssistantMessage()
        ttsQueue
          .then(async () => {
            await Promise.all(playbackQueue)
            if (this.interruptedInteractions.has(voice.interactionId)) {
              finish()
              return
            }
            this.sendJson({
              type: 'interaction.status',
              interactionId: voice.interactionId,
              status: 'completed',
            })
            finishPrimaryRun()
          })
          .catch((err) => {
            if (this.interruptedInteractions.has(voice.interactionId) || (err instanceof Error && err.message === 'audio.interrupted')) {
              finish()
              return
            }
            fail(err instanceof Error ? err.message : String(err))
          })
      })
      socket.on('run.failed', (event: Record<string, unknown> = {}) => {
        backgroundPending = Math.max(0, Number(event.background_pending) || 0)
        const autonomous = event.autonomous === true || currentRunAutonomous
        const queueId = typeof event.queue_id === 'string' ? event.queue_id : undefined
        const isPrimary = currentRunPrimary || queueId === primaryQueueId
        currentRunAutonomous = false
        currentRunPrimary = false
        currentDelegationId = undefined
        backgroundOutput = ''
        if (autonomous || !isPrimary || primaryTerminalReceived) {
          if (primaryFinished && backgroundPending === 0) finish()
          return
        }
        primaryTerminalReceived = true
        this.sendJson({
          type: 'interaction.status',
          interactionId: voice.interactionId,
          status: 'failed',
          text: typeof event.error === 'string' ? event.error : 'chat-run failed',
        })
        finishPrimaryRun()
      })
      socket.on('delegation.updated', (event: Record<string, unknown> = {}) => {
        if (event.background_pending == null) return
        backgroundPending = Math.max(0, Number(event.background_pending) || 0)
        if (primaryFinished && backgroundPending === 0) finish()
      })
      socket.on('approval.requested', (event: Record<string, unknown> = {}) => {
        if (!currentRunPrimary && !currentRunAutonomous) return
        const approvalId = typeof event.approval_id === 'string' ? event.approval_id : ''
        const choice = chooseMcuApprovalChoice(event)
        if (!approvalId || !choice) {
          fail('approval required')
          return
        }
        logger.info({
          interactionId: voice.interactionId,
          sessionId,
          approvalId,
          choice,
        }, '[outbound-relay:ws] auto-approving MCU chat-run approval')
        if (!currentRunAutonomous) {
          this.sendJson({
            type: 'tool.started',
            interactionId: voice.interactionId,
            tool: 'approval',
          })
        }
        socket.emit('approval.respond', {
          session_id: sessionId,
          approval_id: approvalId,
          choice,
        })
      })
      socket.on('approval.resolved', (event: Record<string, unknown> = {}) => {
        if (!currentRunPrimary) return
        const resolved = event.resolved !== false
        this.sendJson({
          type: 'tool.completed',
          interactionId: voice.interactionId,
          tool: 'approval',
          error: resolved ? undefined : 'approval failed',
        })
      })
      socket.on('clarify.requested', () => {
        if (!currentRunPrimary) return
        fail('clarification required')
      })
    })
  }

  private queueBackgroundSpeech(sessionId: string, item: PendingRelayMcuBackgroundSpeech): void {
    const text = item.text.trim()
    if (!text) return
    const queue = this.pendingBackgroundSpeech.get(sessionId) || []
    if (item.delegationId && queue.some(queued => queued.delegationId === item.delegationId)) return
    queue.push({ ...item, text })
    this.pendingBackgroundSpeech.set(sessionId, queue)
    void this.flushBackgroundSpeech(sessionId)
  }

  private async flushBackgroundSpeech(sessionId: string): Promise<void> {
    if (
      this.stopped
      || !this.socket?.connected
      || this.backgroundSpeechRuns.has(sessionId)
      || this.sessionRuns.has(sessionId)
    ) return
    const queue = this.pendingBackgroundSpeech.get(sessionId)
    if (!queue?.length) return

    this.backgroundSpeechRuns.add(sessionId)
    try {
      while (queue.length > 0 && !this.sessionRuns.has(sessionId) && this.socket?.connected) {
        const item = queue.shift()
        if (!item) break
        await this.playBackgroundSpeech(item)
      }
    } catch (err) {
      if (!(err instanceof Error && err.message === 'audio.interrupted')) {
        logger.warn({ err, sessionId }, '[outbound-relay:ws] failed to deliver MCU background speech')
      }
    } finally {
      this.backgroundSpeechRuns.delete(sessionId)
      if (queue.length === 0) this.pendingBackgroundSpeech.delete(sessionId)
    }
  }

  private async playBackgroundSpeech(item: PendingRelayMcuBackgroundSpeech): Promise<void> {
    const suffix = (item.delegationId || randomUUID())
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 96) || randomUUID()
    const interactionId = `mcu-background-${suffix}`
    const segmenter = createMcuSpeechSegmenter()
    const segments = segmenter.pushDelta(item.text)
    const tail = segmenter.flush()
    if (tail) segments.push(tail)

    let segmentIndex = 0
    try {
      for (const rawText of segments) {
        const text = normalizeMcuSpeechText(rawText)
        if (!text) continue
        const segmentId = `${interactionId}-tts-${++segmentIndex}`
        const controller = this.registerTtsAbortController(interactionId)
        const audioResult: Promise<McuSpeechSynthesisResult> = this.synthesizeMcuSpeech(
          text,
          item.profile,
          controller.signal,
        )
          .then(audio => ({ ok: true as const, audio }))
          .catch(err => ({ ok: false as const, err, aborted: controller.signal.aborted }))
          .finally(() => this.releaseTtsAbortController(interactionId, controller))
        const audio = await this.enqueueMcuSpeechSegment(interactionId, segmentId, text, audioResult)
        await audio.playbackDone
        if (this.interruptedInteractions.has(interactionId)) throw new Error('audio.interrupted')
      }

      if (segmentIndex > 0) {
        this.sendJson({ type: 'interaction.status', interactionId, status: 'completed' })
      }
    } finally {
      this.interruptedInteractions.delete(interactionId)
    }
  }

  private async enqueuePromptAudioFromVoiceTurn(interactionId: string, payload: Record<string, unknown>): Promise<boolean> {
    const audio = isRecord(payload.audio) ? payload.audio : payload
    const url = typeof audio.url === 'string' ? audio.url.trim() : ''
    if (!url) return false

    const text = typeof audio.text === 'string' ? audio.text : ''
    const mimeType = typeof audio.mimeType === 'string' && audio.mimeType.trim() ? audio.mimeType.trim() : 'audio/x-pcm'
    const channels = Number(audio.channels) === 1 ? 1 : 2
    const sampleRate = Number.isFinite(Number(audio.sampleRate)) && Number(audio.sampleRate) > 0
      ? Number(audio.sampleRate)
      : MCU_TTS_SAMPLE_RATE
    const durationMs = Number.isFinite(Number(audio.durationMs)) && Number(audio.durationMs) > 0
      ? Number(audio.durationMs)
      : Math.max(1200, Math.min(text.length * 180, 9000))
    const segmentId = `${interactionId}-prompt`

    this.sendJson({ type: 'interaction.status', interactionId, status: 'speaking', text })
    const waitForDone = this.waitForMcuAudioDone(segmentId, Math.max(30_000, durationMs + 20_000))
      .catch((err) => {
        logger.warn({
          err,
          interactionId,
          segmentId,
        }, '[outbound-relay:ws] MCU prompt playback did not complete')
      })
    this.sendJson({
      type: 'audio.enqueue',
      interactionId,
      segmentId,
      text,
      url,
      mimeType,
      channels,
      sampleRate,
      durationMs,
    })
    await waitForDone
    this.sendJson({ type: 'interaction.status', interactionId, status: 'completed' })
    return true
  }

  private abortActiveRun(interactionId: string): void {
    this.interruptedInteractions.add(interactionId)
    this.abortTts(interactionId)
    const active = this.activeRuns.get(interactionId)
    if (!active) return
    logger.info({ interactionId, sessionId: active.sessionId }, '[outbound-relay:ws] aborting chat-run after MCU audio interrupt')
    active.socket.emit('abort', { session_id: active.sessionId })
    this.activeRuns.delete(interactionId)
    this.sessionRuns.delete(active.sessionId)
  }

  private scheduleMcuInterrupt(profile: string, interactionId: string): void {
    const sessionId = this.mcuSessionId(profile)
    this.cancelPendingInterrupt(sessionId)
    const timer = setTimeout(() => {
      this.pendingInterrupts.delete(sessionId)
      this.interruptMcuSession(profile, interactionId)
    }, MCU_INTERRUPT_DEBOUNCE_MS)
    this.pendingInterrupts.set(sessionId, { profile, interactionId, timer })
  }

  private cancelPendingInterrupt(sessionId: string): void {
    const pending = this.pendingInterrupts.get(sessionId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pendingInterrupts.delete(sessionId)
  }

  private cancelPendingInterrupts(): void {
    for (const pending of this.pendingInterrupts.values()) {
      clearTimeout(pending.timer)
    }
    this.pendingInterrupts.clear()
  }

  private forgetMcuSessionRun(sessionId: string, interactionId?: string): void {
    this.pendingBackgroundSpeech.delete(sessionId)
    this.backgroundListeners.get(sessionId)?.close()
    const sessionRun = this.sessionRuns.get(sessionId)
    if (sessionRun) {
      this.interruptedInteractions.add(sessionRun.interactionId)
      this.abortTts(sessionRun.interactionId)
      this.activeRuns.delete(sessionRun.interactionId)
      this.sessionRuns.delete(sessionId)
    }
    if (interactionId) {
      this.interruptedInteractions.add(interactionId)
      this.abortTts(interactionId)
      const active = this.activeRuns.get(interactionId)
      if (active?.sessionId === sessionId) {
        this.activeRuns.delete(interactionId)
        this.sessionRuns.delete(sessionId)
      }
    }
  }

  private interruptMcuSession(profile: string, interactionId?: string): void {
    const sessionId = this.mcuSessionId(profile)
    const sessionRun = this.sessionRuns.get(sessionId)
    const active = interactionId ? this.activeRuns.get(interactionId) : undefined
    const hasActiveTts = interactionId ? this.ttsAbortControllers.has(interactionId) : false
    if (interactionId && (sessionRun || active || hasActiveTts)) {
      this.interruptedInteractions.add(interactionId)
      this.abortTts(interactionId)
    }
    if (sessionRun) {
      this.recentlyInterruptedSessions.set(sessionId, Date.now())
      this.interruptedInteractions.add(sessionRun.interactionId)
      this.abortTts(sessionRun.interactionId)
      logger.info({
        interactionId: sessionRun.interactionId,
        sessionId,
      }, '[outbound-relay:ws] aborting chat-run after MCU interrupt')
      sessionRun.socket.emit('abort', { session_id: sessionId })
      this.activeRuns.delete(sessionRun.interactionId)
      this.sessionRuns.delete(sessionId)
      return
    }
    if (interactionId && active?.sessionId === sessionId) {
      this.recentlyInterruptedSessions.set(sessionId, Date.now())
      this.abortActiveRun(interactionId)
    }
  }

  private registerTtsAbortController(interactionId: string): AbortController {
    const controller = new AbortController()
    if (this.interruptedInteractions.has(interactionId)) {
      controller.abort()
      return controller
    }
    const controllers = this.ttsAbortControllers.get(interactionId) || new Set<AbortController>()
    controllers.add(controller)
    this.ttsAbortControllers.set(interactionId, controllers)
    return controller
  }

  private releaseTtsAbortController(interactionId: string, controller: AbortController): void {
    const controllers = this.ttsAbortControllers.get(interactionId)
    if (!controllers) return
    controllers.delete(controller)
    if (controllers.size === 0) this.ttsAbortControllers.delete(interactionId)
  }

  private abortTts(interactionId: string): void {
    const controllers = this.ttsAbortControllers.get(interactionId)
    if (!controllers) return
    for (const controller of controllers) {
      if (!controller.signal.aborted) controller.abort()
    }
    this.ttsAbortControllers.delete(interactionId)
  }

  private clearMcuSession(profile: string, interactionId?: string): void {
    const sessionId = this.mcuSessionId(profile)
    this.cancelPendingInterrupt(sessionId)
    this.forgetMcuSessionRun(sessionId, interactionId)
    const cleared = getChatRunServer()?.clearSessionHistory(sessionId)
    const deleted = cleared?.deleted ?? clearSessionMessages(sessionId)
    const memoryCleared = cleared?.hadMemoryState ?? false
    logger.info({ sessionId, deleted, memoryCleared }, '[outbound-relay:ws] cleared MCU chat session')
    this.sendJson({
      type: 'mcu.session.cleared',
      interactionId: interactionId || undefined,
      profile,
      sessionId,
      deleted,
      memoryCleared,
    })
  }

  private mcuSessionId(profile: string, agentRuntime: McuAgentRuntime = DEFAULT_MCU_AGENT_RUNTIME): string {
    const instance = (this.options.instanceId || 'device')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'device'
    const profileId = (profile || 'default')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'default'
    return `mcu-${instance}-${profileId}-${agentRuntime}`
  }

  private async enqueueMcuSpeechSegment(
    interactionId: string,
    segmentId: string,
    text: string,
    audioResult: Promise<McuSpeechSynthesisResult>,
  ): Promise<EnqueuedMcuSpeechSegment> {
    if (this.interruptedInteractions.has(interactionId)) {
      return { playbackDone: Promise.resolve() }
    }
    const result = await audioResult
    if (!result.ok) {
      if (result.aborted) throw new Error('audio.interrupted')
      throw result.err
    }
    if (this.interruptedInteractions.has(interactionId)) {
      return { playbackDone: Promise.resolve() }
    }
    const waitForDone = this.waitForMcuAudioDone(segmentId, Math.max(90_000, Math.min(text.length * 1200, 300_000)))
    waitForDone.catch(() => undefined)
    this.sendJson({
      type: 'audio.enqueue',
      interactionId,
      segmentId,
      text,
      url: result.audio.url,
      mimeType: result.audio.mimeType,
      channels: 1,
      sampleRate: MCU_TTS_SAMPLE_RATE,
      durationMs: Math.max(1200, Math.min(text.length * 180, 12_000)),
      completionManagedByServer: true,
    })
    return { playbackDone: waitForDone }
  }

  private waitForMcuAudioDone(segmentId: string, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.audioWaiters.delete(segmentId)
        reject(new Error(`MCU audio playback timed out: ${segmentId}`))
      }, timeoutMs)
      this.audioWaiters.set(segmentId, { resolve, reject, timer })
    })
  }

  private async synthesizeMcuSpeech(text: string, profile: string, signal?: AbortSignal): Promise<{ url: string; mimeType: string }> {
    if (!this.options.userToken) {
      throw new Error('missing Web UI auth token')
    }

    const baseUrl = this.options.localBaseUrl.replace(/\/$/, '')
    const headers = {
      Authorization: `Bearer ${this.options.userToken}`,
      'Content-Type': 'application/json',
      'X-Hermes-Profile': profile || 'default',
    }
    const requestTts = (provider?: 'edge') => this.options.fetchImpl(`${baseUrl}/api/studio/tts/synthesize`, {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify({
        ...(provider ? { provider } : {}),
        text,
        options: MCU_TTS_OPTIONS,
      }),
    })

    const readPcmAudio = async (response: Response, context: string): Promise<Buffer> => {
      let audio: Buffer<ArrayBufferLike> = Buffer.from(await response.arrayBuffer())
      if (!audio.length) {
        throw new Error(`${context} returned empty audio`)
      }
      const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
      const sourceBytes = audio.length
      if (contentType === 'audio/x-pcm' || contentType === 'audio/pcm') {
        logger.info({ context, contentType, sourceBytes, pcmBytes: audio.length }, '[outbound-relay-client] MCU TTS PCM audio ready')
        return audio
      }

      const converted = await transcodeToPcmS16le(audio, contentType || 'application/octet-stream', {
        sampleRate: MCU_TTS_SAMPLE_RATE,
      })
      if (converted.mimeType !== 'audio/x-pcm') {
        throw new Error(`${context} returned ${contentType || 'unknown content type'} and PCM conversion is unavailable`)
      }
      audio = converted.audio
      if (!audio.length) {
        throw new Error(`${context} PCM conversion returned empty audio`)
      }
      logger.info({
        context,
        contentType: contentType || 'application/octet-stream',
        sourceBytes,
        pcmBytes: audio.length,
        sampleRate: MCU_TTS_SAMPLE_RATE,
      }, '[outbound-relay-client] MCU TTS decoded to PCM')
      return audio
    }

    let response = await requestTts()
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      logger.warn({
        status: response.status,
        detail: detail.slice(0, 200),
      }, '[outbound-relay-client] active MCU TTS failed, falling back to Edge TTS')
      response = await requestTts('edge')
      if (!response.ok) {
        const fallbackDetail = await response.text().catch(() => '')
        throw new Error(`MCU TTS failed and Edge fallback failed: ${response.status}${fallbackDetail ? ` ${fallbackDetail.slice(0, 200)}` : ''}`)
      }
    }

    let audio: Buffer
    try {
      audio = await readPcmAudio(response, 'MCU TTS')
    } catch (err) {
      logger.warn({ err }, '[outbound-relay-client] MCU TTS audio decode failed, falling back to Edge TTS')
      const fallback = await requestTts('edge')
      if (!fallback.ok) {
        const detail = await fallback.text().catch(() => '')
        throw new Error(`MCU TTS decode failed and Edge fallback failed: ${fallback.status}${detail ? ` ${detail.slice(0, 200)}` : ''}`)
      }
      audio = await readPcmAudio(fallback, 'MCU Edge TTS fallback')
    }

    const dir = join(config.appHome, 'mcu-audio')
    await mkdir(dir, { recursive: true })
    const file = `${randomUUID()}.adpcm`
    const encoded = encodeMcuImaAdpcm(audio, MCU_TTS_SAMPLE_RATE)
    await writeFile(join(dir, file), encoded)
    logger.info({
      file,
      textChars: text.length,
      pcmBytes: audio.length,
      adpcmBytes: encoded.length,
      ratio: audio.length > 0 ? Number((encoded.length / audio.length).toFixed(3)) : 0,
    }, '[outbound-relay-client] MCU TTS encoded to ADPCM')
    const localUrl = `${baseUrl}/api/studio/mcu/audio/${file}`
    const remoteUrl = await this.uploadMcuAudioToRelay(encoded, 'audio/x-ima-adpcm', signal).catch((err) => {
      logger.warn({
        err,
        relayUrl: this.redactedRelayUrl(),
        bytes: encoded.length,
      }, '[outbound-relay:ws] failed to upload MCU audio to relay')
      return ''
    })
    return { url: remoteUrl || localUrl, mimeType: 'audio/x-ima-adpcm' }
  }

  private relayHttpBaseUrl(): string {
    const url = new URL(this.options.relayUrl)
    if (url.protocol === 'ws:') url.protocol = 'http:'
    if (url.protocol === 'wss:') url.protocol = 'https:'
    url.pathname = ''
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  }

  private resolveRelayAudioUploadUrl(): string {
    const baseUrl = this.relayHttpBaseUrl()
    if (/^https?:\/\//i.test(this.audioUploadPath)) return this.audioUploadPath
    const path = this.audioUploadPath.startsWith('/') ? this.audioUploadPath : `/${this.audioUploadPath}`
    return `${baseUrl}${path}`
  }

  private async uploadMcuAudioToRelay(audio: Buffer, mimeType = 'audio/x-pcm', signal?: AbortSignal): Promise<string> {
    if (!this.audioUploadToken || !this.options.deviceCode) return ''
    const uploadUrl = this.resolveRelayAudioUploadUrl()
    const response = await this.options.fetchImpl(uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.audioUploadToken}`,
        'Content-Type': mimeType,
        'X-Device-Code': this.options.deviceCode,
        'X-Audio-Sample-Rate': String(MCU_TTS_SAMPLE_RATE),
        'X-Audio-Channels': '1',
      },
      body: new Uint8Array(audio),
      signal,
    })
    const text = await response.text()
    let payload: Record<string, unknown> = {}
    try {
      payload = text ? JSON.parse(text) as Record<string, unknown> : {}
    } catch {
      payload = { error: text }
    }
    if (!response.ok || payload.ok === false) {
      const error = typeof payload.error === 'string' ? payload.error : `relay audio upload failed: ${response.status}`
      throw new Error(error)
    }
    const url = typeof payload.url === 'string' ? payload.url.trim() : ''
    if (url) return url
    const path = typeof payload.path === 'string' ? payload.path.trim() : ''
    if (!path) throw new Error('relay audio upload did not return a URL')
    return `${this.relayHttpBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`
  }

  private resolveLocalAudioUrl(url: string): string {
    if (/^https?:\/\//i.test(url)) return url
    const path = url.startsWith('/') ? url : `/${url}`
    return `${this.options.localBaseUrl.replace(/\/$/, '')}${path}`
  }

  private async uploadMcuAudioUrlToRelay(url: string): Promise<string> {
    if (!this.audioUploadToken || !this.options.deviceCode) return ''
    const localUrl = this.resolveLocalAudioUrl(url)
    const response = await this.options.fetchImpl(localUrl, {
      method: 'GET',
      headers: this.options.userToken ? { Authorization: `Bearer ${this.options.userToken}` } : undefined,
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`local MCU audio fetch failed: ${response.status}${detail ? ` ${detail.slice(0, 120)}` : ''}`)
    }
    const audio = Buffer.from(await response.arrayBuffer())
    if (!audio.length) throw new Error('local MCU audio fetch returned empty audio')
    const mimeType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() || 'audio/x-pcm'
    return await this.uploadMcuAudioToRelay(audio, mimeType, undefined)
  }

  private redactedRelayUrl(): string {
    try {
      const url = new URL(this.options.relayUrl)
      if (url.username || url.password) {
        url.username = url.username ? '[redacted]' : ''
        url.password = url.password ? '[redacted]' : ''
      }
      return url.toString()
    } catch {
      return '[invalid relay url]'
    }
  }
}

interface NormalizedBody {
  body?: BodyInit
  contentType?: string
  byteLength: number
}

function relayError(id: string | undefined, code: string, message: string, status?: number): RelayHttpResponse {
  return {
    id,
    ...(status ? { status } : {}),
    error: { code, message },
  }
}

function socketRelayError(id: string | undefined, code: string, message: string): RelaySocketResponse {
  return {
    id,
    ok: false,
    error: { code, message },
  }
}

function isRelayHttpResponse(value: NormalizedBody | RelayHttpResponse): value is RelayHttpResponse {
  return 'error' in value
}

function normalizeMethod(method?: string): string | null {
  const normalized = String(method || 'GET').trim().toUpperCase()
  return ALLOWED_METHODS.has(normalized) ? normalized : null
}

function normalizeRelayPath(path?: string): string | null {
  const raw = String(path || '').trim()
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return null

  const parsed = new URL(raw, 'http://hermes-relay.local')
  const normalized = `${parsed.pathname}${parsed.search}`
  if (parsed.pathname === '/v1' || parsed.pathname.startsWith('/v1/')) return null
  return normalized
}

function normalizeSocketBridgeId(id?: string): string | null {
  const normalized = String(id || '').trim()
  if (!normalized || normalized.length > 128) return null
  return normalized
}

function normalizeSocketNamespace(namespace?: string): string | null {
  const normalized = String(namespace || '').trim()
  return ALLOWED_SOCKET_NAMESPACES.has(normalized) ? normalized : null
}

function normalizeSocketQuery(query?: RelaySocketOpenRequest['query']): Record<string, string> {
  const normalized: Record<string, string> = {}
  for (const [key, value] of Object.entries(query || {})) {
    if (value == null) continue
    normalized[key] = String(value)
  }
  return normalized
}

function normalizeSocketAuth(auth?: RelaySocketOpenRequest['auth']): Record<string, unknown> {
  const normalized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(auth || {})) {
    if (value == null) continue
    normalized[key] = value
  }
  return normalized
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function streamMode(value: unknown, fallback = true): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function normalizeTimeout(timeoutMs?: number): number {
  const value = Number(timeoutMs)
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_REQUEST_TIMEOUT_MS
  return Math.min(Math.floor(value), MAX_REQUEST_TIMEOUT_MS)
}

function normalizeHeaders(headers?: RelayHttpRequest['headers']): Headers {
  const normalized = new Headers()
  for (const [name, value] of Object.entries(headers || {})) {
    const lower = name.toLowerCase()
    if (!ALLOWED_REQUEST_HEADERS.has(lower) || value == null) continue
    const headerValue = Array.isArray(value) ? value.find(Boolean) : value
    if (headerValue) normalized.set(lower, String(headerValue))
  }
  return normalized
}

function normalizeRequestBody(request: RelayHttpRequest, method: string, headers: Headers): NormalizedBody | RelayHttpResponse {
  if (method === 'GET' || method === 'HEAD') {
    return { byteLength: 0 }
  }

  if (typeof request.bodyBase64 === 'string') {
    const buffer = Buffer.from(request.bodyBase64, 'base64')
    if (buffer.byteLength > MAX_REQUEST_BODY_BYTES) {
      return relayError(request.id, 'request_body_too_large', 'Relay request body exceeds the local size limit', 413)
    }
    return { body: buffer, byteLength: buffer.byteLength }
  }

  if (request.body == null) {
    return { byteLength: 0 }
  }

  if (typeof request.body === 'string') {
    const byteLength = Buffer.byteLength(request.body)
    if (byteLength > MAX_REQUEST_BODY_BYTES) {
      return relayError(request.id, 'request_body_too_large', 'Relay request body exceeds the local size limit', 413)
    }
    return { body: request.body, byteLength }
  }

  const serialized = JSON.stringify(request.body)
  const byteLength = Buffer.byteLength(serialized)
  if (byteLength > MAX_REQUEST_BODY_BYTES) {
    return relayError(request.id, 'request_body_too_large', 'Relay request body exceeds the local size limit', 413)
  }
  if (!headers.has('content-type')) {
    return { body: serialized, contentType: 'application/json', byteLength }
  }
  return { body: serialized, byteLength }
}

function responseHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    const lower = key.toLowerCase()
    if (lower === 'connection' || lower === 'transfer-encoding') return
    headers[lower] = value
  })
  return headers
}

function isTextualResponse(contentType: string): boolean {
  const lower = contentType.toLowerCase()
  return TEXTUAL_RESPONSE_TYPES.some(prefix => lower.startsWith(prefix) || lower.includes(prefix))
}

async function readResponseBody(response: Response): Promise<{ body?: string; bodyBase64?: string; truncated?: boolean }> {
  const contentType = response.headers.get('content-type') || ''
  if (!response.body) return {}

  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  let truncated = false

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = Buffer.from(value)
    total += chunk.byteLength
    if (total > MAX_RESPONSE_BODY_BYTES) {
      const remaining = Math.max(0, MAX_RESPONSE_BODY_BYTES - (total - chunk.byteLength))
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining))
      truncated = true
      await reader.cancel()
      break
    }
    chunks.push(chunk)
  }

  const buffer = Buffer.concat(chunks)
  if (isTextualResponse(contentType)) {
    return { body: buffer.toString('utf-8'), truncated }
  }
  return { bodyBase64: buffer.toString('base64'), truncated }
}

export class OutboundRelayClient {
  private socket: Socket | null = null
  private readonly socketBridges = new Map<string, LocalSocketBridge>()
  private readonly relayUrl: string
  private readonly relayToken: string
  private readonly instanceId: string
  private readonly deviceCode: string
  private readonly localBaseUrl: string
  private readonly machineInfo?: Record<string, unknown>
  private readonly fetchImpl: typeof fetch

  constructor(options: OutboundRelayClientOptions) {
    this.relayUrl = options.relayUrl
    this.relayToken = options.relayToken
    this.instanceId = options.instanceId
    this.deviceCode = options.deviceCode
    this.localBaseUrl = options.localBaseUrl.replace(/\/$/, '')
    this.machineInfo = options.machineInfo
    this.fetchImpl = options.fetchImpl
  }

  start(): void {
    if (this.socket) return
    const auth: Record<string, unknown> = {
      role: 'hermes-studio',
    }
    if (this.relayToken) auth.token = this.relayToken
    if (this.deviceCode) {
      auth.deviceCode = this.deviceCode
      auth.device_code = this.deviceCode
    }
    if (this.instanceId) auth.instanceId = this.instanceId
    if (this.machineInfo) auth.machine = this.machineInfo
    this.socket = io(this.relayUrl, {
      auth,
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30_000,
      timeout: 30_000,
    })

    this.socket.on('connect', () => {
      logger.info({ relayUrl: this.redactedRelayUrl() }, '[outbound-relay] connected')
      this.socket?.emit('relay.ready', {
        capabilities: ['http.request', 'socket.chat-run'],
        instanceId: this.instanceId || undefined,
      })
    })
    this.socket.on('connect_error', (err: Error) => {
      logger.warn({ err, relayUrl: this.redactedRelayUrl() }, '[outbound-relay] connection failed')
      if (err.message === 'device_code_not_allowed' || err.message.includes('非官方设备码')) {
        this.stop()
      }
    })
    this.socket.on('disconnect', (reason: string) => {
      logger.info({ reason, relayUrl: this.redactedRelayUrl() }, '[outbound-relay] disconnected')
    })
    this.socket.on('relay.replaced', (payload: unknown) => {
      logger.warn({ payload, relayUrl: this.redactedRelayUrl() }, '[outbound-relay] remote relay connection replaced; reconnect disabled')
      this.stop()
    })
    this.socket.on('http.request', (request: RelayHttpRequest, ack?: (response: RelayHttpResponse) => void) => {
      void this.handleHttpRequest(request)
        .then((response) => this.respond(response, ack))
        .catch((err) => this.respond(relayError(request?.id, 'relay_internal_error', err instanceof Error ? err.message : String(err), 500), ack))
    })
    this.socket.on('socket.open', (request: RelaySocketOpenRequest, ack?: (response: RelaySocketResponse) => void) => {
      this.respondSocket(this.openLocalSocket(request), ack)
    })
    this.socket.on('socket.event', (request: RelaySocketEventRequest, ack?: (response: RelaySocketResponse) => void) => {
      this.respondSocket(this.emitLocalSocketEvent(request), ack)
    })
    this.socket.on('socket.close', (request: RelaySocketCloseRequest, ack?: (response: RelaySocketResponse) => void) => {
      this.respondSocket(this.closeLocalSocket(request), ack)
    })
  }

  stop(): void {
    for (const bridge of this.socketBridges.values()) {
      bridge.socket.disconnect()
    }
    this.socketBridges.clear()
    this.socket?.disconnect()
    this.socket = null
  }

  isConnected(): boolean {
    return Boolean(this.socket?.connected)
  }

  waitForConnected(timeoutMs = 5000): Promise<boolean> {
    const socket = this.socket
    if (!socket) return Promise.resolve(false)
    if (socket.connected) return Promise.resolve(true)
    return new Promise(resolve => {
      const cleanup = () => {
        clearTimeout(timer)
        socket.off('connect', onConnect)
        socket.off('connect_error', onFailure)
      }
      const onConnect = () => {
        cleanup()
        resolve(true)
      }
      const onFailure = () => {
        cleanup()
        resolve(false)
      }
      const timer = setTimeout(() => {
        cleanup()
        resolve(false)
      }, timeoutMs)
      socket.once('connect', onConnect)
      socket.once('connect_error', onFailure)
    })
  }

  async handleHttpRequest(request: RelayHttpRequest): Promise<RelayHttpResponse> {
    const method = normalizeMethod(request.method)
    if (!method) {
      return relayError(request.id, 'method_not_allowed', 'Relay request method is not allowed', 405)
    }

    const path = normalizeRelayPath(request.path)
    if (!path) {
      return relayError(request.id, 'path_not_allowed', 'Relay request path is not allowed', 403)
    }

    const headers = normalizeHeaders(request.headers)
    const normalizedBody = normalizeRequestBody(request, method, headers)
    if (isRelayHttpResponse(normalizedBody)) return normalizedBody
    if (normalizedBody.contentType) headers.set('content-type', normalizedBody.contentType)

    const timeoutMs = normalizeTimeout(request.timeoutMs)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await this.fetchImpl(`${this.localBaseUrl}${path}`, {
        method,
        headers,
        body: normalizedBody.body,
        signal: controller.signal,
      })
      const body = await readResponseBody(response)
      return {
        id: request.id,
        status: response.status,
        headers: responseHeaders(response),
        ...body,
      }
    } catch (err) {
      const aborted = controller.signal.aborted
      return relayError(
        request.id,
        aborted ? 'request_timeout' : 'local_request_failed',
        aborted ? `Local relay request timed out after ${timeoutMs}ms` : err instanceof Error ? err.message : String(err),
        aborted ? 504 : 502,
      )
    } finally {
      clearTimeout(timeout)
    }
  }

  private respond(response: RelayHttpResponse, ack?: (response: RelayHttpResponse) => void): void {
    if (ack) {
      ack(response)
      return
    }
    this.socket?.emit('http.response', response)
  }

  private openLocalSocket(request: RelaySocketOpenRequest): RelaySocketResponse {
    const id = normalizeSocketBridgeId(request.id)
    if (!id) return socketRelayError(request.id, 'invalid_socket_id', 'Relay socket id is required')

    const namespace = normalizeSocketNamespace(request.namespace)
    if (!namespace) return socketRelayError(id, 'namespace_not_allowed', 'Relay socket namespace is not allowed')

    this.closeLocalSocket({ id })
    const localSocket = io(`${this.localBaseUrl}${namespace}`, {
      auth: normalizeSocketAuth(request.auth),
      query: normalizeSocketQuery(request.query),
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30_000,
      timeout: 30_000,
    })
    const bridge: LocalSocketBridge = {
      id,
      namespace,
      socket: localSocket,
      stream: streamMode(request.stream),
      output: '',
      reasoning: '',
    }
    this.socketBridges.set(id, bridge)

    localSocket.on('connect', () => {
      this.emitSocketEvent({ id, namespace, event: 'connect', payload: { socketId: localSocket.id } })
    })
    localSocket.on('connect_error', (err: Error) => {
      this.emitSocketEvent({ id, namespace, event: 'connect_error', payload: { message: err.message } })
    })
    localSocket.on('disconnect', (reason: string) => {
      this.emitSocketEvent({ id, namespace, event: 'disconnect', payload: { reason } })
    })
    for (const event of CHAT_RUN_SERVER_EVENTS) {
      localSocket.on(event, (payload: unknown) => {
        this.handleLocalSocketEvent(bridge, event, payload)
      })
    }

    return { id, ok: true, namespace, stream: bridge.stream }
  }

  private emitLocalSocketEvent(request: RelaySocketEventRequest): RelaySocketResponse {
    const id = normalizeSocketBridgeId(request.id)
    if (!id) return socketRelayError(request.id, 'invalid_socket_id', 'Relay socket id is required')

    const event = String(request.event || '').trim()
    if (!ALLOWED_CHAT_RUN_CLIENT_EVENTS.has(event)) {
      return socketRelayError(id, 'event_not_allowed', 'Relay socket event is not allowed')
    }

    const bridge = this.socketBridges.get(id)
    if (!bridge) return socketRelayError(id, 'socket_not_open', 'Relay socket is not open')
    if (typeof request.stream === 'boolean') {
      bridge.stream = request.stream
    }
    if (event === 'run') {
      bridge.output = ''
      bridge.reasoning = ''
    }

    bridge.socket.emit(event, request.payload)
    return { id, ok: true, namespace: bridge.namespace, event, stream: bridge.stream }
  }

  private closeLocalSocket(request: RelaySocketCloseRequest): RelaySocketResponse {
    const id = normalizeSocketBridgeId(request.id)
    if (!id) return socketRelayError(request.id, 'invalid_socket_id', 'Relay socket id is required')

    const bridge = this.socketBridges.get(id)
    if (!bridge) return { id, ok: true }
    bridge.socket.disconnect()
    this.socketBridges.delete(id)
    return { id, ok: true, namespace: bridge.namespace }
  }

  private emitSocketEvent(event: Required<Pick<RelaySocketResponse, 'id' | 'namespace' | 'event'>> & { payload?: unknown }): void {
    this.socket?.emit('socket.event', {
      id: event.id,
      namespace: event.namespace,
      event: event.event,
      payload: event.payload,
    })
  }

  private handleLocalSocketEvent(bridge: LocalSocketBridge, event: string, payload: unknown): void {
    if (!bridge.stream) {
      if (event === 'message.delta' && isRecord(payload) && typeof payload.delta === 'string') {
        bridge.output += payload.delta
        return
      }
      if ((event === 'reasoning.delta' || event === 'thinking.delta') && isRecord(payload)) {
        const delta = typeof payload.delta === 'string' ? payload.delta : typeof payload.text === 'string' ? payload.text : ''
        bridge.reasoning += delta
        return
      }
      if (NON_STREAMING_SUPPRESSED_EVENTS.has(event)) {
        return
      }
      if (event === 'run.completed') {
        this.emitSocketEvent({
          id: bridge.id,
          namespace: bridge.namespace,
          event,
          payload: this.withNonStreamingOutput(payload, bridge),
        })
        return
      }
    }

    this.emitSocketEvent({ id: bridge.id, namespace: bridge.namespace, event, payload })
  }

  private withNonStreamingOutput(payload: unknown, bridge: LocalSocketBridge): unknown {
    if (!isRecord(payload)) {
      return {
        output: bridge.output,
        ...(bridge.reasoning ? { reasoning: bridge.reasoning } : {}),
      }
    }
    return {
      ...payload,
      output: typeof payload.output === 'string' && payload.output ? payload.output : bridge.output,
      ...(bridge.reasoning && typeof payload.reasoning !== 'string' ? { reasoning: bridge.reasoning } : {}),
    }
  }

  private respondSocket(response: RelaySocketResponse, ack?: (response: RelaySocketResponse) => void): void {
    if (ack) {
      ack(response)
      return
    }
    this.socket?.emit('socket.response', response)
  }

  private redactedRelayUrl(): string {
    try {
      const url = new URL(this.relayUrl)
      url.username = ''
      url.password = ''
      return url.toString()
    } catch {
      return '<invalid-url>'
    }
  }
}

const activeClients = new Map<string, RelayClient>()

function normalizeOutboundRelayConnectionId(options: StartOutboundRelayClientOptions, relayUrl: string): string {
  return (options.connectionId || options.instanceId || relayUrl).trim()
}

export function startOutboundRelayClient(options: StartOutboundRelayClientOptions = {}): RelayClient | null {
  const relayUrl = (options.relayUrl ?? '').trim()
  if (!relayUrl) return null
  const connectionId = normalizeOutboundRelayConnectionId(options, relayUrl)
  const activeClient = activeClients.get(connectionId)
  if (activeClient) return activeClient

    const clientOptions: OutboundRelayClientOptions = {
    relayUrl,
    relayToken: options.relayToken ?? '',
    userToken: options.userToken ?? '',
    instanceId: options.instanceId ?? '',
    deviceCode: options.deviceCode ?? '',
    localBaseUrl: options.localBaseUrl ?? `http://127.0.0.1:${config.port}`,
    machineInfo: options.machineInfo,
    fetchImpl: options.fetchImpl ?? fetch,
  }
  const client = options.relayProtocol === 'mcu-socket.io'
    ? new McuSocketIoRelayClient(clientOptions)
    : new OutboundRelayClient(clientOptions)
  client.start()
  activeClients.set(connectionId, client)
  return client
}

export function getOutboundRelayClient(connectionId?: string): RelayClient | null {
  if (connectionId) return activeClients.get(connectionId) || null
  return activeClients.values().next().value || null
}

export function getOutboundRelayClients(): Map<string, RelayClient> {
  return new Map(activeClients)
}

export function stopOutboundRelayClient(connectionId?: string): void {
  if (connectionId) {
    activeClients.get(connectionId)?.stop()
    activeClients.delete(connectionId)
    return
  }
  for (const client of activeClients.values()) {
    client.stop()
  }
  activeClients.clear()
}
