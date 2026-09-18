import { config } from '../../public/config'
import { getPushTargetById } from '../../repositories/run-push-store'
import { getSession } from '../../repositories/session-store'
import type { BusinessEvent } from '../webhooks/business-events'
import { groupReplyNotification } from '../group-chat/foreground-notification'
import { readRunPushNotification } from './run-push-snapshot'

const PUSH_EVENTS: Record<string, 'completion' | 'failure' | 'approval' | 'interaction'> = {
  'chat.run.completed': 'completion', 'chat.run.failed': 'failure',
  'chat.approval.requested': 'approval', 'chat.clarification.requested': 'interaction',
  'group.message.created': 'completion', 'group.run.failed': 'failure',
  'group.approval.requested': 'approval', 'group.clarification.requested': 'interaction',
  'workflow.run.completed': 'completion', 'workflow.run.failed': 'failure',
}
const plain = (value: unknown, max: number) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : ''

/** Independent consumer: no dispatcher queue, retries, grant lookup or token renewal. */
export function createRunPushConsumer(send: typeof fetch = (...args) => fetch(...args)) {
  const attempted = new Set<string>()
  return async (event: BusinessEvent): Promise<void> => {
    const kind = PUSH_EVENTS[event.type], payload = event.payload
    if (!kind || !event.push_target_id || payload.replayed === true || payload.restored === true || payload.background_snapshot === true) return
    // Group replies and workflow terminals have their own persisted domain events.
    if (event.type.startsWith('chat.') && event.source === 'group_chat') return
    if (event.type.startsWith('chat.run.') && event.source === 'workflow') return
    // Workflow execution currently answers node approvals automatically with "once".
    if (event.type === 'chat.approval.requested' && event.source === 'workflow') return
    if (event.type.startsWith('chat.run.') && (payload.interrupted === true || payload.stop_reason === 'queue_insertion'
      || payload.stop_reason === 'aborted' || payload.stop_reason === 'cancelled' || payload.stop_reason === 'canceled')) return
    try {
      const run = getPushTargetById(event.push_target_id)
      if (!run || run.profile !== event.profile) return
      if (event.type.startsWith('group.') && (run.kind !== 'group' || event.subject.room_id !== run.subject_id)) return
      if (event.type.startsWith('workflow.') && (run.kind !== 'workflow' || event.subject.workflow_id !== run.subject_id || event.subject.run_id !== run.run_id)) return
      if (event.type.startsWith('chat.') && (run.kind === 'chat' ? event.subject.session_id !== run.subject_id
        : run.kind !== 'workflow' || event.subject.workflow_id !== run.subject_id)) return
      if (kind === 'approval' && !event.subject.approval_id || kind === 'interaction' && !event.subject.clarification_id) return
      const snapshot = readRunPushNotification({ kind: run.kind, profile: run.profile, runId: run.run_id })
      if (!snapshot || snapshot.recipient.platform !== 'ios') return
      let title = '', body = ''
      if (event.type === 'group.message.created') {
        const notice = groupReplyNotification(payload.room as Parameters<typeof groupReplyNotification>[0], payload.message as Parameters<typeof groupReplyNotification>[1])
        if (!notice) return
        title = notice.title; body = notice.content
      } else if (run.kind === 'chat') {
        title = plain(getSession(run.subject_id)?.title, 120)
        if (kind === 'completion') body = plain(payload.output, 240)
      } else {
        title = plain((payload.display as Record<string, unknown> | undefined)?.title
          || (payload.room as Record<string, unknown> | undefined)?.name, 120)
      }
      const interaction = event.subject.approval_id || event.subject.clarification_id
      // Runtime IDs can be reused across chat turns. Root identity owns terminal dedupe.
      const occurrence = interaction ? `${kind}:${interaction}` : run.kind === 'group'
        ? `reply:${event.subject.run_id || event.subject.message_id || event.id}` : 'terminal'
      const key = `${run.id}:${occurrence}`
      if (attempted.has(key)) return
      attempted.add(key)
      if (attempted.size > 2000) attempted.delete(attempted.values().next().value!)
      const response = await send(new URL('/push/v1/send', config.appRelay.url), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${snapshot.credential}` },
        body: JSON.stringify({ schema_version: 1, event_id: event.id, event_type: kind,
          recipient: snapshot.recipient, notification: { title, body }, ekko_run: snapshot.route }),
      })
      // The response (including 401/429/5xx) ends the attempt. Never log credential-bearing responses.
      await response.body?.cancel()
    } catch { /* Push failure must not affect run completion or other webhook consumers. */ }
  }
}
