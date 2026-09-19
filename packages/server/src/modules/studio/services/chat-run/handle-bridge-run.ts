import { hermesStudioMcpCapabilities } from './studio-mcp'
import { withTaskPlanTurnContext } from '../task-plan-runs'
/**
 * CLI Bridge run handler — handles runs that use the agent bridge
 * to communicate with Hermes CLI agent.
 */

import type { Server, Socket } from 'socket.io'
import { getSystemPrompt } from '../../public/runs/prompt'
import { getFirstSessionMessageByRole, getSession, getSessionMessageCountByRole, createSession, addMessage, updateSession, updateSessionStats } from '../../repositories/session-store'
import { logger, bridgeLogger } from '../../public/logging'
import { normalizeTokenUsage, recordSessionUsage } from '../usage/usage-recorder'
import type {
  PrimaryAgentBridgeClient as AgentBridgeClient,
  PrimaryAgentBridgeContextEstimate as AgentBridgeContextEstimate,
  PrimaryAgentBridgeMessage as AgentBridgeMessage,
  PrimaryAgentBridgeOutput as AgentBridgeOutput,
} from '../../public/chat-agent-runtime'
import { contentBlocksToString, convertContentBlocksForAgent, extractTextForPreview, isContentBlockArray } from './content-blocks'
import { buildCompressedHistory, buildDbSnapshotAwareHistory, forceCompressBridgeHistory, pushState, replaceState } from './compression'
import {
  calcAndUpdateUsage,
  contextTokensWithCachedOverhead,
  estimateUsageTokensFromMessages,
  getCachedBridgeContextOverhead,
  updateMessageContextTokenUsage,
} from './usage'
import {
  flushBridgePendingToDb,
  ensureOpenBridgeAssistantMessage,
  syncBridgeReasoningToMessage,
  recordBridgeToolStarted,
  recordBridgeToolCompleted,
  recordBridgeMoaDisplayTool,
} from './bridge-message'
import { summarizeToolArguments } from './response-utils'
import type {
  BackgroundContinuationContext,
  ChatRunSource,
  ContentBlock,
  HermesBackgroundContinuationContext,
  QueuedRun,
  SessionState,
} from './types'
import type { ChatMessage } from '../context-compressor'
import { resolveBridgeRunModelConfig, type RunModelGroup } from './model-config'
import { filterBridgeToolCallMarkupDelta, flushPendingToolCallMarkup } from './bridge-delta'
import { markAbortCompleted } from './abort'
import { buildOutboundRunEvent } from './resume-payload'
import { writeModelRunProfileToken } from './model-run-prompt'
import type { AuthenticatedUser } from '../../public/auth'
import { ensureHermesRunWorkspace } from './workspace'
import { observeRunChatPetEvent } from '../../public/pet-events'
import { completeWorkspaceRunCheckpoint, startWorkspaceRunCheckpoint } from './workspace-diff-tracker'
import { resolveAuthorizedProviderRuntimeCredentials } from '../../public/authorized-provider-runtime'
import { saveEnvValueForProfile } from '../../public/profile-config'

const BRIDGE_USAGE_FLUSH_DELAY_MS = 200
const BRIDGE_TITLE_EVENT_POLL_INTERVAL_MS = 500
const BRIDGE_TITLE_EVENT_POLL_TIMEOUT_MS = 45_000
const BRIDGE_GOAL_EVALUATE_TIMEOUT_MS = 120_000

type BridgeRunSource = Extract<ChatRunSource, 'cli' | 'global_agent' | 'workflow' | 'group_chat'>

function normalizeBridgeRunSource(source?: string | null, sessionSource?: string | null): BridgeRunSource {
  if (sessionSource === 'global_agent' || source === 'global_agent') return 'global_agent'
  if (sessionSource === 'group_chat' || source === 'group_chat') return 'group_chat'
  if (sessionSource === 'workflow' || source === 'workflow') return 'workflow'
  return 'cli'
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function parseBackgroundDelegation(
  toolName: string,
  output: string,
): { delegationId: string; status: string; payload: Record<string, unknown> } | null {
  if (toolName !== 'delegate_task') return null
  try {
    const payload = JSON.parse(output) as Record<string, unknown>
    const delegationId = stringValue(payload.delegation_id)
    if (!delegationId || payload.mode !== 'background') return null
    return { delegationId, status: stringValue(payload.status) || 'dispatched', payload }
  } catch {
    return null
  }
}

interface BridgeRunMetadata {
  autonomous?: boolean
  delegationId?: string
  queueId?: string
  backgroundDelegationIds: Set<string>
  originContext: Omit<HermesBackgroundContinuationContext, 'delegationId' | 'originRunId'>
}

function resultMessages(result: unknown): ChatMessage[] | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null
  const messages = (result as Record<string, unknown>).messages
  if (!Array.isArray(messages)) return null
  return structuredClone(messages) as ChatMessage[]
}

function backgroundPendingCount(state: SessionState): number {
  return Object.values(state.backgroundDelegations || {})
    .filter(delegation => delegation.status === 'running' || delegation.status === 'delivering')
    .length
}

function normalizeTitleText(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function fallbackTitleFromText(text: string, limit: number, ellipsis: boolean): string {
  const normalized = normalizeTitleText(text)
  if (!normalized) return ''
  if (normalized.length <= limit) return normalized
  return ellipsis ? `${normalized.slice(0, limit)}...` : normalized.slice(0, limit)
}

function isReplaceableLocalTitle(sessionId: string): boolean {
  const session = getSession(sessionId)
  if (!session) return false
  const current = normalizeTitleText(session.title)
  if (!current) return true
  const variants = new Set<string>([''])
  const preview = normalizeTitleText(session.preview)
  if (preview) {
    variants.add(preview)
    variants.add(fallbackTitleFromText(preview, 40, true))
    variants.add(fallbackTitleFromText(preview, 63, false))
    variants.add(fallbackTitleFromText(preview, 100, false))
  }
  const firstUser = getFirstSessionMessageByRole(sessionId, 'user')
  const firstUserText = normalizeTitleText(firstUser?.content)
  if (firstUserText) {
    variants.add(firstUserText)
    variants.add(fallbackTitleFromText(firstUserText, 40, true))
    variants.add(fallbackTitleFromText(firstUserText, 63, false))
    variants.add(fallbackTitleFromText(firstUserText, 100, false))
  }
  return variants.has(current)
}

function isBridgeSessionSource(source?: string | null): boolean {
  return source === 'cli' || source === 'global_agent'
}

function syncBridgeGeneratedTitle(sessionId: string, title: unknown, emit: (event: string, payload: any) => void): boolean {
  const nextTitle = normalizeTitleText(title)
  if (!nextTitle) return false
  const session = getSession(sessionId)
  if (!session || !isBridgeSessionSource(session.source)) return false
  if (!isReplaceableLocalTitle(sessionId)) {
    logger.info('[chat-run-socket] skipped Hermes generated title for manually titled session %s', sessionId)
    return false
  }
  if (normalizeTitleText(session.title) === nextTitle) return false
  updateSession(sessionId, {
    title: nextTitle,
    last_active: Math.floor(Date.now() / 1000),
  } as any)
  emit('session.title.updated', {
    event: 'session.title.updated',
    session_id: sessionId,
    title: nextTitle,
  })
  return true
}

function shouldPollBridgeGeneratedTitle(sessionId: string): boolean {
  const session = getSession(sessionId)
  if (!session || !isBridgeSessionSource(session.source)) return false
  const userMessageCount = getSessionMessageCountByRole(sessionId, 'user')
  return userMessageCount <= 2 && isReplaceableLocalTitle(sessionId)
}

function looksLikeAgentFailure(value: string): boolean {
  const text = value.replace(/\s+/g, ' ').trim()
  if (!text) return false

  return /\bAPI call failed after\b/i.test(text)
    || /\bHTTP\s+(?:4\d\d|5\d\d)\b/i.test(text)
    || /\b(?:401|403)\b.{0,100}\b(?:unauthorized|forbidden|authentication|auth|invalid api key|permission denied)\b/i.test(text)
    || /\b(?:unauthorized|forbidden|authentication|auth|invalid api key|permission denied)\b.{0,100}\b(?:401|403)\b/i.test(text)
    || /\b429\b.{0,100}\b(?:rate limit|too many requests|quota)\b/i.test(text)
    || /\b(?:rate limit|too many requests|quota)\b.{0,100}\b429\b/i.test(text)
    || /\b(?:500|502|503|504)\b.{0,100}\b(?:server error|bad gateway|service unavailable|gateway timeout|upstream|provider|request failed|api)\b/i.test(text)
    || /\b(?:server error|bad gateway|service unavailable|gateway timeout|upstream|provider|request failed|api)\b.{0,100}\b(?:500|502|503|504)\b/i.test(text)
    || /(?:无可用渠道|渠道不可用|认证失败|鉴权失败|额度不足|余额不足|请求失败|接口调用失败)/i.test(text)
    || /(?:请求|接口|模型|渠道|API).{0,20}(?:被限流|触发限流|因限流失败)/i.test(text)
    || /(?:限流|频率限制).{0,20}(?:失败|错误|重试|稍后)/i.test(text)
}

function looksLikeStandaloneAgentFailure(value: string): boolean {
  const text = value.replace(/\s+/g, ' ').trim()
  // A provider failure returned as final_response is normally a compact error.
  // Do not scan an arbitrary long-form successful answer for incidental terms
  // such as "登录限流" or documentation about HTTP error handling.
  return text.length > 0 && text.length <= 2_000 && looksLikeAgentFailure(text)
}

export function bridgeTerminalError(chunk: Pick<AgentBridgeOutput, 'status' | 'error' | 'result'>): string | null {
  const result = chunk.result && typeof chunk.result === 'object' && !Array.isArray(chunk.result)
    ? chunk.result as Record<string, unknown>
    : null
  const resultError = result
    ? stringValue(result.error)
      || stringValue(result.exception)
    : ''
  const resultMessage = result ? stringValue(result.message) : ''
  const finalResponse = result ? stringValue(result.final_response) : ''

  if (chunk.status === 'error') {
    return stringValue(chunk.error) || resultError || resultMessage || finalResponse || 'Agent run failed'
  }

  if (result?.failed === true || result?.completed === false) {
    return resultError || resultMessage || finalResponse || 'Agent reported failure'
  }

  if (resultError && looksLikeAgentFailure(resultError)) return resultError
  if (result?.completed === true) return null
  if (!finalResponse && resultMessage && looksLikeAgentFailure(resultMessage)) return resultMessage
  if (finalResponse && looksLikeStandaloneAgentFailure(finalResponse)) return finalResponse

  return null
}

function findOpenAssistantMessage(state: SessionState, runMarker: string) {
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    const message = state.messages[i]
    if (message.runMarker === runMarker && message.role === 'assistant' && message.finish_reason == null) return message
  }
  return undefined
}

