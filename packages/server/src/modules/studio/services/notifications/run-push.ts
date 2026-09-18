import { config } from '../../public/config'
import { logger } from '../../public/logging'
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

type PushResponse = { accepted?: boolean; apns_id?: string }
type RunPushConsumerOptions = {
  retryDelaysMs?: number[]
  wait?: (delayMs: number) => Promise<void>
}

const retryableStatus = (status: number) => status === 408 || status === 429 || status >= 500
const waitFor = (delayMs: number) => new Promise<void>(resolve => setTimeout(resolve, delayMs))
const errorKind = (error: unknown) => error instanceof DOMException && error.name === 'TimeoutError'
  ? 'timeout' : error instanceof Error && error.name === 'AbortError' ? 'aborted'
    : error instanceof TypeError ? 'network' : 'unknown'

async function providerResponse(response: Response): Promise<PushResponse> {
  try {
    const value = await response.json() as Record<string, unknown>
    return {
      ...(typeof value.accepted === 'boolean' ? { accepted: value.accepted } : {}),
      ...(typeof value.apns_id === 'string' ? { apns_id: value.apns_id } : {}),
    }
  } catch {
    await response.body?.cancel().catch(() => {})
    return {}
  }
}

/** Independent consumer: no dispatcher queue, grant lookup or token renewal. */
export function createRunPushConsumer(
  send: typeof fetch = (...args) => fetch(...args),
  options: RunPushConsumerOptions = {},
) {
  const settled = new Set<string>()
  const inFlight = new Set<string>()
  const retryDelaysMs = options.retryDelaysMs || [250, 1_000]
  const wait = options.wait || waitFor
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
      if (settled.has(key) || inFlight.has(key)) return
      inFlight.add(key)
      try {
        for (let attempt = 1; attempt <= retryDelaysMs.length + 1; attempt++) {
          try {
            const response = await send(new URL('/push/v1/send', config.appRelay.url), {
              method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${snapshot.credential}` },
              body: JSON.stringify({ schema_version: 1, event_id: event.id, event_type: kind,
                recipient: snapshot.recipient, notification: { title, body }, ekko_run: snapshot.route }),
            })
            const result = await providerResponse(response)
            const accepted = response.status >= 200 && response.status < 300 && result.accepted !== false
            const fields = { eventType: event.type, runKind: run.kind, status: response.status, accepted,
              ...(result.apns_id ? { apnsId: result.apns_id } : {}), attempt }
            if (accepted) {
              settled.add(key)
              logger.info(fields, '[run-push] notification accepted')
              break
            }
            const retry = retryableStatus(response.status) && attempt <= retryDelaysMs.length
            logger.warn({ ...fields, retry }, '[run-push] notification rejected')
            if (!retry) {
              if (!retryableStatus(response.status)) settled.add(key)
              break
            }
          } catch (error) {
            const retry = attempt <= retryDelaysMs.length
            logger.warn({ eventType: event.type, runKind: run.kind, attempt, retry, errorKind: errorKind(error) },
              '[run-push] notification request failed')
            if (!retry) break
          }
          await wait(retryDelaysMs[attempt - 1])
        }
      } finally {
        inFlight.delete(key)
        if (settled.size > 2000) settled.delete(settled.values().next().value!)
      }
    } catch { /* Push failure must not affect run completion or other webhook consumers. */ }
  }
}
