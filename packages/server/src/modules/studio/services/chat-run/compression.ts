/**
 * Context compression — build conversation history from DB,
 * apply snapshot-aware compression and LLM summarization.
 */

import { getSession } from '../../repositories/session-store'
import { deleteCompressionSnapshot, getCompressionSnapshot } from '../../repositories/compression-snapshot'
import { ChatContextCompressor, SUMMARY_PREFIX } from '../context-compressor'
import { getModelContextLength } from '../../public/provider-runtime'
import { readConfigYamlForProfile } from '../../public/profile-config'
import { readCompressionPolicy } from '../../public/compression-policy'
import { logger } from '../../public/logging'
import { bridgeLogger } from '../../public/logging'
import { calcAndUpdateUsage, estimateUsageTokensFromMessages, updateMessageContextTokenUsage } from './usage'
import {
  assembleCursorSnapshotHistory,
  buildDbHistory as queryDbHistory,
  readCursorSnapshotParts,
  type CursorSnapshotParts,
} from './context-history'
import type { ChatMessage, CompressionConfig as CompressorConfig } from '../context-compressor'
import type { SessionState, BridgeCompressionResult } from './types'

interface RunChatCompressionConfig {
  enabled: boolean
  triggerTokens: number
  compressor: Partial<CompressorConfig>
}

interface CompressionModelContext {
  model?: string | null
  provider?: string | null
  allowHermesFallback?: boolean
}

export class ContextWindowTooSmallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ContextWindowTooSmallError'
  }
}

function isContextWindowTooSmallError(err: unknown): err is ContextWindowTooSmallError {
  return err instanceof ContextWindowTooSmallError || (err instanceof Error && err.name === 'ContextWindowTooSmallError')
}

function isSnapshotUsable(
  snapshot: { lastMessageIndex: number } | null,
  history: ChatMessage[],
): boolean {
  return !!snapshot && snapshot.lastMessageIndex >= 0 && snapshot.lastMessageIndex < history.length
}

function buildSnapshotHistory(
  snapshot: { summary: string; lastMessageIndex: number } | null,
  history: ChatMessage[],
  compressionConfig?: Partial<CompressorConfig>,
): ChatMessage[] | null {
  if (!snapshot) return null
  const headCount = compressionConfig?.headMessageCount || 0
  const tailCount = compressionConfig?.tailMessageCount || 0
  const protectedHead = headCount > 0 ? history.slice(0, headCount) : []
  const summaryMessage = { role: 'user', content: SUMMARY_PREFIX + '\n\n' + snapshot.summary } as ChatMessage

  if (isSnapshotUsable(snapshot, history)) {
    return [
      ...protectedHead,
      summaryMessage,
      ...history.slice(snapshot.lastMessageIndex + 1),
    ]
  }

  const tailStart = Math.max(protectedHead.length, history.length - tailCount)
  return [
    ...protectedHead,
    summaryMessage,
    ...history.slice(tailStart),
  ]
}

export async function buildSnapshotAwareHistory(
  sessionId: string,
  profile: string,
  history: ChatMessage[],
  modelContext: { model?: string | null; provider?: string | null } = {},
): Promise<ChatMessage[]> {
  const snapshot = getCompressionSnapshot(sessionId)
  if (!snapshot) return history
  const cursorRead = readCursorSnapshotParts(sessionId, snapshot)
  if (cursorRead.status === 'usable') {
    return assembleCursorSnapshotHistory(snapshot, cursorRead.parts, SUMMARY_PREFIX)
  }
  if (cursorRead.status === 'invalid') {
    logger.warn(
      '[context-compress] session=%s: invalid cursor snapshot (%s); rebuilding from full history',
      sessionId,
      cursorRead.reason,
    )
    deleteCompressionSnapshot(sessionId)
    return history
  }
  const contextLength = getModelContextLength({
    profile,
    model: modelContext.model,
    provider: modelContext.provider,
  })
  const compressionConfig = await getRunChatCompressionConfig(profile, contextLength)
  return buildSnapshotHistory(snapshot, history, compressionConfig.compressor) || history
}

