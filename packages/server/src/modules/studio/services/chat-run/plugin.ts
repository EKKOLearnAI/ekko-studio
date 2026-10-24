import { StudioError, STUDIO_ERROR_CODES, type StudioErrorCode, type ChatRunReceipt, type ChatRunRecord, type ChatRunStartInput, type ExecutionScope } from '../../contracts/plugins'
import { studioSessionAccount } from '../../contracts/runs/usage'
import { historySessionSource, isBuiltinEkkoAgent } from '../../contracts/history-source'
import { findUserById, userCanAccessProfile } from '../../repositories/users-store'
import { getSessionMetadata, type HermesSessionRow } from '../../repositories/session-store'
import { PluginChatRunStore, chatRunTerminal } from '../../repositories/plugin-chat-run-store'
import type { AuthenticatedUser } from '../../public/auth'
import type { DirectChatRunHandle, DirectChatRunPort } from './direct'
import type { ChatRunStartRequest } from './start'
import { parseChatRunStart } from './input'

interface ChatTarget { user: AuthenticatedUser; session: HermesSessionRow }

function receipt(record: ChatRunRecord): ChatRunReceipt {
  const { output: _output, reasoning: _reasoning, truncated: _truncated, ...value } = record
  return value
}

export function authorizeOwnedChatSession(scope: ExecutionScope, id: string): ChatTarget {
  if (scope.principal.kind !== 'user') throw new StudioError('FORBIDDEN', 'Chat requires a user principal')
  const user = findUserById(scope.principal.id)
  if (!user || user.status !== 'active'
    || (user.role !== 'super_admin' && !userCanAccessProfile(user.id, scope.profileId))) {
    throw new StudioError('FORBIDDEN', 'Chat principal or profile is unavailable')
  }
  const session = getSessionMetadata(id)
  if (!session) throw new StudioError('NOT_FOUND', 'Chat session not found')
  // Admin privileges and imported gateway user IDs do not confer plugin ownership.
  if ((session.profile || 'default') !== scope.profileId || studioSessionAccount(session) !== scope.principal.id
    || (scope.sessionId !== undefined && scope.sessionId !== id)) {
    throw new StudioError('FORBIDDEN', 'Chat session is outside the execution scope')
  }
  if (['workflow', 'group_chat', 'global_agent'].includes(session.source)) {
    throw new StudioError('CAPABILITY_UNSUPPORTED', 'This operation supports direct chat sessions only')
  }
  return { session, user: { id: user.id, username: user.username, role: user.role } }
}

function chatRequest(session: HermesSessionRow, input: string): ChatRunStartRequest {
  return {
    session_id: session.id, input, profile: session.profile || 'default',
    source: historySessionSource(session), workspace: session.workspace,
    model: session.model, provider: session.provider, apiMode: session.api_mode,
    reasoning_effort: session.reasoning_effort,
    ...(session.agent_mode ? { mode: session.agent_mode as 'scoped' | 'global' } : {}),
    ...(isBuiltinEkkoAgent(session.agent) ? { agent_id: 'ekko-agent' as const }
      : session.agent && session.agent !== 'hermes' ? { coding_agent_id: session.agent as ChatRunStartRequest['coding_agent_id'] } : {}),
  }
}

/** SDK application service over the same direct port used by HTTP. No transport emulation. */
export class PluginChatRuns {
  private readonly active = new Map<string, DirectChatRunHandle>()
  private closed = false
  constructor(private readonly deps: {
    store: PluginChatRunStore
    server(): DirectChatRunPort | null
    authorize(scope: ExecutionScope, sessionId: string): ChatTarget
  }) {}

  start(scope: ExecutionScope, value: ChatRunStartInput, signal: AbortSignal): ChatRunReceipt {
    const input = parseChatRunStart(value)
    this.checkScope(scope)
    if (signal.aborted) throw new StudioError('CANCELLED', 'Chat admission was cancelled')
    const target = this.deps.authorize(scope, input.sessionId)
    const previous = this.deps.store.find(scope, input)
    if (previous) return receipt(previous)
    if (this.closed) throw new StudioError('RUNTIME_UNAVAILABLE', 'Chat service is closed')
    if (this.active.size >= 128) throw new StudioError('RESOURCE_EXHAUSTED', 'Too many active plugin chat requests')
    const server = this.deps.server()
    if (!server) throw new StudioError('RUNTIME_UNAVAILABLE', 'Chat service is unavailable')
    const request = chatRequest(target.session, input.input)
    const frozenScope = structuredClone(scope)
    const record = this.deps.store.accept(scope, input)
    // Acceptance belongs to the host, independent of the originating callback/worker lifetime.
    const controller = new AbortController()
    try {
      const handle = server.startDirectRun(request, {
        context: { scope: frozenScope, signal: controller.signal },
        profile: scope.profileId, user: target.user, pushActor: async () => null,
        reauthorize: async () => {
          if (this.closed) throw new StudioError('RUNTIME_UNAVAILABLE', 'Chat service is closed')
          const current = this.deps.authorize(frozenScope, input.sessionId)
          if (JSON.stringify(chatRequest(current.session, input.input)) !== JSON.stringify(request)) {
            throw new StudioError('REVISION_CONFLICT', 'Chat configuration changed before dispatch')
          }
        },
        onEvent: (event, payload) => this.observe(record.id, event, payload),
      })
      if (chatRunTerminal(this.deps.store.get(record.id)!.status)) handle.dispose()
      else this.active.set(record.id, handle)
    } catch {
      this.deps.store.update(record.id, { status: 'failed', errorCode: 'RUNTIME_UNAVAILABLE' })
    }
    return receipt(this.deps.store.get(record.id)!)
  }

