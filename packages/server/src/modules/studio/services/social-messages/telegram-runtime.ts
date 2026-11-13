import { createHash } from 'crypto'
import {
  deleteSocialMessageRuntimeState,
  readSocialMessageRuntimeState,
  writeSocialMessageRuntimeState,
} from '../../repositories/social-message-store'
import { logger } from '../../public/logging'
import { notifyFirstSocialMessageBinding } from './binding-notification'
import type { StoredTelegramCredentials } from './credentials'

export interface TelegramRecipient {
  chatId: string
  chatType: string
  title?: string
  username?: string
  displayName?: string
  lastSeenAt: string
}

interface StoredTelegramPeer {
  chatType: string
  title?: string
  username?: string
  displayName?: string
  lastSeenAt: string
}

interface TelegramRuntimeState {
  version: 1
  offset: number
  peers: Record<string, StoredTelegramPeer>
}

interface TelegramChat {
  id?: number | string
  type?: string
  title?: string
  username?: string
  first_name?: string
  last_name?: string
}

interface TelegramMessage {
  chat?: TelegramChat
  from?: { is_bot?: boolean }
}

interface TelegramUpdate {
  update_id?: number
  message?: TelegramMessage
  channel_post?: TelegramMessage
}

interface TelegramUpdatesResponse {
  ok?: boolean
  description?: string
  error_code?: number
  result?: TelegramUpdate[]
}

interface ActiveRuntime {
  key: string
  controller: AbortController
  task: Promise<void>
  status: 'running' | 'error'
  lastError?: string
}

const LONG_POLL_SECONDS = 30
const ERROR_RETRY_MS = 5_000
const runtimes = new Map<number, ActiveRuntime>()

function tokenStorageKey(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 24)
}

function emptyState(): TelegramRuntimeState {
  return { version: 1, offset: 0, peers: {} }
}

function normalizeState(value: unknown): TelegramRuntimeState {
  if (!value || typeof value !== 'object') return emptyState()
  const source = value as Record<string, any>
  const peers: Record<string, StoredTelegramPeer> = {}
  for (const [chatId, value] of Object.entries(source.peers || {})) {
    if (!chatId.trim() || !value || typeof value !== 'object') continue
    const peer = value as Record<string, unknown>
    peers[chatId] = {
      chatType: typeof peer.chatType === 'string' ? peer.chatType : '',
      ...(typeof peer.title === 'string' && peer.title ? { title: peer.title } : {}),
      ...(typeof peer.username === 'string' && peer.username ? { username: peer.username } : {}),
      ...(typeof peer.displayName === 'string' && peer.displayName ? { displayName: peer.displayName } : {}),
      lastSeenAt: typeof peer.lastSeenAt === 'string' ? peer.lastSeenAt : new Date(0).toISOString(),
    }
  }
  return {
    version: 1,
    offset: Number.isSafeInteger(source.offset) && source.offset >= 0 ? source.offset : 0,
    peers,
  }
}

function readState(userId: number, token: string): TelegramRuntimeState {
  return normalizeState(readSocialMessageRuntimeState(userId, 'telegram', tokenStorageKey(token)))
}

function writeState(userId: number, token: string, state: TelegramRuntimeState): void {
  writeSocialMessageRuntimeState(
    userId,
    'telegram',
    tokenStorageKey(token),
    state as unknown as Record<string, unknown>,
  )
}

