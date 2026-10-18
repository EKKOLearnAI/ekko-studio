import { createServer, type Server as HttpServer } from 'http'
import { DatabaseSync } from 'node:sqlite'
import { io as clientIo, type Socket as ClientSocket } from 'socket.io-client'
import { vi } from 'vitest'
import '../../packages/server/src/bootstrap/group-chat-agent-runtime-adapter'

const groupChatDbMock = vi.hoisted(() => ({ current: null as DatabaseSync | null }))
const groupChatAuthMock = vi.hoisted(() => ({
  enabled: false,
  user: null as any,
}))

vi.mock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
  getDb: () => groupChatDbMock.current,
  isSqliteAvailable: () => groupChatDbMock.current !== null,
}))
vi.mock('../../packages/server/src/modules/studio/middleware/auth', () => ({
  requireAdmin: vi.fn(async (_ctx: unknown, next: () => Promise<void>) => next()),
  requireSuperAdmin: vi.fn(async (_ctx: unknown, next: () => Promise<void>) => next()),
  inspectAppUserToken: vi.fn(async () => null),
  isAuthEnabled: vi.fn(async () => groupChatAuthMock.enabled),
  authenticateUserToken: vi.fn(async () => groupChatAuthMock.user),
}))

import { initAllHermesTables } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import { GroupChatServer } from '../../packages/server/src/modules/studio/sockets/group-chat'

export function once<T = any>(socket: ClientSocket, event: string, timeoutMs = 2_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs)
    socket.once(event, (payload: T) => { clearTimeout(timer); resolve(payload) })
  })
}

export function emitAck<T = any>(socket: ClientSocket, event: string, payload: unknown, timeoutMs = 2_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event} ack`)), timeoutMs)
    socket.emit(event, payload, (response: T) => { clearTimeout(timer); resolve(response) })
  })
}

async function listen(server: HttpServer): Promise<number> {
  return await new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('missing port')
      resolve(address.port)
    })
  })
}

export async function connectGroupChatClient(
  port: number,
  userId: string,
  name: string,
  auth: Record<string, unknown> = {},
): Promise<ClientSocket> {
  const socket = clientIo(`http://127.0.0.1:${port}/group-chat`, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    auth: { userId, name, ...auth },
  })
  return await once<ClientSocket>(socket as any, 'connect').then(() => socket)
}

export async function rejectGroupChatClient(
  port: number,
  auth: Record<string, unknown>,
): Promise<string> {
  const socket = clientIo(`http://127.0.0.1:${port}/group-chat`, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    auth,
  })
  try {
    return await once<Error>(socket as any, 'connect_error').then(error => error.message)
  } finally {
    socket.disconnect()
  }
}

export async function createTestGroupChatServer(options: { authEnabled?: boolean } = {}): Promise<{
  db: DatabaseSync
  httpServer: HttpServer
  groupServer: GroupChatServer
  port: number
  sockets: ClientSocket[]
  cleanup: () => void
}> {
  groupChatAuthMock.enabled = options.authEnabled === true
  groupChatAuthMock.user = null
  const db = new DatabaseSync(':memory:')
  groupChatDbMock.current = db
  initAllHermesTables()
  const httpServer = createServer()
  const groupServer = new GroupChatServer(httpServer)
  const port = await listen(httpServer)
  const sockets: ClientSocket[] = []
  return {
    db,
    httpServer,
    groupServer,
    port,
    sockets,
    cleanup: () => {
      for (const socket of sockets) socket.disconnect()
      groupServer.getIO().close()
      httpServer.close()
      db.close()
      groupChatDbMock.current = null
      groupChatAuthMock.enabled = false
      groupChatAuthMock.user = null
      sockets.length = 0
    },
  }
}
