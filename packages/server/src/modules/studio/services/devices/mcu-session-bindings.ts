import { randomUUID } from 'node:crypto'
import { inspectAppUserToken } from '../../public/auth'
import { findUserById, userCanAccessProfile } from '../../public/users'
import { getGlobalAgentServer } from '../../public/global-agent'
import { getChatRunServer } from '../../public/chat-run'
import { getSession, type HermesSessionRow } from '../../repositories/session-store'
import { compareAndSetMcuSessionBinding, getMcuSessionBinding } from '../../repositories/mcu-session-bindings'
import { isPersonSession, isPrivatePersonSession, ownsPersonSession } from '../../contracts/person-session'
import { isBuiltinEkkoAgent } from '../../contracts/history-source'
import { isAgentRuntime } from '../../contracts/agents/runtime'
import { McuBindingError, type McuBindingKind, type McuBindingOwner, type McuBindingSnapshot, type OwnedMcuDevice } from '../../contracts/mcu-session-bindings'
import type { McuAgentRuntime } from '../../public/mcu-voice'
import { MCU_VOICE_SYSTEM_INSTRUCTIONS } from '../global-agent/mcu-voice-instructions'

export interface McuVoiceRoute extends McuBindingOwner {
  leaseId: string
  clientId: string
  sessionId: string
  bindingRevision: number
  kind: McuBindingKind
  bound: boolean
  interactionId: string
  runFields: Record<string, unknown>
  signal: AbortSignal
  settlement: Promise<void>
}
const leases = new Map<string, McuVoiceRoute>()
const cancellations = new Map<string, AbortController>()
const foreground = new Set<string>()
const settlements = new Map<string, () => void>()
const mutations = new Set<string>()
const deviceKey = (owner: McuBindingOwner) => JSON.stringify([owner.userId, owner.profile, owner.deviceCode])
function error(message: string, status: number, code: string): never { throw new McuBindingError(message, status, code) }

function authorizeOwner(owner: McuBindingOwner) {
  const user = findUserById(owner.userId)
  if (!user || user.status !== 'active' || user.role !== 'super_admin' && !userCanAccessProfile(user.id, owner.profile)) {
    error('Device profile is unavailable', 403, 'mcu_owner_unavailable')
  }
  return user
}

function target(owner: McuBindingOwner, sessionId: string, kind: McuBindingKind): HermesSessionRow {
  const user = authorizeOwner(owner), session = getSession(sessionId)
  if (!session || isPrivatePersonSession(sessionId) && (!isPersonSession(sessionId) || !ownsPersonSession(user.id, session))) {
    error('Selected conversation is unavailable', 404, 'mcu_session_unavailable')
  }
  if ((kind === 'bot') !== isPersonSession(sessionId)) error('Conversation kind does not match its target', 400, 'mcu_session_kind_invalid')
  if (kind === 'chat' && (session.profile || 'default') !== owner.profile) error('Select a conversation in the current profile', 403, 'mcu_session_profile_mismatch')
  if (kind === 'bot' && user.role !== 'super_admin' && !userCanAccessProfile(user.id, session.profile || 'default')) {
    error('BOT model profile is unavailable', 403, 'mcu_session_profile_mismatch')
  }
  if (session.source === 'workflow' || session.source === 'group_chat') error('Select a direct conversation or BOT', 400, 'mcu_session_kind_invalid')
  return session
}

export function legacyMcuSessionId(clientId: string | undefined, profile: string, runtime: McuAgentRuntime): string {
  const clean = (input: string, fallback: string) => input.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || fallback
  return `mcu-${clean(clientId || 'device', 'device')}-${clean(profile || 'default', 'default')}-${runtime}`
}

function runFields(session: HermesSessionRow, kind: McuBindingKind): Record<string, unknown> {
  if (kind === 'bot') return {}
  const fields: Record<string, unknown> = { session_source: 'global_agent', instructions: MCU_VOICE_SYSTEM_INSTRUCTIONS }
  const agent = ['claude', 'claude_code'].includes(session.agent) ? 'claude-code' : session.agent
  if (isBuiltinEkkoAgent(agent)) Object.assign(fields, { source: 'builtin_agent', agent_id: 'ekko-agent' })
  else if (agent && agent !== 'hermes') {
    if (!isAgentRuntime(agent) || agent === 'ekko') error('Selected conversation runtime is unavailable', 409, 'mcu_session_runtime_unavailable')
    Object.assign(fields, { source: 'coding_agent', agent_id: agent, mode: session.agent_mode || 'global' })
  } else fields.source = 'global_agent'
  for (const [source, name] of [['model', 'model'], ['provider', 'provider'], ['api_mode', 'api_mode'], ['reasoning_effort', 'reasoning_effort'], ['workspace', 'workspace']] as const) {
    if (session[source]) fields[name] = session[source]
  }
  return fields
}

