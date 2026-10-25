import type { ChatRunCaller } from '../../contracts/runs/caller'
import { StudioError } from '../../contracts/plugins'
import { randomUUID } from 'node:crypto'
import { normalizeEkkoRunData } from '../../contracts/history-source'
import type { AuthenticatedUser } from '../../public/auth'
import { listProfileNamesFromDisk } from '../../public/profile-config'
import { userCanAccessProfile } from '../../repositories/users-store'
import { getSession } from '../../repositories/session-store'
import { getSessionCategory } from '../../repositories/session-category-store'
import { bindRunPushTarget } from '../../repositories/run-push-store'
import { recordSessionUploadAttachments } from '../files/session-uploads'
import { prepareRunPushSnapshot, type authenticatedPushActor } from '../notifications/push-registration'
import { observeChatRunWebhookEvent } from '../webhooks'
import { logger } from '../../public/logging'
import { parseChatCodingAgentSessionCommand as parseCodingAgentSessionCommand } from '../../public/chat-agent-runtime'
import { parseSessionCommand } from './session-command'
import { parseEkkoRunCommand } from './ekko-session-command'
import { getOrCreateSession } from './compression'
import { resolveRunSource } from './load-state'
import { isBridgeRunSource, isProviderAgentExecution, isEkkoAgentExecution, webhookAgentForRun } from './run-routing'
import { serializeQueuedMessages } from './queued-messages'
import type { EkkoAgentRunSocketData } from './handle-ekko-agent-run'
import type { ChatCodingAgentId, ContentBlock, SessionState } from './types'

/** Authenticated caller information supplied by an entry adapter, never by the run payload. */
export interface ChatRunStartScope {
  profile: string
  user?: AuthenticatedUser
  shared?: boolean
  originId?: string
  directCaller?: ChatRunCaller
  /** Recheck a shared caller when its queued input is eventually dispatched. */
  reauthorize?: () => Promise<void>
}

export interface ChatRunStartRequest {
  managed_agent_protocol?: number
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
}

/** Legacy execution and delivery remain adapters; admission owns no HTTP or Socket objects. */
export interface ChatRunStartPorts {
  isManagedChat?(sessionId: string): boolean
  sessions: Map<string, SessionState>
  emit(event: string, payload: Record<string, unknown>): void
  emitSession(sessionId: string, event: string, payload: Record<string, unknown>): void
  publish(sessionId: string, event: string, payload: Record<string, unknown>): void
  pushActor(): ReturnType<typeof authenticatedPushActor>
  commands: {
    ekko(data: ChatRunStartRequest, command: NonNullable<ReturnType<typeof parseEkkoRunCommand>>, profile: string): Promise<void>
    session(data: ChatRunStartRequest, command: NonNullable<ReturnType<typeof parseSessionCommand>>, profile: string): Promise<boolean | void>
    codingAgent(data: ChatRunStartRequest, command: NonNullable<ReturnType<typeof parseCodingAgentSessionCommand>>, profile: string): Promise<void>
  }
  execute(data: ChatRunStartRequest, profile: string, pushTargetId?: string): Promise<void>
}

function profileExists(profile: string): boolean {
  return !profile || profile === 'default' || listProfileNamesFromDisk().includes(profile)
}

function requireProfileAccess(scope: ChatRunStartScope, profile: string): void {
  if (scope.user && scope.user.role !== 'super_admin' && !userCanAccessProfile(scope.user.id, profile)) {
    throw new Error(`Profile "${profile}" is not available for this user`)
  }
}

export function resolveChatRunProfile(scope: ChatRunStartScope, sessionId?: string, requested?: string): string {
  const requestedProfile = typeof requested === 'string' ? requested.trim() : ''
  if (requestedProfile) {
    if (!profileExists(requestedProfile)) throw new Error(`Profile "${requestedProfile}" does not exist`)
    requireProfileAccess(scope, requestedProfile)
    return requestedProfile
  }
  const storedProfile = sessionId ? getSession(sessionId)?.profile || '' : ''
  const profile = storedProfile && profileExists(storedProfile) ? storedProfile : scope.profile
  requireProfileAccess(scope, profile)
  return profile
}

export function requireChatRunSessionAccess(scope: ChatRunStartScope, sessionId: string, authorizedProfile = scope.profile): string {
  const session = getSession(sessionId)
  if (!session) throw new Error('Session not found')
  const profile = String(session.profile || 'default').trim() || 'default'
  if (profile !== authorizedProfile) throw new Error(`Profile "${profile}" is not available on this connection`)
  if (!profileExists(profile)) throw new Error(`Profile "${profile}" does not exist`)
  requireProfileAccess(scope, profile)
  return profile
}

function resolveSessionCategoryId(value: unknown): number | null {
  const categoryId = Number(value)
  if (!Number.isSafeInteger(categoryId) || categoryId <= 0) return null
  return getSessionCategory(categoryId) ? categoryId : null
}

