export interface ConversationSummary {
  id: string
  profile?: string | null
  source: string
  agent?: string
  agent_mode?: string
  agent_session_id?: string
  agent_native_session_id?: string
  model: string
  provider?: string
  api_mode?: string
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

export interface ConversationListOptions {
  source?: string
  humanOnly?: boolean
  limit?: number
}
