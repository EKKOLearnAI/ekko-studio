import type { Context } from 'koa'
import { getChatRunServer } from '../public/chat-run'
import { TaskPlanError } from '../services/task-plan-runs'
import { SessionTasksError } from '../services/session-tasks'

function handleSessionTasks(ctx: Context, write: boolean) {
  const input = (ctx.request.body || {}) as Record<string, unknown>
  const server = getChatRunServer()
  if (!server) {
    ctx.status = 503
    ctx.body = { ok: false, error: 'Chat run service is unavailable' }
    return
  }
  try {
    if (typeof input.context_id !== 'string' || !input.context_id.trim()) throw new SessionTasksError('context_id is required')
    if (!write && Object.keys(input).some(key => key !== 'context_id')) throw new SessionTasksError('Session task queries accept only context_id')
    const profile = String(ctx.state.profile?.name || 'default').trim() || 'default'
    const snapshot = write ? server.updateSessionTasks(input.context_id, profile, input) : server.listSessionTasks(input.context_id, profile)
    ctx.body = { ok: true, ...snapshot }
  } catch (error) {
    if (!(error instanceof SessionTasksError) && !(error instanceof TaskPlanError)) throw error
    ctx.status = error.status
    ctx.body = { ok: false, error: error.message }
  }
}

export const listSessionTasks = (ctx: Context) => handleSessionTasks(ctx, false)
export const updateSessionTasks = (ctx: Context) => handleSessionTasks(ctx, true)
