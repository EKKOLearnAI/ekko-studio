import { createHash } from 'crypto'
import type { WorkspaceRunChangeSummary } from '../../repositories/workspace-run-changes-store'
import type { SessionMessage } from './types'

export const RESUME_TOOL_RESULT_DISPLAY_LIMIT = 1_000
export const RESUME_MESSAGE_PAGE_LIMIT = 150

const JSON_STRING_DISPLAY_LIMIT = 200
const JSON_MAX_DEPTH = 6
const JSON_MAX_NODES = 1_000
const JSON_MAX_KEYS_PER_OBJECT = 50
const JSON_MAX_ITEMS_PER_ARRAY = 50
const JSON_TRUNCATED_KEY = '__truncated__'
const TRUNCATED_MARKER = '... (truncated)'

type ResumeMessage = SessionMessage & Record<string, unknown>
type RunEventRecord = { event: string; data: any }

export type OutboundToolMessage = Record<string, unknown> & {
  role?: string
  content?: string
  display_role?: string | null
  display_content?: string | null
  tool_name?: string | null
}

export interface OutboundToolMessageOptions {
  preserveToolNames?: readonly string[]
}

export interface ResumeMessagePageOptions {
  limit?: number
  messageTotal?: number
  messageStateBaselineCount?: number
}

export interface ResumeMessagePage {
  projection?: string
  taskPlans?: import('../../contracts/task-plan').TaskPlanSnapshot[]
  messages: SessionMessage[]
  workspaceRunChanges?: WorkspaceRunChangeSummary[]
  messageTotal: number
  messageLoadedCount: number
  messagePageLimit: number
  hasMoreBefore: boolean
}

export type AppResumeMessagePage = Omit<ResumeMessagePage, 'messages'> & {
  id: string
  messages?: SessionMessage[]
  messagesCached: boolean
}