export async function buildDbSnapshotAwareHistory(
  sessionId: string,
  profile: string,
  options: { excludeLastUser?: boolean; truncateToolResults?: boolean } = {},
  modelContext: { model?: string | null; provider?: string | null } = {},
): Promise<ChatMessage[]> {
  const snapshot = getCompressionSnapshot(sessionId)
  if (snapshot) {
    const cursorRead = readCursorSnapshotParts(sessionId, snapshot, options)
    if (cursorRead.status === 'usable') {
      return assembleCursorSnapshotHistory(snapshot, cursorRead.parts, SUMMARY_PREFIX)
    }
    if (cursorRead.status === 'invalid') {
      logger.warn(
        '[context-compress] session=%s: invalid cursor snapshot (%s); invalidating it',
        sessionId,
        cursorRead.reason,
      )
      deleteCompressionSnapshot(sessionId)
    }
  }
  const history = await buildDbHistory(sessionId, options)
  return buildSnapshotAwareHistory(sessionId, profile, history, modelContext)
}

function readDefaultModelContext(config: Record<string, any>, fallback: CompressionModelContext): CompressionModelContext {
  const modelConfig = config?.model
  if (typeof modelConfig === 'string') {
    const model = modelConfig.trim()
    return {
      model: model || fallback.model,
      provider: fallback.provider,
    }
  }
  if (modelConfig && typeof modelConfig === 'object' && !Array.isArray(modelConfig)) {
    const model = String(modelConfig.default || '').trim()
    const provider = String(modelConfig.provider || '').trim()
    return {
      model: model || fallback.model,
      provider: provider || fallback.provider,
    }
  }
  return fallback
}

async function resolveCompressionModelContext(
  profile: string,
  fallback: CompressionModelContext,
): Promise<CompressionModelContext> {
  let config: Record<string, any> = {}
  try {
    config = await readConfigYamlForProfile(profile)
  } catch (err) {
    logger.warn(err, '[context-compress] failed to read auxiliary compression model config for profile %s, using session model', profile)
    return fallback
  }

  const compression = config?.auxiliary?.compression
  if (!compression || typeof compression !== 'object' || Array.isArray(compression)) return fallback

  const provider = typeof compression.provider === 'string' ? compression.provider.trim() : ''
  if (!provider || provider === 'auto') return fallback
  if (provider === 'main') return readDefaultModelContext(config, fallback)

  const model = typeof compression.model === 'string' ? compression.model.trim() : ''
  if (!model) return fallback
  return { model, provider }
}

async function getRunChatCompressionConfig(profile: string, contextLength: number): Promise<RunChatCompressionConfig> {
  const { enabled, threshold, targetRatio, protectLastN, protectFirstN } = await readCompressionPolicy(profile)

  return {
    enabled,
    triggerTokens: Math.floor(contextLength * threshold),
    compressor: {
      triggerTokens: Math.floor(contextLength * threshold),
      summaryBudget: Math.max(1_000, Math.floor(contextLength * targetRatio)),
      headMessageCount: protectFirstN,
      tailMessageCount: protectLastN,
    },
  }
}

/**
 * Load conversation history from DB with full message structure (user/assistant/tool).
 */
export async function buildDbHistory(
  sessionId: string,
  options: { excludeLastUser?: boolean; truncateToolResults?: boolean } = {},
): Promise<ChatMessage[]> {
  return queryDbHistory(sessionId, options)
}

export function estimateSnapshotAwareHistoryUsage(
  sessionId: string,
  history: ChatMessage[],
): { messageCount: number; tokenCount: number } {
  const snapshot = getCompressionSnapshot(sessionId)
  const messages = buildSnapshotHistory(snapshot, history) || history
  const usage = estimateUsageTokensFromMessages(messages)
  return {
    messageCount: messages.length,
    tokenCount: usage.inputTokens + usage.outputTokens,
  }
}

