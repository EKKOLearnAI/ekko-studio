import type { Socket } from 'socket.io'
import { randomUUID } from 'crypto'
import { businessEvents, APP_BUSINESS_TYPES, type BusinessEvent } from './business-events'
import { authenticateUserToken, type AuthenticatedUser } from '../../public/auth'
import { listUserProfiles } from '../../repositories/users-store'
import { getSession, getSessionNotificationPreview } from '../../repositories/session-store'
import { getWorkflowRun, getWorkflowRunForSession } from '../../repositories/workflow-run-store'
import { groupReplyNotification } from '../group-chat/foreground-notification'
import { foregroundNotification, foregroundNotificationAgent, foregroundNotificationPreview } from '../chat-run/foreground-notification'
import { appEventState, type AppStateProvider } from './app-event-state'
import { taskPlanWebhookContent } from './task-plan'

interface Subscription { profile: string; types: string[]; sessionIds: string[]; roomIds: string[]; workflowIds: string[]; snapshot: boolean }
interface GroupAccess { canReceive(user: AuthenticatedUser, roomId: string, event?: BusinessEvent): boolean }
let groupAccess: GroupAccess | null = null
export function registerGroupEventAccess(access: GroupAccess): () => void {
  groupAccess = access
  return () => { if (groupAccess === access) groupAccess = null }
}
function allowed(user: AuthenticatedUser, profile: string): boolean {
  return user.role === 'super_admin' || listUserProfiles(user.id).some(item => item.profile_name === profile)
}
function ids(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 100 || value.some(v => typeof v !== 'string' || !v || v.length > 512)) throw new Error('invalid subscription filter')
  return value
}
export function parseAppSubscription(value: unknown): Subscription {
  const p = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  if (p.schema_version !== 1) throw new Error('unsupported event schema')
  const profile = typeof p.profile === 'string' ? p.profile.trim() || 'default' : 'default'
  const types = p.types === undefined ? [...APP_BUSINESS_TYPES] : ids(p.types)
  if (types.some(t => !(APP_BUSINESS_TYPES as readonly string[]).includes(t))) throw new Error('unsupported event type')
  return { profile, types, sessionIds: ids(p.session_ids), roomIds: ids(p.room_ids), workflowIds: ids(p.workflow_ids), snapshot: p.include_snapshot === true }
}
export function appEventEnvelope(event: BusinessEvent) {
  const base = { timestamp: Date.parse(event.occurred_at), schema_version: 1, id: event.id, type: event.type, occurred_at: event.occurred_at,
    profile: event.profile, source: event.source, subject: event.subject }
  if (event.type.endsWith('.run.updated')) return { ...base, notify: false, state: event.payload.state }
  if (event.type.endsWith('.plan.updated')) {
    const plan = event.chat?.task_plan
    return plan ? { ...base, notify: false, task_plan: taskPlanWebhookContent(plan, true) } : null
  }
  const interaction = event.subject.approval_id || event.subject.clarification_id
  const interactionState = interaction ? { interaction: {
    ...(typeof event.payload.resolved === 'boolean' ? { resolved: event.payload.resolved } : {}),
    ...(event.payload.stale === true ? { stale: true } : {}),
    ...(typeof event.payload.reason === 'string' ? { reason: event.payload.reason.slice(0, 100) } : {}),
    ...Object.fromEntries(['timeout_ms', 'requested_at', 'remaining_timeout_ms'].flatMap(key =>
      typeof event.payload[key] === 'number' ? [[key, event.payload[key]]] : [])),
  } } : {}
  if (event.source === 'workflow' && event.type.startsWith('chat.') && interaction) {
    return { ...base, ...interactionState, notify: false, display: { title: '', preview: '' } }
  }
  if (event.type.startsWith('chat.')) {
    if (event.source === 'group_chat' || event.source === 'workflow') return null
    const name = event.type.replace('chat.clarification.', 'clarify.').replace(/^chat\./, '')
    const payload = { ...event.payload, session_id: event.subject.session_id }
    const notice = foregroundNotification(name, payload)
    if (!notice) return null
    const session = getSession(notice.sessionId)
    if (!session || (session.profile || 'default') !== event.profile || session.source === 'group_chat' || session.source === 'workflow') return null
    return { schema_version: 1, id: event.id, type: event.type, occurred_at: event.occurred_at,
      profile: event.profile, source: event.source, subject: event.subject,
      ...interactionState,
      display: { ...foregroundNotificationPreview(notice.kind, getSessionNotificationPreview(notice.sessionId) || session, payload), agent: foregroundNotificationAgent(session.agent) } }
  }
  if (event.type === 'group.message.created') {
    const room = event.payload.room as {id:string;name:string}
    const message = event.payload.message as Parameters<typeof groupReplyNotification>[1]
    if (!room || !message) return null
    const notice = groupReplyNotification(room, message, Date.parse(event.occurred_at))
    if (!notice) return null
    const agents = Array.isArray(event.payload.agents) ? event.payload.agents as Array<Record<string, unknown>> : []
    const visible = agents.length > 4 ? agents.slice(0,3) : agents.slice(0,4)
    return { schema_version: 1, id:event.id,type:event.type,occurred_at:event.occurred_at,profile:event.profile,source:event.source,subject:event.subject,
      display: { title:notice.title,preview:notice.content,agentCount:agents.length,
        agents:visible.map(agent=>({id:String(agent.id || ''),name:String(agent.name || '').slice(0,80),agent:String(agent.agent || ''),avatar:typeof agent.avatar === 'string' && agent.avatar.length <= 65536 ? agent.avatar : ''})) } }
  }
  if (!(APP_BUSINESS_TYPES as readonly string[]).includes(event.type)) return null
  return { schema_version: 1, id: event.id, type: event.type, occurred_at: event.occurred_at,
    profile: event.profile, source: event.source, subject: event.subject, ...interactionState, display: event.payload.display }
}
function matches(request: Subscription, event: BusinessEvent): boolean {
  if (!request.types.includes(event.type) || event.source !== 'group_chat' && request.profile !== event.profile) return false
  const selected = event.subject.room_id ? request.roomIds : event.subject.workflow_id ? request.workflowIds : request.sessionIds
  return !selected.length || selected.includes(event.subject.room_id || event.subject.workflow_id || event.subject.session_id || '')
}
/** Notification ownership is stricter than permission to view a shared Profile. */
export function canReceiveAppEvent(user: AuthenticatedUser | undefined, event: BusinessEvent): boolean {
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) return false
  if (event.source === 'group_chat') {
    return Boolean(event.subject.room_id && groupAccess?.canReceive(user, event.subject.room_id, event))
  }
  if (!allowed(user, event.profile)) return false
  if (event.source === 'workflow') {
    // Node events carry their own runtime ID; resolve the persisted root by session.
    const run = event.subject.session_id
      ? getWorkflowRunForSession(event.subject.session_id, event.profile)
      : event.subject.run_id ? getWorkflowRun(event.subject.run_id) : null
    return Boolean(run && run.workflow_id === event.subject.workflow_id && run.user_id === user.id
      && (event.subject.session_id || run.profile === event.profile))
  }
  const session = event.subject.session_id ? getSession(event.subject.session_id) : null
  return Boolean(session && (session.profile || 'default') === event.profile
    && session.user_id != null && String(session.user_id) === String(user.id))
}
/** One subscription per authenticated socket; local/manual/cloud use the same command. */
export function bindAppEventSubscription(socket: Socket, localState?: AppStateProvider): void {
  let subscription: Subscription | null = null
  let revision = 0
  let closed = false
  let pending = 0
  let chain = Promise.resolve()
  const seen = new Set<string>()
  const token = String(socket.handshake.auth?.token || '')
  socket.on('app.events.subscribe', async (input: unknown, ack?: (result: unknown) => void) => {
    const ticket = ++revision
    subscription = null
    try {
      const request = parseAppSubscription(input)
      const user = await authenticateUserToken(token)
      if (!user || !allowed(user, request.profile)) throw new Error('Profile access denied')
      if (closed || ticket !== revision) return
      subscription = request
      socket.data.appEventVersion = 1
      const snapshot = request.snapshot ? [...appEventState(user, request.profile), ...(localState?.(user, request.profile) || [])]
        .filter(event => matches(request, event) && canReceiveAppEvent(user, event)).map(appEventEnvelope).filter(Boolean) : undefined
      ack?.({ ok: true, schema_version: 1, ...(snapshot ? { snapshot, timestamp: Date.now() } : {}) })
    } catch { if (!closed && ticket === revision) { subscription = null; ack?.({ ok: false, error: 'event_subscription_denied' }) } }
  })
  socket.on('app.events.unsubscribe', (_input: unknown, ack?: (result: unknown) => void) => {
    revision++; subscription = null; ack?.({ ok: true })
  })
  const stop = businessEvents.subscribe(`app:${socket.id}:${randomUUID()}`, event => {
    const request = subscription, ticket = revision
    if (closed || !request || !matches(request, event) || pending >= 100) return
    pending++
    chain = chain.then(async () => {
      if (closed || revision !== ticket || subscription !== request || seen.has(event.id)) return
      // Revalidate JWT/account and current profile/membership on every delivery.
      const user = await authenticateUserToken(token)
      if (!user || !allowed(user, request.profile)) return
      if (!canReceiveAppEvent(user, event)) return
      const envelope = appEventEnvelope(event)
      if (!envelope || closed || revision !== ticket) return
      seen.add(event.id); if (seen.size > 2000) seen.delete(seen.values().next().value!)
      socket.emit('app.event', envelope)
    }).catch(() => {}).finally(() => { pending-- })
  })
  socket.on('disconnect', () => { closed = true; revision++; subscription = null; stop(); seen.clear() })
}