function flushPendingToolMarkupToAssistant(
  state: SessionState,
  runMarker: string,
  runId: string,
  emit: (event: string, payload: any) => void,
): string {
  const pendingMarkup = flushPendingToolCallMarkup(state)
  if (!pendingMarkup) return ''

  state.bridgeOutput = (state.bridgeOutput || '') + pendingMarkup
  state.bridgePendingAssistantContent = (state.bridgePendingAssistantContent || '') + pendingMarkup
  const last = findOpenAssistantMessage(state, runMarker)
  if (last) {
    last.content += pendingMarkup
  }
  emit('message.delta', {
    event: 'message.delta',
    run_id: runId,
    delta: pendingMarkup,
    output: state.bridgeOutput,
  })
  return pendingMarkup
}

function processBridgeTextDelta(
  state: SessionState,
  sessionId: string,
  runMarker: string,
  runId: string,
  rawDelta: string,
  emit: (event: string, payload: any) => void,
): void {
  const delta = filterBridgeToolCallMarkupDelta(state, rawDelta)
  if (!delta) return
  state.bridgeOutput = (state.bridgeOutput || '') + delta
  state.bridgePendingAssistantContent = (state.bridgePendingAssistantContent || '') + delta
  const last = [...state.messages].reverse().find(m => m.runMarker === runMarker)
  if (last?.role === 'assistant' && last.finish_reason == null) {
    last.content += delta
    syncBridgeReasoningToMessage(last, state.bridgePendingReasoningContent)
  } else {
    state.messages.push({
      id: state.messages.length + 1,
      session_id: sessionId,
      runMarker,
      role: 'assistant',
      content: delta,
      reasoning: state.bridgePendingReasoningContent || null,
      reasoning_content: state.bridgePendingReasoningContent || null,
      timestamp: Math.floor(Date.now() / 1000),
    })
  }
  emit('message.delta', {
    event: 'message.delta',
    run_id: runId,
    delta,
    output: state.bridgeOutput,
  })
}

function processBridgeInterimMessage(
  state: SessionState,
  sessionId: string,
  runMarker: string,
  runId: string,
  text: string,
  alreadyStreamed: boolean,
  emit: (event: string, payload: any) => void,
): void {
  if (!text.trim()) return

  // Hermes treats the interim payload as authoritative. A provider may have
  // streamed only a prefix, or may have delivered commentary solely through
  // this callback, so replace the current segment instead of appending text.
  const message = ensureOpenBridgeAssistantMessage(state, sessionId, runMarker)
  const previous = message.content || state.bridgePendingAssistantContent || ''
  const output = state.bridgeOutput || ''
  if (previous && output.endsWith(previous)) {
    state.bridgeOutput = output.slice(0, -previous.length) + text
  } else if (!previous) {
    state.bridgeOutput = output + text
  } else if (!output.endsWith(text)) {
    state.bridgeOutput = output + text
  }
  state.bridgePendingAssistantContent = text
  message.content = text
  syncBridgeReasoningToMessage(message, state.bridgePendingReasoningContent)
  flushBridgePendingToDb(state, sessionId, runMarker)

  emit('message.interim', {
    event: 'message.interim',
    run_id: runId,
    text,
    already_streamed: alreadyStreamed,
    output: state.bridgeOutput,
  })
}

function finiteToken(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined
}

function cacheBridgeContext(state: SessionState, data: Record<string, unknown> | AgentBridgeContextEstimate, workspace?: string | null) {
  const fixedContextTokens = finiteToken(data.fixed_context_tokens)
  if (fixedContextTokens == null) return
  const resolvedWorkspace = String(workspace || '').trim()
  state.bridgeContext = {
    fixedContextTokens,
    systemPromptTokens: finiteToken(data.system_prompt_tokens),
    toolTokens: finiteToken(data.tool_tokens),
    systemPromptChars: finiteToken(data.system_prompt_chars),
    toolCount: finiteToken(data.tool_count),
    toolNames: Array.isArray(data.tool_names) ? data.tool_names.map(String) : undefined,
    profile: typeof data.profile === 'string' ? data.profile : state.bridgeContext?.profile,
    model: typeof data.model === 'string' ? data.model : state.bridgeContext?.model,
    provider: typeof data.provider === 'string' ? data.provider : state.bridgeContext?.provider,
    ...(resolvedWorkspace ? { workspace: resolvedWorkspace } : {}),
  }
}

function bridgeContextMatches(
  state: SessionState,
  expected: { profile: string; model?: string | null; provider?: string | null; workspace?: string | null },
): boolean {
  const context = state.bridgeContext
  if (!context) return false
  if (context.profile && context.profile !== expected.profile) return false
  if (expected.model && context.model && context.model !== expected.model) return false
  if (expected.provider && context.provider && context.provider !== expected.provider) return false
  const expectedWorkspace = String(expected.workspace || '').trim()
  if (expectedWorkspace && context.workspace !== expectedWorkspace) return false
  return true
}

async function ensureBridgeFixedContext(args: {
  sessionId: string
  profile: string
  model?: string | null
  provider?: string | null
  workspace?: string | null
  instructions: string
  state: SessionState
  bridge: AgentBridgeClient
  refresh?: boolean
  backgroundDelegationEnabled?: boolean
}): Promise<number | undefined> {
  const cached = bridgeContextMatches(args.state, args)
    ? getCachedBridgeContextOverhead(args.state)
    : undefined
  if (!args.refresh && cached != null) return cached

  try {
    const estimate = await args.bridge.contextEstimate(
      args.sessionId,
      [],
      args.instructions,
      args.profile,
      {
        model: args.model ?? undefined,
        provider: args.provider ?? undefined,
        workspace: args.workspace ?? undefined,
        ...(args.backgroundDelegationEnabled !== undefined
          ? { background_delegation_enabled: args.backgroundDelegationEnabled }
          : {}),
      },
    )
    cacheBridgeContext(args.state, estimate, args.workspace)
    const fixedContextTokens = getCachedBridgeContextOverhead(args.state)
    bridgeLogger.info({
      sessionId: args.sessionId,
      profile: args.profile,
      model: args.model,
      provider: args.provider,
      toolCount: estimate.tool_count,
      systemPromptChars: estimate.system_prompt_chars,
      fixedContextTokens,
    }, '[chat-run-socket] fixed context estimate')
    return fixedContextTokens
  } catch (err) {
    bridgeLogger.warn({
      err: err instanceof Error ? { message: err.message, name: err.name } : err,
      sessionId: args.sessionId,
      profile: args.profile,
      model: args.model,
      provider: args.provider,
      cachedFixedContextTokens: cached,
    }, '[chat-run-socket] fixed context estimate failed')
    return cached
  }
}

