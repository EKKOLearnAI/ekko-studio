import type { Server, Socket } from 'socket.io'
import { chatCodingAgentRunManager as codingAgentRunManager } from '../../public/chat-agent-runtime'
import {
  handleChatCodingAgentSessionCommand as handleCodingAgentSessionCommand,
  parseChatCodingAgentSessionCommand as parseCodingAgentSessionCommand,
  sendChatCodingAgentRunInput as sendCodingAgentRunInput,
  startChatCodingAgentRun as startCodingAgentRun,
} from '../../public/chat-agent-runtime'
import { getOrCreateSession } from './compression'
import { contentBlocksToString, convertContentBlocksForCodingAgent } from './content-blocks'
import type { ContentBlock, SessionState } from './types'
import type { ChatCodingAgentId } from './types'
import { writeModelRunProfileToken } from './model-run-prompt'
import type { AuthenticatedUser } from '../../public/auth'
import { getSystemPrompt } from '../../public/runs/prompt'
import { getSession, updateSession } from '../../repositories/session-store'
import { logger } from '../../public/logging'

export interface CodingAgentRunSocketData {
  input: string | ContentBlock[]
  session_id?: string
  profile?: string
  provider?: string
  model?: string
  coding_agent_id?: ChatCodingAgentId
  agent_id?: ChatCodingAgentId
  mode?: 'scoped' | 'global'
  workspace?: string | null
  category_id?: number | null
  source?: string
  baseUrl?: string
  base_url?: string
  apiKey?: string
  api_key?: string
  apiMode?: any
  api_mode?: any
  reasoning_effort?: string
  agent_preset?: string
  push_enabled?: boolean
  instructions?: string
  session_source?: 'global_agent' | 'workflow' | 'group_chat'
  group_system_prompt?: string
  group_room_id?: string
  group_agent_id?: string
}

function codingAgentId(data: CodingAgentRunSocketData): Exclude<ChatCodingAgentId, 'ekko-agent'> {
  const value = data.coding_agent_id || data.agent_id || 'claude-code'
  if (value === 'codex' || value === 'pi' || value === 'grok' || (value === 'opencode' || value === 'dsh')) return value
  return 'claude-code'
}

