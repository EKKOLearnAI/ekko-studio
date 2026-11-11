import type { Context } from 'koa'
import { createEmptySession, stopSession } from '../services/sessions/control'

async function respond(ctx: Context, work: () => unknown | Promise<unknown>) {
  try {
    if (ctx.state.sessionShare) ctx.throw(403, 'Studio login required')
    ctx.body = await work()
  } catch (error: any) { ctx.status = error.status || 400; ctx.body = { error: error.message } }
}
export const create = (ctx: Context) => respond(ctx, () => {
  const body = (ctx.request.body || {}) as Record<string, unknown>
  const profile = ctx.state.profile?.name || 'default'
  const result = createEmptySession(ctx.state.user, profile, body)
  ctx.status = 201
  return result
})
export const stop = (ctx: Context) => respond(ctx, () => stopSession(ctx.state.user, ctx.state.profile?.name || 'default', ctx.params.id))