export async function handleBridgeRun(
  nsp: ReturnType<Server['of']>,
  socket: Socket,
  data: { task_plan_context_id?: string; input: string | ContentBlock[]; display_input?: string | ContentBlock[] | null; display_role?: 'user' | 'command'; storage_message?: string; session_id?: string; model?: string; provider?: string; model_groups?: RunModelGroup[]; instructions?: string; workspace?: string | null; category_id?: number | null; source?: string; session_source?: 'global_agent' | 'workflow' | 'group_chat'; queue_id?: string; peerExcludeSocketId?: string; reasoning_effort?: string; push_enabled?: boolean; background_delegation_enabled?: boolean; one_shot_model?: boolean; background_delegation_id?: string; background_claim_id?: string; autonomous?: boolean; onEvent?: (event: string, payload: any) => void },
  profile: string,
  sessionMap: Map<string, SessionState>,
  bridge: AgentBridgeClient,
  skipUserMessage = false,
  loadSessionStateFromDbFn: (sid: string, sessionMap: Map<string, SessionState>) => Promise<SessionState>,
  dequeueNextQueuedRun: (socket: Socket, sessionId: string, fallbackProfile?: string) => void,
  backgroundContinuationContext?: BackgroundContinuationContext,
) {
  const { input, session_id, instructions } = data
  const runSource = normalizeBridgeRunSource(data.source, data.session_source)
  // Ordinary single-chat Hermes agents enable background delegation by default.
  // Workflow and group-chat callers pass false explicitly at their own creation
  // boundaries and remain disabled independently of this default.
  const backgroundDelegationEnabled = data.background_delegation_enabled !== false
  if (!session_id) {
    socket.emit('run.failed', { event: 'run.failed', queue_id: data.queue_id, error: 'session_id is required for cli source' })
    return
  }
  const socketUser = socket.data.user as AuthenticatedUser | undefined
  const callbackContext = data.background_delegation_id
    && backgroundContinuationContext?.runtime === 'hermes'
    && backgroundContinuationContext.delegationId === data.background_delegation_id
    && backgroundContinuationContext.sessionId === session_id
    ? backgroundContinuationContext
    : undefined

  // `instructions` already carries the Studio guidance: the chat-run socket
  // composes it before delegating here. Prepending it again duplicated the whole
  // block — MCP usage plus the output-format rules — byte for byte in the system
  // message of every request. Compose only when a caller hands us nothing.
  let fullInstructions = callbackContext?.instructions
    || instructions
    || getSystemPrompt(undefined, { source: data.session_source || data.source, mcpCapabilities: await hermesStudioMcpCapabilities(profile) })
  const sessionRow = getSession(session_id)
  if (sessionRow && !sessionRow.user_id && socketUser?.id != null) {
    updateSession(session_id, { user_id: String(socketUser.id) })
  }
  const reasoningEffort = callbackContext?.reasoningEffort ?? data.reasoning_effort ?? sessionRow?.reasoning_effort
  const requestedWorkspace = callbackContext
    ? callbackContext.workspace
    : sessionRow?.workspace || data.workspace
  const workspace = await ensureHermesRunWorkspace(profile, requestedWorkspace)
  const shouldEmitWorkspaceUpdate = Boolean(workspace && !sessionRow?.workspace)
  if (sessionRow && !sessionRow.workspace) updateSession(session_id, { workspace })
  const sessionModel = callbackContext?.model || sessionRow?.model || ''
  const sessionProvider = callbackContext?.provider || sessionRow?.provider || ''
  const selectedModelConfig = await resolveBridgeRunModelConfig({
    profile,
    sessionModel,
    sessionProvider,
    requestedModel: callbackContext?.model || data.model,
    requestedProvider: callbackContext?.provider || data.provider,
    modelGroups: data.model_groups,
    preferRequested: Boolean(callbackContext) || data.one_shot_model === true,
    preserveAuthorizedProvider: true,
  })
  const resolvedModel = selectedModelConfig.model
  const selectedProvider = selectedModelConfig.provider
  if (selectedProvider === 'claude-oauth') {
    // Studio owns OAuth refresh. Resolving here happens before context
    // estimation can create a cached Python Agent and synchronizes Claude's
    // fresh access token into the profile ANTHROPIC_TOKEN environment.
    const credentials = await resolveAuthorizedProviderRuntimeCredentials({
      profile,
      provider: selectedProvider,
      model: resolvedModel,
    })
    // Hermes Agent's native Anthropic bridge reads Claude OAuth only from
    // ANTHROPIC_TOKEN. This is intentionally Claude-specific: no other
    // authorized provider or provider environment is touched here.
    await saveEnvValueForProfile(profile, 'ANTHROPIC_TOKEN', credentials.apiKey)
  }
  const resolvedProvider = selectedProvider === 'claude-oauth' ? 'anthropic' : selectedProvider
  if (sessionRow && !callbackContext && data.one_shot_model !== true) {
    const updates: { model?: string; provider?: string } = {}
    if (resolvedModel && sessionRow.model !== resolvedModel) updates.model = resolvedModel
    if (selectedProvider && sessionRow.provider !== selectedProvider) updates.provider = selectedProvider
    if (Object.keys(updates).length > 0) updateSession(session_id, updates)
  }
  await writeModelRunProfileToken(socketUser, profile)
  const runPrompt = [
    'When calling Hermes Web UI endpoints from tools or skills, include the current Hermes profile as the X-Hermes-Profile header if the endpoint supports profile-scoped behavior.',
  ].filter(Boolean).join('\n')
  if (!callbackContext?.instructions) {
    fullInstructions = `\n${runPrompt}\n${fullInstructions}`
  }

  const runMarker = `cli_run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const now = Math.floor(Date.now() / 1000)
  let state = sessionMap.get(session_id)
  if (!state) {
    state = getSession(session_id)
      ? await loadSessionStateFromDbFn(session_id, sessionMap)
      : { messages: [], isWorking: false, events: [], queue: [] }
    sessionMap.set(session_id, state)
  }
  if (sessionRow) {
    try {
      updateSession(session_id, { ended_at: null, end_reason: null, last_active: now })
    } catch (err) {
      bridgeLogger.warn(err, '[chat-run-socket] failed to reopen session %s for bridge run', session_id)
    }
  }

  state.isWorking = true
  state.isAborting = false
  state.events = []
  state.profile = profile
  state.source = runSource
  state.activeRunMarker = runMarker
  state.runId = undefined
  state.abortController = undefined
  state.bridgeOutput = ''
  state.bridgePendingAssistantContent = ''
  state.bridgeAssistantMessageId = undefined
  state.bridgePendingReasoningContent = ''
  state.bridgePendingToolCallMarkup = ''
  state.bridgeToolCounter = 0
  state.bridgePendingTools = []
  state.responseRun = undefined

  const displayInput = data.display_input === undefined ? input : data.display_input
  const inputStr = displayInput == null ? '' : contentBlocksToString(displayInput)
  const actualInputStr = contentBlocksToString(input)
  const storageInputStr = data.storage_message !== undefined ? data.storage_message : inputStr
  const shouldStoreInputInsteadOfDisplay = data.storage_message !== undefined && data.storage_message !== inputStr
  const currentInputUsage = estimateUsageTokensFromMessages([{ role: 'user', content: actualInputStr }])
  const currentInputTokens = currentInputUsage.inputTokens
  const shouldPersistUserMessage = !skipUserMessage && displayInput !== null
  const displayRole = data.display_role === 'command' ? 'command' : 'user'
  const storageRole = shouldStoreInputInsteadOfDisplay ? 'user' : displayRole
  const displayRoleForStorage = shouldStoreInputInsteadOfDisplay ? displayRole : null
  const displayContentForStorage = shouldStoreInputInsteadOfDisplay ? inputStr : null
  let messageId: number | string | undefined

  if (shouldPersistUserMessage) {
    state.messages.push({
      id: state.messages.length + 1,
      session_id,
      runMarker,
      role: storageRole,
      content: storageInputStr,
      display_role: displayRoleForStorage,
      display_content: displayContentForStorage,
      run_marker: runMarker,
      timestamp: now,
    })

    if (!getSession(session_id)) {
      const previewText = extractTextForPreview(displayInput || input)
      const preview = previewText.replace(/[\r\n]/g, ' ').substring(0, 100)
      createSession({ id: session_id, profile, source: runSource, user_id: socketUser?.id, model: resolvedModel, provider: selectedProvider, reasoning_effort: reasoningEffort || '', title: preview, workspace, category_id: data.category_id, push_enabled: data.push_enabled })
    }
    messageId = addMessage({
      session_id,
      role: storageRole,
      content: storageInputStr,
      display_role: displayRoleForStorage,
      display_content: displayContentForStorage,
      timestamp: now,
    })
    data.onEvent?.('message.created', {
      event: 'message.created',
      session_id,
      queue_id: data.queue_id,
      message_id: messageId,
      role: displayRole,
      content: inputStr,
      timestamp: now,
    })
  } else if (!getSession(session_id)) {
    const previewText = displayInput === null ? extractTextForPreview(input) : extractTextForPreview(displayInput || input)
    const preview = previewText.replace(/[\r\n]/g, ' ').substring(0, 100)
    createSession({ id: session_id, profile, source: runSource, user_id: socketUser?.id, model: resolvedModel, provider: selectedProvider, reasoning_effort: reasoningEffort || '', title: preview, workspace, category_id: data.category_id, push_enabled: data.push_enabled })
  }

  socket.join(`session:${session_id}`)
  if (shouldPersistUserMessage) {
    const peerTarget = data.peerExcludeSocketId
      ? nsp.to(`session:${session_id}`).except(data.peerExcludeSocketId)
      : socket.to(`session:${session_id}`)
    peerTarget.emit('run.peer_user_message', {
      event: 'run.peer_user_message',
      session_id,
      message: {
        id: data.queue_id || messageId,
        role: displayRoleForStorage || storageRole,
        content: displayContentForStorage || storageInputStr,
        timestamp: now,
      },
    })
  }
  const emit = (event: string, payload: any) => {
    const tagged = { ...payload, session_id }
    observePetEvent(profile, event, tagged)
    data.onEvent?.(event, tagged)
    const outbound = buildOutboundRunEvent(event, tagged)
    nsp.to(`session:${session_id}`).emit(event, outbound)
    if (!data.onEvent && !nsp.adapter.rooms.get(`session:${session_id}`)?.size && socket.connected) {
      socket.emit(event, outbound)
    }
  }
  if (shouldEmitWorkspaceUpdate) {
    emit('session.workspace.updated', {
      event: 'session.workspace.updated',
      workspace,
    })
  }

  if (data.background_delegation_id && !callbackContext) {
    const error = `Background callback ${data.background_delegation_id} cannot continue because its origin context is unavailable.`
    bridgeLogger.error({ sessionId: session_id, delegationId: data.background_delegation_id }, error)
    if (data.background_claim_id) {
      try {
        await bridge.completeBackgroundNotification(
          session_id,
          profile,
          data.background_delegation_id,
          data.background_claim_id,
        )
      } catch (err) {
        bridgeLogger.warn(err, '[chat-run-socket] failed to acknowledge background callback with missing context')
      }
    }
    if (state.backgroundDelegations?.[data.background_delegation_id]) {
      state.backgroundDelegations[data.background_delegation_id] = {
        ...state.backgroundDelegations[data.background_delegation_id],
        status: 'failed',
        updatedAt: Date.now(),
      }
    }
    state.isWorking = false
    state.profile = undefined
    state.runId = undefined
    state.activeRunMarker = undefined
    state.events = []
    emit('run.failed', {
      event: 'run.failed',
      error,
      queue_remaining: state.queue.length,
      background_pending: backgroundPendingCount(state),
      autonomous: true,
      delegation_id: data.background_delegation_id,
      queue_id: data.queue_id,
    })
    if (state.queue.length > 0) dequeueNextQueuedRun(socket, session_id, profile)
    return
  }

  const history = callbackContext
    ? structuredClone(callbackContext.messages)
    : await buildCompressedHistory(
      session_id, profile,
      '',
      undefined,
      emit,
      sessionMap,
      { model: resolvedModel, provider: resolvedProvider },
      async (_messages, localMessageTokens) => {
        const fixedContextTokens = await ensureBridgeFixedContext({
          sessionId: session_id,
          profile,
          model: resolvedModel,
          provider: resolvedProvider,
          workspace,
          instructions: fullInstructions,
          state,
          bridge,
          refresh: true,
          backgroundDelegationEnabled,
        })
        const contextTokens = fixedContextTokens == null
          ? localMessageTokens
          : fixedContextTokens + localMessageTokens
        bridgeLogger.info({
          sessionId: session_id,
          profile,
          model: resolvedModel,
          provider: resolvedProvider,
          fixedContextTokens,
          messageTokens: localMessageTokens,
          contextTokens,
        }, '[chat-run-socket] local context estimate')
        return contextTokens
      },
      currentInputTokens,
    )
  const bridgeHistory = history
  let backgroundNotificationAccepted = false

  try {
    const originalBridgeInput = isContentBlockArray(input)
      ? await convertContentBlocksForAgent(input)
      : input
    const bridgeInput = withTaskPlanTurnContext(originalBridgeInput, data.task_plan_context_id)
    const runMetadata: BridgeRunMetadata = {
      autonomous: data.autonomous === true,
      delegationId: data.background_delegation_id,
      queueId: data.queue_id,
      backgroundDelegationIds: new Set<string>(),
      originContext: {
        runtime: 'hermes',
        version: 1,
        sessionId: session_id,
        messages: [
          ...structuredClone(bridgeHistory),
          { role: 'user', content: structuredClone(bridgeInput) } as ChatMessage,
        ],
        model: resolvedModel,
        provider: selectedProvider,
        profile,
        instructions: fullInstructions,
        workspace,
        reasoningEffort,
      },
    }
    const bridgeStorageInput = data.storage_message !== undefined
      ? data.storage_message
      : data.task_plan_context_id || isContentBlockArray(input)
        ? inputStr
        : undefined
    logger.info('[chat-run-socket] starting CLI bridge run for session %s', session_id)
    bridgeLogger.info({
      sessionId: session_id,
      profile,
      inputChars: inputStr.length,
      historyMessages: history.length,
      hasInstructions: Boolean(fullInstructions),
      multimodalInput: isContentBlockArray(input),
    }, '[chat-run-socket] starting CLI bridge run')
    const started = await bridge.chat(
      session_id,
      bridgeInput as AgentBridgeMessage,
      bridgeHistory,
      fullInstructions,
      profile,
      {
        ...(bridgeStorageInput !== undefined ? { storage_message: bridgeStorageInput } : {}),
        ...(resolvedModel ? { model: resolvedModel } : {}),
        ...(resolvedProvider ? { provider: resolvedProvider } : {}),
        ...(workspace ? { workspace } : {}),
        // Creation fallback when this chat is the first operation for the
        // cached AgentSession (for example if context estimation was skipped).
        background_delegation_enabled: backgroundDelegationEnabled,
        // Local patch (reasoning-effort): per-session reasoning effort override.
        ...(runMetadata.originContext.reasoningEffort
          ? { reasoning_effort: runMetadata.originContext.reasoningEffort }
          : {}),
      },
    )
    state.runId = started.run_id
    if (data.background_delegation_id && data.background_claim_id) {
      await bridge.completeBackgroundNotification(
        session_id,
        profile,
        data.background_delegation_id,
        data.background_claim_id,
      )
      backgroundNotificationAccepted = true
      if (state.backgroundContinuationContexts) {
        delete state.backgroundContinuationContexts[data.background_delegation_id]
      }
    }
    try {
      startWorkspaceRunCheckpoint({
        sessionId: session_id,
        runId: started.run_id,
        workspace,
      })
    } catch (err) {
      bridgeLogger.warn({ err, sessionId: session_id, runId: started.run_id }, '[workspace-diff] failed to start run checkpoint')
    }
    bridgeLogger.info({
      sessionId: session_id,
      runId: started.run_id,
      status: started.status,
    }, '[chat-run-socket] CLI bridge run started')
    pushState(sessionMap, session_id, 'run.started', {
      event: 'run.started',
      run_id: started.run_id,
      queue_id: data.queue_id,
      queue_length: state.queue.length || 0,
      autonomous: data.autonomous === true,
      delegation_id: data.background_delegation_id,
    })
    emit('run.started', {
      event: 'run.started',
      run_id: started.run_id,
      queue_id: data.queue_id,
      queue_length: state.queue.length || 0,
      autonomous: data.autonomous === true,
      delegation_id: data.background_delegation_id,
    })

    let lastChunk: AgentBridgeOutput | null = null
    let sawTerminalChunk = false
    for await (const chunk of bridge.streamOutput(started.run_id)) {
      lastChunk = chunk
      await applyBridgeChunkAsync(
        nsp,
        socket,
        state,
        session_id,
        runMarker,
        chunk,
        emit,
        profile,
        sessionMap,
        bridge,
        dequeueNextQueuedRun,
        fullInstructions,
        { model: resolvedModel, provider: resolvedProvider },
        runSource,
        workspace,
        currentInputTokens,
        shouldPersistUserMessage && displayRole === 'user',
        data.model_groups,
        runMetadata,
      )
      if (chunk.done) {
        sawTerminalChunk = true
        void pollBridgeGeneratedTitleAfterRun(bridge, session_id, profile, emit)
        break
      }
    }
    if (!sawTerminalChunk && state.activeRunMarker === runMarker && state.isWorking) {
      bridgeLogger.warn({
        sessionId: session_id,
        runId: started.run_id,
      }, '[chat-run-socket] bridge stream ended without terminal chunk; completing local run state')
      const terminalChunk: AgentBridgeOutput = {
        ok: true,
        run_id: lastChunk?.run_id || started.run_id,
        session_id,
        status: 'complete',
        delta: '',
        cursor: typeof lastChunk?.cursor === 'number' ? lastChunk.cursor : 0,
        output: lastChunk?.output || state.bridgeOutput || '',
        done: true,
        result: lastChunk?.result,
        error: lastChunk?.error ?? null,
        events: [],
        event_cursor: typeof lastChunk?.event_cursor === 'number' ? lastChunk.event_cursor : 0,
      }
      await applyBridgeChunkAsync(
        nsp,
        socket,
        state,
        session_id,
        runMarker,
        terminalChunk,
        emit,
        profile,
        sessionMap,
        bridge,
        dequeueNextQueuedRun,
        fullInstructions,
        { model: resolvedModel, provider: resolvedProvider },
        runSource,
        workspace,
        currentInputTokens,
        shouldPersistUserMessage && displayRole === 'user',
        data.model_groups,
        runMetadata,
      )
    }
  } catch (err: any) {
    if (data.background_delegation_id && data.background_claim_id && !backgroundNotificationAccepted) {
      void bridge.releaseBackgroundNotification(
        session_id,
        profile,
        data.background_delegation_id,
        data.background_claim_id,
      ).catch((releaseErr: unknown) => {
        bridgeLogger.warn(releaseErr, '[chat-run-socket] failed to release background notification claim %s', data.background_delegation_id)
      })
    }
    if (state.activeRunMarker !== runMarker) return
    if (!state.isWorking) return
    const queueLen = state.queue?.length ?? 0
    state.isWorking = false
    state.isAborting = false
    state.profile = undefined
    state.runId = undefined
    state.activeRunMarker = undefined
    state.events = []
    state.bridgePendingToolCallMarkup = undefined
    flushBridgePendingToDb(state, session_id, runMarker)
    updateSessionStats(session_id)
    const message = err instanceof Error ? err.message : String(err)
    const errUsage = await calcAndUpdateUsage(session_id, state, emit)
    const errContextTokens = await refreshFinalContextUsage({
      sessionId: session_id,
      profile,
      model: resolvedModel,
      provider: resolvedProvider,
      workspace,
      instructions: fullInstructions,
      state,
      usage: errUsage,
      emit,
      bridge,
    })
    emit('run.failed', {
      event: 'run.failed',
      error: message,
      inputTokens: errUsage.inputTokens,
      outputTokens: errUsage.outputTokens,
      contextTokens: errContextTokens,
      queue_remaining: queueLen,
      background_pending: backgroundPendingCount(state),
      autonomous: data.autonomous === true,
      delegation_id: data.background_delegation_id,
      queue_id: data.queue_id,
    })
    if (queueLen > 0) {
      dequeueNextQueuedRun(socket, session_id)
    } else {
      try {
        updateSession(session_id, { ended_at: Math.floor(Date.now() / 1000), end_reason: 'error' })
      } catch (endErr) {
        bridgeLogger.warn(endErr, '[chat-run-socket] failed to write ended_at for session %s', session_id)
      }
    }
  }
}

function latestAssistantText(state: SessionState): string {
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    const message = state.messages[i]
    if (message.role === 'assistant') return message.content || ''
  }
  return ''
}

export async function resumeBridgeRun(
  nsp: ReturnType<Server['of']>,
  socket: Socket,
  args: {
    sessionId: string
    runId: string
    profile: string
    instructions: string
    model?: string | null
    provider?: string | null
    workspace?: string | null
    source?: string | null
    onEvent?: (event: string, payload: any) => void
  },
  sessionMap: Map<string, SessionState>,
  bridge: AgentBridgeClient,
  dequeueNextQueuedRun: (socket: Socket, sessionId: string, fallbackProfile?: string) => void,
) {
  const { sessionId, runId, profile, instructions } = args
  const runSource = normalizeBridgeRunSource(args.source)
  let state = sessionMap.get(sessionId)
  if (!state) {
    state = { messages: [], isWorking: false, events: [], queue: [] }
    sessionMap.set(sessionId, state)
  }

  const runMarker = state.activeRunMarker || `cli_resume_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  state.isWorking = true
  state.isAborting = state.isAborting === true
  state.profile = profile
  state.source = runSource
  state.runId = runId
  state.activeRunMarker = runMarker
  state.bridgeOutput = state.bridgeOutput || latestAssistantText(state)
  state.bridgePendingAssistantContent = state.bridgePendingAssistantContent || ''
  state.bridgePendingReasoningContent = state.bridgePendingReasoningContent || ''
  state.bridgePendingToolCallMarkup = state.bridgePendingToolCallMarkup || ''
  state.bridgePendingTools = state.bridgePendingTools || []
  state.bridgeToolCounter = state.bridgeToolCounter || 0

  const emit = (event: string, payload: any) => {
    const tagged = { ...payload, session_id: sessionId }
    observePetEvent(profile, event, tagged)
    args.onEvent?.(event, tagged)
    const outbound = buildOutboundRunEvent(event, tagged)
    nsp.to(`session:${sessionId}`).emit(event, outbound)
    if (!nsp.adapter.rooms.get(`session:${sessionId}`)?.size && socket.connected) {
      socket.emit(event, outbound)
    }
  }

  let cursor = 0
  let eventCursor = 0
  try {
    const snapshot = await bridge.getResult(runId)
    const deltas = Array.isArray(snapshot.deltas) ? snapshot.deltas.map(String) : []
    const snapshotEvents = Array.isArray(snapshot.events) ? snapshot.events : []
    for (const event of snapshotEvents) {
      if (!event || typeof event !== 'object' || Array.isArray(event)) continue
      const bridgeEvent = event as Record<string, unknown>
      if (bridgeEvent.event === 'model.usage') {
        recordBridgeModelUsage(sessionId, runId, bridgeEvent, profile, {
          model: args.model,
          provider: args.provider,
        })
      }
    }
    const output = typeof snapshot.output === 'string' ? snapshot.output : deltas.join('')
    const persisted = state.bridgeOutput || ''
    const missingOutput = output && output.startsWith(persisted) ? output.slice(persisted.length) : ''
    if (missingOutput) {
      await applyBridgeChunkAsync(
        nsp,
        socket,
        state,
        sessionId,
        runMarker,
        {
          ok: true,
          run_id: runId,
          session_id: sessionId,
          status: 'running',
          delta: missingOutput,
          cursor: deltas.length,
          output,
          done: false,
          events: [],
          event_cursor: snapshotEvents.length,
          error: null,
        },
        emit,
        profile,
        sessionMap,
        bridge,
        dequeueNextQueuedRun,
        instructions,
        { model: args.model, provider: args.provider },
        runSource,
        args.workspace,
      )
    }
    cursor = deltas.length
    eventCursor = snapshotEvents.length
  } catch (err) {
    bridgeLogger.warn({
      err: err instanceof Error ? { message: err.message, name: err.name } : err,
      sessionId,
      runId,
    }, '[chat-run-socket] failed to snapshot running bridge run before resume')
  }

  try {
    for (;;) {
      const chunk = await bridge.getOutput(runId, cursor, eventCursor)
      cursor = chunk.cursor
      eventCursor = chunk.event_cursor
      if (chunk.delta || chunk.done || (chunk.events && chunk.events.length > 0)) {
        await applyBridgeChunkAsync(
          nsp,
          socket,
          state,
          sessionId,
          runMarker,
          chunk,
          emit,
          profile,
          sessionMap,
          bridge,
          dequeueNextQueuedRun,
          instructions,
          { model: args.model, provider: args.provider },
          runSource,
          args.workspace,
        )
      }
      if (chunk.done) return
      await delay(100)
    }
  } catch (err) {
    if (state.activeRunMarker !== runMarker) return
    state.isWorking = false
    state.isAborting = false
    state.profile = undefined
    state.runId = undefined
    state.activeRunMarker = undefined
    state.events = []
    emit('run.failed', {
      event: 'run.failed',
      run_id: runId,
      error: err instanceof Error ? err.message : String(err),
      resumed: true,
    })
    if ((state.queue?.length ?? 0) === 0) {
      try {
        updateSession(sessionId, { ended_at: Math.floor(Date.now() / 1000), end_reason: 'error' })
      } catch (endErr) {
        bridgeLogger.warn(endErr, '[chat-run-socket] failed to write ended_at for session %s', sessionId)
      }
    }
  }
}

