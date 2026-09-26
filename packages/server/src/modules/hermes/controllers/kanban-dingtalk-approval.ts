import type { Context } from 'koa'
import * as kanban from '../services/kanban/kanban-service'
import {
  isDingTalkApprover,
  parseDingTalkCardCallback,
  verifyDingTalkCardCallbackSignature,
} from '../services/kanban/dingtalk-approval'

export async function receiveDingTalkKanbanApproval(ctx: Context) {
  const timestamp = ctx.get('x-ddpaas-signature-timestamp')
  const signature = ctx.get('x-ddpaas-signature')
  const callbackSecret = process.env.DINGTALK_APPROVAL_CALLBACK_SECRET || ''
  if (!verifyDingTalkCardCallbackSignature(timestamp, signature, callbackSecret)) {
    ctx.status = 401
    ctx.body = { error: 'Invalid or expired DingTalk approval signature' }
    return
  }

  let callback
  try {
    callback = parseDingTalkCardCallback(ctx.request.body)
  } catch (error) {
    ctx.status = 400
    ctx.body = { error: error instanceof Error ? error.message : String(error) }
    return
  }
  if (!isDingTalkApprover(callback.actor, process.env.DINGTALK_ALLOWED_USERS || '')) {
    ctx.status = 403
    ctx.body = { error: 'DingTalk user is not authorized for kanban approvals' }
    return
  }

  try {
    await kanban.performApprovalAction(callback.taskId, callback.action, {
      actor: callback.actor,
      board: callback.board,
      channel: 'dingtalk',
      eventId: callback.eventId,
      reason: callback.reason,
    })
    ctx.body = {}
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.status = message.includes('was not found') ? 404
      : message.startsWith('Cannot ') || message.includes('readback failed') ? 409 : 500
    ctx.body = { error: message }
  }
}
