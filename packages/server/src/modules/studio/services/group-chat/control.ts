import { io } from 'socket.io-client'
import type { AuthenticatedUser } from '../../public/auth'
import { config } from '../../public/config'
import { getGroupChatRuntimeServer } from './runtime'
import { canReadGroupChatRoom } from './access'

export function readableRoom(user: AuthenticatedUser | undefined, roomId: string) {
  if (!user) throw Object.assign(new Error('Studio login required'), { status: 401 })
  const server = getGroupChatRuntimeServer()
  if (!server) throw Object.assign(new Error('Group chat is unavailable'), { status: 503 })
  const storage = server.getStorage()
  if (!storage.getRoom(roomId)) throw Object.assign(new Error('Room not found'), { status: 404 })
  if (!canReadGroupChatRoom(storage, roomId, user)) throw Object.assign(new Error('Access denied'), { status: 403 })
  return storage
}

/** Reuse the authenticated transport so mentions, membership and interrupt ownership
 * follow exactly the same rules as interactive chat. Never accept a caller identity. */
export async function groupChatOperation(token: string, roomId: string, operation: 'message' | 'interrupt_agent', input: Record<string, unknown>, signal: AbortSignal) {
  signal.throwIfAborted()
  const base = (process.env.HERMES_WEB_UI_URL || `http://127.0.0.1:${config.port}`).replace(/\/$/, '')
  const socket = io(`${base}/group-chat`, { auth: { token }, reconnection: false, autoConnect: false, timeout: 10_000 })
  let abort: (() => void) | undefined
  const canceled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
  })
  const check = (value: any) => {
    if (value?.error) throw Object.assign(new Error(String(value.error)), { status: value.error === 'Access denied' ? 403 : 400 })
    return value
  }
  try {
    const work = (async () => {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect()
      })
      signal.throwIfAborted()
      check(await socket.timeout(10_000).emitWithAck('join', { roomId, historyLimit: 1 }))
      signal.throwIfAborted()
      return check(await socket.timeout(30_000).emitWithAck(operation, { ...input, roomId }))
    })()
    return await Promise.race([work, canceled])
  } finally {
    if (abort) signal.removeEventListener('abort', abort)
    socket.disconnect(); socket.removeAllListeners()
  }
}

export function roomMessages(user: AuthenticatedUser | undefined, roomId: string, query: Record<string, unknown>) {
  const storage = readableRoom(user, roomId)
  const offset = Math.max(0, Math.floor(Number(query.offset) || 0))
  const limit = Math.min(150, Math.max(1, Math.floor(Number(query.limit) || 50)))
  const before = typeof query.before === 'string' ? query.before : undefined
  const page = before ? storage.getHistoryPageForUI(roomId, limit, before) : null
  if (page && !page.cursorFound) throw Object.assign(new Error('History cursor not found'), { status: 400 })
  const messages = page?.messages ?? storage.getRecentMessagesForUI(roomId, limit, offset)
  const total = storage.getMessageCount(roomId)
  return { messages, total, offset, limit, hasMore: page?.hasMore ?? offset + messages.length < total }
}
