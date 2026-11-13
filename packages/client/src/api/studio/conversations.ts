import { request } from '../client'

export interface ConversationSummary {
  id: string
  source: string
  model: string
  provider?: string
  title: string | null
  started_at: number
  ended_at: number | null
  last_active: number
  message_count: number
  tool_call_count: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  billing_provider: string | null
  estimated_cost_usd: number
  actual_cost_usd: number | null
  cost_status: string
  preview: string
  is_archived?: number | boolean
  is_active: boolean
  thread_session_count: number
}

export interface ConversationMessage {
  id: number | string
  session_id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
}

export interface ConversationDetail {
  session_id: string
  messages: ConversationMessage[]
  visible_count: number
  thread_session_count: number
}

export async function fetchConversationSummaries(params: { humanOnly?: boolean; source?: string; limit?: number } = {}): Promise<ConversationSummary[]> {
  const query = new URLSearchParams()
  if (params.humanOnly === false) query.set('humanOnly', 'false')
  if (params.source) query.set('source', params.source)
  if (params.limit != null) query.set('limit', String(params.limit))
  const suffix = query.toString() ? `?${query.toString()}` : ''
  const res = await request<{ sessions: ConversationSummary[] }>(`/api/studio/sessions/conversations${suffix}`)
  return res.sessions
}

export async function fetchConversationDetail(sessionId: string, params: { humanOnly?: boolean; source?: string } = {}): Promise<ConversationDetail> {
  const query = new URLSearchParams()
  if (params.humanOnly === false) query.set('humanOnly', 'false')
  if (params.source) query.set('source', params.source)
  const suffix = query.toString() ? `?${query.toString()}` : ''
  return request<ConversationDetail>(`/api/studio/sessions/conversations/${encodeURIComponent(sessionId)}/messages${suffix}`)
}
