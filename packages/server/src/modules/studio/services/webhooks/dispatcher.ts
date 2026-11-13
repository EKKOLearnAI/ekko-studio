import { createHmac, randomUUID } from 'crypto'
import http from 'http'
import https from 'https'
import { logger } from '../../public/logging'
import {
  listChatWebhookEndpoints,
  type ChatWebhookEndpointRecord,
} from '../../public/chat-webhooks'
import { buildChatWebhookEnvelope, type ChatRunWebhookEvent } from './envelope'
import { resolveSafeWebhookTarget } from './url-safety'

const DEFAULT_CONCURRENCY = 8
const DEFAULT_QUEUE_LIMIT = 5_000
const REQUEST_TIMEOUT_MS = 10_000
const MAX_ERROR_RESPONSE_BYTES = 64 * 1024
const BASE_RETRY_MS = 5_000
const MAX_RETRY_MS = 5 * 60_000

export const EVENT_HEADER = 'X-Hermes-Event'
export const EVENT_ID_HEADER = 'X-Hermes-Event-Id'
export const DELIVERY_HEADER = 'X-Hermes-Delivery'
export const TIMESTAMP_HEADER = 'X-Hermes-Timestamp'
export const SIGNATURE_HEADER = 'X-Hermes-Signature-256'

export interface ChatWebhookRuntimeStatus {
  state: 'idle' | 'delivering' | 'retrying' | 'success' | 'failed' | 'dropped'
  queued: number
  active: number
  delivered: number
  failed: number
  dropped: number
  last_status: number | null
  last_error: string | null
  last_attempt_at: number | null
  last_success_at: number | null
}

interface DeliveryTask {
  id: string
  endpointId: string
  event: ChatRunWebhookEvent
  retries: number
  nextAttemptAt: number
}

interface DeliveryOutcome {
  ok: boolean
  status: number
  error: string
}

export interface ChatWebhookDispatcherOptions {
  concurrency?: number
  queueLimit?: number
  retryBaseMs?: number
  retryMaxMs?: number
  fetchImpl?: typeof fetch
  now?: () => number
  random?: () => number
}