function stringifyLength(value: unknown): number {
  try {
    return JSON.stringify(value, null, 2)?.length || 0
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function truncateJsonValue(value: unknown): unknown {
  let nodeCount = 0
  const seen = new WeakSet<object>()

  function visit(current: unknown, depth: number): unknown {
    nodeCount += 1
    if (nodeCount > JSON_MAX_NODES) return TRUNCATED_MARKER
    if (typeof current === 'string') {
      return current.length > JSON_STRING_DISPLAY_LIMIT
        ? `${current.slice(0, JSON_STRING_DISPLAY_LIMIT)}\n${TRUNCATED_MARKER}`
        : current
    }
    if (current === null || typeof current !== 'object') return current
    if (seen.has(current)) return `[Circular ${TRUNCATED_MARKER}]`
    if (depth >= JSON_MAX_DEPTH) {
      return Array.isArray(current)
        ? `[Array ${TRUNCATED_MARKER}]`
        : `[Object ${TRUNCATED_MARKER}]`
    }

    seen.add(current)
    if (Array.isArray(current)) {
      const result: unknown[] = []
      const maxItems = Math.min(current.length, JSON_MAX_ITEMS_PER_ARRAY)
      for (let index = 0; index < maxItems; index += 1) {
        const remaining = current.length - index
        result.push(visit(current[index], depth + 1))
        if (stringifyLength(result) > RESUME_TOOL_RESULT_DISPLAY_LIMIT) {
          result.pop()
          result.push(`${TRUNCATED_MARKER}: ${remaining} more items`)
          seen.delete(current)
          return result
        }
      }
      if (current.length > maxItems) {
        result.push(`${TRUNCATED_MARKER}: ${current.length - maxItems} more items`)
      }
      seen.delete(current)
      return result
    }

    const entries = Object.entries(current as Record<string, unknown>)
    const result: Record<string, unknown> = {}
    const maxKeys = Math.min(entries.length, JSON_MAX_KEYS_PER_OBJECT)
    for (let index = 0; index < maxKeys; index += 1) {
      const [key, entryValue] = entries[index]
      const remaining = entries.length - index
      result[key] = visit(entryValue, depth + 1)
      if (stringifyLength(result) > RESUME_TOOL_RESULT_DISPLAY_LIMIT) {
        delete result[key]
        result[JSON_TRUNCATED_KEY] = `${TRUNCATED_MARKER}: ${remaining} more keys`
        seen.delete(current)
        return result
      }
    }
    if (entries.length > maxKeys) {
      result[JSON_TRUNCATED_KEY] = `${TRUNCATED_MARKER}: ${entries.length - maxKeys} more keys`
    }
    seen.delete(current)
    return result
  }

  const truncated = visit(value, 0)
  return stringifyLength(truncated) <= RESUME_TOOL_RESULT_DISPLAY_LIMIT
    ? truncated
    : { [JSON_TRUNCATED_KEY]: TRUNCATED_MARKER }
}

function looksLikeUnifiedDiff(content: string): boolean {
  const lines = content.trimStart().split('\n', 12)
  const hasFileHeader = lines.some(line => line.startsWith('diff --git ') || line.startsWith('--- '))
  const hasTargetHeader = lines.some(line => line.startsWith('+++ '))
  const hasHunk = lines.some(line => line.startsWith('@@ '))
  return hasFileHeader && (hasTargetHeader || hasHunk)
}

function truncateToolResult(content: string): string {
  if (content.length <= RESUME_TOOL_RESULT_DISPLAY_LIMIT || looksLikeUnifiedDiff(content)) return content

  if (/^[\[{]/.test(content.trim())) {
    try {
      return JSON.stringify(truncateJsonValue(JSON.parse(content)), null, 2)
    } catch {
      // Preserve the existing plain-text rendering for incomplete JSON output.
    }
  }

  const suffix = `\n${TRUNCATED_MARKER}`
  const previewLength = RESUME_TOOL_RESULT_DISPLAY_LIMIT - suffix.length
  return `${content.slice(0, previewLength)}${suffix}`
}

function truncateMessageField(
  target: OutboundToolMessage,
  field: 'content' | 'display_content',
): boolean {
  const content = target[field]
  if (typeof content !== 'string' || content.length <= RESUME_TOOL_RESULT_DISPLAY_LIMIT) return false
  const truncated = truncateToolResult(content)
  if (truncated === content) return false
  target[field] = truncated
  target[`${field}_truncated`] = true
  target[`${field}_original_length`] = content.length
  return true
}

/**
 * Bound one display-only tool message without changing the persisted/runtime
 * message. Consumers may exempt tool payloads that are fetched and rendered as
 * first-class data instead of ordinary text (for example workspace diffs).
 */
export function buildOutboundToolMessage<T extends OutboundToolMessage>(
  message: T,
  options: OutboundToolMessageOptions = {},
): T {
  const isToolResult = message.role === 'tool'
    || message.role === 'moa'
    || message.display_role === 'tool'
  if (!isToolResult) return message

  const toolName = typeof message.tool_name === 'string' ? message.tool_name : ''
  if (toolName && options.preserveToolNames?.includes(toolName)) return message

  const outbound = { ...message } as T
  const contentTruncated = truncateMessageField(outbound, 'content')
  const displayContentTruncated = truncateMessageField(outbound, 'display_content')
  return contentTruncated || displayContentTruncated ? outbound : message
}

/**
 * Build the display-only message page emitted by `resume`.
 *
 * The session state and persisted history intentionally retain complete tool
 * results. Only cloned outbound tool rows are bounded to the same 1000-character
 * display threshold previously enforced by the Studio client.
 */
export function buildResumeMessages(messages: SessionMessage[]): SessionMessage[] {
  return messages.map(message => buildOutboundToolMessage(message as ResumeMessage) as SessionMessage)
}

/**
 * Page the display-only resume snapshot without trimming runtime state. The
 * persisted total can be larger than the in-memory window after a cold load,
 * while the in-memory window can grow during a long-lived server process.
 */
export function buildResumeMessagePage(
  messages: SessionMessage[],
  options: ResumeMessagePageOptions = {},
): ResumeMessagePage {
  const requestedLimit = Number(options.limit)
  const messagePageLimit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.floor(requestedLimit)
    : RESUME_MESSAGE_PAGE_LIMIT
  const persistedTotal = Number(options.messageTotal)
  const stateBaselineCount = Number(options.messageStateBaselineCount)
  const appendedCount = Number.isFinite(stateBaselineCount)
    ? Math.max(0, messages.length - Math.floor(stateBaselineCount))
    : 0
  const messageTotal = Math.max(
    messages.length,
    Number.isFinite(persistedTotal) ? Math.floor(persistedTotal) + appendedCount : 0,
  )
  const page = messages.slice(-messagePageLimit)
  const messageLoadedCount = Math.min(messageTotal, messagePageLimit)

  return {
    messages: buildResumeMessages(page),
    messageTotal,
    messageLoadedCount,
    messagePageLimit,
    hasMoreBefore: messageTotal > messageLoadedCount,
  }
}

/**
 * Build the App-only conditional message page. The App persists the last full
 * page under this opaque id and sends the id with every `app.resume`. When the
 * page is unchanged, only pagination metadata and live run state cross the
 * relay; the App reuses its cached messages.
 */
export function buildAppResumeMessagePage(
  page: ResumeMessagePage,
  cachedIdInput: unknown,
): AppResumeMessagePage {
  const id = createHash('sha256')
    .update(JSON.stringify(page))
    .digest('hex')
    .slice(0, 32)
  const cachedId = typeof cachedIdInput === 'string' ? cachedIdInput.trim() : ''
  if (cachedId && cachedId === id) {
    return {
      id,
      messagesCached: true,
      ...(page.projection ? { projection: page.projection } : {}),
      ...(page.taskPlans ? { taskPlans: page.taskPlans } : {}),
      messageTotal: page.messageTotal,
      messageLoadedCount: page.messageLoadedCount,
      messagePageLimit: page.messagePageLimit,
      hasMoreBefore: page.hasMoreBefore,
    }
  }
  return { ...page, id, messagesCached: false }
}

/**
 * Bound a live tool result only at the WebSocket delivery boundary. Callers
 * keep using the original payload for persistence, webhooks and state.
 */
export function buildOutboundRunEvent(event: string, payload: any): any {
  if (event !== 'tool.completed' && event !== 'tool.failed') return payload
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload

  const outbound = { ...payload }
  let changed = false
  if (typeof outbound.output === 'string' && outbound.output.length > RESUME_TOOL_RESULT_DISPLAY_LIMIT) {
    const output = truncateToolResult(outbound.output)
    if (output !== outbound.output) {
      outbound.output = output
      outbound.output_truncated = true
      outbound.output_original_length = payload.output.length
      changed = true
    }
  }

  if (typeof outbound.preview === 'string') {
    const singleLinePreview = outbound.preview.replace(/\s+/g, ' ').trim()
    const preview = singleLinePreview.length > 100
      ? `${singleLinePreview.slice(0, 97)}...`
      : singleLinePreview
    if (preview !== outbound.preview) {
      outbound.preview = preview
      if (singleLinePreview.length > 100) {
        outbound.preview_truncated = true
        outbound.preview_original_length = payload.preview.length
      }
      changed = true
    }
  }
  return changed ? outbound : payload
}

export function buildResumeEvents(events: RunEventRecord[], nowMs = Date.now()): RunEventRecord[] {
  return events.map((entry) => {
    let data = buildOutboundRunEvent(entry.event, entry.data)
    if (entry.event === 'approval.requested' || entry.event === 'clarify.requested') {
      const timeoutMs = Number(data?.timeout_ms)
      const requestedAt = Number(data?.requested_at)
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        const elapsedMs = Number.isFinite(requestedAt) && requestedAt > 0
          ? Math.max(0, nowMs - requestedAt)
          : 0
        data = {
          ...data,
          remaining_timeout_ms: Math.max(0, Math.trunc(timeoutMs - elapsedMs)),
        }
      }
    }
    return data === entry.data ? entry : { ...entry, data }
  })
}
