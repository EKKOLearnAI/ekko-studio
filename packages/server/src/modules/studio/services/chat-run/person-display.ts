import { isPersonSession } from '../../contracts/person-session'

export const PERSON_DISPLAY_PROJECTION = 'person-display-v1'
type Data = Record<string, any>

/** Copy only declared scalar fields; opaque provider/runtime objects never cross this boundary. */
function pick(value: any, keys: string): Data {
  const result: Data = {}
  for (const key of keys.split(' ')) {
    const item = value?.[key]
    if (item === null || ['string', 'number', 'boolean'].includes(typeof item)) result[key] = item
  }
  return result
}

const usageKeys = 'runId assistantMessageId inputTokens outputTokens cacheReadTokens cacheHitRate costUsd tokensPerSecond speedSource isEstimated'
const receiptKeys = 'taskId executionId assistantMessageId title summary agent state'
function taskReturn(value: any): Data {
  return { ...pick(value, receiptKeys),
    ...(Array.isArray(value?.relatedTasks) ? { relatedTasks: value.relatedTasks.slice(0, 1).map((item: any) => pick(item, receiptKeys)) } : {}) }
}
const tokenKeys = 'input_tokens output_tokens total_tokens cache_read_tokens cache_write_tokens reasoning_tokens cost_usd inputTokens outputTokens cacheReadTokens cacheWriteTokens contextTokens context_tokens systemPromptTokens toolTokens messageTokens toolCount'

function plan(value: any): Data {
  return { ...pick(value, 'session_id run_id plan_id revision execution_state explanation created_at updated_at'),
    plan: Array.isArray(value?.plan) ? value.plan.map((step: any) => pick(step, 'id step status')) : [] }
}

function workspaceChange(value: any): Data {
  return { ...pick(value, 'change_id room_id message_id assistant_message_id session_id run_id source workspace workspace_kind started_at finished_at files_changed additions deletions truncated total_patch_bytes created_at'),
    files: Array.isArray(value?.files) ? value.files.map((file: any) => pick(file,
      'id change_id session_id path old_path change_type additions deletions size_before size_after patch_bytes truncated binary created_at')) : [] }
}

/** Code examples are display text. Unclosed reasoning is always private, including at end of a run. */
export function personVisibleText(input: string, streaming = false): string {
  const code: string[] = []
  let text = input.replace(/(^|\n)( {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\2\3[ \t]*(?=\n|$)|`[^`\n]*`/g, block => {
    code.push(block)
    return `\u0000PERSONCODE${code.length - 1}\u0000`
  })
  if (streaming) {
    // Hold incomplete code and tag prefixes until their meaning is known.
    text = text.replace(/(^|\n) {0,3}(?:`{3,}|~{3,})[^]*$/, '')
    text = text.replace(/`[^`]*$/, '').replace(/<[^>]*$/, '')
  }
  let body = ''
  let end = 0
  const tags: string[] = []
  for (const match of text.matchAll(/<(\/?)(think|thinking|reasoning)>/gi)) {
    if (tags.length === 0) body += text.slice(end, match.index)
    const tag = match[2].toLowerCase()
    if (!match[1]) tags.push(tag)
    else if (tags.at(-1) === tag) tags.pop()
    end = match.index! + match[0].length
  }
  text = body + (tags.length === 0 ? text.slice(end) : '')
  return text.replace(/\u0000PERSONCODE(\d+)\u0000/g, (_, index) => code[Number(index)] || '')
}