export function signChatWebhookPayload(secret: string, timestamp: string, rawBody: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`
}

export function isRetryableWebhookStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500
}

async function readBoundedResponse(response: Response, maxBytes = MAX_ERROR_RESPONSE_BYTES): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value?.length) continue
      const remaining = maxBytes - total
      const chunk = value.length > remaining ? value.subarray(0, remaining) : value
      chunks.push(chunk)
      total += chunk.length
      if (chunk.length < value.length) break
    }
  } finally {
    if (total >= maxBytes) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8')
}

async function postPinnedWebhook(
  endpoint: ChatWebhookEndpointRecord,
  rawBody: string,
  headers: Record<string, string>,
): Promise<DeliveryOutcome> {
  let target
  try {
    target = await resolveSafeWebhookTarget(endpoint.url, endpoint.allow_private_network)
  } catch (error: any) {
    return { ok: false, status: 0, error: String(error?.message || error).slice(0, 500) }
  }
  const url = new URL(target.url)
  const requestImpl = url.protocol === 'https:' ? https.request : http.request

  return new Promise((resolve) => {
    let settled = false
    const finish = (outcome: DeliveryOutcome) => {
      if (settled) return
      settled = true
      resolve(outcome)
    }
    const request = requestImpl({
      protocol: url.protocol,
      hostname: target.address,
      family: target.family,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers: {
        ...headers,
        Host: url.host,
        'Content-Length': Buffer.byteLength(rawBody),
      },
      servername: url.hostname.replace(/^\[|\]$/g, ''),
      agent: false,
    }, (response) => {
      const status = Number(response.statusCode) || 0
      if (status >= 200 && status < 300) {
        response.destroy()
        finish({ ok: true, status, error: '' })
        return
      }
      const chunks: Buffer[] = []
      let total = 0
      response.on('data', (chunk: Buffer | string) => {
        if (total >= MAX_ERROR_RESPONSE_BYTES) return
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        const remaining = MAX_ERROR_RESPONSE_BYTES - total
        chunks.push(bytes.length > remaining ? bytes.subarray(0, remaining) : bytes)
        total += Math.min(bytes.length, remaining)
        if (total >= MAX_ERROR_RESPONSE_BYTES) response.destroy()
      })
      response.on('end', () => {
        const detail = Buffer.concat(chunks).toString('utf8')
        finish({ ok: false, status, error: detail.slice(0, 500) || `HTTP ${status}` })
      })
      response.on('error', (error) => {
        const detail = Buffer.concat(chunks).toString('utf8')
        finish({ ok: false, status, error: detail.slice(0, 500) || String(error.message).slice(0, 500) })
      })
    })
    request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error('Webhook request timed out')))
    request.on('error', (error) => finish({ ok: false, status: 0, error: String(error.message).slice(0, 500) }))
    request.end(rawBody)
  })
}

export async function postChatWebhook(
  endpoint: ChatWebhookEndpointRecord,
  event: ChatRunWebhookEvent,
  fetchImpl?: typeof fetch,
): Promise<DeliveryOutcome> {
  const deliveryId = randomUUID()
  const timestamp = String(Math.floor(Date.now() / 1000))
  const rawBody = JSON.stringify(buildChatWebhookEnvelope(
    event,
    endpoint.include_content,
    endpoint.include_user_content,
  ))
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [EVENT_HEADER]: event.type,
    [EVENT_ID_HEADER]: event.id,
    [DELIVERY_HEADER]: deliveryId,
    [TIMESTAMP_HEADER]: timestamp,
  }
  if (endpoint.secret) headers[SIGNATURE_HEADER] = signChatWebhookPayload(endpoint.secret, timestamp, rawBody)

  if (!fetchImpl) return postPinnedWebhook(endpoint, rawBody, headers)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const target = await resolveSafeWebhookTarget(endpoint.url, endpoint.allow_private_network)
    const response = await fetchImpl(target.url, {
      method: 'POST',
      headers,
      body: rawBody,
      redirect: 'manual',
      signal: controller.signal,
    })
    const status = Number(response.status) || 0
    if (status >= 200 && status < 300) {
      response.body?.cancel().catch(() => undefined)
      return { ok: true, status, error: '' }
    }
    const detail = await readBoundedResponse(response)
    return { ok: false, status, error: detail.slice(0, 500) || `HTTP ${status}` }
  } catch (error: any) {
    return { ok: false, status: 0, error: String(error?.message || error).slice(0, 500) }
  } finally {
    clearTimeout(timer)
  }
}

export class ChatWebhookDispatcher {
  private endpoints = new Map<string, ChatWebhookEndpointRecord>()
  private incoming: ChatRunWebhookEvent[] = []
  private queue: DeliveryTask[] = []
  private activeEndpoints = new Set<string>()
  private statuses = new Map<string, ChatWebhookRuntimeStatus>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private active = 0
  private closing = false

  constructor(private readonly options: ChatWebhookDispatcherOptions = {}) {}

  start(): void {
    this.closing = false
    this.reloadEndpoints()
    this.schedule(0)
  }

  stop(): void {
    this.closing = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.incoming = []
    this.queue = []
  }

  reloadEndpoints(): void {
    this.endpoints = new Map(listChatWebhookEndpoints().map(endpoint => [endpoint.id, endpoint]))
    const activeIds = new Set([...this.endpoints.values()].filter(item => item.enabled).map(item => item.id))
    this.queue = this.queue.filter(task => activeIds.has(task.endpointId))
    for (const endpoint of this.endpoints.values()) this.ensureStatus(endpoint.id)
    for (const endpointId of this.statuses.keys()) {
      if (!this.endpoints.has(endpointId)) this.statuses.delete(endpointId)
    }
    this.schedule(0)
  }

  enqueue(event: ChatRunWebhookEvent): boolean {
    if (this.closing) return false
    const queueLimit = Math.max(1, this.options.queueLimit ?? DEFAULT_QUEUE_LIMIT)
    if (this.incoming.length + this.queue.length + this.active >= queueLimit) {
      logger.warn('[chat-webhooks] dropped event %s: queue full', event.id)
      return false
    }
    this.incoming.push(event)
    this.schedule(0)
    return true
  }

  private fanoutIncoming(): void {
    const queueLimit = Math.max(1, this.options.queueLimit ?? DEFAULT_QUEUE_LIMIT)
    while (this.incoming.length > 0) {
      const event = this.incoming.shift()!
      const targets = [...this.endpoints.values()].filter(endpoint => (
        endpoint.enabled
        && (endpoint.event_types.length === 0 || endpoint.event_types.includes(event.type))
        && (endpoint.profiles.length === 0 || endpoint.profiles.includes(event.profile))
      ))
      let dropped = 0
      for (const endpoint of targets) {
        if (this.queue.length + this.active >= queueLimit) {
          dropped++
          this.updateStatus(endpoint.id, {
            state: 'dropped',
            last_error: 'Webhook queue is full',
            dropped: this.ensureStatus(endpoint.id).dropped + 1,
          })
          continue
        }
        this.queue.push({
          id: randomUUID(),
          endpointId: endpoint.id,
          event,
          retries: 0,
          nextAttemptAt: this.now(),
        })
      }
      if (dropped > 0) logger.warn('[chat-webhooks] dropped %d delivery task(s): queue full', dropped)
    }
    this.refreshQueuedCounts()
  }

  async testEndpoint(endpoint: ChatWebhookEndpointRecord): Promise<DeliveryOutcome> {
    this.updateStatus(endpoint.id, { state: 'delivering' })
    const outcome = await postChatWebhook(endpoint, {
      id: `test_${randomUUID()}`,
      type: 'chat.run.completed',
      occurred_at: new Date().toISOString(),
      profile: 'default',
      source: 'chat',
      agent: 'bridge',
      subject: { session_id: 'test' },
      summary: { status: 'completed' },
      content: 'Ekko Studio webhook test',
    }, this.options.fetchImpl)
    const status = this.ensureStatus(endpoint.id)
    const attemptedAt = this.now()
    if (outcome.ok) {
      this.updateStatus(endpoint.id, {
        state: 'success',
        delivered: status.delivered + 1,
        last_status: outcome.status,
        last_error: null,
        last_attempt_at: attemptedAt,
        last_success_at: attemptedAt,
      })
    } else {
      this.updateStatus(endpoint.id, {
        state: 'failed',
        failed: status.failed + 1,
        last_status: outcome.status || null,
        last_error: outcome.error || 'Webhook test failed',
        last_attempt_at: attemptedAt,
      })
    }
    return outcome
  }

  getStatus(endpointId: string): ChatWebhookRuntimeStatus {
    const status = { ...this.ensureStatus(endpointId) }
    status.queued = this.queue.filter(task => task.endpointId === endpointId).length
    status.active = this.activeEndpoints.has(endpointId) ? 1 : 0
    if (status.active) status.state = 'delivering'
    return status
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private ensureStatus(endpointId: string): ChatWebhookRuntimeStatus {
    let status = this.statuses.get(endpointId)
    if (!status) {
      status = {
        state: 'idle',
        queued: 0,
        active: 0,
        delivered: 0,
        failed: 0,
        dropped: 0,
        last_status: null,
        last_error: null,
        last_attempt_at: null,
        last_success_at: null,
      }
      this.statuses.set(endpointId, status)
    }
    return status
  }

  private updateStatus(endpointId: string, patch: Partial<ChatWebhookRuntimeStatus>): void {
    const status = this.ensureStatus(endpointId)
    Object.assign(status, patch)
  }

  private refreshQueuedCounts(): void {
    const counts = new Map<string, number>()
    for (const task of this.queue) counts.set(task.endpointId, (counts.get(task.endpointId) || 0) + 1)
    for (const endpointId of this.endpoints.keys()) this.ensureStatus(endpointId).queued = counts.get(endpointId) || 0
  }

  private schedule(delayMs: number): void {
    if (this.closing) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.drain()
    }, Math.max(0, delayMs))
    this.timer.unref?.()
  }

  private candidateIndex(now: number): number {
    return this.queue.findIndex((task, index) => (
      task.nextAttemptAt <= now
      && !this.activeEndpoints.has(task.endpointId)
      && !this.queue.slice(0, index).some(earlier => earlier.endpointId === task.endpointId)
    ))
  }

  private drain(): void {
    if (this.closing) return
    this.fanoutIncoming()
    const concurrency = Math.max(1, this.options.concurrency ?? DEFAULT_CONCURRENCY)
    let index = this.candidateIndex(this.now())
    while (this.active < concurrency && index >= 0) {
      const [task] = this.queue.splice(index, 1)
      this.active++
      this.activeEndpoints.add(task.endpointId)
      this.refreshQueuedCounts()
      void this.deliver(task).finally(() => {
        this.active--
        this.activeEndpoints.delete(task.endpointId)
        this.schedule(0)
      })
      index = this.candidateIndex(this.now())
    }
    if (this.active < concurrency && this.queue.length > 0 && index < 0) {
      const delayed = this.queue.filter(task => !this.activeEndpoints.has(task.endpointId))
      if (delayed.length === 0) return
      const nextAt = Math.min(...delayed.map(task => task.nextAttemptAt))
      this.schedule(Math.max(10, nextAt - this.now()))
    }
  }

  private async deliver(task: DeliveryTask): Promise<void> {
    const endpoint = this.endpoints.get(task.endpointId)
    if (!endpoint?.enabled) return
    this.updateStatus(endpoint.id, { state: 'delivering' })
    const outcome = await postChatWebhook(endpoint, task.event, this.options.fetchImpl)
    if (outcome.ok) {
      const status = this.ensureStatus(endpoint.id)
      const attemptedAt = this.now()
      this.updateStatus(endpoint.id, {
        state: 'success',
        delivered: status.delivered + 1,
        last_status: outcome.status,
        last_error: null,
        last_attempt_at: attemptedAt,
        last_success_at: attemptedAt,
      })
      return
    }

    const retryable = isRetryableWebhookStatus(outcome.status)
    if (retryable && task.retries < endpoint.max_retries && !this.closing) {
      const retries = task.retries + 1
      const baseRetryMs = Math.max(1, this.options.retryBaseMs ?? BASE_RETRY_MS)
      const maxRetryMs = Math.max(baseRetryMs, this.options.retryMaxMs ?? MAX_RETRY_MS)
      const ceiling = Math.min(maxRetryMs, baseRetryMs * 2 ** (retries - 1))
      const jitter = 0.5 + (this.options.random?.() ?? Math.random()) * 0.5
      task.retries = retries
      task.nextAttemptAt = this.now() + Math.floor(ceiling * jitter)
      const nextSameEndpoint = this.queue.findIndex(item => item.endpointId === endpoint.id)
      if (nextSameEndpoint >= 0) this.queue.splice(nextSameEndpoint, 0, task)
      else this.queue.push(task)
      this.updateStatus(endpoint.id, {
        state: 'retrying',
        last_status: outcome.status || null,
        last_error: outcome.error,
        last_attempt_at: this.now(),
      })
      this.refreshQueuedCounts()
      return
    }

    const status = this.ensureStatus(endpoint.id)
    this.updateStatus(endpoint.id, {
      state: 'failed',
      last_status: outcome.status || null,
      last_error: outcome.error,
      last_attempt_at: this.now(),
      failed: status.failed + 1,
    })
    logger.warn(
      '[chat-webhooks] delivery to %s failed after %d attempt(s): status=%d %s',
      endpoint.name,
      task.retries + 1,
      outcome.status,
      outcome.error,
    )
  }
}

const dispatcher = new ChatWebhookDispatcher()

export function getChatWebhookDispatcher(): ChatWebhookDispatcher {
  return dispatcher
}

export function startChatWebhookDispatcher(): void {
  dispatcher.start()
}

export function stopChatWebhookDispatcher(): void {
  dispatcher.stop()
}
