import type { TaskPlanSnapshot } from '@/utils/task-plan'
import { io, type Socket } from 'socket.io-client'
import { disconnectBackgroundStatusObservers } from './background-status'
import { onAuthInvalidated } from '../auth-invalidation'
import { getBaseUrlValue, getApiKey } from '../client'
import type { ChatCodingAgentId } from '../coding-agents'
import type { ProviderApiMode } from './provider-api-mode'

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; name: string; path: string; media_type: string; context?: string; video_frame?: boolean; annotation_id?: string }
  | { type: 'file'; name: string; path: string; media_type?: string; context?: string; annotation_id?: string }

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string | ContentBlock[]
}

export interface StartRunRequest {
  input: string | ContentBlock[]
  /** Optional UI/storage representation when model input carries hidden metadata. */
  display_input?: string | ContentBlock[] | null
  /** Model-facing content persisted separately from display_input. */
  storage_message?: string
  instructions?: string
  session_id?: string
  profile?: string
  model?: string
  provider?: string
  model_groups?: Array<{ provider: string; models: string[] }>
  queue_id?: string
  source?: 'api_server' | 'cli' | 'coding_agent' | 'global_agent' | 'workflow' | 'group_chat'
  session_source?: 'global_agent' | 'workflow' | 'group_chat'
  coding_agent_id?: ChatCodingAgentId
  agent_preset?: string
  agent_id?: ChatCodingAgentId
  mode?: 'scoped' | 'global'
  workspace?: string | null
  category_id?: number | null
  baseUrl?: string
  base_url?: string
  apiKey?: string
  api_key?: string
  apiMode?: ProviderApiMode
  api_mode?: ProviderApiMode
  mcpServers?: Record<string, unknown>
  mcp_servers?: Record<string, unknown>
  /** Per-session reasoning effort override.
   * Empty/undefined = use config.yaml default. */
  reasoning_effort?: string
  /** Whether completion messages from this session should be pushed. */
  push_enabled?: boolean
}

export interface StartRunResponse {
  run_id: string
  status: string
}

// SSE event types from /v1/runs/{id}/events
export interface RunEvent {
  event: string
  run_id?: string
  run_marker?: string
  delta?: string
  /** Payload text for `reasoning.delta` / `thinking.delta` / `reasoning.available` events. */
  text?: string
  /** Whether a `message.interim` payload was already delivered by message.delta. */
  already_streamed?: boolean
  /** MoA reference metadata forwarded as display-only reasoning. */
  label?: string
  index?: number
  count?: number
  aggregator?: string
  preset?: string
  moa?: {
    preset?: string
    reference_models?: string[]
    aggregator?: string
  }
  tool?: string
  name?: string
  preview?: string
  timestamp?: number
  error?: string
  /** Final response text on `run.completed`. May be empty/null if the agent
   * silently swallowed an upstream error — see chat store for fallback. */
  output?: string | null
  /** Run-level workspace diff summary attached to terminal run events. */
  workspace_run_change?: unknown
  /** Provider/runtime context returned by Ekko for follow-up runs. */
  context?: unknown
  usage?: {
    input_tokens: number
    output_tokens: number
    total_tokens: number
  }
  /** session_id tag added by server for client-side filtering */
  session_id?: string
  /** Generated session title from session.title.updated. */
  title?: string
  /** Session workspace from session.workspace.updated. */
  workspace?: string | null
  /** Queue length from run.queued event */
  queue_length?: number
  /** Number of background delegations still running or awaiting delivery. */
  background_pending?: number
  /** True when this run was started by a delivered background completion. */
  autonomous?: boolean
  delegation_id?: string
  subagent_id?: string
  task_index?: number
  task_count?: number
  goal?: string
  model?: string
  provider?: string
  api_mode?: ProviderApiMode
  reasoning_effort?: string
  push_enabled?: boolean
  status?: string
  summary?: string
  arguments?: unknown
  tool_count?: number
  duration_seconds?: number
  background_seq?: number
  api_calls?: number
  input_tokens?: number
  output_tokens?: number
  cost_usd?: number
  /** Queue item that was just removed because it is starting now. */
  dequeued_queue_id?: string
  /** Queued user messages from run.queued/resume payloads. */
  queued_messages?: Array<{
    id?: string | number
    role?: string
    content?: string
    timestamp?: number
    queued?: boolean
  }>
  generation?: string
  queue_id?: string
  runtime?: 'hermes' | 'ekko' | 'claude-code' | 'codex' | 'pi' | 'grok' | 'opencode' | 'dsh'
  phase?: 'requesting' | 'waiting_for_tool_batch' | 'stopping_current_turn' | 'starting_queued_message' | 'cancelled'
  guarantee?: 'strict' | 'immediate'
  requested_at?: number
  timeout_ms?: number
  remaining_timeout_ms?: number
  reason?: string
  /** True when a terminal event intentionally stopped the previous run. */
  interrupted?: boolean
  /** Machine-readable reason for an intentional terminal event. */
  stop_reason?: 'queue_insertion' | string
  /** Safety guarantee used when the previous run was interrupted. */
  boundary_guarantee?: 'strict'
  /** Immediate process interruption used by one-shot coding agents. */
  interruption_mode?: 'immediate'
  /** User message broadcast to other windows already watching the same session. */
  message?: {
    id?: string | number
    role?: string
    content?: string
    timestamp?: number
    queued?: boolean
  }
}

