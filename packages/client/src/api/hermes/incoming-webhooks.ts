import { request } from '../client'

export interface IncomingWebhookSubscription {
  name: string
  description: string
  events: string[]
  deliver: string
  deliver_only: boolean
  prompt: string
  skills: string[]
  created_at?: string
  enabled: boolean
  secret_set: boolean
  url: string
}

export interface IncomingWebhookState {
  profile: string
  enabled: boolean
  gateway_running: boolean
  unified: boolean
  base_url: string
  subscriptions: IncomingWebhookSubscription[]
}

export interface IncomingWebhookInput {
  name: string
  description?: string
  events?: string[]
  deliver: string
  deliver_only?: boolean
  deliver_chat_id?: string
  prompt?: string
  skills?: string[]
}

export async function fetchIncomingWebhooks(): Promise<IncomingWebhookState> {
  return request('/api/hermes/incoming-webhooks')
}

export async function enableIncomingWebhooks(): Promise<void> {
  await request('/api/hermes/incoming-webhooks/enable', { method: 'POST' })
}

export async function createIncomingWebhook(input: IncomingWebhookInput): Promise<IncomingWebhookSubscription & { secret: string }> {
  const result = await request<{ subscription: IncomingWebhookSubscription & { secret: string } }>('/api/hermes/incoming-webhooks', {
    method: 'POST', body: JSON.stringify(input),
  })
  return result.subscription
}

export async function setIncomingWebhookEnabled(name: string, enabled: boolean): Promise<void> {
  await request(`/api/hermes/incoming-webhooks/${encodeURIComponent(name)}/enabled`, {
    method: 'PUT', body: JSON.stringify({ enabled }),
  })
}

export async function deleteIncomingWebhook(name: string): Promise<void> {
  await request(`/api/hermes/incoming-webhooks/${encodeURIComponent(name)}`, { method: 'DELETE' })
}
