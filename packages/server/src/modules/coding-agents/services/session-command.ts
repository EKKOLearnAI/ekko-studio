import type { Server, Socket } from 'socket.io'
import { addMessage, getSession, updateSessionStats } from '../../studio/public/sessions'
import { getModelContextLength } from '../../studio/public/provider-runtime'
import { calcAndUpdateUsage, getOrCreateSession } from '../../studio/public/run-state'
import type { SessionState } from '../../studio/contracts/runs/session'
import { codingAgentRunManager } from './runtime/run-manager'
import { compactStoredCodingAgentSession, startCodingAgentRun } from './index'

export type CodingAgentCommandName = 'context' | 'compact' | 'usage' | 'status'

export interface ParsedCodingAgentCommand {
  name: CodingAgentCommandName
  rawName: string
  args: string
}

type CodingAgentCompactResult = { started: boolean } | {
  compacted: boolean
  beforeTokens?: number | null
  afterTokens?: number | null
}

const CODING_AGENT_COMMAND_ALIASES: Record<string, CodingAgentCommandName> = {
  context: 'context',
  compact: 'compact',
  usage: 'usage',
  status: 'status',
}

export function parseCodingAgentSessionCommand(input: string): ParsedCodingAgentCommand | null {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) return null
  const match = trimmed.match(/^\/([a-zA-Z][\w-]*)(?:\s+([\s\S]*))?$/)
  if (!match) return null
  const rawName = match[1].toLowerCase()
  const name = CODING_AGENT_COMMAND_ALIASES[rawName]
  if (!name) return null
  return { name, rawName, args: match[2]?.trim() || '' }
}

export function isCodingAgentSessionCommand(input: string): boolean {
  return parseCodingAgentSessionCommand(input) !== null
}

export interface CodingAgentSessionCommandData {
  session_id?: string
  model?: string
  provider?: string
  mode?: 'scoped' | 'global'
}