export interface ResumeSessionPayload {
  taskPlans?: TaskPlanSnapshot[]
  session_id: string
  messages: any[]
  workspaceRunChanges?: import('./sessions').WorkspaceRunChangeSummary[]
  messageTotal?: number
  messageLoadedCount?: number
  messagePageLimit?: number
  hasMoreBefore?: boolean
  isWorking: boolean
  isAborting?: boolean
  /** Epoch ms the active run began; absent on servers that predate it. */
  runStartedAt?: number
  events: Array<{ event: string; data: RunEvent }>
  inputTokens?: number
  outputTokens?: number
  contextTokens?: number
  workspace?: string | null
  model?: string
  provider?: string
  api_mode?: ProviderApiMode | ''
  reasoning_effort?: string
  push_enabled?: boolean
  queueLength?: number
  queueMessages?: RunEvent['queued_messages']
  queueInsertion?: {
    generation: string
    run_id?: string
    queue_id: string
    runtime: 'hermes' | 'ekko' | 'claude-code' | 'codex' | 'pi' | 'grok' | 'opencode' | 'dsh'
    phase: 'requesting' | 'waiting_for_tool_batch' | 'stopping_current_turn' | 'starting_queued_message'
    guarantee: 'strict' | 'immediate'
    requested_at: number
  } | null
  backgroundTasks?: Array<Record<string, unknown>>
  backgroundPending?: number
}

// ============================
// Socket.IO chat run connection
// ============================

let chatRunSocket: Socket | null = null
let globalListenersRegistered = false
let chatRunSocketProfile: string | null = null
export type ChatRunTransport = 'chat-run' | 'global-agent'
let chatRunSocketTransport: ChatRunTransport = 'chat-run'

const TRANSIENT_DISCONNECT_REASONS = new Set<string>([
  'transport close',
  'transport error',
  'ping timeout',
])

/**
 * Session event handlers map
 * Maps session_id to event handling functions for isolating concurrent session streams
 */
const sessionEventHandlers = new Map<string, {
  onMessageDelta: (event: RunEvent) => void
  onMessageInterim: (event: RunEvent) => void
  onReasoningDelta: (event: RunEvent) => void
  onThinkingDelta: (event: RunEvent) => void
  onReasoningAvailable: (event: RunEvent) => void
  onToolStarted: (event: RunEvent) => void
  onToolCompleted: (event: RunEvent) => void
  onWorkspaceDiffCompleted?: (event: RunEvent) => void
  onSubagentEvent?: (event: RunEvent) => void
  onRunStarted: (event: RunEvent) => void
  onRunCompleted: (event: RunEvent) => void
  onRunFailed: (event: RunEvent) => void
  onCompressionStarted: (event: RunEvent) => void
  onCompressionCompleted: (event: RunEvent) => void
  onAbortStarted: (event: RunEvent) => void
  onAbortTimeout?: (event: RunEvent) => void
  onAbortCompleted: (event: RunEvent) => void
  onUsageUpdated: (event: RunEvent) => void
  onAgentEvent?: (event: RunEvent) => void
  onSessionCommand?: (event: RunEvent) => void
  onSessionTitleUpdated?: (event: RunEvent) => void
  onSessionWorkspaceUpdated?: (event: RunEvent) => void
  onSessionSettingsUpdated?: (event: RunEvent) => void
  onRunQueued?: (event: RunEvent) => void
  onQueueInsertionUpdated?: (event: RunEvent) => void
  onApprovalRequested?: (event: RunEvent) => void
  onApprovalResolved?: (event: RunEvent) => void
  onPeerUserMessage?: (event: RunEvent) => void
  onClarifyRequested?: (event: RunEvent) => void
  onClarifyResolved?: (event: RunEvent) => void
}>()

