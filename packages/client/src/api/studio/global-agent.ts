import { socketEndpoint } from '@/utils/deployment-url'
import { io, type Socket } from 'socket.io-client'
import { getApiKey, getBaseUrlValue, getActiveProfileName } from '../client'
import type { RunEvent, StartRunRequest } from './chat'

export interface GlobalAgentSocketOpenRequest {
  id: string
  namespace: '/chat-run'
  stream?: boolean
}

export interface GlobalAgentSocketCommand {
  id: string
  event: 'run' | 'resume' | 'abort' | 'cancel_queued_run' | 'insert_queued_run' | 'approval.respond' | 'clarify.respond'
  stream?: boolean
  payload?: unknown
}

export interface GlobalAgentAck {
  id?: string
  ok?: boolean
  namespace?: string
  event?: string
  stream?: boolean
  error?: {
    code: string
    message: string
  }
}

export interface GlobalAgentSocketEvent {
  clientId?: string
  payload?: {
    id?: string
    namespace?: string
    event?: string
    payload?: RunEvent
  }
}

let socket: Socket | null = null
let socketProfile: string | null = null

function activeProfile(profile?: string | null): string {
  return profile || getActiveProfileName() || 'default'
}

export function connectGlobalAgent(profile?: string | null): Socket {
  const nextProfile = activeProfile(profile)
  if (socket && socket.connected && socketProfile === nextProfile) return socket
  if (socket) {
    socket.disconnect()
    socket = null
  }

  socketProfile = nextProfile
  socket = io(socketEndpoint(getBaseUrlValue(), '/global-agent').url, {
    path: socketEndpoint(getBaseUrlValue(), '/global-agent').path,
    auth: {
      token: getApiKey(),
      profile: nextProfile,
    },
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

export function disconnectGlobalAgent(): void {
  socket?.disconnect()
  socket = null
  socketProfile = null
}

function emitWithAck<TRequest, TResponse>(
  event: string,
  request: TRequest,
  profile?: string | null,
): Promise<TResponse> {
  const activeSocket = connectGlobalAgent(profile)
  return new Promise((resolve, reject) => {
    activeSocket.timeout(30000).emit(event, request, (err: Error | null, response: TResponse) => {
      if (err) {
        reject(err)
        return
      }
      const maybeAck = response as GlobalAgentAck
      if (maybeAck?.error) {
        reject(new Error(maybeAck.error.message))
        return
      }
      resolve(response)
    })
  })
}

export function openGlobalAgentChatRun(
  request: GlobalAgentSocketOpenRequest,
  profile?: string | null,
): Promise<GlobalAgentAck> {
  return emitWithAck('socket.open', request, profile)
}

export function emitGlobalAgentChatRun(
  request: GlobalAgentSocketCommand,
  profile?: string | null,
): Promise<GlobalAgentAck> {
  return emitWithAck('socket.event', request, profile)
}

export function closeGlobalAgentChatRun(id: string, profile?: string | null): Promise<GlobalAgentAck> {
  return emitWithAck('socket.close', { id }, profile)
}

export function startGlobalAgentRun(
  bridgeId: string,
  body: StartRunRequest,
  options: {
    profile?: string | null
    stream?: boolean
  } = {},
): Promise<GlobalAgentAck> {
  return emitGlobalAgentChatRun({
    id: bridgeId,
    event: 'run',
    stream: options.stream,
    payload: body,
  }, options.profile)
}
