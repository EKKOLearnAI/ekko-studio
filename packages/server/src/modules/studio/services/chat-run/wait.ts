import type { DirectChatRunHandle } from './direct'

type ChatRunEvent = Record<string, unknown> & {
  event?: string
  session_id?: string
  run_id?: string
  delta?: string
  text?: string
  output?: string | null
  reasoning?: string | null
  error?: unknown
}

const CHAT_RUN_EVENTS = [
  'run.started',
  'message.delta',
  'message.interim',
  'reasoning.delta',
  'thinking.delta',
  'reasoning.available',
  'tool.started',
  'tool.completed',
  'tool.failed',
  'workspace.diff.completed',
  'plan.updated',
  'run.completed',
  'run.failed',
  'compression.started',
  'compression.completed',
  'abort.started',
  'abort.timeout',
  'abort.completed',
  'usage.updated',
  'agent.event',
  'subagent.event',
  'session.command',
  'session.title.updated',
  'run.queued',
  'approval.requested',
  'approval.resolved',
  'clarify.requested',
  'clarify.resolved',
  'location.requested',
  'location.resolved',
  'calendar.requested',
  'calendar.resolved',
  'reminder.requested',
  'reminder.resolved',
  'health.requested',
  'health.resolved',
  'peer.user.message',
]

const MAX_RECORDED_EVENTS = 1000

export interface ChatRunHttpResult { status: number; body: Record<string, unknown> }

/** A timeout detaches the response observer; it never aborts accepted work. */
export function waitForChatRun(options: {
  sessionId: string
  timeoutMs: number
  includeEvents: boolean
  start(onEvent: (event: string, payload: ChatRunEvent) => void): DirectChatRunHandle
  watch?(invalidate: () => void): () => void
}): Promise<ChatRunHttpResult> {
  return new Promise(resolve => {
    const events: ChatRunEvent[] = []
    let output = ''
    let reasoning = ''
    let runId = ''
    let settled = false
    let handle: DirectChatRunHandle | undefined
    let stopWatching: (() => void) | undefined
    let revoked = false
    const cleanup = () => {
      clearTimeout(timer)
      const stop = stopWatching
      stopWatching = undefined
      stop?.()
      const current = handle
      handle = undefined
      current?.dispose()
      // Let every invalidated share observer disconnect before queue broadcasts.
      if (revoked && current) queueMicrotask(() => current.dropQueued())
    }
    const finish = (status: number, response: Record<string, unknown>) => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ status, body: {
        ...response, session_id: options.sessionId, run_id: runId || undefined,
        output, ...(reasoning ? { reasoning } : {}), ...(options.includeEvents ? { events } : {}),
      } })
    }
    const timer = setTimeout(() => finish(504, {
      ok: false, status: 'timeout', error: `chat-run timed out after ${options.timeoutMs}ms`,
    }), options.timeoutMs)
    const onEvent = (eventName: string, event: ChatRunEvent = {}) => {
      if (settled || !CHAT_RUN_EVENTS.includes(eventName)) return
      const tagged = { ...event, event: event.event || eventName }
      if (options.includeEvents) {
        if (events.length >= MAX_RECORDED_EVENTS) events.shift()
        events.push(tagged)
      }
      if (typeof tagged.run_id === 'string' && tagged.run_id) runId = tagged.run_id
      if (eventName === 'message.delta' && typeof tagged.delta === 'string') output += tagged.delta
      if ((eventName === 'reasoning.delta' || eventName === 'thinking.delta') && typeof tagged.delta === 'string') reasoning += tagged.delta
      if (eventName === 'run.completed') {
        if (typeof tagged.output === 'string' && tagged.output) output = tagged.output
        if (typeof tagged.reasoning === 'string' && tagged.reasoning) reasoning = tagged.reasoning
        finish(200, { ok: true, status: 'completed', event: eventName })
      } else if (eventName === 'run.failed') {
        finish(500, { ok: false, status: 'failed', event: eventName, error: tagged.error || 'chat-run failed' })
      } else if (eventName === 'approval.requested' || eventName === 'clarify.requested') {
        finish(409, { ok: false, status: 'requires_action', event: eventName, action: tagged })
      }
    }
    try {
      stopWatching = options.watch?.(() => {
        if (settled) return
        revoked = true
        // Do not return previously collected private content after access is revoked.
        output = ''; reasoning = ''; events.length = 0
        finish(403, { ok: false, status: 'failed', error: 'share_access_denied' })
      })
      if (!settled) handle = options.start(onEvent)
    } catch (error) {
      finish(503, { ok: false, status: 'connect_error', error: error instanceof Error ? error.message : String(error) })
    }
    // Ports and policy watchers may reply synchronously before returning their disposers.
    if (settled) cleanup()
  })
}
