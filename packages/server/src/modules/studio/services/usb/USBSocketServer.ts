import type { Server, Socket } from 'socket.io'
import { authenticateUserToken, isAuthEnabled } from '../../middleware/auth'
import { logger } from '../../public/logging'
import { getUSBService } from './index'
import type { USBDeviceRecord, USBEventRecord, USBServiceRuntimeStatus } from './USBDevice'
import type { USBService } from './USBService'

const USB_NAMESPACE = '/usb'
const USB_STREAM_ROOM = 'usb:stream'

interface USBSubscribeRequest {
  since?: string | null
}

interface USBSocketAck<T> {
  ok: boolean
  data?: T
  error?: string
}

type Ack<T> = (response: USBSocketAck<T>) => void

function safeAck<T>(ack: Ack<T> | undefined, response: USBSocketAck<T>): void {
  if (typeof ack === 'function') ack(response)
}

export interface USBSubscribeResponse {
  runtime: USBServiceRuntimeStatus
  devices: USBDeviceRecord[]
  events: USBEventRecord[]
}

export class USBSocketServer {
  private readonly nsp: ReturnType<Server['of']>
  private readonly service: USBService
  private readonly onReadyBound: (payload: { ts: string, existingDevices: USBDeviceRecord[], runtime: USBServiceRuntimeStatus }) => void
  private readonly onHeartbeatBound: (payload: { ts: string, deviceCount: number, runtime: USBServiceRuntimeStatus }) => void
  private readonly onDeviceEventBound: (event: USBEventRecord) => void

  constructor(io: Server, service: USBService = getUSBService()) {
    this.service = service
    this.nsp = io.of(USB_NAMESPACE)
    this.onReadyBound = this.emitReady.bind(this)
    this.onHeartbeatBound = this.emitHeartbeat.bind(this)
    this.onDeviceEventBound = this.emitDeviceEvent.bind(this)
    this.service.on('ready', this.onReadyBound)
    this.service.on('heartbeat', this.onHeartbeatBound)
    this.service.on('device_event', this.onDeviceEventBound)
  }

  init(): void {
    this.nsp.use(this.authMiddleware.bind(this))
    this.nsp.on('connection', this.onConnection.bind(this))
    logger.info('[usb-socket] Socket.IO ready at /usb')
  }

  close(): void {
    this.service.off('ready', this.onReadyBound)
    this.service.off('heartbeat', this.onHeartbeatBound)
    this.service.off('device_event', this.onDeviceEventBound)
  }

  private async authMiddleware(socket: Socket, next: (err?: Error) => void): Promise<void> {
    if (!await isAuthEnabled()) {
      next()
      return
    }
    const token = socket.handshake.auth?.token as string | undefined
    const user = await authenticateUserToken(token || '')
    if (!user) {
      next(new Error('Authentication failed'))
      return
    }
    socket.data.user = user
    next()
  }

  private onConnection(socket: Socket): void {
    socket.on('usb.subscribe', (request: USBSubscribeRequest | Ack<USBSubscribeResponse> | undefined, ack?: Ack<USBSubscribeResponse>) => {
      const callback = typeof request === 'function' ? request : ack
      const payload = typeof request === 'function' ? {} : request || {}
      this.handleSubscribe(socket, payload, callback)
    })

    socket.on('usb.unsubscribe', (ack?: Ack<{ ok: true }>) => {
      void socket.leave(USB_STREAM_ROOM)
      safeAck(ack, { ok: true, data: { ok: true } })
    })
  }

  private handleSubscribe(socket: Socket, request: USBSubscribeRequest, ack?: Ack<USBSubscribeResponse>): void {
    const since = typeof request.since === 'string' && request.since.trim() ? request.since.trim() : '24h'
    void socket.join(USB_STREAM_ROOM)
    safeAck(ack, {
      ok: true,
      data: {
        runtime: this.service.status(),
        devices: this.service.listDevices(),
        events: this.service.listHistory(since),
      },
    })
  }

  private emitReady(payload: { ts: string, existingDevices: USBDeviceRecord[], runtime: USBServiceRuntimeStatus }): void {
    this.nsp.to(USB_STREAM_ROOM).emit('usb.ready', payload)
  }

  private emitHeartbeat(payload: { ts: string, deviceCount: number, runtime: USBServiceRuntimeStatus }): void {
    this.nsp.to(USB_STREAM_ROOM).emit('usb.heartbeat', payload)
  }

  private emitDeviceEvent(event: USBEventRecord): void {
    this.nsp.to(USB_STREAM_ROOM).emit('usb.device_event', event)
  }
}
