import type { ChatRunWebhookEvent } from './envelope'

export const APP_BUSINESS_TYPES = [
  'chat.run.completed', 'chat.run.failed', 'chat.approval.requested', 'chat.approval.resolved',
  'chat.clarification.requested', 'chat.clarification.resolved', 'group.message.created',
  'workflow.run.completed', 'workflow.run.failed',
  'chat.run.updated', 'group.run.updated', 'workflow.run.updated',
  'chat.plan.updated', 'group.plan.updated', 'workflow.plan.updated',
  'group.run.failed', 'group.approval.requested', 'group.approval.resolved',
  'group.clarification.requested', 'group.clarification.resolved',
] as const
export type AppBusinessType = typeof APP_BUSINESS_TYPES[number]
export interface BusinessEvent {
  schema_version: 1
  id: string
  type: string
  occurred_at: string
  profile: string
  source: string
  subject: { session_id?: string; run_id?: string; room_id?: string; message_id?: string; workflow_id?: string; approval_id?: string; clarification_id?: string; plan_id?: string }
  /** Internal source data. Never sent directly to App or HTTP subscribers. */
  payload: Record<string, unknown>
  chat?: ChatRunWebhookEvent
  /** Internal immutable run target, never a bearer token or a client-selected recipient. */
  push_target_id?: string
}
type Consumer = (event: BusinessEvent) => unknown
export function createBusinessEventHub(onError: (name: string) => void = () => {}) {
  const consumers = new Map<string, Consumer>()
  return {
    subscribe(name: string, consumer: Consumer) {
      consumers.set(name, consumer)
      return () => { if (consumers.get(name) === consumer) consumers.delete(name) }
    },
    publish(event: BusinessEvent) {
      let accepted = false
      for (const [name, consume] of consumers) {
        try {
          const result = consume(event)
          if (result === true) accepted = true
          if (result && typeof (result as Promise<unknown>).then === 'function') {
            void Promise.resolve(result).catch(() => onError(name))
          }
        } catch { onError(name) }
      }
      return accepted
    },
  }
}
export const businessEvents = createBusinessEventHub(name => console.warn('[business-events] consumer failed:', name))