function runtimeKey(credentials: StoredTelegramCredentials): string {
  return createHash('sha256').update(credentials.botToken).digest('hex')
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

function peerFromMessage(message: TelegramMessage | undefined): StoredTelegramPeer | undefined {
  const chat = message?.chat
  const chatId = String(chat?.id ?? '').trim()
  if (!chatId || (message?.from?.is_bot && chat?.type !== 'channel')) return undefined
  const displayName = [chat?.first_name, chat?.last_name]
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .join(' ')
  return {
    chatType: String(chat?.type || '').trim(),
    ...(String(chat?.title || '').trim() ? { title: String(chat?.title).trim() } : {}),
    ...(String(chat?.username || '').trim() ? { username: String(chat?.username).trim() } : {}),
    ...(displayName ? { displayName } : {}),
    lastSeenAt: new Date().toISOString(),
  }
}

function responseError(response: Response, payload: TelegramUpdatesResponse): string | null {
  if (response.ok && payload.ok === true) return null
  const detail = payload.description || `HTTP ${response.status}`
  return payload.error_code ? `${detail} (${payload.error_code})` : detail
}

async function run(userId: number, credentials: StoredTelegramCredentials, runtime: ActiveRuntime): Promise<void> {
  const signal = runtime.controller.signal
  let state = readState(userId, credentials.botToken)
  while (!signal.aborted) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${credentials.botToken}/getUpdates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          offset: state.offset,
          timeout: LONG_POLL_SECONDS,
          allowed_updates: ['message', 'channel_post'],
        }),
        signal,
      })
      const payload = await response.json() as TelegramUpdatesResponse
      const error = responseError(response, payload)
      if (error) throw new Error(error)
      if (signal.aborted) break

      runtime.status = 'running'
      runtime.lastError = undefined
      const updates = Array.isArray(payload.result) ? payload.result : []
      if (!updates.length) continue

      let bindingRecipient = ''
      for (const update of updates) {
        if (Number.isSafeInteger(update.update_id)) {
          state.offset = Math.max(state.offset, Number(update.update_id) + 1)
        }
        const message = update.message || update.channel_post
        const peer = peerFromMessage(message)
        const chatId = String(message?.chat?.id ?? '').trim()
        if (chatId && peer) {
          state.peers[chatId] = peer
          if (!bindingRecipient) bindingRecipient = chatId
        }
      }
      writeState(userId, credentials.botToken, state)
      if (bindingRecipient) {
        await notifyFirstSocialMessageBinding({
          userId,
          platform: 'telegram',
          recipient: bindingRecipient,
          recipientType: 'chat_id',
        })
      }
    } catch (error) {
      if (signal.aborted) break
      runtime.status = 'error'
      runtime.lastError = error instanceof Error ? error.message : String(error)
      logger.warn('[social-messages] Telegram poll failed userId=%s: %s', userId, runtime.lastError)
      await delay(ERROR_RETRY_MS, signal)
      state = readState(userId, credentials.botToken)
    }
  }
}

export function ensureTelegramRuntime(userId: number, credentials: StoredTelegramCredentials): void {
  const key = runtimeKey(credentials)
  const existing = runtimes.get(userId)
  if (existing?.key === key && !existing.controller.signal.aborted) return
  existing?.controller.abort()

  const controller = new AbortController()
  const runtime: ActiveRuntime = {
    key,
    controller,
    task: Promise.resolve(),
    status: 'running',
  }
  runtime.task = run(userId, credentials, runtime).catch(error => {
    if (controller.signal.aborted) return
    runtime.status = 'error'
    runtime.lastError = error instanceof Error ? error.message : String(error)
    logger.error(error, '[social-messages] Telegram runtime stopped userId=%s', userId)
  })
  runtimes.set(userId, runtime)
}

export async function listTelegramRecipients(
  userId: number,
  credentials: StoredTelegramCredentials,
): Promise<{ recipients: TelegramRecipient[]; runtimeStatus: 'running' | 'error'; runtimeError?: string }> {
  ensureTelegramRuntime(userId, credentials)
  const state = readState(userId, credentials.botToken)
  const runtime = runtimes.get(userId)
  return {
    recipients: Object.entries(state.peers)
      .map(([chatId, peer]) => ({ chatId, ...peer }))
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)),
    runtimeStatus: runtime?.status || 'running',
    ...(runtime?.lastError ? { runtimeError: runtime.lastError } : {}),
  }
}

export async function stopTelegramRuntime(userId: number): Promise<void> {
  const runtime = runtimes.get(userId)
  if (!runtime) return
  runtimes.delete(userId)
  runtime.controller.abort()
  await runtime.task.catch(() => undefined)
}

export function resetTelegramRuntimeState(userId: number, botToken: string): void {
  deleteSocialMessageRuntimeState(userId, 'telegram', tokenStorageKey(botToken))
}

export async function shutdownTelegramRuntimes(): Promise<void> {
  await Promise.all([...runtimes.keys()].map(userId => stopTelegramRuntime(userId)))
}
