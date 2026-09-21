import { listLiveActivityDestinations } from '../../repositories/live-activity-store'
import { findUserById } from '../../repositories/users-store'
import { canReceiveAppEvent } from '../webhooks/app-events'
import { randomUUID } from 'node:crypto'
import { getChatRunServer } from '../chat-run/server-registry'
import { taskPlanWebhookSnapshot } from '../webhooks/task-plan'
import type { BusinessEvent } from '../webhooks/business-events'

let deliver: ((event: BusinessEvent, connectionId: number) => Promise<void>) | undefined
const pending = new Set<number>()
const lastAttempt = new Map<number, number>()
export function configureLiveActivityCatchup(consumer: typeof deliver): void { deliver = consumer }

/** Only the newly registered connection, with fresh live runtime evidence.
 * Snapshot events bypass neither consumer permission checks nor replay protection.
 */
export async function catchUpLiveActivities(connectionId: number): Promise<void> {
  if (!deliver || pending.has(connectionId)) return
  if (Date.now() - (lastAttempt.get(connectionId) || 0) < 120_000) return
  const device = listLiveActivityDestinations().find(row => row.connection_id === connectionId && row.enabled)
  const user = device && findUserById(device.user_id)
  if (!user || user.status !== 'active') return
  lastAttempt.set(connectionId, Date.now())
  if (lastAttempt.size > 1000) lastAttempt.delete(lastAttempt.keys().next().value!)
  pending.add(connectionId)
  try {
    const snapshots = getChatRunServer()?.getLiveActivityPlans?.() || []
    for (const entry of snapshots) {
      const plan = taskPlanWebhookSnapshot(entry.snapshot)
      if (!plan || plan.execution_state !== 'running') continue
      const event: BusinessEvent = {
        schema_version: 1, id: randomUUID(), type: 'chat.plan.updated', source: 'chat',
        profile: entry.profile, occurred_at: new Date().toISOString(),
        subject: { session_id: plan.session_id, run_id: plan.run_id, plan_id: plan.plan_id }, payload: {},
        chat: { id: randomUUID(), type: 'chat.plan.updated', profile: entry.profile, source: 'chat',
          occurred_at: new Date().toISOString(), subject: { session_id: plan.session_id, run_id: plan.run_id },
          summary: { status: 'updated' }, task_plan: plan },
      }
      if (!canReceiveAppEvent(user, event)) continue
      await deliver(event, connectionId)
      break // At most one latest authorized task; do not burst push-to-start on reconnect.
    }
  } finally { pending.delete(connectionId) }
}

export async function endDeviceLiveActivities(connectionId: number): Promise<void> {
  if (!deliver) return
  await deliver({schema_version:1,id:randomUUID(),type:'device.push.disabled',source:'chat',profile:'default',
    occurred_at:new Date().toISOString(),subject:{},payload:{}},connectionId)
}
