import { authenticateSessionShare, socketShareToken, assertShareProfile, sessionShareExecutionUser, refreshSessionShare, type SessionShareAccess } from '../services/session-shares/access'
import { bindSessionShareSocket } from '../services/session-shares/socket-access'
import { codingAgentId } from '../services/chat-run/types'
import { studioMcpCapabilities } from '../public/runs/mcp-capabilities'
import { hermesStudioMcpCapabilities } from '../services/chat-run/studio-mcp'
import { publishAppState, stateEvent, planStateEvent } from '../services/webhooks/app-event-state'
import type { BusinessEvent } from '../services/webhooks/business-events'
import { authenticatedPushActor, prepareRunPushSnapshot } from '../services/notifications/push-registration'
import { bindRunPushTarget, type PushRunRef, getRunPushTarget } from '../repositories/run-push-store'
import { ClarificationRuns } from '../services/clarification-runs'
import { TaskPlanRuns, taskPlanRunInstruction } from '../services/task-plan-runs'
import { saveTaskPlan } from '../repositories/task-plan-store'
import { getSessionTaskPlans } from '../services/task-plans'
import { bindLegacyAppEvents } from '../services/webhooks/legacy-app-events'
import { bindAppEventSubscription } from '../services/webhooks/app-events'
import { mobileDeviceRoom, mobileDeviceId, sameMobileDevice, mobileEventAllowed, type MobileDeviceTarget } from '../services/chat-run/mobile-device-target'
/**
 * ChatRunSocket — Socket.IO namespace /chat-run.
 *
 * Thin orchestrator that delegates to specialized modules:
 * - handle-bridge-run.ts → CLI bridge runs
 * - abort.ts             → run cancellation
 * - compression.ts       → context window management
 */

import type { Server, Socket } from 'socket.io'
import { randomUUID } from 'crypto'
import { logger } from '../public/logging'
import { getSystemPrompt } from '../public/runs/prompt'
import { clearSessionMessages, deleteSession, getSession, getSessionMetadata, listSessions, updateMessageDisplayContent } from '../repositories/session-store'
import { listWorkspaceRunChangesForAssistantMessages } from '../repositories/workspace-run-changes-store'
import { getSessionCategory } from '../repositories/session-category-store'
import { getActiveProfileName, getProfileDir, listProfileNamesFromDisk } from '../public/profile-config'
import {
  getChatCodingAgentMcpServers,
  resolveChatEkkoMcpServers,
  chatCodingAgentRunManager as codingAgentRunManager,
  createPrimaryAgentBridge,
  getChatEkkoAgent as getGlobalEkkoAgent,
  getPrimaryAgentBridgeManager as getAgentBridgeManager,
  handleChatCodingAgentSessionCommand as handleCodingAgentSessionCommand,
  parseChatCodingAgentSessionCommand as parseCodingAgentSessionCommand,
  redactPrimaryAgentBridgeError as redactAgentBridgeError,
  respondToChatEkkoClarification as respondToEkkoClarification,
  respondToChatEkkoToolApproval as respondToEkkoToolApproval,
} from '../public/chat-agent-runtime'
import { handleBridgeRun, resumeBridgeRun } from '../services/chat-run/handle-bridge-run'
import { handleCodingAgentRun } from '../services/chat-run/handle-coding-agent-run'
import { handleEkkoAgentRun, type EkkoAgentRunSocketData } from '../services/chat-run/handle-ekko-agent-run'
import { handleAbort } from '../services/chat-run/abort'
import { getOrCreateSession } from '../services/chat-run/compression'
import { loadSessionStateFromDb, resolveRunSource } from '../services/chat-run/load-state'
import { handleSessionCommand, isSessionCommand, parseSessionCommand } from '../services/chat-run/session-command'
import { contentBlocksToString } from '../services/chat-run/content-blocks'
import {
  buildAppResumeMessagePage,
  buildOutboundRunEvent,
  buildResumeEvents,
  buildResumeMessagePage,
} from '../services/chat-run/resume-payload'
import type {
  BackgroundContinuationContext,
  ChatCodingAgentId,
  ContentBlock,
  QueueInsertionControl,
  QueueInsertionPhase,
  QueueInsertionRuntime,
  QueuedRun,
  SessionState,
} from '../services/chat-run/types'
import { authenticateUserToken, inspectAppUserToken, isAuthEnabled, type AuthenticatedUser } from '../public/auth'
import { userCanAccessProfile } from '../repositories/users-store'
import { observeRunChatPetEvent } from '../public/pet-events'
import { observeChatRunWebhookEvent, type ChatRunWebhookAgent } from '../services/webhooks'
import { getAgentStatusSnapshot } from '../public/agent-status-registry'
import {
  normalizeMobileCalendarRequest,
  normalizeMobileCalendarResponse,
  type MobileCalendarCapability,
  type MobileCalendarResponse,
  type MobileCalendarRequest,
} from '../services/chat-run/mobile-calendar'
import {
  mobileHealthResponseSourceMatches,
  normalizeMobileHealthRequest,
  normalizeMobileHealthResponse,
  type MobileHealthResponse,
  type MobileHealthRequest,
} from '../services/chat-run/mobile-health'

type AgentBridgeBackgroundNotification = any
type AgentBridgeBackgroundSession = any

export type { ContentBlock } from '../services/chat-run/types'

function currentProfileFromSocket(socket: Socket): string {
  const socketProfile = typeof socket.handshake.query?.profile === 'string'
    ? socket.handshake.query.profile.trim()
    : ''
  return socketProfile || getActiveProfileName() || 'default'
}

function persistHermesBackgroundResult(
  sessionId: string,
  state: SessionState,
  delegationId: string,
  event: Record<string, unknown>,
) {
  const delegation = state.backgroundDelegations?.[delegationId]
  if (!delegation?.messageId) return
  const dispatch = delegation.dispatchPayload || {}
  const eventResults = Array.isArray(event.results)
    ? event.results.filter(result => result && typeof result === 'object') as Array<Record<string, unknown>>
    : [event]
  const stateTasks = Object.values(state.backgroundTasks || {})
    .filter(task => task.runtime !== 'ekko')
  const dispatchGoals = Array.isArray(dispatch.goals)
    ? dispatch.goals.map(value => String(value || '').trim())
    : []
  const tasks = eventResults.map((result, taskIndex) => {
    const index = Number.isFinite(Number(result.task_index)) ? Number(result.task_index) : taskIndex
    const goal = String(result.goal || dispatchGoals[index] || event.goal || dispatch.goal || '').trim()
    const snapshot = stateTasks.find(task =>
      Number(task.task_index ?? 0) === index
      && (!goal || !String(task.goal || '').trim() || String(task.goal || '').trim() === goal),
    ) || (eventResults.length === 1
      ? stateTasks.find(task => !goal || String(task.goal || '').trim() === goal)
      : undefined)
    const summary = String(result.summary || snapshot?.summary || snapshot?.preview || '').trim()
    return {
      runtime: 'hermes',
      mode: 'background',
      delegation_id: delegationId,
      subagent_id: String(snapshot?.subagent_id || result.subagent_id || `${delegationId}:${index}`),
      task_index: index,
      task_count: eventResults.length,
      goal,
      model: result.model || snapshot?.model || event.model,
      status: String(result.status || snapshot?.status || event.status || 'completed'),
      summary,
      output: summary,
      started_at: snapshot?.started_at || event.dispatched_at,
      completed_at: snapshot?.completed_at || event.completed_at,
      duration_seconds: result.duration_seconds || snapshot?.duration_seconds || event.duration_seconds || event.total_duration_seconds,
      api_calls: result.api_calls || snapshot?.api_calls || event.api_calls,
      input_tokens: result.input_tokens || snapshot?.input_tokens,
      output_tokens: result.output_tokens || snapshot?.output_tokens,
      cost_usd: result.cost_usd || snapshot?.cost_usd,
    }
  })
  const displayPayload = tasks.length === 1
    ? tasks[0]
    : {
        runtime: 'hermes',
        mode: 'background',
        delegation_id: delegationId,
        status: String(event.status || 'completed'),
        tasks,
      }
  const displayContent = JSON.stringify(displayPayload)
  if (!updateMessageDisplayContent(sessionId, delegation.messageId, displayContent)) return
  const message = state.messages.find(item =>
    String(item.id) === String(delegation.messageId)
    || (delegation.toolCallId && item.tool_call_id === delegation.toolCallId),
  )
  if (message) message.display_content = displayContent
}

function redactBridgeReadyError(error: string, endpoint?: string): string {
  const normalized = error.replace(/^Error:\s*/, '').trim() || 'unknown error'
  return redactAgentBridgeError(normalized, endpoint, 'configured endpoint') || 'unknown error'
}

function isBridgeStatusLookupTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /^Agent bridge request timed out after \d+ms$/.test(message.trim())
}

function isHermesWorkerBackedSession(session?: { source?: string | null; agent?: string | null; agent_session_id?: string | null }): boolean {
  const source = session?.source || undefined
  // "api_server" is a legacy/default source value; Hermes sessions still use worker-backed runtime.
  // coding_agent runs have a separate lifecycle.
  if (!source || source === 'cli' || source === 'api_server') return true
  if (source === 'workflow' || source === 'group_chat') {
    const agent = String(session?.agent || '').trim()
    return agent !== 'claude' && agent !== 'codex' && agent !== 'pi' && agent !== 'grok' && (agent !== 'opencode' && agent !== 'dsh') && agent !== 'ekko-agent' && !session?.agent_session_id
  }
  if (source !== 'global_agent') return false
  const agent = String(session?.agent || '').trim()
  return agent !== 'claude' && agent !== 'codex' && agent !== 'pi' && agent !== 'grok' && (agent !== 'opencode' && agent !== 'dsh') && agent !== 'ekko-agent' && !session?.agent_session_id
}

function isBridgeRunSource(source?: string): boolean {
  return source === 'cli' || source === 'global_agent' || source === 'workflow' || source === 'group_chat'
}

function mobileLocationRunInstruction(sessionId: string | undefined, source: string | undefined): string {
  if (!sessionId || source === 'workflow' || source === 'group_chat') return ''
  return [
    `The current Ekko Studio chat session id is ${JSON.stringify(sessionId)}.`,
    'Only when the user explicitly asks to use their current mobile-device location, use ekko_studio_use_toolset to describe and call ekko_studio_use_mobile_location with this exact session_id.',
    'The App will show a one-time confirmation before sharing WGS84 coordinates. Never request location proactively, in a delegated subtask, in a workflow node, or for background tracking.',
  ].join(' ')
}

function mobileCalendarRunInstruction(sessionId: string | undefined, source: string | undefined): string {
  if (!sessionId || source === 'workflow' || source === 'group_chat') return ''
  return [
    `The current Ekko Studio direct-chat session id is ${JSON.stringify(sessionId)}.`,
    'Only when the user explicitly asks to read or change calendar events, use ekko_studio_use_toolset to describe and call ekko_studio_use_mobile_calendar with this exact session_id.',
    'Only when the user explicitly asks to read or change reminders, use ekko_studio_use_toolset to describe and call ekko_studio_use_mobile_reminders with this exact session_id.',
    'The App always asks the user to share once or confirm the write. Never use these tools proactively, in delegated/workflow/group tasks, or for background access. Delete only the exact listed item after fresh App confirmation; never delete a whole recurring series.',
  ].join(' ')
}

function mobileHealthRunInstruction(sessionId: string | undefined, source: string | undefined): string {
  if (!sessionId || source === 'workflow' || source === 'group_chat') return ''
  return [
    `The current Ekko Studio direct-chat session id is ${JSON.stringify(sessionId)}.`,
    'Only when the user explicitly asks to read Apple Health data from their iPhone or iPad, use ekko_studio_use_toolset to describe and call ekko_studio_use_mobile_health with this exact session_id.',
    'Health data access is available only on iOS through Apple HealthKit. The App asks the user to share once and requests system permission. This tool is read-only and limited to its allowlisted activity, sleep, heart, oxygen and body metrics for at most 31 days. Never use it proactively, for diagnosis, advertising, background collection, delegated tasks, workflows, or group chats.',
  ].join(' ')
}
type ChatRunBridgeReadiness =
  | { ok: true }
  | { ok: false; error: string; runtimeUnavailable?: true }

function runtimeUnavailableForChatRun(): ChatRunBridgeReadiness | null {
  if (process.env.HERMES_RUNTIME_SOURCE?.trim() !== 'none') return null
  const status = getAgentStatusSnapshot().agents.find(agent => agent.id === 'hermes')
  return {
    ok: false,
    error: status?.error.trim()
      || 'Hermes Runtime is not installed or is incomplete. Open Runtime Manager to repair or download a Runtime.',
    runtimeUnavailable: true,
  }
}

export async function ensureBridgeReadyForChatRun(): Promise<ChatRunBridgeReadiness> {
  const runtimeUnavailable = runtimeUnavailableForChatRun()
  if (runtimeUnavailable) return runtimeUnavailable

  try {
    const manager = getAgentBridgeManager()
    await manager.start()
    const readiness = await manager.ensureReady({ timeoutMs: 1000, connectRetryMs: 0, recover: false })
    if (readiness.reachable) {
      return { ok: true }
    }
    return {
      ok: false,
      error: redactBridgeReadyError(readiness.error || `Agent Bridge is ${readiness.status}`, readiness.endpoint),
    }
  } catch (err) {
    return {
      ok: false,
      error: redactBridgeReadyError(err instanceof Error ? err.message : String(err)),
    }
  }
}

function isCodingAgentExecution(source: string | undefined, data?: { coding_agent_id?: string; agent_id?: string }): boolean {
  return source === 'coding_agent'
    || ((source === 'workflow' || source === 'group_chat') && Boolean(data?.coding_agent_id || data?.agent_id))
}

function resolveSessionCategoryId(value: unknown): number | null {
  const categoryId = Number(value)
  if (!Number.isSafeInteger(categoryId) || categoryId <= 0) return null
  return getSessionCategory(categoryId) ? categoryId : null
}

function isEkkoAgentExecution(data?: { coding_agent_id?: string; agent_id?: string }): boolean {
  return data?.coding_agent_id === 'ekko-agent' || data?.agent_id === 'ekko-agent'
}

function webhookAgentForRun(data?: { coding_agent_id?: string; agent_id?: string }): ChatRunWebhookAgent {
  const agent = data?.coding_agent_id || data?.agent_id
  if (agent === 'ekko-agent') return 'ekko'
  if (agent === 'codex') return 'codex'
  if (agent === 'pi') return 'pi'
  if (agent === 'grok') return 'grok'
  if (agent === 'dsh') return 'dsh'
  if (agent === 'opencode') return 'opencode'
  if (agent === 'claude-code') return 'claude-code'
  return 'bridge'
}

export interface ChatRunAndWaitResult {
  ok: boolean
  event: 'run.completed' | 'run.failed'
  session_id: string
  run_id?: string
  output?: string | null
  reasoning?: string | null
  error?: string
}

type ChatRunAutoApprovalChoice = 'once' | 'session' | 'always'

type MobileLocationAccuracy = 'coarse' | 'precise'

type MobileLocationValue = {
  latitude: number
  longitude: number
  accuracyMeters: number
  altitudeMeters?: number
  speedMetersPerSecond?: number
  coordinateSystem: 'wgs84'
  timestamp: number
}

export type MobileLocationResponse =
  | { status: 'success'; location: MobileLocationValue }
  | { status: 'denied' }
  | { status: 'error'; error: { code: string } }

type PendingMobileLocationRequest = {
  sessionId: string
  profile: string
  resolve: (response: MobileLocationResponse) => void
  timer: NodeJS.Timeout
}

const MOBILE_LOCATION_MIN_TIMEOUT_MS = 3_000
const MOBILE_LOCATION_MAX_TIMEOUT_MS = 60_000
const MOBILE_LOCATION_DEVICE_TIMEOUT_MS = 30_000
const MOBILE_LOCATION_PURPOSE_MAX_LENGTH = 240
const MOBILE_LOCATION_ERROR_CODES = new Set([
  'location_permission_denied',
  'location_timeout',
  'location_service_unavailable',
  'location_invalid_result',
  'location_failed',
])

