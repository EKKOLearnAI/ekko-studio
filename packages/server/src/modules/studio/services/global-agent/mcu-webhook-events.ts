import { randomUUID } from 'crypto'
import type { Socket } from 'socket.io'
import { authenticateUserToken, type AuthenticatedUser } from '../../public/auth'
import { userCanAccessProfile } from '../../public/users'
import { CHAT_WEBHOOK_EVENT_TYPES, type ChatWebhookEventType } from '../../public/chat-webhooks'
import { businessEvents, type BusinessEvent } from '../webhooks/business-events'
import { canReceiveAppEvent } from '../webhooks/app-events'
import { buildChatWebhookEnvelope } from '../webhooks/envelope'

const MAX_PENDING_EVENTS = 100
const MAX_SEEN_EVENTS = 2000

interface McuWebhookSubscription {
  token: string
  profile: string
  types: ChatWebhookEventType[]
  sessionIds: string[]
  roomIds: string[]
  workflowIds: string[]
  includeContent: boolean
  includeUserContent: boolean
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid subscription')
  return value as Record<string, unknown>
}

function apiToken(input: Record<string, unknown>): string {
  const raw = input.apiToken ?? input.api_token ?? input.authorization
  return typeof raw === 'string' ? raw.trim().replace(/^bearer\s+/i, '') : ''
}

function ids(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 100
    || value.some(id => typeof id !== 'string' || !id.trim() || id.length > 512)) {
    throw new Error('invalid subscription filter')
  }
  return [...new Set(value.map(id => (id as string).trim()))]
}

function parseSubscription(value: unknown): McuWebhookSubscription {
  const input = record(value)
  if (input.schema_version !== 1) throw new Error('unsupported event schema')
  if (input.profile !== undefined && (typeof input.profile !== 'string' || input.profile.length > 512)) {
    throw new Error('invalid profile')
  }
  for (const key of ['include_content', 'include_user_content']) {
    if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new Error('invalid content option')
  }
  const types = input.types === undefined ? [...CHAT_WEBHOOK_EVENT_TYPES] : ids(input.types)
  if (types.some(type => !(CHAT_WEBHOOK_EVENT_TYPES as readonly string[]).includes(type))) {
    throw new Error('unsupported event type')
  }
  const token = apiToken(input)
  if (!token) throw new Error('missing API token')
  return {
    token,
    profile: typeof input.profile === 'string' ? input.profile.trim() || 'default' : 'default',
    types: types as ChatWebhookEventType[],
    sessionIds: ids(input.session_ids),
    roomIds: ids(input.room_ids),
    workflowIds: ids(input.workflow_ids),
    includeContent: input.include_content === true,
    includeUserContent: input.include_user_content === true,
  }
}

function allowed(user: AuthenticatedUser, profile: string): boolean {
  return user.role === 'super_admin' || userCanAccessProfile(user.id, profile)
}

function matches(subscription: McuWebhookSubscription, event: BusinessEvent): boolean {
  if (!event.chat || event.profile !== subscription.profile || !subscription.types.includes(event.chat.type)) return false
  const subject = event.chat.subject
  return (!subscription.sessionIds.length || subscription.sessionIds.includes(subject.session_id || ''))
    && (!subscription.roomIds.length || subscription.roomIds.includes(subject.room_id || ''))
    && (!subscription.workflowIds.length || subscription.workflowIds.includes(subject.workflow_id || ''))
}

/** Opt-in Webhook projection; legacy MCU connections receive no extra traffic. */
export function bindMcuWebhookEvents(socket: Socket): void {
  let subscription: McuWebhookSubscription | null = null
  let revision = 0
  let closed = false
  let pending = 0
  let chain = Promise.resolve()
  const seen = new Set<string>()
  const respond = (type: string, result: Record<string, unknown>, ack?: (result: unknown) => void) => {
    const response = { type, schema_version: 1, ...result }
    socket.emit(type, response)
    ack?.(response)
  }

  socket.on('mcu.events.subscribe', async (input: unknown, ack?: (result: unknown) => void) => {
    const ticket = ++revision
    subscription = null
    seen.clear()
    try {
      const request = parseSubscription(input)
      // The subscriber authenticates independently of the relay transport's account.
      const user = await authenticateUserToken(request.token)
      if (!user || !allowed(user, request.profile)) throw new Error('Profile access denied')
      if (closed || revision !== ticket) return
      subscription = request
      respond('mcu.events.subscribed', {
        ok: true, profile: request.profile, types: request.types,
        include_content: request.includeContent, include_user_content: request.includeUserContent,
      }, ack)
    } catch {
      if (!closed && revision === ticket) respond('mcu.events.subscribed', { ok: false, error: 'event_subscription_denied' }, ack)
    }
  })

  socket.on('mcu.events.unsubscribe', (input: unknown, ack?: (result: unknown) => void) => {
    try {
      const token = apiToken(record(input))
      if (!token || subscription && token !== subscription.token) throw new Error('invalid API token')
      revision++
      subscription = null
      seen.clear()
      respond('mcu.events.unsubscribed', { ok: true }, ack)
    } catch {
      respond('mcu.events.unsubscribed', { ok: false, error: 'event_subscription_denied' }, ack)
    }
  })

  const stop = businessEvents.subscribe(`mcu-webhooks:${socket.id}:${randomUUID()}`, event => {
    const request = subscription
    const ticket = revision
    if (closed || !request || !matches(request, event) || pending >= MAX_PENDING_EVENTS) return
    pending++
    chain = chain.then(async () => {
      if (closed || revision !== ticket || seen.has(event.id)) return
      const user = await authenticateUserToken(request.token)
      if (!user || !allowed(user, request.profile) || !canReceiveAppEvent(user, event)) return
      if (closed || revision !== ticket) return
      const envelope = buildChatWebhookEnvelope(event.chat!, request.includeContent, request.includeUserContent)
      seen.add(event.id)
      if (seen.size > MAX_SEEN_EVENTS) seen.delete(seen.values().next().value!)
      socket.volatile.emit('mcu.webhook.event', { type: 'mcu.webhook.event', schema_version: 1, event: envelope })
    }).catch(() => {}).finally(() => { pending-- })
  })

  socket.on('disconnect', () => {
    closed = true
    revision++
    subscription = null
    seen.clear()
    stop()
  })
}
