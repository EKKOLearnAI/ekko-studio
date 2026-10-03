import type { Server, Socket } from 'socket.io'
import { addMessage, createSession, getSession, updateSession, updateSessionStats } from '../../repositories/session-store'
import { historySessionSource, isBuiltinEkkoAgent } from '../../contracts/history-source'
import { getRecordedUsageTotals, getUsage } from '../../repositories/usage-store'
import { getModelContextLength } from '../../public/provider-runtime'
import { resolveChatEkkoProviderRuntimeConfig } from '../../public/chat-agent-runtime'
import { buildDbSnapshotAwareHistory, forceCompressBridgeHistory, getOrCreateSession } from './compression'
import { compactBiliConversation, refreshExternalContextUsage, resolveStudioContextManager } from '../context-manager/runtime'
import { resolveBridgeRunModelConfig } from './model-config'
import { estimateUsageTokensFromMessages, updateContextTokenUsage } from './usage'
import type { EkkoAgentRunSocketData } from './handle-ekko-agent-run'
import type { SessionState } from './types'

type EkkoCommandName = 'context' | 'usage' | 'status' | 'compact'
export interface EkkoSessionCommand { name: EkkoCommandName; rawName: string; args: string }

export function parseEkkoSessionCommand(input: unknown): EkkoSessionCommand | null {
  if (typeof input !== 'string') return null
  const match = input.trim().match(/^\/([a-zA-Z][\w-]*)(?:\s+([\s\S]*))?$/)
  if (!match) return null
  const rawName = match[1].toLowerCase()
  const name = rawName === 'compress' ? 'compact' : rawName
  if (!['context', 'usage', 'status', 'compact'].includes(name)) return null
  return { name: name as EkkoCommandName, rawName, args: match[2]?.trim() || '' }
}

export function parseEkkoRunCommand(
  data: { input: unknown; source?: string; session_source?: string },
  storedSource?: string,
): EkkoSessionCommand | null {
  // Slash-prefixed task content in orchestrated runs belongs to the Agent.
  if ([data.source, data.session_source, storedSource].some(source => source === 'group_chat' || source === 'workflow')) return null
  return parseEkkoSessionCommand(data.input)
}