export async function handleCodingAgentSessionCommand(
  nsp: ReturnType<Server['of']>,
  socket: Socket,
  data: CodingAgentSessionCommandData,
  command: ParsedCodingAgentCommand,
  profile: string,
  sessionMap: Map<string, SessionState>,
): Promise<void> {
  const sessionId = String(data.session_id || '').trim()
  if (!sessionId) return
  socket.join(`session:${sessionId}`)
  const state = getOrCreateSession(sessionMap, sessionId)
  const displayCommand = `/${command.rawName}${command.args ? ` ${command.args}` : ''}`
  persistCommandMessage(sessionId, state, displayCommand)

  const emit = (event: string, payload: Record<string, unknown>) => {
    emitToSession(nsp, socket, sessionId, event, { ...payload })
  }

  const emitCommand = (payload: Record<string, unknown>) => {
    emitToSession(nsp, socket, sessionId, 'session.command', {
      event: 'session.command',
      session_id: sessionId,
      command: command.rawName,
      ok: true,
      ...payload,
    })
  }

  if (command.name === 'context' || command.name === 'usage') {
    try {
      const row = getSession(sessionId)
      const runInfo = codingAgentRunManager.getRunInfo(sessionId)
      if (row?.agent === 'pi' || runInfo?.agentId === 'pi') {
        const stats = await withPiRpcSession(sessionId, profile, state, () => (
          codingAgentRunManager.getPiSessionStats(sessionId)
        ))
        if (command.name === 'context') {
          const contextTokens = stats.contextUsage?.tokens ?? null
          const contextWindow = stats.contextUsage?.contextWindow || getModelContextLength({
            profile,
            model: data.model || row?.model || undefined,
            provider: data.provider || row?.provider || undefined,
          })
          const percent = stats.contextUsage?.percent
            ?? (contextTokens != null && contextWindow > 0
              ? Math.round((contextTokens / contextWindow) * 1000) / 10
              : null)
          emitCommand({
            action: 'context',
            terminal: !state.isWorking,
            message: `Context: ${contextTokens ?? 'unknown'} / ${contextWindow} tokens (${percent ?? 'unknown'}%).`,
            contextTokens,
            contextWindow,
            contextPercent: percent,
            source: 'pi',
          })
        } else {
          emitCommand({
            action: 'usage',
            terminal: !state.isWorking,
            message: `Usage: input ${stats.tokens.input}, output ${stats.tokens.output}, cache read ${stats.tokens.cacheRead}, cache write ${stats.tokens.cacheWrite}, total ${stats.tokens.total} tokens.`,
            inputTokens: stats.tokens.input,
            outputTokens: stats.tokens.output,
            cacheReadTokens: stats.tokens.cacheRead,
            cacheWriteTokens: stats.tokens.cacheWrite,
            totalTokens: stats.tokens.total,
            cost: stats.cost,
            source: 'pi',
          })
        }
        return
      }
      const usage = await calcAndUpdateUsage(sessionId, state, (event: string, payload: any) => {
        emit(event, payload)
      }, { nativeSource: 'coding_agent' })
      const contextWindow = getModelContextLength({
        profile,
        model: data.model || row?.model || undefined,
        provider: data.provider || row?.provider || undefined,
      })
      const totalTokens = usage.inputTokens + usage.outputTokens
      const percent = contextWindow > 0 ? Math.round((totalTokens / contextWindow) * 1000) / 10 : 0
      emitCommand({
        action: command.name,
        terminal: !state.isWorking,
        message: command.name === 'context'
          ? `Context: input ${usage.inputTokens}, output ${usage.outputTokens}, total ${totalTokens} / ${contextWindow} tokens (${percent}%).`
          : `Usage: input ${usage.inputTokens}, output ${usage.outputTokens}, total ${totalTokens} tokens.`,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens,
        contextWindow,
        contextPercent: percent,
      })
    } catch (err) {
      emitCommand({
        ok: false,
        action: command.name,
        terminal: !state.isWorking,
        message: `${command.name === 'context' ? 'Context' : 'Usage'} lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
    return
  }

  if (command.name === 'status') {
    const row = getSession(sessionId)
    const info = codingAgentRunManager.getRunInfo(sessionId)
    if (row?.agent === 'pi' || info?.agentId === 'pi') {
      try {
        const piState = await withPiRpcSession(sessionId, profile, state, () => (
          codingAgentRunManager.getPiSessionState(sessionId)
        ))
        const running = piState.isStreaming || piState.isCompacting
        const model = piState.model?.id || row?.model || info?.model || data.model || '-'
        const provider = piState.model?.provider || row?.provider || info?.provider || data.provider || '-'
        emitCommand({
          action: 'status',
          terminal: !running,
          message: [
            `Status: ${running ? 'running' : 'idle'}`,
            'agent: pi',
            `provider: ${provider}`,
            `model: ${model}`,
            `native session: ${piState.sessionId || row?.agent_native_session_id || '-'}`,
            `compacting: ${piState.isCompacting ? 'yes' : 'no'}`,
            `auto compact: ${piState.autoCompactionEnabled ? 'on' : 'off'}`,
          ].join(', '),
          isWorking: running,
          agent: 'pi',
          model,
          provider,
          nativeSessionId: piState.sessionId || row?.agent_native_session_id || null,
          nativeMessageCount: piState.messageCount,
          pendingMessageCount: piState.pendingMessageCount,
          thinkingLevel: piState.thinkingLevel,
          isCompacting: piState.isCompacting,
          autoCompactionEnabled: piState.autoCompactionEnabled,
          source: 'pi',
        })
      } catch (err) {
        emitCommand({
          ok: false,
          action: 'status',
          terminal: !state.isWorking,
          message: `Status lookup failed: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
      return
    }
    const running = Boolean(info?.running)
    const agent = row?.agent || info?.agentId || '-'
    const model = row?.model || info?.model || data.model || '-'
    const provider = row?.provider || info?.provider || data.provider || '-'
    emitCommand({
      action: 'status',
      terminal: !running,
      message: [
        `Status: ${running ? 'running' : 'idle'}`,
        `agent: ${agent}`,
        `provider: ${provider}`,
        `model: ${model}`,
        `native session: ${info?.nativeSessionId || row?.agent_native_session_id || '-'}`,
      ].join(', '),
      isWorking: running,
      agent,
      model,
      provider,
      nativeSessionId: info?.nativeSessionId || row?.agent_native_session_id || null,
    })
    return
  }

  if (command.name === 'compact') {
    const compactRow = getSession(sessionId)
    const compactInfo = codingAgentRunManager.getRunInfo(sessionId)
    const compactAgentId = compactRow?.agent || compactInfo?.agentId || ''
    if (compactAgentId === 'opencode') {
      emitCommand({
        ok: false,
        action: 'compact',
        terminal: !compactInfo?.running && !state.isWorking,
        message: 'OpenCode /compact is not available in Studio. Compaction is managed by OpenCode internally.',
        compacted: false,
      })
      return
    }
    if (compactAgentId === 'cursor') {
      emitCommand({
        ok: false,
        action: 'compact',
        terminal: !compactInfo?.running && !state.isWorking,
        message: 'Cursor /compact is not available in Studio. The Cursor CLI does not expose native compaction.',
        compacted: false,
      })
      return
    }
    const compactAgentName = compactAgentId === 'codex'
      ? 'Codex'
      : compactAgentId === 'pi'
        ? 'Pi'
        : compactAgentId === 'grok'
          ? 'Grok'
          : 'Claude Code'
    emitCommand({
      action: 'compact',
      terminal: false,
      started: true,
      message: `Native /compact sent to ${compactAgentName}.`,
    })
    try {
      let result: CodingAgentCompactResult
      try {
        if (compactAgentId === 'pi') {
          result = await withPiRpcSession<CodingAgentCompactResult>(sessionId, profile, state, () => (
            codingAgentRunManager.compact(sessionId, command.args)
          ))
        } else {
          result = await codingAgentRunManager.compact(sessionId, command.args)
        }
      } catch (err) {
        if (compactAgentId === 'pi') throw err
        if (!(err instanceof Error) || !err.message.includes('Coding agent session not found')) throw err
        result = await restartCodingAgentRunForCompact(sessionId, profile, state, command.args)
      }
      if ('started' in result) {
        return
      }
      emitCommand({
        action: 'compact',
        terminal: true,
        message: compactionCompletionMessage(result),
        compacted: result.compacted,
      })
    } catch (err) {
      emitCommand({
        ok: false,
        action: 'compact',
        terminal: true,
        message: `Compaction failed: ${err instanceof Error ? err.message : String(err)}`,
        compacted: false,
      })
    }
    return
  }
}

async function restartCodingAgentRunForCompact(
  sessionId: string,
  profile: string,
  state: SessionState,
  args = '',
): Promise<{ started: boolean } | {
  compacted: boolean
  beforeTokens?: number | null
  afterTokens?: number | null
}> {
  const row = getSession(sessionId)
  if (!row || (row.agent !== 'codex' && row.agent !== 'claude' && row.agent !== 'grok')) {
    throw new Error('Coding agent session not found or does not support native compaction')
  }
  if (row.agent === 'codex') {
    if (String(args || '').trim()) {
      throw new Error('Codex native compaction does not accept arguments')
    }
    return compactStoredCodingAgentSession(sessionId, profile)
  }
  const agentId = row.agent === 'grok' ? 'grok' : 'claude-code'
  await startCodingAgentRun(agentId, {
    sessionId,
    profile,
    mode: row.agent_mode === 'global' ? 'global' : 'scoped',
    workspace: row.workspace || undefined,
    agentNativeSessionId: row.agent_native_session_id || undefined,
    agentSessionId: row.agent_session_id || undefined,
  }, state)
  const result = await codingAgentRunManager.compact(sessionId, args)
  if (!('started' in result) && !('compacted' in result)) {
    throw new Error('Coding agent compact returned an unexpected result')
  }
  return result
}

async function withPiRpcSession<T>(
  sessionId: string,
  profile: string,
  state: SessionState,
  operation: () => Promise<T> | T,
): Promise<T> {
  const existing = codingAgentRunManager.getRunInfo(sessionId)
  if (existing && existing.agentId !== 'pi') {
    throw new Error(`Session is running ${existing.agentId}, not Pi`)
  }
  let started = false
  if (!existing) {
    const row = getSession(sessionId)
    if (!row || row.agent !== 'pi') throw new Error('Pi coding agent session not found')
    await startCodingAgentRun('pi', {
      sessionId,
      profile,
      mode: row.agent_mode === 'global' ? 'global' : 'scoped',
      workspace: row.workspace || undefined,
      agentNativeSessionId: row.agent_native_session_id || undefined,
      agentSessionId: row.agent_session_id || undefined,
    }, state)
    started = true
  }
  try {
    return await operation()
  } finally {
    if (started) {
      codingAgentRunManager.stop(sessionId, { reportClosed: false })
      state.isWorking = false
      state.runId = undefined
      state.abortController = undefined
      state.activeRunMarker = undefined
    }
  }
}

function compactionCompletionMessage(result: {
  compacted: boolean
  beforeTokens?: number | null
  afterTokens?: number | null
}): string {
  if (!result.compacted) return 'Compaction completed without changes.'
  const parts = ['Compaction completed.']
  if (result.beforeTokens != null) parts.push(`Before: ${result.beforeTokens} tokens.`)
  if (result.afterTokens != null) parts.push(`After: ${result.afterTokens} tokens.`)
  return parts.join(' ')
}

function persistCommandMessage(sessionId: string, state: SessionState, content: string) {
  const now = Math.floor(Date.now() / 1000)
  const id = addMessage({
    session_id: sessionId,
    role: 'command',
    content,
    timestamp: now,
  })
  state.messages.push({
    id: id || `command_${now}_${state.messages.length}`,
    session_id: sessionId,
    role: 'command',
    content,
    timestamp: now,
  })
  updateSessionStats(sessionId)
}

function emitToSession(
  nsp: ReturnType<Server['of']>,
  socket: Socket,
  sessionId: string,
  event: string,
  payload: Record<string, unknown>,
) {
  const tagged = { ...payload, session_id: sessionId }
  nsp.to(`session:${sessionId}`).emit(event, tagged)
  if (!nsp.adapter.rooms.get(`session:${sessionId}`)?.size && socket.connected) {
    socket.emit(event, tagged)
  }
}