function displayContent(value: unknown, assistant: boolean, streaming = false): string {
  let parsed = value
  if (typeof parsed === 'string') {
    if (!assistant) return parsed
    // Both raw arrays and double-serialized native blocks occur in persisted history.
    for (let depth = 0; depth < 2; depth++) {
      try {
        const next = JSON.parse(parsed as string)
        if (typeof next !== 'string' && !Array.isArray(next)) break
        parsed = next
        if (Array.isArray(parsed)) break
      } catch { break }
    }
    if (typeof parsed === 'string') {
      if ((streaming && parsed.trimStart().startsWith('['))
        || /^\s*\[\s*\{[\s\S]*?"type"\s*:\s*"(?:thinking|redacted_thinking|reasoning|tool_use|tool_result|text)"/.test(parsed)) return ''
      return personVisibleText(value as string, streaming)
    }
  }
  if (!Array.isArray(parsed)) return ''
  if (!parsed.some(block => block && typeof block === 'object' && typeof block.type === 'string')) {
    return typeof value === 'string' ? personVisibleText(value, streaming) : JSON.stringify(parsed)
  }
  const blocks = parsed.flatMap((block: any) => {
    if (block?.type === 'text' && typeof block.text === 'string') {
      return [{ type: 'text', text: assistant ? personVisibleText(block.text, streaming) : block.text }]
    }
    if (['image', 'file'].includes(block?.type)) {
      return [pick(block, 'type name path media_type video_frame')]
    }
    if (block?.type === 'image_url') {
      return [{ type: 'image_url', image_url: pick(block.image_url, 'url detail') }]
    }
    return []
  })
  return blocks.every(block => block.type === 'text')
    ? blocks.map(block => block.text).join('') : JSON.stringify(blocks)
}

/**
 * Keep one inert slot per source row. Released clients advance raw OFFSET by
 * messages.length and stop on empty pages, so deleting hidden rows loses history.
 * Empty assistant slots are already ignored by both clients' display mappers.
 */
export function personDisplayMessages<T>(sessionId: string, messages: T[]): T[] {
  if (!isPersonSession(sessionId)) return messages
  return messages.map((input: any) => {
    const role = input.display_role || input.role
    const visible = !['tool', 'moa'].includes(input.role) && ['user', 'assistant', 'command'].includes(role)
    const result = { ...pick(input, 'id session_id timestamp runMarker run_marker'),
      role: visible ? role : 'assistant',
      content: visible ? displayContent(input.display_content ?? input.content, role === 'assistant') : '' } as Data
    if (visible) {
      Object.assign(result, pick(input, 'finish_reason token_count'))
      if (input.run_usage) result.run_usage = pick(input.run_usage, usageKeys)
      if (input.person_task_return) result.person_task_return = taskReturn(input.person_task_return)
    }
    return result as T
  })
}

export function personDisplayPage<T extends { messages: any[] }>(sessionId: string, page: T): T {
  if (!isPersonSession(sessionId)) return page
  return { ...page, projection: PERSON_DISPLAY_PROJECTION, messages: personDisplayMessages(sessionId, page.messages) }
}

/** Metadata previews can start halfway through a native block or thinking tag. */
export function personDisplayMetadata<T extends { id?: unknown }>(session: T): T {
  if (typeof session.id !== 'string' || !isPersonSession(session.id)) return session
  const result: Data = { ...session }
  if ('preview' in result) result.preview = ''
  if ('parent_last_message' in result) result.parent_last_message = null
  return result as T
}

/** Person HTTP operations return either a session or an envelope of session metadata. */
export function personDisplayResponse(value: any): any {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const result = personDisplayMetadata(value)
  return { ...result,
    ...(value.session ? { session: personDisplayMetadata(value.session) } : {}),
    ...(Array.isArray(value.sessions) ? { sessions: value.sessions.map(personDisplayMetadata) } : {}),
  }
}

export function personDisplayBackgroundTasks(sessionId: string, tasks: any[]): any[] {
  if (!isPersonSession(sessionId)) return tasks
  return tasks.map(task => pick(task, 'id subagent_id delegation_id run_id parent_run_id child_run_id status background model started_at completed_at updated_at duration_seconds task_index task_count tool_count api_calls input_tokens output_tokens cache_read_tokens cache_write_tokens reasoning_tokens'))
}

const common = 'event session_id run_id run_marker message_id queue_id timestamp replayed restored background_snapshot'
const controls: Record<string, string> = {
  'run.started': 'model provider queue_length autonomous delegation_id',
  'run.completed': 'interrupted boundary_interrupt queue_remaining background_pending autonomous delegation_id stop_reason',
  'run.failed': 'error code queue_remaining background_pending stop_reason interrupted',
  'run.reattach_failed': 'error code retryable',
  'abort.started': 'queue_length', 'abort.completed': 'queue_length background_pending',
  'abort.timeout': 'message synced',
  'usage.updated': tokenKeys, 'run.usage.updated': tokenKeys, 'context.estimated': tokenKeys,
  'context.updated': tokenKeys,
  'compression.started': 'automatic message_count token_count source',
  'compression.completed': 'automatic before_tokens after_tokens compressed failed error source message_count token_count original_tokens compressed_tokens original_message_count compressed_message_count ratio saved_tokens llmCompressed totalMessages resultMessages beforeTokens afterTokens contextTokens summaryTokens verbatimCount compressedStartIndex',
  'compression.failed': 'error',
  'session.command': 'command action started terminal ok message',
  'session.workspace.updated': 'workspace',
  'session.settings.updated': 'model provider api_mode reasoning_effort push_enabled',
  'run.queue_insertion.updated': 'generation phase guarantee runtime requested_at',
  'run.queued': 'queue_length', 'run.dequeued': 'queue_length',
  'delegation.updated': 'delegation_id status background_pending',
  'subagent.start': 'subagent_id parent_run_id child_run_id status background model task_index task_count',
  'subagent.complete': 'subagent_id parent_run_id child_run_id status background task_index task_count duration_seconds tool_count api_calls',
  'workspace.diff.completed': '',
}
const interactionKeys = 'approval_id clarify_id location_request_id calendar_request_id reminder_request_id health_request_id command description tool permission_key allow_permanent question timeout_ms remaining_timeout_ms requested_at durable choice resolved reason stale error code target_device_id target_user_id target_profile capability action request_id purpose start_ms end_ms include_completed limit expires_at_ms status'

/** Unknown event families fail closed. Interactions are explicit business data, not tool logs. */
export function personDisplayEvent(sessionId: string, event: string, payload: any): Data | null {
  if (!isPersonSession(sessionId)) return payload
  if (event === 'plan.updated') return { ...pick(payload, common), ...plan(payload) }
  const interaction = /^(approval|clarify|location|calendar|reminder|health)\.(requested|resolved)$/.test(event)
  const keys = interaction ? interactionKeys : controls[event]
  if (keys === undefined) return null
  const result = pick(payload, `${common} ${keys}`)
  if (interaction && Array.isArray(payload?.choices)) result.choices = payload.choices.filter((choice: any) => typeof choice === 'string')
  if (interaction && Array.isArray(payload?.metrics)) result.metrics = payload.metrics.filter((metric: any) => typeof metric === 'string')
  if (interaction && payload?.item) result.item = pick(payload.item, 'id title notes location start_ms end_ms all_day reminder_minutes due_ms priority completed')
  if (interaction && payload?.error && typeof payload.error === 'object') result.error = pick(payload.error, 'code')
  if (event === 'run.completed') result.output = displayContent(payload?.output, true)
  if (payload?.run_usage) result.run_usage = pick(payload.run_usage, usageKeys)
  if (payload?.person_task_return) result.person_task_return = taskReturn(payload.person_task_return)
  if (payload?.usage) result.usage = pick(payload.usage, tokenKeys)
  if (payload?.contextEstimate) result.contextEstimate = pick(payload.contextEstimate, tokenKeys)
  if (payload?.workspace_run_change) result.workspace_run_change = workspaceChange(payload.workspace_run_change)
  return result
}

/** A live stream must retain tag boundaries across arbitrarily split provider deltas. */
export function createPersonDisplayStream(sessionId: string) {
  let source = ''
  let sent = ''
  return (event: string, payload: any): any => {
    if (!isPersonSession(sessionId)) return payload
    if (event === 'run.started') { source = ''; sent = '' }
    if (event !== 'message.delta') return personDisplayEvent(sessionId, event, payload)
    source += typeof payload?.delta === 'string' ? payload.delta : ''
    const visible = displayContent(source, true, true)
    if (!visible.startsWith(sent) || visible === sent) return null
    const delta = visible.slice(sent.length)
    sent = visible
    return { ...pick(payload, common), delta }
  }
}

export function personDisplayEvents(sessionId: string, events: Array<{ event: string; data: any }>) {
  if (!isPersonSession(sessionId)) return events
  // The replay ring can start inside a reasoning tag. Never interpret an orphan
  // delta as visible text; a complete run boundary makes reconstruction safe.
  const stream = createPersonDisplayStream(sessionId)
  let started = false
  return events.flatMap(entry => {
    if (entry.event === 'run.started') started = true
    if (entry.event === 'message.delta' && !started) return []
    const data = stream(entry.event, entry.data)
    return data === null ? [] : [{ event: entry.event, data }]
  })
}
