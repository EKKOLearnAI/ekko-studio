import { createHash } from 'crypto'
import {
  deleteSocialMessageRuntimeState,
  readSocialMessageRuntimeState,
  writeSocialMessageRuntimeState,
} from '../../repositories/social-message-store'
import type { StoredWeixinCredentials } from './credentials'
import { notifyFirstSocialMessageBinding } from './binding-notification'
import { weixinIlinkPost } from './weixin-ilink'
import { logger } from '../../public/logging'

export interface WeixinRecipient {
  userId: string
  lastSeenAt: string
  hasContextToken: boolean
}

interface StoredPeer {
  contextToken?: string
  lastSeenAt: string
}

interface WeixinRuntimeState {
  version: 1
  accountId: string
  syncBuf: string
  peers: Record<string, StoredPeer>
}

interface ActiveRuntime {
  key: string
  controller: AbortController
  task: Promise<void>
  status: 'running' | 'error'
  lastError?: string
}

const runtimes = new Map<number, ActiveRuntime>()

function accountStorageKey(accountId: string): string {
  return createHash('sha256').update(accountId).digest('hex').slice(0, 24)
}

function emptyState(accountId: string): WeixinRuntimeState {
  return { version: 1, accountId, syncBuf: '', peers: {} }
}

function hasSessionState(state: WeixinRuntimeState): boolean {
  return Boolean(state.syncBuf || Object.keys(state.peers).length)
}

async function readState(ownerUserId: number, accountId: string): Promise<WeixinRuntimeState> {
  const raw = readSocialMessageRuntimeState(
    ownerUserId,
    'weixin',
    accountStorageKey(accountId),
  ) as Record<string, any> | null
  const peers: Record<string, StoredPeer> = {}
  for (const [peerUserId, value] of Object.entries(raw?.peers || {})) {
    if (!peerUserId.trim() || !value || typeof value !== 'object') continue
    const peer = value as Record<string, unknown>
    peers[peerUserId] = {
      ...(typeof peer.contextToken === 'string' && peer.contextToken ? { contextToken: peer.contextToken } : {}),
      lastSeenAt: typeof peer.lastSeenAt === 'string' ? peer.lastSeenAt : new Date(0).toISOString(),
    }
  }
  return {
    version: 1,
    accountId,
    syncBuf: typeof raw?.syncBuf === 'string' ? raw.syncBuf : '',
    peers,
  }
}

async function writeState(userId: number, state: WeixinRuntimeState): Promise<void> {
  writeSocialMessageRuntimeState(
    userId,
    'weixin',
    accountStorageKey(state.accountId),
    state as unknown as Record<string, unknown>,
  )
}

