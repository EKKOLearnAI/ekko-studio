import * as lark from '@larksuiteoapi/node-sdk'
import { createHash } from 'crypto'
import {
  deleteSocialMessageRuntimeState,
  readSocialMessageRuntimeState,
  updateSocialMessageRuntimeState,
} from '../../repositories/social-message-store'
import { logger } from '../../public/logging'
import { notifyFirstSocialMessageBinding } from './binding-notification'
import type { StoredFeishuCredentials } from './credentials'

export interface FeishuRecipient {
  chatId: string
  chatType: string
  lastSeenAt: string
}

interface StoredFeishuPeer {
  chatType: string
  lastSeenAt: string
}

interface FeishuRuntimeState {
  version: 1
  appId: string
  peers: Record<string, StoredFeishuPeer>
}

interface FeishuMessageEvent {
  sender?: {
    sender_type?: string
  }
  message?: {
    chat_id?: string
    chat_type?: string
  }
}

interface ActiveRuntime {
  key: string
  client: lark.WSClient
  status: 'running' | 'error'
  lastError?: string
}

const runtimes = new Map<number, ActiveRuntime>()

function appStorageKey(appId: string): string {
  return createHash('sha256').update(appId).digest('hex').slice(0, 24)
}

function emptyState(appId: string): FeishuRuntimeState {
  return { version: 1, appId, peers: {} }
}

function normalizeState(value: unknown, appId: string): FeishuRuntimeState {
  if (!value || typeof value !== 'object') return emptyState(appId)
  const source = value as Record<string, any>
  const peers: Record<string, StoredFeishuPeer> = {}
  for (const [chatId, value] of Object.entries(source.peers || {})) {
    if (!chatId.trim() || !value || typeof value !== 'object') continue
    const peer = value as Record<string, unknown>
    peers[chatId] = {
      chatType: typeof peer.chatType === 'string' ? peer.chatType : '',
      lastSeenAt: typeof peer.lastSeenAt === 'string' ? peer.lastSeenAt : new Date(0).toISOString(),
    }
  }
  return { version: 1, appId, peers }
}

async function readState(userId: number, appId: string): Promise<FeishuRuntimeState> {
  return normalizeState(readSocialMessageRuntimeState(userId, 'feishu', appStorageKey(appId)), appId)
}

async function recordRecipient(
  userId: number,
  appId: string,
  event: FeishuMessageEvent,
): Promise<{ chatId: string } | undefined> {
  const senderType = String(event.sender?.sender_type || '').trim()
  if (senderType && senderType !== 'user') return
  const chatId = String(event.message?.chat_id || '').trim()
  if (!chatId) return
  updateSocialMessageRuntimeState(userId, 'feishu', appStorageKey(appId), current => {
    const state = normalizeState(current, appId)
    state.peers[chatId] = {
      chatType: String(event.message?.chat_type || '').trim(),
      lastSeenAt: new Date().toISOString(),
    }
    return state as unknown as Record<string, unknown>
  })
  return { chatId }
}

function runtimeKey(credentials: StoredFeishuCredentials): string {
  return createHash('sha256')
    .update(`${credentials.appId}\0${credentials.appSecret}`)
    .digest('hex')
}

export function ensureFeishuRuntime(userId: number, credentials: StoredFeishuCredentials): void {
  const key = runtimeKey(credentials)
  const existing = runtimes.get(userId)
  if (existing?.key === key) return
  existing?.client.close({ force: true })

  let runtime: ActiveRuntime
  const dispatcher = new lark.EventDispatcher({})
  dispatcher.register({
    'im.message.receive_v1': async (event: FeishuMessageEvent) => {
      if (runtimes.get(userId) !== runtime) return
      try {
        const recipient = await recordRecipient(userId, credentials.appId, event)
        if (recipient) {
          await notifyFirstSocialMessageBinding({
            userId,
            platform: 'feishu',
            recipient: recipient.chatId,
            recipientType: 'chat_id',
          })
        }
      } catch (error) {
        runtime.status = 'error'
        runtime.lastError = error instanceof Error ? error.message : String(error)
        logger.warn('[social-messages] Failed to persist Feishu recipient userId=%s: %s', userId, runtime.lastError)
      }
    },
  })

  const client = new lark.WSClient({
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    domain: lark.Domain.Feishu,
    source: 'hermes-studio-social-messages',
    extraUaTags: ['channel'],
    handshakeTimeoutMs: 15_000,
    onReady: () => {
      if (runtimes.get(userId) !== runtime) return
      runtime.status = 'running'
      runtime.lastError = undefined
    },
    onReconnected: () => {
      if (runtimes.get(userId) !== runtime) return
      runtime.status = 'running'
      runtime.lastError = undefined
    },
    onError: error => {
      if (runtimes.get(userId) !== runtime) return
      runtime.status = 'error'
      runtime.lastError = error.message
      logger.warn('[social-messages] Feishu receiver failed userId=%s: %s', userId, error.message)
    },
  })
  runtime = { key, client, status: 'running' }
  runtimes.set(userId, runtime)
  void client.start({ eventDispatcher: dispatcher }).catch(error => {
    if (runtimes.get(userId) !== runtime) return
    runtime.status = 'error'
    runtime.lastError = error instanceof Error ? error.message : String(error)
    logger.warn('[social-messages] Feishu receiver failed to start userId=%s: %s', userId, runtime.lastError)
  })
}

export async function listFeishuRecipients(
  userId: number,
  credentials: StoredFeishuCredentials,
): Promise<{ recipients: FeishuRecipient[]; runtimeStatus: 'running' | 'error'; runtimeError?: string }> {
  ensureFeishuRuntime(userId, credentials)
  const state = await readState(userId, credentials.appId)
  const runtime = runtimes.get(userId)
  return {
    recipients: Object.entries(state.peers)
      .map(([chatId, peer]) => ({ chatId, chatType: peer.chatType, lastSeenAt: peer.lastSeenAt }))
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)),
    runtimeStatus: runtime?.status || 'running',
    ...(runtime?.lastError ? { runtimeError: runtime.lastError } : {}),
  }
}

export function stopFeishuRuntime(userId: number): void {
  const runtime = runtimes.get(userId)
  if (!runtime) return
  runtimes.delete(userId)
  runtime.client.close({ force: true })
}

export async function resetFeishuRuntimeState(userId: number, appId: string): Promise<void> {
  deleteSocialMessageRuntimeState(userId, 'feishu', appStorageKey(appId))
}

export function shutdownFeishuRuntimes(): void {
  for (const userId of [...runtimes.keys()]) stopFeishuRuntime(userId)
}
