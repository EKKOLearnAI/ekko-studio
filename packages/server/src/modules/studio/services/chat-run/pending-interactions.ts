import type { SessionState } from './types'
import { buildResumeEvents } from './resume-payload'

type Entry = SessionState['events'][number]
type Pending = Map<string, Entry>

function update(pending: Pending, event: string, data: Entry['data']) {
  const id = event === 'approval.requested' || event === 'approval.resolved' ? data?.approval_id
    : event === 'clarify.requested' || event === 'clarify.resolved' ? data?.clarify_id : undefined
  if (!id) return
  const key = `${event.split('.')[0]}:${id}`
  if (event.endsWith('.requested')) pending.set(key, { event, data })
  else if (data.stale || data.resolved !== false || ['timeout', 'timed_out', 'aborted', 'cancelled', 'canceled'].includes(data.reason || data.outcome)) pending.delete(key)
}

function pendingFrom(history: Entry[]): Pending {
  const pending: Pending = new Map()
  for (const { event, data } of history) update(pending, event, data)
  return pending
}

/** Pending requests can outlive the bounded transcript and can settle on another socket. */
export class PendingChatInteractions {
  private readonly runs = new WeakMap<SessionState, Pending>()

  observe(state: SessionState, event: string, data: Entry['data']) {
    if (event === 'run.started' || event === 'run.completed' || event === 'run.failed' || event === 'abort.completed') {
      this.runs.set(state, new Map())
      return
    }
    if (!event.startsWith('approval.') && !event.startsWith('clarify.')) return
    let pending = this.runs.get(state)
    if (!pending) {
      pending = pendingFrom(state.events)
      this.runs.set(state, pending)
    }
    update(pending, event, data)
  }

  snapshot(state: SessionState) {
    const pending = this.runs.get(state) || pendingFrom(state.events)
    return buildResumeEvents([...pending.values()]).filter(entry => entry.data.remaining_timeout_ms !== 0)
  }
}