function observePetEvent(profile: string, event: string, payload: Record<string, unknown>): void {
  try {
    observeRunChatPetEvent(profile, event, payload)
  } catch (err) {
    logger.debug(err, '[chat-run-socket] failed to update pet state')
  }
}

async function refreshFinalContextUsage(args: {
  sessionId: string
  profile: string
  model?: string | null
  provider?: string | null
  workspace?: string | null
  instructions: string
  state: SessionState
  usage: { inputTokens: number; outputTokens: number }
  emit: (event: string, payload: any) => void
  bridge: AgentBridgeClient
}): Promise<number | undefined> {
  try {
    const finalHistory = await buildDbSnapshotAwareHistory(
      args.sessionId,
      args.profile,
      { excludeLastUser: false },
      { model: args.model, provider: args.provider },
    )
    const finalMessageUsage = estimateUsageTokensFromMessages(finalHistory)
    const finalMessageTokens = finalMessageUsage.inputTokens + finalMessageUsage.outputTokens
    await ensureBridgeFixedContext({
      sessionId: args.sessionId,
      profile: args.profile,
      model: args.model,
      provider: args.provider,
      workspace: args.workspace,
      instructions: args.instructions,
      state: args.state,
      bridge: args.bridge,
    })
    const contextTokens = updateMessageContextTokenUsage(
      args.sessionId,
      args.state,
      args.emit,
      finalMessageTokens,
      args.usage,
    )
    bridgeLogger.info({
      sessionId: args.sessionId,
      profile: args.profile,
      model: args.model,
      provider: args.provider,
      messages: finalHistory.length,
      fixedContextTokens: args.state.bridgeContext?.fixedContextTokens,
      messageTokens: finalMessageTokens,
      contextTokens,
    }, '[chat-run-socket] final local context estimate')
    return contextTokens
  } catch (err) {
    bridgeLogger.warn({
      err: err instanceof Error ? { message: err.message, name: err.name } : err,
      sessionId: args.sessionId,
      profile: args.profile,
    }, '[chat-run-socket] final local context estimate failed')
    return args.state.contextTokens
  }
}

