import type { Context } from 'koa'
import { getChatRunServer } from '../public/chat-run'
import { runChatHttpRequest } from '../services/chat-run/http'

export async function requestMobileLocation(ctx: Context) {
  const body = (ctx.request.body || {}) as Record<string, unknown>
  const sessionId = String(body.session_id || '').trim()
  if (!sessionId) {
    ctx.status = 400
    ctx.body = { ok: false, error: 'session_id is required' }
    return
  }
  const server = getChatRunServer()
  if (!server?.requestMobileLocation) {
    ctx.status = 503
    ctx.body = { ok: false, error: 'Chat run service is unavailable' }
    return
  }
  const profile = String(ctx.state.profile?.name || 'default').trim() || 'default'
  try {
    const result = await server.requestMobileLocation({
      sessionId,
      profile,
      purpose: body.purpose,
      accuracy: body.accuracy,
      timeoutMs: body.timeout_ms,
    })
    ctx.body = { ok: true, session_id: sessionId, ...result }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    ctx.status = error === 'Session not found' ? 404 : 400
    ctx.body = { ok: false, error }
  }
}

export async function requestMobileCalendar(ctx: Context) {
  const body = (ctx.request.body || {}) as Record<string, unknown>
  const sessionId = String(body.session_id || '').trim()
  if (!sessionId) {
    ctx.status = 400
    ctx.body = { ok: false, error: 'session_id is required' }
    return
  }
  const server = getChatRunServer()
  if (!server?.requestMobileCalendar) {
    ctx.status = 503
    ctx.body = { ok: false, error: 'Chat run service is unavailable' }
    return
  }
  const profile = String(ctx.state.profile?.name || 'default').trim() || 'default'
  try {
    const result = await server.requestMobileCalendar({
      sessionId,
      profile,
      capability: body.capability === 'reminder' ? 'reminder' : 'calendar',
      action: body.action,
      purpose: body.purpose,
      startMs: body.start_ms,
      endMs: body.end_ms,
      includeCompleted: body.include_completed,
      limit: body.limit,
      item: body.item,
      timeoutMs: body.timeout_ms,
    })
    ctx.body = { ok: true, session_id: sessionId, ...result }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    ctx.status = error === 'Session not found' ? 404 : 400
    ctx.body = { ok: false, error }
  }
}

export async function requestMobileHealth(ctx: Context) {
  const body = (ctx.request.body || {}) as Record<string, unknown>
  const sessionId = String(body.session_id || '').trim()
  if (!sessionId) {
    ctx.status = 400
    ctx.body = { ok: false, error: 'session_id is required' }
    return
  }
  const server = getChatRunServer()
  if (!server?.requestMobileHealth) {
    ctx.status = 503
    ctx.body = { ok: false, error: 'Chat run service is unavailable' }
    return
  }
  const profile = String(ctx.state.profile?.name || 'default').trim() || 'default'
  try {
    const result = await server.requestMobileHealth({
      sessionId,
      profile,
      purpose: body.purpose,
      metrics: body.metrics,
      startMs: body.start_ms,
      endMs: body.end_ms,
      limit: body.limit,
      timeoutMs: body.timeout_ms,
    })
    ctx.body = { ok: true, session_id: sessionId, ...result }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    ctx.status = error === 'Session not found' ? 404 : 400
    ctx.body = { ok: false, error }
  }
}

export async function runOnce(ctx: Context) {
  const result = await runChatHttpRequest(ctx.request.body || {}, {
    token: ctx.get('authorization').match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || '',
    profile: ctx.state.profile?.name || 'default',
    share: ctx.state.sessionShare,
  }, getChatRunServer())
  ctx.status = result.status
  ctx.body = result.body
}
