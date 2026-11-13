export interface ChatContentBlock {
  type: 'text' | 'image' | 'file'
  text?: string
  path?: string
  source?: { type: string; media_type?: string; data?: string }
}

export interface ChatMessage {
  role: string
  content: string | ChatContentBlock[]
  /** Internal database identity used for compression boundaries; never serialized to a model. */
  cursorId?: number
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>
  tool_call_id?: string
  name?: string
  reasoning_content?: string | null
  reasoning_details?: string | null
}