async function estimateSnapshotAwareMessageTokens(args: {
  sessionId: string
  profile: string
  model?: string | null
  provider?: string | null
  currentInputTokens?: number
  currentInputIncludedInDb?: boolean
}): Promise<{ messageTokens: number; messages: number }> {
  const snapshotHistory = await buildDbSnapshotAwareHistory(
    args.sessionId,
    args.profile,
    { excludeLastUser: false },
    { model: args.model, provider: args.provider },
  )
  const usage = estimateUsageTokensFromMessages(snapshotHistory)
  const extraInputTokens = args.currentInputIncludedInDb
    ? 0
    : finiteToken(args.currentInputTokens) ?? 0
  return {
    messageTokens: usage.inputTokens + usage.outputTokens + extraInputTokens,
    messages: snapshotHistory.length,
  }
}

function recordBridgeModelUsage(
  sessionId: string,
  bridgeRunId: string,
  event: Record<string, unknown>,
  profile: string,
  modelContext: { model?: string | null; provider?: string | null },
): void {
  const usage = normalizeTokenUsage(event.usage)
  if (usage.isEstimated) {
    bridgeLogger.warn({
      sessionId,
      bridgeRunId,
      apiRequestId: event.api_request_id,
    }, '[chat-run-socket] ignoring incomplete Hermes model usage event')
    return
  }

  const apiRequestId = stringValue(event.api_request_id)
  const turnId = stringValue(event.turn_id)
  const apiCallCount = Number(event.api_call_count)
  const fallbackId = turnId && Number.isFinite(apiCallCount)
    ? `${turnId}:${Math.max(0, Math.floor(apiCallCount))}`
    : ''
  const requestKey = apiRequestId || fallbackId
  if (!requestKey) {
    bridgeLogger.warn({ sessionId, bridgeRunId }, '[chat-run-socket] ignoring Hermes model usage event without request identity')
    return
  }

  recordSessionUsage({
    sessionId,
    runId: `${bridgeRunId}:api:${requestKey}`,
    source: 'hermes',
    agent: 'hermes',
    usageScope: 'model_call',
    apiCalls: 1,
    usage: event.usage,
    model: stringValue(event.model) || modelContext.model,
    provider: stringValue(event.provider) || modelContext.provider,
    profile,
    isEstimated: false,
  })
}

