import { randomBytes, randomUUID } from 'crypto'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { personNotificationRoom } from '../contracts/person-session'
import type { Server, Socket } from 'socket.io'
import { io as createClientSocket, type Socket as ClientSocket } from 'socket.io-client'
import { logger } from '../public/logging'
import { authenticateUserToken, type AuthenticatedUser } from '../public/auth'
import { userCanAccessProfile } from '../public/users'
import { config } from '../public/config'
import { getChatRunServer } from '../public/chat-run'
import { transcodeToPcmS16le } from '../services/voice/stt/audio-convert'
import { decodeMcuImaAdpcm, encodeMcuImaAdpcm } from '../services/voice/mcu/adpcm'
import { MCU_TTS_SAMPLE_RATE, mcuPromptText, mcuPromptUrl } from '../services/voice/mcu/prompts'
import { createMcuSpeechSegmenter, normalizeMcuSpeechText } from '../services/global-agent/mcu-speech-segmenter'
import { bindMcuWebhookEvents } from '../services/global-agent/mcu-webhook-events'
import {
  mcuChatRunFields,
  normalizeMcuAgentRuntime,
  type McuAgentRuntime,
} from '../services/global-agent/mcu-agent-runtime'
import type {
  RelayHttpRequest,
  RelayHttpResponse,
  RelaySocketCloseRequest,
  RelaySocketEventRequest,
  RelaySocketOpenRequest,
  RelaySocketResponse,
} from '../services/global-agent/outbound-relay-client'

const GLOBAL_AGENT_NAMESPACE = '/global-agent'
const DEFAULT_GLOBAL_AGENT_TIMEOUT_MS = 30_000
const MCU_TTS_OPTIONS = {
  mcuPlayback: true,
  sampleRate: MCU_TTS_SAMPLE_RATE,
} as const
const MCU_INTERRUPT_DEBOUNCE_MS = 280
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const MAX_REQUEST_TIMEOUT_MS = 120_000
const MAX_REQUEST_BODY_BYTES = 5 * 1024 * 1024
const MAX_RESPONSE_BODY_BYTES = 10 * 1024 * 1024
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
const MCU_FORWARD_EVENTS = [
  'mcu.ready',
  'mcu.status',
  'mcu.interrupt',
  'mcu.session.clear',
  'mcu.session.cleared',
  'voice.stream.start',
  'voice.stream.chunk',
  'voice.stream.end',
  'voice.stream.abort',
  'voice.recorded',
  'interaction.status',
  'tool.started',
  'tool.completed',
  'tool.failed',
  'audio.started',
  'audio.done',
  'audio.interrupted',
  'audio.queued',
  'audio.dropped',
  'audio.cleared',
]
const SOCKET_IO_RESERVED_EVENTS = new Set([
  'connect',
  'connect_error',
  'disconnect',
  'disconnecting',
  'newListener',
  'removeListener',
])

interface GlobalAgentRequestOptions {
  clientId?: string
  timeoutMs?: number
}

interface StartGlobalAgentServerOptions {
  localBaseUrl?: string
  fetchImpl?: typeof fetch
}

interface LocalSocketBridge {
  id: string
  ownerSocketId: string
  namespace: string
  socket: ClientSocket
  stream: boolean
  output: string
  reasoning: string
}

interface McuVoiceChatTurnOptions {
  userToken: string
  profile: string
  interactionId: string
  transcript: string
  clientId?: string
  agentRuntime?: McuAgentRuntime
}

