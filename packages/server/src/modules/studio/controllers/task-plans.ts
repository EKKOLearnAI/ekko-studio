import type { Context } from 'koa'
import { getChatRunServer } from '../public/chat-run'
import { TaskPlanError } from '../services/task-plan-runs'

export function updateTaskPlan(ctx: Context) {
  const body = (ctx.request.body || {}) as Record<string, unknown>
  const server = getChatRunServer()
  if (!server) {
    ctx.status = 503
    ctx.body = { ok: false, error: 'Chat run service is unavailable' }
    return
  }
  try {
    if (typeof body.context_id !== 'string' || !body.context_id.trim()) throw new TaskPlanError('context_id is required')
    const profile = String(ctx.state.profile?.name || 'default').trim() || 'default'
    const plan = server.updateTaskPlan(body.context_id, profile, body)
    ctx.body = { ok: true, ...plan }
  } catch (err) {
    if (!(err instanceof TaskPlanError)) throw err
    ctx.status = err.status
    ctx.body = { ok: false, error: err.message }
  }
}
