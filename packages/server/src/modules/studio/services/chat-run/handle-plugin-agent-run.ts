import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { Server, Socket } from 'socket.io'
import type { AgentContent, AgentEvent, AgentMessage, AgentScopedModel, PluginIdentity } from '../../contracts/plugins'
import { config } from '../../public/config'
import { createSession, getSession, getSessionContextMessages, updateSession, updateSessionStats } from '../../repositories/session-store'
import { completeRunUsage } from '../../repositories/run-usage-store'
import { recordSessionUsage } from '../../public/usage'
import { pluginAgent, scopedAgentModel, pluginAgentMcpServers } from '../agents/registry'
import { agentRunInteractions } from '../agents/interactions'
import { runMcpCredentials } from '../auth/run-mcp-credentials'
import { withTaskPlanTurnContext } from '../task-plan-runs'
import { authorizePluginIdentity } from '../plugins/host'
import { isSessionUploadAttachment, recordSessionUploadAttachments } from '../files/session-uploads'
import { getOrCreateSession } from './compression'
import { persistRunMessages } from './message-persistence'
import { contentBlocksToString } from './content-blocks'
import { getSystemPrompt } from '../../public/runs/prompt'
import type { CodingAgentRunSocketData } from './handle-coding-agent-run'
import type { ContentBlock, SessionState } from './types'

