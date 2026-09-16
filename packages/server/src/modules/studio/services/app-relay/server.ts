import type { Server as SocketIoServer, Socket } from 'socket.io'
import { io as createClientSocket, type Socket as ClientSocket } from 'socket.io-client'
import { authenticateUserToken, inspectAppUserToken } from '../../middleware/auth'
import { config } from '../../public/config'
import { logger } from '../../public/logging'
import { getDeviceId } from '../../public/system-info'
import type { AppConnectionType } from '../../repositories/app-connections-store'
import {
  inspectAppEntitlementToken,
  verifyAppEntitlementToken,
  type AppEntitlementClaims,
  type AppEntitlementInspection,
} from '../auth/app-entitlement'
import type {
  AppRelayHttpRequest,
  AppRelayHttpDownloadRequest,
  AppRelayHttpDownloadResponse,
  AppRelayHttpResponse,
  AppRelaySocketCloseRequest,
  AppRelaySocketEventRequest,
  AppRelaySocketOpenRequest,
  AppRelaySocketResponse,
} from './client'
import {
  RELAY_DOWNLOAD_CHUNK_BYTES,
  RelayDownloadSessionError,
  RelayDownloadSessions,
} from './download-session'

const APP_RELAY_NAMESPACE = '/app-relay'
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const MAX_REQUEST_TIMEOUT_MS = 120_000
const MAX_MEDIA_REQUEST_TIMEOUT_MS = 5 * 60 * 1000
const MAX_REQUEST_BODY_BYTES = 20 * 1024 * 1024
const MAX_RESPONSE_BODY_BYTES = 20 * 1024 * 1024

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])
const ALLOWED_REQUEST_HEADERS = new Set([
  'accept',
  'accept-language',
  'authorization',
  'content-type',
  'if-match',
  'if-none-match',
  'range',
  'x-hermes-profile',
  'x-request-id',
])
const ALLOWED_CHAT_RUN_CLIENT_EVENTS = new Set([
  'app.events.subscribe',
  'app.events.unsubscribe',
  'run',
  'resume',
  'app.resume',
  'abort',
  'insert_queued_run',
  'cancel_queued_run',
  'approval.respond',
  'clarify.respond',
  'calendar.respond',
  'reminder.respond',
  'location.respond',
  'health.respond',
])
const ALLOWED_GROUP_CHAT_CLIENT_EVENTS = new Set([
  'join',
  'load_pending_approvals',
  'load_messages',
  'update_member_profile',
  'message',
  'typing',
  'stop_typing',
  'interrupt_agent',
  'remove_agent',
  'approval.respond',
  'clarify.respond',
])
const ALLOWED_WORKFLOW_CLIENT_EVENTS = new Set([
  'workflows.list',
  'workflow.status.subscribe',
  'workflow.status.unsubscribe',
])
const ALLOWED_TERMINAL_CLIENT_EVENTS = new Set(['terminal.capabilities', 'terminal.list', 'terminal.create', 'terminal.attach', 'terminal.read', 'terminal.input', 'terminal.resize', 'terminal.detach', 'terminal.close'])
const ALLOWED_SOCKET_NAMESPACES = new Set(['/terminal', '/chat-run', '/group-chat', '/workflow'])
const NON_STREAMING_SUPPRESSED_EVENTS = new Set([
  'message.delta',
  'message.interim',
  'reasoning.delta',
  'thinking.delta',
  'reasoning.available',
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

interface LocalAppRelayServerOptions {
  localBaseUrl?: string
  machineId?: string
  fetchImpl?: typeof fetch
  entitlementRequired?: boolean
  verifyEntitlementToken?: (token: string) => AppEntitlementClaims | null
  inspectEntitlementToken?: (token: string) => AppEntitlementInspection
}

export interface AppEntitlementFailure {
  code: string
  deviceCode: string
  cloudUserId: number
  plan: string
  tokenTtlSeconds?: number
  occurredAt: number
}

interface LocalSocketBridge {
  key: string
  id: string
  namespace: string
  ownerSocketId: string
  socket: ClientSocket
  stream: boolean
  output: string
  reasoning: string
}

type NormalizedBody = {
  body?: BodyInit
  contentType?: string
}

/**
 * Serves the App-facing relay protocol directly from Ekko Studio.
 *
 * The cloud relay uses the same App events but forwards them through the
 * outbound AppRelayClient. On a LAN connection this server terminates those
 * events locally and talks to the loopback HTTP and /chat-run services without
 * an extra host-client hop.
 */
export class LocalAppRelayServer {
  private readonly namespace: ReturnType<SocketIoServer['of']>
  private readonly bridges = new Map<string, LocalSocketBridge>()
  private readonly appSockets = new Map<string, Socket>()
  private readonly downloadSessions = new RelayDownloadSessions()
  private readonly localBaseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly configuredMachineId: string
  private readonly entitlementRequired: boolean
  private readonly verifyEntitlementToken: (token: string) => AppEntitlementClaims | null
  private readonly inspectEntitlementToken: (token: string) => AppEntitlementInspection
  private latestEntitlementFailure: AppEntitlementFailure | null = null
  private initialized = false

  constructor(io: SocketIoServer, options: LocalAppRelayServerOptions = {}) {
    this.namespace = io.of(APP_RELAY_NAMESPACE)
    this.localBaseUrl = (options.localBaseUrl || `http://127.0.0.1:${config.port}`).replace(/\/$/, '')
    this.configuredMachineId = String(options.machineId || '').trim()
    this.fetchImpl = options.fetchImpl || fetch
    this.entitlementRequired = options.entitlementRequired ?? config.appRelay.entitlementRequired
    this.verifyEntitlementToken = options.verifyEntitlementToken || verifyAppEntitlementToken
    this.inspectEntitlementToken = options.inspectEntitlementToken
      || (options.verifyEntitlementToken
        ? (token: string) => {
            const claims = this.verifyEntitlementToken(token)
            return claims ? { status: 'valid', claims } : { status: 'invalid', claims: null }
          }
        : inspectAppEntitlementToken)
  }

  init(): void {
    if (this.initialized) return
    this.initialized = true
    this.namespace.use(async (socket, next) => {
      try {
        const auth = socket.handshake.auth || {}
        const role = String(auth.role || '').trim().toLowerCase()
        const machineId = normalizeIdentifier(auth.machineId || auth.machine_id || auth.instanceId)
        const localMachineId = this.configuredMachineId || await getDeviceId()
        const token = String(auth.token || '').trim()
        const entitlementToken = String(
          auth.entitlementToken
          || auth.entitlement_token
          || auth.accessLease
          || auth.access_lease
          || '',
        ).trim()
        if (role !== 'app' || !machineId || machineId !== localMachineId) {
          next(new Error('app_relay_unauthorized'))
          return
        }
        const declaredDeviceCode = normalizeIdentifier(auth.deviceCode || auth.device_code)
        const declaredCloudUserId = normalizePositiveInteger(auth.cloudUserId || auth.cloud_user_id)
        const entitlementInspection = entitlementToken ? this.inspectEntitlementToken(entitlementToken) : null
        const entitlement = entitlementInspection?.status === 'valid' ? entitlementInspection.claims : null
        if (entitlementInspection?.status === 'expired' && entitlementInspection.claims) {
          this.recordEntitlementFailure(
            'app_entitlement_expired',
            declaredDeviceCode || entitlementInspection.claims.deviceCode,
            declaredCloudUserId || entitlementInspection.claims.userId,
            entitlementInspection.claims.plan,
            Math.max(0, entitlementInspection.claims.expiresAt - entitlementInspection.claims.issuedAt),
          )
          next(new Error('app_entitlement_expired'))
          return
        }
        if (entitlementToken && !entitlement) {
          this.recordEntitlementFailure('app_entitlement_invalid', declaredDeviceCode, declaredCloudUserId, '')
          next(new Error('app_entitlement_invalid'))
          return
        }
        if (this.entitlementRequired && !entitlement) {
          this.recordEntitlementFailure('app_entitlement_required', declaredDeviceCode, declaredCloudUserId, '')
          next(new Error('app_entitlement_required'))
          return
        }
        if (entitlement && (!declaredDeviceCode || declaredDeviceCode !== entitlement.deviceCode)) {
          this.recordEntitlementFailure('app_entitlement_device_mismatch', declaredDeviceCode, declaredCloudUserId, entitlement.plan)
          next(new Error('app_entitlement_device_mismatch'))
          return
        }
        if (entitlement && declaredCloudUserId && declaredCloudUserId !== entitlement.userId) {
          this.recordEntitlementFailure('app_entitlement_account_mismatch', declaredDeviceCode, declaredCloudUserId, entitlement.plan)
          next(new Error('app_entitlement_account_mismatch'))
          return
        }
        const appToken = token ? await inspectAppUserToken(token) : null
        if (appToken?.status === 'revoked') {
          next(new Error('app_connection_deleted'))
          return
        }
        const user = appToken?.status === 'active' && appToken.user
          ? appToken.user
          : token && !appToken
            ? await authenticateUserToken(token)
            : null
        if (token && !user) {
          next(new Error('app_relay_unauthorized'))
          return
        }
        if (entitlement && appToken?.status === 'active' && appToken.deviceCode !== entitlement.deviceCode) {
          this.recordEntitlementFailure('app_entitlement_device_mismatch', declaredDeviceCode, declaredCloudUserId, entitlement.plan)
          next(new Error('app_entitlement_device_mismatch'))
          return
        }
        socket.data.appRelayRole = 'app'
        socket.data.machineId = localMachineId
        socket.data.localUser = user
        socket.data.localUserToken = token
        socket.data.appEntitlement = entitlement
        socket.data.appCloudUserId = entitlement?.userId || declaredCloudUserId
        if (appToken?.status === 'active') {
          socket.data.appDeviceCode = appToken.deviceCode
          socket.data.appConnectionType = appToken.connectionType
        } else if (entitlement) {
          socket.data.appDeviceCode = entitlement.deviceCode
        }
        if (entitlement) this.clearEntitlementFailure(entitlement.deviceCode, entitlement.userId)
        next()
      } catch (err) {
        logger.warn({ err }, '[app-relay:lan] socket authentication failed')
        next(new Error('app_relay_auth_failed'))
      }
    })
    this.namespace.on('connection', socket => this.onConnection(socket))
    logger.info('[app-relay:lan] Socket.IO ready at %s', APP_RELAY_NAMESPACE)
  }

  getNamespace(): string {
    return APP_RELAY_NAMESPACE
  }

  getLatestEntitlementFailure(now = Date.now()): AppEntitlementFailure | null {
    const failure = this.latestEntitlementFailure
    if (!failure || now - failure.occurredAt > 30 * 60 * 1000) return null
    return { ...failure }
  }

  isConnectionOnline(deviceCode: string, connectionType: AppConnectionType): boolean {
    return Array.from(this.appSockets.values()).some(socket => (
      socket.connected
      && socket.data.appDeviceCode === deviceCode
      && socket.data.appConnectionType === connectionType
    ))
  }

  notifyConnectionDeleted(deviceCode: string, connectionType: AppConnectionType): number {
    const sockets = Array.from(this.appSockets.values()).filter(socket => (
      socket.connected
      && socket.data.appDeviceCode === deviceCode
      && socket.data.appConnectionType === connectionType
    ))
    for (const socket of sockets) {
      socket.emit('relay.connection.deleted', {
        machineId: socket.data.machineId,
        deviceCode,
        connectionType,
      })
      setImmediate(() => socket.disconnect(true))
    }
    return sockets.length
  }

  private onConnection(socket: Socket): void {
    this.appSockets.set(socket.id, socket)
    const machineId = String(socket.data.machineId)
    socket.emit('relay.ready', {
      role: 'app',
      machineId,
      hostConnected: true,
      capabilities: ['http.request', 'http.download.chunked', 'socket.chat-run', 'socket.group-chat', 'socket.workflow', 'app.entitlement'],
    })
    if (socket.data.localUserToken) this.scheduleTokenExpiry(socket)
    if (socket.data.appEntitlement) this.scheduleEntitlementExpiry(socket)

    socket.on('http.request', (request: AppRelayHttpRequest = {}, ack?: (response: AppRelayHttpResponse) => void) => {
      void this.handleHttpRequest(socket, request).then(response => ack?.(response))
    })
    socket.on('http.download.chunk', (
      request: AppRelayHttpDownloadRequest = {},
      ack?: (response: AppRelayHttpDownloadResponse) => void,
    ) => {
      void this.readHttpDownloadChunk(socket, request).then(response => ack?.(response))
    })
    socket.on('http.download.cancel', (
      request: AppRelayHttpDownloadRequest = {},
      ack?: (response: AppRelayHttpDownloadResponse) => void,
    ) => {
      const id = normalizeBridgeId(request.id)
      const cancelled = id ? this.downloadSessions.cancel(socket.id, id) : false
      ack?.(cancelled ? { id, done: true } : downloadError(request.id, 'download_not_found', 'Download session was not found'))
    })
    socket.on('socket.open', (request: AppRelaySocketOpenRequest = {}, ack?: (response: AppRelaySocketResponse) => void) => {
      void this.openSocket(socket, request).then(response => ack?.(response))
    })
    socket.on('socket.event', (request: AppRelaySocketEventRequest = {}, ack?: (response: AppRelaySocketResponse) => void) => {
      void this.emitSocketEvent(socket, request).then(response => ack?.(response))
    })
    socket.on('socket.close', (request: AppRelaySocketCloseRequest = {}, ack?: (response: AppRelaySocketResponse) => void) => {
      ack?.(this.closeSocket(socket, request))
    })
    socket.on('disconnect', () => {
      this.appSockets.delete(socket.id)
      this.downloadSessions.cancelOwner(socket.id)
      this.closeOwnerBridges(socket.id)
    })
  }

  private async handleHttpRequest(socket: Socket, request: AppRelayHttpRequest): Promise<AppRelayHttpResponse> {
    const method = normalizeMethod(request.method)
    if (!method) return httpError(request.id, 'method_not_allowed', 'Relay request method is not allowed', 405)
    const path = normalizeRelayPath(request.path)
    if (!path) return httpError(request.id, 'path_not_allowed', 'Relay request path is not allowed', 403)

    const appLoginRequest = method === 'POST' && path === '/api/auth/app-login'
    const loginRequest = method === 'POST' && (path === '/api/auth/login' || appLoginRequest)
    const entitlement = socket.data.appEntitlement as AppEntitlementClaims | null | undefined
    if (appLoginRequest && entitlement) {
      const loginDeviceCode = relayRequestIdentifier(request.body, 'device_code', 'deviceCode')
      if (!loginDeviceCode || loginDeviceCode !== entitlement.deviceCode) {
        return httpError(request.id, 'app_entitlement_device_mismatch', 'The App device does not match its cloud entitlement', 403)
      }
      const loginCloudUserId = relayRequestPositiveInteger(request.body, 'cloud_user_id', 'cloudUserId')
      if (loginCloudUserId && loginCloudUserId !== entitlement.userId) {
        return httpError(request.id, 'app_entitlement_account_mismatch', 'The App account does not match its cloud entitlement', 403)
      }
    }
    const authenticated = Boolean(socket.data.localUserToken) && await this.authorized(socket)
    if (!authenticated && !loginRequest) {
      return httpError(request.id, 'app_relay_unauthorized', 'Log in to Ekko Studio before using the App relay', 401)
    }

    const headers = normalizeHeaders(request.headers)
    headers.delete('authorization')
    if (appLoginRequest) headers.set('x-hermes-app-connection', 'lan')
    if (authenticated) headers.set('authorization', `Bearer ${socket.data.localUserToken}`)
    const normalizedBody = normalizeRequestBody(request, method, headers)
    if (isHttpErrorResponse(normalizedBody)) return normalizedBody
    if (normalizedBody.contentType) headers.set('content-type', normalizedBody.contentType)

    const timeoutMs = normalizeHttpTimeout(request)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await this.fetchImpl(`${this.localBaseUrl}${path}`, {
        method,
        headers,
        body: normalizedBody.body,
        signal: controller.signal,
      })
      if (
        request.streamBinary === true
        && !isTextualResponse(response)
        && response.ok
        && response.body
      ) {
        return {
          id: request.id,
          status: response.status,
          headers: responseHeaders(response),
          download: this.downloadSessions.create(socket.id, response),
        }
      }
      const responseBody = await readResponseBody(response)
      if (loginRequest && response.ok && typeof responseBody.body === 'string') {
        await this.promoteLogin(socket, responseBody.body)
      }
      return {
        id: request.id,
        status: response.status,
        headers: responseHeaders(response),
        ...responseBody,
      }
    } catch (err) {
      const aborted = controller.signal.aborted
      return httpError(
        request.id,
        aborted ? 'request_timeout' : 'local_request_failed',
        aborted ? `Local request timed out after ${timeoutMs}ms` : err instanceof Error ? err.message : String(err),
        aborted ? 504 : 502,
      )
    } finally {
      clearTimeout(timer)
    }
  }

  private async readHttpDownloadChunk(
    socket: Socket,
    request: AppRelayHttpDownloadRequest,
  ): Promise<AppRelayHttpDownloadResponse> {
    if (!await this.authorized(socket)) {
      return downloadError(request.id, 'app_relay_unauthorized', 'The App relay session is no longer authorized', 401)
    }
    const id = normalizeBridgeId(request.id)
    if (!id) return downloadError(request.id, 'invalid_download_id', 'Download session id is required')
    try {
      return await this.downloadSessions.read(
        socket.id,
        id,
        Number(request.maxBytes) || RELAY_DOWNLOAD_CHUNK_BYTES,
      )
    } catch (error) {
      const code = error instanceof RelayDownloadSessionError ? error.code : 'download_failed'
      logger.warn({
        err: error,
        errorCode: code,
        downloadId: id,
        ...(error instanceof RelayDownloadSessionError ? error.diagnostic : {}),
        ...(error instanceof RelayDownloadSessionError && error.causeMessage
          ? { causeMessage: error.causeMessage }
          : {}),
      }, '[app-relay:lan] download chunk read failed')
      return downloadError(id, code, 'Unable to read the next download chunk')
    }
  }

  private async openSocket(socket: Socket, request: AppRelaySocketOpenRequest): Promise<AppRelaySocketResponse> {
    if (!await this.authorized(socket)) {
      return socketError(request.id, 'app_relay_unauthorized', 'The App relay session is no longer authorized')
    }
    const id = normalizeBridgeId(request.id)
    if (!id) return socketError(request.id, 'invalid_socket_id', 'A socket bridge id is required')
    const namespace = String(request.namespace || '').trim()
    if (!ALLOWED_SOCKET_NAMESPACES.has(namespace)) return socketError(id, 'namespace_not_allowed', 'Relay socket namespace is not allowed')

    this.closeSocket(socket, { id })
    const localSocket = createClientSocket(`${this.localBaseUrl}${namespace}`, {
      auth: {
        ...normalizeSocketAuth(request.auth),
        token: socket.data.localUserToken,
      },
      query: normalizeSocketQuery(request.query),
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30_000,
      timeout: 30_000,
    })
    const bridge: LocalSocketBridge = {
      key: bridgeKey(socket.id, id),
      id,
      namespace,
      ownerSocketId: socket.id,
      socket: localSocket,
      stream: typeof request.stream === 'boolean' ? request.stream : true,
      output: '',
      reasoning: '',
    }
    this.bridges.set(bridge.key, bridge)
    localSocket.on('connect', () => this.forwardLocalSocketEvent(socket, bridge, 'connect', { socketId: localSocket.id }))
    localSocket.on('connect_error', (err: Error) => this.forwardLocalSocketEvent(socket, bridge, 'connect_error', { message: err.message }))
    localSocket.on('disconnect', (reason: string) => this.forwardLocalSocketEvent(socket, bridge, 'disconnect', { reason }))
    localSocket.onAny((event: string, ...args: unknown[]) => {
      this.handleLocalSocketEvent(socket, bridge, event, args.length <= 1 ? args[0] : args)
    })
    return { id, ok: true, namespace: bridge.namespace, stream: bridge.stream }
  }

  private async emitSocketEvent(socket: Socket, request: AppRelaySocketEventRequest): Promise<AppRelaySocketResponse> {
    if (!await this.authorized(socket)) {
      return socketError(request.id, 'app_relay_unauthorized', 'The App relay session is no longer authorized')
    }
    const id = normalizeBridgeId(request.id)
    if (!id) return socketError(request.id, 'invalid_socket_id', 'A socket bridge id is required')
    const event = String(request.event || '').trim()
    const bridge = this.bridges.get(bridgeKey(socket.id, id))
    if (!bridge) return socketError(id, 'socket_not_open', 'The chat socket bridge is not open')
    if (!isAllowedSocketEvent(bridge.namespace, event)) {
      return socketError(id, 'event_not_allowed', 'Relay socket event is not allowed')
    }
    if (typeof request.stream === 'boolean') bridge.stream = request.stream
    if (event === 'run') {
      bridge.output = ''
      bridge.reasoning = ''
    }
    if (!request.ack) {
      bridge.socket.emit(event, request.payload)
      return { id, ok: true, namespace: bridge.namespace, event, stream: bridge.stream }
    }
    try {
      const payload = await emitLocalSocketWithAck(bridge.socket, event, request.payload, normalizeTimeout(request.timeoutMs))
      return { id, ok: true, namespace: bridge.namespace, event, stream: bridge.stream, payload }
    } catch (error) {
      return socketError(id, 'socket_ack_timeout', error instanceof Error ? error.message : 'Socket acknowledgement timed out')
    }
  }

  private closeSocket(socket: Socket, request: AppRelaySocketCloseRequest): AppRelaySocketResponse {
    const id = normalizeBridgeId(request.id)
    if (!id) return socketError(request.id, 'invalid_socket_id', 'A socket bridge id is required')
    const key = bridgeKey(socket.id, id)
    const bridge = this.bridges.get(key)
    if (!bridge) return { id, ok: true }
    bridge.socket.disconnect()
    this.bridges.delete(key)
    return { id, ok: true, namespace: bridge.namespace }
  }

  private handleLocalSocketEvent(socket: Socket, bridge: LocalSocketBridge, event: string, payload: unknown): void {
    if (!bridge.stream) {
      if (event === 'message.delta' && isRecord(payload) && typeof payload.delta === 'string') {
        bridge.output += payload.delta
        return
      }
      if ((event === 'reasoning.delta' || event === 'thinking.delta') && isRecord(payload)) {
        bridge.reasoning += typeof payload.delta === 'string'
          ? payload.delta
          : typeof payload.text === 'string'
            ? payload.text
            : ''
        return
      }
      if (NON_STREAMING_SUPPRESSED_EVENTS.has(event)) return
      if (event === 'run.completed') {
        const completion = isRecord(payload) ? payload : {}
        this.forwardLocalSocketEvent(socket, bridge, event, {
          ...completion,
          output: typeof completion.output === 'string' && completion.output ? completion.output : bridge.output,
          ...(bridge.reasoning && typeof completion.reasoning !== 'string' ? { reasoning: bridge.reasoning } : {}),
        })
        return
      }
    }
    this.forwardLocalSocketEvent(socket, bridge, event, payload)
  }

  private forwardLocalSocketEvent(socket: Socket, bridge: LocalSocketBridge, event: string, payload: unknown): void {
    if (this.bridges.get(bridge.key) !== bridge || !socket.connected) return
    socket.emit('socket.event', {
      id: bridge.id,
      namespace: bridge.namespace,
      event,
      payload,
    })
  }

  private closeOwnerBridges(ownerSocketId: string): void {
    for (const bridge of Array.from(this.bridges.values())) {
      if (bridge.ownerSocketId !== ownerSocketId) continue
      bridge.socket.disconnect()
      this.bridges.delete(bridge.key)
    }
  }

  private async authorized(socket: Socket): Promise<boolean> {
    const entitlement = socket.data.appEntitlement as AppEntitlementClaims | null | undefined
    if (this.entitlementRequired && !entitlement) {
      this.revokeEntitlement(socket, 'entitlement_required')
      return false
    }
    if (entitlement && entitlement.expiresAt <= Math.floor(Date.now() / 1000)) {
      this.revokeEntitlement(socket, 'entitlement_expired')
      return false
    }
    const token = String(socket.data.localUserToken || '')
    const appToken = await inspectAppUserToken(token)
    if (appToken?.status === 'revoked') {
      socket.emit('relay.connection.deleted', {
        machineId: socket.data.machineId,
        deviceCode: appToken.deviceCode,
        connectionType: appToken.connectionType,
      })
      setImmediate(() => socket.disconnect(true))
      return false
    }
    if (entitlement && appToken?.status === 'active' && appToken.deviceCode !== entitlement.deviceCode) {
      this.revokeEntitlement(socket, 'entitlement_device_mismatch')
      return false
    }
    const user = appToken?.status === 'active' && appToken.user
      ? appToken.user
      : !appToken
        ? await authenticateUserToken(token)
        : null
    if (user) return true
    socket.emit('relay.access.revoked', {
      machineId: socket.data.machineId,
      reason: 'token_expired',
    })
    setImmediate(() => socket.disconnect(true))
    return false
  }

  private async promoteLogin(socket: Socket, responseBody: string): Promise<void> {
    try {
      const body = JSON.parse(responseBody) as Record<string, unknown>
      const token = String(body.token || '').trim()
      const appToken = token ? await inspectAppUserToken(token) : null
      const user = appToken?.status === 'active' && appToken.user
        ? appToken.user
        : token && !appToken
          ? await authenticateUserToken(token)
          : null
      if (!token || !user) return
      const entitlement = socket.data.appEntitlement as AppEntitlementClaims | null | undefined
      if (entitlement && appToken?.status === 'active' && appToken.deviceCode !== entitlement.deviceCode) {
        this.revokeEntitlement(socket, 'entitlement_device_mismatch')
        return
      }
      socket.data.localUserToken = token
      socket.data.localUser = user
      if (appToken?.status === 'active') {
        socket.data.appDeviceCode = appToken.deviceCode
        socket.data.appConnectionType = appToken.connectionType
      }
      this.scheduleTokenExpiry(socket)
    } catch {
      // A malformed success response is returned unchanged and does not
      // authenticate the relay session.
    }
  }

  private scheduleTokenExpiry(socket: Socket): void {
    const expiresAt = jwtExpiryMs(String(socket.data.localUserToken || ''))
    if (!expiresAt) return
    const existingTimer = socket.data.appRelayTokenExpiryTimer as NodeJS.Timeout | undefined
    if (existingTimer) clearTimeout(existingTimer)

    const schedule = () => {
      const remaining = expiresAt - Date.now()
      if (remaining <= 0) {
        socket.emit('relay.access.revoked', {
          machineId: socket.data.machineId,
          reason: 'token_expired',
        })
        socket.disconnect(true)
        return
      }
      const timer = setTimeout(schedule, Math.min(remaining, 2_147_000_000))
      timer.unref()
      socket.data.appRelayTokenExpiryTimer = timer
    }
    schedule()
    socket.once('disconnect', () => {
      const timer = socket.data.appRelayTokenExpiryTimer as NodeJS.Timeout | undefined
      if (timer) clearTimeout(timer)
      socket.data.appRelayTokenExpiryTimer = undefined
    })
  }

  private scheduleEntitlementExpiry(socket: Socket): void {
    const entitlement = socket.data.appEntitlement as AppEntitlementClaims | null | undefined
    if (!entitlement) return
    const expiresAt = entitlement.expiresAt * 1000
    const existingTimer = socket.data.appRelayEntitlementExpiryTimer as NodeJS.Timeout | undefined
    if (existingTimer) clearTimeout(existingTimer)

    const schedule = () => {
      const remaining = expiresAt - Date.now()
      if (remaining <= 0) {
        this.revokeEntitlement(socket, 'entitlement_expired', false)
        return
      }
      const timer = setTimeout(schedule, Math.min(remaining, 2_147_000_000))
      timer.unref()
      socket.data.appRelayEntitlementExpiryTimer = timer
    }
    schedule()
    socket.once('disconnect', () => {
      const timer = socket.data.appRelayEntitlementExpiryTimer as NodeJS.Timeout | undefined
      if (timer) clearTimeout(timer)
      socket.data.appRelayEntitlementExpiryTimer = undefined
    })
  }

  private revokeEntitlement(socket: Socket, reason: string, asyncDisconnect = true): void {
    if (reason.startsWith('entitlement_')) {
      const entitlement = socket.data.appEntitlement as AppEntitlementClaims | null | undefined
      this.recordEntitlementFailure(
        `app_${reason}`,
        String(entitlement?.deviceCode || socket.data.appDeviceCode || ''),
        Number(entitlement?.userId || socket.data.appCloudUserId || 0),
        String(entitlement?.plan || ''),
        entitlement
          ? Math.max(0, entitlement.expiresAt - entitlement.issuedAt)
          : undefined,
      )
    }
    socket.emit('relay.access.revoked', {
      machineId: socket.data.machineId,
      reason,
    })
    if (asyncDisconnect) setImmediate(() => socket.disconnect(true))
    else socket.disconnect(true)
  }

  private recordEntitlementFailure(
    code: string,
    deviceCode: string,
    cloudUserId: number,
    plan: string,
    tokenTtlSeconds?: number,
  ): void {
    this.latestEntitlementFailure = {
      code,
      deviceCode,
      cloudUserId,
      plan,
      ...(tokenTtlSeconds == null ? {} : { tokenTtlSeconds }),
      occurredAt: Date.now(),
    }
  }

  private clearEntitlementFailure(deviceCode: string, cloudUserId: number): void {
    const failure = this.latestEntitlementFailure
    if (!failure) return
    if (failure.deviceCode === deviceCode && (!failure.cloudUserId || failure.cloudUserId === cloudUserId)) {
      this.latestEntitlementFailure = null
    }
  }
}

let activeLocalAppRelayServer: LocalAppRelayServer | null = null

export function startLocalAppRelayServer(
  io: SocketIoServer,
  options: LocalAppRelayServerOptions = {},
): LocalAppRelayServer {
  if (activeLocalAppRelayServer) return activeLocalAppRelayServer
  activeLocalAppRelayServer = new LocalAppRelayServer(io, options)
  activeLocalAppRelayServer.init()
  return activeLocalAppRelayServer
}

export function isLocalAppConnectionOnline(
  deviceCode: string,
  connectionType: AppConnectionType,
): boolean {
  return activeLocalAppRelayServer?.isConnectionOnline(deviceCode, connectionType) || false
}

export function notifyLocalAppConnectionDeleted(
  deviceCode: string,
  connectionType: AppConnectionType,
): number {
  return activeLocalAppRelayServer?.notifyConnectionDeleted(deviceCode, connectionType) || 0
}

export function getLatestLocalAppEntitlementFailure(): AppEntitlementFailure | null {
  return activeLocalAppRelayServer?.getLatestEntitlementFailure() || null
}

function normalizeIdentifier(value: unknown): string {
  const normalized = String(value || '').trim()
  return normalized && normalized.length <= 255 ? normalized : ''
}

function normalizePositiveInteger(value: unknown): number {
  const normalized = Number(value)
  return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : 0
}

function relayRequestRecord(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value
  if (typeof value !== 'string' || value.length > MAX_REQUEST_BODY_BYTES) return null
  try {
    const parsed = JSON.parse(value)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function relayRequestIdentifier(value: unknown, ...keys: string[]): string {
  const record = relayRequestRecord(value)
  if (!record) return ''
  for (const key of keys) {
    const normalized = normalizeIdentifier(record[key])
    if (normalized) return normalized
  }
  return ''
}

function relayRequestPositiveInteger(value: unknown, ...keys: string[]): number {
  const record = relayRequestRecord(value)
  if (!record) return 0
  for (const key of keys) {
    const normalized = normalizePositiveInteger(record[key])
    if (normalized) return normalized
  }
  return 0
}

function normalizeMethod(value: unknown): string | null {
  const method = String(value || 'GET').trim().toUpperCase()
  return ALLOWED_METHODS.has(method) ? method : null
}

function normalizeRelayPath(value: unknown): string | null {
  const raw = String(value || '').trim()
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return null
  const parsed = new URL(raw, 'http://app-relay.local')
  if (
    parsed.pathname === '/api'
    || parsed.pathname.startsWith('/api/')
    || parsed.pathname === '/health'
  ) {
    return `${parsed.pathname}${parsed.search}`
  }
  return null
}

function normalizeHeaders(input: AppRelayHttpRequest['headers']): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(input || {})) {
    const lower = name.toLowerCase()
    if (!ALLOWED_REQUEST_HEADERS.has(lower) || value == null) continue
    const selected = Array.isArray(value) ? value.find(Boolean) : value
    if (selected) headers.set(lower, String(selected))
  }
  return headers
}

function normalizeRequestBody(
  request: AppRelayHttpRequest,
  method: string,
  headers: Headers,
): NormalizedBody | AppRelayHttpResponse {
  if (method === 'GET' || method === 'HEAD') return {}
  let body: BodyInit | undefined
  const byteBody = relayByteBuffer(request.bodyBytes)
  if (byteBody) body = Uint8Array.from(byteBody)
  else if (request.bodyBytes != null) return httpError(request.id, 'invalid_binary_body', 'Relay binary request body is invalid', 400)
  else if (typeof request.bodyBase64 === 'string') body = Buffer.from(request.bodyBase64, 'base64')
  else if (typeof request.body === 'string') body = request.body
  else if (request.body != null) {
    body = JSON.stringify(request.body)
    if (!headers.has('content-type')) headers.set('content-type', 'application/json')
  }
  if (body != null && Buffer.byteLength(typeof body === 'string' ? body : Buffer.from(body as any)) > MAX_REQUEST_BODY_BYTES) {
    return httpError(request.id, 'request_body_too_large', 'Relay request body exceeds the local size limit', 413)
  }
  return { body }
}

function isHttpErrorResponse(value: NormalizedBody | AppRelayHttpResponse): value is AppRelayHttpResponse {
  return 'error' in value && Boolean(value.error)
}

function responseHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'connection' || key.toLowerCase() === 'transfer-encoding') return
    headers[key.toLowerCase()] = value
  })
  return headers
}