function boundedMobileLocationTimeout(value: unknown): number {
  const numeric = Math.round(Number(value))
  if (!Number.isFinite(numeric)) return 35_000
  return Math.max(MOBILE_LOCATION_MIN_TIMEOUT_MS, Math.min(MOBILE_LOCATION_MAX_TIMEOUT_MS, numeric))
}

function finiteLocationNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizeMobileLocationResponse(value: unknown): MobileLocationResponse | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const response = value as Record<string, any>
  const status = String(response.status || '').trim()
  if (status === 'denied') return { status: 'denied' }
  if (status === 'error') {
    const rawCode = String(response.error?.code || '').trim()
    return {
      status: 'error',
      error: { code: MOBILE_LOCATION_ERROR_CODES.has(rawCode) ? rawCode : 'location_failed' },
    }
  }
  if (status !== 'success' || !response.location || typeof response.location !== 'object') return null
  // The App must supply WGS84 coordinates; relabeling another system does not convert it.
  if (Array.isArray(response.location) || response.location.coordinateSystem !== 'wgs84') return null
  const latitude = finiteLocationNumber(response.location.latitude)
  const longitude = finiteLocationNumber(response.location.longitude)
  if (
    latitude == null
    || longitude == null
    || latitude < -90
    || latitude > 90
    || longitude < -180
    || longitude > 180
  ) return null
  const location: MobileLocationValue = {
    latitude,
    longitude,
    accuracyMeters: Math.max(0, finiteLocationNumber(response.location.accuracyMeters) || 0),
    coordinateSystem: 'wgs84',
    timestamp: Math.max(0, Math.round(finiteLocationNumber(response.location.timestamp) || Date.now())),
  }
  const altitude = finiteLocationNumber(response.location.altitudeMeters)
  const speed = finiteLocationNumber(response.location.speedMetersPerSecond)
  if (altitude != null) location.altitudeMeters = altitude
  if (speed != null && speed >= 0) location.speedMetersPerSecond = speed
  return { status: 'success', location }
}

type PendingMobileCalendarRequest = {
  target: MobileDeviceTarget
  sessionId: string
  profile: string
  request: MobileCalendarRequest
  resolve: (response: MobileCalendarResponse) => void
  timer: NodeJS.Timeout
}
type PendingMobileHealthRequest = {
  target: MobileDeviceTarget
  sessionId: string
  profile: string
  request: MobileHealthRequest
  resolve: (response: MobileHealthResponse) => void
  timer: NodeJS.Timeout
}
const MOBILE_CALENDAR_MIN_TIMEOUT_MS = 3_000
const MOBILE_CALENDAR_MAX_TIMEOUT_MS = 300_000
const MOBILE_CALENDAR_DEFAULT_TIMEOUT_MS = 300_000
function boundedMobileCalendarTimeout(value: unknown): number {
  const numeric = Math.round(Number(value))
  if (value == null || !Number.isFinite(numeric) || numeric <= 0) return MOBILE_CALENDAR_DEFAULT_TIMEOUT_MS
  return Math.max(MOBILE_CALENDAR_MIN_TIMEOUT_MS, Math.min(MOBILE_CALENDAR_MAX_TIMEOUT_MS, numeric))
}
export class ChatRunSocket {
  private nsp: ReturnType<Server['of']>
  private bridge = createPrimaryAgentBridge()
  private backgroundBridge = createPrimaryAgentBridge({ timeoutMs: 1000, connectRetryMs: 0 })
  /** sessionId → session state (messages, working status, events, run tracking) */
  private sessionMap = new Map<string, SessionState>()
  private readonly taskPlanRuns = new TaskPlanRuns(saveTaskPlan, (sessionId, snapshot) => {
    this.emitExternalEvent(sessionId, 'plan.updated', { event: 'plan.updated', ...snapshot })
  })
  private readonly clarificationRuns = new ClarificationRuns((sessionId, event, payload) => {
    this.emitExternalEvent(sessionId, event, payload)
    if (event === 'clarify.resolved') this.clearClarifyEventState(sessionId, String(payload.clarify_id))
  })
  private bridgeResumePolls = new Set<string>()
  private readonly runWaiters = new Map<string, Set<(event: string, payload: any) => void>>()
  private readonly pendingMobileLocations = new Map<string, PendingMobileLocationRequest>()
  private readonly mobileRunTargets = new Map<string, MobileDeviceTarget>()
  private readonly pendingMobileCalendar = new Map<string, PendingMobileCalendarRequest>()
  private readonly pendingMobileHealth = new Map<string, PendingMobileHealthRequest>()
  private backgroundPollTimer?: NodeJS.Timeout
  private backgroundPollInFlight = false
  private backgroundRecoveryNeeded = true
  private backgroundBrokerId?: string
  private backgroundPollRetryAt = 0
  private backgroundActivityGraceUntil = 0
  private closing = false

  constructor(io: Server) {
    this.nsp = io.of('/chat-run')
  }

  isLiveActivityRunActive(sessionId: string, profile: string, runId: string): boolean {
    const state = this.sessionMap.get(sessionId)
    return !!state?.isWorking && !state.isAborting && (state.activeRunMarker || state.responseRun?.runMarker || state.runId) === runId
      && (state.profile || getSession(sessionId)?.profile || 'default') === profile
  }

  getLiveActivityStartedAt(sessionId: string, profile: string, runId: string): number | undefined {
    if (!this.isLiveActivityRunActive(sessionId, profile, runId)) return undefined
    const started = this.sessionMap.get(sessionId)?.runStartedAt
    return typeof started === 'number' && Number.isFinite(started) && started > 0 ? started / 1000 : undefined
  }

  updateTaskPlan(contextId: string, profile: string, input: Record<string, unknown>) {
    return this.taskPlanRuns.update(contextId, profile, input)
  }

  requestClarification(contextId: string, profile: string, input: Record<string, unknown>, signal?: AbortSignal) {
    return this.clarificationRuns.request(contextId, profile, input, signal)
  }

  beginGroupTaskPlanRun(sessionId: string, profile: string, runId: string, isCurrent: () => boolean, publish: (snapshot: import('../contracts/task-plan').TaskPlanSnapshot) => void) {
    const contextId = this.taskPlanRuns.begin(sessionId, profile,
      () => ({ isWorking: isCurrent(), activeRunMarker: runId }), publish)
    return { contextId, finish: (state: 'ended' | 'interrupted' | 'failed') => this.taskPlanRuns.finish(contextId, state) }
  }

  private beginTaskPlanRun(sessionId: string | undefined, profile: string) {
    if (!sessionId) return undefined
    this.clarificationRuns.finishSession(sessionId)
    return this.taskPlanRuns.begin(sessionId, profile, () => this.sessionMap.get(sessionId))
  }

  private finishTaskPlanRun(sessionId: string, event: string, payload?: any, contextId?: string) {
    if (!['run.completed', 'run.failed', 'abort.completed'].includes(event)) return
    this.clarificationRuns.finishSession(sessionId, contextId)
    const interrupted = event === 'abort.completed' || payload?.interrupted === true || payload?.result?.interrupted === true || this.sessionMap.get(sessionId)?.isAborting
    const executionState = interrupted ? 'interrupted' : event === 'run.failed' ? 'failed' : 'ended'
    try {
      if (contextId) this.taskPlanRuns.finish(contextId, executionState)
      else this.taskPlanRuns.finishSession(sessionId, executionState)
    } catch (err) {
      // Keep terminal run delivery working even if persistence fails; startup recovery settles the stored plan.
      logger.warn(err, '[chat-run-socket] failed to finish task plan for %s', sessionId)
    }
  }

  emitSessionSettingsUpdated(sessionId: string, settings: {
    model?: string
    provider?: string
    api_mode?: string
    reasoning_effort?: string
    push_enabled?: boolean
  }): void {
    this.nsp.to(`session:${sessionId}`).emit('session.settings.updated', {
      event: 'session.settings.updated',
      session_id: sessionId,
      ...settings,
    })
  }