async function applyBridgeChunkAsync(
  nsp: ReturnType<Server['of']>,
  socket: Socket,
  state: SessionState,
  sessionId: string,
  runMarker: string,
  chunk: AgentBridgeOutput,
  emit: (event: string, payload: any) => void,
  profile: string,
  sessionMap: Map<string, SessionState>,
  bridge: AgentBridgeClient,
  dequeueNextQueuedRun: (socket: Socket, sessionId: string, fallbackProfile?: string) => void,
  instructions: string,
  modelContext: { model?: string | null; provider?: string | null },
  runSource: BridgeRunSource,
  workspace?: string | null,
  currentInputTokens = 0,
  currentInputIncludedInDb = true,
  modelGroups?: RunModelGroup[],
  runMetadata?: BridgeRunMetadata,
): Promise<void> {
  if (state.activeRunMarker !== runMarker) {
    bridgeLogger.info({
      sessionId,
      runId: chunk.run_id,
      runMarker,
      activeRunMarker: state.activeRunMarker,
    }, '[chat-run-socket] ignoring stale CLI bridge chunk')
    return
  }

  state.runId = chunk.run_id

  // When the bridge emits text as ordered `stream.delta` events (interleaved
  // with tool.started/tool.completed in the SAME events list), we process the
  // text here in true order and must NOT also process the aggregated
  // `chunk.delta` below (that would duplicate the text). This flag tracks it.
  let sawStreamDeltaEvent = false

  for (const ev of chunk.events || []) {
    const evType = ev.event as string | undefined
    if (evType === 'stream.delta') {
      sawStreamDeltaEvent = true
      processBridgeTextDelta(state, sessionId, runMarker, chunk.run_id, String((ev as any).delta || ''), emit)
      continue
    }
    if (evType === 'message.interim') {
      // Release any partial markup prefix before replacing the segment with
      // Hermes' authoritative interim text, then seal it as its own message.
      flushPendingToolMarkupToAssistant(state, runMarker, chunk.run_id, emit)
      processBridgeInterimMessage(
        state,
        sessionId,
        runMarker,
        chunk.run_id,
        String((ev as any).text || ''),
        Boolean((ev as any).already_streamed),
        emit,
      )
    } else if (evType === 'model.usage') {
      recordBridgeModelUsage(sessionId, chunk.run_id, ev, profile, modelContext)
    } else if (evType === 'session.title.updated') {
      syncBridgeGeneratedTitle(sessionId, (ev as any).title, emit)
    } else if (evType === 'bridge.context.ready') {
      cacheBridgeContext(state, ev, workspace)
      const usage = await calcAndUpdateUsage(sessionId, state, emit)
      const snapshotAware = await estimateSnapshotAwareMessageTokens({
        sessionId,
        profile,
        model: modelContext.model,
        provider: modelContext.provider,
        currentInputTokens,
        currentInputIncludedInDb,
      })
      updateMessageContextTokenUsage(
        sessionId,
        state,
        emit,
        snapshotAware.messageTokens,
        usage,
      )
    } else if (evType === 'tool.started') {
      // Flush any partial tool-call-marker prefix that was held back by
      // the markup filter. Without this, deltas ending in `[`, `[C`,
      // `[Ca`, etc. are silently dropped because no follow-up delta will
      // come for this assistant message — the next chunk is the tool call
      // itself. See bridge-delta.ts for full rationale.
      flushPendingToolMarkupToAssistant(state, runMarker, chunk.run_id, emit)
      flushBridgePendingToDb(state, sessionId, runMarker)
      const toolName = (ev.tool_name as string) || ''
      const args = ev.args as Record<string, unknown> | undefined
      const tool = recordBridgeToolStarted(state, sessionId, runMarker, toolName, args, ev.tool_call_id)
      const payload = {
        event: 'tool.started',
        run_id: chunk.run_id,
        tool_call_id: tool.id,
        tool: toolName,
        name: toolName,
        arguments: tool.arguments,
        preview: ev.preview || summarizeToolArguments(tool.arguments),
      }
      pushState(sessionMap, sessionId, 'tool.started', payload)
      emit('tool.started', payload)
    } else if (evType === 'tool.completed') {
      const toolName = (ev.tool_name as string) || ''
      const completed = recordBridgeToolCompleted(state, sessionId, runMarker, toolName, ev)
      const backgroundDelegation = parseBackgroundDelegation(toolName, completed.output)
      if (backgroundDelegation) {
        runMetadata?.backgroundDelegationIds.add(backgroundDelegation.delegationId)
        state.backgroundDelegations = state.backgroundDelegations || {}
        const existing = state.backgroundDelegations[backgroundDelegation.delegationId]
        if (!existing || existing.status === 'running') {
          state.backgroundDelegations[backgroundDelegation.delegationId] = {
            delegationId: backgroundDelegation.delegationId,
            status: 'running',
            profile,
            updatedAt: Date.now(),
            toolCallId: completed.id,
            messageId: completed.messageId,
            dispatchPayload: backgroundDelegation.payload,
          }
        }
      }
      const payload = {
        event: 'tool.completed',
        run_id: chunk.run_id,
        tool_call_id: completed.id,
        tool: toolName,
        name: toolName,
        output: completed.output,
        duration: completed.duration ?? ev.duration,
        error: ev.is_error || undefined,
      }
      pushState(sessionMap, sessionId, 'tool.completed', payload)
      emit('tool.completed', payload)
      if (backgroundDelegation) {
        const delegationPayload = {
          event: 'delegation.updated',
          run_id: chunk.run_id,
          delegation_id: backgroundDelegation.delegationId,
          status: 'running',
          background_pending: backgroundPendingCount(state),
        }
        pushState(sessionMap, sessionId, 'delegation.updated', delegationPayload)
        emit('delegation.updated', delegationPayload)
      }
    } else if (evType?.startsWith('subagent.')) {
      const payload = {
        event: evType,
        run_id: chunk.run_id,
        subagent_id: ev.subagent_id,
        parent_id: ev.parent_id,
        depth: ev.depth,
        task_index: ev.task_index,
        task_count: ev.task_count,
        goal: ev.goal,
        model: ev.model,
        toolsets: ev.toolsets,
        tool_count: ev.tool_count,
        tool: ev.tool_name,
        name: ev.tool_name,
        arguments: ev.args,
        preview: ev.text || ev.summary || ev.tool_preview || '',
        text: ev.text || '',
        status: ev.status,
        summary: ev.summary,
        duration: ev.duration_seconds,
        duration_seconds: ev.duration_seconds,
        input_tokens: ev.input_tokens,
        output_tokens: ev.output_tokens,
        reasoning_tokens: ev.reasoning_tokens,
        api_calls: ev.api_calls,
        cost_usd: ev.cost_usd,
        files_read: ev.files_read,
        files_written: ev.files_written,
        output_tail: ev.output_tail,
        background_seq: ev.background_seq,
        timestamp: ev.timestamp,
        started_at: ev.started_at,
        updated_at: ev.updated_at,
      }
      pushState(sessionMap, sessionId, evType, payload)
      emit(evType, payload)
    } else if (evType === 'turn.boundary') {
      flushBridgePendingToDb(state, sessionId, runMarker)
    } else if (evType === 'reasoning.delta' || evType === 'thinking.delta') {
      const text = String(ev.text || '')
      if (text) {
        state.bridgePendingReasoningContent = (state.bridgePendingReasoningContent || '') + text
        const message = ensureOpenBridgeAssistantMessage(state, sessionId, runMarker)
        message.reasoning = (message.reasoning || '') + text
        message.reasoning_content = (message.reasoning_content || '') + text
      }
      emit(evType, {
        event: evType,
        run_id: chunk.run_id,
        text,
      })
    } else if (evType === 'reasoning.available') {
      emit('reasoning.available', {
        event: 'reasoning.available',
        run_id: chunk.run_id,
      })
    } else if (evType === 'moa.reference') {
      const index = Number.isFinite(Number((ev as any).index)) ? Number((ev as any).index) : undefined
      const count = Number.isFinite(Number((ev as any).count)) ? Number((ev as any).count) : undefined
      const label = String((ev as any).label || 'reference')
      const text = String((ev as any).text || '')
      const preview = index != null && count != null ? `${index}/${count} ${label}` : label
      const payload = {
        event: 'moa.reference',
        run_id: chunk.run_id,
        label,
        text,
        index,
        count,
      }
      recordBridgeMoaDisplayTool(
        state,
        sessionId,
        runMarker,
        'moa_reference',
        `moa:reference:${chunk.run_id || runMarker}:${index ?? label}`,
        JSON.stringify({ label, preview, text, index, count }),
      )
      pushState(sessionMap, sessionId, 'moa.reference', payload)
      emit('moa.reference', payload)
    } else if (evType === 'moa.aggregating') {
      const aggregator = String((ev as any).aggregator || '')
      const payload = {
        event: 'moa.aggregating',
        run_id: chunk.run_id,
        aggregator,
      }
      recordBridgeMoaDisplayTool(
        state,
        sessionId,
        runMarker,
        'moa_aggregating',
        `moa:aggregating:${chunk.run_id || runMarker}`,
        JSON.stringify({ aggregator, preview: aggregator, text: aggregator }),
      )
      replaceState(sessionMap, sessionId, 'moa.aggregating', payload)
      emit('moa.aggregating', payload)
    } else if (evType === 'approval.requested') {
      const requestedAt = Date.now()
      const payload = {
        event: 'approval.requested',
        run_id: chunk.run_id,
        approval_id: ev.approval_id,
        command: ev.command,
        description: ev.description,
        choices: ev.choices,
        allow_permanent: ev.allow_permanent,
        timeout_ms: ev.timeout_ms,
        remaining_timeout_ms: ev.timeout_ms,
        requested_at: requestedAt,
      }
      replaceState(sessionMap, sessionId, 'approval.requested', payload)
      emit('approval.requested', payload)
    } else if (evType === 'approval.resolved') {
      const payload = {
        event: 'approval.resolved',
        run_id: chunk.run_id,
        approval_id: ev.approval_id,
        choice: ev.choice,
      }
      replaceState(sessionMap, sessionId, 'approval.resolved', payload)
      emit('approval.resolved', payload)
    } else if (evType === 'clarify.requested') {
      const requestedAt = Date.now()
      const payload = {
        event: 'clarify.requested',
        run_id: chunk.run_id,
        clarify_id: ev.clarify_id,
        question: ev.question,
        choices: Array.isArray(ev.choices) ? ev.choices : null,
        timeout_ms: ev.timeout_ms,
        remaining_timeout_ms: ev.timeout_ms,
        requested_at: requestedAt,
      }
      replaceState(sessionMap, sessionId, 'clarify.requested', payload)
      emit('clarify.requested', payload)
    } else if (evType === 'clarify.resolved') {
      const payload = {
        event: 'clarify.resolved',
        run_id: chunk.run_id,
        clarify_id: ev.clarify_id,
      }
      replaceState(sessionMap, sessionId, 'clarify.resolved', payload)
      emit('clarify.resolved', payload)
    } else if (evType === 'bridge.compression.requested') {
      const bridgeHistory = await buildDbSnapshotAwareHistory(
        sessionId,
        profile,
        { excludeLastUser: true },
        { model: modelContext.model, provider: modelContext.provider },
      )
      const bridgeUsage = estimateUsageTokensFromMessages(bridgeHistory)
      const messageOnlyTokens = bridgeUsage.inputTokens + bridgeUsage.outputTokens
      const runInputTokens = typeof currentInputTokens === 'number' && Number.isFinite(currentInputTokens) && currentInputTokens > 0
        ? Math.floor(currentInputTokens)
        : 0
      const runMessageTokens = messageOnlyTokens + runInputTokens
      const tokenCount = contextTokensWithCachedOverhead(state, runMessageTokens)
      bridgeLogger.info({
        sessionId,
        profile,
        bridgeMessages: ev.message_count,
        dbMessages: bridgeHistory.length,
        messageOnlyTokens,
        currentInputTokens: runInputTokens,
        fixedContextTokens: state.bridgeContext?.fixedContextTokens,
        contextTokens: tokenCount,
        bridgeApproxTokens: ev.approx_tokens,
        source: 'local',
      }, '[chat-run-socket] bridge compression token estimate')
      const payload = {
        event: 'compression.started',
        run_id: chunk.run_id,
        request_id: ev.request_id,
        message_count: bridgeHistory.length || ev.message_count,
        token_count: tokenCount,
        source: 'bridge',
      }
      replaceState(sessionMap, sessionId, 'compression.started', payload)
      emit('compression.started', payload)
      if (ev.request_id && Array.isArray(ev.messages)) {
        try {
          const compressed = await forceCompressBridgeHistory(
            sessionId,
            profile,
            ev.messages as ChatMessage[],
            tokenCount,
          )
          state.bridgeCompressionResults = state.bridgeCompressionResults || {}
          state.bridgeCompressionResults[String(ev.request_id)] = compressed
          await bridge.compressionRespond(String(ev.request_id), { messages: compressed.messages })
        } catch (err: any) {
          await bridge.compressionRespond(String(ev.request_id), {
            error: err?.message || String(err),
          }).catch(() => undefined)
        }
      }
    } else if (evType === 'bridge.compression.completed') {
      const compressionResult = ev.request_id
        ? state.bridgeCompressionResults?.[String(ev.request_id)]
        : undefined
      const messageAfterTokens = finiteToken(compressionResult?.afterTokens)
      const runInputTokens = typeof currentInputTokens === 'number' && Number.isFinite(currentInputTokens) && currentInputTokens > 0
        ? Math.floor(currentInputTokens)
        : 0
      const messageAfterTokensWithInput = messageAfterTokens != null
        ? messageAfterTokens + runInputTokens
        : undefined
      const afterContextTokens = messageAfterTokensWithInput != null
        ? contextTokensWithCachedOverhead(state, messageAfterTokensWithInput)
        : undefined
      const payload = {
        event: 'compression.completed',
        run_id: chunk.run_id,
        request_id: ev.request_id,
        compressed: compressionResult?.compressed ?? ev.compressed !== false,
        llmCompressed: compressionResult?.llmCompressed,
        totalMessages: compressionResult?.beforeMessages ?? ev.message_count,
        resultMessages: compressionResult?.resultMessages ?? ev.result_messages,
        beforeTokens: compressionResult?.beforeTokens ?? ev.approx_tokens,
        afterTokens: messageAfterTokensWithInput,
        contextTokens: afterContextTokens,
        summaryTokens: compressionResult?.summaryTokens,
        verbatimCount: compressionResult?.verbatimCount,
        compressedStartIndex: compressionResult?.compressedStartIndex,
        source: 'bridge',
      }
      if (ev.request_id && state.bridgeCompressionResults) {
        delete state.bridgeCompressionResults[String(ev.request_id)]
      }
      replaceState(sessionMap, sessionId, 'compression.completed', payload)
      emit('compression.completed', payload)
      const usage = await calcAndUpdateUsage(sessionId, state, emit)
      if (messageAfterTokensWithInput != null) {
        updateMessageContextTokenUsage(sessionId, state, emit, messageAfterTokensWithInput, usage)
      }
    } else if (evType === 'bridge.compression.failed') {
      const payload = {
        event: 'compression.completed',
        run_id: chunk.run_id,
        request_id: ev.request_id,
        compressed: false,
        totalMessages: ev.message_count,
        resultMessages: ev.message_count,
        beforeTokens: ev.approx_tokens,
        error: ev.error,
        source: 'bridge',
      }
      if (ev.request_id && state.bridgeCompressionResults) {
        delete state.bridgeCompressionResults[String(ev.request_id)]
      }
      replaceState(sessionMap, sessionId, 'compression.completed', payload)
      emit('compression.completed', payload)
    } else if (evType === 'status') {
      const payload = {
        ...ev,
        event: 'agent.event',
        run_id: chunk.run_id,
      }
      replaceState(sessionMap, sessionId, 'agent.event', payload)
      emit('agent.event', payload)
    }
  }

  // Only process the aggregated chunk.delta when the bridge did NOT emit
  // ordered stream.delta events for this chunk. With ordered events, the text
  // was already handled above in true interleaved order; processing it again
  // here would duplicate it.
  if (chunk.delta && !sawStreamDeltaEvent) {
    const delta = filterBridgeToolCallMarkupDelta(state, chunk.delta)
    if (delta) {
      state.bridgeOutput = (state.bridgeOutput || '') + delta
      state.bridgePendingAssistantContent = (state.bridgePendingAssistantContent || '') + delta
      const last = [...state.messages].reverse().find(m => m.runMarker === runMarker)
      if (last?.role === 'assistant' && last.finish_reason == null) {
        last.content += delta
        syncBridgeReasoningToMessage(last, state.bridgePendingReasoningContent)
      } else {
        state.messages.push({
          id: state.messages.length + 1,
          session_id: sessionId,
          runMarker,
          role: 'assistant',
          content: delta,
          reasoning: state.bridgePendingReasoningContent || null,
          reasoning_content: state.bridgePendingReasoningContent || null,
          timestamp: Math.floor(Date.now() / 1000),
        })
      }
      emit('message.delta', {
        event: 'message.delta',
        run_id: chunk.run_id,
        delta,
        output: state.bridgeOutput,
      })
    }
  }

  if (!chunk.done) return
  if (!state.isWorking) return
  if (state.isAborting) {
    bridgeLogger.info({
      sessionId,
      runId: chunk.run_id,
      status: chunk.status,
    }, '[chat-run-socket][abort] completing CLI bridge abort after terminal chunk')
    await markAbortCompleted(
      nsp,
      socket,
      sessionId,
      chunk.run_id || runMarker,
      sessionMap,
      (queuedSocket, queuedSessionId, nextQueuedRun, fallbackProfile) => {
        const queuedState = sessionMap.get(queuedSessionId)
        if (queuedState) queuedState.queue.unshift(nextQueuedRun)
        dequeueNextQueuedRun(queuedSocket, queuedSessionId, fallbackProfile)
      },
    )
    return
  }

  // If the run terminated while we still had a partial tool-call-marker
  // prefix buffered, flush it to the user-visible stream now. Discarding
  // it (which the line below was doing implicitly) silently drops the
  // final characters of the assistant message.
  const terminalError = bridgeTerminalError(chunk)
  const useMoaFinalResponse = String(modelContext.provider || '').toLowerCase() === 'moa'
  let finalResponse = bridgeFinalResponse(chunk, state, useMoaFinalResponse)
  if (
    useMoaFinalResponse
    &&
    !terminalError
    && finalResponse.trim()
    && !(state.bridgeOutput || '').trim()
    && !(state.bridgePendingAssistantContent || '').trim()
  ) {
    state.bridgeOutput = finalResponse
    state.bridgePendingAssistantContent = finalResponse
    const message = ensureOpenBridgeAssistantMessage(state, sessionId, runMarker)
    message.content = finalResponse
    syncBridgeReasoningToMessage(message, state.bridgePendingReasoningContent)
  }

  flushPendingToolMarkupToAssistant(state, runMarker, chunk.run_id, emit)
  flushBridgePendingToDb(state, sessionId, runMarker)
  finalResponse = bridgeFinalResponse(chunk, state, useMoaFinalResponse)
  state.bridgePendingToolCallMarkup = undefined
  if (runMetadata?.backgroundDelegationIds.size) {
    const exactMessages = resultMessages(chunk.result)
    const fallbackGeneratedMessages = state.messages
      .filter(message => message.runMarker === runMarker && (message.role === 'assistant' || message.role === 'tool'))
      .map(message => ({
        role: message.role,
        content: message.content,
        ...(message.tool_calls?.length ? { tool_calls: structuredClone(message.tool_calls) } : {}),
        ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
        ...(message.tool_name ? { name: message.tool_name } : {}),
        ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
        ...(message.reasoning_details ? { reasoning_details: message.reasoning_details } : {}),
      })) as ChatMessage[]
    const messages = exactMessages || [
      ...structuredClone(runMetadata.originContext.messages),
      ...fallbackGeneratedMessages,
    ]
    state.backgroundContinuationContexts = state.backgroundContinuationContexts || {}
    for (const delegationId of runMetadata.backgroundDelegationIds) {
      state.backgroundContinuationContexts[delegationId] = {
        ...runMetadata.originContext,
        delegationId,
        originRunId: chunk.run_id,
        messages: structuredClone(messages),
      }
    }
    bridgeLogger.info({
      sessionId,
      runId: chunk.run_id,
      delegationIds: [...runMetadata.backgroundDelegationIds],
      messageCount: messages.length,
      source: exactMessages ? 'bridge-result' : 'local-fallback',
    }, '[chat-run-socket] captured process-local background continuation context')
  }
  updateSessionStats(sessionId)
  await delay(BRIDGE_USAGE_FLUSH_DELAY_MS)
  const usage = await calcAndUpdateUsage(sessionId, state, emit)
  const contextTokens = await refreshFinalContextUsage({
    sessionId,
    profile,
    model: modelContext.model,
    provider: modelContext.provider,
    workspace,
    instructions,
    state,
    usage,
    emit,
    bridge,
  })
  const hadQueuedRunBeforeGoalEvaluation = state.queue.length > 0
  const eventName = terminalError ? 'run.failed' : 'run.completed'
  if (runMetadata?.delegationId && state.backgroundDelegations?.[runMetadata.delegationId]) {
    state.backgroundDelegations[runMetadata.delegationId] = {
      ...state.backgroundDelegations[runMetadata.delegationId],
      status: terminalError ? 'failed' : 'completed',
      updatedAt: Date.now(),
    }
  }
  let workspaceRunChange: ReturnType<typeof completeWorkspaceRunCheckpoint> = null
  try {
    const change = completeWorkspaceRunCheckpoint({
      sessionId,
      runId: chunk.run_id,
      workspace,
      assistantMessageId: state.bridgeAssistantMessageId,
    })
    workspaceRunChange = change
    if (change) {
      const changePayload = {
        event: 'workspace.diff.completed',
        run_id: chunk.run_id,
        change_id: change.change_id,
        change,
      }
      pushState(sessionMap, sessionId, 'workspace.diff.completed', changePayload)
      emit('workspace.diff.completed', changePayload)
    }
  } catch (err) {
    bridgeLogger.warn({ err, sessionId, runId: chunk.run_id }, '[workspace-diff] failed to complete run checkpoint')
  }
  state.isWorking = hadQueuedRunBeforeGoalEvaluation
  state.isAborting = false
  state.profile = hadQueuedRunBeforeGoalEvaluation ? (state.queue[0]?.profile || profile) : undefined
  state.source = hadQueuedRunBeforeGoalEvaluation ? state.queue[0]?.source : state.source
  state.runId = undefined
  state.activeRunMarker = undefined
  state.events = []
  const payload = {
    event: eventName,
    run_id: chunk.run_id,
    message_id: state.bridgeAssistantMessageId,
    output: finalResponse,
    result: chunk.result,
    error: terminalError || chunk.error,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    contextTokens,
    queue_remaining: state.queue.length,
    background_pending: backgroundPendingCount(state),
    autonomous: runMetadata?.autonomous === true,
    delegation_id: runMetadata?.delegationId,
    queue_id: runMetadata?.queueId,
    workspace_run_change: workspaceRunChange,
  }
  emit(eventName, payload)

  // Workflow node progression is owned by the DAG scheduler. Use the immutable
  // source of the run being finalized: state.source may already describe the
  // next queued run by this point. The standing-goal judge uses the same profile
  // worker as chat runs and can otherwise delay the scheduler's next node.
  if (!terminalError && runSource !== 'workflow') {
    await maybeEnqueueGoalContinuation({
      nsp,
      socket,
      sessionId,
      state,
      bridge,
      profile,
      modelContext,
      modelGroups,
      instructions,
      finalResponse,
      runSource,
    })
  }

  if (state.queue.length > 0 && !state.activeRunMarker) {
    const nextQueuedRun = state.queue[0]
    state.isWorking = true
    state.profile = nextQueuedRun.profile || profile
    state.source = nextQueuedRun.source
    dequeueNextQueuedRun(socket, sessionId)
  } else if (!state.activeRunMarker) {
    state.isWorking = false
    state.profile = undefined
    try {
      updateSession(sessionId, { ended_at: Math.floor(Date.now() / 1000), end_reason: terminalError ? 'error' : 'complete' })
    } catch (endErr) {
      bridgeLogger.warn(endErr, '[chat-run-socket] failed to write ended_at for session %s', sessionId)
    }
  }
}