const peerUserMessageHandlers = new Set<(event: RunEvent) => void>()
const sessionCommandHandlers = new Set<(event: RunEvent) => void>()
const sessionTitleUpdatedHandlers = new Set<(event: RunEvent) => void>()
const sessionWorkspaceUpdatedHandlers = new Set<(event: RunEvent) => void>()
const sessionSettingsUpdatedHandlers = new Set<(event: RunEvent) => void>()

/**
 * Global message.delta event handler
 * Distributes events to appropriate session based on session_id
 */
function globalMessageDeltaHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onMessageDelta) {
    handlers.onMessageDelta(event)
  }
}

function globalMessageInterimHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  sessionEventHandlers.get(sid)?.onMessageInterim(event)
}

/**
 * Global reasoning.delta event handler
 */
function globalReasoningDeltaHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onReasoningDelta) {
    handlers.onReasoningDelta(event)
  }
}

/**
 * Global thinking.delta event handler (alias for reasoning.delta)
 */
function globalThinkingDeltaHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onThinkingDelta) {
    handlers.onThinkingDelta(event)
  }
}

/**
 * Global reasoning.available event handler
 */
function globalReasoningAvailableHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onReasoningAvailable) {
    handlers.onReasoningAvailable(event)
  }
}

/**
 * Global tool.started event handler
 */
function globalToolStartedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onToolStarted) {
    handlers.onToolStarted(event)
  }
}

/**
 * Global tool.completed event handler
 */
function globalToolCompletedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onToolCompleted) {
    handlers.onToolCompleted(event)
  }
}

function globalWorkspaceDiffCompletedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onWorkspaceDiffCompleted) {
    handlers.onWorkspaceDiffCompleted(event)
  }
}

function globalSubagentEventHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onSubagentEvent) {
    handlers.onSubagentEvent(event)
  }
}

/**
 * Global run.started event handler
 */
function globalRunStartedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onRunStarted) {
    handlers.onRunStarted(event)
  }
}

/**
 * Global run.completed event handler
 */
function globalRunCompletedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onRunCompleted) {
    handlers.onRunCompleted(event)
  }

  // Auto-cleanup session handlers on completion (skip if more runs queued)
  if ((event as any).queue_remaining > 0 || (event.background_pending || 0) > 0) return
  sessionEventHandlers.delete(sid)
}

/**
 * Global run.failed event handler
 */
function globalRunFailedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onRunFailed) {
    handlers.onRunFailed(event)
  }

  // Auto-cleanup session handlers on failure (skip if more runs queued)
  if ((event as any).queue_remaining > 0 || (event.background_pending || 0) > 0) return
  sessionEventHandlers.delete(sid)
}

/**
 * Global run.queued event handler
 */
function globalRunQueuedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onRunQueued) {
    handlers.onRunQueued(event)
  }
}

function globalQueueInsertionUpdatedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return
  sessionEventHandlers.get(sid)?.onQueueInsertionUpdated?.(event)
}

/**
 * Global compression.started event handler
 */
function globalCompressionStartedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onCompressionStarted) {
    handlers.onCompressionStarted(event)
  }
}

/**
 * Global compression.completed event handler
 */
function globalCompressionCompletedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onCompressionCompleted) {
    handlers.onCompressionCompleted(event)
  }
}

/**
 * Global abort.started event handler
 */
function globalAbortStartedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onAbortStarted) {
    handlers.onAbortStarted(event)
  }
}

/**
 * Global abort.timeout event handler
 */
function globalAbortTimeoutHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onAbortTimeout) {
    handlers.onAbortTimeout(event)
  }
}

