import { createHash, randomUUID } from 'node:crypto'
import { listAppConnections } from '../../repositories/app-connections-store'
import { listLiveActivityDestinations } from '../../repositories/live-activity-store'
import { getLiveActivityRun, saveLiveActivityRun, type LiveActivityRunRecord } from '../../repositories/live-activity-runtime-store'
import { findUserById } from '../../repositories/users-store'
import { getSession } from '../../repositories/session-store'
import type { BusinessEvent } from '../webhooks/business-events'
import { canReceiveAppEvent } from '../webhooks/app-events'
import { appRelayUrlForRoute, getAppRelayRoute } from '../app-relay/route'
import { decryptPushSecret } from './push-secrets'

const terminal = (type: string) => type.endsWith('.run.completed') || type.endsWith('.run.failed')
const runKind = (event: BusinessEvent) => event.source === 'group_chat' ? 'group' : event.source === 'workflow' ? 'workflow' : 'chat'
const subjectId = (event: BusinessEvent) => event.subject.room_id || event.subject.workflow_id || event.subject.session_id || ''
const bounded = (value: unknown, max: number) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : ''
function content(event: BusinessEvent, state: LiveActivityRunRecord, ending = false) {
  const plan = event.chat?.task_plan, steps = Array.isArray(plan?.plan) ? plan!.plan : []
  const inProgress = steps.find(step => step.status === 'in_progress') as { step?: unknown } | undefined
  const waiting = event.type.includes('approval.requested') || event.type.includes('clarification.requested'), failed = event.type.endsWith('.failed')
  return { title: state.title, status: ending ? failed ? 'failed' : 'completed' : waiting ? 'waiting_confirmation' : 'running',
    currentStep: bounded(ending ? failed ? '任务失败' : '任务完成' : waiting ? '等待确认' : inProgress?.step || '任务正在运行', 80),
    completedSteps: state.completed, totalSteps: state.total }
}
function title(event: BusinessEvent): string {
  if (event.source === 'chat') return bounded(getSession(event.subject.session_id || '')?.title, 40) || 'Ekko Studio 任务'
  return bounded((event.payload.display as Record<string, unknown> | undefined)?.title, 40) || 'Ekko Studio 任务'
}
function ref(event: BusinessEvent, destination: string): string {
  return createHash('sha256').update(`${destination}\0${runKind(event)}\0${subjectId(event)}\0${event.subject.run_id || event.id}`).digest('hex').slice(0, 32)
}
function validConnection(device: ReturnType<typeof listLiveActivityDestinations>[number], connections: ReturnType<typeof listAppConnections>) {
  return connections.find(row => row.id === device.connection_id && row.user_id === device.user_id && row.device_code === device.device_id
    && row.token_hash === device.connection_token_hash && row.revoked_at == null && row.token_expires_at > Date.now() / 1000)
}

/** Starts a Live Activity as soon as a verified task plan exists, then updates that activity through the run lifecycle. */
export function createLiveActivityConsumer(send: typeof fetch = (...args) => fetch(...args)) {
  const pending = new Map<string, Promise<void>>()
  async function serialized(key: string, operation: () => Promise<void>): Promise<void> {
    const previous = pending.get(key) || Promise.resolve()
    const current = previous.catch(() => {}).then(operation)
    pending.set(key, current)
    try { await current } finally { if (pending.get(key) === current) pending.delete(key) }
  }
  async function dispatch(event: BusinessEvent, device: ReturnType<typeof listLiveActivityDestinations>[number], registration: Record<string, any>, key: string, requested?: 'start'|'update'|'end') {
    let state = getLiveActivityRun(key)
    if (!state || state.terminal) return
    const ending = requested === 'end' || terminal(event.type)
    const action = requested || (!state.started ? 'start' : ending ? 'end' : 'update')
    if (!state.started && action !== 'start') return
    state = { ...state, revision: state.revision + 1, updated_at: Date.now() }
    const now = Math.floor(Date.now() / 1000)
    const body: Record<string, unknown> = { schema_version: 1, event_id: randomUUID(), event: action,
      destination_id: device.destination_id, activity_ref: state.activity_ref, revision: state.revision,
      occurred_at: now, expires_at: now + (action === 'end' ? 600 : 120), content_state: content(event, state, action === 'end') }
    if (action === 'start') body.ekko_run = { schema_version: 1, studio_device_id: registration.studio_device_id,
      cloud_user_id: registration.cloud_user_id, profile: event.profile, run_kind: runKind(event), run_id: event.subject.run_id || event.id,
      [runKind(event) === 'chat' ? 'session_id' : runKind(event) === 'group' ? 'room_id' : 'workflow_id']: subjectId(event) }
    if (action === 'end') body.dismissal_at = now + 120; else body.stale_at = now + 300
    const url = new URL('/push/v1/live-activities/send', appRelayUrlForRoute(await getAppRelayRoute()))
    const response = await send(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${registration.push_token}` }, body: JSON.stringify(body) })
    if (response.status >= 200 && response.status < 300) {
      state.started = 1; state.terminal = action === 'end' ? 1 : 0; saveLiveActivityRun(state)
    }
    await response.body?.cancel()
  }
  return async (event: BusinessEvent): Promise<void> => {
    const plan = event.type.endsWith('.plan.updated') ? event.chat?.task_plan : null
    if (!plan && !terminal(event.type) && !event.type.includes('approval.requested') && !event.type.includes('clarification.requested')) return
    if (!subjectId(event) || event.payload.replayed === true || event.payload.restored === true) return
    try {
      const connections = listAppConnections()
      await Promise.allSettled(listLiveActivityDestinations().map(async device => {
        if (!device.enabled || !validConnection(device, connections)) return
        const user = findUserById(device.user_id); if (!user || user.status !== 'active' || !canReceiveAppEvent(user, event)) return
        let registration: Record<string, any>; try { registration = JSON.parse(decryptPushSecret(device.ciphertext)) } catch { return }
        const key = `${device.destination_id}:${runKind(event)}:${subjectId(event)}:${event.subject.run_id || ''}`
        await serialized(key, async () => {
          let state = getLiveActivityRun(key)
          if (!state) state = { run_key:key,destination_id:device.destination_id,activity_ref:ref(event,device.destination_id),revision:0,started:0,terminal:0,title:title(event),completed:0,total:0,updated_at:Date.now() }
          if (state.terminal) return
          if (plan) {
            state.completed = Number(plan.progress?.completed) || 0; state.total = Number(plan.progress?.total) || 0
            if (!state.total) return
          }
          state.updated_at = Date.now()
          saveLiveActivityRun(state)
          if (!state.started) {
            if (terminal(event.type)) {
              state.terminal = 1
              saveLiveActivityRun(state)
              return
            }
            if (!plan) return
            await dispatch(event, device, registration, key, 'start')
            return
          }
          await dispatch(event, device, registration, key, terminal(event.type) ? 'end' : 'update')
        })
      }))
    } catch { /* Live Activity delivery never changes task outcomes. */ }
  }
}