export async function buildCompressedHistory(
  sessionId: string,
  profile: string,
  upstream: string,
  apiKey: string | undefined,
  emit: (event: string, payload: any) => void,
  sessionMap: Map<string, SessionState>,
  modelContext: CompressionModelContext = {},
  contextTokenEstimator?: (messages: ChatMessage[], messageTokens: number) => Promise<number | null | undefined>,
  currentInputTokens = 0,
  excludeLastUser = true,
): Promise<ChatMessage[]> {
  try {
    let snapshot = getCompressionSnapshot(sessionId)
    let cursorParts: CursorSnapshotParts | null = null
    let history: ChatMessage[]
    if (snapshot?.compressedThroughMessageId != null) {
      const cursorRead = readCursorSnapshotParts(sessionId, snapshot, { excludeLastUser })
      if (cursorRead.status === 'usable') {
        cursorParts = cursorRead.parts
        history = assembleCursorSnapshotHistory(snapshot, cursorParts, SUMMARY_PREFIX)
      } else {
        logger.warn(
          '[context-compress] session=%s: invalid cursor snapshot (%s); invalidating it before run',
          sessionId,
          cursorRead.status === 'invalid' ? cursorRead.reason : 'unexpected_legacy',
        )
        deleteCompressionSnapshot(sessionId)
        snapshot = null
        history = await buildDbHistory(sessionId, { excludeLastUser })
      }
    } else {
      history = await buildDbHistory(sessionId, { excludeLastUser })
    }

    const contextLength = getModelContextLength({
      profile,
      model: modelContext.model,
      provider: modelContext.provider,
    })
    const compressionConfig = await getRunChatCompressionConfig(profile, contextLength)
    const triggerTokens = compressionConfig.triggerTokens
    if (!compressionConfig.enabled) {
      logger.info('[context-compress] session=%s: compression disabled by config', sessionId)
      return history
    }
    const cState = getOrCreateSession(sessionMap, sessionId)
    const assembledTokens = await calcAndUpdateUsage(sessionId, cState, emit, {
      truncateToolResultsForContext: true,
    })
    const currentRunInputTokens = typeof currentInputTokens === 'number' && Number.isFinite(currentInputTokens) && currentInputTokens > 0
      ? Math.floor(currentInputTokens)
      : 0
    const estimateLocalContextTokens = async (messages: ChatMessage[], messageTokens: number) => {
      const localMessageTokens = Math.max(0, Math.floor(messageTokens))
      try {
        const estimate = await contextTokenEstimator?.(messages, localMessageTokens)
        if (typeof estimate === 'number' && Number.isFinite(estimate) && estimate > 0) return Math.floor(estimate)
      } catch (err) {
        logger.warn(err, '[context-compress] session=%s: fixed context token estimate failed; using message-only estimate', sessionId)
      }
      return localMessageTokens
    }
    const emitContextUsage = (contextTokens: number) => {
      cState.contextTokens = contextTokens
      emit('usage.updated', {
        event: 'usage.updated',
        session_id: sessionId,
        inputTokens: cState.inputTokens ?? assembledTokens.inputTokens,
        outputTokens: cState.outputTokens ?? assembledTokens.outputTokens,
        contextTokens,
      })
    }
    const messageOnlyTotalTokens =
      (assembledTokens.contextInputTokens ?? assembledTokens.inputTokens) +
      (assembledTokens.contextOutputTokens ?? assembledTokens.outputTokens)
    let totalTokens = messageOnlyTotalTokens

    if (history.length === 0) {
      totalTokens = await estimateLocalContextTokens([], Math.max(currentRunInputTokens, messageOnlyTotalTokens))
      if (totalTokens > triggerTokens) {
        throw new ContextWindowTooSmallError(
          `Context window is too small: fixed prompt/tool overhead plus the current input uses ~${totalTokens} tokens, exceeding compression threshold ${triggerTokens}. Increase model context length, raise compression.threshold, shorten the input, or disable some tools.`,
        )
      }
      if (totalTokens > 0) emitContextUsage(totalTokens)
      return []
    }

    const canCompressHistory = history.length > 4
    const staleSnapshot = snapshot && snapshot.compressedThroughMessageId == null && !isSnapshotUsable(snapshot, history)
    if (staleSnapshot && snapshot) {
      logger.warn('[context-compress] session=%s: stale snapshot index %d for %d history messages; using summary plus safe tail',
        sessionId, snapshot.lastMessageIndex, history.length)
      const staleHistory = buildSnapshotHistory(snapshot, history, compressionConfig.compressor) || history
      const staleUsage = estimateUsageTokensFromMessages(staleHistory)
      const staleMessageTokens = staleUsage.inputTokens + staleUsage.outputTokens
      const staleRunMessageTokens = Math.max(staleMessageTokens + currentRunInputTokens, messageOnlyTotalTokens)
      totalTokens = await estimateLocalContextTokens(staleHistory, staleRunMessageTokens)
      emitContextUsage(totalTokens)
      logger.info({
        sessionId,
        profile,
        messages: staleHistory.length,
        messageOnlyTokens: staleRunMessageTokens,
        fullContextTokens: totalTokens,
        triggerTokens,
        decision: totalTokens > triggerTokens ? 'compress' : 'skip',
        snapshot: 'stale',
      }, '[context-compress] threshold check')
    }

    if (snapshot && cursorParts) {
      const historyUsage = estimateUsageTokensFromMessages(history)
      const historyMessageTokens = historyUsage.inputTokens + historyUsage.outputTokens
      const runMessageTokens = Math.max(historyMessageTokens + currentRunInputTokens, messageOnlyTotalTokens)
      totalTokens = await estimateLocalContextTokens(history, runMessageTokens)
      emitContextUsage(totalTokens)
      logger.info({
        sessionId,
        profile,
        messages: history.length,
        newMessages: cursorParts.newMessages.length,
        messageOnlyTokens: runMessageTokens,
        fullContextTokens: totalTokens,
        triggerTokens,
        decision: totalTokens > triggerTokens ? 'compress' : 'skip',
        snapshot: 'cursor',
      }, '[context-compress] threshold check')
      if (totalTokens > triggerTokens) {
        history = await compressHistory(
          history,
          cursorParts.newMessages,
          sessionId,
          upstream,
          apiKey,
          cState,
          totalTokens,
          emit,
          sessionMap,
          modelContext,
          compressionConfig.compressor,
          currentRunInputTokens,
        )
      }
    } else if (snapshot && !staleSnapshot) {
      const newMessages = history.slice(snapshot.lastMessageIndex + 1)
      const snapshotHistory = buildSnapshotHistory(snapshot, history, compressionConfig.compressor) || history
      const snapshotUsage = estimateUsageTokensFromMessages(snapshotHistory)
      const snapshotMessageTokens = snapshotUsage.inputTokens + snapshotUsage.outputTokens
      const snapshotRunMessageTokens = Math.max(snapshotMessageTokens + currentRunInputTokens, messageOnlyTotalTokens)
      totalTokens = await estimateLocalContextTokens(snapshotHistory, snapshotRunMessageTokens)
      emitContextUsage(totalTokens)
      logger.info({
        sessionId,
        profile,
        messages: snapshotHistory.length,
        messageOnlyTokens: snapshotRunMessageTokens,
        fullContextTokens: totalTokens,
        triggerTokens,
        decision: totalTokens > triggerTokens ? 'compress' : 'skip',
        snapshot: 'usable',
      }, '[context-compress] threshold check')
      logger.info('[context-compress] session=%s: snapshot at %d, %d new messages, assembled ~%d tokens (threshold %d)',
        sessionId, snapshot.lastMessageIndex, newMessages.length, totalTokens, triggerTokens)
      if (totalTokens <= triggerTokens) {
        history = snapshotHistory
      } else {
        history = await compressHistory(history, newMessages, sessionId, upstream, apiKey, cState, totalTokens, emit, sessionMap, modelContext, compressionConfig.compressor, currentRunInputTokens)
      }
    } else if (snapshot && staleSnapshot) {
      if (totalTokens <= triggerTokens) {
        history = buildSnapshotHistory(snapshot, history, compressionConfig.compressor) || history
      } else {
        history = await compressHistory(history, null, sessionId, upstream, apiKey, cState, totalTokens, emit, sessionMap, modelContext, compressionConfig.compressor, currentRunInputTokens)
      }
    } else {
      const historyUsage = estimateUsageTokensFromMessages(history)
      const historyMessageTokens = historyUsage.inputTokens + historyUsage.outputTokens
      const runMessageTokens = Math.max(historyMessageTokens + currentRunInputTokens, messageOnlyTotalTokens)
      totalTokens = await estimateLocalContextTokens(history, runMessageTokens)
      emitContextUsage(totalTokens)
      logger.info({
        sessionId,
        profile,
        messages: history.length,
        messageOnlyTokens: runMessageTokens,
        fullContextTokens: totalTokens,
        triggerTokens,
        decision: totalTokens > triggerTokens ? 'compress' : 'skip',
        snapshot: 'none',
      }, '[context-compress] threshold check')
      if (!canCompressHistory && totalTokens > triggerTokens) {
        throw new ContextWindowTooSmallError(
          `Context window is too small: fixed prompt/tool overhead plus ${history.length} history messages uses ~${totalTokens} tokens, exceeding compression threshold ${triggerTokens}, and there is not enough history to compress. Increase model context length, raise compression.threshold, or disable some tools.`,
        )
      }
      if (totalTokens <= triggerTokens) {
        logger.info('[context-compress] session=%s: %d messages, ~%d tokens — under threshold, skip', sessionId, history.length, totalTokens)
      } else {
        history = await compressHistory(history, null, sessionId, upstream, apiKey, cState, totalTokens, emit, sessionMap, modelContext, compressionConfig.compressor, currentRunInputTokens)
      }
    }
    return history
  } catch (err) {
    if (isContextWindowTooSmallError(err)) throw err
    logger.warn(err, '[chat-run-socket] failed to build compressed history for session %s', sessionId)
    return []
  }
}

