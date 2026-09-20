import { readAppConfig } from '../config/app-config'
import { getLiveActivityUsage } from '../../repositories/live-activity-usage'
import { notificationPreview } from './notification-preview'
import { getChatRunServer } from '../chat-run/server-registry'
import { createHash, randomUUID } from 'node:crypto'
import { listAppConnections } from '../../repositories/app-connections-store'
import { listLiveActivityDestinations } from '../../repositories/live-activity-store'
import { getLiveActivityRun, listActiveLiveActivityRuns, saveLiveActivityRun, getLiveActivityLastStart, recordLiveActivityStart, type LiveActivityRunRecord } from '../../repositories/live-activity-runtime-store'
import { findUserById } from '../../repositories/users-store'
import { getSession, getSessionNotificationPreview } from '../../repositories/session-store'
import type { BusinessEvent } from '../webhooks/business-events'
import { canReceiveAppEvent } from '../webhooks/app-events'
import { appRelayUrlForRoute, getAppRelayRoute } from '../app-relay/route'
import { decryptPushSecret } from './push-secrets'

const cancelled = (event: BusinessEvent) => event.chat?.task_plan?.execution_state === 'interrupted'
  || event.payload.interrupted === true || event.type.endsWith('.abort.completed')
const terminal = (event: BusinessEvent) => event.type.endsWith('.run.completed') || event.type.endsWith('.run.failed')
  || cancelled(event) || ['ended', 'failed'].includes(String(event.chat?.task_plan?.execution_state))
const runKind = (event: BusinessEvent) => event.source === 'group_chat' ? 'group' : event.source === 'workflow' ? 'workflow' : 'chat'
const subjectId = (event: BusinessEvent) => event.subject.room_id || event.subject.workflow_id || event.subject.session_id || ''
const bounded = (value: unknown, max: number) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : ''
function displayFields(event: BusinessEvent, registration: Record<string, any>, state: LiveActivityRunRecord) {
  let result: Record<string, string | number> = {}
  try { result = JSON.parse(state.display_json || '{}') } catch { /* old row */ }
  if (['light', 'dark'].includes(registration.appearance)) result.appearance = registration.appearance
  const started = getChatRunServer()?.getLiveActivityStartedAt?.(event.subject.session_id, event.profile, event.subject.run_id)
  if (result.startedAtEpoch === undefined && typeof started === 'number' && Number.isFinite(started) && started >= 0) result.startedAtEpoch = started
  const through = terminal(event) ? Date.parse(event.occurred_at) : Date.now()
  const recorded = typeof result.startedAtEpoch === 'number' && runKind(event) === 'chat'
    ? getLiveActivityUsage(event.subject.session_id || '', event.profile, result.startedAtEpoch, through) : undefined
  if (recorded) Object.assign(result, recorded)
  // If no model-call ledger exists, use only explicitly reported event usage.
  const summary = event.chat?.summary
  for (const [key, value] of [['inputTokens', summary?.input_tokens], ['outputTokens', summary?.output_tokens]] as const) {
    if (!recorded && typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) result[key] = value
  }
  state.display_json = JSON.stringify(result)
  return result
}
function content(event: BusinessEvent, state: LiveActivityRunRecord, ending = false) {
  const plan = event.chat?.task_plan, steps = Array.isArray(plan?.plan) ? plan!.plan : []
  const inProgress = steps.find(step => step.status === 'in_progress') as { step?: unknown } | undefined
  const waiting = event.type.includes('approval.requested') || event.type.includes('clarification.requested'), failed = event.type.endsWith('.failed') || event.chat?.task_plan?.execution_state === 'failed'
  return { title: state.title, status: ending ? cancelled(event) ? 'cancelled' : failed ? 'failed' : 'completed' : waiting ? 'waiting_confirmation' : 'running',
    currentStep: bounded(ending ? cancelled(event) ? '任务已取消' : failed ? '任务失败' : '任务完成' : waiting ? '等待确认' : inProgress?.step || '任务正在运行', 80),
    completedSteps: state.completed, totalSteps: state.total, agent: agent(event) }
}
function agent(event: BusinessEvent): string {
  const raw = bounded(event.chat?.agent || (runKind(event) === 'chat' ? getSession(event.subject.session_id || '')?.agent : ''), 32).toLowerCase()
  const aliases: Record<string, string> = { 'claude-code': 'claude', 'ekko-agent': 'ekko', bridge: 'hermes', dsh: 'deepseek' }
  const normalized = aliases[raw] || raw
  return ['claude', 'codex', 'hermes', 'ekko', 'pi', 'grok', 'opencode', 'deepseek'].includes(normalized) ? normalized : 'ekko'
}
function title(event: BusinessEvent): string {
  if (runKind(event) === 'chat') {
    const id = event.subject.session_id || ''
    const saved = getSession(id)
    const preview = getSessionNotificationPreview(id)
    return notificationPreview({ title: saved?.title || preview?.title }, false).title
      || bounded(event.chat?.task_plan?.explanation, 40) || 'Ekko Studio 任务' 
  }
  return bounded((event.payload.display as Record<string, unknown> | undefined)?.title, 40) || 'Ekko Studio 任务'
}
function ref(event: BusinessEvent, destination: string): string {
  return createHash('sha256').update(`${destination}\0${runKind(event)}\0${subjectId(event)}\0${event.subject.run_id || event.chat?.task_plan?.run_id || event.chat?.task_plan?.plan_id || event.subject.plan_id || event.id}`).digest('hex').slice(0, 32)
}
const stableKey = (event: BusinessEvent, destination: string) => `${destination}:${runKind(event)}:${subjectId(event)}`
const legacyKeyPrefix = (event: BusinessEvent, destination: string) => `${stableKey(event, destination)}:`
function validConnection(device: ReturnType<typeof listLiveActivityDestinations>[number], connections: ReturnType<typeof listAppConnections>) {
  return connections.find(row => row.id === device.connection_id && row.user_id === device.user_id && row.device_code === device.device_id
    && row.token_hash === device.connection_token_hash && row.revoked_at == null && row.token_expires_at > Date.now() / 1000)
}