/** Preserve the legacy command/queue/launch contract for authenticated chat entry points. */
export async function startChatRun(request: ChatRunStartRequest, scope: ChatRunStartScope, ports: ChatRunStartPorts): Promise<void> {
  // Runtime normalization and device binding must not change the caller's request object.
  const data = { ...request }
  const pushSnapshot = data.push_snapshot
  delete data.push_snapshot
  let pushTargetId: string | undefined
  let runProfile: string
  try {
    // Socket packet middleware already refreshes shares. Direct admission has no packet layer.
    if (scope.directCaller && scope.reauthorize) await scope.reauthorize()
    runProfile = resolveChatRunProfile(scope, data.session_id, data.profile)
    normalizeEkkoRunData(data, data.session_id ? getSession(data.session_id) : undefined)
    if (!scope.shared && data.session_id && Array.isArray(data.input)) {
      // New chats carry a client-generated id; the runtime persists them on the first run.
      if (getSession(data.session_id)) requireChatRunSessionAccess(scope, data.session_id, runProfile)
      await recordSessionUploadAttachments(data.session_id, runProfile, data.input, { allowPendingSession: true })
    }
  } catch (err) {
    const payload = {
      event: 'run.failed',
      session_id: data.session_id,
      queue_id: data.queue_id,
      error: err instanceof Error ? err.message : String(err),
      ...(err instanceof StudioError ? { error_code: err.code } : {}),
    }
    ports.emit('run.failed', payload)
    return
  }
  if (data.category_id !== undefined) {
    data.category_id = resolveSessionCategoryId(data.category_id)
  }
  if (data.session_id) {
    if (ports.isManagedChat?.(data.session_id)) {
      try {
        if (scope.shared) throw new StudioError('FORBIDDEN', 'Managed Agent chats require their owner')
        scope.directCaller?.assertCanStart?.()
        const actor = await ports.pushActor()
        if (actor) {
          const target = bindRunPushTarget({ kind: 'chat', profile: runProfile, runId: randomUUID() }, data.session_id, actor, {
            ciphertext: prepareRunPushSnapshot(actor, pushSnapshot), platform: String((pushSnapshot as any)?.platform || 'unknown'),
          })
          pushTargetId = target.id
          ports.emit('run.push.bound', { session_id: data.session_id, queue_id: data.queue_id, run_id: target.run_id })
        }
        await ports.execute(data, runProfile, pushTargetId)
      } catch (err) {
        ports.emit('run.failed', { event: 'run.failed', session_id: data.session_id, queue_id: data.queue_id,
          error: err instanceof Error ? err.message : String(err), ...(err instanceof StudioError ? { error_code: err.code } : {}) })
      }
      return
    }
    const state = getOrCreateSession(ports.sessions, data.session_id)
    const source = resolveRunSource(data.source, data.session_id)
    const storedSession = getSession(data.session_id)
    const ekkoExecution = isEkkoAgentExecution(data)
    if (ekkoExecution) {
      data.agent_id = 'ekko-agent'
      const ekkoCommand = parseEkkoRunCommand(data, storedSession?.source)
      if (ekkoCommand) {
        await ports.commands.ekko(data, ekkoCommand, runProfile)
        return
      }
    }
    const command = parseSessionCommand(data.input)
    if (command && ((!ekkoExecution && isBridgeRunSource(source)) || command.name === 'branch')) {
      try {
        const handled = await ports.commands.session(data, command, runProfile)
        if (handled !== false) return
        data.allow_command_passthrough = true
      } catch (err) {
        ports.emitSession(data.session_id, 'session.command', {
          event: 'session.command',
          command: command.rawName,
          ok: false,
          action: 'error',
          message: err instanceof Error ? err.message : String(err),
        })
      }
      return
    }
    if (!ekkoExecution && isProviderAgentExecution(source, data)) {
      if (typeof data.input === 'string') {
        const codingAgentCommand = parseCodingAgentSessionCommand(data.input)
        if (codingAgentCommand) {
          await ports.commands.codingAgent(data, codingAgentCommand, runProfile)
          return
        }
      }
    }
    try {
      const actor = scope.shared ? null : await ports.pushActor()
      scope.directCaller?.assertCanStart?.()
      if (actor) {
        const target = bindRunPushTarget({ kind: 'chat', profile: runProfile, runId: randomUUID() }, data.session_id, actor, {
          ciphertext: prepareRunPushSnapshot(actor, pushSnapshot),
          platform: String((pushSnapshot as any)?.platform || 'unknown'),
        })
        pushTargetId = target.id
        ports.emit('run.push.bound', { session_id: data.session_id, queue_id: data.queue_id, run_id: target.run_id })
      }
    } catch {
      ports.emit('run.failed', { session_id: data.session_id, queue_id: data.queue_id, error: 'Run device binding failed' })
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
        originSocketId: scope.originId,
        directCaller: scope.directCaller,
        authorize: scope.reauthorize,
        pushTargetId,
      })
      const queuedPayload = {
        event: 'run.queued',
        session_id: data.session_id,
        queue_id: queueId,
        queue_length: state.queue.length,
        queued_messages: serializeQueuedMessages(state.queue),
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
      ports.publish(data.session_id, 'run.queued', queuedPayload)
      logger.info('[chat-run-socket] queued run for session %s (queue: %d)', data.session_id, state.queue.length)
      return
    }
    state.events = []
    state.isWorking = !isProviderAgentExecution(source, data)
    state.runStartedAt = Date.now()
    state.profile = runProfile
    state.source = source
  }
  try {
    await ports.execute(data, runProfile, pushTargetId)
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
      const state = ports.sessions.get(data.session_id)
      if (state && !state.runId && !state.abortController && !state.activeRunMarker) {
        state.isWorking = false
        state.profile = undefined
      }
    }
    ports.emit('run.failed', payload)
  }
}