function runtimeKey(credentials: StoredWeixinCredentials): string {
  return createHash('sha256')
    .update(`${credentials.accountId}\0${credentials.token}\0${credentials.baseUrl}`)
    .digest('hex')
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

function responseError(payload: Record<string, any>): string | null {
  const ret = payload.ret
  const errcode = payload.errcode
  if ((ret == null || ret === 0) && (errcode == null || errcode === 0)) return null
  return `${payload.errmsg || payload.msg || 'unknown error'} (ret=${ret ?? 0}, errcode=${errcode ?? 0})`
}

async function run(ownerUserId: number, credentials: StoredWeixinCredentials, runtime: ActiveRuntime): Promise<void> {
  const signal = runtime.controller.signal
  let state = await readState(ownerUserId, credentials.accountId)
  let timeoutMs = 35_000
  while (!signal.aborted) {
    try {
      const response = await weixinIlinkPost({
        baseUrl: credentials.baseUrl,
        endpoint: 'ilink/bot/getupdates',
        token: credentials.token,
        payload: { get_updates_buf: state.syncBuf },
        timeoutMs: Math.max(timeoutMs + 5_000, 40_000),
        signal,
      })
      if (signal.aborted) break
      if ((response.ret === -14 || response.errcode === -14) && hasSessionState(state)) {
        state = emptyState(credentials.accountId)
        await writeState(ownerUserId, state)
        runtime.status = 'running'
        runtime.lastError = undefined
        logger.info('[social-messages] Reset expired Weixin session userId=%s', ownerUserId)
        continue
      }
      const error = responseError(response)
      if (error) throw new Error(error)
      runtime.status = 'running'
      runtime.lastError = undefined
      if (Number.isFinite(response.longpolling_timeout_ms) && response.longpolling_timeout_ms > 0) {
        timeoutMs = Number(response.longpolling_timeout_ms)
      }
      const nextSyncBuf = typeof response.get_updates_buf === 'string' ? response.get_updates_buf : ''
      if (nextSyncBuf) state.syncBuf = nextSyncBuf
      const now = new Date().toISOString()
      let bindingRecipient: { userId: string; contextToken?: string } | undefined
      for (const message of Array.isArray(response.msgs) ? response.msgs : []) {
        if (!message || typeof message !== 'object') continue
        const peerUserId = String(message.from_user_id || '').trim()
        if (!peerUserId || peerUserId === credentials.accountId) continue
        const contextToken = String(message.context_token || '').trim()
        state.peers[peerUserId] = {
          ...(contextToken ? { contextToken } : state.peers[peerUserId]?.contextToken ? { contextToken: state.peers[peerUserId].contextToken } : {}),
          lastSeenAt: now,
        }
        if (!bindingRecipient) {
          bindingRecipient = {
            userId: peerUserId,
            ...(contextToken ? { contextToken } : {}),
          }
        }
      }
      await writeState(ownerUserId, state)
      if (bindingRecipient) {
        await notifyFirstSocialMessageBinding({
          userId: ownerUserId,
          platform: 'weixin',
          recipient: bindingRecipient.userId,
          recipientType: 'user_id',
          contextToken: bindingRecipient.contextToken,
        })
      }
    } catch (error) {
      if (signal.aborted) break
      runtime.status = 'error'
      runtime.lastError = error instanceof Error ? error.message : String(error)
      logger.warn('[social-messages] Weixin poll failed userId=%s: %s', ownerUserId, runtime.lastError)
      await delay(5_000, signal)
      state = await readState(ownerUserId, credentials.accountId).catch(() => state)
    }
  }
}

export function ensureWeixinRuntime(userId: number, credentials: StoredWeixinCredentials): void {
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
    logger.error(error, '[social-messages] Weixin runtime stopped userId=%s', userId)
  })
  runtimes.set(userId, runtime)
}

export async function stopWeixinRuntime(userId: number): Promise<void> {
  const runtime = runtimes.get(userId)
  if (!runtime) return
  runtimes.delete(userId)
  runtime.controller.abort()
  await runtime.task.catch(() => undefined)
}

export async function resetWeixinRuntimeState(userId: number, accountId: string): Promise<void> {
  deleteSocialMessageRuntimeState(userId, 'weixin', accountStorageKey(accountId))
}

export async function listWeixinRecipients(
  userId: number,
  credentials: StoredWeixinCredentials,
): Promise<{ recipients: WeixinRecipient[]; runtimeStatus: 'running' | 'error'; runtimeError?: string }> {
  ensureWeixinRuntime(userId, credentials)
  const state = await readState(userId, credentials.accountId)
  const runtime = runtimes.get(userId)
  return {
    recipients: Object.entries(state.peers)
      .map(([userId, peer]) => ({
        userId,
        lastSeenAt: peer.lastSeenAt,
        hasContextToken: Boolean(peer.contextToken),
      }))
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)),
    runtimeStatus: runtime?.status || 'running',
    ...(runtime?.lastError ? { runtimeError: runtime.lastError } : {}),
  }
}

export async function resolveWeixinContextToken(
  ownerUserId: number,
  credentials: StoredWeixinCredentials,
  peerUserId: string,
): Promise<string | undefined> {
  ensureWeixinRuntime(ownerUserId, credentials)
  return (await readState(ownerUserId, credentials.accountId)).peers[peerUserId]?.contextToken
}

export async function shutdownWeixinRuntimes(): Promise<void> {
  await Promise.all([...runtimes.keys()].map(userId => stopWeixinRuntime(userId)))
}

export const shutdownSocialMessageRuntimes = shutdownWeixinRuntimes