export async function compressHistory(
  history: ChatMessage[],
  newMessagesOnly: ChatMessage[] | null,
  sessionId: string,
  upstream: string,
  apiKey: string | undefined,
  cState: SessionState,
  totalTokens: number,
  emit: (event: string, payload: any) => void,
  sessionMap: Map<string, SessionState>,
  modelContext: CompressionModelContext = {},
  compressionConfig?: Partial<CompressorConfig>,
  currentInputTokens = 0,
): Promise<ChatMessage[]> {
  const msgCount = newMessagesOnly ? newMessagesOnly.length : history.length
  const currentRunInputTokens = typeof currentInputTokens === 'number' && Number.isFinite(currentInputTokens) && currentInputTokens > 0
    ? Math.floor(currentInputTokens)
    : 0
  pushState(sessionMap, sessionId, 'compression.started', {
    event: 'compression.started', message_count: msgCount, token_count: totalTokens,
  })
  emit('compression.started', {
    event: 'compression.started', message_count: msgCount, token_count: totalTokens,
  })

  try {
    const session = getSession(sessionId)
    const summarizerProfile = session?.profile || 'default'
    const summarizerModelContext = await resolveCompressionModelContext(summarizerProfile, {
      model: modelContext.model || session?.model,
      provider: modelContext.provider || session?.provider,
    })
    const compressor = new ChatContextCompressor({ config: compressionConfig })
    const result = await compressor.compress(history, upstream, apiKey, sessionId, {
      profile: summarizerProfile,
      model: summarizerModelContext.model,
      provider: summarizerModelContext.provider,
      sessionId,
      historyRevision: session?.history_revision ?? 0,
      workerKey: `${summarizerProfile}:compression:${sessionId}`,
      allowHermesFallback: modelContext.allowHermesFallback !== false,
    })
    const afterTokens = await calcAndUpdateUsage(sessionId, cState, emit, {
      truncateToolResultsForContext: true,
    })
    const compressedAfterTokens =
      (afterTokens.contextInputTokens ?? afterTokens.inputTokens) +
      (afterTokens.contextOutputTokens ?? afterTokens.outputTokens)
    const resultUsage = estimateUsageTokensFromMessages(result.messages)
    const resultMessageTokens = resultUsage.inputTokens + resultUsage.outputTokens
    const compressedRunMessageTokens = Math.max(
      compressedAfterTokens,
      resultMessageTokens + currentRunInputTokens,
    )
    const compressedMeta: any = {
      event: 'compression.completed' as const,
      compressed: result.meta.compressed,
      llmCompressed: result.meta.llmCompressed,
      totalMessages: result.meta.totalMessages,
      resultMessages: result.messages.length,
      beforeTokens: totalTokens,
      afterTokens: compressedRunMessageTokens,
      summaryTokens: result.meta.summaryTokenEstimate,
      verbatimCount: result.meta.verbatimCount,
      compressedStartIndex: result.meta.compressedStartIndex,
    }
    replaceState(sessionMap, sessionId, 'compression.completed', compressedMeta)
    logger.info('[context-compress] AFTER  session=%s: %d messages, ~%d tokens (was %d)',
      sessionId, result.messages.length, compressedRunMessageTokens, totalTokens)
    const compressedContextTokens = updateMessageContextTokenUsage(sessionId, cState, emit, compressedRunMessageTokens, afterTokens)
    if (compressedContextTokens != null) {
      compressedMeta.contextTokens = compressedContextTokens
    }
    emit('compression.completed', compressedMeta)

    const compressed = result.messages.map(m => {
      const msg: any = { role: m.role, content: m.content, tool_call_id: m.tool_call_id, name: m.name }
      if (m.reasoning_content != null) msg.reasoning_content = m.reasoning_content
      if (m.reasoning_details != null) msg.reasoning_details = m.reasoning_details
      if (m.tool_calls?.length) {
        const cleanedToolCalls = m.tool_calls
          .filter((tc: any) => tc.id && tc.id.length > 0)
          .map((tc: any) => ({ id: tc.id, type: tc.type, function: tc.function }))
        if (cleanedToolCalls.length > 0) msg.tool_calls = cleanedToolCalls
      }
      return msg
    })
    await calcAndUpdateUsage(sessionId, cState, emit)
    return compressed
  } catch (err: any) {
    const failedMeta = {
      event: 'compression.completed' as const,
      compressed: false,
      totalMessages: msgCount,
      resultMessages: msgCount,
      beforeTokens: totalTokens,
      afterTokens: totalTokens,
      contextTokens: totalTokens,
      summaryTokens: 0,
      verbatimCount: msgCount,
      compressedStartIndex: -1,
      error: err.message,
    }
    replaceState(sessionMap, sessionId, 'compression.completed', failedMeta)
    logger.warn(err, '[chat-run-socket] compression failed for session %s, using assembled context', sessionId)
    emit('compression.completed', failedMeta)
    return history
  }
}

