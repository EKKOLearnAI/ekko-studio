import { io, type Socket } from 'socket.io-client'
import { getApiKey, getBaseUrlValue } from '../client'
import { socketEndpoint } from '@/utils/deployment-url'

export type USBDeviceStatus = 'mounted' | 'mount_failed' | 'removed'

export interface USBDeviceRecord {
  uuid: string
  deviceNode: string
  mountPoint: string
  fsType: string | null
  label: string | null
  vendor: string | null
  model: string | null
  serial: string | null
  sizeBytes: number | null
  status: USBDeviceStatus
  error: string | null
  ts: string
}

export interface USBEventRecord {
  id: string
  uuid: string
  deviceNode: string
  action: 'add' | 'remove'
  mountPoint: string | null
  fsType: string | null
  label: string | null
  status: string
  error: string | null
  ts: number
}

export interface USBServiceRuntimeStatus {
  state: 'idle' | 'starting' | 'running' | 'unsupported' | 'error' | 'stopped'
  monitorScriptPath: string
  lastReadyAt: string | null
  lastHeartbeatAt: string | null
  lastError: string | null
}

export interface USBReadyPayload {
  ts: string
  existingDevices: USBDeviceRecord[]
  runtime: USBServiceRuntimeStatus
}

export interface USBHeartbeatPayload {
  ts: string
  deviceCount: number
  runtime: USBServiceRuntimeStatus
}

export interface USBSubscribeResponse {
  runtime: USBServiceRuntimeStatus
  devices: USBDeviceRecord[]
  events: USBEventRecord[]
}

interface SocketAck<T> {
  ok: boolean
  data?: T
  error?: string
}

let socket: Socket | null = null

function connectUSBSocket(): Socket {
  if (socket) return socket
  const endpoint = socketEndpoint(getBaseUrlValue(), '/usb')
  socket = io(endpoint.url, {
    path: endpoint.path,
    auth: { token: getApiKey() },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 30000,
    randomizationFactor: 0.5,
    timeout: 30000,
  })
  return socket
}

export function disconnectUSBSocket(): void {
  socket?.disconnect()
  socket = null
}

function emitWithAck<TRequest, TResponse>(event: string, request: TRequest): Promise<TResponse> {
  const activeSocket = connectUSBSocket()
  return new Promise((resolve, reject) => {
    activeSocket.timeout(30000).emit(event, request, (err: Error | null, response: SocketAck<TResponse>) => {
      if (err) {
        reject(err)
        return
      }
      if (!response?.ok) {
        reject(new Error(response?.error || `${event} failed`))
        return
      }
      resolve(response.data as TResponse)
    })
  })
}

export async function subscribeUSBStream(since = '24h'): Promise<USBSubscribeResponse> {
  return emitWithAck<{ since: string }, USBSubscribeResponse>('usb.subscribe', { since })
}

export async function unsubscribeUSBStream(): Promise<void> {
  await emitWithAck<Record<string, never>, { ok: true }>('usb.unsubscribe', {})
}

export function onUSBReady(handler: (payload: USBReadyPayload) => void): () => void {
  const activeSocket = connectUSBSocket()
  activeSocket.on('usb.ready', handler)
  return () => activeSocket.off('usb.ready', handler)
}

export function onUSBHeartbeat(handler: (payload: USBHeartbeatPayload) => void): () => void {
  const activeSocket = connectUSBSocket()
  activeSocket.on('usb.heartbeat', handler)
  return () => activeSocket.off('usb.heartbeat', handler)
}

export function onUSBDeviceEvent(handler: (event: USBEventRecord) => void): () => void {
  const activeSocket = connectUSBSocket()
  activeSocket.on('usb.device_event', handler)
  return () => activeSocket.off('usb.device_event', handler)
}

export function onUSBSocketConnect(handler: () => void): () => void {
  const activeSocket = connectUSBSocket()
  activeSocket.on('connect', handler)
  return () => activeSocket.off('connect', handler)
}

export function onUSBSocketDisconnect(handler: () => void): () => void {
  const activeSocket = connectUSBSocket()
  activeSocket.on('disconnect', handler)
  return () => activeSocket.off('disconnect', handler)
}