async function pollBridgeGeneratedTitleAfterRun(
  bridge: AgentBridgeClient,
  sessionId: string,
  profile: string,
  emit: (event: string, payload: any) => void,
) {
  if (!shouldPollBridgeGeneratedTitle(sessionId)) return
  const deadline = Date.now() + BRIDGE_TITLE_EVENT_POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    await delay(BRIDGE_TITLE_EVENT_POLL_INTERVAL_MS)
    let title = ''
    try {
      const result = await bridge.getSessionTitle(sessionId, profile, { timeoutMs: 2000 })
      title = normalizeTitleText(result.title)
    } catch (err) {
      logger.debug(err, '[chat-run-socket] stopped polling bridge generated title for session %s', sessionId)
      return
    }
    if (title) {
      syncBridgeGeneratedTitle(sessionId, title, emit)
      return
    }
  }
}

function bridgeFinalResponse(chunk: AgentBridgeOutput, state: SessionState, useResultFinalResponse = false): string {
  const result = chunk.result && typeof chunk.result === 'object' && !Array.isArray(chunk.result)
    ? chunk.result as Record<string, unknown>
    : null
  const finalResponse = result && typeof result.final_response === 'string'
    ? result.final_response
    : ''
  // The reconciled state includes authoritative interim callbacks and filtered
  // deltas. The bridge output is only the raw delta snapshot, so use it as a
  // fallback when no reconciled output was produced locally.
  const streamedResponse = state.bridgeOutput || chunk.output || ''
  return useResultFinalResponse ? finalResponse || streamedResponse : streamedResponse
}

