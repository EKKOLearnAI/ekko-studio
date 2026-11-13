import type { Context } from 'koa'
import {
  CHAT_WEBHOOK_EVENT_TYPES,
  createChatWebhookEndpoint,
  deleteChatWebhookEndpoint,
  getChatWebhookEndpoint,
  listChatWebhookEndpoints,
  updateChatWebhookEndpoint,
  type ChatWebhookEndpointInput,
  type ChatWebhookEndpointRecord,
  type ChatWebhookEventType,
} from '../public/chat-webhooks'
import {
  DELIVERY_HEADER,
  EVENT_HEADER,
  EVENT_ID_HEADER,
  TIMESTAMP_HEADER,
  getChatWebhookDispatcher,
} from '../services/webhooks/dispatcher'
import { normalizeSafeWebhookUrl } from '../services/webhooks/url-safety'
import {
  clearLocalChatWebhookTestInbox,
  getLocalChatWebhookTestTarget,
  listLocalChatWebhookTestInbox,
  validateLocalChatWebhookTestDelivery,
} from '../services/webhooks/local-test-receiver'

const MAX_NAME_LENGTH = 100
const MAX_URL_LENGTH = 2_048
const MAX_SECRET_LENGTH = 4_096
const MAX_RETRIES = 10

function publicEndpoint(endpoint: ChatWebhookEndpointRecord) {
  return {
    id: endpoint.id,
    name: endpoint.name,
    url: endpoint.url,
    has_secret: Boolean(endpoint.secret),
    event_types: endpoint.event_types,
    profiles: endpoint.profiles,
    enabled: endpoint.enabled,
    include_content: endpoint.include_content,
    include_user_content: endpoint.include_user_content,
    allow_private_network: endpoint.allow_private_network,
    max_retries: endpoint.max_retries,
    created_at: endpoint.created_at,
    updated_at: endpoint.updated_at,
    runtime: getChatWebhookDispatcher().getStatus(endpoint.id),
  }
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`)
  const result = value.trim()
  if (result.length > maxLength) throw new Error(`${field} is too long`)
  return result
}

function optionalString(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${field} must be a string`)
  if (value.length > maxLength) throw new Error(`${field} is too long`)
  return value
}

function booleanValue(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`)
  return value
}

function stringList(value: unknown, field: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`)
  const values = [...new Set(value.map(item => String(item).trim()).filter(Boolean))]
  if (values.some(item => item.length > 100)) throw new Error(`${field} contains an invalid value`)
  return values
}

function eventTypes(value: unknown): ChatWebhookEventType[] {
  const values = stringList(value, 'event_types')
  if (values.length === 0) throw new Error('event_types must contain at least one event')
  if (values.some(item => !(CHAT_WEBHOOK_EVENT_TYPES as readonly string[]).includes(item))) {
    throw new Error('event_types contains an unsupported event')
  }
  return values as ChatWebhookEventType[]
}

function retryCount(value: unknown, fallback: number): number {
  if (value === undefined) return fallback
  const retries = Number(value)
  if (!Number.isInteger(retries) || retries < 0 || retries > MAX_RETRIES) {
    throw new Error(`max_retries must be an integer between 0 and ${MAX_RETRIES}`)
  }
  return retries
}

async function createInput(body: Record<string, unknown>): Promise<ChatWebhookEndpointInput> {
  const allowPrivateNetwork = booleanValue(body.allow_private_network, 'allow_private_network', false)
  return {
    name: requiredString(body.name, 'name', MAX_NAME_LENGTH),
    url: await normalizeSafeWebhookUrl(requiredString(body.url, 'url', MAX_URL_LENGTH), allowPrivateNetwork),
    secret: optionalString(body.secret, 'secret', MAX_SECRET_LENGTH) || '',
    event_types: eventTypes(body.event_types),
    profiles: stringList(body.profiles, 'profiles'),
    enabled: booleanValue(body.enabled, 'enabled', true),
    include_content: booleanValue(body.include_content, 'include_content', false),
    include_user_content: booleanValue(body.include_user_content, 'include_user_content', false),
    allow_private_network: allowPrivateNetwork,
    max_retries: retryCount(body.max_retries, 3),
  }
}

export async function listEndpoints(ctx: Context) {
  ctx.body = { endpoints: listChatWebhookEndpoints().map(publicEndpoint) }
}

