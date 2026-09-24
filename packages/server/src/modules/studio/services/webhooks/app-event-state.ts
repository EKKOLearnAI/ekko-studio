import { taskPlanWebhookSnapshot } from './task-plan'
import { randomUUID } from 'node:crypto'
import type { AuthenticatedUser } from '../../public/auth'
import { businessEvents, type BusinessEvent } from './business-events'
import { ensureBusinessConsumers } from './business-consumers'

export type AppStateProvider = (user: AuthenticatedUser, profile: string) => BusinessEvent[]
const providers = new Map<string, AppStateProvider>()
export function registerAppEventState(name: string, provider: AppStateProvider): () => void {
  providers.set(name, provider)
  return () => { if (providers.get(name) === provider) providers.delete(name) }
}
export function appEventState(user: AuthenticatedUser, profile: string): BusinessEvent[] {
  return [...providers.values()].flatMap(provider => provider(user, profile))
}
export function stateEvent(type: string, profile: string, subject: BusinessEvent['subject'], payload: BusinessEvent['payload']): BusinessEvent {
  return { schema_version: 1, id: randomUUID(), type, profile, subject, payload,
    source: subject.room_id ? 'group_chat' : subject.workflow_id ? 'workflow' : 'chat', occurred_at: new Date().toISOString() }
}
/** State updates share the notification event stream, without completion alerts. */
export function publishAppState(event: BusinessEvent): void {
  ensureBusinessConsumers()
  businessEvents.publish({ ...event, chat: {
    id: event.id, type: event.type as 'chat.run.updated' | 'group.run.updated' | 'workflow.run.updated',
    occurred_at: event.occurred_at, profile: event.profile, source: event.source as 'chat' | 'group_chat' | 'workflow',
    subject: event.subject, summary: { status: 'updated' }, state: event.payload.state as Record<string, unknown>,
  } })
}

/** Snapshot cards use the same allowlisted shape as live webhook cards. */
export function planStateEvent(profile: string, subject: BusinessEvent['subject'], value: unknown): BusinessEvent | null {
  const plan = taskPlanWebhookSnapshot(value)
  if (!plan) return null
  const event = stateEvent(subject.room_id ? 'group.plan.updated' : subject.workflow_id ? 'workflow.plan.updated' : 'chat.plan.updated',
    profile, { ...subject, session_id: plan.session_id, plan_id: plan.plan_id }, {})
  return { ...event, chat: { id: event.id, type: event.type as 'chat.plan.updated', profile, source: event.source as 'chat',
    occurred_at: event.occurred_at, subject: event.subject, summary: { status: 'updated' }, task_plan: plan } }
}
