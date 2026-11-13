import type { GroupMessageCursorCutoff } from './group-message-ordering'

// ─── Message Types ──────────────────────────────────────────

/** Raw message from SQLite messages table */
export interface StoredMessage {
    id: string
    roomId: string
    senderId: string
    senderName: string
    content: string
    timestamp: number
    role?: string
    tool_call_id?: string | null
    tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }> | null
    tool_name?: string | null
    finish_reason?: string | null
}

// ─── Compression Config ────────────────────────────────────

export interface CompressionConfig {
    /** Token threshold to trigger compression (estimate all messages) */
    triggerTokens: number
    /** Max tokens for the final compressed context sent to LLM */
    maxHistoryTokens: number
    /** Number of recent messages to keep verbatim after compression */
    tailMessageCount: number
    /** Characters per token for estimation */
    charsPerToken: number
    /** Timeout for summarization LLM call in ms */
    summarizationTimeoutMs: number
}

export const DEFAULT_COMPRESSION_CONFIG: CompressionConfig = {
    triggerTokens: 100_000,
    maxHistoryTokens: 32_000,
    tailMessageCount: 10,
    charsPerToken: 6,
    summarizationTimeoutMs: 30_000,
}

// ─── Compression Output ────────────────────────────────────

export interface CompressedContext {
    conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>
    instructions: string
    meta: {
        totalMessages: number
        verbatimCount: number
        hadSnapshot: boolean
        compressed: boolean
        summaryTokenEstimate: number
        contextTokenEstimate?: number
        messageTokenEstimate?: number
    }
}

// ─── Context Snapshot (persisted in SQLite) ────────────────

export interface ContextSnapshot {
    roomId: string
    summary: string
    lastMessageId: string
    lastMessageTimestamp: number
    updatedAt: number
}

// ─── Summary Cache ──────────────────────────────────────────

export interface SummaryCacheEntry {
    summary: string
    lastMessageId: string
    lastMessageTimestamp: number
    createdAt: number
}

// ─── Dependency Injection ──────────────────────────────────

export interface MessageFetcher {
    getMessagesForContext(roomId: string, cutoff?: GroupMessageCursorCutoff): StoredMessage[]
    getContextSnapshot(roomId: string): ContextSnapshot | null
    saveContextSnapshot(roomId: string, summary: string, lastMessageId: string, lastMessageTimestamp: number): void
    deleteContextSnapshot(roomId: string): void
}

export interface GatewayCaller {
    summarize(
        upstream: string,
        apiKey: string | null,
        systemPrompt: string,
        messages: StoredMessage[],
        roomId: string,
        profile: string,
        previousSummary?: string,
    ): Promise<{ summary: string; sessionId: string }>
}

export type SessionCleaner = (sessionId: string) => void

export type ContextProgress = (event: {
    status: 'compressing'
    path: 'snapshot' | 'full'
    messageCount: number
    tokenCount: number
}) => void

// ─── Build Context Input ───────────────────────────────────

export interface MemberInfo {
    userId: string
    name: string
    description: string
    kind?: 'human' | 'agent'
}

export interface BuildContextInput {
    roomId: string
    agentId: string
    agentName: string
    agentDescription: string
    agentSocketId: string
    roomName: string
    memberNames: string[]
    members: MemberInfo[]
    upstream: string
    apiKey: string | null
    currentMessage: StoredMessage
    compression?: Partial<CompressionConfig>
    profile?: string
    contextTokenEstimator?: (
        history: Array<{ role: 'user' | 'assistant'; content: string }>,
        instructions: string,
    ) => Promise<number | null | undefined>
    onProgress?: ContextProgress
}