/**
 * Global abort.completed event handler
 */
function globalAbortCompletedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onAbortCompleted) {
    handlers.onAbortCompleted(event)
  }

  // If abort completion is followed by queued runs, keep the handler alive so
  // the next run.started/message.delta/run.completed events are still received.
  if ((event as any).queue_length > 0) return
  sessionEventHandlers.delete(sid)
}

/**
 * Global usage.updated event handler
 */
function globalUsageUpdatedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onUsageUpdated) {
    handlers.onUsageUpdated(event)
  }
}

function globalSessionCommandHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onSessionCommand) {
    handlers.onSessionCommand(event)
  }

  for (const handler of sessionCommandHandlers) {
    handler(event)
  }
}

function globalSessionTitleUpdatedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers) {
    handlers.onSessionTitleUpdated?.(event)
  }

  for (const handler of sessionTitleUpdatedHandlers) {
    handler(event)
  }
}

function globalSessionWorkspaceUpdatedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers) {
    handlers.onSessionWorkspaceUpdated?.(event)
  }

  for (const handler of sessionWorkspaceUpdatedHandlers) {
    handler(event)
  }
}

function globalSessionSettingsUpdatedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return
  sessionEventHandlers.get(sid)?.onSessionSettingsUpdated?.(event)
  for (const handler of sessionSettingsUpdatedHandlers) handler(event)
}

function globalAgentEventHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onAgentEvent) {
    handlers.onAgentEvent(event)
  }
}

function globalRunReattachFailedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onAgentEvent) {
    handlers.onAgentEvent(event)
  }
}

function globalApprovalRequestedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onApprovalRequested) {
    handlers.onApprovalRequested(event)
  }
  for (const handler of peerUserMessageHandlers) handler(event)
}

function globalApprovalResolvedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onApprovalResolved) {
    handlers.onApprovalResolved(event)
  }
  for (const handler of peerUserMessageHandlers) handler(event)
}

function globalPeerUserMessageHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onPeerUserMessage) {
    handlers.onPeerUserMessage(event)
  }

  for (const handler of peerUserMessageHandlers) {
    handler(event)
  }
}

function globalClarifyRequestedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onClarifyRequested) {
    handlers.onClarifyRequested(event)
  }
  for (const handler of peerUserMessageHandlers) handler(event)
}

function globalClarifyResolvedHandler(event: RunEvent): void {
  const sid = event.session_id
  if (!sid) return

  const handlers = sessionEventHandlers.get(sid)
  if (handlers?.onClarifyResolved) {
    handlers.onClarifyResolved(event)
  }
  for (const handler of peerUserMessageHandlers) handler(event)
}

/**
 * Register event handlers for a session
 * @param sessionId - Session ID
 * @param handlers - Event handling functions
 * @returns Cleanup function to unregister handlers
 */
export function registerSessionHandlers(
  sessionId: string,
  handlers: {
    onMessageDelta: (event: RunEvent) => void
    onMessageInterim: (event: RunEvent) => void
    onReasoningDelta: (event: RunEvent) => void
    onThinkingDelta: (event: RunEvent) => void
    onReasoningAvailable: (event: RunEvent) => void
    onToolStarted: (event: RunEvent) => void
    onToolCompleted: (event: RunEvent) => void
    onWorkspaceDiffCompleted?: (event: RunEvent) => void
    onSubagentEvent?: (event: RunEvent) => void
    onRunStarted: (event: RunEvent) => void
    onRunCompleted: (event: RunEvent) => void
    onRunFailed: (event: RunEvent) => void
    onCompressionStarted: (event: RunEvent) => void
    onCompressionCompleted: (event: RunEvent) => void
    onAbortStarted: (event: RunEvent) => void
    onAbortTimeout?: (event: RunEvent) => void
    onAbortCompleted: (event: RunEvent) => void
    onUsageUpdated: (event: RunEvent) => void
    onAgentEvent?: (event: RunEvent) => void
    onSessionCommand?: (event: RunEvent) => void
    onSessionTitleUpdated?: (event: RunEvent) => void
    onSessionWorkspaceUpdated?: (event: RunEvent) => void
    onSessionSettingsUpdated?: (event: RunEvent) => void
    onRunQueued?: (event: RunEvent) => void
    onQueueInsertionUpdated?: (event: RunEvent) => void
    onApprovalRequested?: (event: RunEvent) => void
    onApprovalResolved?: (event: RunEvent) => void
    onPeerUserMessage?: (event: RunEvent) => void
    onClarifyRequested?: (event: RunEvent) => void
    onClarifyResolved?: (event: RunEvent) => void
  }
): () => void {
  sessionEventHandlers.set(sessionId, handlers)

  // Return cleanup function
  return () => {
    sessionEventHandlers.delete(sessionId)
  }
}