async function readResponseBody(
  response: Response,
): Promise<Pick<AppRelayHttpResponse, 'body' | 'bodyBytes' | 'truncated'>> {
  if (!response.body) return {}
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  let truncated = false
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = Buffer.from(value)
    const remaining = MAX_RESPONSE_BODY_BYTES - total
    if (chunk.byteLength > remaining) {
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining))
      truncated = true
      await reader.cancel()
      break
    }
    chunks.push(chunk)
    total += chunk.byteLength
  }
  const buffer = Buffer.concat(chunks)
  const textual = isTextualResponse(response)
  return textual
    ? { body: buffer.toString('utf8'), truncated }
    : { bodyBytes: buffer, truncated }
}

function isTextualResponse(response: Response): boolean {
  if ((response.headers.get('content-disposition') || '').toLowerCase().includes('attachment')) return false
  const contentType = (response.headers.get('content-type') || '').toLowerCase()
  return TEXTUAL_RESPONSE_TYPES.some(prefix => contentType.startsWith(prefix) || contentType.includes(prefix))
}

function relayByteBuffer(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  return null
}

function normalizeBridgeId(value: unknown): string {
  const id = String(value || '').trim()
  return id && id.length <= 128 ? id : ''
}

function normalizeSocketAuth(value: AppRelaySocketOpenRequest['auth']): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value || {}).filter(([, item]) => item != null))
}