export async function forceCompressBridgeHistory(
  sessionId: string,
  profile: string,
  _messages: ChatMessage[],
  beforeTokenOverride?: number | null,
): Promise<BridgeCompressionResult> {
  const initialSnapshot = getCompressionSnapshot(sessionId)
  const session = getSession(sessionId)
  const history = initialSnapshot?.compressedThroughMessageId != null
    ? await buildDbSnapshotAwareHistory(
        sessionId,
        profile,
        { excludeLastUser: true },
        { model: session?.model, provider: session?.provider },
      )
    : await buildDbHistory(sessionId, { excludeLastUser: true })

  if (history.length === 0) {
    return {
      messages: [],
      beforeMessages: 0,
      resultMessages: 0,
      beforeTokens: 0,
      afterTokens: 0,
      compressed: false,
      llmCompressed: false,
      summaryTokens: 0,
      verbatimCount: 0,
      compressedStartIndex: -1,
    }
  }

  const upstream = ''
  const apiKey = undefined
  const contextLength = getModelContextLength({ profile, model: session?.model, provider: session?.provider })
  const compressionConfig = await getRunChatCompressionConfig(session?.profile || profile, contextLength)
  const beforeUsage = initialSnapshot?.compressedThroughMessageId != null
    ? (() => {
        const usage = estimateUsageTokensFromMessages(history)
        return { messageCount: history.length, tokenCount: usage.inputTokens + usage.outputTokens }
      })()
    : estimateSnapshotAwareHistoryUsage(sessionId, history)
  const totalTokens = typeof beforeTokenOverride === 'number' && Number.isFinite(beforeTokenOverride) && beforeTokenOverride > 0
    ? Math.floor(beforeTokenOverride)
    : beforeUsage.tokenCount
  bridgeLogger.info({
    sessionId,
    profile,
    historyMessages: history.length,
    snapshotAwareMessages: beforeUsage.messageCount,
    bridgeProvidedMessages: Array.isArray(_messages) ? _messages.length : 0,
    tokenEstimate: totalTokens,
    snapshotAware: true,
  }, '[chat-run-socket] bridge forced compression started')

  const compressor = new ChatContextCompressor({ config: compressionConfig.compressor })
  const summarizerProfile = session?.profile || profile || 'default'
  const summarizerModelContext = await resolveCompressionModelContext(summarizerProfile, {
    model: session?.model,
    provider: session?.provider,
  })
  const result = await compressor.compress(history, upstream, apiKey, sessionId, {
    profile: summarizerProfile,
    model: summarizerModelContext.model,
    provider: summarizerModelContext.provider,
    sessionId,
    historyRevision: session?.history_revision ?? 0,
    workerKey: `${summarizerProfile}:compression:${sessionId}`,
    allowHermesFallback: true,
  })
  const compressedMessages = result.messages.map(m => {
    const msg: any = { role: m.role, content: m.content }
    if (m.reasoning_content != null) msg.reasoning_content = m.reasoning_content
    if (m.reasoning_details != null) msg.reasoning_details = m.reasoning_details
    if (m.tool_calls?.length) {
      const cleanedToolCalls = m.tool_calls
        .filter((tc: any) => tc.id && tc.id.length > 0)
        .map((tc: any) => ({ id: tc.id, type: tc.type, function: tc.function }))
      if (cleanedToolCalls.length > 0) msg.tool_calls = cleanedToolCalls
    }
    if (m.tool_call_id) msg.tool_call_id = m.tool_call_id
    if (m.name) msg.name = m.name
    return msg
  })
  const afterUsage = estimateUsageTokensFromMessages(compressedMessages)
  const afterTokens = afterUsage.inputTokens + afterUsage.outputTokens
  bridgeLogger.info({
    sessionId,
    profile,
    beforeMessages: history.length,
    resultMessages: result.messages.length,
    beforeTokens: totalTokens,
    afterTokens,
    compressed: result.meta.compressed,
    llmCompressed: result.meta.llmCompressed,
    verbatimCount: result.meta.verbatimCount,
    compressedStartIndex: result.meta.compressedStartIndex,
    compressedHistory: result.messages.map((m) => ({
      role: m.role,
      content: m.content,
      reasoning_content: m.reasoning_content,
      reasoning_details: m.reasoning_details,
      tool_calls: m.tool_calls,
      tool_call_id: m.tool_call_id,
      name: m.name,
    })),
  }, '[chat-run-socket] bridge forced compression completed')

  return {
    messages: compressedMessages,
    beforeMessages: history.length,
    resultMessages: compressedMessages.length,
    beforeTokens: totalTokens,
    afterTokens,
    compressed: result.meta.compressed,
    llmCompressed: result.meta.llmCompressed,
    summaryTokens: result.meta.summaryTokenEstimate,
    verbatimCount: result.meta.verbatimCount,
    compressedStartIndex: result.meta.compressedStartIndex,
  }
}

// --- Shared state helpers (used by compression) ---

export function getOrCreateSession(sessionMap: Map<string, SessionState>, sessionId: string): SessionState {
  let state = sessionMap.get(sessionId)
  if (!state) {
    state = { messages: [], isWorking: false, events: [], queue: [] }
    sessionMap.set(sessionId, state)
  }
  return state
}

export function pushState(sessionMap: Map<string, SessionState>, sessionId: string, event: string, data: any) {
  const state = getOrCreateSession(sessionMap, sessionId)
  state.events.push({ event, data })
}

export function replaceState(sessionMap: Map<string, SessionState>, sessionId: string, event: string, data: any) {
  const state = sessionMap.get(sessionId)
  if (state) {
    const idx = state.events.findIndex(s => s.event === event)
    if (idx >= 0) {
      state.events[idx] = { event, data }
      return
    }
  }
  pushState(sessionMap, sessionId, event, data)
}
