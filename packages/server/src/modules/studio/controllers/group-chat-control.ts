import type { Context } from 'koa'
import { groupChatOperation, readableRoom, roomMessages } from '../services/group-chat/control'

async function respond(ctx: Context, work: () => unknown | Promise<unknown>) {
  try {
    if (ctx.state.sessionShare) ctx.throw(403, 'Studio login required')
    ctx.body = await work()
  } catch (error: any) { ctx.status = error.status || 400; ctx.body = { error: error.message } }
}
async function operation(ctx: Context, event: 'message' | 'interrupt_agent', input: Record<string, unknown>) {
  readableRoom(ctx.state.user, ctx.params.roomId)
  const controller = new AbortController()
  const close = () => { if (!ctx.res.writableEnded) controller.abort() }
  ctx.res.once('close', close)
  try { return await groupChatOperation(ctx.get('authorization').replace(/^Bearer\s+/i, ''), ctx.params.roomId, event, input, controller.signal) }
  finally { ctx.res.off('close', close) }
}
export const messages = (ctx: Context) => respond(ctx, () => roomMessages(ctx.state.user, ctx.params.roomId, ctx.query))
export const send = (ctx: Context) => respond(ctx, () => {
  const body = (ctx.request.body || {}) as Record<string, unknown>
  if (typeof body.content !== 'string' && !Array.isArray(body.content)) ctx.throw(400, 'content is required')
  return operation(ctx, 'message', { content: body.content, ...(body.mentions === undefined ? {} : { mentions: body.mentions }) })
})
export const stop = (ctx: Context) => respond(ctx, () => {
  const body = (ctx.request.body || {}) as Record<string, unknown>
  if (typeof body.agentName !== 'string' || !body.agentName.trim()) ctx.throw(400, 'agentName is required')
  return operation(ctx, 'interrupt_agent', { agentName: body.agentName })
})