function normalizeSocketQuery(value: AppRelaySocketOpenRequest['query']): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value || {})
      .filter(([, item]) => item != null)
      .map(([key, item]) => [key, String(item)]),
  )
}

function normalizeTimeout(value: unknown): number {
  const timeout = Number(value)
  if (!Number.isFinite(timeout) || timeout <= 0) return DEFAULT_REQUEST_TIMEOUT_MS
  return Math.min(Math.floor(timeout), MAX_REQUEST_TIMEOUT_MS)
}

function normalizeHttpTimeout(request: AppRelayHttpRequest): number {
  const timeout = Number(request.timeoutMs)
  if (!Number.isFinite(timeout) || timeout <= 0) return DEFAULT_REQUEST_TIMEOUT_MS
  const maxTimeout = isMediaHttpRequest(request)
    ? MAX_MEDIA_REQUEST_TIMEOUT_MS
    : MAX_REQUEST_TIMEOUT_MS
  return Math.min(Math.floor(timeout), maxTimeout)
}

function isMediaHttpRequest(request: AppRelayHttpRequest): boolean {
  if (request.streamBinary === true || request.bodyBytes != null || request.bodyBase64 != null) return true
  const path = String(request.path || '').split('?', 1)[0]
  return path === '/api/studio/app-uploads'
    || path.startsWith('/api/studio/app-uploads/')
    || /^\/api\/studio\/group-chat\/rooms\/[^/]+\/attachment-uploads(?:\/|$)/.test(path)
}