/** Ekko owns these commands; legacy coding_agent transport fields do not select its family. */
export async function handleEkkoSessionCommand(
  nsp: ReturnType<Server['of']>,
  socket: Socket,
  data: EkkoAgentRunSocketData,
  command: EkkoSessionCommand,
  profile: string,
  sessionMap: Map<string, SessionState>,
  dequeue?: (socket: Socket, sessionId: string, profile: string) => boolean,
): Promise<void> {
  const sessionId = String(data.session_id || '').trim()
  if (!sessionId) return
  const storedSession = getSession(sessionId)
  const boundaryError = storedSession?.profile && storedSession.profile !== profile
    ? 'Context manager session belongs to another profile.'
    : storedSession && !isBuiltinEkkoAgent(storedSession.agent)
      ? 'Context manager session belongs to another agent family.'
      : undefined
  if (boundaryError) {
    const payload = { event: 'session.command', session_id: sessionId, command: command.rawName, action: command.name, source: 'ekko', ok: false, terminal: true, message: boundaryError }
    data.onEvent?.('session.command', payload)
    socket.emit('session.command', payload)
    return
  }
  socket.join(`session:${sessionId}`)
  const state = getOrCreateSession(sessionMap, sessionId)
  const emit = (event: string, payload: Record<string, unknown>) => {
    const tagged = { event, ...payload, session_id: sessionId }
    data.onEvent?.(event, tagged)
    nsp.to(`session:${sessionId}`).emit(event, tagged)
    if (!nsp.adapter.rooms.get(`session:${sessionId}`)?.size && socket.connected) socket.emit(event, tagged)
  }
  const reply = (payload: Record<string, unknown>) => emit('session.command', {
    command: command.rawName, action: command.name, source: 'ekko',
    ok: true, terminal: !state.isWorking, ...payload,
  })
  if (command.name === 'compact' && state.isWorking) {
    reply({ ok: false, terminal: false, message: 'Compression can only run while the session is idle.' })
    return
  }
  // Reserve the session before asynchronous provider resolution or summarization.
  const ownsCompression = command.name === 'compact'
  if (ownsCompression) state.isWorking = true
  try {
    let row = storedSession
    if (!row) {
      const model = await resolveBridgeRunModelConfig({
        profile, requestedModel: data.model, requestedProvider: data.provider, preferRequested: true,
      })
      createSession({
        id: sessionId, profile, source: data.session_source === 'global_agent' || data.source === 'global_agent' ? 'global_agent' : 'builtin_agent', agent: 'ekko-agent', agent_mode: 'scoped',
        model: model.model, provider: model.provider, title: 'Ekko', workspace: data.workspace || undefined,
        user_id: socket.data?.user?.id == null ? undefined : String(socket.data.user.id),
        category_id: data.category_id,
      })
      row = getSession(sessionId)
    }
    if (row) {
      const source = historySessionSource({ ...row, agent: 'ekko-agent' })
      if (row.source !== source || row.agent !== 'ekko-agent') updateSession(sessionId, { source, agent: 'ekko-agent' })
      state.source = source as SessionState['source']
    } else state.source = data.session_source === 'global_agent' || data.source === 'global_agent' ? 'global_agent' : 'builtin_agent'
    const content = `/${command.rawName}${command.args ? ` ${command.args}` : ''}`
    const timestamp = Math.floor(Date.now() / 1000)
    const id = addMessage({ session_id: sessionId, role: 'command', content, timestamp })
    state.messages.push({ id: id || `command_${timestamp}_${state.messages.length}`, session_id: sessionId, role: 'command', content, timestamp })
    updateSessionStats(sessionId)

    if (command.name === 'status') {
      reply({ message: `Ekko: ${state.isWorking ? 'running' : 'idle'}. Queue: ${state.queue.length}.`,
        isWorking: state.isWorking, queueLength: state.queue.length, agent: 'ekko-agent', mode: 'scoped',
        model: row?.model || data.model || null, provider: row?.provider || data.provider || null })
      return
    }
    if (command.name === 'usage') {
      const totals = getRecordedUsageTotals(sessionId, 'ekko_agent')
      const available = Boolean(getUsage(sessionId, 'ekko_agent'))
      const totalTokens = totals.inputTokens + totals.outputTokens + (totals.cacheReadTokens || 0) + (totals.cacheWriteTokens || 0)
      reply({ available, messageKey: available ? 'nativeUsage' : 'nativeUsageUnknown',
        message: available ? `Usage: input ${totals.inputTokens}, output ${totals.outputTokens}, total ${totalTokens} tokens.`
          : 'Usage: unknown. No token usage has been reported for this session.',
        inputTokens: available ? totals.inputTokens : null, outputTokens: available ? totals.outputTokens : null,
        cacheReadTokens: available ? totals.cacheReadTokens || 0 : null,
        cacheWriteTokens: available ? totals.cacheWriteTokens || 0 : null, totalTokens: available ? totalTokens : null })
      return
    }
    const modelContext = { model: row?.model || data.model, provider: row?.provider || data.provider }
    const owner = await resolveStudioContextManager(profile, 'ekko', sessionId)
    if (owner.manager === 'bili') {
      state.contextOwner = { manager: 'bili', proxyUrl: owner.proxyUrl, conversationId: sessionId }
      if (command.name === 'compact') {
        emit('compression.started', { source: 'command', manager: 'bili' })
        const result = await compactBiliConversation({ sessionId, profile, agent: 'ekko', model: modelContext.model, state, emit })
        emit('compression.completed', { source: 'command', manager: 'bili', compressed: true, ...result, contextTokens: result.afterTokens })
        reply({ terminal: true, manager: 'bili', compressed: true, ...result, contextTokens: result.afterTokens,
          message: `Compression completed: ${result.beforeTokens} -> ${result.afterTokens} tokens.` })
        return
      }
      const available = await refreshExternalContextUsage({ sessionId, profile, agent: 'ekko', model: modelContext.model, state, emit, owner: state.contextOwner })
      const usage = available ? state.externalContext : undefined
      reply({ manager: 'bili', available, estimated: false, contextTokens: usage?.tokens ?? null,
        contextWindow: usage?.window ?? null,
        contextPercent: usage && usage.window > 0 ? Math.round(usage.tokens / usage.window * 1000) / 10 : null,
        message: usage ? `Context: ${usage.tokens} / ${usage.window} tokens.` : 'Context: unknown. Bili effective usage is unavailable.' })
      return
    }
    const history = await buildDbSnapshotAwareHistory(sessionId, profile, { excludeLastUser: false }, modelContext)
    const historyUsage = estimateUsageTokensFromMessages(history)
    const fixedContextTokens = state.ekkoContext?.fixedContextTokens || 0
    const beforeTokens = historyUsage.inputTokens + historyUsage.outputTokens + fixedContextTokens
    if (command.name === 'context') {
      const contextWindow = getModelContextLength({ profile, ...modelContext })
      reply({ message: `Context: approximately ${beforeTokens} / ${contextWindow} tokens.`, estimated: true,
        contextTokens: beforeTokens, contextWindow,
        contextPercent: contextWindow > 0 ? Math.round(beforeTokens / contextWindow * 1000) / 10 : null })
      return
    }
    emit('compression.started', { message_count: history.length, token_count: beforeTokens, source: 'command' })
    // Use the same provider resolver and snapshot store as Ekko automatic compression.
    const runtime = history.length ? await resolveChatEkkoProviderRuntimeConfig({
      profile, ...modelContext, baseUrl: data.baseUrl || data.base_url, apiKey: data.apiKey || data.api_key,
      apiMode: data.apiMode || data.api_mode || row?.api_mode || undefined,
    }) : undefined
    const result = await forceCompressBridgeHistory(sessionId, profile, [], undefined, {
      ...modelContext, upstream: runtime?.baseUrl, apiKey: runtime?.apiKey, apiMode: runtime?.apiMode,
      allowHermesFallback: false, excludeLastUser: false, force: true,
    })
    const contextTokens = result.afterTokens + fixedContextTokens
    updateContextTokenUsage(sessionId, state, emit, contextTokens)
    emit('compression.completed', {
      source: 'command', compressed: result.compressed, llmCompressed: result.llmCompressed,
      totalMessages: result.beforeMessages, resultMessages: result.resultMessages,
      beforeTokens, afterTokens: result.afterTokens, contextTokens,
      summaryTokens: result.summaryTokens, verbatimCount: result.verbatimCount,
      compressedStartIndex: result.compressedStartIndex,
    })
    reply({ terminal: true, message: `Compression completed: ${result.beforeMessages} -> ${result.resultMessages} messages, ${beforeTokens} -> ${contextTokens} tokens.`,
      beforeMessages: result.beforeMessages, resultMessages: result.resultMessages, beforeTokens, afterTokens: contextTokens,
      contextTokens, compressed: result.compressed })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (ownsCompression) emit('compression.completed', { compressed: false, failed: true, error: message, source: 'command' })
    reply({ ok: false, terminal: ownsCompression || !state.isWorking, message })
  } finally {
    if (ownsCompression) {
      state.isWorking = false
      dequeue?.(socket, sessionId, profile)
    }
  }
}