/**
 * Unregister event handlers for a session
 * @param sessionId - Session ID
 */
export function unregisterSessionHandlers(sessionId: string): void {
  sessionEventHandlers.delete(sessionId)
}

export function onPeerUserMessage(handler: (event: RunEvent) => void): () => void {
  peerUserMessageHandlers.add(handler)
  return () => {
    peerUserMessageHandlers.delete(handler)
  }
}

export function onSessionCommand(handler: (event: RunEvent) => void): () => void {
  sessionCommandHandlers.add(handler)
  return () => {
    sessionCommandHandlers.delete(handler)
  }
}

export function onSessionTitleUpdated(handler: (event: RunEvent) => void): () => void {
  sessionTitleUpdatedHandlers.add(handler)
  return () => {
    sessionTitleUpdatedHandlers.delete(handler)
  }
}

export function onSessionWorkspaceUpdated(handler: (event: RunEvent) => void): () => void {
  sessionWorkspaceUpdatedHandlers.add(handler)
  return () => {
    sessionWorkspaceUpdatedHandlers.delete(handler)
  }
}

export function onSessionSettingsUpdated(handler: (event: RunEvent) => void): () => void {
  sessionSettingsUpdatedHandlers.add(handler)
  return () => {
    sessionSettingsUpdatedHandlers.delete(handler)
  }
}

export function respondClarify(
  sessionId: string,
  clarifyId: string,
  response: string,
  transport: ChatRunTransport = 'chat-run',
): void {
  const socket = connectChatRun(null, transport)
  socket.emit('clarify.respond', {
    session_id: sessionId,
    clarify_id: clarifyId,
    response,
  })
}

export function respondToolApproval(
  sessionId: string,
  approvalId: string,
  choice: 'once' | 'session' | 'always' | 'deny',
  transport: ChatRunTransport = 'chat-run',
): void {
  const socket = connectChatRun(null, transport)
  socket.emit('approval.respond', {
    session_id: sessionId,
    approval_id: approvalId,
    choice,
  })
}

export function getChatRunSocket(transport?: ChatRunTransport): Socket | null {
  if (transport && chatRunSocketTransport !== transport) return null
  return chatRunSocket
}

