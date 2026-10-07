/**
 * Usage calculation — token counting from DB messages,
 * snapshot-aware computation, client notification.
 */

import {
  getSessionDetail,
} from '../../repositories/session-store'
import { deleteCompressionSnapshot, getCompressionSnapshot } from '../../repositories/compression-snapshot'
import { getRecordedUsageTotals, getUsage } from '../../repositories/usage-store'
import { countTokens, SUMMARY_PREFIX } from '../context-compressor'
import { truncateToolResultForContext } from './tool-result-context'
import { projectChatBrowserHistory } from '../../public/chat-agent-runtime'
import { logger } from '../../public/logging'
import { assembleCursorSnapshotHistory, readCursorSnapshotParts } from './context-history'
import type { SessionState } from './types'

type UsageTokenMessage = {
  role?: string
  content?: unknown
  tool_calls?: unknown
  /** DeepSeek/Kimi thinking-mode payload echoed back on subsequent turns. */
  reasoning_content?: unknown
  reasoning?: unknown
  reasoning_details?: unknown
}

function contentToUsageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!content) return ''
  if (Array.isArray(content)) {
    return content.map((block: any) => {
      if (typeof block?.text === 'string') return block.text
      if (typeof block?.type === 'string') return `[${block.type}]`
      return String(block || '')
    }).join('\n')
  }
  return String(content)
}

export function estimateUsageTokensFromMessages(messages: UsageTokenMessage[]): { inputTokens: number; outputTokens: number } {
  const inputTokens = messages
    .filter(m => m.role === 'user')
    .reduce((sum, m) => sum + countTokens(contentToUsageText(m.content)), 0)
  const outputTokens = messages
    .filter(m => m.role === 'assistant' || m.role === 'tool')
    .reduce((sum, m) => {
      // reasoning_content is re-sent to providers that require thinking-mode
      // echo-back (DeepSeek/Kimi). Omitting it undercounts full context by
      // hundreds of K tokens and skips compression until the upstream 400
      // (NousResearch/hermes-agent#80246).
      const reasoning = m.reasoning_content ?? m.reasoning
      const estimatedReasoningTokens = storedReasoningTokenEstimate(m.reasoning_details)
      return (
        sum
        + countTokens(contentToUsageText(m.content))
        + countTokens(String(m.tool_calls || ''))
        + (estimatedReasoningTokens ?? countTokens(String(reasoning || '')))
      )
    }, 0)
  return { inputTokens, outputTokens }
}

