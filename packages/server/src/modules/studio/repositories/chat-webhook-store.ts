import { randomUUID } from 'crypto'
import { getDb } from '../infrastructure/database'
import { CHAT_WEBHOOK_ENDPOINTS_TABLE } from '../infrastructure/database/schemas'

export const CHAT_WEBHOOK_EVENT_TYPES = [
  'chat.message.created',
  'chat.run.queued',
  'chat.run.started',
  'chat.tool.started',
  'chat.tool.completed',
  'chat.tool.failed',
  'chat.approval.requested',
  'chat.approval.resolved',
  'chat.clarification.requested',
  'chat.clarification.resolved',
  'chat.run.completed',
  'chat.run.failed',
  'group.message.created',
  'group.run.failed',
  'group.approval.requested',
  'group.approval.resolved',
  'group.clarification.requested',
  'group.clarification.resolved',
  'workflow.run.completed',
  'workflow.run.failed',
  'chat.run.updated',
  'group.run.updated',
  'workflow.run.updated',
  'chat.plan.updated',
  'group.plan.updated',
  'workflow.plan.updated',
] as const

export type ChatWebhookEventType = (typeof CHAT_WEBHOOK_EVENT_TYPES)[number]

export interface ChatWebhookEndpointRecord {
  id: string
  name: string
  url: string
  secret: string
  event_types: ChatWebhookEventType[]
  profiles: string[]
  enabled: boolean
  include_content: boolean
  include_user_content: boolean
  allow_private_network: boolean
  max_retries: number
  created_at: number
  updated_at: number
}

export interface ChatWebhookEndpointInput {
  name: string
  url: string
  secret?: string
  event_types?: ChatWebhookEventType[]
  profiles?: string[]
  enabled?: boolean
  include_content?: boolean
  include_user_content?: boolean
  allow_private_network?: boolean
  max_retries?: number
}

function stringArray(value: unknown): string[] {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    return Array.isArray(parsed) ? parsed.map(item => String(item)).filter(Boolean) : []
  } catch {
    return []
  }
}

function eventTypes(value: unknown): ChatWebhookEventType[] {
  return stringArray(value).filter((item): item is ChatWebhookEventType => (
    (CHAT_WEBHOOK_EVENT_TYPES as readonly string[]).includes(item)
  ))
}

function mapEndpoint(row: Record<string, unknown>): ChatWebhookEndpointRecord {
  return {
    id: String(row.id || ''),
    name: String(row.name || ''),
    url: String(row.url || ''),
    secret: String(row.secret || ''),
    event_types: eventTypes(row.event_types_json),
    profiles: stringArray(row.profiles_json),
    enabled: Boolean(row.enabled),
    include_content: Boolean(row.include_content),
    include_user_content: Boolean(row.include_user_content),
    allow_private_network: Boolean(row.allow_private_network),
    max_retries: Number(row.max_retries ?? 3),
    created_at: Number(row.created_at || 0),
    updated_at: Number(row.updated_at || 0),
  }
}

export function listChatWebhookEndpoints(): ChatWebhookEndpointRecord[] {
  const db = getDb()
  if (!db) return []
  return (db.prepare(
    `SELECT * FROM ${CHAT_WEBHOOK_ENDPOINTS_TABLE} ORDER BY created_at ASC`,
  ).all() as Record<string, unknown>[]).map(mapEndpoint)
}

export function getChatWebhookEndpoint(id: string): ChatWebhookEndpointRecord | null {
  const db = getDb()
  if (!db) return null
  const row = db.prepare(`SELECT * FROM ${CHAT_WEBHOOK_ENDPOINTS_TABLE} WHERE id = ?`).get(id) as Record<string, unknown> | undefined
  return row ? mapEndpoint(row) : null
}

export function createChatWebhookEndpoint(input: ChatWebhookEndpointInput): ChatWebhookEndpointRecord | null {
  const db = getDb()
  if (!db) return null
  const timestamp = Date.now()
  const id = randomUUID()
  db.prepare(
    `INSERT INTO ${CHAT_WEBHOOK_ENDPOINTS_TABLE}
     (id, name, url, secret, event_types_json, profiles_json, enabled, include_content, include_user_content, allow_private_network, max_retries, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.name,
    input.url,
    input.secret || '',
    JSON.stringify(input.event_types || []),
    JSON.stringify(input.profiles || []),
    input.enabled === false ? 0 : 1,
    input.include_content ? 1 : 0,
    input.include_user_content ? 1 : 0,
    input.allow_private_network ? 1 : 0,
    input.max_retries ?? 3,
    timestamp,
    timestamp,
  )
  return getChatWebhookEndpoint(id)
}

export function updateChatWebhookEndpoint(
  id: string,
  input: Partial<ChatWebhookEndpointInput> & { clear_secret?: boolean },
): ChatWebhookEndpointRecord | null {
  const db = getDb()
  const current = getChatWebhookEndpoint(id)
  if (!db || !current) return null
  const secret = input.clear_secret ? '' : input.secret === undefined ? current.secret : input.secret
  db.prepare(
    `UPDATE ${CHAT_WEBHOOK_ENDPOINTS_TABLE}
     SET name = ?, url = ?, secret = ?, event_types_json = ?, profiles_json = ?, enabled = ?,
         include_content = ?, include_user_content = ?, allow_private_network = ?, max_retries = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    input.name ?? current.name,
    input.url ?? current.url,
    secret,
    JSON.stringify(input.event_types ?? current.event_types),
    JSON.stringify(input.profiles ?? current.profiles),
    input.enabled === undefined ? (current.enabled ? 1 : 0) : (input.enabled ? 1 : 0),
    input.include_content === undefined ? (current.include_content ? 1 : 0) : (input.include_content ? 1 : 0),
    input.include_user_content === undefined ? (current.include_user_content ? 1 : 0) : (input.include_user_content ? 1 : 0),
    input.allow_private_network === undefined ? (current.allow_private_network ? 1 : 0) : (input.allow_private_network ? 1 : 0),
    input.max_retries ?? current.max_retries,
    Date.now(),
    id,
  )
  return getChatWebhookEndpoint(id)
}

export function deleteChatWebhookEndpoint(id: string): boolean {
  const db = getDb()
  if (!db) return false
  return Number(db.prepare(`DELETE FROM ${CHAT_WEBHOOK_ENDPOINTS_TABLE} WHERE id = ?`).run(id).changes) > 0
}
