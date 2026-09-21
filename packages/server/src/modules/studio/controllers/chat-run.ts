import { prepareSessionShareRun } from '../services/session-shares/access'
import type { Context } from 'koa'
import { randomUUID } from 'crypto'
import { io, type Socket } from 'socket.io-client'
import { config } from '../public/config'
import { getChatRunServer } from '../public/chat-run'
import { resolveModelExecutionIdentity } from '../contracts/runs/model-execution-identity'

type ChatRunPayload = Record<string, unknown> & {
  input?: unknown
  session_id?: unknown
  profile?: unknown
  timeout_ms?: unknown
  include_events?: unknown
}

type ChatRunEvent = Record<string, unknown> & {
  event?: string
  session_id?: string
  run_id?: string
  delta?: string
  text?: string
  output?: string | null
  reasoning?: string | null
  error?: unknown
}

const CHAT_RUN_EVENTS = [
  'run.started',
  'message.delta',
  'message.interim',
  'reasoning.delta',
  'thinking.delta',
  'reasoning.available',
  'tool.started',
  'tool.completed',
  'tool.failed',
  'workspace.diff.completed',
  'plan.updated',
  'run.completed',
  'run.failed',
  'compression.started',
  'compression.completed',
  'abort.started',
  'abort.timeout',
  'abort.completed',
  'usage.updated',
  'agent.event',
  'subagent.event',
  'session.command',
  'session.title.updated',
  'run.queued',
  'approval.requested',
  'approval.resolved',
  'clarify.requested',
  'clarify.resolved',
  'location.requested',
  'location.resolved',
  'calendar.requested',
  'calendar.resolved',
  'reminder.requested',
  'reminder.resolved',
  'health.requested',
  'health.resolved',
  'peer.user.message',
]

const DEFAULT_TIMEOUT_MS = 300_000
const MAX_TIMEOUT_MS = 1_800_000
const MAX_RECORDED_EVENTS = 1000

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
function bearerToken(ctx: Context): string {
  const match = ctx.get('authorization').match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || ''
}

function requestTimeoutMs(value: unknown): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_TIMEOUT_MS
  return Math.min(Math.floor(numeric), MAX_TIMEOUT_MS)
}

function chatRunBaseUrl(): string {
  return (process.env.HERMES_WEB_UI_URL || `http://127.0.0.1:${config.port}`).replace(/\/$/, '')
}

function profileFrom(ctx: Context, body: ChatRunPayload): string {
  return String(body.profile || ctx.state.profile?.name || 'default').trim() || 'default'
}

function userBody(body: ChatRunPayload): Record<string, unknown> {
  const { timeout_ms: _timeoutMs, include_events: _includeEvents, ...payload } = body
  return payload
}

function generatedSessionId(): string {
  return randomUUID()
}

function needsGeneratedSessionId(payload: Record<string, unknown>): boolean {
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id.trim() : ''
  return !sessionId
}

export async function runOnce(ctx: Context) {
  let body = (ctx.request.body || {}) as ChatRunPayload
  if (ctx.state.sessionShare) {
    const prepared = { ...body }
    prepareSessionShareRun(ctx.state.sessionShare, prepared)
    body = { ...prepared, timeout_ms: body.timeout_ms, include_events: body.include_events }
  }
  if (body.input == null) {
    ctx.status = 400
    ctx.body = { ok: false, error: 'input is required' }
    return
  }

  const timeoutMs = requestTimeoutMs(body.timeout_ms)
  const includeEvents = body.include_events === true
  const token = bearerToken(ctx)
  const profile = profileFrom(ctx, body)
  const payload: Record<string, unknown> = { ...userBody(body), profile }
  const isCodingAgentRun = body.source === 'coding_agent' || body.coding_agent_id != null || body.agent_id != null
  if (isCodingAgentRun) {
    try {
      const identity = await resolveModelExecutionIdentity({
        profile,
        provider: body.provider,
        model: body.model,
        apiMode: body.apiMode ?? body.api_mode,
      })
      payload.provider = identity.provider
      payload.model = identity.model
      payload.apiMode = identity.apiMode
      delete payload.api_mode
      delete payload.apiKey
      delete payload.api_key
      delete payload.baseUrl
      delete payload.base_url
    } catch (error: any) {
      ctx.status = Number(error?.status) || 400
      ctx.body = { ok: false, error: error?.message || 'Invalid execution identity' }
      return
    }
  }
  if (needsGeneratedSessionId(payload)) payload.session_id = generatedSessionId()

  ctx.body = await new Promise((resolve) => {
    const events: ChatRunEvent[] = []
    let output = ''
    let reasoning = ''
    let runId = ''
    let settled = false

    const socket: Socket = io(`${chatRunBaseUrl()}/chat-run`, {
      auth: ctx.state.sessionShare
        ? { token: ctx.state.sessionShare.token, appAccessToken: ctx.state.sessionShare.appAccessToken }
        : token ? { token } : {},
      query: { profile },
      transports: ['websocket', 'polling'],
      reconnection: false,
      timeout: 30_000,
    })

    const cleanup = () => {
      clearTimeout(timer)
      socket.removeAllListeners()
      socket.disconnect()
    }

    const finish = (status: number, response: Record<string, unknown>) => {
      if (settled) return
      settled = true
      cleanup()
      ctx.status = status
      resolve({
        ...response,
        session_id: typeof payload.session_id === 'string' ? payload.session_id : undefined,
        run_id: runId || undefined,
        output,
        ...(reasoning ? { reasoning } : {}),
        ...(includeEvents ? { events } : {}),
      })
    }

    const record = (event: ChatRunEvent) => {
      if (!includeEvents) return
      if (events.length >= MAX_RECORDED_EVENTS) events.shift()
      events.push(event)
    }

    const timer = setTimeout(() => {
      finish(504, {
        ok: false,
        status: 'timeout',
        error: `chat-run timed out after ${timeoutMs}ms`,
      })
    }, timeoutMs)

    socket.on('connect_error', (err: Error) => {
      finish(503, {
        ok: false,
        status: 'connect_error',
        error: err.message,
      })
    })

    socket.on('connect', () => {
      socket.emit('run', payload)
    })

    for (const eventName of CHAT_RUN_EVENTS) {
      socket.on(eventName, (event: ChatRunEvent = {}) => {
        const tagged = { ...event, event: event.event || eventName }
        record(tagged)
        if (typeof tagged.run_id === 'string' && tagged.run_id) runId = tagged.run_id
        if (eventName === 'message.delta' && typeof tagged.delta === 'string') output += tagged.delta
        if ((eventName === 'reasoning.delta' || eventName === 'thinking.delta') && typeof tagged.delta === 'string') reasoning += tagged.delta
        if (eventName === 'run.completed') {
          if (typeof tagged.output === 'string' && tagged.output) output = tagged.output
          if (typeof tagged.reasoning === 'string' && tagged.reasoning) reasoning = tagged.reasoning
          finish(200, { ok: true, status: 'completed', event: eventName })
          return
        }
        if (eventName === 'run.failed') {
          finish(500, {
            ok: false,
            status: 'failed',
            event: eventName,
            error: tagged.error || 'chat-run failed',
          })
          return
        }
        if (eventName === 'approval.requested' || eventName === 'clarify.requested') {
          finish(409, {
            ok: false,
            status: 'requires_action',
            event: eventName,
            action: tagged,
          })
        }
      })
    }
  })
}
