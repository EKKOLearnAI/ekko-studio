import { findPushRunLink, getRunPushTarget } from '../../repositories/run-push-store'
import { businessEvents, type BusinessEvent } from './business-events'
import { ensureBusinessConsumers } from './business-consumers'
import { stableChatWebhookEventId, truncateChatWebhookContent, type ChatRunWebhookEvent } from './envelope'
import { acceptTaskPlanRevision, taskPlanWebhookSnapshot, type WebhookTaskPlan } from './task-plan'

export type DomainEventType = 'group.message.created' | 'group.run.failed'
  | 'group.approval.requested' | 'group.approval.resolved'
  | 'group.clarification.requested' | 'group.clarification.resolved'
  | 'workflow.run.completed' | 'workflow.run.failed' | 'group.plan.updated'

function publish(event: BusinessEvent, content = '', role?: 'user' | 'assistant', plan?: WebhookTaskPlan): void {
  const text = truncateChatWebhookContent(content)
  const webhook: ChatRunWebhookEvent = {
    id: event.id, type: event.type as DomainEventType, occurred_at: event.occurred_at,
    profile: event.profile, source: event.source as 'group_chat' | 'workflow', subject: event.subject,
    summary: { status: plan ? 'updated' : event.type.endsWith('.failed') ? 'failed' : event.type.endsWith('.requested') ? 'requested'
      : event.type.endsWith('.resolved') ? 'resolved' : event.type.endsWith('.created') ? 'created' : 'completed',
      role, ...(typeof event.payload.resolved === 'boolean' ? { resolved: event.payload.resolved } : {}) },
    ...(content ? { content: text.text, content_truncated: text.truncated, content_role: role } : {}),
    ...(plan ? { task_plan: plan } : {}),
  }
  ensureBusinessConsumers()
  businessEvents.publish({ ...event, chat: webhook })
}

export function publishDomainEvent(type: 'workflow.run.completed' | 'workflow.run.failed', profile: string,
  subject: BusinessEvent['subject'], display: Record<string, unknown>): void {
  profile = profile?.trim() || 'default'
  const target = subject.run_id ? getRunPushTarget({ kind: 'workflow', profile, runId: subject.run_id }) : null
  publish({ schema_version: 1, id: stableChatWebhookEventId(`${type}:${profile}:${subject.workflow_id}:${subject.run_id}`), type,
    ...(target ? { push_target_id: target.id } : {}), occurred_at: new Date().toISOString(),
    profile, source: 'workflow', subject, payload: { display } })
}

export function publishGroupMessage(room: { id: string; name: string; summaryProfile: string }, message: Record<string, unknown>, agents: unknown[]): void {
  if (message.tool_name === 'task_plan') {
    if (message.senderType !== 'agent' || message.role !== 'tool') return
    let content: unknown
    try { content = JSON.parse(String(message.content || '')) } catch { return }
    const plan = taskPlanWebhookSnapshot(content)
    if (!plan || plan.run_id !== message.run_id) return
    if (!acceptTaskPlanRevision(`group.plan.updated:${room.id}`, plan)) return
    const target = findPushRunLink('group_runtime', room.id, plan.run_id)
    publish({ schema_version: 1, id: stableChatWebhookEventId(`group.plan.updated:${room.id}:${plan.session_id}:${plan.plan_id}:${plan.revision}`),
      type: 'group.plan.updated', occurred_at: new Date(plan.updated_at).toISOString(), profile: room.summaryProfile?.trim() || 'default', source: 'group_chat',
      subject: { room_id: room.id, session_id: plan.session_id, run_id: plan.run_id, message_id: String(message.id), plan_id: plan.plan_id },
      ...(target ? { push_target_id: target.id } : {}), payload: { task_plan: plan } }, '', undefined, plan)
    return
  }
  const target = findPushRunLink('group_message', room.id, String(message.id))
  const common = { schema_version: 1 as const, ...(target ? { push_target_id: target.id } : {}),
    occurred_at: new Date().toISOString(), profile: room.summaryProfile?.trim() || 'default', source: 'group_chat',
    subject: { room_id: room.id, message_id: String(message.id), run_id: typeof message.run_id === 'string' ? message.run_id : undefined },
    payload: { room: { id: room.id, name: room.name }, message, agents } }
  publish({ ...common, id: stableChatWebhookEventId(`group.message.created:${room.id}:${message.id}`), type: 'group.message.created' },
    message.role === 'assistant' || message.role === 'user' ? String(message.content || '') : '',
    message.role === 'assistant' ? 'assistant' : 'user')
  if (message.senderType === 'agent' && message.role === 'assistant' && message.finish_reason === 'error') {
    publish({ ...common, id: stableChatWebhookEventId(`group.run.failed:${room.id}:${message.run_id || message.id}`), type: 'group.run.failed' })
  }
}

export function publishGroupInteraction(room: { id: string; name: string; summaryProfile: string },
  type: 'group.approval.requested' | 'group.approval.resolved' | 'group.clarification.requested' | 'group.clarification.resolved',
  runId: string, interactionId: string, resolved?: boolean, metadata: Record<string, unknown> = {}): void {
  const target = findPushRunLink('group_runtime', room.id, runId)
  const subject = { room_id: room.id, run_id: runId || undefined,
    ...(type.startsWith('group.approval.') ? { approval_id: interactionId } : { clarification_id: interactionId }) }
  publish({ schema_version: 1, id: stableChatWebhookEventId(`${type}:${room.id}:${runId}:${interactionId}`), type,
    ...(target ? { push_target_id: target.id } : {}), occurred_at: new Date().toISOString(),
    profile: room.summaryProfile?.trim() || 'default', source: 'group_chat', subject,
    payload: { ...Object.fromEntries(['owner_member_id', 'reason', 'timeout_ms', 'requested_at', 'remaining_timeout_ms'].filter(key => ['string', 'number'].includes(typeof metadata[key])).map(key => [key, metadata[key]])), display: { title: room.name.slice(0, 120), preview: '' }, ...(resolved !== undefined ? { resolved } : {}) } })
}