export function connectChatRun(requestedProfile?: string | null, transport: ChatRunTransport = 'chat-run'): Socket {
  const normalizedRequestedProfile = requestedProfile?.trim() || null
  if (
    chatRunSocket?.connected &&
    chatRunSocketTransport === transport &&
    (!normalizedRequestedProfile || chatRunSocketProfile === normalizedRequestedProfile)
  ) {
    return chatRunSocket
  }

  // Clean up old socket to prevent duplicate event listeners
  if (chatRunSocket) {
    chatRunSocket.removeAllListeners()
    chatRunSocket.disconnect()
    globalListenersRegistered = false
    chatRunSocketProfile = null
  }

  const baseUrl = getBaseUrlValue()
  const token = getApiKey()

  // Get active profile from store (authoritative source)
  let profile = normalizedRequestedProfile || 'default'
  try {
    if (!normalizedRequestedProfile) {
      const { useProfilesStore } = require('@/stores/hermes/profiles')
      const profilesStore = useProfilesStore()
      profile = profilesStore.activeProfileName || 'default'
    }
  } catch {
    // Fallback to localStorage during early initialization
    profile = normalizedRequestedProfile || localStorage.getItem('hermes_active_profile_name') || 'default'
  }
  chatRunSocketProfile = profile
  chatRunSocketTransport = transport

  const namespace = transport === 'global-agent' ? '/global-agent' : '/chat-run'
  chatRunSocket = io(`${baseUrl}${namespace}`, {
    auth: { token },
    query: { profile },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 30000,
    randomizationFactor: 0.5,
    timeout: 30000,
  })

  // Retained callbacks from a replaced/invalidated socket must not dispatch
  // into handlers registered by a later authenticated session.
  const ownerSocket = chatRunSocket
  const on = (event: string, handler: (event: RunEvent) => void) => {
    ownerSocket.on(event, (data: RunEvent) => {
      if (chatRunSocket === ownerSocket) handler(data)
    })
  }

  // Register global listeners only once per socket connection
  if (!globalListenersRegistered) {
    // Message events
    on('message.delta', globalMessageDeltaHandler)
    on('message.interim', globalMessageInterimHandler)
    on('reasoning.delta', globalReasoningDeltaHandler)
    on('thinking.delta', globalThinkingDeltaHandler)
    on('reasoning.available', globalReasoningAvailableHandler)
    on('moa.reference', globalReasoningDeltaHandler)
    on('moa.aggregating', globalAgentEventHandler)

    // Tool events
    on('tool.started', globalToolStartedHandler)
    on('tool.completed', globalToolCompletedHandler)
    on('tool.failed', globalToolCompletedHandler)
    on('workspace.diff.completed', globalWorkspaceDiffCompletedHandler)
    on('subagent.start', globalSubagentEventHandler)
    on('subagent.tool', globalSubagentEventHandler)
    on('subagent.progress', globalSubagentEventHandler)
    on('subagent.text', globalSubagentEventHandler)
    on('subagent.thinking', globalSubagentEventHandler)
    on('subagent.complete', globalSubagentEventHandler)
    on('delegation.updated', globalSubagentEventHandler)

    // Run lifecycle events
    on('run.started', globalRunStartedHandler)
    on('run.failed', globalRunFailedHandler)
    on('run.completed', globalRunCompletedHandler)
    on('run.queued', globalRunQueuedHandler)
    on('run.queue_insertion.updated', globalQueueInsertionUpdatedHandler)
    on('approval.requested', globalApprovalRequestedHandler)
    on('approval.resolved', globalApprovalResolvedHandler)
    on('run.peer_user_message', globalPeerUserMessageHandler)
    on('clarify.requested', globalClarifyRequestedHandler)
    on('clarify.resolved', globalClarifyResolvedHandler)

    // Compression events
    on('compression.started', globalCompressionStartedHandler)
    on('compression.completed', globalCompressionCompletedHandler)
    on('abort.started', globalAbortStartedHandler)
    on('abort.timeout', globalAbortTimeoutHandler)
    on('abort.completed', globalAbortCompletedHandler)

    // Usage and task-plan events
    on('usage.updated', globalUsageUpdatedHandler)
    on('plan.updated', globalAgentEventHandler)
    on('agent.event', globalAgentEventHandler)
    on('run.reattach_failed', globalRunReattachFailedHandler)
    on('session.command', globalSessionCommandHandler)
    on('session.title.updated', globalSessionTitleUpdatedHandler)
    on('session.workspace.updated', globalSessionWorkspaceUpdatedHandler)
    on('session.settings.updated', globalSessionSettingsUpdatedHandler)

    globalListenersRegistered = true
  }

  return chatRunSocket
}

export function disconnectChatRun(): void {
  disconnectBackgroundStatusObservers()
  sessionEventHandlers.clear()
  if (chatRunSocket) {
    chatRunSocket.removeAllListeners()
    chatRunSocket.disconnect()
    chatRunSocket = null
    chatRunSocketProfile = null
    chatRunSocketTransport = 'chat-run'
    globalListenersRegistered = false
  }
}

onAuthInvalidated(disconnectChatRun)

function removeSocketListener(socket: Socket, event: string, handler: (...args: any[]) => void): void {
  const candidate = socket as Socket & {
    off?: (event: string, handler: (...args: any[]) => void) => Socket
    removeListener?: (event: string, handler: (...args: any[]) => void) => Socket
  }
  if (typeof candidate.off === 'function') {
    candidate.off(event, handler)
    return
  }
  candidate.removeListener?.(event, handler)
}

/**
 * Start a chat run via Socket.IO and stream events back.
 * Returns an AbortController-compatible handle for cancellation.
 */
/**
 * Resume a session via Socket.IO. Returns messages, working status, and events.
 */
