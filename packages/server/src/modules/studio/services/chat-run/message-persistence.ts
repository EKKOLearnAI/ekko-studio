import { addMessage, addMessages } from '../../repositories/session-store'
import type { SessionMessage, SessionState } from './types'

export type RunMessageDraft = Omit<SessionMessage, 'id' | 'session_id' | 'runMarker' | 'run_marker' | 'timestamp'> & {
  id?: number | string
  runMarker?: string | null
  run_marker?: string | null
  timestamp?: number
}

interface PersistRunMessagesOptions {
  sessionId: string
  runMarker?: string | null
  messages: RunMessageDraft[]
  appendToState?: boolean
  atomic?: boolean
}

export interface PersistRunMessagesResult {
  ids: Array<number | undefined>
  messages: SessionMessage[]
}

/**
 * Normalize and persist messages produced by one agent run.
 *
 * Agent adapters own the timing of a write (for example, Ekko waits for a
 * complete parallel tool group), while this function owns the durable and
 * in-memory representation. This keeps run attribution and reasoning/tool
 * fields identical across Bridge, Ekko, and Responses-based coding agents.
 */
export function persistRunMessages(
  state: SessionState,
  options: PersistRunMessagesOptions,
): PersistRunMessagesResult {
  const { sessionId, messages: drafts, appendToState = false, atomic = false } = options
  if (!drafts.length) return { ids: [], messages: [] }

  const timestamp = Math.floor(Date.now() / 1000)
  const fallbackIdStart = state.messages.length + 1
  const messages = drafts.map((draft, index): SessionMessage => {
    const {
      id,
      runMarker: draftRunMarker,
      run_marker: draftStoredRunMarker,
      ...message
    } = draft
    const runMarker = options.runMarker || draftRunMarker || draftStoredRunMarker || undefined
    return {
      ...message,
      id: id ?? fallbackIdStart + index,
      session_id: sessionId,
      runMarker,
      content: message.content || '',
      timestamp: message.timestamp ?? timestamp,
    }
  })
  const rows = messages.map(message => ({
    session_id: sessionId,
    role: message.role,
    content: message.content,
    display_role: message.display_role ?? null,
    display_content: message.display_content ?? null,
    tool_call_id: message.tool_call_id ?? null,
    tool_calls: message.tool_calls ?? null,
    tool_name: message.tool_name ?? null,
    run_marker: message.runMarker ?? null,
    timestamp: message.timestamp,
    token_count: message.token_count ?? null,
    finish_reason: message.finish_reason ?? null,
    reasoning: message.reasoning ?? null,
    reasoning_details: message.reasoning_details ?? null,
    reasoning_content: message.reasoning_content ?? null,
  }))
  const ids = atomic
    ? addMessages(rows).map(id => id as number | undefined)
    : rows.map(row => addMessage(row))

  messages.forEach((message, index) => {
    const persistedId = ids[index]
    if (persistedId == null) return
    message.id = persistedId
    if (!appendToState) drafts[index].id = persistedId
  })
  if (appendToState) state.messages.push(...messages)

  return { ids, messages }
}
