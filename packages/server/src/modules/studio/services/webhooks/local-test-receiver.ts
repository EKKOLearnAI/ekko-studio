import { createHmac, timingSafeEqual } from 'crypto'
import { config } from '../../public/config'
import { getToken } from '../../public/auth'

const LOCAL_TEST_TOKEN_PURPOSE = 'hermes-studio:chat-webhook-local-test:v1'
const LOCAL_TEST_INBOX_LIMIT = 50
const LOCAL_TEST_MAX_PAYLOAD_BYTES = 128 * 1024

export interface LocalChatWebhookTestInboxEntry {
  received_at: string
  event: string
  event_id: string
  delivery_id: string
  timestamp: string
  payload: Record<string, unknown>
}

const localTestInbox: LocalChatWebhookTestInboxEntry[] = []

export interface LocalChatWebhookTestDelivery {
  remoteAddress: string
  token: string
  event: string
  eventId: string
  deliveryId: string
  timestamp: string
  body: unknown
}

export interface LocalChatWebhookTestResult {
  ok: boolean
  status: number
  response: Record<string, unknown>
}

export function listLocalChatWebhookTestInbox(): LocalChatWebhookTestInboxEntry[] {
  return localTestInbox.map(entry => ({
    ...entry,
    payload: JSON.parse(JSON.stringify(entry.payload)) as Record<string, unknown>,
  }))
}

export function clearLocalChatWebhookTestInbox(): void {
  localTestInbox.length = 0
}

function isLoopbackAddress(value: string): boolean {
  const address = String(value || '').trim().toLowerCase()
  return address === '::1'
    || address === '127.0.0.1'
    || address.startsWith('127.')
    || address.startsWith('::ffff:127.')
}

async function expectedLocalTestToken(): Promise<string> {
  return createHmac('sha256', await getToken()).update(LOCAL_TEST_TOKEN_PURPOSE).digest('base64url')
}

async function validLocalTestToken(value: string): Promise<boolean> {
  const expected = Buffer.from(await expectedLocalTestToken())
  const actual = Buffer.from(String(value || ''))
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export async function getLocalChatWebhookTestTarget(): Promise<{
  url: string
  allow_private_network: true
}> {
  const token = await expectedLocalTestToken()
  return {
    url: `http://127.0.0.1:${config.port}/webhook-test/${token}`,
    allow_private_network: true,
  }
}

export async function validateLocalChatWebhookTestDelivery(
  input: LocalChatWebhookTestDelivery,
): Promise<LocalChatWebhookTestResult> {
  if (!isLoopbackAddress(input.remoteAddress) || !await validLocalTestToken(input.token)) {
    return { ok: false, status: 404, response: { error: 'Not found' } }
  }

  const body = input.body && typeof input.body === 'object' && !Array.isArray(input.body)
    ? input.body as Record<string, unknown>
    : null
  if (
    !body
    || body.schema_version !== 1
    || typeof body.id !== 'string'
    || body.id !== input.eventId
    || typeof body.type !== 'string'
    || body.type !== input.event
    || !input.deliveryId
    || !input.timestamp
  ) {
    return {
      ok: false,
      status: 400,
      response: { error: 'Invalid Ekko Studio webhook test payload' },
    }
  }

  const serializedBody = JSON.stringify(body)
  if (Buffer.byteLength(serializedBody, 'utf8') > LOCAL_TEST_MAX_PAYLOAD_BYTES) {
    return {
      ok: false,
      status: 413,
      response: { error: 'Webhook test payload is too large' },
    }
  }

  localTestInbox.unshift({
    received_at: new Date().toISOString(),
    event: input.event,
    event_id: input.eventId,
    delivery_id: input.deliveryId,
    timestamp: input.timestamp,
    payload: JSON.parse(serializedBody) as Record<string, unknown>,
  })
  if (localTestInbox.length > LOCAL_TEST_INBOX_LIMIT) {
    localTestInbox.length = LOCAL_TEST_INBOX_LIMIT
  }

  return {
    ok: true,
    status: 200,
    response: {
      ok: true,
      event_id: input.eventId,
      delivery_id: input.deliveryId,
    },
  }
}