function storedReasoningTokenEstimate(details: unknown): number | undefined {
  let parsed = details
  if (typeof parsed === 'string') {
    if (!parsed.trim()) return undefined
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return undefined
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const value = (parsed as Record<string, unknown>).estimatedTokens
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined
}

export async function calcAndUpdateUsage(
  sid: string,
  state: SessionState,
  emit: (event: string, payload: any) => void,
  options: {
    truncateToolResultsForContext?: boolean
    nativeSource?: 'coding_agent'
  } = {},
): Promise<{
  inputTokens: number
  outputTokens: number
  contextInputTokens?: number
  contextOutputTokens?: number
  nativeUsageAvailable?: boolean
  nativeModel?: string
  cacheReadTokens?: number
  cacheWriteTokens?: number
}> {
  try {
    if (options.nativeSource) {
      const totals = getRecordedUsageTotals(sid, options.nativeSource)
      const latest = getUsage(sid, options.nativeSource)
      const usage = {
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        cacheReadTokens: totals.cacheReadTokens || 0,
        cacheWriteTokens: totals.cacheWriteTokens || 0,
      }
      if (latest) {
        state.inputTokens = usage.inputTokens
        state.outputTokens = usage.outputTokens
        state.cacheReadTokens = usage.cacheReadTokens
        state.cacheWriteTokens = usage.cacheWriteTokens
        emit('usage.updated', {
          event: 'usage.updated',
          session_id: sid,
          ...usage,
        })
      }
      return {
        ...usage,
        nativeUsageAvailable: Boolean(latest),
        nativeModel: latest?.model || '',
        ...(latest
          ? {
              // Accounting keeps ordinary and cached input disjoint, but both
              // occupy the model's context window.
              contextInputTokens: Number(latest.input_tokens || 0) + Number(latest.cache_read_tokens || 0) + Number(latest.cache_write_tokens || 0),
              contextOutputTokens: Number(latest.output_tokens || 0),
            }
          : {}),
      }
    }

    const snapshot = getCompressionSnapshot(sid)
    if (snapshot?.compressedThroughMessageId != null) {
      const cursorRead = readCursorSnapshotParts(sid, snapshot, {
        truncateToolResults: false,
      })
      if (cursorRead.status === 'usable') {
        const messages = assembleCursorSnapshotHistory(snapshot, cursorRead.parts, SUMMARY_PREFIX)
        const usage = estimateUsageTokensFromMessages(messages)
        let contextUsage: { inputTokens: number; outputTokens: number } | undefined
        if (options.truncateToolResultsForContext) {
          const contextRead = readCursorSnapshotParts(sid, snapshot, {
            truncateToolResults: true,
          })
          if (contextRead.status === 'usable') {
            contextUsage = estimateUsageTokensFromMessages(
              assembleCursorSnapshotHistory(snapshot, contextRead.parts, SUMMARY_PREFIX),
            )
          }
        }
        state.inputTokens = usage.inputTokens
        state.outputTokens = usage.outputTokens
        emit('usage.updated', {
          event: 'usage.updated',
          session_id: sid,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        })
        return {
          ...usage,
          ...(contextUsage
            ? {
                contextInputTokens: contextUsage.inputTokens,
                contextOutputTokens: contextUsage.outputTokens,
              }
            : {}),
        }
      }
      if (cursorRead.status === 'invalid') {
        logger.warn(
          '[chat-run-socket] invalid cursor snapshot while calculating usage for session %s (%s)',
          sid,
          cursorRead.reason,
        )
        deleteCompressionSnapshot(sid)
      }
    }

    const detail = getSessionDetail(sid)
    const storedMessages = detail?.messages
      ?.filter(m => m.role === 'user' || m.role === 'assistant' || m.role === 'tool') || []
    const estimateSnapshotUsage = (messages: typeof storedMessages) => {
      if (snapshot && messages.length && snapshot.lastMessageIndex >= 0 && snapshot.lastMessageIndex < messages.length) {
        const newMessages = messages.slice(snapshot.lastMessageIndex + 1)
        const newUsage = estimateUsageTokensFromMessages(newMessages)
        return {
          inputTokens: countTokens(SUMMARY_PREFIX + snapshot.summary) + newUsage.inputTokens,
          outputTokens: newUsage.outputTokens,
        }
      }
      return estimateUsageTokensFromMessages(messages)
    }
    const usage = estimateSnapshotUsage(storedMessages)
    const contextUsage = options.truncateToolResultsForContext
      ? estimateSnapshotUsage(projectChatBrowserHistory(storedMessages, { truncateOtherTools: truncateToolResultForContext }))
      : undefined
    state.inputTokens = usage.inputTokens
    state.outputTokens = usage.outputTokens
    emit('usage.updated', {
      event: 'usage.updated',
      session_id: sid,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    })
    return {
      ...usage,
      ...(contextUsage
        ? {
            contextInputTokens: contextUsage.inputTokens,
            contextOutputTokens: contextUsage.outputTokens,
          }
        : {}),
    }
  } catch (err: any) {
    logger.warn(err, '[chat-run-socket] failed to calculate usage for session %s', sid)
    return { inputTokens: 0, outputTokens: 0, ...(options.nativeSource ? { nativeUsageAvailable: false } : {}) }
  }
}

export function invalidateExternalContextUsage(
  sid: string,
  state: SessionState,
  emit: (event: string, payload: any) => void,
  usage?: { inputTokens: number; outputTokens: number },
): undefined {
  if (!state.contextOwner && state.externalContext) {
    state.contextOwner = { manager: 'bili', conversationId: state.externalContext.conversationId }
  }
  state.externalContext = undefined
  state.contextTokens = undefined
  state.contextManagerStatus = 'unavailable'
  emit('usage.updated', {
    event: 'usage.updated', session_id: sid,
    inputTokens: usage?.inputTokens ?? state.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? state.outputTokens ?? 0,
    contextTokens: null, contextManager: 'bili', contextSource: 'unavailable', contextManagerStatus: 'unavailable',
    contextObservedAt: null, contextGeneration: null, contextModel: null, contextWindow: null,
  })
  return undefined
}

export function updateContextTokenUsage(
  sid: string,
  state: SessionState,
  emit: (event: string, payload: any) => void,
  contextTokens: number | null | undefined,
  usage?: { inputTokens: number; outputTokens: number },
): number | undefined {
  const external = state.externalContext
  if (external) {
    const now = Date.now()
    if (external.conversationId !== sid || external.observedAt < now - 15 * 60 * 1_000 || external.observedAt > now + 60_000) {
      return invalidateExternalContextUsage(sid, state, emit, usage)
    }
    contextTokens = external.tokens
  }
  if (state.contextOwner?.manager === 'bili' && !state.externalContext) {
    return invalidateExternalContextUsage(sid, state, emit, usage)
  }
  if (typeof contextTokens !== 'number' || !Number.isFinite(contextTokens) || contextTokens < 0) {
    return state.contextTokens
  }
  const normalizedContextTokens = Math.floor(contextTokens)
  state.contextTokens = normalizedContextTokens
  state.contextManagerStatus = state.externalContext ? 'active' : 'native'
  emit('usage.updated', {
    event: 'usage.updated',
    session_id: sid,
    inputTokens: usage?.inputTokens ?? state.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? state.outputTokens ?? 0,
    contextTokens: normalizedContextTokens,
    contextManager: state.externalContext?.manager ?? state.contextOwner?.manager ?? 'native',
    contextSource: state.externalContext?.source ?? 'estimate',
    contextObservedAt: state.externalContext?.observedAt,
    contextGeneration: state.externalContext?.generation,
    contextModel: state.externalContext?.model,
    contextWindow: state.externalContext?.window,
    contextManagerStatus: state.contextManagerStatus ?? 'native',
    contextFallback: state.contextFallback === true,
  })
  return normalizedContextTokens
}

export function getCachedBridgeContextOverhead(state: SessionState): number | undefined {
  const fixedContextTokens = state.bridgeContext?.fixedContextTokens
  if (typeof fixedContextTokens !== 'number' || !Number.isFinite(fixedContextTokens) || fixedContextTokens < 0) {
    return undefined
  }
  return Math.floor(fixedContextTokens)
}

export function contextTokensWithCachedOverhead(state: SessionState, messageTokens: number): number {
  const normalizedMessageTokens = Math.max(0, Math.floor(messageTokens))
  const fixedContextTokens = getCachedBridgeContextOverhead(state)
  return fixedContextTokens == null
    ? normalizedMessageTokens
    : fixedContextTokens + normalizedMessageTokens
}

export function updateMessageContextTokenUsage(
  sid: string,
  state: SessionState,
  emit: (event: string, payload: any) => void,
  messageTokens: number | null | undefined,
  usage?: { inputTokens: number; outputTokens: number },
): number | undefined {
  const external = state.externalContext
  if (external) {
    const now = Date.now()
    if (external.conversationId === sid && external.observedAt >= now - 15 * 60 * 1_000 && external.observedAt <= now + 60_000) {
      return state.contextTokens
    }
    return invalidateExternalContextUsage(sid, state, emit, usage)
  }
  if (state.contextOwner?.manager === 'bili') return invalidateExternalContextUsage(sid, state, emit, usage)
  if (typeof messageTokens !== 'number' || !Number.isFinite(messageTokens) || messageTokens < 0) {
    return state.contextTokens
  }
  return updateContextTokenUsage(
    sid,
    state,
    emit,
    contextTokensWithCachedOverhead(state, messageTokens),
    usage,
  )
}
