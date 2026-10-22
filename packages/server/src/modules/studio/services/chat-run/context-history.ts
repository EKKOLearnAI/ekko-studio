import type { CompressionSnapshot } from '../../repositories/compression-snapshot'
import {
  HIDDEN_DISPLAY_ROLE,
  getSession,
  getSessionContextMessage,
  getSessionContextMessages,
  type HermesMessageRow,
} from '../../repositories/session-store'
import type { ChatMessage } from '../context-compressor'
import { truncateToolResultForContext } from './tool-result-context'
import { logger } from '../../public/logging'
import { projectChatBrowserHistory } from '../../public/chat-agent-runtime'
import { isAssistantMessageSendable } from './message-format'

export interface CursorSnapshotParts {
  head: ChatMessage[]
  newMessages: ChatMessage[]
  historyRevision: number
}

export type CursorSnapshotReadResult =
  | { status: 'usable'; parts: CursorSnapshotParts }
  | { status: 'invalid'; reason: string }
  | { status: 'legacy' }

export function buildDbHistoryFromContextRows(
  sessionId: string,
  rows: HermesMessageRow[],
  options: {
    excludeLastUser?: boolean
    truncateToolResults?: boolean
  } = {},
): ChatMessage[] {
  const cutRows = options.excludeLastUser ? excludeLatestUserAndFollowing(rows) : rows
  // A hidden automatic-turn input that no assistant answered (failed, aborted or still running)
  // would send the abandoned input again and break user/assistant alternation.
  const selectedRows = cutRows.filter((row, index) =>
    row.role !== 'user' || row.display_role !== HIDDEN_DISPLAY_ROLE || cutRows[index + 1]?.role === 'assistant')
  const sourceRows = options.truncateToolResults === false ? selectedRows
    : projectChatBrowserHistory(selectedRows, { truncateOtherTools: truncateToolResultForContext })
  return sourceRows.map((row, index, allRows) => {
    const content = row.content || ''
    const cursorId = Number(row.id)
    const message: ChatMessage = {
      role: row.role,
      content,
    }
    // The cursor is runtime-only metadata. Keeping it non-enumerable lets the
    // compressor advance snapshots without leaking database IDs to providers.
    if (Number.isSafeInteger(cursorId)) {
      Object.defineProperty(message, 'cursorId', {
        value: cursorId,
        enumerable: false,
      })
    }
    if (row.reasoning_content != null) message.reasoning_content = row.reasoning_content
    if (row.reasoning_details != null) message.reasoning_details = row.reasoning_details
    if (row.tool_calls?.length) {
      const cleanedToolCalls = row.tool_calls
        .filter((toolCall: any) => toolCall.id && toolCall.id.length > 0)
        .map((toolCall: any) => ({
          id: toolCall.id,
          type: toolCall.type,
          function: toolCall.function,
        }))
      if (cleanedToolCalls.length > 0) message.tool_calls = cleanedToolCalls
    }
    if (row.role === 'tool') {
      let callId = row.tool_call_id
      if (!callId) {
        const previous = allRows[index - 1]
        if (previous?.role === 'assistant' && previous.tool_calls?.length) {
          const match = previous.tool_calls.find((toolCall: any) => toolCall.function?.name === row.tool_name)
          if (match?.id) callId = match.id
        }
      }
      if (!callId) return null
      message.tool_call_id = callId
    }
    if (row.tool_name) message.name = row.tool_name
    if (row.role === 'assistant' && !isAssistantMessageSendable(message)) {
      logger.warn('[chat-run-socket] skipped empty assistant message while building history for session %s', sessionId)
      return null
    }
    return message
  }).filter((message): message is ChatMessage => message !== null)
}

export function buildDbHistory(
  sessionId: string,
  options: {
    excludeLastUser?: boolean
    truncateToolResults?: boolean
  } = {},
): ChatMessage[] {
  const startedAt = Date.now()
  const rows = getSessionContextMessages(sessionId)
  const messages = buildDbHistoryFromContextRows(
    sessionId,
    rows,
    options,
  )
  logContextRead('full', sessionId, startedAt, rows.length, messages.length)
  return messages
}

