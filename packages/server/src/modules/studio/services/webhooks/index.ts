import { randomUUID } from 'crypto'
import { businessEvents } from './business-events'
import { ensureBusinessConsumers } from './business-consumers'
import { acceptTaskPlanRevision, taskPlanWebhookSnapshot } from './task-plan'
import {
  stableChatWebhookEventId,
  truncateChatWebhookContent,
  type ChatRunWebhookAgent,
  type ChatRunWebhookEvent,
  type ChatRunWebhookSource,
  type ChatWebhookLifecycleStatus,
  type ChatWebhookMessageRole,
} from './envelope'
import type { ChatWebhookEventType } from '../../public/chat-webhooks'

export interface ObserveChatRunWebhookEventInput {
  event: string
  sessionId: string
  profile: string
  source: string
  agent: ChatRunWebhookAgent
  payload?: Record<string, unknown>
  roomId?: string
  workflowId?: string
  workflowNodeId?: string
  pushTargetId?: string
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function identifierValue(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function positiveNumber(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : undefined
}

function normalizeSource(value: string): ChatRunWebhookSource {
  if (value === 'global_agent' || value === 'workflow' || value === 'group_chat' || value === 'coding_agent' || value === 'cli' || value === 'api_server') {
    return value
  }
  return 'chat'
}

function usageValue(payload: Record<string, unknown>, key: string): unknown {
  const usage = payload.usage
  return usage && typeof usage === 'object' ? (usage as Record<string, unknown>)[key] : undefined
}

const EVENT_MAPPING: Record<string, { type: ChatWebhookEventType; status: ChatWebhookLifecycleStatus }> = {
  'message.created': { type: 'chat.message.created', status: 'created' },
  'run.queued': { type: 'chat.run.queued', status: 'queued' },
  'run.started': { type: 'chat.run.started', status: 'started' },
  'tool.started': { type: 'chat.tool.started', status: 'started' },
  'tool.completed': { type: 'chat.tool.completed', status: 'completed' },
  'tool.failed': { type: 'chat.tool.failed', status: 'failed' },
  'approval.requested': { type: 'chat.approval.requested', status: 'requested' },
  'approval.resolved': { type: 'chat.approval.resolved', status: 'resolved' },
  'clarify.requested': { type: 'chat.clarification.requested', status: 'requested' },
  'clarify.resolved': { type: 'chat.clarification.resolved', status: 'resolved' },
  'run.completed': { type: 'chat.run.completed', status: 'completed' },
  'run.failed': { type: 'chat.run.failed', status: 'failed' },
}

function messageRole(value: unknown): ChatWebhookMessageRole {
  return value === 'command' ? 'command' : value === 'assistant' ? 'assistant' : 'user'
}

function stringChoices(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const choices = value
    .map(item => String(item).trim().slice(0, 200))
    .filter(Boolean)
    .slice(0, 20)
  return choices.length > 0 ? choices : undefined
}

function occurredAt(value: unknown): string {
  const timestamp = Number(value)
  if (!Number.isFinite(timestamp) || timestamp <= 0) return new Date().toISOString()
  const milliseconds = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp
  return new Date(milliseconds).toISOString()
}

export function observeChatRunWebhookEvent(input: ObserveChatRunWebhookEventInput): boolean {
  const payload = input.payload || {}
  const sessionId = stringValue(input.sessionId)
  const plan = input.event === 'plan.updated' ? taskPlanWebhookSnapshot(payload, sessionId) : null
  // Group cards publish only after their message snapshot has been persisted.
  if (input.event === 'plan.updated' && (!plan || input.source === 'group_chat')) return false
  const mapping: { type: ChatWebhookEventType; status: ChatWebhookLifecycleStatus } | undefined = plan
    ? { type: input.source === 'workflow' ? 'workflow.plan.updated' : 'chat.plan.updated', status: 'updated' }
    : input.event === 'tool.completed' && Boolean(payload.error)
    ? EVENT_MAPPING['tool.failed']
    : EVENT_MAPPING[input.event]
  if (!mapping) return false
  if (!sessionId) return false
  const runId = identifierValue(payload.run_id) || identifierValue(payload.response_id)
  const queueId = identifierValue(payload.queue_id)
  const messageId = identifierValue(payload.message_id)
  const toolCallId = identifierValue(payload.tool_call_id) || identifierValue(payload.call_id)
  const approvalId = identifierValue(payload.approval_id)
  const clarificationId = identifierValue(payload.clarify_id)
  const occurrenceKey = plan ? `${plan.plan_id}:${plan.revision}` : approvalId || clarificationId || (input.event.startsWith('run.') ? runId || queueId || messageId : messageId || toolCallId || runId || queueId) || randomUUID()
  // Coding-agent runtime IDs may persist across turns; mobile roots must not collapse.
  const dedupeKey = plan ? `${mapping.type}:${input.profile || 'default'}:${sessionId}:${occurrenceKey}`
    : `${mapping.type}:${sessionId}:${occurrenceKey}${input.pushTargetId ? `:${input.pushTargetId}` : ''}`
  const rawContent = input.event === 'run.completed'
    ? stringValue(payload.output)
    : input.event === 'message.created'
      ? stringValue(payload.content) || stringValue(payload.text)
      : ''
  const content = truncateChatWebhookContent(rawContent)
  const role = messageRole(payload.role)
  const toolName = stringValue(payload.tool) || stringValue(payload.name) || stringValue(payload.tool_name)
  const event: ChatRunWebhookEvent = {
    id: stableChatWebhookEventId(dedupeKey),
    type: mapping.type,
    occurred_at: plan ? new Date(plan.updated_at).toISOString() : occurredAt(payload.timestamp),
    profile: input.profile || 'default',
    source: normalizeSource(input.source),
    agent: input.agent,
    subject: {
      session_id: sessionId,
      run_id: runId || undefined,
      queue_id: queueId || undefined,
      message_id: messageId || undefined,
      tool_call_id: toolCallId || undefined,
      approval_id: approvalId || undefined,
      clarification_id: clarificationId || undefined,
      room_id: input.roomId || undefined,
      workflow_id: input.workflowId || undefined,
      workflow_node_id: input.workflowNodeId || undefined,
      ...(plan ? { plan_id: plan.plan_id } : {}),
    },
    summary: {
      status: mapping.status,
      role: input.event === 'message.created' ? role : undefined,
      tool_name: toolName || undefined,
      queue_length: positiveNumber(payload.queue_length),
      choice: input.event === 'approval.resolved' ? stringValue(payload.choice) || undefined : undefined,
      choices: input.event === 'approval.requested' || input.event === 'clarify.requested'
        ? stringChoices(payload.choices)
        : undefined,
      resolved: typeof payload.resolved === 'boolean' ? payload.resolved : undefined,
      allow_permanent: typeof payload.allow_permanent === 'boolean' ? payload.allow_permanent : undefined,
      input_tokens: positiveNumber(payload.inputTokens ?? usageValue(payload, 'input_tokens')),
      output_tokens: positiveNumber(payload.outputTokens ?? usageValue(payload, 'output_tokens')),
      error_kind: input.event === 'run.failed'
        ? 'run_error'
        : input.event === 'tool.failed'
          ? 'tool_error'
          : undefined,
    },
    content: content.text,
    content_truncated: content.truncated,
    content_role: input.event === 'message.created' ? role : input.event === 'run.completed' ? 'assistant' : undefined,
    ...(plan ? { task_plan: plan } : {}),
  }
  if (plan && !acceptTaskPlanRevision(`${mapping.type}:${event.profile}`, plan)) return false
  ensureBusinessConsumers()
  return businessEvents.publish({ schema_version: 1, id: event.id, type: event.type, occurred_at: event.occurred_at,
    profile: event.profile.trim() || 'default', source: event.source, subject: event.subject, payload, chat: event,
    ...(input.pushTargetId ? { push_target_id: input.pushTargetId } : {}) })
}

export * from './dispatcher'
export * from './envelope'