async function online(owner: McuBindingOwner, clientId?: string): Promise<OwnedMcuDevice | null> {
  authorizeOwner(owner)
  return await getGlobalAgentServer()?.getOwnedMcuDevice(owner, clientId) ?? null
}

export async function readMcuBinding(owner: McuBindingOwner): Promise<McuBindingSnapshot> {
  authorizeOwner(owner)
  const device = await online(owner), row = getMcuSessionBinding(owner)
  let binding: McuBindingSnapshot['binding'] = null
  if (row?.sessionId && row.kind) {
    try { target(owner, row.sessionId, row.kind); binding = { sessionId: row.sessionId, kind: row.kind, revision: row.revision } }
    catch (reason) { if (!(reason instanceof McuBindingError)) throw reason }
  }
  return { capabilities: { version: 1, manualApprovals: true, clarificationWait: true },
    device: device ?? { deviceCode: owner.deviceCode, profile: owner.profile, clientId: '', agentRuntime: '', online: false },
    binding, revision: row?.revision ?? 0 }
}

function idleLeases(owner: McuBindingOwner, sessionIds: Array<string | null | undefined>) {
  if ([...leases.values()].some(lease => deviceKey(lease) === deviceKey(owner))) error('Wait for the device turn to finish', 409, 'mcu_binding_busy')
  if ([...leases.values()].some(lease => sessionIds.includes(lease.sessionId))) error('Wait for the selected conversation to finish', 409, 'mcu_binding_busy')
}
async function idle(owner: McuBindingOwner, sessionIds: Array<string | null | undefined>) {
  idleLeases(owner, sessionIds)
  for (const id of new Set(sessionIds.filter((value): value is string => Boolean(value)))) {
    if ([...leases.values()].some(lease => lease.sessionId === id)) error('Wait for the selected conversation to finish', 409, 'mcu_binding_busy')
    try { await getChatRunServer()?.assertSessionMessagesEditable(id) }
    catch { error('Wait for the selected conversation and pending tasks to finish', 409, 'mcu_binding_busy') }
  }
}

export async function writeMcuBinding(owner: McuBindingOwner, expectedRevision: number,
  next: { sessionId: string; kind: McuBindingKind } | null): Promise<McuBindingSnapshot> {
  authorizeOwner(owner)
  const key = deviceKey(owner)
  if (mutations.has(key)) error('A binding change is already pending', 409, 'mcu_binding_busy')
  mutations.add(key)
  try {
    if (next) target(owner, next.sessionId, next.kind)
    const previous = getMcuSessionBinding(owner)
    await idle(owner, [previous?.sessionId, next?.sessionId])
    if (!await online(owner)) error('Device is offline or unavailable to this account', 409, 'mcu_device_offline')
    await idle(owner, [previous?.sessionId, next?.sessionId])
    if (next) target(owner, next.sessionId, next.kind)
    idleLeases(owner, [previous?.sessionId, next?.sessionId])
    compareAndSetMcuSessionBinding(owner, expectedRevision, next)
    return readMcuBinding(owner)
  } finally { mutations.delete(key) }
}