export function readCursorSnapshotParts(
  sessionId: string,
  snapshot: CompressionSnapshot | null,
  options: {
    excludeLastUser?: boolean
    truncateToolResults?: boolean
  } = {},
): CursorSnapshotReadResult {
  if (!snapshot || snapshot.compressedThroughMessageId == null) return { status: 'legacy' }
  const session = getSession(sessionId)
  if (!session) return { status: 'invalid', reason: 'session_missing' }
  if (session.history_revision !== snapshot.historyRevision) {
    return { status: 'invalid', reason: 'history_revision_mismatch' }
  }
  const cursor = getSessionContextMessage(sessionId, snapshot.compressedThroughMessageId)
  if (!cursor) return { status: 'invalid', reason: 'cursor_missing' }
  if (
    snapshot.protectedHeadThroughMessageId != null &&
    snapshot.protectedHeadThroughMessageId > snapshot.compressedThroughMessageId
  ) {
    return { status: 'invalid', reason: 'protected_head_after_cursor' }
  }
  if (
    snapshot.protectedHeadThroughMessageId != null &&
    !getSessionContextMessage(sessionId, snapshot.protectedHeadThroughMessageId)
  ) {
    return { status: 'invalid', reason: 'protected_head_missing' }
  }

  const startedAt = Date.now()
  const headRows = snapshot.protectedHeadThroughMessageId == null
    ? []
    : getSessionContextMessages(sessionId, {
        throughId: snapshot.protectedHeadThroughMessageId,
      })
  const { rows: newRows, batches } = readPostCursorRows(
    sessionId,
    snapshot.compressedThroughMessageId,
  )
  const head = buildDbHistoryFromContextRows(sessionId, headRows, {
    truncateToolResults: options.truncateToolResults,
  })
  const newMessages = buildDbHistoryFromContextRows(sessionId, newRows, options)
  const elapsedMs = Date.now() - startedAt
  const logPayload = {
    sessionId,
    cursorId: snapshot.compressedThroughMessageId,
    historyRevision: session.history_revision,
    headRows: headRows.length,
    postCursorRows: newRows.length,
    validMessages: head.length + newMessages.length,
    batches,
    elapsedMs,
  }
  logger.info(logPayload, '[context-history] cursor context read')
  if (elapsedMs > 1_000) logger.warn(logPayload, '[context-history] slow cursor context read')
  return {
    status: 'usable',
    parts: {
      head,
      newMessages,
      historyRevision: session.history_revision,
    },
  }
}

export function assembleCursorSnapshotHistory(
  snapshot: CompressionSnapshot,
  parts: CursorSnapshotParts,
  summaryPrefix: string,
): ChatMessage[] {
  return [
    ...parts.head,
    { role: 'user', content: `${summaryPrefix}\n\n${snapshot.summary}` },
    ...parts.newMessages,
  ]
}

function excludeLatestUserAndFollowing(rows: HermesMessageRow[]): HermesMessageRow[] {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index].role === 'user') return rows.slice(0, index)
  }
  return rows
}

function readPostCursorRows(
  sessionId: string,
  cursorId: number,
  batchSize = 500,
): { rows: HermesMessageRow[]; batches: number } {
  const rows: HermesMessageRow[] = []
  let afterId = cursorId
  let batches = 0
  while (true) {
    const batch = getSessionContextMessages(sessionId, { afterId, limit: batchSize })
    if (batch.length === 0) break
    rows.push(...batch)
    batches += 1
    const nextAfterId = Number(batch.at(-1)?.id)
    if (!Number.isSafeInteger(nextAfterId) || nextAfterId <= afterId) break
    afterId = nextAfterId
    if (batch.length < batchSize) break
  }
  return { rows, batches }
}

function logContextRead(
  mode: 'full',
  sessionId: string,
  startedAt: number,
  rawRows: number,
  validMessages: number,
): void {
  const elapsedMs = Date.now() - startedAt
  const payload = { sessionId, mode, rawRows, validMessages, elapsedMs }
  logger.info(payload, '[context-history] context read')
  if (elapsedMs > 1_000) logger.warn(payload, '[context-history] slow context read')
}
