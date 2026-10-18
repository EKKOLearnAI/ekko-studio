import { request } from '../client'

export type ChatWebhookEventType =
  | 'chat.message.created'
  | 'chat.run.queued'
  | 'chat.run.started'
  | 'chat.tool.started'
  | 'chat.tool.completed'
  | 'chat.tool.failed'
  | 'chat.approval.requested'
  | 'chat.approval.resolved'
  | 'chat.clarification.requested'
  | 'chat.clarification.resolved'
  | 'chat.run.completed'
  | 'chat.run.failed'
  | 'group.message.created'
  | 'group.run.failed'
  | 'group.approval.requested'
  | 'group.approval.resolved'
  | 'group.clarification.requested'
  | 'group.clarification.resolved'
  | 'workflow.run.completed'
  | 'workflow.run.failed'
  | 'chat.run.updated'
  | 'group.run.updated'
  | 'workflow.run.updated'
  | 'chat.plan.updated'
  | 'group.plan.updated'
  | 'workflow.plan.updated'

export type ChatWebhookRuntimeState =
  | 'idle'
  | 'delivering'
  | 'retrying'
  | 'success'
  | 'failed'
  | 'dropped'

export interface ChatWebhookRuntimeStatus {
  state: ChatWebhookRuntimeState
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

export interface ChatWebhookEndpoint {
  id: string
  name: string
  url: string
  has_secret: boolean
  event_types: ChatWebhookEventType[]
  profiles: string[]
  enabled: boolean
  include_content: boolean
  include_user_content: boolean
  allow_private_network: boolean
  max_retries: number
  created_at: number
  updated_at: number
  runtime: ChatWebhookRuntimeStatus
}

export interface ChatWebhookEndpointInput {
  name: string
  url: string
  secret?: string
  event_types: ChatWebhookEventType[]
  profiles: string[]
  enabled: boolean
  include_content: boolean
  include_user_content: boolean
  allow_private_network: boolean
  max_retries: number
  clear_secret?: boolean
}

export interface ChatWebhookTestResult {
  ok: boolean
  status: number
  error?: string
}

export interface LocalChatWebhookTestTarget {
  url: string
  allow_private_network: true
}

export interface LocalChatWebhookTestEvent {
  received_at: string
  event: string
  event_id: string
  delivery_id: string
  timestamp: string
  payload: Record<string, unknown>
}

export async function fetchChatWebhookEndpoints(): Promise<ChatWebhookEndpoint[]> {
  const result = await request<{ endpoints: ChatWebhookEndpoint[] }>('/api/studio/webhooks/endpoints')
  return result.endpoints
}

export async function createChatWebhookEndpoint(
  input: ChatWebhookEndpointInput,
): Promise<ChatWebhookEndpoint> {
  const result = await request<{ endpoint: ChatWebhookEndpoint }>('/api/studio/webhooks/endpoints', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return result.endpoint
}

export async function updateChatWebhookEndpoint(
  id: string,
  input: Partial<ChatWebhookEndpointInput>,
): Promise<ChatWebhookEndpoint> {
  const result = await request<{ endpoint: ChatWebhookEndpoint }>(
    `/api/studio/webhooks/endpoints/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(input),
    },
  )
  return result.endpoint
}

export async function deleteChatWebhookEndpoint(id: string): Promise<void> {
  await request(`/api/studio/webhooks/endpoints/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function testChatWebhookEndpoint(id: string): Promise<ChatWebhookTestResult> {
  return request<ChatWebhookTestResult>(
    `/api/studio/webhooks/endpoints/${encodeURIComponent(id)}/test`,
    { method: 'POST' },
  )
}

export async function fetchLocalChatWebhookTestTarget(): Promise<LocalChatWebhookTestTarget> {
  return request<LocalChatWebhookTestTarget>('/api/studio/webhooks/local-test-target')
}

export async function fetchLocalChatWebhookTestEvents(): Promise<LocalChatWebhookTestEvent[]> {
  const result = await request<{ events: LocalChatWebhookTestEvent[] }>(
    '/api/studio/webhooks/local-test-events',
  )
  return result.events
}

export async function clearLocalChatWebhookTestEvents(): Promise<void> {
  await request('/api/studio/webhooks/local-test-events', { method: 'DELETE' })
}