async function liveActivityResult(response: Response): Promise<{ status: string; error: string }> {
  let result: { status?: unknown; error?: unknown } = {}
  try { result = await response.json() as { status?: unknown; error?: unknown } } catch { /* non-JSON failures are not delivery receipts */ }
  try { await response.body?.cancel() } catch { /* already consumed */ }
  return { status: typeof result.status === 'string' && /^[a-z_]{1,48}$/.test(result.status) ? result.status : '',
    error: typeof result.error === 'string' && /^[a-z_]{1,64}$/.test(result.error) && !result.error.startsWith('push_') ? result.error : '' }
}

/** Starts a Live Activity as soon as a verified task plan exists, then updates that activity through the run lifecycle. */
export function createLiveActivityConsumer(send: typeof fetch = (...args) => fetch(...args)) {
  const refreshes = new Map<string, ReturnType<typeof setTimeout>>()
  const latest = new Map<string, BusinessEvent>()
  const active = (event: BusinessEvent) => runKind(event) === 'chat' && !!event.subject.run_id
    && getChatRunServer()?.isLiveActivityRunActive(event.subject.session_id, event.profile, event.subject.run_id) === true
  function cancelRefresh(key: string) {
    const timer = refreshes.get(key)
    if (timer) clearTimeout(timer)
    refreshes.delete(key)
  }
  function scheduleRefresh(key: string, event: BusinessEvent) {
    cancelRefresh(key)
    if (!active(event) || latest.get(key) !== event) return
    const timer = setTimeout(() => {
      refreshes.delete(key)
      const state = getLiveActivityRun(key)
      if (!state?.started || state.terminal || latest.get(key) !== event || !active(event)) { latest.delete(key); return }
      // Re-enter the normal consumer: revalidate ownership/connection and serialize updates.
      void consume(event, true)
    }, 120_000)
    timer.unref?.()
    refreshes.set(key, timer)
  }
  const pending = new Map<string, Promise<void>>()
  const polling = new Map<string, { controller: AbortController; runId: string }>()
  async function serialized(key: string, operation: () => Promise<void>): Promise<void> {
    const previous = pending.get(key) || Promise.resolve()
    const current = previous.catch(() => {}).then(operation)
    pending.set(key, current)
    try { await current } finally { if (pending.get(key) === current) pending.delete(key) }
  }
  async function dispatch(event: BusinessEvent, device: ReturnType<typeof listLiveActivityDestinations>[number], registration: Record<string, any>, key: string, requested?: 'start'|'update'|'end') {
    let state = getLiveActivityRun(key)
    if (!state || state.terminal) return
    const ending = requested === 'end' || terminal(event)
    const action = requested || (!state.started ? 'start' : ending ? 'end' : 'update')
    if (!state.started && action !== 'start') return
    state = { ...state, revision: state.revision + 1, updated_at: Date.now() }
    const now = Math.floor(Date.now() / 1000)
    const body: Record<string, unknown> = { schema_version: 1, event_id: randomUUID(), event: action,
      destination_id: device.destination_id, activity_ref: state.activity_ref, revision: state.revision,
      occurred_at: now, expires_at: now + (action === 'end' ? 600 : 120), content_state: { ...content(event, state, action === 'end'), ...displayFields(event, registration, state) } }
    // Opt-in only after gateway supports top-level relevance_score -> aps.relevance-score.
    // Business event time, not dispatch/heartbeat time: heartbeats cannot steal priority.
    if ((await readAppConfig()).liveActivityRelevanceEnabled === true) {
      const businessAt = event.chat?.task_plan?.updated_at ?? Date.parse(event.occurred_at)
      if (Number.isFinite(businessAt) && businessAt > 0) body.relevance_score = action === 'end' ? 0 : businessAt / 1000
    }
    if (action === 'start') body.ekko_run = { schema_version: 1, studio_device_id: registration.studio_device_id,
      cloud_user_id: registration.cloud_user_id, profile: event.profile, run_kind: runKind(event), run_id: event.subject.run_id || event.id,
      [runKind(event) === 'chat' ? 'session_id' : runKind(event) === 'group' ? 'room_id' : 'workflow_id']: subjectId(event) }
    if (action === 'end') body.dismissal_at = now + (terminal(event) && !cancelled(event) ? 60 : 0); else body.stale_at = now + 300
    const url = new URL('/push/v1/live-activities/send', appRelayUrlForRoute(await getAppRelayRoute()))
    const request = { method: 'POST', redirect: 'error' as const,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${registration.push_token}` }, body: JSON.stringify(body) }
    let response = await send(url, { ...request, signal: AbortSignal.timeout(10_000) })
    let result = await liveActivityResult(response)
    // Never log request bodies, destination IDs, task text, or credentials.
    console.info('[live-activity] delivery', { connection: device.connection_id, action,
      agent: agent(event), revision: state.revision, http: response.status, status: result.status, error: result.error })
    if (response.status >= 200 && response.status < 300) {
      state.started = 1; state.terminal = action === 'end' ? 1 : 0; saveLiveActivityRun(state)
      if (action === 'start') recordLiveActivityStart(device.destination_id, Date.now())
    }
    const deadline = Date.now() + (action === 'end' ? 580_000 : 110_000)
    const controller = new AbortController()
    polling.set(key, { controller, runId: event.subject.run_id || '' })
    try {
      while (response.status === 202 && ['queued', 'pending_token', 'dispatching'].includes(result.status) && Date.now() < deadline) {
        const continued = await new Promise<boolean>(resolve => {
          let timer: ReturnType<typeof setTimeout>
          const cancel = () => finish(false)
          const finish = (value: boolean) => {
            clearTimeout(timer)
            controller.signal.removeEventListener('abort', cancel)
            resolve(value)
          }
          timer = setTimeout(() => finish(true), 5_000)
          controller.signal.addEventListener('abort', cancel, { once: true })
        })
        if (!continued) break
        response = await send(url, { ...request, signal: AbortSignal.timeout(10_000) })
        result = await liveActivityResult(response)
        console.info('[live-activity] receipt', { connection: device.connection_id, action,
          revision: state.revision, http: response.status, status: result.status, error: result.error })
      }
    } finally {
      if (polling.get(key)?.controller === controller) polling.delete(key)
    }
  }
  const consume = async (event: BusinessEvent, heartbeat = false, targetConnectionId?: number): Promise<void> => {
    const plan = event.type.endsWith('.plan.updated') ? event.chat?.task_plan : null
    if (!plan && !terminal(event) && !event.type.includes('approval.requested') && !event.type.includes('clarification.requested')) return
    if (!subjectId(event) || event.payload.replayed === true || event.payload.restored === true) return
    try {
      const connections = listAppConnections()
      await Promise.allSettled(listLiveActivityDestinations().map(async device => {
        if (targetConnectionId !== undefined && device.connection_id !== targetConnectionId) return
        if (!device.enabled || !validConnection(device, connections)) return
        const user = findUserById(device.user_id); if (!user || user.status !== 'active' || !canReceiveAppEvent(user, event)) return
        let registration: Record<string, any>; try { registration = JSON.parse(decryptPushSecret(device.ciphertext)) } catch { console.warn('[live-activity] registration_unreadable', { connection: device.connection_id }); return }
        const key = stableKey(event, device.destination_id)
        if (heartbeat && (latest.get(key) !== event || !active(event))) return
        const previous = latest.get(key)
        if (!heartbeat && targetConnectionId === undefined && plan && previous?.chat?.task_plan && previous.subject.run_id === event.subject.run_id
          && previous.chat.task_plan.plan_id === plan.plan_id && previous.chat.task_plan.revision >= plan.revision) return
        if (targetConnectionId !== undefined) {
          if (!active(event)) return
          const stored = getLiveActivityRun(key)
          if (stored?.terminal) return // registration never revives a terminal activity
        }
        cancelRefresh(key)
        latest.set(key, event)
        // A terminal event must not wait behind an update receipt poll; new turns also supersede old polls.
        const activePoll = polling.get(key)
        if (activePoll && ((!heartbeat && !!plan) || terminal(event) || activePoll.runId !== (event.subject.run_id || ''))) activePoll.controller.abort()
        await serialized(key, async () => {
          const legacy = listActiveLiveActivityRuns(device.destination_id)
            .filter(row => row.run_key.startsWith(legacyKeyPrefix(event, device.destination_id)))
          for (const row of legacy) await dispatch(event, device, registration, row.run_key, 'end')
          if (targetConnectionId !== undefined && (!active(event) || getLiveActivityRun(key)?.terminal)) return
          if (plan && !terminal(event) && latest.get(key) !== event) return
          let state = getLiveActivityRun(key)
          if (heartbeat && (!state?.started || state.terminal || latest.get(key) !== event || !active(event))) return
          if (state?.terminal && (!plan || terminal(event))) return
          if (!state || state.terminal) state = { run_key:key,destination_id:device.destination_id,activity_ref:ref(event,device.destination_id),revision:0,started:0,terminal:0,title:title(event),completed:0,total:0,updated_at:Date.now() }
          if (plan) {
            state.completed = Number(plan.progress?.completed) || 0; state.total = Number(plan.progress?.total) || 0
            if (!state.total) return
          }
          state.title = title(event)
          state.updated_at = Date.now()
          saveLiveActivityRun(state)
          if (!state.started) {
            if (terminal(event)) {
              state.terminal = 1
              saveLiveActivityRun(state)
              return
            }
            if (!plan) return
            if (targetConnectionId !== undefined && Date.now() - getLiveActivityLastStart(device.destination_id) < 30 * 60_000) return
            await dispatch(event, device, registration, key, 'start')
            if (getLiveActivityRun(key)?.started && !terminal(event)) scheduleRefresh(key, event)
            return
          }
          await dispatch(event, device, registration, key, terminal(event) ? 'end' : 'update')
          if (plan && !terminal(event)) scheduleRefresh(key, event)
          else if (latest.get(key) === event) latest.delete(key)
        }).catch(() => { console.warn('[live-activity] delivery_exception', { connection: device.connection_id }) })
      }))
    } catch { /* Live Activity delivery never changes task outcomes. */ }
  }
  return consume
}