  get(scope: ExecutionScope, id: string): ChatRunRecord {
    this.checkScope(scope)
    if (typeof id !== 'string' || !id || id.length > 256) throw new StudioError('INVALID_ARGUMENT', 'Invalid chat receipt id')
    const record = this.deps.store.get(id)
    if (!record) throw new StudioError('NOT_FOUND', 'Chat receipt not found')
    if (record.ownerId !== scope.principal.id || record.profileId !== scope.profileId) {
      throw new StudioError('FORBIDDEN', 'Chat receipt is outside the execution scope')
    }
    this.deps.authorize(scope, record.sessionId)
    return record
  }

  async cancel(scope: ExecutionScope, id: string): Promise<ChatRunReceipt> {
    const record = this.get(scope, id)
    if (chatRunTerminal(record.status)) return receipt(record)
    const handle = this.active.get(id)
    if (!handle?.cancel) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Chat cancellation is unavailable')
    this.deps.store.update(id, { status: 'cancelling' })
    await handle.cancel()
    // Recheck authorization after asynchronous native cancellation before returning private text.
    return receipt(this.get(scope, id))
  }

  close(): void {
    this.closed = true
    for (const [id, handle] of this.active) {
      this.deps.store.update(id, { status: 'interrupted', errorCode: 'RUNTIME_UNAVAILABLE' })
      handle.dispose()
      handle.dropQueued()
      void handle.cancel?.().catch(() => {})
    }
    this.active.clear()
  }

  private checkScope(scope: ExecutionScope): void {
    if (scope.runId !== undefined || scope.workspaceId !== undefined) {
      throw new StudioError('CAPABILITY_UNSUPPORTED', 'Bound run/workspace chat execution is not supported yet')
    }
  }

  private observe(id: string, event: string, payload: Record<string, unknown> = {}): void {
    const record = this.deps.store.get(id)
    if (!record || chatRunTerminal(record.status)) return
    const patch: Partial<ChatRunRecord> = {}
    if (event === 'run.queued' && record.status !== 'cancelling') patch.status = 'queued'
    if (event === 'run.started' && record.status !== 'cancelling') patch.status = 'running'
    if (['approval.requested', 'clarify.requested'].includes(event) && record.status !== 'cancelling') patch.status = 'waiting_input'
    if (['approval.resolved', 'clarify.resolved'].includes(event) && record.status === 'waiting_input') patch.status = 'running'
    const text = (field: 'output' | 'reasoning', value: unknown, append = false) => {
      if (typeof value !== 'string') return
      const next = (append ? record[field] : '') + value
      patch[field] = next.slice(0, 65_536)
      if (next.length > 65_536) patch.truncated = true
    }
    if (event === 'message.delta') text('output', payload.delta, true)
    if (event === 'reasoning.delta' || event === 'thinking.delta') text('reasoning', payload.delta, true)
    if (event === 'run.completed') {
      patch.status = 'completed'
      if (payload.output) text('output', payload.output)
      if (payload.reasoning) text('reasoning', payload.reasoning)
    }
    if (event === 'run.failed') {
      patch.status = 'failed'
      patch.errorCode = STUDIO_ERROR_CODES.includes(payload.error_code as StudioErrorCode) ? payload.error_code as StudioErrorCode : 'INTERNAL'
    }
    if (event === 'abort.completed') {
      patch.status = payload.synced === false ? 'interrupted' : 'cancelled'
      patch.errorCode = payload.synced === false ? 'RUNTIME_UNAVAILABLE' : null
    }
    if (Object.keys(patch).length) this.deps.store.update(id, patch)
    if (patch.status && chatRunTerminal(patch.status)) {
      this.active.get(id)?.dispose()
      this.active.delete(id)
    }
  }
}