function hasRealQueuedRun(state: SessionState): boolean {
  return state.queue.some(item => !item.goalContinuation)
}

async function maybeEnqueueGoalContinuation(args: {
  nsp: ReturnType<Server['of']>
  socket: Socket
  sessionId: string
  state: SessionState
  bridge: AgentBridgeClient
  profile: string
  modelContext: { model?: string | null; provider?: string | null }
  modelGroups?: RunModelGroup[]
  instructions: string
  finalResponse: string
  runSource: BridgeRunSource
}) {
  const finalResponse = args.finalResponse || ''
  if (!finalResponse.trim()) return
  if (hasRealQueuedRun(args.state)) return

  let decision: any
  try {
    decision = await withTimeout(
      args.bridge.goalEvaluate(args.sessionId, finalResponse, args.profile),
      BRIDGE_GOAL_EVALUATE_TIMEOUT_MS,
      'goal evaluation timed out',
    )
  } catch (err) {
    logger.warn(err, '[chat-run-socket] /goal evaluation failed for session %s', args.sessionId)
    return
  }

  if (isGoalJudgeUnavailable(decision.reason)) {
    emitGoalStatus(
      args.nsp,
      args.socket,
      args.sessionId,
      args.state,
      'judge_unavailable',
      'Goal judge is not configured; automatic goal continuation was skipped. The goal remains active, but Hermes cannot mark it done automatically.',
    )
    return
  }

  const message = typeof decision.message === 'string' ? decision.message.trim() : ''
  if (message) emitGoalStatus(args.nsp, args.socket, args.sessionId, args.state, decision.verdict || 'goal', message)

  if (!decision.should_continue) return
  if (hasRealQueuedRun(args.state)) return

  const prompt = typeof decision.continuation_prompt === 'string'
    ? decision.continuation_prompt.trim()
    : ''
  if (!prompt) return

  const next: QueuedRun = {
    queue_id: `goal_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    input: prompt,
    displayInput: null,
    storageMessage: prompt,
    model: args.modelContext.model || undefined,
    provider: args.modelContext.provider || undefined,
    model_groups: args.modelGroups,
    instructions: undefined,
    profile: args.profile,
    source: args.runSource === 'global_agent' ? 'global_agent' : 'cli',
    goalContinuation: true,
  }
  args.state.queue.push(next)
}

function isGoalJudgeUnavailable(reason?: string | null): boolean {
  const value = String(reason || '').toLowerCase()
  return value.includes('no auxiliary client configured') || value.includes('auxiliary client unavailable')
}

function emitGoalStatus(
  nsp: ReturnType<Server['of']>,
  socket: Socket,
  sessionId: string,
  state: SessionState,
  action: string,
  message: string,
) {
  const now = Math.floor(Date.now() / 1000)
  const id = addMessage({
    session_id: sessionId,
    role: 'command',
    content: message,
    timestamp: now,
  })
  state.messages.push({
    id: id || `goal_${now}_${state.messages.length}`,
    session_id: sessionId,
    role: 'command',
    content: message,
    timestamp: now,
  })
  nsp.to(`session:${sessionId}`).emit('session.command', {
    event: 'session.command',
    session_id: sessionId,
    command: 'goal',
    ok: true,
    action,
    message,
    terminal: false,
  })
  if (!nsp.adapter.rooms.get(`session:${sessionId}`)?.size && socket.connected) {
    socket.emit('session.command', {
      event: 'session.command',
      session_id: sessionId,
      command: 'goal',
      ok: true,
      action,
      message,
      terminal: false,
    })
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      err => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}
