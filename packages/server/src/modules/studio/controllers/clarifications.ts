import type { Context } from 'koa'
import { getChatRunServer } from '../public/chat-run'
import { ClarificationError } from '../services/clarification-runs'

export async function requestClarification(ctx: Context) {
  const body = (ctx.request.body || {}) as Record<string, unknown>
  const server = getChatRunServer()
  if (!server?.requestClarification) {
    ctx.status = 503
    ctx.body = { ok: false, error: 'Chat run service is unavailable' }
    return
  }
  const abort = new AbortController()
  const onClose = () => abort.abort()
  ctx.res.once('close', onClose)
  try {
    if (typeof body.context_id !== 'string' || !body.context_id.trim()) throw new ClarificationError('context_id is required')
    const profile = String(ctx.state.profile?.name || 'default').trim() || 'default'
    const result = await server.requestClarification(body.context_id, profile, body, abort.signal)
    ctx.body = { ok: true, ...result }
  } catch (err) {
    if (!(err instanceof ClarificationError)) throw err
    ctx.status = err.status
    ctx.body = { ok: false, error: err.message }
  } finally {
    ctx.res.removeListener('close', onClose)
  }
}