export async function handlePluginAgentRun(
  nsp: ReturnType<Server['of']>, socket: Socket,
  data: CodingAgentRunSocketData & { queue_id?: string; display_input?: string | ContentBlock[] | null; display_role?: 'user' | 'command'; storage_message?: string; onEvent?: (event: string, payload: any) => void },
  profile: string, states: Map<string, SessionState>, dequeue: (socket: Socket, sessionId: string, profile?: string) => void,
) {
  const sessionId = data.session_id
  if (!sessionId) throw new Error('Plugin Agent runs require session_id')
  const stored = getSession(sessionId)
  const id = String(data.coding_agent_id || data.agent_id || stored?.agent || '')
  const agent = pluginAgent(id)
  const userId = Number(socket.data?.user?.id)
  let identity: PluginIdentity & { sessionId: string; runId: string } = { userId, profile, sessionId, runtime: id, surface: data.session_source || data.source || 'chat', runId: randomUUID() }
  authorizePluginIdentity(stored ? identity : { ...identity, sessionId: undefined })
  if (stored && stored.agent && stored.agent !== id) throw new Error('Session belongs to a different Agent')
  const mode = data.mode || (stored?.agent_mode === 'global' ? 'global' : agent.definition.modes.scoped ? 'scoped' : 'global')
  if (!agent.definition.modes[mode]) throw new Error('Agent does not support the requested mode')
  const surface = identity.surface === 'group_chat' ? 'group-chat' : identity.surface === 'workflow' ? 'workflow' : identity.surface === 'api' ? 'api' : 'chat'
  if (!agent.definition.features.surfaces.includes(surface)) throw new Error('Agent does not support this surface')
  const state = getOrCreateSession(states, sessionId)
  const controller = new AbortController()
  const runId = identity.runId
  state.isWorking = true; state.isAborting = false; state.abortController = controller
  state.runId = runId; state.activeRunMarker = runId; state.profile = profile
  state.source = identity.surface === 'workflow' ? 'workflow' : identity.surface === 'group_chat' ? 'group_chat' : 'coding_agent'
  state.events = []
  state.webhookAgent = id as `plugin:${string}/${string}`
  const startedAt = Date.now(), deadlineAt = startedAt + 3_600_000
  const signal = AbortSignal.any([controller.signal, agent.owner.effects.controller.signal, AbortSignal.timeout(deadlineAt - startedAt)])
  const current = () => states.get(sessionId) === state && state.activeRunMarker === runId && !signal.aborted
  const emit = (event: string, payload: Record<string, unknown>) => {
    const value = { ...payload, event, session_id: sessionId, run_id: runId, queue_id: data.queue_id }
    if (!['run.completed', 'run.failed', 'abort.completed'].includes(event)) state.events.push({ event, data: value })
    nsp.to(`session:${sessionId}`).emit(event, value)
    data.onEvent?.(event, value)
  }
  socket.join(`session:${sessionId}`)
  let disposeModel: (() => void) | undefined
  let text = '', reasoning = ''
  let finalized = false
  const pendingTools = new Map<string, string>()
  const persistToolResult = (callId: string, output: unknown, failed: boolean) => {
    const name = pendingTools.get(callId)
    if (name === undefined) throw new Error('Unknown Agent tool call')
    persistRunMessages(state, { sessionId, runMarker: runId, appendToState: true, messages: [{
      role: 'tool', tool_call_id: callId, tool_name: name,
      content: typeof output === 'string' ? output : JSON.stringify(output ?? null), finish_reason: failed ? 'error' : null,
    }] })
    pendingTools.delete(callId)
  }
  const flushPartial = () => {
    if (finalized || state.activeRunMarker !== runId) return
    finalized = true
    for (const callId of pendingTools.keys()) persistToolResult(callId, 'Tool execution interrupted', true)
    if (text || reasoning) persistRunMessages(state, { sessionId, runMarker: runId, appendToState: true, messages: [{ role: 'assistant', content: text, reasoning: reasoning || null, finish_reason: 'interrupted' }] })
  }
  state.pluginAgent = { id, flushPartial }
  try {
    const source = state.source
    const workspaceDir = String(data.workspace || stored?.workspace || join(config.appHome, 'workspaces', String(userId), sessionId))
    if (!isAbsolute(workspaceDir)) throw new Error('Agent workspace must be absolute')
    const paths = { runtimeDir: join(config.appHome, 'plugins', 'global', 'agent-runs', createHash('sha256').update(JSON.stringify([id, userId, profile, sessionId, mode])).digest('hex')), workspaceDir }
    await mkdir(workspaceDir, { recursive: true })
    signal.throwIfAborted()
    if (!stored) createSession({ id: sessionId, profile, source, agent: id, agent_mode: mode, user_id: String(userId),
      model: data.model || '', provider: mode === 'global' ? '' : data.provider || '', workspace: workspaceDir,
      title: typeof data.input === 'string' ? data.input.slice(0, 100) : 'Agent', category_id: data.category_id, api_mode: mode === 'global' ? '' : data.apiMode || data.api_mode || '' })
    identity = { ...identity, workspace: workspaceDir }
    updateSession(sessionId, { workspace: workspaceDir, ended_at: null, end_reason: null, last_active: Math.floor(Date.now() / 1000) })
    if (!(await agent.status(identity, signal)).installed) throw new Error('Agent engine is not installed')
    await recordSessionUploadAttachments(sessionId, profile, data.input)
    signal.throwIfAborted()
    const attachmentPaths = new Map<string, { path: string; name: string; mediaType: string }>()
    const content = async (input: string | ContentBlock[]): Promise<AgentContent[]> => {
      signal.throwIfAborted()
      if (typeof input === 'string') {
        try { const parsed = JSON.parse(input); if (Array.isArray(parsed) && parsed.every(part => part && ['text', 'image', 'file'].includes(part.type))) return content(parsed) } catch { /* Plain message. */ }
        return [{ type: 'text', text: input }]
      }
      return Promise.all(input.map(async block => {
        if (block.type === 'text') return { type: 'text' as const, text: block.text }
        const path = await realpath(block.path)
        const offset = relative(await realpath(workspaceDir), path)
        if (!(await isSessionUploadAttachment(sessionId, profile, block.path)) && (offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset))) throw new Error('Attachment is outside the authorized session')
        const assetId = createHash('sha256').update(path).digest('hex')
        const value = { path, name: block.name, mediaType: block.media_type || 'application/octet-stream' }
        attachmentPaths.set(assetId, value)
        return { type: block.type, assetId, name: value.name, mediaType: value.mediaType }
      }))
    }
    const input = await content(data.input)
    const attachment = async (assetId: string) => {
      signal.throwIfAborted(); authorizePluginIdentity(identity)
      const file = attachmentPaths.get(assetId)
      if (!file || await realpath(file.path) !== file.path) throw new Error('Attachment is unavailable or changed')
      const info = await stat(file.path)
      if (!info.isFile()) throw new Error('Attachment must be a file')
      signal.throwIfAborted()
      return { ...file, size: info.size }
    }
    const history: AgentMessage[] = []
    // The display cache is paginated; runtimes need the complete durable conversation.
    for (const message of getSessionContextMessages(sessionId)) {
      if (!['system', 'user', 'assistant', 'tool'].includes(message.role)) continue
      // Tool results are arbitrary JSON, not Studio upload content blocks.
      const parts = message.role === 'tool' ? [{ type: 'text' as const, text: message.content }] : await content(message.content)
      history.push({ role: message.role as AgentMessage['role'], content: parts, ...(message.tool_call_id ? { toolCallId: message.tool_call_id } : {}) })
    }
    signal.throwIfAborted()
    const displayInput = data.display_input === undefined ? data.input : data.display_input
    if (displayInput !== null) {
      const role = data.display_role || 'user'
      const userMessage = persistRunMessages(state, { sessionId, runMarker: runId, appendToState: true,
        messages: [{ role, content: data.storage_message ?? contentBlocksToString(displayInput) }] }).messages[0]
      emit('message.created', { message_id: userMessage.id, role, content: userMessage.content, timestamp: userMessage.timestamp })
    }
    let model: AgentScopedModel | { model?: string; reasoningEffort?: string }
    if (mode === 'global') {
      const catalog = await agent.models(identity, false, signal)
      const chosen = data.model || stored?.model || ''
      if (chosen && !catalog.models.some(value => value.id === chosen && !value.hidden)) throw new Error('Selected Agent model is no longer available')
      if (catalog.status !== 'ready' && catalog.status !== 'empty') throw new Error(catalog.message || `Agent model catalog: ${catalog.status}`)
      model = { ...(chosen ? { model: chosen } : {}), reasoningEffort: data.reasoning_effort }
    } else {
      const provider = data.provider || stored?.provider || '', selected = data.model || stored?.model || '', apiMode = data.apiMode || data.api_mode || stored?.api_mode || ''
      if (!provider || !selected || !apiMode) throw new Error('Scoped Agent requires provider, model and apiMode')
      const lease = await scopedAgentModel({ identity, agentId: id, provider, model: selected, apiMode, protocols: agent.definition.modes.scoped!.protocols, reasoningEffort: data.reasoning_effort, signal })
      model = lease.model; disposeModel = lease.dispose
    }
    signal.throwIfAborted()
    let mcpServers = {}
    if (data.task_plan_context_id) {
      const group = typeof socket.data?.groupRunIsCurrent === 'function'
      const tokenFile = await runMcpCredentials.issue({ userId, sessionId, contextId: data.task_plan_context_id, profile,
        agentId: group ? String(data.group_agent_id) : id, roomId: group ? data.group_room_id : undefined,
        isActive: () => current() && (socket.data?.groupRunIsCurrent?.() ?? true) })
      mcpServers = pluginAgentMcpServers(profile, tokenFile)
      signal.throwIfAborted()
    }
    updateSession(sessionId, { model: model.model || '', provider: mode === 'global' ? '' : (model as AgentScopedModel).provider, agent_mode: mode,
      reasoning_effort: data.reasoning_effort || '', api_mode: mode === 'global' ? '' : data.apiMode || data.api_mode || stored?.api_mode || '' })
    emit('run.started', { model: model.model, agent: id })
    const interactions = agentRunInteractions({ sessionId, runId, signal, deadlineAt, emit })
    const result = await agent.execute({ identity, mode, paths, model, signal, deadlineAt, mcpServers: mcpServers as any, interactions,
      request: { input, history, instructions: [{ kind: 'system', text: getSystemPrompt() }, ...(data.task_plan_context_id ? [{ kind: 'task' as const, text: withTaskPlanTurnContext('', data.task_plan_context_id, surface === 'chat') as string }] : []), ...(data.group_system_prompt ? [{ kind: 'role' as const, text: data.group_system_prompt }] : []), ...(data.instructions ? [{ kind: 'task' as const, text: data.instructions }] : [])], options: {} },
      attachments: {
        resolve: async assetId => { const file = await attachment(assetId); return { assetId, name: file.name, mediaType: file.mediaType, localPath: file.path, size: file.size } },
        read: async assetId => readFile((await attachment(assetId)).path),
      },
      emit: async (event: AgentEvent) => {
        if (!current()) throw new Error('Agent run expired')
        if (event.type === 'text.delta') { if (typeof event.text !== 'string') throw new Error('Invalid Agent text delta'); text += event.text; emit('message.delta', { delta: event.text }) }
        else if (event.type === 'reasoning.summary.delta') { reasoning += event.text; emit('reasoning.delta', { delta: event.text }) }
        else if (event.type === 'status') emit('run.updated', { status: event.phase, message: event.message })
        else if (event.type === 'tool.started') {
          if (pendingTools.has(event.callId)) throw new Error('Duplicate Agent tool call')
          persistRunMessages(state, { sessionId, runMarker: runId, appendToState: true, messages: [{
            role: 'assistant', content: '', finish_reason: 'tool_calls',
            tool_calls: [{ id: event.callId, type: 'function', function: { name: event.name, arguments: JSON.stringify(event.input) } }],
          }] })
          pendingTools.set(event.callId, event.name)
          emit('tool.started', { tool_call_id: event.callId, name: event.name, arguments: event.input })
        } else if (event.type === 'tool.completed' || event.type === 'tool.failed') {
          persistToolResult(event.callId, event.type === 'tool.completed' ? event.result : event.error, event.type === 'tool.failed')
          emit(event.type, { tool_call_id: event.callId, ...(event.type === 'tool.completed' ? { result: event.result } : { error: event.error }) })
        }
        else throw new Error('Unknown Agent event')
      },
    })
    if (!current()) return
    if (pendingTools.size) throw new Error('Agent run ended with unfinished tool calls')
    const outputParts = await Promise.all(result.content.map(async part => {
      if (part.type === 'text') return { type: 'text' as const, text: part.text }
      const file = await attachment(part.assetId)
      return { type: part.type, path: file.path, name: file.name, media_type: file.mediaType }
    }))
    if (!current()) return
    const output = outputParts.every(part => part.type === 'text')
      ? outputParts.map(part => part.type === 'text' ? part.text : '').join('') : JSON.stringify(outputParts)
    const assistant = persistRunMessages(state, { sessionId, runMarker: runId, appendToState: true, messages: [{ role: 'assistant', content: output, reasoning: reasoning || null, finish_reason: result.finishReason }] }).messages[0]
    finalized = true
    // Scoped requests are recorded by the Studio proxy. Native usage is supplied by the plugin.
    if (mode === 'global' && result.usage?.inputTokens != null && result.usage.outputTokens != null) {
      recordSessionUsage({ sessionId, parentRunId: runId, runId, source: 'coding_agent', agent: id as `plugin:${string}/${string}`,
        usageScope: 'run', profile, model: model.model, usage: result.usage, isEstimated: result.usage.isEstimated,
        ...(result.usage.costUsd != null ? { cost: { costUsd: result.usage.costUsd, costSource: 'reported' as const } } : {}) })
    }
    const usage = completeRunUsage(sessionId, runId, assistant.id, (Date.now() - startedAt) / 1000)
    emit('run.completed', { output, parsed_content: output, parsed_reasoning: reasoning, message_id: assistant.id, run_usage: usage, finish_reason: result.finishReason })
    updateSession(sessionId, { ended_at: Math.floor(Date.now() / 1000), end_reason: 'completed' })
  } catch (error) {
    if (state.activeRunMarker === runId && !state.isAborting) {
      flushPartial()
      emit('run.failed', { error: error instanceof Error ? error.message : String(error) })
      if (getSession(sessionId)) updateSession(sessionId, { ended_at: Math.floor(Date.now() / 1000), end_reason: 'error' })
    }
  } finally {
    disposeModel?.()
    if (data.task_plan_context_id) runMcpCredentials.revoke(sessionId, data.task_plan_context_id)
    if (state.activeRunMarker === runId && !state.isAborting) {
      controller.abort(); state.isWorking = false; state.runId = undefined; state.abortController = undefined; state.activeRunMarker = undefined; state.events = []
      state.pluginAgent = undefined
      updateSessionStats(sessionId)
      dequeue(socket, sessionId, profile)
    }
  }
}