function isAllowedSocketEvent(namespace: string, event: string): boolean {
  if (namespace === '/terminal') return ALLOWED_TERMINAL_CLIENT_EVENTS.has(event)
  if (namespace === '/chat-run') return ALLOWED_CHAT_RUN_CLIENT_EVENTS.has(event)
  if (namespace === '/group-chat') return ALLOWED_GROUP_CHAT_CLIENT_EVENTS.has(event)
  if (namespace === '/workflow') return ALLOWED_WORKFLOW_CLIENT_EVENTS.has(event)
  return false
}

function emitLocalSocketWithAck(socket: ClientSocket, event: string, payload: unknown, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`Socket acknowledgement timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    socket.emit(event, payload, (...args: unknown[]) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(args.length <= 1 ? args[0] : args)
    })
  })
}

function bridgeKey(ownerSocketId: string, id: string): string {
  return `${ownerSocketId}:${id}`
}

function httpError(
  id: string | undefined,
  code: string,
  message: string,
  status?: number,
): AppRelayHttpResponse {
  return { id, ...(status ? { status } : {}), error: { code, message } }
}

function downloadError(
  id: string | undefined,
  code: string,
  message: string,
  status?: number,
): AppRelayHttpDownloadResponse {
  return { id, ...(status ? { status } : {}), error: { code, message } }
}

function socketError(id: string | undefined, code: string, message: string): AppRelaySocketResponse {
  return { id, ok: false, error: { code, message } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function jwtExpiryMs(token: string): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] || '', 'base64url').toString('utf8')) as Record<string, unknown>
    const expiresAt = Number(payload.exp) * 1000
    return Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : 0
  } catch {
    return 0
  }
}