interface McuAudioWaiter {
  resolve: () => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface EnqueuedMcuSpeechSegment {
  playbackDone: Promise<void>
}

type McuSpeechSynthesisResult =
  | { ok: true; audio: { url: string; mimeType: string } }
  | { ok: false; err: unknown; aborted: boolean }

interface McuVoiceStreamState {
  interactionId: string
  profile: string
  agentRuntime: McuAgentRuntime
  mimeType: string
  sampleRate: number
  channels: number
  bitsPerSample: number
  bytes: number
  chunks: Array<{ offset: number; chunk: Buffer; seq?: number; crc32?: number }>
  userToken: string
}

interface PendingMcuInterrupt {
  clientId: string
  profile: string
  agentRuntime: McuAgentRuntime
  interactionId: string
  timer: ReturnType<typeof setTimeout>
}

interface McuBackgroundListener {
  socket: ClientSocket
  close: () => void
}

interface PendingMcuBackgroundSpeech {
  options: McuVoiceChatTurnOptions
  delegationId?: string
  text: string
}

interface NormalizedBody {
  body?: BodyInit
  contentType?: string
  byteLength: number
}

function timeoutMs(value?: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Math.floor(Number(value)) : DEFAULT_GLOBAL_AGENT_TIMEOUT_MS
}

function requestTimeoutMs(value?: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_REQUEST_TIMEOUT_MS
  return Math.min(Math.floor(parsed), MAX_REQUEST_TIMEOUT_MS)
}

function responseError<T extends { id?: string; ok?: boolean; error?: { code: string; message: string } }>(
  id: string | undefined,
  code: string,
  message: string,
): T {
  return {
    id,
    ok: false,
    error: { code, message },
  } as T
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

function requestedAgentRole(auth: Record<string, unknown>): boolean {
  const role = String(auth.role || '').trim()
  return role === 'hermes-studio' || role === 'agent'
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

function streamMode(value: unknown, fallback = true): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function chooseMcuApprovalChoice(event: Record<string, unknown>): 'once' | 'session' | 'always' | null {
  const rawChoices = Array.isArray(event.choices) ? event.choices.map(choice => String(choice)) : []
  const choices = rawChoices.length > 0 ? rawChoices : ['once', 'session', 'deny']
  if (choices.includes('session')) return 'session'
  if (choices.includes('once')) return 'once'
  if (choices.includes('always')) return 'always'
  return null
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

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
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

export class GlobalAgentServer {
  private readonly nsp: ReturnType<Server['of']>
  private readonly clients = new Map<string, Socket>()
  private readonly frontendClients = new Map<string, Socket>()
  private readonly bridgeOwners = new Map<string, string>()
  private readonly localSocketBridges = new Map<string, LocalSocketBridge>()
  private readonly activeMcuRuns = new Map<string, { socket: ClientSocket; sessionId: string }>()
  private readonly mcuSessionRuns = new Map<string, { interactionId: string; socket: ClientSocket }>()
  private readonly mcuBackgroundListeners = new Map<string, McuBackgroundListener>()
  private readonly pendingMcuBackgroundSpeech = new Map<string, PendingMcuBackgroundSpeech[]>()
  private readonly mcuBackgroundSpeechRuns = new Set<string>()
  private readonly mcuAudioWaiters = new Map<string, McuAudioWaiter>()
  private readonly mcuVoiceStreams = new Map<string, McuVoiceStreamState>()
  private readonly interruptedMcuInteractions = new Set<string>()
  private readonly mcuTtsAbortControllers = new Map<string, Set<AbortController>>()
  private readonly recentlyInterruptedMcuSessions = new Map<string, number>()
  private readonly pendingMcuInterrupts = new Map<string, PendingMcuInterrupt>()
  private readonly authToken = randomBytes(32).toString('hex')
  private readonly localBaseUrl: string
  private readonly fetchImpl: typeof fetch
  private initialized = false

  constructor(io: Server, options: StartGlobalAgentServerOptions = {}) {
    this.nsp = io.of(GLOBAL_AGENT_NAMESPACE)
    this.localBaseUrl = (options.localBaseUrl || `http://127.0.0.1:${config.port}`).replace(/\/$/, '')
    this.fetchImpl = options.fetchImpl || fetch
  }

  init(): void {
    if (this.initialized) return
    this.initialized = true
    this.nsp.use(async (socket, next) => {
      const auth = socket.handshake.auth || {}
      const token = String(auth.token || '')
      if (token === this.authToken) {
        socket.data.globalAgentRole = 'agent'
        next()
        return
      }

      const user = await authenticateUserToken(token)
      if (!user) {
        next(new Error('Unauthorized'))
        return
      }
      const profile = String(auth.profile || socket.handshake.query?.profile || '').trim()
      if (profile && !this.canAccessProfile(user, profile)) {
        next(new Error('Profile access denied'))
        return
      }
      // The JWT authenticates the user; auth.role only selects the relay protocol mode.
      socket.data.globalAgentRole = requestedAgentRole(auth) ? 'agent' : 'frontend'
      socket.data.user = user
      socket.data.userToken = token
      socket.data.profile = profile
      next()
    })
    this.nsp.on('connection', this.onConnection.bind(this))
    logger.info('[global-agent] Socket.IO ready at %s', GLOBAL_AGENT_NAMESPACE)
  }

  getNamespace(): string {
    return GLOBAL_AGENT_NAMESPACE
  }

  getAuthToken(): string {
    return this.authToken
  }

  getClientIds(): string[] {
    return Array.from(this.clients.keys())
  }

  hasMcuDeviceCode(deviceCode: string): boolean {
    const expected = deviceCode.trim()
    if (!expected) return false
    for (const socket of this.clients.values()) {
      const auth = socket.handshake.auth || {}
      const raw = typeof auth.deviceCode === 'string'
        ? auth.deviceCode
        : typeof auth.device_code === 'string'
          ? auth.device_code
          : ''
      if (raw.trim() === expected) return true
    }
    return false
  }

  async httpRequest(request: RelayHttpRequest, options: GlobalAgentRequestOptions = {}): Promise<RelayHttpResponse> {
    const socket = this.resolveClient(options.clientId)
    if (!socket) {
      return responseError<RelayHttpResponse>(request.id, 'global_agent_unavailable', 'No global agent client is connected')
    }
    return this.emitWithAck<RelayHttpResponse>(socket, 'http.request', request, options.timeoutMs, request.id)
  }

  async openSocket(request: RelaySocketOpenRequest, options: GlobalAgentRequestOptions = {}): Promise<RelaySocketResponse> {
    const socket = this.resolveClient(options.clientId)
    if (!socket) return responseError<RelaySocketResponse>(request.id, 'global_agent_unavailable', 'No global agent client is connected')
    return this.emitWithAck<RelaySocketResponse>(socket, 'socket.open', request, options.timeoutMs, request.id)
  }

  async emitSocketEvent(request: RelaySocketEventRequest, options: GlobalAgentRequestOptions = {}): Promise<RelaySocketResponse> {
    const socket = this.resolveClient(options.clientId)
    if (!socket) return responseError<RelaySocketResponse>(request.id, 'global_agent_unavailable', 'No global agent client is connected')
    return this.emitWithAck<RelaySocketResponse>(socket, 'socket.event', request, options.timeoutMs, request.id)
  }

  async closeSocket(request: RelaySocketCloseRequest, options: GlobalAgentRequestOptions = {}): Promise<RelaySocketResponse> {
    const socket = this.resolveClient(options.clientId)
    if (!socket) return responseError<RelaySocketResponse>(request.id, 'global_agent_unavailable', 'No global agent client is connected')
    return this.emitWithAck<RelaySocketResponse>(socket, 'socket.close', request, options.timeoutMs, request.id)
  }

  emitMcuEvent(payload: Record<string, unknown>, options: GlobalAgentRequestOptions = {}): boolean {
    const socket = this.resolveClient(options.clientId)
    if (!socket) return false
    const event = typeof payload.type === 'string' && payload.type.trim() ? payload.type.trim() : 'mcu.event'
    socket.emit(event, payload)
    return true
  }

  startMcuVoiceChatTurn(options: McuVoiceChatTurnOptions): void {
    const agentRuntime = normalizeMcuAgentRuntime(options.agentRuntime)
    const sessionId = this.mcuSessionId(options.clientId, options.profile, agentRuntime)
    const primaryQueueId = `mcu_${randomUUID()}`
    this.emitMcuEvent({
      type: 'interaction.status',
      interactionId: options.interactionId,
      status: 'thinking',
      text: options.transcript,
    }, { clientId: options.clientId })

    const socket: ClientSocket = createClientSocket(`${this.localBaseUrl}/chat-run`, {
      auth: { token: options.userToken },
      query: { profile: options.profile },
      transports: ['websocket', 'polling'],
      reconnection: false,
      timeout: 30_000,
    })
    let segmentIndex = 0
    let ttsQueue = Promise.resolve()
    const playbackQueue: Promise<void>[] = []
    let previousPlaybackDone = Promise.resolve()
    let settled = false
    let primaryFinished = false
    let primaryTerminalReceived = false
    let currentRunPrimary = false
    let currentRunAutonomous = false
    let currentDelegationId: string | undefined
    let backgroundOutput = ''
    let backgroundPending = 0
    let output = ''
    const speechSegmenter = createMcuSpeechSegmenter()
    const ownsBackgroundEvents = () => {
      const listener = this.mcuBackgroundListeners.get(sessionId)
      return primaryTerminalReceived || listener?.socket === socket
    }

    const releasePrimaryRun = () => {
      if (primaryFinished) return
      primaryFinished = true
      this.activeMcuRuns.delete(options.interactionId)
      const sessionRun = this.mcuSessionRuns.get(sessionId)
      if (sessionRun?.socket === socket) this.mcuSessionRuns.delete(sessionId)
      this.interruptedMcuInteractions.delete(options.interactionId)
      clearTimeout(timer)
      void this.flushMcuBackgroundSpeech(sessionId)
    }
    const finish = () => {
      if (settled) return
      settled = true
      releasePrimaryRun()
      const listener = this.mcuBackgroundListeners.get(sessionId)
      if (listener?.socket === socket) this.mcuBackgroundListeners.delete(sessionId)
      socket.removeAllListeners()
      socket.disconnect()
    }
    const keepBackgroundListener = () => {
      if (settled) return
      releasePrimaryRun()
      const existing = this.mcuBackgroundListeners.get(sessionId)
      if (existing && existing.socket !== socket) existing.close()
      this.mcuBackgroundListeners.set(sessionId, { socket, close: finish })
      logger.info({
        interactionId: options.interactionId,
        sessionId,
        backgroundPending,
      }, '[global-agent] keeping MCU session listener for background delivery')
    }
    const finishPrimaryRun = () => {
      if (backgroundPending > 0) keepBackgroundListener()
      else finish()
    }
    const fail = (message: string) => {
      this.emitMcuEvent({
        type: 'interaction.status',
        interactionId: options.interactionId,
        status: 'failed',
        text: message,
      }, { clientId: options.clientId })
      finish()
    }
    const enqueueSpeech = (text: string) => {
      if (this.interruptedMcuInteractions.has(options.interactionId)) return
      const segmentText = normalizeMcuSpeechText(text)
      if (!segmentText) return
      const segmentId = `${options.interactionId}-tts-${++segmentIndex}`
      this.emitMcuEvent({
        type: 'interaction.status',
        interactionId: options.interactionId,
        status: 'speaking',
        text: segmentText,
      }, { clientId: options.clientId })
      const controller = this.registerMcuTtsAbortController(options.interactionId)
      const audioResult: Promise<McuSpeechSynthesisResult> = this.synthesizeMcuSpeech(
        segmentText,
        options.userToken,
        options.profile,
        controller.signal,
      )
        .then(audio => ({ ok: true as const, audio }))
        .catch(err => ({ ok: false as const, err, aborted: controller.signal.aborted }))
        .finally(() => {
          this.releaseMcuTtsAbortController(options.interactionId, controller)
        })
      ttsQueue = ttsQueue
        .then(async () => {
          await previousPlaybackDone
          const audio = await this.enqueueMcuSpeechSegment(options, segmentId, segmentText, audioResult)
          previousPlaybackDone = audio.playbackDone
          playbackQueue.push(audio.playbackDone)
        })
        .catch((err) => {
          if (err instanceof Error && err.message === 'audio.interrupted') {
            this.interruptedMcuInteractions.add(options.interactionId)
            logger.info({ interactionId: options.interactionId, segmentId }, '[global-agent] MCU speech interrupted by user')
            return
          }
          logger.warn({ err, interactionId: options.interactionId, segmentId }, '[global-agent] failed to enqueue MCU speech')
          this.emitMcuEvent({
            type: 'interaction.status',
            interactionId: options.interactionId,
            status: 'failed',
            text: err instanceof Error ? err.message : String(err),
          }, { clientId: options.clientId })
          this.emitMcuEvent({
            type: 'audio.enqueue',
            interactionId: options.interactionId,
            segmentId: `${segmentId}-failed-prompt`,
            text: mcuPromptText('tts-failed'),
            url: mcuPromptUrl('tts-failed'),
            mimeType: 'audio/x-pcm',
            format: 's16le',
            channels: 1,
            sampleRate: MCU_TTS_SAMPLE_RATE,
          }, { clientId: options.clientId })
        })
    }
    const flushCompletedAssistantMessage = () => {
      const text = speechSegmenter.flush()
      if (text) enqueueSpeech(text)
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
        logger.warn({ sessionId, reason }, '[global-agent] MCU background session listener disconnected')
        finish()
        return
      }
      fail(`chat-run disconnected: ${reason}`)
    })
    socket.on('connect', () => {
      logger.info({
        interactionId: options.interactionId,
        sessionId,
        profile: options.profile,
        transcriptLength: options.transcript.length,
      }, '[global-agent] starting MCU chat-run')
      this.activeMcuRuns.set(options.interactionId, { socket, sessionId })
      this.mcuSessionRuns.set(sessionId, { interactionId: options.interactionId, socket })
      const runPayload = {
        input: options.transcript,
        session_id: sessionId,
        queue_id: primaryQueueId,
        profile: options.profile,
        ...mcuChatRunFields(agentRuntime),
      }
      const interruptedAt = this.recentlyInterruptedMcuSessions.get(sessionId) || 0
      if (Date.now() - interruptedAt < 10_000) {
        socket.emit('abort', { session_id: sessionId })
        setTimeout(() => socket.emit('run', runPayload), 800)
        this.recentlyInterruptedMcuSessions.delete(sessionId)
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
      this.emitMcuEvent({ type: 'interaction.status', interactionId: options.interactionId, status: 'thinking' }, { clientId: options.clientId })
    })
    socket.on('run.queued', (event: Record<string, unknown> = {}) => {
      const queuedMessages = Array.isArray(event.queued_messages) ? event.queued_messages : []
      const ownsQueueEvent = event.dequeued_queue_id === primaryQueueId || queuedMessages.some((message) => (
        typeof message === 'object' && message !== null && (message as Record<string, unknown>).id === primaryQueueId
      ))
      if (!ownsQueueEvent) return
      currentRunPrimary = false
      this.emitMcuEvent({ type: 'interaction.status', interactionId: options.interactionId, status: 'thinking' }, { clientId: options.clientId })
    })
    socket.on('tool.started', (event: Record<string, unknown> = {}) => {
      if (!currentRunPrimary) return
      flushCompletedAssistantMessage()
      output = ''
      const tool = typeof event.tool === 'string' ? event.tool : typeof event.name === 'string' ? event.name : 'tool'
      this.emitMcuEvent({ type: 'tool.started', interactionId: options.interactionId, tool }, { clientId: options.clientId })
    })
    const handleToolFinished = (event: Record<string, unknown> = {}, failed = false) => {
      if (!currentRunPrimary) return
      const tool = typeof event.tool === 'string' ? event.tool : typeof event.name === 'string' ? event.name : 'tool'
      const error = failed ? 'tool.failed' : undefined
      this.emitMcuEvent({ type: 'tool.completed', interactionId: options.interactionId, tool, error }, { clientId: options.clientId })
    }
    socket.on('tool.completed', (event: Record<string, unknown> = {}) => handleToolFinished(event))
    socket.on('tool.failed', (event: Record<string, unknown> = {}) => handleToolFinished(event, true))
    socket.on('message.delta', (event: Record<string, unknown> = {}) => {
      if (typeof event.delta !== 'string') return
      if (currentRunAutonomous) {
        backgroundOutput += event.delta
        return
      }
      if (!currentRunPrimary) return
      output += event.delta
      for (const segment of speechSegmenter.pushDelta(event.delta)) {
        enqueueSpeech(segment)
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
          this.queueMcuBackgroundSpeech(sessionId, {
            options,
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
          if (this.interruptedMcuInteractions.has(options.interactionId)) {
            finish()
            return
          }
          this.emitMcuEvent({ type: 'interaction.status', interactionId: options.interactionId, status: 'completed' }, { clientId: options.clientId })
          finishPrimaryRun()
        })
        .catch((err) => {
          if (this.interruptedMcuInteractions.has(options.interactionId) || (err instanceof Error && err.message === 'audio.interrupted')) {
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
      this.emitMcuEvent({
        type: 'interaction.status',
        interactionId: options.interactionId,
        status: 'failed',
        text: typeof event.error === 'string' ? event.error : 'chat-run failed',
      }, { clientId: options.clientId })
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
      if (!currentRunAutonomous) {
        this.emitMcuEvent({ type: 'tool.started', interactionId: options.interactionId, tool: 'approval' }, { clientId: options.clientId })
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
      this.emitMcuEvent({
        type: 'tool.completed',
        interactionId: options.interactionId,
        tool: 'approval',
        error: resolved ? undefined : 'approval failed',
      }, { clientId: options.clientId })
    })
    socket.on('clarify.requested', () => {
      if (!currentRunPrimary) return
      fail('clarification required')
    })
  }

  private queueMcuBackgroundSpeech(sessionId: string, item: PendingMcuBackgroundSpeech): void {
    const text = item.text.trim()
    if (!text) return
    const queue = this.pendingMcuBackgroundSpeech.get(sessionId) || []
    if (item.delegationId && queue.some(queued => queued.delegationId === item.delegationId)) return
    queue.push({ ...item, text })
    this.pendingMcuBackgroundSpeech.set(sessionId, queue)
    void this.flushMcuBackgroundSpeech(sessionId)
  }

  private async flushMcuBackgroundSpeech(sessionId: string): Promise<void> {
    if (this.mcuBackgroundSpeechRuns.has(sessionId) || this.mcuSessionRuns.has(sessionId)) return
    const queue = this.pendingMcuBackgroundSpeech.get(sessionId)
    if (!queue?.length) return
    if (!this.resolveClient(queue[0].options.clientId)) return

    this.mcuBackgroundSpeechRuns.add(sessionId)
    try {
      while (queue.length > 0 && !this.mcuSessionRuns.has(sessionId)) {
        const item = queue.shift()
        if (!item) break
        await this.playMcuBackgroundSpeech(item)
      }
    } catch (err) {
      if (!(err instanceof Error && err.message === 'audio.interrupted')) {
        logger.warn({ err, sessionId }, '[global-agent] failed to deliver MCU background speech')
      }
    } finally {
      this.mcuBackgroundSpeechRuns.delete(sessionId)
      if (queue.length === 0) this.pendingMcuBackgroundSpeech.delete(sessionId)
    }
  }

  private async playMcuBackgroundSpeech(item: PendingMcuBackgroundSpeech): Promise<void> {
    const suffix = (item.delegationId || randomUUID())
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 96) || randomUUID()
    const interactionId = `mcu-background-${suffix}`
    const options = { ...item.options, interactionId }
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
        const controller = this.registerMcuTtsAbortController(interactionId)
        const audioResult: Promise<McuSpeechSynthesisResult> = this.synthesizeMcuSpeech(
          text,
          options.userToken,
          options.profile,
          controller.signal,
        )
          .then(audio => ({ ok: true as const, audio }))
          .catch(err => ({ ok: false as const, err, aborted: controller.signal.aborted }))
          .finally(() => this.releaseMcuTtsAbortController(interactionId, controller))
        const audio = await this.enqueueMcuSpeechSegment(options, segmentId, text, audioResult)
        await audio.playbackDone
        if (this.interruptedMcuInteractions.has(interactionId)) throw new Error('audio.interrupted')
      }

      if (segmentIndex > 0) {
        this.emitMcuEvent({ type: 'interaction.status', interactionId, status: 'completed' }, { clientId: options.clientId })
      }
    } finally {
      this.interruptedMcuInteractions.delete(interactionId)
    }
  }

  private onConnection(socket: Socket): void {
    if (socket.data.globalAgentRole === 'frontend' && socket.data.user?.id) socket.join(personNotificationRoom(socket.data.user.id))
    if (socket.data.globalAgentRole === 'frontend') {
      this.onFrontendConnection(socket)
      return
    }
    this.onAgentConnection(socket)
  }

  private onAgentConnection(socket: Socket): void {
    const clientId = String(socket.handshake.auth?.instanceId || socket.id)
    const existing = this.clients.get(clientId)
    if (existing && existing.id !== socket.id) {
      this.closeInboundSocketsForOwner(existing.id)
      existing.disconnect(true)
      logger.info('[global-agent] replaced existing client id=%s old_socket=%s new_socket=%s', clientId, existing.id, socket.id)
    }
    this.clients.set(clientId, socket)
    bindMcuWebhookEvents(socket)
    for (const [sessionId, queue] of this.pendingMcuBackgroundSpeech.entries()) {
      if (queue.some(item => item.options.clientId === clientId)) void this.flushMcuBackgroundSpeech(sessionId)
    }
    logger.info('[global-agent] client connected id=%s socket=%s', clientId, socket.id)

    socket.on('disconnect', () => {
      if (this.clients.get(clientId)?.id === socket.id) {
        this.clients.delete(clientId)
      }
      this.cancelPendingMcuInterruptsForClient(clientId)
      this.closeInboundSocketsForOwner(socket.id)
      logger.info('[global-agent] client disconnected id=%s socket=%s', clientId, socket.id)
    })
    socket.on('relay.ready', (payload: unknown) => {
      logger.info({ clientId, payload }, '[global-agent] client ready')
    })
    socket.on('http.request', (request: RelayHttpRequest, ack?: (response: RelayHttpResponse) => void) => {
      void this.handleInboundHttpRequest(socket, request)
        .then(response => this.respondHttp(socket, response, ack))
        .catch((err) => this.respondHttp(
          socket,
          relayError(request?.id, 'relay_internal_error', err instanceof Error ? err.message : String(err), 500),
          ack,
        ))
    })
    socket.on('socket.open', (request: RelaySocketOpenRequest, ack?: (response: RelaySocketResponse) => void) => {
      this.respondSocket(socket, this.openInboundSocket(socket, request), ack)
    })
    socket.on('socket.event', (payload: unknown, ack?: (response: RelaySocketResponse) => void) => {
      if (ack) {
        this.respondSocket(socket, this.emitInboundSocketEvent(socket, payload as RelaySocketEventRequest), ack)
        return
      }
      this.emitFrontendBridgeEvent(clientId, payload)
      socket.broadcast.emit('relay.socket.event', { clientId, payload })
    })
    socket.on('socket.close', (request: RelaySocketCloseRequest, ack?: (response: RelaySocketResponse) => void) => {
      this.respondSocket(socket, this.closeInboundSocket(socket, request), ack)
    })
    socket.on('http.response', (payload: unknown) => {
      socket.broadcast.emit('relay.http.response', { clientId, payload })
    })
    for (const event of MCU_FORWARD_EVENTS) {
      socket.on(event, (payload: unknown) => {
        this.forwardMcuEvent(clientId, event, payload)
      })
    }
  }

  private onFrontendConnection(socket: Socket): void {
    this.frontendClients.set(socket.id, socket)
    logger.info('[global-agent] frontend connected socket=%s user=%s', socket.id, socket.data.user?.id)

    socket.on('http.request', (request: RelayHttpRequest & { clientId?: string }, ack?: (response: RelayHttpResponse) => void) => {
      void this.httpRequest(
        this.withFrontendHttpAuth(socket, request),
        { clientId: request.clientId, timeoutMs: request.timeoutMs },
      ).then(response => ack?.(response))
    })
    socket.on('socket.open', (request: RelaySocketOpenRequest & { clientId?: string; timeoutMs?: number }, ack?: (response: RelaySocketResponse) => void) => {
      void this.openSocket(
        this.withFrontendSocketAuth(socket, request),
        { clientId: request.clientId, timeoutMs: request.timeoutMs },
      ).then((response) => {
        const bridgeId = String(request.id || '').trim()
        if (!response.error && bridgeId) this.bridgeOwners.set(bridgeId, socket.id)
        ack?.(response)
      })
    })
    socket.on('socket.event', (request: RelaySocketEventRequest & { clientId?: string; timeoutMs?: number }, ack?: (response: RelaySocketResponse) => void) => {
      if (!this.frontendOwnsBridge(socket, request.id)) {
        ack?.(responseError<RelaySocketResponse>(request.id, 'socket_not_open', 'Relay socket is not open for this frontend client'))
        return
      }
      void this.emitSocketEvent(
        this.withFrontendSocketPayload(socket, request),
        { clientId: request.clientId, timeoutMs: request.timeoutMs },
      ).then(response => ack?.(response))
    })
    socket.on('socket.close', (request: RelaySocketCloseRequest & { clientId?: string; timeoutMs?: number }, ack?: (response: RelaySocketResponse) => void) => {
      if (!this.frontendOwnsBridge(socket, request.id)) {
        ack?.(responseError<RelaySocketResponse>(request.id, 'socket_not_open', 'Relay socket is not open for this frontend client'))
        return
      }
      void this.closeSocket(request, { clientId: request.clientId, timeoutMs: request.timeoutMs }).then((response) => {
        const bridgeId = String(request.id || '').trim()
        if (bridgeId) this.bridgeOwners.delete(bridgeId)
        ack?.(response)
      })
    })
    socket.on('run', (payload: unknown) => {
      void this.emitFrontendChatEvent(socket, 'run', payload)
    })
    socket.on('resume', (payload: unknown) => {
      void this.emitFrontendChatEvent(socket, 'resume', payload)
    })
    socket.on('abort', (payload: unknown) => {
      void this.emitFrontendChatEvent(socket, 'abort', payload)
    })
    socket.on('cancel_queued_run', (payload: unknown) => {
      void this.emitFrontendChatEvent(socket, 'cancel_queued_run', payload)
    })
    socket.on('insert_queued_run', (payload: unknown) => {
      void this.emitFrontendChatEvent(socket, 'insert_queued_run', payload)
    })
    socket.on('approval.respond', (payload: unknown) => {
      void this.emitFrontendChatEvent(socket, 'approval.respond', payload)
    })
    socket.on('clarify.respond', (payload: unknown) => {
      void this.emitFrontendChatEvent(socket, 'clarify.respond', payload)
    })
    socket.on('disconnect', () => {
      this.frontendClients.delete(socket.id)
      for (const [bridgeId, ownerSocketId] of this.bridgeOwners.entries()) {
        if (ownerSocketId !== socket.id) continue
        this.bridgeOwners.delete(bridgeId)
        void this.closeSocket({ id: bridgeId })
      }
      logger.info('[global-agent] frontend disconnected socket=%s user=%s', socket.id, socket.data.user?.id)
    })
  }

  private async handleInboundHttpRequest(socket: Socket, request: RelayHttpRequest): Promise<RelayHttpResponse> {
    if (!socket.data.userToken) {
      return relayError(request.id, 'unauthorized', 'A user login token is required for inbound relay requests', 401)
    }

    const method = normalizeMethod(request.method)
    if (!method) {
      return relayError(request.id, 'method_not_allowed', 'Relay request method is not allowed', 405)
    }

    const path = normalizeRelayPath(request.path)
    if (!path) {
      return relayError(request.id, 'path_not_allowed', 'Relay request path is not allowed', 403)
    }

    const headers = normalizeHeaders(request.headers)
    headers.set('authorization', `Bearer ${socket.data.userToken}`)
    const profile = this.frontendProfile(socket)
    if (profile) headers.set('x-hermes-profile', profile)

    const normalizedBody = normalizeRequestBody(request, method, headers)
    if (isRelayHttpResponse(normalizedBody)) return normalizedBody
    if (normalizedBody.contentType) headers.set('content-type', normalizedBody.contentType)

    const timeout = requestTimeoutMs(request.timeoutMs)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)

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
        aborted ? `Local relay request timed out after ${timeout}ms` : err instanceof Error ? err.message : String(err),
        aborted ? 504 : 502,
      )
    } finally {
      clearTimeout(timer)
    }
  }

  private openInboundSocket(owner: Socket, request: RelaySocketOpenRequest): RelaySocketResponse {
    if (!owner.data.userToken) {
      return socketRelayError(request.id, 'unauthorized', 'A user login token is required for inbound relay sockets')
    }

    const id = normalizeSocketBridgeId(request.id)
    if (!id) return socketRelayError(request.id, 'invalid_socket_id', 'Relay socket id is required')

    const namespace = normalizeSocketNamespace(request.namespace)
    if (!namespace) return socketRelayError(id, 'namespace_not_allowed', 'Relay socket namespace is not allowed')

    this.closeInboundSocket(owner, { id })
    const profile = this.frontendProfile(owner)
    const auth = {
      ...normalizeSocketAuth(request.auth),
      token: owner.data.userToken,
    }
    const query = {
      ...normalizeSocketQuery(request.query),
      ...(profile ? { profile } : {}),
    }
    const localSocket = createClientSocket(`${this.localBaseUrl}${namespace}`, {
      auth,
      query,
      transports: ['websocket', 'polling'],
      reconnection: false,
      timeout: 30_000,
    })
    const bridge: LocalSocketBridge = {
      id,
      ownerSocketId: owner.id,
      namespace,
      socket: localSocket,
      stream: streamMode(request.stream),
      output: '',
      reasoning: '',
    }
    this.localSocketBridges.set(this.inboundBridgeKey(owner, id), bridge)

    localSocket.on('connect', () => {
      this.emitInboundSocketEvent(owner, bridge, 'connect', { socketId: localSocket.id })
    })
    localSocket.on('connect_error', (err: Error) => {
      this.emitInboundSocketEvent(owner, bridge, 'connect_error', { message: err.message })
    })
    localSocket.on('disconnect', (reason: string) => {
      this.emitInboundSocketEvent(owner, bridge, 'disconnect', { reason })
    })
    for (const event of CHAT_RUN_SERVER_EVENTS) {
      localSocket.on(event, (payload: unknown) => {
        this.handleInboundLocalSocketEvent(owner, bridge, event, payload)
      })
    }

    return { id, ok: true, namespace, stream: bridge.stream }
  }

  private emitInboundSocketEvent(owner: Socket, request: RelaySocketEventRequest): RelaySocketResponse
  private emitInboundSocketEvent(owner: Socket, bridge: LocalSocketBridge, event: string, payload: unknown): void
  private emitInboundSocketEvent(
    owner: Socket,
    requestOrBridge: RelaySocketEventRequest | LocalSocketBridge,
    eventName?: string,
    payload?: unknown,
  ): RelaySocketResponse | void {
    if ('socket' in requestOrBridge) {
      const bridge = requestOrBridge
      owner.emit('socket.event', {
        id: bridge.id,
        namespace: bridge.namespace,
        event: eventName,
        payload,
      })
      return
    }

    const request = requestOrBridge
    const id = normalizeSocketBridgeId(request.id)
    if (!id) return socketRelayError(request.id, 'invalid_socket_id', 'Relay socket id is required')

    const event = String(request.event || '').trim()
    if (!ALLOWED_CHAT_RUN_CLIENT_EVENTS.has(event)) {
      return socketRelayError(id, 'event_not_allowed', 'Relay socket event is not allowed')
    }

    const bridge = this.localSocketBridges.get(this.inboundBridgeKey(owner, id))
    if (!bridge || bridge.ownerSocketId !== owner.id) {
      return socketRelayError(id, 'socket_not_open', 'Relay socket is not open')
    }
    if (typeof request.stream === 'boolean') {
      bridge.stream = request.stream
    }
    if (event === 'run') {
      bridge.output = ''
      bridge.reasoning = ''
    }

    bridge.socket.emit(event, this.withInboundSocketPayload(owner, request.payload))
    return { id, ok: true, namespace: bridge.namespace, event, stream: bridge.stream }
  }

  private closeInboundSocket(owner: Socket, request: RelaySocketCloseRequest): RelaySocketResponse {
    const id = normalizeSocketBridgeId(request.id)
    if (!id) return socketRelayError(request.id, 'invalid_socket_id', 'Relay socket id is required')

    const key = this.inboundBridgeKey(owner, id)
    const bridge = this.localSocketBridges.get(key)
    if (!bridge || bridge.ownerSocketId !== owner.id) return { id, ok: true }
    bridge.socket.disconnect()
    this.localSocketBridges.delete(key)
    return { id, ok: true, namespace: bridge.namespace }
  }

  private closeInboundSocketsForOwner(ownerSocketId: string): void {
    for (const [key, bridge] of this.localSocketBridges.entries()) {
      if (bridge.ownerSocketId !== ownerSocketId) continue
      bridge.socket.disconnect()
      this.localSocketBridges.delete(key)
    }
  }

  private handleInboundLocalSocketEvent(owner: Socket, bridge: LocalSocketBridge, event: string, payload: unknown): void {
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
        this.emitInboundSocketEvent(owner, bridge, event, this.withNonStreamingOutput(payload, bridge))
        return
      }
    }

    this.emitInboundSocketEvent(owner, bridge, event, payload)
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

  private withInboundSocketPayload(socket: Socket, payload: unknown): unknown {
    const profile = this.frontendProfile(socket)
    if (!profile || !isRecord(payload)) return payload
    return {
      ...payload,
      profile: typeof payload.profile === 'string' && payload.profile ? payload.profile : profile,
    }
  }

  private respondHttp(socket: Socket, response: RelayHttpResponse, ack?: (response: RelayHttpResponse) => void): void {
    if (ack) {
      ack(response)
      return
    }
    socket.emit('http.response', response)
  }

  private respondSocket(socket: Socket, response: RelaySocketResponse, ack?: (response: RelaySocketResponse) => void): void {
    if (ack) {
      ack(response)
      return
    }
    socket.emit('socket.response', response)
  }

  private inboundBridgeKey(socket: Socket, id: string): string {
    return `${socket.id}:${id}`
  }

  private clientIdForSocket(socket: Socket): string {
    for (const [clientId, clientSocket] of this.clients.entries()) {
      if (clientSocket.id === socket.id) return clientId
    }
    return socket.id
  }

  private mcuApiToken(payload: Record<string, unknown>): string {
    const raw = typeof payload.apiToken === 'string'
      ? payload.apiToken
      : typeof payload.api_token === 'string'
        ? payload.api_token
        : typeof payload.authorization === 'string'
          ? payload.authorization
          : ''
    const trimmed = raw.trim()
    return trimmed.toLowerCase().startsWith('bearer ') ? trimmed.slice(7).trim() : trimmed
  }

  private authorizeMcuEvent(clientId: string, event: string, payload: Record<string, unknown>): boolean {
    const socket = this.clients.get(clientId)
    const expectedToken = String(socket?.data.userToken || '')
    const providedToken = this.mcuApiToken(payload)
    if (!socket || !expectedToken || !providedToken || providedToken !== expectedToken) {
      logger.warn({ clientId, event }, '[global-agent] rejected MCU event with invalid API token')
      this.emitMcuEvent({
        type: 'auth.invalid',
        event,
        text: mcuPromptText('token-invalid'),
        url: mcuPromptUrl('token-invalid'),
        mimeType: 'audio/x-pcm',
        channels: 1,
        sampleRate: MCU_TTS_SAMPLE_RATE,
      }, { clientId })
      return false
    }

    const profile = typeof payload.profile === 'string' ? payload.profile.trim() : ''
    const user = socket.data.user as AuthenticatedUser | undefined
    if (profile && user && !this.canAccessProfile(user, profile)) {
      logger.warn({ clientId, event, profile, userId: user.id }, '[global-agent] rejected MCU event for inaccessible profile')
      return false
    }

    return true
  }

  private redactMcuAuthPayload(payload: Record<string, unknown>): Record<string, unknown> {
    const redacted = { ...payload }
    delete redacted.apiToken
    delete redacted.api_token
    delete redacted.authorization
    return redacted
  }

  private forwardMcuEvent(clientId: string, event: string, payload: unknown): void {
    const body = isRecord(payload)
      ? { ...payload, type: typeof payload.type === 'string' && payload.type ? payload.type : event }
      : { type: event, payload }
    if (!this.authorizeMcuEvent(clientId, event, body)) return
    this.handleMcuClientEvent(clientId, event, body)
    this.emitFrontendBridgeEvent(clientId, this.redactMcuAuthPayload(body))
  }

  private mcuSessionId(clientId: string | undefined, profile: string, agentRuntime: McuAgentRuntime): string {
    const instance = (clientId || 'device')
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

  private async synthesizeMcuSpeech(text: string, userToken: string, profile: string, signal?: AbortSignal): Promise<{ url: string; mimeType: string }> {
    const headers = {
      Authorization: `Bearer ${userToken}`,
      'Content-Type': 'application/json',
      'X-Hermes-Profile': profile || 'default',
    }
    const requestTts = (provider?: 'edge') => this.fetchImpl(`${this.localBaseUrl}/api/studio/tts/synthesize`, {
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
      if (!audio.length) throw new Error(`${context} returned empty audio`)
      const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
      const sourceBytes = audio.length
      if (contentType === 'audio/x-pcm' || contentType === 'audio/pcm') {
        logger.info({ context, contentType, sourceBytes, pcmBytes: audio.length }, '[global-agent] MCU TTS PCM audio ready')
        return audio
      }

      const converted = await transcodeToPcmS16le(audio, contentType || 'application/octet-stream', {
        sampleRate: MCU_TTS_SAMPLE_RATE,
      })
      if (converted.mimeType !== 'audio/x-pcm') {
        throw new Error(`${context} returned ${contentType || 'unknown content type'} and PCM conversion is unavailable`)
      }
      audio = converted.audio
      if (!audio.length) throw new Error(`${context} PCM conversion returned empty audio`)
      logger.info({
        context,
        contentType: contentType || 'application/octet-stream',
        sourceBytes,
        pcmBytes: audio.length,
        sampleRate: MCU_TTS_SAMPLE_RATE,
      }, '[global-agent] MCU TTS decoded to PCM')
      return audio
    }

    let response = await requestTts()
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      logger.warn({
        status: response.status,
        detail: detail.slice(0, 200),
      }, '[global-agent] active MCU TTS failed, falling back to Edge TTS')
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
      logger.warn({ err }, '[global-agent] MCU TTS audio decode failed, falling back to Edge TTS')
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
    }, '[global-agent] MCU TTS encoded to ADPCM')
    return { url: `/api/studio/mcu/audio/${file}`, mimeType: 'audio/x-ima-adpcm' }
  }

  private async enqueueMcuSpeechSegment(
    options: McuVoiceChatTurnOptions,
    segmentId: string,
    text: string,
    audioResult: Promise<McuSpeechSynthesisResult>,
  ): Promise<EnqueuedMcuSpeechSegment> {
    if (this.interruptedMcuInteractions.has(options.interactionId)) {
      return { playbackDone: Promise.resolve() }
    }
    const result = await audioResult
    if (!result.ok) {
      if (result.aborted) throw new Error('audio.interrupted')
      throw result.err
    }
    if (this.interruptedMcuInteractions.has(options.interactionId)) {
      return { playbackDone: Promise.resolve() }
    }
    const waitForDone = this.waitForMcuAudioDone(segmentId, Math.max(90_000, Math.min(text.length * 1200, 300_000)))
    waitForDone.catch(() => undefined)
    const emitted = this.emitMcuEvent({
      type: 'audio.enqueue',
      interactionId: options.interactionId,
      segmentId,
      text,
      url: result.audio.url,
      mimeType: result.audio.mimeType,
      channels: 1,
      sampleRate: MCU_TTS_SAMPLE_RATE,
      durationMs: Math.max(1200, Math.min(text.length * 180, 12_000)),
      completionManagedByServer: true,
    }, { clientId: options.clientId })
    if (!emitted) {
      const waiter = this.mcuAudioWaiters.get(segmentId)
      if (waiter) {
        clearTimeout(waiter.timer)
        this.mcuAudioWaiters.delete(segmentId)
        waiter.reject(new Error('MCU client disconnected before audio delivery'))
      }
      throw new Error('MCU client disconnected before audio delivery')
    }
    return { playbackDone: waitForDone }
  }

  private waitForMcuAudioDone(segmentId: string, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.mcuAudioWaiters.delete(segmentId)
        reject(new Error(`MCU audio playback timed out: ${segmentId}`))
      }, timeoutMs)
      this.mcuAudioWaiters.set(segmentId, { resolve, reject, timer })
    })
  }

  private abortActiveMcuRun(interactionId: string): void {
    this.interruptedMcuInteractions.add(interactionId)
    this.abortMcuTts(interactionId)
    const active = this.activeMcuRuns.get(interactionId)
    if (!active) return
    logger.info({ interactionId, sessionId: active.sessionId }, '[global-agent] aborting MCU chat-run after audio interrupt')
    active.socket.emit('abort', { session_id: active.sessionId })
    this.activeMcuRuns.delete(interactionId)
    this.mcuSessionRuns.delete(active.sessionId)
  }

  private scheduleMcuInterrupt(clientId: string, profile: string, agentRuntime: McuAgentRuntime, interactionId: string): void {
    const sessionId = this.mcuSessionId(clientId, profile, agentRuntime)
    this.cancelPendingMcuInterrupt(sessionId)
    const timer = setTimeout(() => {
      this.pendingMcuInterrupts.delete(sessionId)
      this.interruptMcuSession(clientId, profile, agentRuntime, interactionId)
    }, MCU_INTERRUPT_DEBOUNCE_MS)
    this.pendingMcuInterrupts.set(sessionId, { clientId, profile, agentRuntime, interactionId, timer })
  }

  private cancelPendingMcuInterrupt(sessionId: string): void {
    const pending = this.pendingMcuInterrupts.get(sessionId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pendingMcuInterrupts.delete(sessionId)
  }

  private cancelPendingMcuInterruptsForClient(clientId: string): void {
    for (const [sessionId, pending] of this.pendingMcuInterrupts.entries()) {
      if (pending.clientId !== clientId) continue
      clearTimeout(pending.timer)
      this.pendingMcuInterrupts.delete(sessionId)
    }
  }

  private forgetMcuSessionRun(sessionId: string, interactionId?: string): void {
    this.pendingMcuBackgroundSpeech.delete(sessionId)
    this.mcuBackgroundListeners.get(sessionId)?.close()
    const sessionRun = this.mcuSessionRuns.get(sessionId)
    if (sessionRun) {
      this.interruptedMcuInteractions.add(sessionRun.interactionId)
      this.abortMcuTts(sessionRun.interactionId)
      this.activeMcuRuns.delete(sessionRun.interactionId)
      this.mcuSessionRuns.delete(sessionId)
    }
    if (interactionId) {
      this.interruptedMcuInteractions.add(interactionId)
      this.abortMcuTts(interactionId)
      const active = this.activeMcuRuns.get(interactionId)
      if (active?.sessionId === sessionId) {
        this.activeMcuRuns.delete(interactionId)
        this.mcuSessionRuns.delete(sessionId)
      }
    }
  }

  private interruptMcuSession(clientId: string, profile: string, agentRuntime: McuAgentRuntime, interactionId?: string): void {
    const active = interactionId ? this.activeMcuRuns.get(interactionId) : undefined
    const requestedSessionId = this.mcuSessionId(clientId, profile, agentRuntime)
    const activeSessionBelongsToDevice = active && (
      active.sessionId === this.mcuSessionId(clientId, profile, 'ekko')
      || active.sessionId === this.mcuSessionId(clientId, profile, 'hermes')
    )
    const sessionId = activeSessionBelongsToDevice ? active.sessionId : requestedSessionId
    const sessionRun = this.mcuSessionRuns.get(sessionId)
    const hasActiveTts = interactionId ? this.mcuTtsAbortControllers.has(interactionId) : false
    if (interactionId && (sessionRun || active || hasActiveTts)) {
      this.interruptedMcuInteractions.add(interactionId)
      this.abortMcuTts(interactionId)
    }
    if (sessionRun) {
      this.recentlyInterruptedMcuSessions.set(sessionId, Date.now())
      this.interruptedMcuInteractions.add(sessionRun.interactionId)
      this.abortMcuTts(sessionRun.interactionId)
      logger.info({ interactionId: sessionRun.interactionId, sessionId }, '[global-agent] aborting MCU chat-run after interrupt')
      sessionRun.socket.emit('abort', { session_id: sessionId })
      this.activeMcuRuns.delete(sessionRun.interactionId)
      this.mcuSessionRuns.delete(sessionId)
      return
    }
    if (interactionId && active?.sessionId === sessionId) {
      this.recentlyInterruptedMcuSessions.set(sessionId, Date.now())
      this.abortActiveMcuRun(interactionId)
    }
  }

  private registerMcuTtsAbortController(interactionId: string): AbortController {
    const controller = new AbortController()
    if (this.interruptedMcuInteractions.has(interactionId)) {
      controller.abort()
      return controller
    }
    const controllers = this.mcuTtsAbortControllers.get(interactionId) || new Set<AbortController>()
    controllers.add(controller)
    this.mcuTtsAbortControllers.set(interactionId, controllers)
    return controller
  }

  private releaseMcuTtsAbortController(interactionId: string, controller: AbortController): void {
    const controllers = this.mcuTtsAbortControllers.get(interactionId)
    if (!controllers) return
    controllers.delete(controller)
    if (controllers.size === 0) this.mcuTtsAbortControllers.delete(interactionId)
  }

  private abortMcuTts(interactionId: string): void {
    const controllers = this.mcuTtsAbortControllers.get(interactionId)
    if (!controllers) return
    for (const controller of controllers) {
      if (!controller.signal.aborted) controller.abort()
    }
    this.mcuTtsAbortControllers.delete(interactionId)
  }

  private clearMcuSession(clientId: string, profile: string, agentRuntime: McuAgentRuntime, interactionId?: string): void {
    const sessionId = this.mcuSessionId(clientId, profile, agentRuntime)
    this.cancelPendingMcuInterrupt(sessionId)
    this.forgetMcuSessionRun(sessionId, interactionId)
    const chatRunServer = getChatRunServer()
    if (!chatRunServer) {
      logger.error({ clientId, sessionId }, '[global-agent] cannot clear MCU chat session: chat-run server is unavailable')
      this.emitMcuEvent({
        type: 'mcu.session.cleared',
        interactionId: interactionId || undefined,
        profile,
        agentRuntime,
        sessionId,
        ok: false,
        error: 'chat_run_server_unavailable',
      }, { clientId })
      return
    }
    const cleared = chatRunServer.clearSessionHistory(sessionId)
    const deleted = cleared.deleted
    const memoryCleared = cleared.hadMemoryState
    logger.info({ clientId, sessionId, deleted, memoryCleared }, '[global-agent] cleared MCU chat session')
    this.emitMcuEvent({
      type: 'mcu.session.cleared',
      interactionId: interactionId || undefined,
      profile,
      agentRuntime,
      sessionId,
      deleted,
      memoryCleared,
    }, { clientId })
    this.emitFrontendSessionCommand({
      event: 'session.command',
      session_id: sessionId,
      command: 'clear',
      action: 'clear',
      clearHistory: true,
      ok: true,
      deleted,
      memoryCleared,
    })
  }

  private handleMcuClientEvent(clientId: string, event: string, payload: Record<string, unknown>): void {
    if (event === 'voice.stream.start') {
      if (!this.handleMcuVoiceStreamStart(clientId, payload)) {
        this.emitMcuEvent({
          type: 'interaction.status',
          interactionId: typeof payload.interactionId === 'string' ? payload.interactionId : undefined,
          status: 'failed',
          text: 'missing Web UI auth token',
        }, { clientId })
      }
      return
    }

    if (event === 'voice.stream.chunk') {
      this.handleMcuVoiceStreamChunk(clientId, payload)
      return
    }

    if (event === 'voice.stream.end') {
      void this.handleMcuVoiceStreamEnd(clientId, payload)
      return
    }

    if (event === 'voice.stream.abort') {
      this.handleMcuVoiceStreamAbort(clientId, payload)
      return
    }

    if (event === 'audio.done' || event === 'audio.interrupted' || event === 'audio.dropped') {
      if (event === 'audio.interrupted' && typeof payload.interactionId === 'string') {
        this.abortActiveMcuRun(payload.interactionId)
      }
      const segmentId = typeof payload.segmentId === 'string' ? payload.segmentId : ''
      if (!segmentId) return
      const waiter = this.mcuAudioWaiters.get(segmentId)
      if (!waiter) return
      clearTimeout(waiter.timer)
      this.mcuAudioWaiters.delete(segmentId)
      if (event === 'audio.done') {
        waiter.resolve()
      } else {
        waiter.reject(new Error(event))
      }
      return
    }

    if (event === 'mcu.interrupt') {
      const interactionId = typeof payload.interactionId === 'string' ? payload.interactionId.trim() : ''
      const profile = typeof payload.profile === 'string' && payload.profile.trim() ? payload.profile.trim() : 'default'
      const agentRuntime = normalizeMcuAgentRuntime(payload.agentRuntime)
      this.scheduleMcuInterrupt(clientId, profile, agentRuntime, interactionId)
      this.emitMcuEvent({ type: 'mcu.interrupt.ack', interactionId, profile, agentRuntime }, { clientId })
      return
    }

    if (event === 'mcu.session.clear') {
      const profile = typeof payload.profile === 'string' && payload.profile.trim() ? payload.profile.trim() : 'default'
      const interactionId = typeof payload.interactionId === 'string' ? payload.interactionId.trim() : ''
      const agentRuntime = normalizeMcuAgentRuntime(payload.agentRuntime)
      this.clearMcuSession(clientId, profile, agentRuntime, interactionId)
    }
  }

  private handleMcuVoiceStreamStart(clientId: string, payload: Record<string, unknown>): boolean {
    const socket = this.clients.get(clientId)
    const userToken = String(socket?.data.userToken || '')
    if (!socket || !userToken) return false
    const interactionId = typeof payload.interactionId === 'string' && payload.interactionId.trim()
      ? payload.interactionId.trim()
      : `mcu-voice-${Date.now()}`
    this.mcuVoiceStreams.set(clientId, {
      interactionId,
      profile: typeof payload.profile === 'string' && payload.profile.trim() ? payload.profile.trim() : this.frontendProfile(socket) || 'default',
      agentRuntime: normalizeMcuAgentRuntime(payload.agentRuntime),
      mimeType: typeof payload.mimeType === 'string' && payload.mimeType.trim()
        ? payload.mimeType.trim().toLowerCase()
        : 'audio/pcm',
      sampleRate: Number.isFinite(Number(payload.sampleRate)) ? Number(payload.sampleRate) : MCU_TTS_SAMPLE_RATE,
      channels: Number(payload.channels) === 1 ? 1 : 2,
      bitsPerSample: Number(payload.bitsPerSample) === 16 ? 16 : 16,
      bytes: 0,
      chunks: [],
      userToken,
    })
    this.emitMcuEvent({ type: 'interaction.status', interactionId, status: 'listening' }, { clientId })
    return true
  }

  private handleMcuVoiceStreamChunk(clientId: string, payload: Record<string, unknown>): void {
    const stream = this.mcuVoiceStreams.get(clientId)
    const payloadInteractionId = typeof payload.interactionId === 'string' ? payload.interactionId.trim() : ''
    const interactionId = typeof payload.interactionId === 'string' ? payload.interactionId.trim() : ''
    const seq = Number(payload.seq)
    const normalizedSeq = Number.isFinite(seq) && seq >= 0 ? Math.floor(seq) : undefined
    const expectsAck = normalizedSeq !== undefined || Number.isFinite(Number(payload.crc32))
    if (!stream) {
      if (expectsAck) {
        this.emitMcuEvent({
          type: 'voice.stream.chunk.ack',
          interactionId: payloadInteractionId || undefined,
          seq: normalizedSeq,
          offset: Number.isFinite(Number(payload.offset)) ? Math.floor(Number(payload.offset)) : undefined,
          ok: false,
          reason: 'missing_stream',
        }, { clientId })
      }
      return
    }
    const ack = (ok: boolean, reason?: string, offset?: number, bytes?: number, checksum?: number) => {
      if (!expectsAck) return
      this.emitMcuEvent({
        type: 'voice.stream.chunk.ack',
        interactionId: stream.interactionId,
        seq: normalizedSeq,
        offset,
        bytes,
        crc32: checksum,
        ok,
        reason,
      }, { clientId })
    }
    if (interactionId && interactionId !== stream.interactionId) {
      logger.warn({
        clientId,
        streamInteractionId: stream.interactionId,
        chunkInteractionId: interactionId,
      }, '[global-agent] ignoring MCU voice stream chunk for stale interaction')
      ack(false, 'stale_interaction')
      return
    }
    const data = payload.data
    let chunk: Buffer
    if (typeof data === 'string') {
      chunk = Buffer.from(data, 'base64')
    } else if (Buffer.isBuffer(data)) {
      chunk = Buffer.from(data)
    } else if (data instanceof Uint8Array) {
      chunk = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    } else if (data instanceof ArrayBuffer) {
      chunk = Buffer.from(data)
    } else {
      ack(false, 'missing_data')
      return
    }
    if (!chunk.length) {
      ack(false, 'empty_data')
      return
    }
    const offset = Number(payload.offset)
    const normalizedOffset = Number.isFinite(offset) && offset >= 0 ? Math.floor(offset) : stream.bytes
    const expectedBytes = Number(payload.bytes)
    if (Number.isFinite(expectedBytes) && expectedBytes >= 0 && Math.floor(expectedBytes) !== chunk.byteLength) {
      ack(false, 'byte_count_mismatch', normalizedOffset, chunk.byteLength)
      return
    }
    const checksum = crc32(chunk)
    const expectedChecksum = Number(payload.crc32)
    if (Number.isFinite(expectedChecksum) && expectedChecksum >= 0 && (Math.floor(expectedChecksum) >>> 0) !== checksum) {
      ack(false, 'crc_mismatch', normalizedOffset, chunk.byteLength, checksum)
      return
    }
    const existing = stream.chunks.find(part => part.offset === normalizedOffset)
    if (existing) {
      if (existing.chunk.equals(chunk)) {
        ack(true, undefined, normalizedOffset, chunk.byteLength, checksum)
        return
      }
      ack(false, 'offset_conflict', normalizedOffset, chunk.byteLength, checksum)
      return
    }
    if (normalizedOffset !== stream.bytes) {
      logger.warn({
        clientId,
        interactionId: stream.interactionId,
        expectedOffset: stream.bytes,
        actualOffset: normalizedOffset,
        bytes: chunk.byteLength,
      }, '[global-agent] rejecting out-of-order MCU voice stream chunk')
      ack(false, 'out_of_order', normalizedOffset, chunk.byteLength, checksum)
      return
    }
    stream.chunks.push({ offset: normalizedOffset, chunk, seq: normalizedSeq, crc32: checksum })
    stream.bytes += chunk.byteLength
    ack(true, undefined, normalizedOffset, chunk.byteLength, checksum)
  }

  private async handleMcuVoiceStreamEnd(clientId: string, payload: Record<string, unknown>): Promise<void> {
    const stream = this.mcuVoiceStreams.get(clientId)
    if (!stream) {
      this.emitMcuEvent({ type: 'interaction.status', status: 'failed', text: 'missing voice stream metadata' }, { clientId })
      return
    }
    const interactionId = typeof payload.interactionId === 'string' ? payload.interactionId.trim() : ''
    if (interactionId && interactionId !== stream.interactionId) {
      logger.warn({
        clientId,
        streamInteractionId: stream.interactionId,
        endInteractionId: interactionId,
      }, '[global-agent] ignoring MCU voice stream end for stale interaction')
      return
    }
    this.mcuVoiceStreams.delete(clientId)
    const expectedBytes = Number(payload.bytes)
    const sortedChunks = [...stream.chunks].sort((a, b) => a.offset - b.offset)
    let expectedOffset = 0
    for (const part of sortedChunks) {
      if (part.offset !== expectedOffset) {
        logger.warn({
          clientId,
          interactionId: stream.interactionId,
          expectedOffset,
          actualOffset: part.offset,
          receivedBytes: stream.bytes,
          expectedBytes: Number.isFinite(expectedBytes) ? expectedBytes : undefined,
        }, '[global-agent] MCU voice stream has a chunk gap')
        this.emitMcuEvent({
          type: 'interaction.status',
          interactionId: stream.interactionId,
          status: 'failed',
          text: 'voice stream chunk gap',
        }, { clientId })
        return
      }
      expectedOffset += part.chunk.byteLength
    }
    logger.info({
      clientId,
      bytes: stream.bytes,
      expectedBytes,
      interactionId: stream.interactionId,
      mimeType: stream.mimeType,
    }, '[global-agent] MCU voice stream completed')
    if (Number.isFinite(expectedBytes) && expectedBytes >= 0 && stream.bytes !== expectedBytes) {
      logger.warn({
        clientId,
        interactionId: stream.interactionId,
        bytes: stream.bytes,
        expectedBytes,
      }, '[global-agent] MCU voice stream byte count mismatch')
      this.emitMcuEvent({
        type: 'interaction.status',
        interactionId: stream.interactionId,
        status: 'failed',
        text: 'voice stream incomplete',
      }, { clientId })
      return
    }
    if (!stream.bytes) {
      this.emitMcuEvent({
        type: 'interaction.status',
        interactionId: stream.interactionId,
        status: 'failed',
        text: 'empty voice stream',
      }, { clientId })
      return
    }
    let pcm: Buffer
    try {
      if (stream.mimeType === 'audio/x-ima-adpcm' || stream.mimeType === 'audio/ima-adpcm') {
        const decodedChunks = sortedChunks.map(({ chunk }) => {
          const decoded = decodeMcuImaAdpcm(chunk)
          if (decoded.sampleRate !== stream.sampleRate) {
            throw new Error(`IMA-ADPCM sample rate ${decoded.sampleRate} does not match stream rate ${stream.sampleRate}`)
          }
          if (decoded.channels !== stream.channels) {
            throw new Error(`IMA-ADPCM channels ${decoded.channels} do not match stream channels ${stream.channels}`)
          }
          return decoded.pcm
        })
        pcm = Buffer.concat(decodedChunks)
      } else {
        pcm = Buffer.concat(sortedChunks.map(part => part.chunk), stream.bytes)
      }
    } catch (err) {
      logger.warn({ err, clientId, interactionId: stream.interactionId }, '[global-agent] MCU voice stream decode failed')
      this.emitMcuEvent({
        type: 'interaction.status',
        interactionId: stream.interactionId,
        status: 'failed',
        text: err instanceof Error ? err.message : 'voice stream decode failed',
      }, { clientId })
      return
    }
    const wav = this.wrapPcmAsWav(pcm, stream.sampleRate, stream.channels, stream.bitsPerSample)
    try {
      const response = await this.fetchImpl(`${this.localBaseUrl}/api/studio/mcu/voice-turn`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${stream.userToken}`,
          'Content-Type': 'audio/wav',
          'X-Hermes-Mcu-Interaction-Id': stream.interactionId,
          'X-Hermes-Mcu-Device-Id': clientId,
          'X-Hermes-Mcu-Agent-Runtime': stream.agentRuntime,
          'X-Hermes-Profile': stream.profile,
        },
        body: new Uint8Array(wav),
      })
      const text = await response.text()
      let body: Record<string, unknown> = {}
      try {
        body = text ? JSON.parse(text) as Record<string, unknown> : {}
      } catch {
        body = { error: text }
      }
      if (!response.ok || body.ok === false) {
        if (body.ok === false && await this.enqueuePromptAudioFromVoiceTurn(clientId, stream.interactionId, body)) return
        this.emitMcuEvent({
          type: 'interaction.status',
          interactionId: stream.interactionId,
          status: 'failed',
          text: typeof body.error === 'string' ? body.error : `voice turn failed: ${response.status}`,
        }, { clientId })
      }
    } catch (err) {
      this.emitMcuEvent({
        type: 'interaction.status',
        interactionId: stream.interactionId,
        status: 'failed',
        text: err instanceof Error ? err.message : String(err),
      }, { clientId })
    }
  }

  private handleMcuVoiceStreamAbort(clientId: string, payload: Record<string, unknown>): void {
    const stream = this.mcuVoiceStreams.get(clientId)
    const payloadInteractionId = typeof payload.interactionId === 'string' ? payload.interactionId.trim() : ''
    if (stream && payloadInteractionId && payloadInteractionId !== stream.interactionId) {
      logger.warn({
        clientId,
        streamInteractionId: stream.interactionId,
        abortInteractionId: payloadInteractionId,
      }, '[global-agent] ignoring MCU voice stream abort for stale interaction')
      return
    }
    this.mcuVoiceStreams.delete(clientId)
    const interactionId = payloadInteractionId
      ? payloadInteractionId
      : stream?.interactionId
    const reason = typeof payload.reason === 'string' && payload.reason.trim()
      ? payload.reason.trim()
      : 'aborted'
    this.emitMcuEvent({
      type: 'interaction.status',
      interactionId,
      status: 'failed',
      text: `voice stream ${reason}`,
    }, { clientId })
  }

  private async enqueuePromptAudioFromVoiceTurn(clientId: string, interactionId: string, payload: Record<string, unknown>): Promise<boolean> {
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

    this.emitMcuEvent({ type: 'interaction.status', interactionId, status: 'speaking', text }, { clientId })
    this.emitMcuEvent({
      type: 'audio.enqueue',
      interactionId,
      segmentId,
      text,
      url,
      mimeType,
      channels,
      sampleRate,
      durationMs,
    }, { clientId })
    return true
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

  private resolveClient(clientId?: string): Socket | null {
    if (clientId) return this.clients.get(clientId) || null
    return this.clients.values().next().value || null
  }

  private canAccessProfile(user: AuthenticatedUser, profile: string): boolean {
    return user.role === 'super_admin' || userCanAccessProfile(user.id, profile)
  }

  private frontendProfile(socket: Socket): string {
    return String(socket.data.profile || '').trim()
  }

  private withFrontendHttpAuth(socket: Socket, request: RelayHttpRequest): RelayHttpRequest {
    const headers = { ...(request.headers || {}) }
    headers.authorization = `Bearer ${socket.data.userToken}`
    const profile = this.frontendProfile(socket)
    if (profile) headers['x-hermes-profile'] = profile
    return { ...request, headers }
  }

  private withFrontendSocketAuth(socket: Socket, request: RelaySocketOpenRequest): RelaySocketOpenRequest {
    const profile = this.frontendProfile(socket)
    return {
      ...request,
      auth: {
        ...(request.auth || {}),
        token: socket.data.userToken,
      },
      query: {
        ...(request.query || {}),
        ...(profile ? { profile } : {}),
      },
    }
  }

  private withFrontendSocketPayload(socket: Socket, request: RelaySocketEventRequest): RelaySocketEventRequest {
    const profile = this.frontendProfile(socket)
    if (!profile || !request.payload || typeof request.payload !== 'object' || Array.isArray(request.payload)) {
      return request
    }
    const payload = request.payload as Record<string, unknown>
    return {
      ...request,
      payload: {
        ...payload,
        profile: typeof payload.profile === 'string' && payload.profile ? payload.profile : profile,
      },
    }
  }

  private frontendOwnsBridge(socket: Socket, id?: string): boolean {
    const bridgeId = String(id || '').trim()
    return Boolean(bridgeId) && this.bridgeOwners.get(bridgeId) === socket.id
  }

  private frontendBridgeId(socket: Socket): string {
    return `frontend:${socket.id}:chat-run`
  }

  private async ensureFrontendChatBridge(socket: Socket): Promise<string | null> {
    const id = this.frontendBridgeId(socket)
    if (this.bridgeOwners.get(id) === socket.id) return id

    const response = await this.openSocket(this.withFrontendSocketAuth(socket, {
      id,
      namespace: '/chat-run',
      stream: true,
    }))
    if (response.error) {
      socket.emit('connect_error', new Error(response.error.message))
      return null
    }
    this.bridgeOwners.set(id, socket.id)
    return id
  }

  private async emitFrontendChatEvent(socket: Socket, event: string, payload: unknown): Promise<void> {
    const id = await this.ensureFrontendChatBridge(socket)
    if (!id) return
    const response = await this.emitSocketEvent(this.withFrontendSocketPayload(socket, {
      id,
      event,
      payload,
    }))
    if (response.error) {
      const sessionId = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? String((payload as Record<string, unknown>).session_id || '')
        : ''
      socket.emit('run.failed', {
        event: 'run.failed',
        ...(sessionId ? { session_id: sessionId } : {}),
        error: response.error.message,
      })
    }
  }

  private emitFrontendBridgeEvent(_clientId: string, event: unknown): void {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return
    const record = event as {
      id?: unknown
      event?: unknown
      payload?: unknown
    }
    const bridgeId = typeof record.id === 'string' ? record.id : ''
    const eventName = typeof record.event === 'string' ? record.event : ''
    if (!bridgeId || !eventName) return
    if (SOCKET_IO_RESERVED_EVENTS.has(eventName)) return
    const ownerSocketId = this.bridgeOwners.get(bridgeId)
    if (!ownerSocketId) return
    this.frontendClients.get(ownerSocketId)?.emit(eventName, record.payload)
  }

  private emitFrontendSessionCommand(payload: Record<string, unknown>): void {
    for (const socket of this.frontendClients.values()) {
      socket.emit('session.command', payload)
    }
  }

  private emitWithAck<T extends { id?: string; ok?: boolean; error?: { code: string; message: string } }>(
    socket: Socket,
    event: string,
    payload: unknown,
    requestedTimeoutMs: number | undefined,
    id: string | undefined,
  ): Promise<T> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve(responseError<T>(id, 'global_agent_timeout', `Global agent request timed out after ${timeoutMs(requestedTimeoutMs)}ms`))
      }, timeoutMs(requestedTimeoutMs))
      socket.emit(event, payload, (response: T) => {
        clearTimeout(timer)
        resolve(response)
      })
    })
  }
}

let activeGlobalAgentServer: GlobalAgentServer | null = null

export function getActiveGlobalAgentServer(): GlobalAgentServer | null {
  return activeGlobalAgentServer
}

export function startGlobalAgentServer(io: Server, options: StartGlobalAgentServerOptions = {}): GlobalAgentServer {
  if (activeGlobalAgentServer) return activeGlobalAgentServer
  activeGlobalAgentServer = new GlobalAgentServer(io, options)
  activeGlobalAgentServer.init()
  return activeGlobalAgentServer
}

export function getGlobalAgentServer(): GlobalAgentServer | null {
  return activeGlobalAgentServer
}
