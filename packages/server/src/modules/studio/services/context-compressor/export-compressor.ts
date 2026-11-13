/**
 * Export Compressor
 *
 * Compresses session context for export purposes.
 * Reuses the LLM summarization logic from ChatContextCompressor
 * but does NOT read or write compression snapshots.
 * Always forces LLM compression regardless of token count.
 * No tail reservation — all messages are compressed.
 */

import { logger } from '../../public/logging'
import {
  type ChatMessage,
  type CompressionConfig,
  type CompressedResult,
  type SummarizerOptions,
  DEFAULT_COMPRESSION_CONFIG,
  countTokens,
  serializeForSummary,
  buildFullPrompt,
  buildIncrementalPrompt,
  buildConversationHistory,
  callSummarizer,
} from './index'
import { deleteCompressionSnapshot, getCompressionSnapshot } from '../../repositories/compression-snapshot'
import {
  buildDbHistory,
  readCursorSnapshotParts,
} from '../chat-run/context-history'

export function buildDbExportHistory(sessionId: string): ChatMessage[] {
  const snapshot = getCompressionSnapshot(sessionId)
  if (snapshot?.compressedThroughMessageId != null) {
    const cursorRead = readCursorSnapshotParts(sessionId, snapshot)
    if (cursorRead.status === 'usable') {
      // ExportCompressor supplies the previous summary separately, so only
      // protected head and post-cursor messages belong in the incremental input.
      return [...cursorRead.parts.head, ...cursorRead.parts.newMessages]
    }
    if (cursorRead.status === 'invalid') {
      logger.warn(
        '[export-compressor] session=%s: invalid cursor snapshot (%s); exporting from full history',
        sessionId,
        cursorRead.reason,
      )
      deleteCompressionSnapshot(sessionId)
    }
  }
  return buildDbHistory(sessionId)
}

export class ExportCompressor {
  private config: CompressionConfig

  constructor(opts?: { config?: Partial<CompressionConfig> }) {
    this.config = { ...DEFAULT_COMPRESSION_CONFIG, ...opts?.config }
  }

  async compress(
    messages: ChatMessage[],
    upstream: string,
    apiKey: string | undefined,
    sessionId?: string,
    summarizer?: string | SummarizerOptions,
  ): Promise<CompressedResult> {
    const total = messages.length

    const meta: CompressedResult['meta'] = {
      totalMessages: total,
      compressed: false,
      llmCompressed: false,
      summaryTokenEstimate: 0,
      verbatimCount: 0,
      compressedStartIndex: -1,
    }

    // Read snapshot for incremental context, but never write
    const snapshot = sessionId ? getCompressionSnapshot(sessionId) : null

    if (snapshot) {
      logger.info(
        '[export-compressor] session=%s: incremental compress with existing snapshot boundary %s',
        sessionId,
        snapshot.compressedThroughMessageId ?? snapshot.lastMessageIndex,
      )
      return this.incrementalCompress(
        messages, snapshot, upstream, apiKey, meta, summarizer,
      )
    }

    logger.info(
      '[export-compressor] session=%s: full compress %d messages',
      sessionId, total,
    )
    return this.fullCompress(messages, upstream, apiKey, meta, summarizer)
  }

  private async incrementalCompress(
    messages: ChatMessage[],
    snapshot: { summary: string; lastMessageIndex: number; compressedThroughMessageId?: number | null },
    upstream: string,
    apiKey: string | undefined,
    meta: CompressedResult['meta'],
    summarizer?: string | SummarizerOptions,
  ): Promise<CompressedResult> {
    const { summary: previousSummary, lastMessageIndex } = snapshot
    const newMessages = snapshot.compressedThroughMessageId != null
      ? messages
      : messages.slice(lastMessageIndex + 1)

    let summary: string | null = null
    try {
      const contentToSummarize = serializeForSummary(newMessages)
      const prompt = buildIncrementalPrompt(previousSummary, contentToSummarize, this.config.summaryBudget)
      const history = buildConversationHistory(newMessages)

      const t0 = Date.now()
      summary = await callSummarizer(upstream, apiKey, prompt, history, this.config.summarizationTimeoutMs, previousSummary, summarizer)
      logger.info('[export-compressor] incremental-llm done in %dms, %d chars', Date.now() - t0, summary!.length)
    } catch (err: any) {
      logger.warn('[export-compressor] incremental-llm failed: %s — reusing previous summary', err.message)
      summary = previousSummary
    }

    const summaryText = summary || previousSummary

    return {
      messages: [{ role: 'user', content: summaryText }],
      meta: {
        ...meta,
        compressed: true,
        llmCompressed: true,
        summaryTokenEstimate: countTokens(summaryText),
        verbatimCount: 0,
      },
    }
  }

  private async fullCompress(
    messages: ChatMessage[],
    upstream: string,
    apiKey: string | undefined,
    meta: CompressedResult['meta'],
    summarizer?: string | SummarizerOptions,
  ): Promise<CompressedResult> {
    if (messages.length === 0) {
      return { messages: [], meta }
    }

    let summary: string | null = null
    try {
      const contentToSummarize = serializeForSummary(messages)
      const prompt = buildFullPrompt(contentToSummarize, this.config.summaryBudget)
      const history = buildConversationHistory(messages)

      const t0 = Date.now()
      summary = await callSummarizer(upstream, apiKey, prompt, history, this.config.summarizationTimeoutMs, undefined, summarizer)
      logger.info('[export-compressor] full-llm done in %dms, %d chars', Date.now() - t0, summary!.length)
    } catch (err: any) {
      logger.warn('[export-compressor] full-llm failed: %s', err.message)
    }

    if (!summary) {
      return { messages, meta }
    }

    return {
      messages: [{ role: 'user', content: summary }],
      meta: {
        ...meta,
        compressed: true,
        llmCompressed: true,
        summaryTokenEstimate: countTokens(summary),
        verbatimCount: 0,
      },
    }
  }
}