  requestMobileLocation(options: {
    sessionId: string
    profile: string
    purpose?: string
    accuracy?: MobileLocationAccuracy
    timeoutMs?: number
  }): Promise<MobileLocationResponse> {
    const sessionId = String(options.sessionId || '').trim()
    const profile = String(options.profile || '').trim() || 'default'
    const session = getSession(sessionId)
    if (!session) throw new Error('Session not found')
    if ((String(session.profile || '').trim() || 'default') !== profile) {
      throw new Error('Session is not available for this profile')
    }
    if (session.source === 'group_chat' || session.source === 'workflow') {
      throw new Error('Mobile location is available only in direct chats')
    }
    for (const pending of this.pendingMobileLocations.values()) {
      if (pending.sessionId === sessionId) throw new Error('A mobile location request is already pending')
    }

    const locationRequestId = randomUUID()
    const timeoutMs = boundedMobileLocationTimeout(options.timeoutMs)
    const purpose = String(options.purpose || '').trim().slice(0, MOBILE_LOCATION_PURPOSE_MAX_LENGTH)
    const accuracy: MobileLocationAccuracy = options.accuracy === 'precise' ? 'precise' : 'coarse'

    return new Promise<MobileLocationResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.finishMobileLocationRequest(locationRequestId, {
          status: 'error',
          error: { code: 'location_timeout' },
        })
      }, timeoutMs)
      timer.unref?.()
      this.pendingMobileLocations.set(locationRequestId, {
        sessionId,
        profile,
        resolve,
        timer,
      })
      this.emitMobileLocationEvent(profile, sessionId, 'location.requested', {
        event: 'location.requested',
        location_request_id: locationRequestId,
        purpose,
        accuracy,
        timeout_ms: Math.min(timeoutMs, MOBILE_LOCATION_DEVICE_TIMEOUT_MS),
        max_age_ms: 0,
      })
    })
  }

  requestMobileCalendar(options: {
    sessionId: string
    profile: string
    capability: MobileCalendarCapability
    action?: unknown
    purpose?: unknown
    startMs?: unknown
    endMs?: unknown
    includeCompleted?: unknown
    limit?: unknown
    item?: unknown
    timeoutMs?: unknown
  }): Promise<MobileCalendarResponse> {
    const sessionId = String(options.sessionId || '').trim()
    const profile = String(options.profile || '').trim() || 'default'
    const session = getSession(sessionId)
    if (!session) throw new Error('Session not found')
    if ((String(session.profile || '').trim() || 'default') !== profile) {
      throw new Error('Session is not available for this profile')
    }
    if (session.source === 'group_chat' || session.source === 'workflow') {
      throw new Error('Mobile calendar and reminders are available only in direct chats')
    }
    for (const pending of this.pendingMobileCalendar.values()) {
      if (pending.sessionId === sessionId) throw new Error('A mobile calendar or reminder request is already pending')
    }
    const target = this.mobileRunTargets.get(sessionId)
    if (!target || target.profile !== profile) throw new Error('Mobile target unavailable; send a new message from the intended mobile device')
    const room = this.nsp.adapter.rooms.get(mobileDeviceRoom(target))
    if (!room?.size) throw new Error('Target mobile device is offline; reconnect the same device')
    const request = normalizeMobileCalendarRequest({
      capability: options.capability,
      action: options.action,
      purpose: options.purpose,
      start_ms: options.startMs,
      end_ms: options.endMs,
      include_completed: options.includeCompleted,
      limit: options.limit,
      item: options.item,
    })
    const requestId = randomUUID()
    const timeoutMs = boundedMobileCalendarTimeout(options.timeoutMs)
    const event = request.capability === 'reminder' ? 'reminder.requested' : 'calendar.requested'
    const idKey = request.capability === 'reminder' ? 'reminder_request_id' : 'calendar_request_id'
    return new Promise<MobileCalendarResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.finishMobileCalendarRequest(requestId, {
          status: 'error',
          error: { code: 'calendar_failed' },
        })
      }, timeoutMs)
      timer.unref?.()
      this.pendingMobileCalendar.set(requestId, { sessionId, profile, target, request, resolve, timer })
      this.emitMobileCalendarEvent(profile, sessionId, event, {
        event,
        [idKey]: requestId,
        ...request,
        target_device_id: target.deviceCode,
        target_user_id: target.userId,
        target_profile: target.profile,
        timeout_ms: timeoutMs,
        expires_at_ms: Date.now() + timeoutMs,
      })
    })
  }

  requestMobileHealth(options: {
    sessionId: string
    profile: string
    purpose?: unknown
    metrics?: unknown
    startMs?: unknown
    endMs?: unknown
    limit?: unknown
    timeoutMs?: unknown
  }): Promise<MobileHealthResponse> {
    const sessionId = String(options.sessionId || '').trim()
    const profile = String(options.profile || '').trim() || 'default'
    const session = getSession(sessionId)
    if (!session) throw new Error('Session not found')
    if ((String(session.profile || '').trim() || 'default') !== profile) throw new Error('Session is not available for this profile')
    if (session.source === 'group_chat' || session.source === 'workflow') throw new Error('Mobile health data is available only in direct chats')
    for (const pending of this.pendingMobileHealth.values()) {
      if (pending.sessionId === sessionId) throw new Error('A mobile health request is already pending')
    }
    const target = this.mobileRunTargets.get(sessionId)
    if (!target || target.profile !== profile) throw new Error('Mobile target unavailable; send a new message from the intended mobile device')
    if (target.platform !== 'ios') throw new Error('Mobile health data is available only on iPhone and iPad')
    if (!this.nsp.adapter.rooms.get(mobileDeviceRoom(target))?.size) throw new Error('Target mobile device is offline; reconnect the same device')
    const request = normalizeMobileHealthRequest({
      purpose: options.purpose,
      metrics: options.metrics,
      start_ms: options.startMs,
      end_ms: options.endMs,
      limit: options.limit,
    })
    const requestId = randomUUID()
    const timeoutMs = boundedMobileCalendarTimeout(options.timeoutMs)
    return new Promise<MobileHealthResponse>((resolve) => {
      const timer = setTimeout(() => this.finishMobileHealthRequest(requestId, {
        status: 'error',
        error: { code: 'health_timeout' },
      }), timeoutMs)
      timer.unref?.()
      this.pendingMobileHealth.set(requestId, { sessionId, profile, target, request, resolve, timer })
      this.emitMobileHealthEvent(sessionId, 'health.requested', {
        event: 'health.requested',
        health_request_id: requestId,
        ...request,
        target_device_id: target.deviceCode,
        target_user_id: target.userId,
        target_profile: target.profile,
        timeout_ms: timeoutMs,
        expires_at_ms: Date.now() + timeoutMs,
      })
    })
  }
  init() {
    this.closing = false
    this.nsp.use(this.authMiddleware.bind(this))
    this.nsp.on('connection', this.onConnection.bind(this))
    this.backgroundPollTimer = setInterval(() => void this.pollBackgroundWork(), 500)
    this.backgroundPollTimer.unref?.()
    void this.pollBackgroundWork()
    logger.info('[chat-run-socket] Socket.IO ready at /chat-run')
  }

  // --- Auth middleware ---

  private async authMiddleware(socket: Socket, next: (err?: Error) => void) {
    const token = socket.handshake.auth?.token as string | undefined
    const shareToken = socketShareToken(socket.handshake.auth)
    if (shareToken) {
      try {
        const access = await authenticateSessionShare(shareToken, String(socket.handshake.auth?.appAccessToken || ''))
        assertShareProfile(access, socket.handshake.query?.profile)
        socket.handshake.query.profile = access.share.profile
        socket.data.sessionShare = access
        socket.data.user = sessionShareExecutionUser(access)
        return next()
      } catch (error) { return next(error instanceof Error ? error : new Error('share_access_denied')) }
    }
    const appToken = token ? await inspectAppUserToken(token) : null
    if (appToken) {
      if (appToken.status !== 'active' || !appToken.user) return next(new Error('App device authentication failed'))
      const profile = String(socket.handshake.query?.profile || 'default')
      if (!this.canAccessProfile(appToken.user, profile)) return next(new Error('Profile access denied'))
      const rawPlatform = String(socket.handshake.query?.platform || '').trim().toLowerCase()
      const platform = rawPlatform === 'ios' || rawPlatform === 'android' ? rawPlatform : 'unknown'
      socket.data.mobileDeviceTarget = {
        deviceCode: appToken.deviceCode,
        userId: String(appToken.user.id),
        profile,
        platform,
      }
    }
    if (!await isAuthEnabled()) {
      next()
      return
    }

    const user = await authenticateUserToken(token || '')
    if (!user) {
      return next(new Error('Authentication failed'))
    }
    const socketProfile = String(socket.handshake.query?.profile || 'default').trim() || 'default'
    if (socketProfile && !this.canAccessProfile(user, socketProfile)) {
      return next(new Error('Profile access denied'))
    }
    socket.data.user = user
    next()
  }

  // --- Connection handler ---

  private onConnection(socket: Socket) {
    const shared = socket.data.sessionShare as SessionShareAccess | undefined
    if (shared) bindSessionShareSocket(socket, shared, () => {
      const state = this.sessionMap.get(shared.share.session_id)
      if (!state) return
      state.queue = state.queue.filter(item => item.originSocketId !== socket.id)
      if (state.queueInsertion && !state.queue.some(item => item.queue_id === state.queueInsertion?.queueId)) {
        this.clearQueueInsertion(shared.share.session_id, state, 'share_access_denied')
      }
      this.nsp.to(`session:${shared.share.session_id}`).emit('run.queued', {
        event: 'run.queued', session_id: shared.share.session_id,
        queue_length: state.queue.length, queued_messages: this.serializeQueuedMessages(state.queue),
      })
    })
    if (!shared) {
      bindAppEventSubscription(socket, (_user, profile) => {
        const result: BusinessEvent[] = []
        for (const [sessionId, state] of this.sessionMap) {
          if (!state.isWorking || (state.profile || getSession(sessionId)?.profile || 'default') !== profile) continue
          const source = state.source || getSession(sessionId)?.source
          if (source === 'group_chat') continue
          // Task cards belong to a turn; coding-agent runId can span many turns.
          const runId = state.activeRunMarker || state.responseRun?.runMarker || state.runId
          const subject = { session_id: sessionId, run_id: runId, workflow_id: state.webhookWorkflowId }
          if (source !== 'workflow') result.push(stateEvent('chat.run.updated', profile, subject,
            { state: { session_id: sessionId, status: 'running', timestamp: Date.now(), started_at: state.runStartedAt } }))
          const pending = new Map<string, BusinessEvent>()
          for (const { event, data } of buildResumeEvents(state.events)) {
            if (!['approval.requested', 'approval.resolved', 'clarify.requested', 'clarify.resolved'].includes(event)) continue
            const id = data?.approval_id || data?.clarify_id
            if (!id) continue
            const key = `${event.split('.')[0]}:${id}`
            if (event.endsWith('.resolved')) {
              if (!data.stale && (data.resolved !== false || ['timeout', 'aborted', 'cancelled', 'canceled'].includes(data.reason))) pending.delete(key)
              continue
            }
            if (data.remaining_timeout_ms === 0) continue
            const type = `chat.${event.replace('clarify.', 'clarification.')}`
            pending.set(key, stateEvent(type, profile, { ...subject,
              ...(event.startsWith('approval.') ? { approval_id: id } : { clarification_id: id }) }, data))
          }
          result.push(...pending.values())
          for (const card of getSessionTaskPlans(sessionId, [], true, runId)) {
            if (card.run_id !== runId) continue
            const event = planStateEvent(profile, subject, card)
            if (event) result.push(event)
          }
        }
        return result
      })
      bindLegacyAppEvents(socket, 'chat', event => {
        const user = socket.data.user as AuthenticatedUser | undefined
        return Boolean(user && this.canAccessProfile(user, event.profile)
          && socket.rooms.has(`pending-interactions:${event.profile}`))
      })
    }
    const socketUser = socket.data.user as AuthenticatedUser | undefined
    const socketProfile = (socket.handshake.query?.profile as string) || 'default'
    const currentProfile = () => socketProfile || getActiveProfileName() || 'default'
    const mobileTarget = socket.data.mobileDeviceTarget as MobileDeviceTarget | undefined
    if (mobileTarget) socket.join(mobileDeviceRoom(mobileTarget))
    if (!shared) { socket.join('studio-account'); socket.join(`pending-interactions:${currentProfile()}`) }
    socket.emit('session.activity.snapshot', {
      event: 'session.activity.snapshot',
      profile: currentProfile(),
      sessions: Array.from(this.sessionMap.entries()).flatMap(([sessionId, state]) => {
        if (!state.isWorking || (shared && sessionId !== shared.share.session_id)) return []
        const profile = state.profile || getSession(sessionId)?.profile || 'default'
        return profile === currentProfile() ? [{ session_id: sessionId, status: 'running' }] : []
      }),
      timestamp: Date.now(),
    })
    const profileExists = (profile: string) => {
      if (!profile || profile === 'default') return true
      return listProfileNamesFromDisk().includes(profile)
    }
    const resolveRunProfile = (sessionId?: string, requested?: string) => {
      const requestedProfile = typeof requested === 'string' ? requested.trim() : ''
      if (requestedProfile) {
        if (!profileExists(requestedProfile)) throw new Error(`Profile "${requestedProfile}" does not exist`)
        if (socketUser && !this.canAccessProfile(socketUser, requestedProfile)) {
          throw new Error(`Profile "${requestedProfile}" is not available for this user`)
        }
        return requestedProfile
      }
      if (!sessionId) {
        const profile = currentProfile()
        if (socketUser && !this.canAccessProfile(socketUser, profile)) {
          throw new Error(`Profile "${profile}" is not available for this user`)
        }
        return profile
      }
      const storedProfile = getSession(sessionId)?.profile || ''
      const profile = storedProfile && profileExists(storedProfile) ? storedProfile : currentProfile()
      if (socketUser && !this.canAccessProfile(socketUser, profile)) {
        throw new Error(`Profile "${profile}" is not available for this user`)
      }
      return profile
    }
    const requireSocketSessionAccess = (sessionId: string) => {
      const session = getSession(sessionId)
      if (!session) throw new Error('Session not found')
      const sessionProfile = String(session.profile || 'default').trim() || 'default'
      const authorizedProfile = currentProfile()
      if (sessionProfile !== authorizedProfile) {
        throw new Error(`Profile "${sessionProfile}" is not available on this connection`)
      }
      if (!profileExists(sessionProfile)) {
        throw new Error(`Profile "${sessionProfile}" does not exist`)
      }
      if (socketUser && !this.canAccessProfile(socketUser, sessionProfile)) {
        throw new Error(`Profile "${sessionProfile}" is not available for this user`)
      }
      return sessionProfile
    }

    socket.on('run', async (data: {
      push_snapshot?: unknown
      input: string | ContentBlock[]
      display_input?: string | ContentBlock[] | null
      display_role?: 'user' | 'command'
      storage_message?: string
      session_id?: string
      model?: string
      instructions?: string
      group_system_prompt?: string
      group_room_id?: string
      group_agent_id?: string
      workflow_id?: string
      workflow_node_id?: string
      provider?: string
      model_groups?: Array<{ provider: string; models: string[] }>
      queue_id?: string
      workspace?: string | null
      category_id?: number | null
      source?: string
      session_source?: 'global_agent' | 'workflow' | 'group_chat'
      memory_input?: string | ContentBlock[]
      memory_messages?: EkkoAgentRunSocketData['memory_messages']
      memory_write_policy?: 'automatic' | 'explicit-only'
      memory_origin?: EkkoAgentRunSocketData['memory_origin']
      memory_recall_scopes?: EkkoAgentRunSocketData['memory_recall_scopes']
      memory_write_scopes?: EkkoAgentRunSocketData['memory_write_scopes']
      memory_default_write_scope?: EkkoAgentRunSocketData['memory_default_write_scope']
      coding_agent_id?: ChatCodingAgentId
      agent_id?: ChatCodingAgentId
      mode?: 'scoped' | 'global'
      baseUrl?: string
      base_url?: string
      apiKey?: string
      api_key?: string
      apiMode?: string
      api_mode?: string
      mcpServers?: Record<string, unknown>
      mcp_servers?: Record<string, unknown>
      profile?: string
      allow_command_passthrough?: boolean
      // Local patch (reasoning-effort): per-session reasoning effort override.
      reasoning_effort?: string
      push_enabled?: boolean
    }) => {
      const pushSnapshot = data.push_snapshot
      delete data.push_snapshot
      let pushTargetId: string | undefined
      let runProfile: string
      try {
        runProfile = resolveRunProfile(data.session_id, data.profile)
      } catch (err) {
        const payload = {
          event: 'run.failed',
          session_id: data.session_id,
          queue_id: data.queue_id,
          error: err instanceof Error ? err.message : String(err),
        }
        socket.emit('run.failed', payload)
        return
      }
      if (data.category_id !== undefined) {
        data.category_id = resolveSessionCategoryId(data.category_id)
      }
      if (data.session_id) {
        const state = getOrCreateSession(this.sessionMap, data.session_id)
        const source = resolveRunSource(data.source, data.session_id)
        const command = parseSessionCommand(data.input)
        if (command && (isBridgeRunSource(source) || command.name === 'branch')) {
          try {
            const handled = await handleSessionCommand(data.session_id, command, {
              nsp: this.nsp,
              socket,
              sessionMap: this.sessionMap,
              bridge: this.bridge,
              profile: runProfile,
              model: data.model,
              provider: data.provider,
              model_groups: data.model_groups,
              instructions: data.instructions,
              queueId: data.queue_id,
              runQueuedItem: this.runQueuedItem.bind(this),
            })
            if (handled !== false) return
            data.allow_command_passthrough = true
          } catch (err) {
            this.emitToSession(socket, data.session_id, 'session.command', {
              event: 'session.command',
              command: command.rawName,
              ok: false,
              action: 'error',
              message: err instanceof Error ? err.message : String(err),
            })
          }
          return
        }
        if (isCodingAgentExecution(source, data)) {
          if (typeof data.input === 'string') {
            const codingAgentCommand = parseCodingAgentSessionCommand(data.input)
            if (codingAgentCommand) {
              await handleCodingAgentSessionCommand(this.nsp, socket, data, codingAgentCommand, runProfile, this.sessionMap)
              return
            }
          }
        }
        try {
          const actor = shared ? null : await authenticatedPushActor(socket.handshake.auth?.token)
          if (actor) {
            const target = bindRunPushTarget({ kind: 'chat', profile: runProfile, runId: randomUUID() }, data.session_id, actor, {
              ciphertext: prepareRunPushSnapshot(actor, pushSnapshot),
              platform: String((pushSnapshot as any)?.platform || 'unknown'),
            })
            pushTargetId = target.id
            socket.emit('run.push.bound', { session_id: data.session_id, queue_id: data.queue_id, run_id: target.run_id })
          }
        } catch {
          socket.emit('run.failed', { session_id: data.session_id, queue_id: data.queue_id, error: 'Run device binding failed' })
          return
        }
        if (state.isWorking) {
          const queueId = data.queue_id || `queue_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
          state.queue.push({
            queue_id: queueId,
            input: data.input,
            displayInput: data.display_input,
            displayRole: data.display_role,
            storageMessage: data.storage_message,
            model: data.model,
            provider: data.provider,
            model_groups: data.model_groups,
            instructions: data.instructions,
            groupSystemPrompt: data.group_system_prompt,
            groupRoomId: data.group_room_id,
            groupAgentId: data.group_agent_id,
            workflowId: data.workflow_id,
            workflowNodeId: data.workflow_node_id,
            profile: runProfile,
            workspace: data.workspace,
            source,
            sessionSource: data.session_source,
            codingAgentId: data.coding_agent_id,
            agentId: data.agent_id,
            mode: data.mode,
            baseUrl: data.baseUrl,
            base_url: data.base_url,
            apiKey: data.apiKey,
            api_key: data.api_key,
            apiMode: data.apiMode,
            api_mode: data.api_mode,
            mcpServers: data.mcpServers,
            mcp_servers: data.mcp_servers,
            commandPassthrough: data.allow_command_passthrough,
            reasoningEffort: data.reasoning_effort,
            originSocketId: socket.id,
            authorize: shared ? async () => { await refreshSessionShare(shared, 'input', data.session_id) } : undefined,
            pushTargetId,
          })
          const queuedPayload = {
            event: 'run.queued',
            session_id: data.session_id,
            queue_id: queueId,
            queue_length: state.queue.length,
            queued_messages: this.serializeQueuedMessages(state.queue),
          }
          observeChatRunWebhookEvent({
            event: 'run.queued',
            sessionId: data.session_id,
            profile: runProfile,
            source,
            agent: webhookAgentForRun(data),
            payload: queuedPayload,
            roomId: data.group_room_id,
            workflowId: data.workflow_id,
            workflowNodeId: data.workflow_node_id,
          })
          this.nsp.to(`session:${data.session_id}`).emit('run.queued', queuedPayload)
          logger.info('[chat-run-socket] queued run for session %s (queue: %d)', data.session_id, state.queue.length)
          return
        }
        state.events = []
        state.isWorking = !isCodingAgentExecution(source, data)
        state.runStartedAt = Date.now()
        state.profile = runProfile
        state.source = source
      }
      try {
        await this.handleRun(socket, data, runProfile, false, undefined, pushTargetId)
      } catch (err) {
        const payload = {
          event: 'run.failed',
          session_id: data.session_id,
          queue_id: data.queue_id,
          error: err instanceof Error ? err.message : String(err),
        }
        if (data.session_id) {
          observeChatRunWebhookEvent({
            pushTargetId,
            event: 'run.failed',
            sessionId: data.session_id,
            profile: runProfile,
            source: resolveRunSource(data.source, data.session_id),
            agent: webhookAgentForRun(data),
            payload,
            roomId: data.group_room_id,
            workflowId: data.workflow_id,
            workflowNodeId: data.workflow_node_id,
          })
        }
        if (data.session_id) {
          const state = this.sessionMap.get(data.session_id)
          if (state && !state.runId && !state.abortController && !state.activeRunMarker) {
            state.isWorking = false
            state.profile = undefined
          }
        }
        socket.emit('run.failed', payload)
      }
    })

    socket.on('insert_queued_run', (data: { session_id?: string; queue_id?: string }) => {
      if (!data.session_id || !data.queue_id) return
      try {
        requireSocketSessionAccess(data.session_id)
      } catch {
        return
      }
      void this.requestQueuedRunInsertion(data.session_id, data.queue_id)
    })

    socket.on('cancel_queued_run', (data: { session_id?: string; queue_id?: string }) => {
      if (!data.session_id || !data.queue_id) return
      try {
        requireSocketSessionAccess(data.session_id)
      } catch {
        return
      }
      const state = this.sessionMap.get(data.session_id)
      if (!state?.queue.length) return
      const before = state.queue.length
      state.queue = state.queue.filter(item => item.queue_id !== data.queue_id)
      if (state.queue.length === before) return
      if (state.queueInsertion?.queueId === data.queue_id) {
        const nextVisible = state.queue.find(item => this.isQueueInsertionCandidate(item))
        if (nextVisible) {
          state.queueInsertion.queueId = nextVisible.queue_id
          this.emitQueueInsertionUpdate(data.session_id, state.queueInsertion)
        } else {
          this.clearQueueInsertion(data.session_id, state, 'queued_message_removed')
        }
      }
      this.nsp.to(`session:${data.session_id}`).emit('run.queued', {
        event: 'run.queued',
        session_id: data.session_id,
        queue_length: state.queue.length,
        queued_messages: this.serializeQueuedMessages(state.queue),
      })
      logger.info('[chat-run-socket] cancelled queued run %s for session %s (queue: %d)',
        data.queue_id, data.session_id, state.queue.length)
    })

    socket.on('resume', async (data: { session_id?: string }) => {
      if (!data.session_id) return
      const sid = data.session_id
      try {
        requireSocketSessionAccess(sid)
      } catch (err) {
        socket.emit('run.failed', {
          event: 'run.failed',
          session_id: sid,
          error: err instanceof Error ? err.message : String(err),
        })
        return
      }
      socket.join(`session:${sid}`)
      await this.resumeSession(socket, sid)
    })

    socket.on('app.resume', async (data: { session_id?: string; id?: string }) => {
      if (!data.session_id || typeof data.id !== 'string' || data.id.length > 128) return
      const sid = data.session_id
      try {
        requireSocketSessionAccess(sid)
      } catch (err) {
        socket.emit('run.failed', {
          event: 'run.failed',
          session_id: sid,
          error: err instanceof Error ? err.message : String(err),
        })
        return
      }
      socket.join(`session:${sid}`)
      await this.resumeSession(socket, sid, { event: 'app.resumed', cachedId: data.id })
    })

    socket.on('abort', (data: { session_id?: string }) => {
      if (data.session_id) {
        const sessionId = data.session_id
        let profile: string
        try {
          profile = requireSocketSessionAccess(sessionId)
        } catch {
          return
        }
        this.finishTaskPlanRun(sessionId, 'abort.completed')
        void handleAbort(
          this.nsp,
          socket,
          sessionId,
          this.sessionMap,
          this.bridge,
          this.runQueuedItem.bind(this),
        ).then(() => {
          const state = this.sessionMap.get(sessionId)
          this.emitSessionActivity(profile, state?.isWorking ? 'run.started' : 'abort.completed', {
            session_id: sessionId,
          })
        }).catch(err => logger.warn(err, '[chat-run-socket] abort failed for session %s', sessionId))
      }
    })

    socket.on('approval.respond', async (data: { session_id?: string; approval_id?: string; choice?: string }) => {
      if (!data.session_id || !data.approval_id) return
      try {
        requireSocketSessionAccess(data.session_id)
      } catch (err) {
        socket.emit('approval.resolved', {
          event: 'approval.resolved',
          session_id: data.session_id,
          approval_id: data.approval_id,
          choice: data.choice || 'deny',
          resolved: false,
          error: err instanceof Error ? err.message : String(err),
        })
        return
      }
      const ekkoResult = respondToEkkoToolApproval(
        data.session_id,
        data.approval_id,
        data.choice,
      )
      if (ekkoResult.handled) {
        if (!ekkoResult.resolved) {
          this.emitToSession(socket, data.session_id, 'approval.resolved', {
            event: 'approval.resolved',
            approval_id: data.approval_id,
            choice: ekkoResult.choice,
            resolved: false,
            error: 'Approval does not belong to this session.',
          })
        }
        return
      }
      const codingAgentResult = codingAgentRunManager.resolveApproval(
        data.session_id,
        data.approval_id,
        data.choice,
      )
      if (codingAgentResult.handled) {
        this.emitToSession(socket, data.session_id, 'approval.resolved', {
          event: 'approval.resolved',
          approval_id: data.approval_id,
          choice: data.choice || 'deny',
          resolved: codingAgentResult.resolved,
          ...(!codingAgentResult.resolved ? { error: 'Approval could not be applied.' } : {}),
        })
        return
      }
      try {
        if (shared && !buildResumeEvents(this.sessionMap.get(data.session_id)?.events || []).some(entry => entry.event === 'approval.requested' && entry.data?.approval_id === data.approval_id)) throw new Error('Approval does not belong to this session')
        const result = await this.bridge.approvalRespond(data.approval_id, data.choice || 'deny')
        const resolved = Boolean(result.resolved)
        this.emitToSession(socket, data.session_id, 'approval.resolved', {
          event: 'approval.resolved',
          approval_id: data.approval_id,
          choice: data.choice || 'deny',
          resolved,
          ...(!resolved ? {
            stale: true,
            error: 'Approval is no longer pending.',
          } : {}),
        })
      } catch (err) {
        this.emitToSession(socket, data.session_id, 'approval.resolved', {
          event: 'approval.resolved',
          approval_id: data.approval_id,
          choice: data.choice || 'deny',
          resolved: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })

    socket.on('clarify.respond', async (data: { session_id?: string; clarify_id?: string; response?: string }) => {
      if (!data.session_id || !data.clarify_id) return
      try {
        requireSocketSessionAccess(data.session_id)
      } catch (err) {
        socket.emit('clarify.resolved', {
          event: 'clarify.resolved',
          session_id: data.session_id,
          clarify_id: data.clarify_id,
          resolved: false,
          error: err instanceof Error ? err.message : String(err),
        })
        return
      }
      const mcpResult = this.clarificationRuns.respond(data.session_id, data.clarify_id, data.response)
      if (mcpResult.handled) {
        if (!mcpResult.resolved) socket.emit('clarify.resolved', {
          event: 'clarify.resolved', session_id: data.session_id, clarify_id: data.clarify_id,
          resolved: false, error: 'Clarification could not be applied.',
        })
        return
      }
      const ekkoResult = respondToEkkoClarification(
        data.session_id,
        data.clarify_id,
        data.response,
      )
      if (ekkoResult.handled) {
        if (!ekkoResult.resolved) {
          this.emitToSession(socket, data.session_id, 'clarify.resolved', {
            event: 'clarify.resolved',
            clarify_id: data.clarify_id,
            resolved: false,
            error: 'Clarification does not belong to this session.',
          })
        } else {
          this.clearClarifyEventState(data.session_id, data.clarify_id)
        }
        return
      }
      const codingAgentResult = codingAgentRunManager.resolveClarification(
        data.session_id,
        data.clarify_id,
        data.response,
      )
      if (codingAgentResult.handled) {
        this.emitToSession(socket, data.session_id, 'clarify.resolved', {
          event: 'clarify.resolved',
          clarify_id: data.clarify_id,
          resolved: codingAgentResult.resolved,
          ...(!codingAgentResult.resolved ? { error: 'Clarification could not be applied.' } : {}),
        })
        if (codingAgentResult.resolved) {
          this.clearClarifyEventState(data.session_id, data.clarify_id)
        }
        return
      }
      try {
        if (shared && !buildResumeEvents(this.sessionMap.get(data.session_id)?.events || []).some(entry => entry.event === 'clarify.requested' && entry.data?.clarify_id === data.clarify_id)) throw new Error('Clarification does not belong to this session')
        const result = await this.bridge.clarifyRespond(data.clarify_id, data.response || '')
        const resolved = Boolean((result as any)?.resolved)
        this.emitToSession(socket, data.session_id, 'clarify.resolved', {
          event: 'clarify.resolved',
          clarify_id: data.clarify_id,
          resolved,
          ...(!resolved ? {
            stale: true,
            error: 'Clarification is no longer pending.',
          } : {}),
        })
        if (resolved) {
          this.clearClarifyEventState(data.session_id, data.clarify_id)
        }
      } catch (err) {
        this.emitToSession(socket, data.session_id, 'clarify.resolved', {
          event: 'clarify.resolved',
          clarify_id: data.clarify_id,
          resolved: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })

    socket.on('location.respond', (data: {
      session_id?: string
      location_request_id?: string
      status?: string
      location?: unknown
      error?: unknown
    }) => {
      if (!data.session_id || !data.location_request_id) return
      try {
        requireSocketSessionAccess(data.session_id)
      } catch (err) {
        socket.emit('location.resolved', {
          event: 'location.resolved',
          session_id: data.session_id,
          location_request_id: data.location_request_id,
          resolved: false,
          error: err instanceof Error ? err.message : String(err),
        })
        return
      }
      const pending = this.pendingMobileLocations.get(data.location_request_id)
      if (!pending || pending.sessionId !== data.session_id) {
        this.emitToSession(socket, data.session_id, 'location.resolved', {
          event: 'location.resolved',
          location_request_id: data.location_request_id,
          resolved: false,
          stale: true,
          error: 'Location request is no longer pending.',
        })
        return
      }
      const response = normalizeMobileLocationResponse(data)
      if (!response) {
        this.finishMobileLocationRequest(data.location_request_id, {
          status: 'error',
          error: { code: 'location_invalid_result' },
        })
        return
      }
      this.finishMobileLocationRequest(data.location_request_id, response)
    })
    const respondMobileCalendar = (
      capability: MobileCalendarCapability,
      data: {
        session_id?: string
        calendar_request_id?: string
        reminder_request_id?: string
        status?: string
        result?: unknown
        error?: unknown
      },
    ) => {
      const requestId = capability === 'reminder' ? data.reminder_request_id : data.calendar_request_id
      const resolvedEvent = capability === 'reminder' ? 'reminder.resolved' : 'calendar.resolved'
      const idKey = capability === 'reminder' ? 'reminder_request_id' : 'calendar_request_id'
      if (!data.session_id || !requestId) return
      try {
        requireSocketSessionAccess(data.session_id)
      } catch (err) {
        socket.emit(resolvedEvent, {
          event: resolvedEvent,
          session_id: data.session_id,
          [idKey]: requestId,
          resolved: false,
          error: err instanceof Error ? err.message : String(err),
        })
        return
      }
      const pending = this.pendingMobileCalendar.get(requestId)
      if (!pending || pending.sessionId !== data.session_id || pending.request.capability !== capability) {
        this.emitToSession(socket, data.session_id, resolvedEvent, {
          event: resolvedEvent,
          [idKey]: requestId,
          resolved: false,
          stale: true,
          error: 'Calendar or reminder request is no longer pending.',
        })
        return
      }
      if (!sameMobileDevice(pending.target, socket.data.mobileDeviceTarget)) {
        socket.emit(resolvedEvent, { event: resolvedEvent, session_id: data.session_id, [idKey]: requestId, resolved: false, error: 'Response is not from the target device' })
        return
      }
      const response = normalizeMobileCalendarResponse(data, pending.request)
      if (!response) {
        this.finishMobileCalendarRequest(requestId, {
          status: 'error',
          error: { code: 'calendar_invalid_request' },
        })
        return
      }
      this.finishMobileCalendarRequest(requestId, response)
    }
    socket.on('calendar.respond', data => respondMobileCalendar('calendar', data))
    socket.on('reminder.respond', data => respondMobileCalendar('reminder', data))
    socket.on('health.respond', (data: {
      session_id?: string
      health_request_id?: string
      status?: string
      result?: unknown
      error?: unknown
    }) => {
      if (!data.session_id || !data.health_request_id) return
      try {
        requireSocketSessionAccess(data.session_id)
      } catch (err) {
        socket.emit('health.resolved', { event: 'health.resolved', session_id: data.session_id, health_request_id: data.health_request_id, resolved: false, error: err instanceof Error ? err.message : String(err) })
        return
      }
      const pending = this.pendingMobileHealth.get(data.health_request_id)
      if (!pending || pending.sessionId !== data.session_id) {
        this.emitToSession(socket, data.session_id, 'health.resolved', { event: 'health.resolved', health_request_id: data.health_request_id, resolved: false, stale: true, error: 'Health request is no longer pending.' })
        return
      }
      if (!sameMobileDevice(pending.target, socket.data.mobileDeviceTarget)) {
        socket.emit('health.resolved', { event: 'health.resolved', session_id: data.session_id, health_request_id: data.health_request_id, resolved: false, error: 'Response is not from the target device' })
        return
      }
      if (!mobileHealthResponseSourceMatches(data, pending.target.deviceCode)) {
        this.finishMobileHealthRequest(data.health_request_id, { status: 'error', error: { code: 'health_invalid_request' } })
        return
      }
      const response = normalizeMobileHealthResponse(data, pending.request)
      if (!response) {
        this.finishMobileHealthRequest(data.health_request_id, { status: 'error', error: { code: 'health_invalid_request' } })
        return
      }
      this.finishMobileHealthRequest(data.health_request_id, response)
    })
  }

  respondCodingAgentApproval(sessionId: string, approvalId: string, choice: string): boolean {
    return codingAgentRunManager.resolveApproval(sessionId, approvalId, choice).resolved
  }

  respondCodingAgentClarification(sessionId: string, clarifyId: string, response: string): boolean {
    const result = this.clarificationRuns.respond(sessionId, clarifyId, response)
    if (result.handled) return result.resolved
    return codingAgentRunManager.resolveClarification(sessionId, clarifyId, response).resolved
  }

  // --- Run dispatcher ---

  private async handleRun(
    socket: Socket,
    data: {
      input: string | ContentBlock[]
      display_input?: string | ContentBlock[] | null
      display_role?: 'user' | 'command'
      storage_message?: string
      session_id?: string
      model?: string
      provider?: string
      model_groups?: Array<{ provider: string; models: string[] }>
      instructions?: string
      group_system_prompt?: string
      group_room_id?: string
      group_agent_id?: string
      workflow_id?: string
      workflow_node_id?: string
      workspace?: string | null
      category_id?: number | null
      source?: string
      session_source?: 'global_agent' | 'workflow' | 'group_chat'
      memory_input?: string | ContentBlock[]
      memory_messages?: EkkoAgentRunSocketData['memory_messages']
      memory_write_policy?: 'automatic' | 'explicit-only'
      memory_origin?: EkkoAgentRunSocketData['memory_origin']
      memory_recall_scopes?: EkkoAgentRunSocketData['memory_recall_scopes']
      memory_write_scopes?: EkkoAgentRunSocketData['memory_write_scopes']
      memory_default_write_scope?: EkkoAgentRunSocketData['memory_default_write_scope']
      queue_id?: string
      peerExcludeSocketId?: string
      coding_agent_id?: ChatCodingAgentId
      agent_id?: ChatCodingAgentId
      mode?: 'scoped' | 'global'
      baseUrl?: string
      base_url?: string
      apiKey?: string
      api_key?: string
      apiMode?: string
      api_mode?: string
      mcpServers?: Record<string, unknown>
      mcp_servers?: Record<string, unknown>
      one_shot_model?: boolean
      allow_command_passthrough?: boolean
      reasoning_effort?: string
      push_enabled?: boolean
      background_delegation_enabled?: boolean
      context_compression_enabled?: boolean
      background_delegation_id?: string
      background_claim_id?: string
      autonomous?: boolean
      onEvent?: (event: string, payload: any) => void
    },
    profile: string,
    skipUserMessage = false,
    backgroundContinuationContext?: BackgroundContinuationContext,
    pushTargetId?: string,
  ) {
    const source = resolveRunSource(data.source, data.session_id)
    const surface = data.session_source || source
    if (data.session_id) getOrCreateSession(this.sessionMap, data.session_id).pushTargetId = pushTargetId
    if (data.session_id) {
      const target = socket.data?.mobileDeviceTarget as MobileDeviceTarget | undefined
      if (target && target.profile === profile && surface !== 'workflow' && surface !== 'group_chat' && !backgroundContinuationContext) {
        this.mobileRunTargets.set(data.session_id, { ...target })
      } else this.mobileRunTargets.delete(data.session_id)
    }
    const ekkoMcpServers = isEkkoAgentExecution(data)
      ? resolveChatEkkoMcpServers(profile, data.mcpServers || data.mcp_servers) || {}
      : undefined
    const mcpCapabilities = ekkoMcpServers
      ? studioMcpCapabilities(ekkoMcpServers)
      : isCodingAgentExecution(source, data)
        ? studioMcpCapabilities(getChatCodingAgentMcpServers(codingAgentId(data), profile))
        : await hermesStudioMcpCapabilities(profile)
    const mobileTarget = data.session_id ? this.mobileRunTargets.get(data.session_id) : undefined
    const mobileSessionId = mcpCapabilities.use && mobileTarget ? data.session_id : undefined
    const locationInstruction = mobileLocationRunInstruction(mobileSessionId, surface)
    if (locationInstruction) {
      data.instructions = [String(data.instructions || '').trim(), locationInstruction]
        .filter(Boolean)
        .join('\n\n')
    }
    const calendarInstruction = mobileCalendarRunInstruction(mobileSessionId, surface)
    if (calendarInstruction) {
      data.instructions = [String(data.instructions || '').trim(), calendarInstruction]
        .filter(Boolean)
        .join('\n\n')
    }
    const healthInstruction = mobileHealthRunInstruction(mobileTarget?.platform === 'ios' ? mobileSessionId : undefined, surface)
    if (healthInstruction) {
      data.instructions = [String(data.instructions || '').trim(), healthInstruction].filter(Boolean).join('\n\n')
    }
    if (data.session_id) {
      const state = getOrCreateSession(this.sessionMap, data.session_id)
      state.webhookAgent = webhookAgentForRun(data)
      state.webhookRoomId = data.group_room_id
      state.webhookWorkflowId = data.workflow_id
      state.webhookWorkflowNodeId = data.workflow_node_id
    }
    if (data.session_id && isBridgeRunSource(source) && isSessionCommand(data.input) && data.allow_command_passthrough !== true) return

    if (!isCodingAgentExecution(source, data)) {
      const bridgeReady = await ensureBridgeReadyForChatRun()
      if (!bridgeReady.ok) {
        let shouldDequeueNext = false
        let queueRemaining = 0
        if (data.session_id) {
          const state = this.sessionMap.get(data.session_id)
          queueRemaining = state?.queue?.length ?? 0
          const canReleaseCurrentRun = state && !state.runId && !state.abortController && !state.activeRunMarker
          if (canReleaseCurrentRun) {
            if (queueRemaining > 0) {
              const nextQueuedRun = state.queue[0]
              state.isWorking = true
              state.profile = nextQueuedRun?.profile || profile
              state.source = nextQueuedRun?.source
              shouldDequeueNext = true
            } else {
              state.isWorking = false
              state.profile = undefined
            }
          }
        }
        const payload: {
          event: 'run.failed'
          session_id?: string
          queue_id?: string
          error: string
          queue_remaining?: number
        } = {
          event: 'run.failed',
          session_id: data.session_id,
          queue_id: data.queue_id,
          error: bridgeReady.runtimeUnavailable
            ? `Hermes Runtime is unavailable: ${bridgeReady.error}`
            : `Agent Bridge is not reachable: ${bridgeReady.error}`,
        }
        if (data.session_id) {
          observeChatRunWebhookEvent({
            pushTargetId,
            event: 'run.failed',
            sessionId: data.session_id,
            profile,
            source,
            agent: webhookAgentForRun(data),
            payload,
            roomId: data.group_room_id,
            workflowId: data.workflow_id,
            workflowNodeId: data.workflow_node_id,
          })
        }
        if (queueRemaining > 0) payload.queue_remaining = queueRemaining
        socket.emit('run.failed', payload)
        if (data.session_id && data.background_delegation_id && data.background_claim_id) {
          void this.bridge.releaseBackgroundNotification(
            data.session_id,
            profile,
            data.background_delegation_id,
            data.background_claim_id,
          ).catch((err: unknown) => logger.warn(err, '[chat-run-socket] failed to release undelivered background notification'))
        }
        if (data.session_id && shouldDequeueNext) {
          this.dequeueNextQueuedRun(socket, data.session_id, profile)
        }
        return
      }

      const planContext = mcpCapabilities.interaction ? this.beginTaskPlanRun(data.session_id, profile) : undefined
      if (planContext) data.instructions = [data.instructions, taskPlanRunInstruction()].filter(Boolean).join('\n\n')
      let fullInstructions = data.instructions
        ? `${getSystemPrompt(undefined, { source, mcpCapabilities })}\n${data.instructions}`
        : getSystemPrompt(undefined, { source, mcpCapabilities })

      const onEvent = (event: string, payload: any) => {
        if (data.session_id) this.observeQueueInsertionRunEvent(data.session_id, event, payload)
        if (data.session_id) this.finishTaskPlanRun(data.session_id, event, payload, planContext)
        observeChatRunWebhookEvent({
          pushTargetId,
          event,
          sessionId: String(data.session_id || payload?.session_id || ''),
          profile,
          source,
          agent: 'bridge',
          payload,
          roomId: data.group_room_id,
          workflowId: data.workflow_id,
          workflowNodeId: data.workflow_node_id,
        })
        data.onEvent?.(event, payload)
        this.emitPendingInteraction(profile, event, payload)
      }
      try {
        await handleBridgeRun(
          this.nsp, socket, { ...data, task_plan_context_id: planContext, instructions: fullInstructions, onEvent }, profile,
          this.sessionMap, this.bridge,
          skipUserMessage,
          loadSessionStateFromDb,
          this.dequeueNextQueuedRun.bind(this),
          backgroundContinuationContext,
        )
      } catch (err) {
        if (data.session_id) this.finishTaskPlanRun(data.session_id, 'run.failed', undefined, planContext)
        throw err
      } finally {
        if (data.session_id) this.finishTaskPlanRun(data.session_id, 'run.completed', undefined, planContext)
      }
      return
    }

    if (isEkkoAgentExecution(data)) {
      const onEvent = (event: string, payload: any) => {
        if (data.session_id) this.observeQueueInsertionRunEvent(data.session_id, event, payload)
        observeChatRunWebhookEvent({
          pushTargetId,
          event,
          sessionId: String(data.session_id || payload?.session_id || ''),
          profile,
          source,
          agent: 'ekko',
          payload,
          roomId: data.group_room_id,
          workflowId: data.workflow_id,
          workflowNodeId: data.workflow_node_id,
        })
        data.onEvent?.(event, payload)
        this.emitPendingInteraction(profile, event, payload)
      }
      await handleEkkoAgentRun(
        this.nsp,
        socket,
        { ...data, onEvent, resolved_mcp_servers: ekkoMcpServers },
        profile,
        this.sessionMap,
        this.dequeueNextQueuedRun.bind(this),
        skipUserMessage,
        backgroundContinuationContext,
      )
      return
    }

    const isCommand = typeof data.input === 'string' && parseCodingAgentSessionCommand(data.input)
    const planContext = isCommand || !mcpCapabilities.interaction ? undefined : this.beginTaskPlanRun(data.session_id, profile)
    const interactionContext = planContext && source !== 'workflow' && data.session_source !== 'workflow'
      && source !== 'global_agent' && data.session_source !== 'global_agent' ? planContext : undefined
    if (interactionContext && data.session_id) {
      this.clarificationRuns.begin(interactionContext, data.session_id, profile, () => this.sessionMap.get(data.session_id!))
    }
    const instructions = planContext
      ? [data.instructions, taskPlanRunInstruction()].filter(Boolean).join('\n\n')
      : data.instructions
    let started: Awaited<ReturnType<typeof handleCodingAgentRun>>
    try {
      started = await handleCodingAgentRun(this.nsp, socket, { ...data, task_plan_context_id: planContext, interaction_context_id: interactionContext, instructions, studio_mcp_capabilities: mcpCapabilities }, profile, this.sessionMap)
      if (!started && planContext && data.session_id) this.finishTaskPlanRun(data.session_id, 'run.completed', undefined, planContext)
    } catch (err) {
      if (planContext && data.session_id) this.finishTaskPlanRun(data.session_id, 'run.failed', undefined, planContext)
      throw err
    }
    if (!started) return
    if (data.session_id) {
      const timestamp = Math.floor(Date.now() / 1000)
      const role = data.display_role === 'command' ? 'command' : 'user'
      const content = data.display_input === null
        ? data.storage_message || contentBlocksToString(data.input)
        : contentBlocksToString(data.display_input ?? data.input)
      const messageId = data.queue_id || started.messageId
      observeChatRunWebhookEvent({
        pushTargetId,
        event: 'message.created',
        sessionId: data.session_id,
        profile,
        source,
        agent: webhookAgentForRun(data),
        payload: {
          event: 'message.created',
          queue_id: data.queue_id,
          message_id: started.messageId,
          role,
          content,
          timestamp,
        },
        roomId: data.group_room_id,
        workflowId: data.workflow_id,
        workflowNodeId: data.workflow_node_id,
      })
      const peerTarget = data.peerExcludeSocketId
        ? this.nsp.to(`session:${data.session_id}`).except(data.peerExcludeSocketId)
        : socket.to(`session:${data.session_id}`)
      peerTarget.emit('run.peer_user_message', {
        event: 'run.peer_user_message',
        session_id: data.session_id,
        message: {
          id: messageId,
          role,
          content,
          timestamp,
          queued: false,
        },
      })
      observeChatRunWebhookEvent({
        pushTargetId,
        event: 'run.started',
        sessionId: data.session_id,
        profile,
        source,
        agent: webhookAgentForRun(data),
        payload: {
          event: 'run.started',
          run_id: started.runId,
          queue_id: data.queue_id,
        },
        roomId: data.group_room_id,
        workflowId: data.workflow_id,
        workflowNodeId: data.workflow_node_id,
      })
    }
  }

  private backgroundPendingCount(state: SessionState): number {
    const delegations = Object.values(state.backgroundDelegations || {})
      .filter(item => item.status === 'running' || item.status === 'delivering')
      .length
    if (delegations > 0) return delegations
    return Object.values(state.backgroundTasks || {})
      .filter(task => task.status === 'running')
      .length
  }

  private async sessionStateForBackground(sessionId: string): Promise<SessionState | null> {
    const existing = this.sessionMap.get(sessionId)
    if (existing) return existing
    if (!getSession(sessionId)) return null
    const loaded = await loadSessionStateFromDb(sessionId, this.sessionMap)
    this.sessionMap.set(sessionId, loaded)
    return loaded
  }

  private applyBackgroundSessionPoll(poll: AgentBridgeBackgroundSession, state: SessionState) {
    if ((poll.events?.length || 0) > 0 || poll.running_count > 0) {
      this.backgroundActivityGraceUntil = Date.now() + 30_000
    }
    state.backgroundTasks = state.backgroundTasks || {}
    for (const task of poll.tasks || []) {
      const subagentId = String(task.subagent_id || '').trim()
      if (subagentId) state.backgroundTasks[subagentId] = { ...task }
    }
    for (const rawEvent of poll.events || []) {
      const event = String(rawEvent.event || '')
      if (!event.startsWith('subagent.')) continue
      this.emitExternalEvent(poll.session_id, event, {
        ...rawEvent,
        event,
        profile: poll.profile,
        background: true,
      })
    }
  }

  private socketForBackgroundRun(sessionId: string): Socket {
    const room = this.nsp.adapter.rooms.get(`session:${sessionId}`)
    if (room) {
      for (const socketId of room) {
        const socket = this.nsp.sockets.get(socketId)
        if (socket) return socket
      }
    }
    return {
      id: `background-run-${sessionId}`,
      connected: false,
      data: {},
      join: () => {},
      emit: (event: string, payload: any) => this.nsp.to(`session:${sessionId}`).emit(event, payload),
      to: (roomName: string) => ({
        emit: (event: string, payload: any) => this.nsp.to(roomName).emit(event, payload),
      }),
    } as unknown as Socket
  }

  private async scheduleBackgroundNotification(notification: AgentBridgeBackgroundNotification) {
    const sessionId = String(notification.session_id || '').trim()
    const delegationId = String(notification.delegation_id || '').trim()
    const claimId = String(notification.claim_id || '').trim()
    if (!sessionId || !delegationId || !claimId || !notification.message) return

    const releaseClaim = () => this.backgroundBridge.releaseBackgroundNotification(
      sessionId,
      notification.profile,
      delegationId,
      claimId,
    )
    if (this.closing) {
      await releaseClaim()
      return
    }

    const session = getSession(sessionId)
    if (!session) {
      logger.warn('[chat-run-socket] acknowledging orphaned background delegation %s for missing session %s', delegationId, sessionId)
      await this.backgroundBridge.completeBackgroundNotification(
        sessionId,
        notification.profile,
        delegationId,
        claimId,
      )
      return
    }

    const state = await this.sessionStateForBackground(sessionId)
    if (!state) {
      await releaseClaim()
      return
    }
    if (this.closing) {
      await releaseClaim()
      return
    }
    state.backgroundDelegations = state.backgroundDelegations || {}
    persistHermesBackgroundResult(
      sessionId,
      state,
      delegationId,
      notification.event || {},
    )
    const previousDelegation = state.backgroundDelegations[delegationId]
    state.backgroundDelegations[delegationId] = {
      ...previousDelegation,
      delegationId,
      status: 'delivering',
      profile: notification.profile,
      updatedAt: Date.now(),
    }
    this.emitExternalEvent(sessionId, 'delegation.updated', {
      event: 'delegation.updated',
      profile: notification.profile,
      delegation_id: delegationId,
      status: notification.status || 'completed',
      delivery_status: 'delivering',
      background_pending: this.backgroundPendingCount(state),
    })

    const next: QueuedRun = {
      queue_id: `delegation_${delegationId}`,
      input: notification.message,
      displayInput: null,
      storageMessage: notification.message,
      model: session.model || undefined,
      provider: session.provider || undefined,
      profile: notification.profile || session.profile || 'default',
      workspace: session.workspace,
      source: resolveRunSource(session.source || undefined, sessionId),
      backgroundDelegationId: delegationId,
      backgroundClaimId: claimId,
      autonomous: true,
    }

    if (state.isWorking) {
      state.queue.push(next)
      logger.info('[chat-run-socket] queued background delegation %s for busy session %s', delegationId, sessionId)
      return
    }

    state.isWorking = true
    state.profile = next.profile
    state.source = next.source
    this.runQueuedItem(this.socketForBackgroundRun(sessionId), sessionId, next, next.profile)
  }

  private needsBackgroundPoll(): boolean {
    if (this.closing) return false
    if (this.backgroundRecoveryNeeded) return true
    if (Date.now() < this.backgroundActivityGraceUntil) return true
    for (const state of this.sessionMap.values()) {
      if (Object.values(state.backgroundDelegations || {})
        .some(item => item.status === 'running' || item.status === 'delivering')) return true
      if (Object.values(state.backgroundTasks || {})
        .some(task => task.status === 'running' && task.runtime !== 'ekko')) return true
    }
    return false
  }

  private backgroundRecoveryRoutes() {
    const cutoff = Math.floor(Date.now() / 1000) - 8 * 24 * 60 * 60
    const sessionsByProfile = new Map<string, string[]>()
    for (const session of listSessions(undefined, undefined, 10_000)) {
      if (session.last_active < cutoff) continue
      if (!isHermesWorkerBackedSession(session)) continue
      const profile = session.profile || 'default'
      const ids = sessionsByProfile.get(profile) || []
      ids.push(session.id)
      sessionsByProfile.set(profile, ids)
    }
    return [...sessionsByProfile.entries()].map(([profile, session_ids]) => ({ profile, session_ids }))
  }

  private async pollBackgroundWork() {
    if (this.closing || this.backgroundPollInFlight || Date.now() < this.backgroundPollRetryAt || !this.needsBackgroundPoll()) return
    this.backgroundPollInFlight = true
    try {
      const recovering = this.backgroundRecoveryNeeded
      const routes = recovering ? this.backgroundRecoveryRoutes() : undefined
      const result = await this.backgroundBridge.backgroundPoll(routes, { timeoutMs: recovering ? 120_000 : 1000 })
      if (this.closing) {
        await Promise.allSettled((result.notifications || []).map((notification: any) => (
          this.backgroundBridge.releaseBackgroundNotification(
            notification.session_id,
            notification.profile,
            notification.delegation_id,
            notification.claim_id,
          )
        )))
        return
      }
      const brokerChanged = Boolean(this.backgroundBrokerId && result.broker_id && result.broker_id !== this.backgroundBrokerId)
      if (result.broker_id) this.backgroundBrokerId = result.broker_id
      this.backgroundRecoveryNeeded = brokerChanged && !recovering
      this.backgroundPollRetryAt = 0
      if ((result.pending_count || 0) > 0) {
        this.backgroundActivityGraceUntil = Date.now() + 310_000
      }
      for (const poll of result.sessions || []) {
        const sessionId = String(poll.session_id || '').trim()
        if (!sessionId) continue
        const state = await this.sessionStateForBackground(sessionId)
        if (state) this.applyBackgroundSessionPoll(poll, state)
      }
      for (const notification of result.notifications || []) {
        await this.scheduleBackgroundNotification(notification)
      }
    } catch (err) {
      this.backgroundPollRetryAt = Date.now() + 5000
      logger.debug(err, '[chat-run-socket] background bridge poll unavailable')
    } finally {
      this.backgroundPollInFlight = false
    }
  }

  // --- Resume ---

  private async resumeSession(
    socket: Socket,
    sid: string,
    options?: { event: 'app.resumed'; cachedId: string },
  ) {
    let state = this.sessionMap.get(sid)
    if (!state) {
      state = await loadSessionStateFromDb(sid, this.sessionMap)
      this.sessionMap.set(sid, state)
    }
    await this.reattachBridgeRun(socket, sid, state)
    const resumeEvents = state.isWorking
      ? state.events
      : (state.events || []).filter(evt => evt?.event === 'run.reattach_failed')
    const sessionDetail = getSessionMetadata(sid)
    const messagePage = buildResumeMessagePage(state.messages, {
      limit: state.messagePageLimit,
      messageTotal: state.messageTotal,
      messageStateBaselineCount: state.messageStateBaselineCount,
    })
    const workspaceRunChanges = listWorkspaceRunChangesForAssistantMessages(
      sid,
      messagePage.messages
        .filter(message => String(message.display_role || message.role || '') === 'assistant')
        .map(message => message.id),
    )
    const taskPlans = getSessionTaskPlans(sid, messagePage.messages, true, state.runId)
    const resumePage = { ...messagePage, workspaceRunChanges, taskPlans }
    const appMessagePage = options
      ? buildAppResumeMessagePage(resumePage, options.cachedId)
      : null
    const outboundMessagePage = appMessagePage || resumePage
    socket.emit(options?.event || 'resumed', {
      session_id: sid,
      ...outboundMessagePage,
      taskPlans,
      parentSessionId: sessionDetail?.parent_session_id || null,
      forkPointMessageId: sessionDetail?.fork_point_message_id || null,
      parentTitle: socket.data?.sessionShare ? null : sessionDetail?.parent_title || null,
      parentLastMessage: socket.data?.sessionShare ? null : sessionDetail?.parent_last_message || null,
      parentLastMessageRole: socket.data?.sessionShare ? null : sessionDetail?.parent_last_message_role || null,
      workspace: sessionDetail?.workspace || null,
      model: sessionDetail?.model || '',
      provider: sessionDetail?.provider || '',
      api_mode: sessionDetail?.api_mode || '',
      reasoning_effort: sessionDetail?.reasoning_effort || '',
      push_enabled: Number(sessionDetail?.push_enabled || 0) !== 0,
      isWorking: state.isWorking,
      runStartedAt: state.runStartedAt,
      isAborting: state.isAborting || false,
      events: buildResumeEvents(resumeEvents.filter(entry =>
        !['calendar.requested', 'reminder.requested', 'calendar.resolved', 'reminder.resolved', 'health.requested', 'health.resolved'].includes(entry.event)
        || mobileEventAllowed(entry.data, socket.data.mobileDeviceTarget))),
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      contextTokens: state.contextTokens,
      queueLength: state.queue?.length || 0,
      queueMessages: this.serializeQueuedMessages(state.queue || []),
      queueInsertion: state.queueInsertion ? {
        generation: state.queueInsertion.generation,
        run_id: state.queueInsertion.runId,
        queue_id: state.queueInsertion.queueId,
        runtime: state.queueInsertion.runtime,
        phase: state.queueInsertion.phase,
        guarantee: state.queueInsertion.guarantee,
        requested_at: state.queueInsertion.requestedAt,
      } : null,
      backgroundTasks: Object.values(state.backgroundTasks || {}),
      backgroundPending: this.backgroundPendingCount(state),
    })

    logger.info('[chat-run-socket] socket %s resumed session %s (working: %s, messages: %d, app cache: %s)',
      socket.id, sid, state.isWorking, state.messages.length,
      appMessagePage ? (appMessagePage.messagesCached ? 'hit' : 'miss') : 'n/a')
  }

  private async reattachBridgeRun(socket: Socket, sid: string, state: SessionState) {
    if (state.runId && state.isWorking) return
    const session = getSession(sid)
    const source = state.source || session?.source
    if (!isHermesWorkerBackedSession({ source, agent: session?.agent, agent_session_id: session?.agent_session_id })) return
    const profile = session?.profile || currentProfileFromSocket(socket)
    let pollKey: string | undefined
    try {
      const status = await this.bridge.statusIfLoaded(sid, profile, { timeoutMs: 1000 }) as Record<string, unknown>
      const running = status.running === true
      const runId = typeof status.current_run_id === 'string' ? status.current_run_id : ''
      if (!running || !runId) return
      pollKey = `${sid}:${runId}`
      if (this.bridgeResumePolls.has(pollKey)) return
      this.bridgeResumePolls.add(pollKey)
      if (!state.isWorking || !(state.runStartedAt && state.runStartedAt > 0)) {
        // The bridge does not expose the original start in its lightweight
        // status response. Use one shared server-side fallback for every
        // client attaching after this Web UI process discovers the run.
        state.runStartedAt = Date.now()
      }
      state.isWorking = true
      state.isAborting = state.isAborting === true
      state.runId = runId
      state.activeRunMarker = undefined
      state.profile = profile
      state.source = source === 'global_agent'
        ? 'global_agent'
        : source === 'group_chat'
          ? 'group_chat'
        : source === 'workflow'
          ? 'workflow'
          : 'cli'
      state.events = []
      const instructions = this.resumeInstructionsForSession(sid)
      void resumeBridgeRun(
        this.nsp,
        socket,
        {
          sessionId: sid,
          runId,
          profile,
          instructions,
          model: session?.model,
          provider: session?.provider,
          workspace: session?.workspace,
          source,
          onEvent: (event, payload) => {
            this.observeQueueInsertionRunEvent(sid, event, payload)
            this.finishTaskPlanRun(sid, event, payload)
            observeChatRunWebhookEvent({
              event,
              sessionId: sid,
              profile,
              source: String(source || 'cli'),
              agent: 'bridge',
              payload,
            })
          },
        },
        this.sessionMap,
        this.bridge,
        this.dequeueNextQueuedRun.bind(this),
      ).finally(() => {
        if (pollKey) this.bridgeResumePolls.delete(pollKey!)
      })
      logger.info('[chat-run-socket] reattached running bridge run %s for session %s', runId, sid)
    } catch (err) {
      if (pollKey) this.bridgeResumePolls.delete(pollKey)
      if (isBridgeStatusLookupTimeout(err)) {
        logger.debug(err, '[chat-run-socket] bridge status lookup timed out while resuming session %s', sid)
        return
      }
      logger.warn(err, '[chat-run-socket] bridge status lookup failed while resuming session %s', sid)
      const endpoint = getAgentBridgeManager().getRuntimeState?.().endpoint
      const error = redactBridgeReadyError(err instanceof Error ? err.message : String(err), endpoint)
      const payload = {
        event: 'run.reattach_failed',
        session_id: sid,
        error,
        message: `Unable to confirm Agent Bridge status while resuming: ${error}`,
        text: `Unable to confirm Agent Bridge status while resuming: ${error}`,
      }
      const nextEvents = [...(state.events || [])]
      const lastEvent = nextEvents[nextEvents.length - 1]
      if (lastEvent?.event !== 'run.reattach_failed' || lastEvent?.data?.error !== error) {
        nextEvents.push({ event: 'run.reattach_failed', data: payload })
        state.events = nextEvents
      }
      this.emitToSession(socket, sid, 'run.reattach_failed', payload)
    }
  }

  private resumeInstructionsForSession(sessionId: string): string {
    const sessionRow = getSession(sessionId)
    return getSystemPrompt(undefined, { source: sessionRow?.source })
  }

  // --- Queue insertion ---

  private isQueueInsertionCandidate(item: QueuedRun): boolean {
    return item.displayInput !== null
      && item.goalContinuation !== true
      && !item.backgroundDelegationId
      && item.autonomous !== true
  }

  private queueInsertionRuntime(sessionId: string, state: SessionState): QueueInsertionRuntime | null {
    const storedAgent = String(getSession(sessionId)?.agent || '').trim()
    const activeAgent = state.webhookAgent
      || (storedAgent === 'ekko-agent' ? 'ekko' : storedAgent === 'claude' ? 'claude-code' : storedAgent === 'codex' ? 'codex' : storedAgent === 'pi' ? 'pi' : storedAgent === 'grok' ? 'grok' : storedAgent === 'dsh' ? 'dsh' : storedAgent === 'opencode' ? 'opencode' : 'bridge')
    if (activeAgent === 'ekko') return 'ekko'
    if (activeAgent === 'claude-code' || activeAgent === 'codex' || activeAgent === 'pi' || activeAgent === 'grok' || (activeAgent === 'opencode' || activeAgent === 'dsh')) return activeAgent
    if (activeAgent !== 'bridge') return null
    if (state.source === 'coding_agent') return null
    return state.source === 'cli' || state.source === 'global_agent' ? 'hermes' : null
  }

  private emitQueueInsertionUpdate(
    sessionId: string,
    control: QueueInsertionControl,
    phase: QueueInsertionPhase | 'cancelled' = control.phase,
    reason?: string,
  ) {
    this.nsp.to(`session:${sessionId}`).emit('run.queue_insertion.updated', {
      event: 'run.queue_insertion.updated',
      session_id: sessionId,
      generation: control.generation,
      run_id: control.runId,
      queue_id: control.queueId,
      runtime: control.runtime,
      phase,
      guarantee: control.guarantee,
      requested_at: control.requestedAt,
      ...(reason ? { reason } : {}),
    })
  }

  private clearQueueInsertion(sessionId: string, state: SessionState, reason: string) {
    const control = state.queueInsertion
    if (!control) return
    state.queueInsertion = undefined
    this.emitQueueInsertionUpdate(sessionId, control, 'cancelled', reason)
  }

  private emitQueuedRunSnapshot(sessionId: string, state: SessionState) {
    this.nsp.to(`session:${sessionId}`).emit('run.queued', {
      event: 'run.queued',
      session_id: sessionId,
      queue_length: state.queue.length,
      queued_messages: this.serializeQueuedMessages(state.queue),
    })
  }

  private async requestQueuedRunInsertion(sessionId: string, queueId: string) {
    const state = this.sessionMap.get(sessionId)
    if (!state?.isWorking) return
    const selectedIndex = state.queue.findIndex(item => item.queue_id === queueId && this.isQueueInsertionCandidate(item))
    if (selectedIndex < 0) return

    if (state.queueInsertion) {
      this.emitQueueInsertionUpdate(sessionId, state.queueInsertion)
      return
    }

    const runtime = this.queueInsertionRuntime(sessionId, state)
    if (!runtime) return

    if (selectedIndex > 0) {
      const [selected] = state.queue.splice(selectedIndex, 1)
      state.queue.unshift(selected)
      this.emitQueuedRunSnapshot(sessionId, state)
    }

    const control: QueueInsertionControl = {
      generation: randomUUID(),
      queueId,
      runId: state.runId,
      runtime,
      phase: 'requesting',
      guarantee: runtime === 'hermes' || runtime === 'ekko' ? 'strict' : 'immediate',
      requestedAt: Date.now(),
    }
    state.queueInsertion = control
    this.emitQueueInsertionUpdate(sessionId, control)
    logger.info({ sessionId, queueId, runtime, runId: control.runId }, '[chat-run-socket] queue insertion requested')

    if (control.runId) {
      await this.activateQueueInsertion(sessionId, control.generation)
    }
  }

  private async activateQueueInsertion(sessionId: string, generation: string) {
    const state = this.sessionMap.get(sessionId)
    const control = state?.queueInsertion
    if (!state || !control || control.generation !== generation || control.phase !== 'requesting' || !control.runId) return

    try {
      if (control.runtime === 'claude-code' || control.runtime === 'codex' || control.runtime === 'pi' || control.runtime === 'grok' || (control.runtime === 'opencode' || control.runtime === 'dsh')) {
        control.phase = 'stopping_current_turn'
        this.emitQueueInsertionUpdate(sessionId, control)
        const result = await codingAgentRunManager.interruptForQueueInsertion(sessionId, control.runId)
        if (result.status !== 'interrupted') {
          const currentState = this.sessionMap.get(sessionId)
          if (currentState?.queueInsertion?.generation === generation) {
            this.clearQueueInsertion(sessionId, currentState, result.status)
          }
        }
        return
      }

      const result = control.runtime === 'ekko'
        ? getGlobalEkkoAgent(state.profile || 'default').requestBoundaryInterrupt({
            sessionId,
            expectedRunId: control.runId,
          })
        : await this.bridge.requestBoundaryInterrupt(sessionId, control.runId, state.profile)

      const current = this.sessionMap.get(sessionId)?.queueInsertion
      if (!current || current.generation !== generation) return
      if (result.status !== 'accepted' && result.status !== 'already_pending') {
        this.clearQueueInsertion(sessionId, state, result.status === 'unsupported'
          ? String('reason' in result && result.reason ? result.reason : 'runtime_unsupported')
          : result.status)
        return
      }

      current.phase = result.phase === 'tool_batch'
        ? 'waiting_for_tool_batch'
        : 'stopping_current_turn'
      this.emitQueueInsertionUpdate(sessionId, current)
      logger.info({
        sessionId,
        queueId: current.queueId,
        runtime: current.runtime,
        runId: current.runId,
        phase: current.phase,
      }, '[chat-run-socket] queue insertion armed')
    } catch (err) {
      const currentState = this.sessionMap.get(sessionId)
      if (currentState?.queueInsertion?.generation !== generation) return
      const reason = err instanceof Error ? err.message : String(err)
      this.clearQueueInsertion(sessionId, currentState, reason)
      logger.warn(err, '[chat-run-socket] failed to request queue insertion for session %s', sessionId)
    }
  }

  private observeQueueInsertionRunEvent(sessionId: string, event: string, payload: any) {
    const state = this.sessionMap.get(sessionId)
    const control = state?.queueInsertion
    if (!state || !control) return

    if (event === 'run.started') {
      const runId = typeof payload?.run_id === 'string' ? payload.run_id : ''
      if (!runId || control.phase !== 'requesting') return
      if (control.runId && control.runId !== runId) return
      control.runId = runId
      this.emitQueueInsertionUpdate(sessionId, control)
      void this.activateQueueInsertion(sessionId, control.generation)
      return
    }

    if (event !== 'run.completed' && event !== 'run.failed') return
    const runId = typeof payload?.run_id === 'string' ? payload.run_id : ''
    if (control.runId && runId && control.runId !== runId) return
    if (control.phase !== 'requesting') {
      payload.interrupted = true
      payload.stop_reason = 'queue_insertion'
      if (control.guarantee === 'strict') payload.boundary_guarantee = 'strict'
      else payload.interruption_mode = 'immediate'
    }
    if (state.queue.length === 0) this.clearQueueInsertion(sessionId, state, 'queue_empty')
  }

  // --- Queue ---

  private dequeueNextQueuedRun(socket: Socket, sessionId: string, fallbackProfile = 'default') {
    const state = this.sessionMap.get(sessionId)
    if (!state?.queue.length) return false

    const next = state.queue.shift()!
    if (state.queueInsertion) {
      state.queueInsertion.phase = 'starting_queued_message'
      state.queueInsertion.queueId = next.queue_id
      this.emitQueueInsertionUpdate(sessionId, state.queueInsertion)
      state.queueInsertion = undefined
    }
    state.isWorking = true
    state.profile = next.profile || fallbackProfile
    state.source = next.source
    logger.info('[chat-run-socket] dequeuing queued run for session %s (remaining: %d)', sessionId, state.queue.length)
    this.nsp.to(`session:${sessionId}`).emit('run.queued', {
      event: 'run.queued',
      session_id: sessionId,
      queue_length: state.queue.length,
      dequeued_queue_id: next.queue_id,
      queued_messages: this.serializeQueuedMessages(state.queue),
    })
    this.runQueuedItem(socket, sessionId, next, fallbackProfile)
    return true
  }

  private runQueuedItem(socket: Socket, sessionId: string, next: QueuedRun, fallbackProfile = 'default') {
    if (next.authorize) {
      const authorize = next.authorize
      void authorize().then(() => this.runQueuedItem(socket, sessionId, { ...next, authorize: undefined }, fallbackProfile)).catch(() => {
        const state = this.sessionMap.get(sessionId)
        if (state) state.isWorking = false
        this.nsp.to(`session:${sessionId}`).emit('run.failed', { event: 'run.failed', session_id: sessionId, queue_id: next.queue_id, error: 'share_access_denied' })
        this.dequeueNextQueuedRun(socket, sessionId, fallbackProfile)
      })
      return
    }
    const state = this.sessionMap.get(sessionId)
    if (state) state.runStartedAt = Date.now()
    const skipUserMessage = next.displayInput === null
    const backgroundContinuationContext = next.backgroundContinuationContext
      || (next.backgroundDelegationId
        ? this.sessionMap.get(sessionId)?.backgroundContinuationContexts?.[next.backgroundDelegationId]
        : undefined)
    const runProfile = backgroundContinuationContext?.runtime === 'hermes'
      ? backgroundContinuationContext.profile
      : next.profile || fallbackProfile
    void this.handleRun(socket, {
      input: next.input,
      display_input: next.displayInput,
      display_role: next.displayRole,
      storage_message: next.storageMessage,
      session_id: sessionId,
      model: next.model,
      provider: next.provider,
      model_groups: next.model_groups,
      instructions: next.instructions,
      group_system_prompt: next.groupSystemPrompt,
      group_room_id: next.groupRoomId,
      group_agent_id: next.groupAgentId,
      workflow_id: next.workflowId,
      workflow_node_id: next.workflowNodeId,
      workspace: next.workspace,
      source: next.source,
      session_source: next.sessionSource,
      queue_id: next.queue_id,
      peerExcludeSocketId: next.originSocketId,
      coding_agent_id: next.codingAgentId,
      agent_id: next.agentId,
      mode: next.mode,
      baseUrl: next.baseUrl,
      base_url: next.base_url,
      apiKey: next.apiKey,
      api_key: next.api_key,
      apiMode: next.apiMode,
      api_mode: next.api_mode,
      mcpServers: next.mcpServers,
      mcp_servers: next.mcp_servers,
      one_shot_model: next.oneShotModel,
      allow_command_passthrough: next.commandPassthrough,
      reasoning_effort: next.reasoningEffort,
      background_delegation_id: next.backgroundDelegationId,
      background_claim_id: next.backgroundClaimId,
      autonomous: next.autonomous,
    }, runProfile, skipUserMessage, backgroundContinuationContext, next.pushTargetId)
  }

  // --- Helpers ---

  async runAndWait(
    data: {
      input: string | ContentBlock[]
      display_input?: string | ContentBlock[] | null
      display_role?: 'user' | 'command'
      storage_message?: string
      session_id: string
      model?: string
      provider?: string
      model_groups?: Array<{ provider: string; models: string[] }>
      instructions?: string
      group_system_prompt?: string
      group_room_id?: string
      group_agent_id?: string
      workflow_id?: string
      workflow_node_id?: string
      workspace?: string | null
      source?: string
      session_source?: 'global_agent' | 'workflow' | 'group_chat'
      memory_input?: string | ContentBlock[]
      memory_messages?: EkkoAgentRunSocketData['memory_messages']
      memory_write_policy?: 'automatic' | 'explicit-only'
      memory_origin?: EkkoAgentRunSocketData['memory_origin']
      memory_recall_scopes?: EkkoAgentRunSocketData['memory_recall_scopes']
      memory_write_scopes?: EkkoAgentRunSocketData['memory_write_scopes']
      memory_default_write_scope?: EkkoAgentRunSocketData['memory_default_write_scope']
      queue_id?: string
      coding_agent_id?: ChatCodingAgentId
      agent_id?: ChatCodingAgentId
      mode?: 'scoped' | 'global'
      baseUrl?: string
      base_url?: string
      apiKey?: string
      api_key?: string
      apiMode?: string
      api_mode?: string
      mcpServers?: Record<string, unknown>
      mcp_servers?: Record<string, unknown>
      profile?: string
      reasoning_effort?: string
      /** Hermes Agent creation policy used by internal orchestration callers. */
      background_delegation_enabled?: boolean
      context_compression_enabled?: boolean
      one_shot_model?: boolean
    },
    options: {
      profile?: string
      user?: AuthenticatedUser
      timeoutMs?: number
      approvalChoice?: ChatRunAutoApprovalChoice
      pushRoot?: PushRunRef
      onEvent?: (event: string, payload: any) => void
    } = {},
  ): Promise<ChatRunAndWaitResult> {
    const sessionId = String(data.session_id || '').trim()
    if (!sessionId) throw new Error('session_id is required')
    const profile = options.profile || data.profile || getSession(sessionId)?.profile || getActiveProfileName() || 'default'
    const source = resolveRunSource(data.source, sessionId)
    const pushTargetId = options.pushRoot ? getRunPushTarget(options.pushRoot)?.id : undefined
    const state = getOrCreateSession(this.sessionMap, sessionId)
    state.events = []
    state.isWorking = !isCodingAgentExecution(source, data)
    state.runStartedAt = Date.now()
    state.profile = profile
    state.source = source

    return new Promise<ChatRunAndWaitResult>((resolve) => {
      let settled = false
      let output = ''
      let reasoning = ''
      let runId = ''
      const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : null
      const waiters = this.runWaiters.get(sessionId) || new Set<(event: string, payload: any) => void>()
      const finish = (result: Omit<ChatRunAndWaitResult, 'session_id'>) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        waiters.delete(onEvent)
        if (waiters.size === 0) this.runWaiters.delete(sessionId)
        resolve({
          session_id: sessionId,
          run_id: runId || result.run_id,
          output: output || result.output,
          reasoning: reasoning || result.reasoning,
          ...result,
        })
      }
      const respondToApproval = async (payload: any = {}) => {
        const choice = options.approvalChoice
        if (!choice || settled) return
        const approvalId = typeof payload.approval_id === 'string' ? payload.approval_id : ''
        const rawChoices = Array.isArray(payload.choices) ? payload.choices.map((item: unknown) => String(item)) : []
        const choices = rawChoices.length > 0 ? rawChoices : ['once', 'session', 'deny']
        if (!approvalId) {
          finish({ ok: false, event: 'run.failed', output, reasoning, error: 'approval required' })
          return
        }
        if (!choices.includes(choice)) {
          finish({ ok: false, event: 'run.failed', output, reasoning, error: `approval choice "${choice}" is not available` })
          return
        }
        try {
          const codingAgentResult = codingAgentRunManager.resolveApproval(sessionId, approvalId, choice)
          const result = codingAgentResult.handled
            ? codingAgentResult
            : await this.bridge.approvalRespond(approvalId, choice)
          const resolvedPayload = {
            event: 'approval.resolved',
            session_id: sessionId,
            approval_id: approvalId,
            choice,
            resolved: Boolean((result as any)?.resolved),
          }
          observeChatRunWebhookEvent({
            event: 'approval.resolved',
            pushTargetId,
            sessionId,
            profile,
            source,
            agent: webhookAgentForRun(data),
            payload: resolvedPayload,
            roomId: data.group_room_id,
            workflowId: data.workflow_id,
            workflowNodeId: data.workflow_node_id,
          })
          this.nsp.to(`session:${sessionId}`).emit('approval.resolved', resolvedPayload)
          onEvent('approval.resolved', resolvedPayload)
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err)
          this.nsp.to(`session:${sessionId}`).emit('approval.resolved', {
            event: 'approval.resolved',
            session_id: sessionId,
            approval_id: approvalId,
            choice,
            resolved: false,
            error,
          })
          finish({ ok: false, event: 'run.failed', output, reasoning, error })
        }
      }
      const onEvent = (event: string, payload: any = {}) => {
        if (typeof payload.run_id === 'string' && payload.run_id) runId = payload.run_id
        if (event === 'message.delta' && typeof payload.delta === 'string') output += payload.delta
        if ((event === 'reasoning.delta' || event === 'thinking.delta') && typeof payload.delta === 'string') reasoning += payload.delta
        try {
          options.onEvent?.(event, payload)
        } catch (err) {
          logger.warn(err, '[chat-run-socket] runAndWait event observer failed for session %s', sessionId)
        }
        if (event === 'approval.requested') {
          void respondToApproval(payload)
        } else if (event === 'run.completed') {
          finish({
            ok: true,
            event: 'run.completed',
            run_id: payload.run_id,
            output: typeof payload.output === 'string' && payload.output ? payload.output : output,
            reasoning: typeof payload.reasoning === 'string' && payload.reasoning ? payload.reasoning : reasoning,
          })
        } else if (event === 'run.failed') {
          finish({
            ok: false,
            event: 'run.failed',
            run_id: payload.run_id,
            output,
            reasoning,
            error: payload.error ? String(payload.error) : 'chat-run failed',
          })
        }
      }
      const timer = timeoutMs
        ? setTimeout(() => {
            const error = `chat-run timed out after ${timeoutMs}ms`
            finish({ ok: false, event: 'run.failed', error })
            void this.abortSession(sessionId, error).catch(err => {
              logger.warn(err, '[chat-run-socket] failed to abort timed-out session %s', sessionId)
            })
          }, timeoutMs)
        : null
      waiters.add(onEvent)
      this.runWaiters.set(sessionId, waiters)

      const fakeSocket = {
        id: `workflow-run-${sessionId}`,
        connected: true,
        data: { user: options.user },
        join: () => {},
        to: (room: string) => ({
          emit: (event: string, payload: any) => {
            this.nsp.to(room).emit(event, payload)
            onEvent(event, payload)
          },
        }),
        emit: (event: string, payload: any) => onEvent(event, payload),
      } as unknown as Socket

      this.handleRun(fakeSocket, { ...data, onEvent }, profile, false, undefined, pushTargetId)
        .catch(err => {
          const error = err instanceof Error ? err.message : String(err)
          const payload = { event: 'run.failed', session_id: sessionId, error }
          observeChatRunWebhookEvent({
            event: 'run.failed',
            pushTargetId,
            sessionId,
            profile,
            source,
            agent: webhookAgentForRun(data),
            payload,
            roomId: data.group_room_id,
            workflowId: data.workflow_id,
            workflowNodeId: data.workflow_node_id,
          })
          finish({ ok: false, event: 'run.failed', error })
        })
    })
  }

  async abortSession(sessionId: string, reason = 'Run canceled'): Promise<void> {
    const sid = String(sessionId || '').trim()
    if (!sid) return
    this.mobileRunTargets.delete(sid)
    const fakeSocket = {
      id: `workflow-abort-${sid}`,
      connected: false,
      data: {},
      emit: () => {},
      join: () => {},
      to: (room: string) => ({ emit: (event: string, payload: any) => this.nsp.to(room).emit(event, payload) }),
    } as unknown as Socket
    this.finishTaskPlanRun(sid, 'abort.completed')
    await handleAbort(
      this.nsp,
      fakeSocket,
      sid,
      this.sessionMap,
      this.bridge,
      this.runQueuedItem.bind(this),
    )
    this.emitExternalEvent(sid, 'run.failed', {
      event: 'run.failed',
      error: reason,
    })
  }

  async disposeSession(sessionId: string): Promise<void> {
    const sid = String(sessionId || '').trim()
    if (!sid) return
    for (const [requestId, pending] of this.pendingMobileLocations.entries()) {
      if (pending.sessionId !== sid) continue
      this.finishMobileLocationRequest(requestId, {
        status: 'error',
        error: { code: 'location_failed' },
      })
    }
    for (const [requestId, pending] of this.pendingMobileCalendar.entries()) {
      if (pending.sessionId !== sid) continue
      this.finishMobileCalendarRequest(requestId, {
        status: 'error',
        error: { code: 'calendar_failed' },
      })
    }
    for (const [requestId, pending] of this.pendingMobileHealth.entries()) {
      if (pending.sessionId !== sid) continue
      this.finishMobileHealthRequest(requestId, { status: 'error', error: { code: 'health_failed' } })
    }
    codingAgentRunManager.stop(sid, { reportClosed: false })
    const state = this.sessionMap.get(sid)
    this.finishTaskPlanRun(sid, 'abort.completed')
    state?.abortController?.abort()
    this.sessionMap.delete(sid)
    this.runWaiters.delete(sid)
    deleteSession(sid)
  }

  emitExternalEvent(sessionId: string, event: string, payload: any) {
    this.finishTaskPlanRun(sessionId, event, payload)
    const tagged = { ...payload, session_id: sessionId }
    const profile = this.resolvePetEventProfile(sessionId, tagged)
    const state = this.sessionMap.get(sessionId)
    const session = getSession(sessionId)
    const storedAgent = String(session?.agent || '')
    observeChatRunWebhookEvent({
      pushTargetId: state?.isWorking ? state.pushTargetId : undefined,
      event,
      sessionId,
      profile,
      source: state?.source || session?.source || 'coding_agent',
      agent: state?.webhookAgent || (storedAgent === 'codex' ? 'codex' : storedAgent === 'pi' ? 'pi' : storedAgent === 'grok' ? 'grok' : storedAgent === 'dsh' ? 'dsh' : storedAgent === 'opencode' ? 'opencode' : storedAgent === 'ekko-agent' ? 'ekko' : 'claude-code'),
      payload: tagged,
      roomId: state?.webhookRoomId,
      workflowId: state?.webhookWorkflowId,
      workflowNodeId: state?.webhookWorkflowNodeId,
    })
    this.observePetEvent(profile, event, tagged)
    this.emitPendingInteraction(profile, event, tagged)
    if (state?.isWorking) {
      state.events.push({ event, data: tagged })
      if (state.events.length > 200) state.events.splice(0, state.events.length - 200)
    }
    this.nsp.to(`session:${sessionId}`).emit(event, buildOutboundRunEvent(event, tagged))
    const waiters = this.runWaiters.get(sessionId)
    if (waiters) {
      for (const waiter of waiters) waiter(event, tagged)
    }
  }

  markExternalRunCompleted(sessionId: string, event: string) {
    const state = this.sessionMap.get(sessionId)
    if (!state) return
    state.isWorking = false
    state.abortController = undefined
    state.runId = undefined
    state.activeRunMarker = undefined
    state.events = []
    state.responseRun = undefined
    state.profile = undefined
    logger.info('[chat-run-socket] external run completed for session %s (%s)', sessionId, event)
    if (state.queue.length > 0) {
      const socket = this.socketForQueuedRun(sessionId, state.queue[0])
      if (socket) this.dequeueNextQueuedRun(socket, sessionId)
    }
  }

  clearSessionHistory(sessionId: string): { deleted: number; hadMemoryState: boolean } {
    this.finishTaskPlanRun(sessionId, 'abort.completed')
    const deleted = clearSessionMessages(sessionId)
    const state = this.sessionMap.get(sessionId)
    const hadMemoryState = Boolean(state)
    const messagePageLimit = state?.messagePageLimit
    if (state) {
      state.abortController?.abort()
      if (state.isWorking && isBridgeRunSource(state.source)) {
        const profile = state.profile
        void this.bridge.interrupt(sessionId, 'Session cleared', profile)
          .catch((err: unknown) => logger.warn(err, '[chat-run-socket] failed to interrupt bridge run while clearing session %s', sessionId))
      }
      state.messages = []
      state.messageTotal = 0
      state.messageLoadedCount = 0
      state.messageStateBaselineCount = 0
      state.hasMoreBefore = false
      state.inputTokens = 0
      state.outputTokens = 0
      state.contextTokens = 0
      state.events = []
      state.queue = []
      state.queueInsertion = undefined
      state.bridgePendingAssistantContent = undefined
      state.bridgePendingReasoningContent = undefined
      state.bridgePendingToolCallMarkup = undefined
      state.bridgeOutput = undefined
      state.bridgePendingTools = undefined
      state.bridgeCompressionResults = undefined
      state.responseRun = undefined
      state.activeRunMarker = undefined
      state.runId = undefined
      state.abortController = undefined
      state.isAborting = false
      state.isWorking = false
      state.profile = undefined
      this.sessionMap.delete(sessionId)
    }
    this.nsp.to(['studio-account', `session:${sessionId}`]).emit('session.command', {
      event: 'session.command',
      session_id: sessionId,
      command: 'clear',
      ok: true,
      action: 'clear',
      clearHistory: true,
      source: 'mcu',
      deleted,
      memory_cleared: hadMemoryState,
    })
    this.nsp.to(['studio-account', `session:${sessionId}`]).emit('resumed', {
      session_id: sessionId,
      messages: [],
      messageTotal: 0,
      messageLoadedCount: 0,
      messagePageLimit,
      hasMoreBefore: false,
      isWorking: false,
      isAborting: false,
      events: [],
      inputTokens: 0,
      outputTokens: 0,
      contextTokens: 0,
      queueLength: 0,
      queueMessages: [],
      queueInsertion: null,
    })
    this.nsp.to(['studio-account', `session:${sessionId}`]).emit('run.queued', {
      event: 'run.queued',
      session_id: sessionId,
      queue_length: 0,
      queued_messages: [],
    })
    logger.info({ sessionId, deleted, hadMemoryState }, '[chat-run-socket] cleared session history and memory state')
    return { deleted, hadMemoryState }
  }

  private socketForQueuedRun(sessionId: string, next?: QueuedRun): Socket | null {
    if (next?.originSocketId) {
      const origin = this.nsp.sockets.get(next.originSocketId)
      if (origin) return origin
    }
    const room = this.nsp.adapter.rooms.get(`session:${sessionId}`)
    if (room) {
      for (const socketId of room) {
        const socket = this.nsp.sockets.get(socketId)
        if (socket) return socket
      }
    }
    return this.nsp.sockets.values().next().value || null
  }

  private clearClarifyEventState(sessionId: string, clarifyId: string) {
    const state = this.sessionMap.get(sessionId)
    if (!state?.events.length) return

    const nextEvents = state.events.filter(({ event, data }) => {
      if (event !== 'clarify.requested' && event !== 'clarify.resolved') return true
      return data?.clarify_id !== clarifyId
    })
    if (nextEvents.length !== state.events.length) {
      state.events = nextEvents
    }
  }

  private finishMobileLocationRequest(
    locationRequestId: string,
    response: MobileLocationResponse,
  ): boolean {
    const pending = this.pendingMobileLocations.get(locationRequestId)
    if (!pending) return false
    this.pendingMobileLocations.delete(locationRequestId)
    clearTimeout(pending.timer)
    this.clearMobileLocationEventState(pending.sessionId, locationRequestId)
    this.emitMobileLocationEvent(pending.profile, pending.sessionId, 'location.resolved', {
      event: 'location.resolved',
      location_request_id: locationRequestId,
      status: response.status,
      resolved: true,
      ...(response.status === 'error' ? { error: response.error } : {}),
    })
    pending.resolve(response)
    return true
  }

  private clearMobileLocationEventState(sessionId: string, locationRequestId: string): void {
    const state = this.sessionMap.get(sessionId)
    if (!state?.events.length) return
    state.events = state.events.filter(({ event, data }) => {
      if (event !== 'location.requested' && event !== 'location.resolved') return true
      return data?.location_request_id !== locationRequestId
    })
  }

  private emitMobileLocationEvent(
    profile: string,
    sessionId: string,
    event: 'location.requested' | 'location.resolved',
    payload: Record<string, unknown>,
  ): void {
    const tagged = { ...payload, session_id: sessionId }
    const state = this.sessionMap.get(sessionId)
    if (event === 'location.requested' && state) {
      state.events = state.events.filter(({ event: current }) =>
        current !== 'location.requested' && current !== 'location.resolved')
      state.events.push({ event, data: tagged })
    }
    this.nsp.to(`session:${sessionId}`).emit(event, tagged)
    this.emitPendingInteraction(profile, event, tagged)
  }

  private finishMobileCalendarRequest(requestId: string, response: MobileCalendarResponse): boolean {
    const pending = this.pendingMobileCalendar.get(requestId)
    if (!pending) return false
    this.pendingMobileCalendar.delete(requestId)
    clearTimeout(pending.timer)
    this.clearMobileCalendarEventState(pending.sessionId, requestId)
    const event = pending.request.capability === 'reminder' ? 'reminder.resolved' : 'calendar.resolved'
    const idKey = pending.request.capability === 'reminder' ? 'reminder_request_id' : 'calendar_request_id'
    this.emitMobileCalendarEvent(pending.profile, pending.sessionId, event, {
      event,
      [idKey]: requestId,
      target_device_id: pending.target.deviceCode,
      target_user_id: pending.target.userId,
      target_profile: pending.target.profile,
      status: response.status,
      resolved: true,
      ...(response.status === 'error' ? { error: response.error } : {}),
    })
    pending.resolve({ ...response, device_id: mobileDeviceId(pending.target) })
    return true
  }
  private finishMobileHealthRequest(requestId: string, response: MobileHealthResponse): boolean {
    const pending = this.pendingMobileHealth.get(requestId)
    if (!pending) return false
    this.pendingMobileHealth.delete(requestId)
    clearTimeout(pending.timer)
    this.clearMobileHealthEventState(pending.sessionId, requestId)
    this.emitMobileHealthEvent(pending.sessionId, 'health.resolved', {
      event: 'health.resolved',
      health_request_id: requestId,
      target_device_id: pending.target.deviceCode,
      target_user_id: pending.target.userId,
      target_profile: pending.target.profile,
      status: response.status,
      resolved: true,
      ...(response.status === 'error' ? { error: response.error } : {}),
    })
    pending.resolve({ ...response, device_id: mobileDeviceId(pending.target) })
    return true
  }
  private clearMobileHealthEventState(sessionId: string, requestId: string): void {
    const state = this.sessionMap.get(sessionId)
    if (!state?.events.length) return
    state.events = state.events.filter(({ event, data }) =>
      !['health.requested', 'health.resolved'].includes(event) || data?.health_request_id !== requestId)
  }
  private emitMobileHealthEvent(sessionId: string, event: 'health.requested' | 'health.resolved', payload: any): void {
    const tagged = { ...payload, session_id: sessionId }
    if (event === 'health.requested') {
      const state = getOrCreateSession(this.sessionMap, sessionId)
      state.events = state.events.filter(({ event: current }) => !['health.requested', 'health.resolved'].includes(current))
      state.events.push({ event, data: tagged })
    }
    const target: MobileDeviceTarget = { deviceCode: payload.target_device_id, userId: payload.target_user_id, profile: payload.target_profile }
    this.nsp.to(mobileDeviceRoom(target)).emit(event, tagged)
  }
  private clearMobileCalendarEventState(sessionId: string, requestId: string): void {
    const state = this.sessionMap.get(sessionId)
    if (!state?.events.length) return
    state.events = state.events.filter(({ event, data }) => {
      if (!['calendar.requested', 'calendar.resolved', 'reminder.requested', 'reminder.resolved'].includes(event)) return true
      return data?.calendar_request_id !== requestId && data?.reminder_request_id !== requestId
    })
  }
  private emitMobileCalendarEvent(profile: string, sessionId: string, event: string, payload: any): void {
    const tagged = { ...payload, session_id: sessionId }
    if (event === 'calendar.requested' || event === 'reminder.requested') {
      const state = getOrCreateSession(this.sessionMap, sessionId)
      state.events = state.events.filter(({ event: current }) =>
        !['calendar.requested', 'calendar.resolved', 'reminder.requested', 'reminder.resolved'].includes(current))
      state.events.push({ event, data: tagged })
    }
    const target: MobileDeviceTarget = { deviceCode: payload.target_device_id, userId: payload.target_user_id, profile: payload.target_profile }
    this.nsp.to(mobileDeviceRoom(target)).emit(event, tagged)
  }
  private emitToSession(socket: Socket, sessionId: string, event: string, payload: any) {
    const tagged = { ...payload, session_id: sessionId }
    const profile = this.resolvePetEventProfile(sessionId, tagged)
    const state = this.sessionMap.get(sessionId)
    const session = getSession(sessionId)
    const storedAgent = String(session?.agent || '')
    observeChatRunWebhookEvent({
      pushTargetId: state?.isWorking ? state.pushTargetId : undefined,
      event,
      sessionId,
      profile,
      source: state?.source || session?.source || 'chat',
      agent: state?.webhookAgent || (storedAgent === 'codex' ? 'codex' : storedAgent === 'pi' ? 'pi' : storedAgent === 'grok' ? 'grok' : storedAgent === 'dsh' ? 'dsh' : storedAgent === 'opencode' ? 'opencode' : storedAgent === 'ekko-agent' ? 'ekko' : 'bridge'),
      payload: tagged,
      roomId: state?.webhookRoomId,
      workflowId: state?.webhookWorkflowId,
      workflowNodeId: state?.webhookWorkflowNodeId,
    })
    this.observePetEvent(profile, event, tagged)
    this.emitPendingInteraction(profile, event, tagged)
    this.nsp.to(`session:${sessionId}`).emit(event, tagged)
    if (!this.nsp.adapter.rooms.get(`session:${sessionId}`)?.size && socket.connected) {
      socket.emit(event, tagged)
    }
  }

  private emitPendingInteraction(profile: string, event: string, payload: any) {
    this.emitSessionActivity(profile, event, payload)
    if (event !== 'approval.requested' && event !== 'approval.resolved'
      && event !== 'clarify.requested' && event !== 'clarify.resolved'
      && event !== 'location.requested' && event !== 'location.resolved'
      && event !== 'calendar.requested' && event !== 'calendar.resolved'
      && event !== 'reminder.requested' && event !== 'reminder.resolved'
      && event !== 'health.requested' && event !== 'health.resolved') return
    const sessionId = typeof payload?.session_id === 'string' ? payload.session_id : ''
    const source = sessionId
      ? this.sessionMap.get(sessionId)?.source || getSession(sessionId)?.source
      : undefined
    if (source === 'group_chat') return
    this.nsp.to(`pending-interactions:${profile}`).emit(event, payload)
  }

  private emitSessionActivity(profile: string, event: string, payload: any) {
    const sessionId = typeof payload?.session_id === 'string' ? payload.session_id : ''
    if (!sessionId) return

    let status: 'running' | 'completed' | 'failed' | null = null
    if (event === 'run.started' || (event === 'session.command' && payload.started === true && payload.terminal !== true)) {
      status = 'running'
    } else if (event === 'run.completed') {
      status = Number(payload.queue_remaining || 0) > 0 ? 'running' : 'completed'
    } else if (event === 'run.failed') {
      status = Number(payload.queue_remaining || 0) > 0 ? 'running' : 'failed'
    } else if (event === 'abort.completed') {
      status = Number(payload.queue_length || 0) > 0 ? 'running' : 'completed'
    } else if (event === 'session.command' && payload.terminal === true) {
      status = payload.ok === false || payload.action === 'error' ? 'failed' : 'completed'
    }
    if (!status) return

    const state = this.sessionMap.get(sessionId)
    const source = state?.source || getSession(sessionId)?.source
    const runId = state?.activeRunMarker || state?.responseRun?.runMarker || payload.run_marker || state?.runId || payload.run_id
    if (source !== 'group_chat' && source !== 'workflow') publishAppState(stateEvent('chat.run.updated', profile,
      { session_id: sessionId, run_id: runId },
      { state: { session_id: sessionId, status, timestamp: Date.now(), started_at: state?.runStartedAt,
        reset_progress: event === 'run.started' } }))

    this.nsp.to([`pending-interactions:${profile}`, `session:${sessionId}`]).emit('session.activity', {
      event: 'session.activity',
      session_id: sessionId,
      status,
      timestamp: Date.now(),
    })
  }

  private serializeQueuedMessages(queue: QueuedRun[]) {
    return queue.filter(item => item.displayInput !== null).map(item => ({
      id: item.queue_id,
      role: item.displayRole || (typeof item.displayInput === 'string' && item.displayInput.trim().startsWith('/') ? 'command' : 'user'),
      content: contentBlocksToString(item.displayInput ?? item.input),
      timestamp: Math.floor(Date.now() / 1000),
      queued: true,
    }))
  }

  private canAccessProfile(user: AuthenticatedUser, profile: string): boolean {
    return user.role === 'super_admin' || userCanAccessProfile(user.id, profile)
  }

  /** Close all active upstream response streams */
  async close() {
    if (this.closing) return
    this.closing = true
    for (const sessionId of this.sessionMap.keys()) this.finishTaskPlanRun(sessionId, 'abort.completed')
    if (this.backgroundPollTimer) {
      clearInterval(this.backgroundPollTimer)
      this.backgroundPollTimer = undefined
    }
    for (const requestId of [...this.pendingMobileLocations.keys()]) {
      this.finishMobileLocationRequest(requestId, {
        status: 'error',
        error: { code: 'location_failed' },
      })
    }
    for (const requestId of [...this.pendingMobileCalendar.keys()]) {
      this.finishMobileCalendarRequest(requestId, {
        status: 'error',
        error: { code: 'calendar_failed' },
      })
    }
    for (const requestId of [...this.pendingMobileHealth.keys()]) {
      this.finishMobileHealthRequest(requestId, { status: 'error', error: { code: 'health_failed' } })
    }
    const releaseClaims: Array<Promise<unknown>> = []
    for (const [sessionId, state] of this.sessionMap.entries()) {
      if (state.abortController) {
        try {
          state.abortController.abort()
        } catch (e) {
          logger.warn(e, '[chat-run-socket] failed to abort controller for session %s', sessionId)
        }
      }
      for (const queued of state.queue) {
        if (!queued.backgroundDelegationId || !queued.backgroundClaimId) continue
        releaseClaims.push(this.backgroundBridge.releaseBackgroundNotification(
          sessionId,
          queued.profile,
          queued.backgroundDelegationId,
          queued.backgroundClaimId,
        ))
      }
    }
    this.sessionMap.clear()
    const releaseResults = await Promise.allSettled(releaseClaims)
    for (const result of releaseResults) {
      if (result.status === 'rejected') {
        logger.warn(result.reason, '[chat-run-socket] failed to release queued background notification on close')
      }
    }
    await Promise.allSettled([this.bridge.close(), this.backgroundBridge.close()])
    logger.info('[chat-run-socket] closed all connections and cleared state')
  }

  private resolvePetEventProfile(sessionId: string, payload: Record<string, unknown>): string {
    const payloadProfile = typeof payload.profile === 'string' ? payload.profile.trim() : ''
    if (payloadProfile) return payloadProfile
    const stateProfile = this.sessionMap.get(sessionId)?.profile
    if (stateProfile) return stateProfile
    const storedProfile = getSession(sessionId)?.profile
    return storedProfile || 'default'
  }

  private observePetEvent(profile: string, event: string, payload: Record<string, unknown>): void {
    try {
      observeRunChatPetEvent(profile, event, payload)
    } catch (err) {
      logger.debug(err, '[chat-run-socket] failed to update pet state')
    }
  }
}