export async function createEndpoint(ctx: Context) {
  try {
    const endpoint = createChatWebhookEndpoint(await createInput((ctx.request.body || {}) as Record<string, unknown>))
    if (!endpoint) {
      ctx.status = 503
      ctx.body = { error: 'Webhook storage is unavailable' }
      return
    }
    getChatWebhookDispatcher().reloadEndpoints()
    ctx.status = 201
    ctx.body = { endpoint: publicEndpoint(endpoint) }
  } catch (error) {
    ctx.status = 400
    ctx.body = { error: error instanceof Error ? error.message : String(error) }
  }
}

export async function updateEndpoint(ctx: Context) {
  const id = String(ctx.params.id || '')
  const current = getChatWebhookEndpoint(id)
  if (!current) {
    ctx.status = 404
    ctx.body = { error: 'Webhook endpoint not found' }
    return
  }
  try {
    const body = (ctx.request.body || {}) as Record<string, unknown>
    const allowPrivateNetwork = booleanValue(body.allow_private_network, 'allow_private_network', current.allow_private_network)
    const url = body.url === undefined
      ? current.url
      : requiredString(body.url, 'url', MAX_URL_LENGTH)
    const shouldValidateUrl = body.url !== undefined || allowPrivateNetwork !== current.allow_private_network
    const patch: Partial<ChatWebhookEndpointInput> & { clear_secret?: boolean } = {
      name: body.name === undefined ? undefined : requiredString(body.name, 'name', MAX_NAME_LENGTH),
      url: shouldValidateUrl ? await normalizeSafeWebhookUrl(url, allowPrivateNetwork) : undefined,
      secret: optionalString(body.secret, 'secret', MAX_SECRET_LENGTH),
      event_types: body.event_types === undefined ? undefined : eventTypes(body.event_types),
      profiles: body.profiles === undefined ? undefined : stringList(body.profiles, 'profiles'),
      enabled: body.enabled === undefined ? undefined : booleanValue(body.enabled, 'enabled', current.enabled),
      include_content: body.include_content === undefined
        ? undefined
        : booleanValue(body.include_content, 'include_content', current.include_content),
      include_user_content: body.include_user_content === undefined
        ? undefined
        : booleanValue(body.include_user_content, 'include_user_content', current.include_user_content),
      allow_private_network: allowPrivateNetwork,
      max_retries: body.max_retries === undefined ? undefined : retryCount(body.max_retries, current.max_retries),
      clear_secret: body.clear_secret === undefined ? false : booleanValue(body.clear_secret, 'clear_secret', false),
    }
    const endpoint = updateChatWebhookEndpoint(id, patch)
    getChatWebhookDispatcher().reloadEndpoints()
    ctx.body = { endpoint: publicEndpoint(endpoint!) }
  } catch (error) {
    ctx.status = 400
    ctx.body = { error: error instanceof Error ? error.message : String(error) }
  }
}

export async function removeEndpoint(ctx: Context) {
  const id = String(ctx.params.id || '')
  if (!deleteChatWebhookEndpoint(id)) {
    ctx.status = 404
    ctx.body = { error: 'Webhook endpoint not found' }
    return
  }
  getChatWebhookDispatcher().reloadEndpoints()
  ctx.body = { success: true }
}

export async function testEndpoint(ctx: Context) {
  const endpoint = getChatWebhookEndpoint(String(ctx.params.id || ''))
  if (!endpoint) {
    ctx.status = 404
    ctx.body = { error: 'Webhook endpoint not found' }
    return
  }
  const outcome = await getChatWebhookDispatcher().testEndpoint(endpoint)
  ctx.status = outcome.ok ? 200 : 502
  ctx.body = outcome
}

export async function localTestTarget(ctx: Context) {
  ctx.body = await getLocalChatWebhookTestTarget()
}

export function localTestEvents(ctx: Context) {
  ctx.body = { events: listLocalChatWebhookTestInbox() }
}

export function clearLocalTestEvents(ctx: Context) {
  clearLocalChatWebhookTestInbox()
  ctx.body = { success: true }
}

export async function receiveLocalTestWebhook(ctx: Context) {
  const result = await validateLocalChatWebhookTestDelivery({
    remoteAddress: String(ctx.req.socket.remoteAddress || ''),
    token: String(ctx.params.token || ''),
    event: ctx.get(EVENT_HEADER),
    eventId: ctx.get(EVENT_ID_HEADER),
    deliveryId: ctx.get(DELIVERY_HEADER),
    timestamp: ctx.get(TIMESTAMP_HEADER),
    body: ctx.request.body,
  })
  ctx.status = result.status
  ctx.body = result.response
}