export async function handleCodingAgentRun(
  nsp: ReturnType<Server['of']>,
  socket: Socket,
  data: CodingAgentRunSocketData,
  profile: string,
  sessionMap: Map<string, SessionState>,
) {
  const sessionId = String(data.session_id || '').trim()
  if (!sessionId) {
    socket.emit('run.failed', { event: 'run.failed', error: 'session_id is required for coding agent runs' })
    return
  }
  const socketUser = socket.data?.user as AuthenticatedUser | undefined

  socket.join(`session:${sessionId}`)
  const agentId = codingAgentId(data)
  const state = getOrCreateSession(sessionMap, sessionId)
  state.profile = profile
  state.source = data.session_source === 'group_chat' || data.source === 'group_chat'
    ? 'group_chat'
    : data.session_source === 'workflow' || data.source === 'workflow'
      ? 'workflow'
      : 'coding_agent'

  if (typeof data.input === 'string') {
    const command = parseCodingAgentSessionCommand(data.input)
    if (command) {
      await handleCodingAgentSessionCommand(nsp, socket, data, command, profile, sessionMap)
      return
    }
  }

  let runId = codingAgentRunManager.runIdForSession(sessionId)
  const mode = data.mode === 'global' ? 'global' : 'scoped'
  const storedSession = getSession(sessionId)
  if (storedSession && !storedSession.user_id && socketUser?.id != null) {
    updateSession(sessionId, { user_id: String(socketUser.id) })
  }
  const launchProvider = data.provider || (mode === 'scoped' ? storedSession?.provider || undefined : undefined)
  const launchModel = data.model || (mode === 'scoped' ? storedSession?.model || undefined : undefined)
  const launchApiMode = data.apiMode || data.api_mode || (mode === 'scoped' ? storedSession?.api_mode || undefined : undefined)
  const launchReasoningEffort = data.reasoning_effort ?? (mode === 'scoped' ? storedSession?.reasoning_effort || undefined : undefined)
  const groupSystemPrompt = String(data.group_system_prompt || '').trim()
  const groupRoomId = String(data.group_room_id || '').trim()
  const groupAgentId = String(data.group_agent_id || '').trim()
  if (groupSystemPrompt && (!groupRoomId || !groupAgentId)) {
    throw new Error('Group coding-agent run requires group_room_id and group_agent_id')
  }
  if (runId && !codingAgentRunManager.isSessionLaunchCompatible(sessionId, {
    agentId,
    mode,
    provider: launchProvider,
    model: launchModel,
    apiMode: launchApiMode,
    reasoningEffort: launchReasoningEffort,
  })) {
    codingAgentRunManager.stop(sessionId, { reportClosed: false })
    runId = undefined
  }
  if (!runId) {
    const started = await startCodingAgentRun(agentId, {
      sessionId,
      mode,
      profile,
      provider: launchProvider,
      model: launchModel,
      workspace: data.workspace,
      baseUrl: data.baseUrl || data.base_url,
      apiKey: data.apiKey || data.api_key,
      apiMode: launchApiMode,
      reasoningEffort: launchReasoningEffort,
      agentPreset: data.agent_preset,
      sessionSource: data.session_source,
      ...(groupSystemPrompt ? { groupSystemPrompt } : {}),
      ...(groupRoomId && groupAgentId
        ? { groupRuntimeScope: { roomId: groupRoomId, agentId: groupAgentId } }
        : {}),
    }, state)
    runId = started.agentSessionId
  }
  const persistedSession = getSession(sessionId)
  if (persistedSession && !persistedSession.user_id && socketUser?.id != null) {
    updateSession(sessionId, { user_id: String(socketUser.id) })
  }

  if (data.category_id !== undefined) {
    updateSession(sessionId, { category_id: data.category_id })
  }
  if (data.push_enabled !== undefined) {
    updateSession(sessionId, { push_enabled: data.push_enabled ? 1 : 0 })
  }

  state.isWorking = true
  state.runId = runId
  try {
    updateSession(sessionId, {
      ended_at: null,
      end_reason: null,
      last_active: Math.floor(Date.now() / 1000),
    })
  } catch (err) {
    logger.warn(err, '[chat-run-socket] failed to reopen coding-agent session %s', sessionId)
  }

  try {
    const codingInput = convertContentBlocksForCodingAgent(data.input)
    await writeModelRunProfileToken(socketUser, profile)
    const includeBaseSystemPrompt = agentId === 'claude-code' || agentId === 'codex' || agentId === 'pi' || agentId === 'grok' || (agentId === 'opencode' || agentId === 'dsh')
    const runPrompt = [
      groupSystemPrompt || (includeBaseSystemPrompt ? getSystemPrompt(undefined, { source: data.session_source || data.source }) : ''),
      String(data.instructions || '').trim() === groupSystemPrompt ? '' : String(data.instructions || '').trim(),
    ].filter(Boolean).join('\n')
    const sent = await (Array.isArray(data.input)
      ? sendCodingAgentRunInput(
        sessionId,
        codingInput.text,
        runPrompt,
        codingInput.images,
        contentBlocksToString(data.input),
      )
      : sendCodingAgentRunInput(sessionId, codingInput.text, runPrompt))
    return sent
  } catch (err) {
    if (!codingAgentRunManager.isSessionProcessing(sessionId)) {
      state.isWorking = false
      state.isAborting = false
      state.runId = undefined
      state.abortController = undefined
      state.activeRunMarker = undefined
      state.events = []
      state.responseRun = undefined
      try {
        updateSession(sessionId, {
          ended_at: Math.floor(Date.now() / 1000),
          end_reason: 'error',
        })
      } catch (updateErr) {
        logger.warn(updateErr, '[chat-run-socket] failed to write coding-agent send error end marker for %s', sessionId)
      }
    }
    throw err
  }
}