export function resumeSession(
  sessionId: string,
  onResumed: (data: ResumeSessionPayload) => void,
  profile?: string | null,
  transport: ChatRunTransport = 'chat-run',
): Socket {
  const socket = connectChatRun(profile, transport)

  const handleResumed = (data: ResumeSessionPayload) => {
    if (data?.session_id !== sessionId) return
    removeSocketListener(socket, 'resumed', handleResumed)
    onResumed(data)
  }
  socket.on('resumed', handleResumed)
  socket.emit('resume', { session_id: sessionId, ...(profile ? { profile } : {}) })

  return socket
}

export function startRunViaSocket(
  body: StartRunRequest,
  onEvent: (event: RunEvent) => void,
  onDone: () => void,
  onError: (err: Error) => void,
  onStarted?: (runId: string) => void,
  options?: {
    onReconnectResume?: (data: ResumeSessionPayload) => void
    transport?: ChatRunTransport
    /** Opt in to a bounded server-acceptance gate for durable draft clearing. */
    trackAcceptance?: boolean
  },
): { abort: () => void; accepted: Promise<boolean> } {
  const sid = body.session_id
  if (!sid) {
    throw new Error('session_id is required for startRunViaSocket')
  }

  let closed = false
  const socket = connectChatRun(body.profile, options?.transport)

  const trackAcceptance = options?.trackAcceptance === true
  let resolveAccepted: (accepted: boolean) => void = () => {}
  let acceptanceSettled = false
  let acceptanceTimeout: ReturnType<typeof setTimeout> | null = null
  const accepted = trackAcceptance
    ? new Promise<boolean>((resolve) => { resolveAccepted = resolve })
    : Promise.resolve(true)
  const settleAcceptance = (value: boolean) => {
    if (acceptanceSettled) return
    acceptanceSettled = true
    if (acceptanceTimeout) clearTimeout(acceptanceTimeout)
    acceptanceTimeout = null
    removeSocketListener(socket, 'run.started', handleAcceptedStart)
    removeSocketListener(socket, 'run.queued', handleAcceptedQueue)
    removeSocketListener(socket, 'run.accepted', handleAcceptedRun)
    removeSocketListener(socket, 'run.failed', handleRejectedRun)
    removeSocketListener(socket, 'connect_error', handleRejectedConnect)
    removeSocketListener(socket, 'connect', emitAcceptanceTrackedRun)
    resolveAccepted(value)
  }
  const matchesSubmission = (evt: RunEvent) => {
    if (evt?.session_id !== sid) return false
    return !body.queue_id || evt.queue_id === body.queue_id
  }
  const handleAcceptedStart = (evt: RunEvent) => {
    if (matchesSubmission(evt)) settleAcceptance(true)
  }
  const handleAcceptedQueue = (evt: RunEvent) => {
    if (matchesSubmission(evt)) settleAcceptance(true)
  }
  const handleAcceptedRun = (evt: RunEvent) => {
    if (matchesSubmission(evt)) settleAcceptance(true)
  }
  const handleRejectedRun = (evt: RunEvent) => {
    if (matchesSubmission(evt)) settleAcceptance(false)
  }
  const handleRejectedConnect = () => settleAcceptance(false)
  const emitAcceptanceTrackedRun = () => {
    if (acceptanceSettled) return
    socket.volatile.emit('run', body)
  }
  if (trackAcceptance) {
    socket.on('run.started', handleAcceptedStart)
    socket.on('run.queued', handleAcceptedQueue)
    socket.on('run.accepted', handleAcceptedRun)
    socket.on('run.failed', handleRejectedRun)
    socket.on('connect_error', handleRejectedConnect)
    if (!socket.connected) socket.once('connect', emitAcceptanceTrackedRun)
    acceptanceTimeout = setTimeout(() => settleAcceptance(false), 30_000)
  }
  const emitRunRequest = () => {
    if (trackAcceptance) {
      if (socket.connected) emitAcceptanceTrackedRun()
      return
    }
    socket.emit('run', body)
  }
  if (sessionEventHandlers.has(sid)) {
    emitRunRequest()
    return {
      accepted,
      abort: () => {
        if (!closed) {
          socket.emit('abort', { session_id: sid })
        }
      },
    }
  }

  let sawTransientDisconnect = false
  let removeTerminalSocketListeners: () => void = () => {}
  let reconnectResumeHandler: ((data: ResumeSessionPayload) => void) | null = null

  const clearReconnectResumeHandler = () => {
    if (!reconnectResumeHandler) return
    removeSocketListener(socket, 'resumed', reconnectResumeHandler)
    reconnectResumeHandler = null
  }

  const emitReconnectResume = () => {
    clearReconnectResumeHandler()
    if (options?.onReconnectResume) {
      reconnectResumeHandler = (data: ResumeSessionPayload) => {
        clearReconnectResumeHandler()
        if (closed || data.session_id !== sid) return
        options.onReconnectResume?.(data)
      }
      socket.on('resumed', reconnectResumeHandler)
    }
    socket.emit('resume', { session_id: sid, ...(body.profile ? { profile: body.profile } : {}) })
  }

  const handleSocketError = (err: Error) => {
    if (closed) return
    settleAcceptance(false)
    closed = true
    removeTerminalSocketListeners()
    sessionEventHandlers.delete(sid)
    onError(err)
  }
  const handleSocketConnectError = (err: Error) => {
    if (closed) return
    if (sawTransientDisconnect) return
    handleSocketError(err)
  }
  socket.on('connect_error', handleSocketConnectError)
  const handleSocketDisconnect = (reason: string) => {
    if (closed || reason === 'io client disconnect') return
    if (TRANSIENT_DISCONNECT_REASONS.has(reason)) {
      sawTransientDisconnect = true
      return
    }
    handleSocketError(new Error(`Socket disconnected: ${reason}`))
  }
  socket.on('disconnect', handleSocketDisconnect)

  const handleSocketReconnect = () => {
    if (closed || !sawTransientDisconnect) return
    sawTransientDisconnect = false
    emitReconnectResume()
  }
  socket.on('connect', handleSocketReconnect)

  removeTerminalSocketListeners = () => {
    clearReconnectResumeHandler()
    removeSocketListener(socket, 'connect_error', handleSocketConnectError)
    removeSocketListener(socket, 'disconnect', handleSocketDisconnect)
    removeSocketListener(socket, 'connect', handleSocketReconnect)
  }

  // Define event handlers for this session
  const handlers = {
    onMessageDelta: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onMessageInterim: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onReasoningDelta: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onThinkingDelta: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onReasoningAvailable: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onToolStarted: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onToolCompleted: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onWorkspaceDiffCompleted: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onSubagentEvent: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onRunStarted: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
      onStarted?.(evt.run_id || '')
    },
    onRunCompleted: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
      if ((evt as any).queue_remaining > 0) return
      if ((evt.background_pending || 0) > 0) {
        onDone()
        return
      }
      closed = true
      removeTerminalSocketListeners()
      onDone()
    },
    onRunFailed: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
      if ((evt as any).queue_remaining > 0) return
      if ((evt.background_pending || 0) > 0) {
        onDone()
        return
      }
      closed = true
      removeTerminalSocketListeners()
      onDone()
    },
    onCompressionStarted: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onCompressionCompleted: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onAbortStarted: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onAbortTimeout: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onAbortCompleted: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
      if ((evt as any).queue_length > 0) return
      closed = true
      removeTerminalSocketListeners()
      onDone()
    },
    onUsageUpdated: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onAgentEvent: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onSessionCommand: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
      if ((evt as any).terminal === false) return
      closed = true
      removeTerminalSocketListeners()
      sessionEventHandlers.delete(sid)
      onDone()
    },
    onSessionTitleUpdated: (evt: RunEvent) => {
      onEvent(evt)
    },
    onSessionSettingsUpdated: (evt: RunEvent) => {
      onEvent(evt)
    },
    onRunQueued: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onQueueInsertionUpdated: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onApprovalRequested: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onApprovalResolved: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onClarifyRequested: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
    onClarifyResolved: (evt: RunEvent) => {
      if (closed) return
      onEvent(evt)
    },
  }

  // Register handlers in the global session map
  sessionEventHandlers.set(sid, handlers)

  // Emit run request
  emitRunRequest()

  return {
    accepted,
    abort: () => {
      if (!closed) {
        socket.emit('abort', { session_id: sid })
      }
    },
  }
}
