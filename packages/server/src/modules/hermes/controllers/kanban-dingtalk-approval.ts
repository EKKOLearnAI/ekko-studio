import type { Context } from 'koa'
import * as kanban from '../services/kanban/kanban-service'
import {
  isDingTalkApprover,
  parseDingTalkApprovalReply,
  verifyDingTalkApprovalSignature,
} from '../services/kanban/dingtalk-approval'

const CALLBACK_ACTIONS = new Set(['approve', 'request_changes'])

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`)
  return value.trim()
}

export async function receiveDingTalkKanbanApproval(ctx: Context) {
  const payload = (ctx.request.body || {}) as Record<string, unknown>
  const serialized = JSON.stringify(payload)
  const timestamp = ctx.get('x-hermes-dingtalk-timestamp')
  const signature = ctx.get('x-hermes-dingtalk-signature')
  const callbackSecret = process.env.DINGTALK_APPROVAL_CALLBACK_SECRET || ''
  if (!verifyDingTalkApprovalSignature(serialized, timestamp, signature, callbackSecret)) {
    ctx.status = 401
    ctx.body = { error: 'Invalid or expired DingTalk approval signature' }
    return
  }

  try {
    const eventId = requiredString(payload.event_id, 'event_id')
    const senderId = requiredString(payload.sender_id, 'sender_id')
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(eventId)) throw new Error('event_id has an invalid format')
    const parsedReply = typeof payload.text === 'string' ? parseDingTalkApprovalReply(payload.text) : null
    if (typeof payload.text === 'string' && !parsedReply) throw new Error('text must be 批准 <task-id> <原因> or 退回 <task-id> <原因>')
    const taskId = parsedReply?.taskId || requiredString(payload.task_id, 'task_id')
    const action = parsedReply?.action || requiredString(payload.action, 'action')
    const reason = parsedReply?.reason || requiredString(payload.reason, 'reason')
    const board = typeof payload.board === 'string' && payload.board.trim() ? payload.board.trim() : 'codex-tech'
    if (!CALLBACK_ACTIONS.has(action)) throw new Error('action must be approve or request_changes')
    if (board !== 'codex-tech') throw new Error('DingTalk approvals are only enabled for codex-tech')
    if (!isDingTalkApprover(senderId, process.env.DINGTALK_ALLOWED_USERS || '')) {
      ctx.status = 403
      ctx.body = { error: 'DingTalk user is not authorized for kanban approvals' }
      return
    }

    const receipt = await kanban.performApprovalAction(taskId, action as 'approve' | 'request_changes', {
      actor: senderId,
      board,
      channel: 'dingtalk',
      eventId,
      reason,
    })
    ctx.body = { receipt }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.status = message.includes('required') || message.startsWith('action ') || message.startsWith('text ') || message.includes('invalid format') || message.includes('only enabled')
      ? 400
      : message.startsWith('Cannot ') ? 409 : 500
    ctx.body = { error: message }
  }
}