export async function reserveMcuVoiceRoute(input: {
  userId: number; profile: string; userToken: string; clientId?: string; interactionId: string; agentRuntime: McuAgentRuntime
}): Promise<McuVoiceRoute> {
  const app = await inspectAppUserToken(input.userToken)
  if (!app || app.status !== 'active' || app.user?.id !== input.userId) error('An active paired MCU authorization is required', 403, 'mcu_device_authorization_invalid')
  const owner: McuBindingOwner = { userId: input.userId, profile: input.profile, deviceCode: app.deviceCode }
  const device = input.clientId ? await online(owner, input.clientId) : null
  if (!device || device.clientId !== input.clientId) error('MCU upload does not match its authenticated online device', 403, 'mcu_device_owner_mismatch')
  if (mutations.has(deviceKey(owner))) error('A binding change is already pending', 409, 'mcu_binding_busy')
  if ([...leases.values()].some(lease => foreground.has(lease.leaseId) && deviceKey(lease) === deviceKey(owner))) error('A device voice turn is already pending', 409, 'mcu_device_busy')
  if ([...leases.values()].some(lease => lease.interactionId === input.interactionId)) error('Voice interaction is already pending', 409, 'mcu_device_busy')
  const row = getMcuSessionBinding(owner)
  const bound = Boolean(row?.sessionId), kind = row?.kind ?? 'chat'
  const sessionId = row?.sessionId ?? legacyMcuSessionId(device.clientId, input.profile, input.agentRuntime)
  const session = bound ? target(owner, sessionId, kind) : getSession(sessionId)
  const cancellation = new AbortController()
  let resolveSettlement!: () => void
  const settlement = new Promise<void>(resolve => { resolveSettlement = resolve })
  const route: McuVoiceRoute = { ...owner, leaseId: randomUUID(), clientId: device.clientId, sessionId, kind, bound, signal: cancellation.signal, settlement,
    interactionId: input.interactionId, bindingRevision: row?.revision ?? 0,
    runFields: session ? runFields(session, kind) : input.agentRuntime === 'hermes'
      ? { source: 'global_agent', session_source: 'global_agent', instructions: MCU_VOICE_SYSTEM_INSTRUCTIONS }
      : { source: 'coding_agent', coding_agent_id: 'ekko-agent', session_source: 'global_agent', instructions: MCU_VOICE_SYSTEM_INSTRUCTIONS } }
  leases.set(route.leaseId, route)
  cancellations.set(route.leaseId, cancellation)
  foreground.add(route.leaseId)
  settlements.set(route.leaseId, resolveSettlement)
  return route
}

export function getMcuVoiceRoute(leaseId: string): McuVoiceRoute {
  return leases.get(leaseId) ?? error('Device voice lease is no longer active', 409, 'mcu_voice_lease_expired')
}
export async function validateMcuVoiceRoute(leaseId: string, userToken: string): Promise<McuVoiceRoute> {
  const route = getMcuVoiceRoute(leaseId)
  await validateMcuVoiceDelivery(route, userToken)
  getMcuVoiceRoute(leaseId)
  return route
}
/** Recheck the output boundary even when a completed turn has released its lease. */
export async function validateMcuVoiceDelivery(route: McuVoiceRoute, userToken: string): Promise<void> {
  await validateMcuVoiceRecipient(route, userToken)
  const row = getMcuSessionBinding(route)
  if ((row?.revision ?? 0) !== route.bindingRevision) error('Device binding changed during this turn', 409, 'mcu_binding_conflict')
  if (route.bound) target(route, route.sessionId, route.kind)
}
/** Content-free cancellation can clear an owned fence after its target disappears. */
export async function validateMcuVoiceRecipient(route: McuBindingOwner & { clientId: string }, userToken: string): Promise<void> {
  const app = await inspectAppUserToken(userToken)
  if (!app || app.status !== 'active' || app.user?.id !== route.userId || app.deviceCode !== route.deviceCode) error('Device authorization was revoked', 403, 'mcu_device_authorization_invalid')
  const device = await online(route, route.clientId)
  if (!device || device.clientId !== route.clientId) error('Authenticated device connection changed', 403, 'mcu_device_owner_mismatch')
}
export function releaseMcuVoiceRoute(leaseId?: string): void {
  if (!leaseId) return
  leases.delete(leaseId)
  foreground.delete(leaseId)
  cancellations.get(leaseId)?.abort()
  cancellations.delete(leaseId)
  settlements.get(leaseId)?.()
  settlements.delete(leaseId)
}
/** Request cancellation without claiming that asynchronous work has ended. */
export function cancelMcuVoiceRoute(leaseId: string): void { cancellations.get(leaseId)?.abort() }
/** Keep the background recipient snapshot without blocking another spoken turn. */
export function releaseMcuVoiceForeground(leaseId?: string): void { if (leaseId) foreground.delete(leaseId) }
export function releaseMcuVoiceRoutesForClient(clientId: string): void {
  for (const route of leases.values()) if (route.clientId === clientId) cancelMcuVoiceRoute(route.leaseId)
}
export function activeMcuVoiceRoute(clientId: string, profile: string): McuVoiceRoute | undefined {
  const owned = [...leases.values()].filter(route => route.clientId === clientId && route.profile === profile)
  return owned.find(route => foreground.has(route.leaseId)) ?? owned.at(-1)
}
