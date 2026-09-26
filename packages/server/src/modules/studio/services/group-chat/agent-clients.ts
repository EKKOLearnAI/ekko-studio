import { hermesStudioMcpCapabilities } from '../chat-run/studio-mcp'
import { studioMcpUsageGuidelines } from '../../public/runs/prompt'
import { findPushRunLink, linkPushRun, type PushRunRef } from '../../repositories/run-push-store'
import { withTaskPlanTurnContext } from '../task-plan-runs'
import type { TaskPlanSnapshot } from '../../contracts/task-plan'
import { groupTaskPlanMessage } from './task-plan'
import { groupRunUser } from './run-user'
import type { AuthenticatedUser } from '../../public/auth'
import { io, Socket } from 'socket.io-client'
import { createHash, randomBytes, randomUUID } from 'crypto'
import { getToken } from '../../public/auth'
import { logger } from '../../public/logging'
import { countTokens } from '../context-compressor'
import {
    cancelGroupEkkoClarification,
    createGroupPrimaryAgentBridge,
    type GroupPrimaryAgentBridge,
    type GroupPrimaryAgentBridgeContextEstimate,
    type GroupPrimaryAgentBridgeMessage,
    type GroupPrimaryAgentBridgeOutput,
} from '../../public/group-chat-agent-runtime'
import { convertContentBlocksForAgent, isContentBlockArray } from '../chat-run/content-blocks'
import { resolveBridgeRunModelConfig } from '../chat-run/model-config'
import {
    completeWorkspaceRunCheckpointDraft,
    discardWorkspaceRunCheckpoint,
    startWorkspaceRunCheckpoint,
} from '../chat-run/workspace-diff-tracker'
import type { ContentBlock } from '../chat-run/types'
import type { StoredMessage } from './types'
import type { GroupRoomSummaryService, GroupRuntimeContext } from './room-summary'
import {
    isAgentMentioned,
    isAllAgentsMentioned,
    resolveMentionTargets,
    stripMentionRoutingTokens,
} from './mention-routing'
import { buildAgentInstructions, buildNonOwnerRequestSecurityPrompt } from './agent-prompt'

export const GROUP_CHAT_AGENT_SOCKET_SECRET = randomBytes(32).toString('hex')

// ─── Types ────────────────────────────────────────────────────

export interface AgentConfig {
    agentId?: string
    agent?: 'hermes' | 'ekko' | 'codex' | 'claude' | 'pi' | 'grok' | 'opencode' | 'dsh'
    agentMode?: 'scoped' | 'global'
    profile: string
    provider?: string
    model?: string
    apiMode?: string
    agentPreset?: string
    reasoningEffort?: string
    name: string
    description: string
    invited: number
    /** Group-chat Hermes agents must never detach delegate_task work. */
    backgroundDelegationEnabled: false
}

interface MessageData {
    id: string
    roomId: string
    senderId: string
    senderName: string
    content: string
    timestamp: number
    run_id?: string | null
}

export type MentionMessage = {
    messageId?: string
    content: string
    senderName: string
    senderId: string
    timestamp: number
    role?: string
    input?: string | ContentBlock[]
    mentionDepth?: number
    handoffChainId?: string
    mentions?: StructuredMention[]
    /** SHA-256 proof binding queued work to the originating browser; never broadcast. */
    executionQueueCapabilityHash?: string
    /** Server-issued durable continuation identity; never accepted from an Agent socket. */
    continuationAttemptId?: string
    /** Trusted, target-specific ownership context added by AgentClients. */
    targetOwnerMemberId?: string
}

export type StructuredMention =
    | { type: 'agent'; participantId: string }
    | { type: 'all' }

export type StructuredMentionEntry =
    | { type: 'agent'; participantId: string; displayName: string }
    | { type: 'all'; displayName: 'all' }


export function mentionMessageToStoredContextMessage(roomId: string, msg: MentionMessage): StoredMessage {
    return {
        id: msg.messageId || '',
        roomId,
        senderId: msg.senderId,
        senderName: msg.senderName,
        content: msg.content,
        timestamp: msg.timestamp,
        role: msg.role === 'assistant' ? 'assistant' : 'user',
    }
}

type GroupEstimateMessage = { role: 'user' | 'assistant'; content: string }
export type GroupModelContext = { model: string; provider: string }
export type GroupAgentSessionConfig = {
    agent?: 'hermes' | 'ekko' | 'codex' | 'claude' | 'pi' | 'grok' | 'opencode' | 'dsh'
    agentMode?: 'scoped' | 'global'
    provider?: string
    model?: string
    apiMode?: string
    agentPreset?: string
    reasoningEffort?: string
}
type WorkspaceDiffTerminalStatus = 'completed' | 'failed' | 'aborted'
export type WorkspaceDiffBroadcaster = (roomId: string, message: MessageData & Record<string, unknown>, totalTokens: number) => void
type AgentActivityBroadcaster = (
    roomId: string,
    agentName: string,
    status: 'compressing' | 'replying' | 'ready',
    runId?: string,
    agentSessionId?: string,
) => void
type ExecutionQueueBroadcaster = (roomId: string) => void

function isUnknownBridgeSessionError(err: unknown): boolean {
    const message = String((err as any)?.message || err || '').toLowerCase()
    return message.includes('unknown session') || message.includes('session not found')
}

interface WorkspaceDiffRunState {
    roomId: string
    sessionId: string
    runId: string
    responseRunId: string
    workspace: string
    abortRequested: boolean
    finalized: boolean
}

interface BridgeContextCache {
    fixedContextTokens: number
    instructions?: string
    systemPromptTokens?: number
    toolTokens?: number
    systemPromptChars?: number
    toolCount?: number
    toolNames?: string[]
    profile?: string
    model?: string
    provider?: string
}

export async function resolveGroupAgentModelContext(
    profile: string,
    model?: string,
    provider?: string,
): Promise<GroupModelContext> {
    return resolveBridgeRunModelConfig({
        profile,
        requestedModel: model,
        requestedProvider: provider,
        preferRequested: true,
    })
}

export function estimateGroupHistoryMessageTokens(history: Array<{ content?: unknown }>): number {
    return history.reduce((sum, message) => sum + countTokens(String(message.content || '')), 0)
}

export function groupContextTokensWithFixedOverhead(
    fixedContextTokens: number | null | undefined,
    history: Array<{ content?: unknown }>,
): number | undefined {
    if (typeof fixedContextTokens !== 'number' || !Number.isFinite(fixedContextTokens) || fixedContextTokens < 0) {
        return undefined
    }
    return Math.floor(fixedContextTokens) + estimateGroupHistoryMessageTokens(history)
}

export function isGroupBridgeContextCacheCompatible(
    cache: { model?: string; provider?: string } | null | undefined,
    modelContext: GroupModelContext,
): boolean {
    if (!cache) return false
    if (modelContext.model && cache.model !== modelContext.model) return false
    if (modelContext.provider && cache.provider !== modelContext.provider) return false
    return true
}

export function groupBridgeReasoningDeltaFromEvent(event: Record<string, unknown>): string | null {
    if (String(event.event || '') !== 'reasoning.delta') return null
    const text = String(event.text || '')
    return text ? text : null
}

export interface MemberData {
    id: string
    name: string
    joinedAt: number
}

export interface JoinResult {
    roomId: string
    roomName: string
    members: MemberData[]
    messages: MessageData[]
    rooms: string[]
}

export interface AgentEventHandler {
    onMessage?: (data: { roomId: string; msg: MessageData }) => void
    onTyping?: (data: { roomId: string; userId: string; userName: string }) => void
    onStopTyping?: (data: { roomId: string; userId: string; userName: string }) => void
    onMemberJoined?: (data: { roomId: string; memberId: string; memberName: string; members: MemberData[] }) => void
    onMemberLeft?: (data: { roomId: string; memberId: string; memberName: string; members: MemberData[] }) => void
    onRoomUpdated?: (data: { roomId: string; name?: string; inviteCode?: string | null }) => void
}

export interface GroupAgentEventSink {
    readonly connected: boolean
    readonly id?: string
    sendMessage(
        roomId: string,
        content: string,
        messageId?: string,
        extra?: Record<string, unknown>,
        agentSessionId?: string,
    ): Promise<string>
    emit(event: string, payload: Record<string, unknown>): void
    disconnect?(): void
}

export interface GroupAgentExecutor {
    readonly agentId: string
    readonly agent: 'hermes' | 'ekko' | 'codex' | 'claude' | 'pi' | 'grok' | 'opencode' | 'dsh'
    readonly agentMode: 'scoped' | 'global'
    readonly profile: string
    readonly provider: string
    readonly model: string
    readonly apiMode: string
    readonly agentPreset?: string
    readonly reasoningEffort: string
    readonly name: string
    readonly description: string
    readonly connected: boolean
    reserveInvocation?(): void
    releaseInvocation?(): void
    disconnect(): void | Promise<void>
    sendMessage(roomId: string, content: string, messageId?: string, extra?: Record<string, unknown>, agentSessionId?: string): Promise<string>
    interrupt(roomId: string): Promise<boolean>
    getActiveSessionId(roomId: string): string | undefined
    isActiveSession(roomId: string, sessionId: string): boolean
    respondApproval?(approvalId: string, choice: string): Promise<boolean>
    respondClarify?(clarifyId: string, response: string): Promise<boolean>
    cancelClarify?(clarifyId: string, sessionId: string, runId: string): Promise<boolean>
    replyToMention(
        roomId: string,
        msg: MentionMessage,
        runtimeContext?: GroupRuntimeContext,
        onStatus?: (status: 'compressing' | 'replying' | 'ready', extra?: Record<string, unknown>) => void,
    ): Promise<void>
    setStorage(storage: any): void
    setWorkspaceDiffBroadcaster(broadcaster: WorkspaceDiffBroadcaster | null): void
    setChatRunService(service: GroupChatRunService | null): void
}

export interface MentionDeliveryResult {
    targetCount: number
    deliveredCount: number
    errors: string[]
    outcomeUnknown?: boolean
}

type MentionQueueError = {
    message: string
    outcomeUnknown: boolean
}

export interface GroupChatRunService {
    runAndWait(
        data: {
            input: string | ContentBlock[]
            session_id: string
            model?: string
            provider?: string
            apiMode?: string
            instructions?: string
            group_system_prompt?: string
            group_room_id?: string
            group_agent_id?: string
            workspace?: string | null
            source?: string
            session_source?: 'group_chat'
            coding_agent_id?: 'claude-code' | 'codex' | 'pi' | 'grok' | 'opencode' | 'dsh' | 'ekko-agent'
            mode?: 'scoped' | 'global'
            profile?: string
            reasoning_effort?: string
            background_delegation_enabled?: boolean
            context_compression_enabled?: boolean
            memory_input?: string | ContentBlock[]
            memory_messages?: Array<{
                id?: string
                role: 'user' | 'assistant'
                content: string
                metadata?: Record<string, unknown>
                createdAt?: string
            }>
            memory_write_policy?: 'automatic' | 'explicit-only'
            memory_origin?: { host?: string; namespace?: string; contextId?: string }
            memory_recall_scopes?: Array<Record<string, string>>
            memory_write_scopes?: Array<Record<string, string>>
            memory_default_write_scope?: Record<string, string>
        },
        options?: {
            user?: AuthenticatedUser
            groupRunIsCurrent?: () => boolean
            pushRoot?: PushRunRef
            profile?: string
            timeoutMs?: number
            onEvent?: (event: string, payload: any) => void
        },
    ): Promise<{
        ok: boolean
        output?: string | null
        reasoning?: string | null
        error?: string
    }>
    beginGroupTaskPlanRun?(sessionId: string, profile: string, runId: string, isCurrent: () => boolean, publish: (snapshot: TaskPlanSnapshot) => void): {
        contextId: string
        finish(state: 'ended' | 'interrupted' | 'failed'): void
    }
    abortSession(sessionId: string, reason?: string): Promise<void>
    disposeSession?(sessionId: string): Promise<void>
    respondCodingAgentApproval?(sessionId: string, approvalId: string, choice: string): boolean
    respondCodingAgentClarification?(sessionId: string, clarifyId: string, response: string): boolean
}

// ─── Agent Client (single connection) ─────────────────────────

export class AgentClient implements GroupAgentExecutor {
    readonly agentId: string
    readonly agent: 'hermes' | 'ekko' | 'codex' | 'claude' | 'pi' | 'grok' | 'opencode' | 'dsh'
    readonly agentMode: 'scoped' | 'global'
    readonly profile: string
    readonly provider: string
    readonly model: string
    readonly apiMode: string
    readonly agentPreset?: string
    readonly reasoningEffort: string
    readonly name: string
    readonly description: string
    private readonly backgroundDelegationEnabled: false
    private socket: Socket | null = null
    private joinedRooms = new Set<string>()
    private handlers: AgentEventHandler
    private _reconnecting = false
    private storage: any = null
    private pendingToolCallIds = new Map<string, string[]>()
    private pendingToolBaseIds = new Map<string, string>()
    private pendingToolRunIds = new Map<string, string>()
    private pendingToolNames = new Map<string, string>()
    private pendingToolExternalIds = new Map<string, string>()
    private pendingToolCompletionEvents = new Map<string, Record<string, unknown>>()
    private acknowledgedToolCallIds = new Map<string, number>()
    private anonymousToolCallSequence = 0
    private bridgeContextCache = new Map<string, BridgeContextCache>()
    private workspaceDiffRuns = new Map<string, WorkspaceDiffRunState>()
    private interruptVersions = new Map<string, number>()
    private activeSessions = new Map<string, string>()
    private workspaceDiffBroadcaster: WorkspaceDiffBroadcaster | null = null
    private chatRunService: GroupChatRunService | null = null
    private readonly eventSink: GroupAgentEventSink | null
    private mentionBuilder: ((roomId: string, content: string) => StructuredMentionEntry[]) | null = null

    constructor(config: AgentConfig, handlers: AgentEventHandler = {}, eventSink: GroupAgentEventSink | null = null) {
        this.agentId = config.agentId || Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
        this.agent = config.agent || 'hermes'
        this.agentMode = config.agentMode === 'global' && (this.agent === 'claude' || this.agent === 'codex' || this.agent === 'pi' || this.agent === 'grok' || (this.agent === 'opencode' || this.agent === 'dsh'))
            ? 'global'
            : 'scoped'
        this.profile = config.profile
        this.provider = String(config.provider || '').trim()
        this.model = String(config.model || '').trim()
        this.apiMode = this.agent === 'hermes' ? '' : String(config.apiMode || '').trim()
        this.reasoningEffort = String(config.reasoningEffort || '').trim()
        this.agentPreset = config.agentPreset
        this.name = config.name
        this.description = config.description
        this.backgroundDelegationEnabled = config.backgroundDelegationEnabled ?? false
        this.handlers = handlers
        this.eventSink = eventSink
    }

    get connected(): boolean {
        return this.eventSink?.connected ?? this.socket?.connected ?? false
    }

    get id(): string | undefined {
        return this.eventSink?.id || this.socket?.id
    }

    setStorage(storage: any): void {
        this.storage = storage
    }

    setWorkspaceDiffBroadcaster(broadcaster: WorkspaceDiffBroadcaster | null): void {
        this.workspaceDiffBroadcaster = broadcaster
    }

    setChatRunService(service: GroupChatRunService | null): void {
        this.chatRunService = service
    }

    setMentionBuilder(builder: ((roomId: string, content: string) => StructuredMentionEntry[]) | null): void {
        this.mentionBuilder = builder
    }

    async connect(port?: number): Promise<void> {
        if (this.eventSink) {
            this.ensureConnected()
            return
        }
        const actualPort = port ?? parseInt(process.env.PORT || '8648', 10)
        const token = await getToken()

        this.socket = io(`http://127.0.0.1:${actualPort}/group-chat`, {
            // A relay namespace can close its entire transport. Do not let it
            // share this Agent's connection and permanently disconnect it.
            forceNew: true,
            auth: {
                token: token || undefined,
                userId: this.agentId,
                name: this.name,
                description: this.description,
                source: 'agent',
                agentSocketSecret: GROUP_CHAT_AGENT_SOCKET_SECRET,
            },
            transports: ['websocket'],
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 30000,
            randomizationFactor: 0.5,
            timeout: 30000,
        })

        this.bindEvents()

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Connection timeout')), 10000)

            this.socket!.on('connect', () => {
                clearTimeout(timeout)
                logger.debug(`[AgentClient] ${this.name} connected, socket id: ${this.socket!.id}`)
                resolve()
            })

            this.socket!.on('connect_error', (err) => {
                clearTimeout(timeout)
                logger.error(err, `[AgentClient] ${this.name} connect_error`)
                reject(err)
            })
        })
    }

    async disconnect(): Promise<void> {
        const sessions = [...this.activeSessions.values()]
        for (const sessionId of sessions) {
            this.markSessionInterrupted(sessionId)
            await this.chatRunService?.abortSession(sessionId, 'Coding agent removed, reconfigured, or disconnected')
                .catch((err: any) => {
                    logger.warn(`[AgentClients] failed to abort disconnected coding-agent session ${sessionId}: ${err?.message || err}`)
                })
            await this.chatRunService?.disposeSession?.(sessionId).catch((err: any) => {
                logger.warn(`[AgentClients] failed to dispose disconnected coding-agent session ${sessionId}: ${err?.message || err}`)
            })
        }
        this.activeSessions.clear()
        this.eventSink?.disconnect?.()
        if (this.socket) {
            this.socket.disconnect()
            this.socket = null
            this.joinedRooms.clear()
            this.bridgeContextCache.clear()
        }
        this.pendingToolCallIds.clear()
        this.pendingToolBaseIds.clear()
        this.pendingToolRunIds.clear()
        this.pendingToolNames.clear()
        this.pendingToolExternalIds.clear()
        this.pendingToolCompletionEvents.clear()
        this.acknowledgedToolCallIds.clear()
    }

    respondApproval(approvalId: string, choice: string): Promise<boolean> {
        if (!this.chatRunService?.respondCodingAgentApproval) return Promise.resolve(false)
        for (const sessionId of this.activeSessions.values()) {
            if (this.chatRunService.respondCodingAgentApproval(sessionId, approvalId, choice)) return Promise.resolve(true)
        }
        return Promise.resolve(false)
    }

    respondClarify(clarifyId: string, response: string): Promise<boolean> {
        if (!this.chatRunService?.respondCodingAgentClarification) return Promise.resolve(false)
        for (const sessionId of this.activeSessions.values()) {
            if (this.chatRunService.respondCodingAgentClarification(sessionId, clarifyId, response)) return Promise.resolve(true)
        }
        return Promise.resolve(false)
    }

    async cancelClarify(clarifyId: string, sessionId: string, runId: string): Promise<boolean> {
        if (this.agent !== 'ekko') return false
        return cancelGroupEkkoClarification(sessionId, clarifyId, runId).resolved
    }

    async joinRoom(roomId: string): Promise<JoinResult> {
        this.ensureConnected()
        return new Promise((resolve, reject) => {
            this.socket!.emit('join', { roomId }, (res: JoinResult | { error: string }) => {
                if ('error' in res) {
                    reject(new Error(res.error))
                } else {
                    this.joinedRooms.add(roomId)
                    resolve(res)
                }
            })
        })
    }

    sendMessage(roomId: string, content: string, messageId?: string, extra?: Record<string, unknown>, agentSessionId?: string): Promise<string> {
        this.ensureConnected()
        // Preserve the legacy implicit-assistant call shape, but never classify
        // runtime Tool payload text as conversational routing intent.
        const role = typeof extra?.role === 'string' ? extra.role : undefined
        const canCarryMentions = role === undefined || role === 'user' || role === 'assistant'
        const generatedMentions = canCarryMentions ? this.mentionBuilder?.(roomId, content) || [] : []
        const mentions = generatedMentions.length > 0
            ? generatedMentions
            : (canCarryMentions ? this.structuredMentionsForAgentReply(roomId, content) : [])
        const messageExtra = canCarryMentions ? { ...extra, mentions } : extra
        if (role === 'assistant' && messageId) {
            this.storage?.registerTrustedAgentMessageMetadata?.(
                roomId,
                messageId,
                extra?.mentionDepth,
                extra?.handoffChainId,
                extra?.continuationAttemptId,
            )
        }
        if (this.eventSink) {
            return this.eventSink.sendMessage(roomId, content, messageId, messageExtra, agentSessionId)
        }
        return new Promise((resolve, reject) => {
            this.socket!.emit('message', {
                roomId,
                content,
                id: messageId,
                ...messageExtra,
                ...(agentSessionId ? { agentSessionId } : {}),
            }, (res: { id?: string; error?: string }) => {
                if (res.error) {
                    reject(new Error(res.error))
                } else {
                    resolve(res.id!)
                }
            })
        })
    }

    private structuredMentionsForAgentReply(roomId: string, content: string): StructuredMentionEntry[] {
        const rawAgents = this.storage?.getRoomAgents?.(roomId)
        const agents = Array.isArray(rawAgents) ? rawAgents : []
        if (isAllAgentsMentioned(content)) return [{ type: 'all', displayName: 'all' }]
        const byName = new Map<string, Array<{ agentId: string; name: string }>>()
        for (const agent of agents) {
            const participantId = String(agent?.agentId || '').trim()
            const displayName = String(agent?.name || '').trim()
            if (!participantId || !displayName || participantId === this.agentId) continue
            const matches = byName.get(displayName) || []
            matches.push({ agentId: participantId, name: displayName })
            byName.set(displayName, matches)
        }
        return [...byName.values()]
            .filter(matches => matches.length === 1 && isAgentMentioned(content, matches[0].name))
            .map(matches => ({ type: 'agent' as const, participantId: matches[0].agentId, displayName: matches[0].name }))
    }

    startTyping(roomId: string): void {
        this.ensureConnected()
        if (this.eventSink) {
            this.eventSink.emit('typing', { roomId })
            return
        }
        this.socket!.emit('typing', { roomId })
    }

    stopTyping(roomId: string): void {
        this.ensureConnected()
        if (this.eventSink) {
            this.eventSink.emit('stop_typing', { roomId })
            return
        }
        this.socket!.emit('stop_typing', { roomId })
    }

    emitContextStatus(roomId: string, status: 'compressing' | 'replying' | 'ready', extra?: Record<string, unknown>, agentSessionId?: string): void {
        this.ensureConnected()
        const payload = { roomId, agentName: this.name, status, ...extra, ...(agentSessionId ? { agentSessionId } : {}) }
        if (this.eventSink) {
            this.eventSink.emit('context_status', payload)
            return
        }
        this.socket!.emit('context_status', payload)
    }

    emitApprovalRequested(roomId: string, payload: Record<string, unknown>): void {
        this.ensureConnected()
        const event = { roomId, agentName: this.name, ...payload }
        if (this.eventSink) {
            this.eventSink.emit('approval.requested', event)
            return
        }
        this.socket!.emit('approval.requested', event)
    }

    emitApprovalResolved(roomId: string, payload: Record<string, unknown>): void {
        this.ensureConnected()
        const event = { roomId, agentName: this.name, ...payload }
        if (this.eventSink) {
            this.eventSink.emit('approval.resolved', event)
            return
        }
        this.socket!.emit('approval.resolved', event)
    }

    emitClarifyRequested(roomId: string, payload: Record<string, unknown>): void {
        this.ensureConnected()
        const event = { roomId, agentName: this.name, ...payload }
        if (this.eventSink) {
            this.eventSink.emit('clarify.requested', event)
            return
        }
        this.socket!.emit('clarify.requested', event)
    }

    emitClarifyResolved(roomId: string, payload: Record<string, unknown>): void {
        this.ensureConnected()
        const event = { roomId, agentName: this.name, ...payload }
        if (this.eventSink) {
            this.eventSink.emit('clarify.resolved', event)
            return
        }
        this.socket!.emit('clarify.resolved', event)
    }

    async interrupt(roomId: string): Promise<boolean> {
        const sessionId = this.activeSessions.get(roomId)
        if (!sessionId) return true
        if (this.agent !== 'hermes') {
            if (!this.chatRunService) throw new Error('Chat run service is not ready')
            await this.chatRunService.abortSession(sessionId, 'Interrupted by group chat user')
            this.markSessionInterrupted(sessionId)
            const abortedStates = this.markWorkspaceDiffAborted(roomId)
            try {
                for (const state of abortedStates) {
                    await this.finalizeWorkspaceDiffOnce(state, 'aborted', null)
                }
            } finally {
                try { this.stopTyping(roomId) } catch { /* disconnected */ }
                try { this.emitContextStatus(roomId, 'ready', undefined, sessionId) } catch { /* disconnected */ }
            }
            return true
        }
        let result: Awaited<ReturnType<GroupPrimaryAgentBridge['interrupt']>> | null = null
        try {
            result = await createGroupPrimaryAgentBridge().interrupt(sessionId, 'Interrupted by group chat user', this.profile)
        } catch (err) {
            if (!isUnknownBridgeSessionError(err)) throw err
            logger.info(`[AgentClients] ${this.name}: bridge session ${sessionId} was already idle/missing during interrupt`)
        }
        const synced = result?.synced !== false
        if (!synced) return false
        this.markSessionInterrupted(sessionId)
        const abortedStates = this.markWorkspaceDiffAborted(roomId)
        try {
            for (const state of abortedStates) {
                await this.finalizeWorkspaceDiffOnce(state, 'aborted', null)
            }
        } finally {
            try {
                this.stopTyping(roomId)
            } catch (err: any) {
                logger.warn(`[AgentClients] ${this.name}: failed to emit stop_typing after interrupt: ${err.message || err}`)
            }
            try {
                this.emitContextStatus(roomId, 'ready', undefined, sessionId)
            } catch (err: any) {
                logger.warn(`[AgentClients] ${this.name}: failed to emit ready status after interrupt: ${err.message || err}`)
            }
        }
        return true
    }

    emitMessageStreamStart(roomId: string, messageId: string, agentSessionId?: string, responseRunId?: string): void {
        this.ensureConnected()
        const payload = {
            roomId,
            id: messageId,
            senderId: this.id || this.agentId,
            senderName: this.name,
            timestamp: Date.now(),
            ...(responseRunId ? { run_id: responseRunId } : {}),
            ...(agentSessionId ? { agentSessionId } : {}),
        }
        if (this.eventSink) {
            this.eventSink.emit('message_stream_start', payload)
            return
        }
        this.socket!.emit('message_stream_start', payload)
    }

    emitMessageStreamDelta(roomId: string, messageId: string, delta: string, agentSessionId?: string): void {
        if (!delta) return
        this.ensureConnected()
        const payload = { roomId, id: messageId, delta, ...(agentSessionId ? { agentSessionId } : {}) }
        if (this.eventSink) {
            this.eventSink.emit('message_stream_delta', payload)
            return
        }
        this.socket!.emit('message_stream_delta', payload)
    }

    emitMessageReasoningDelta(roomId: string, messageId: string, delta: string, agentSessionId?: string): void {
        if (!delta) return
        this.ensureConnected()
        const payload = { roomId, id: messageId, delta, ...(agentSessionId ? { agentSessionId } : {}) }
        if (this.eventSink) {
            this.eventSink.emit('message_reasoning_delta', payload)
            return
        }
        this.socket!.emit('message_reasoning_delta', payload)
    }

    emitMessageStreamEnd(roomId: string, messageId: string, agentSessionId?: string): void {
        this.ensureConnected()
        const payload = { roomId, id: messageId, ...(agentSessionId ? { agentSessionId } : {}) }
        if (this.eventSink) {
            this.eventSink.emit('message_stream_end', payload)
            return
        }
        this.socket!.emit('message_stream_end', payload)
    }

    getJoinedRooms(): string[] {
        return Array.from(this.joinedRooms)
    }

    getActiveSessionId(roomId: string): string | undefined {
        return this.activeSessions.get(roomId)
    }

    isActiveSession(roomId: string, sessionId: string): boolean {
        return this.activeSessions.get(roomId) === sessionId
    }

    private finiteToken(value: unknown): number | undefined {
        return typeof value === 'number' && Number.isFinite(value) && value >= 0
            ? Math.floor(value)
            : undefined
    }

    private cacheBridgeContext(
        sessionId: string,
        data: Record<string, unknown> | GroupPrimaryAgentBridgeContextEstimate,
        instructions?: string,
        modelContext: GroupModelContext = { model: '', provider: '' },
    ): void {
        const fixedContextTokens = this.finiteToken(data.fixed_context_tokens)
        if (fixedContextTokens == null) return
        this.bridgeContextCache.set(sessionId, {
            fixedContextTokens,
            instructions,
            systemPromptTokens: this.finiteToken(data.system_prompt_tokens),
            toolTokens: this.finiteToken(data.tool_tokens),
            systemPromptChars: this.finiteToken(data.system_prompt_chars),
            toolCount: this.finiteToken(data.tool_count),
            toolNames: Array.isArray(data.tool_names) ? data.tool_names.map(String) : undefined,
            profile: typeof data.profile === 'string' ? data.profile : undefined,
            model: typeof data.model === 'string' ? data.model : modelContext.model || undefined,
            provider: typeof data.provider === 'string' ? data.provider : modelContext.provider || undefined,
        })
    }

    private estimateHistoryMessageTokens(history: GroupEstimateMessage[]): number {
        return estimateGroupHistoryMessageTokens(history)
    }

    private estimateWithCachedBridgeContext(sessionId: string, history: GroupEstimateMessage[], instructions: string | undefined, modelContext: GroupModelContext): number | undefined {
        const cache = this.bridgeContextCache.get(sessionId)
        if (!cache) return undefined
        if (cache.instructions !== instructions) return undefined
        if (!isGroupBridgeContextCacheCompatible(cache, modelContext)) return undefined
        return groupContextTokensWithFixedOverhead(cache.fixedContextTokens, history)
    }

    private async estimateGroupContextTokens(
        roomId: string,
        sessionId: string,
        bridge: GroupPrimaryAgentBridge,
        history: GroupEstimateMessage[],
        instructions: string | undefined,
        modelContext: GroupModelContext,
        phase: string,
    ): Promise<number | undefined> {
        const cachedTokens = this.estimateWithCachedBridgeContext(sessionId, history, instructions, modelContext)
        if (cachedTokens != null) {
            logger.info({
                roomId,
                agentName: this.name,
                profile: this.profile,
                sessionId,
                messages: history.length,
                fixedContextTokens: this.bridgeContextCache.get(sessionId)?.fixedContextTokens,
                messageTokens: cachedTokens - (this.bridgeContextCache.get(sessionId)?.fixedContextTokens || 0),
                fullContextTokens: cachedTokens,
                phase,
                source: 'cache',
            }, '[GroupChat] full context estimate')
            return cachedTokens
        }

        const estimate = await bridge.contextEstimate(
            sessionId,
            history,
            instructions,
            this.profile,
            {
                ...(modelContext.model ? { model: modelContext.model } : {}),
                ...(modelContext.provider ? { provider: modelContext.provider } : {}),
                background_delegation_enabled: this.backgroundDelegationEnabled,
            },
        )
        this.cacheBridgeContext(sessionId, estimate, instructions, modelContext)
        const totalTokens = Number(estimate.token_count || 0)
        logger.info({
            roomId,
            agentName: this.name,
            profile: this.profile,
            sessionId,
            messages: estimate.message_count,
            toolCount: estimate.tool_count,
            systemPromptChars: estimate.system_prompt_chars,
            fixedContextTokens: estimate.fixed_context_tokens,
            fullContextTokens: estimate.token_count,
            phase,
            source: 'bridge',
        }, '[GroupChat] full context estimate')
        return Number.isFinite(totalTokens) && totalTokens > 0 ? Math.floor(totalTokens) : undefined
    }

    private ensureConnected(): void {
        if (!this.connected) {
            throw new Error(`Agent "${this.name}" is not connected`)
        }
    }

    private workspaceDiffKey(roomId: string, sessionId: string, runId: string): string {
        return `${roomId}\u0000${sessionId}\u0000${runId}`
    }

    private beginWorkspaceDiffIfNeeded(args: { roomId: string; sessionId: string; runId: string; responseRunId: string; workspace: string }): WorkspaceDiffRunState | null {
        if (!args.workspace) return null
        startWorkspaceRunCheckpoint({
            sessionId: args.sessionId,
            runId: args.runId,
            workspace: args.workspace,
        })
        const state: WorkspaceDiffRunState = { ...args, abortRequested: false, finalized: false }
        this.workspaceDiffRuns.set(this.workspaceDiffKey(args.roomId, args.sessionId, args.runId), state)
        return state
    }

    private discardWorkspaceDiffRun(state: WorkspaceDiffRunState | null): void {
        if (!state) return
        this.workspaceDiffRuns.delete(this.workspaceDiffKey(state.roomId, state.sessionId, state.runId))
        discardWorkspaceRunCheckpoint({ sessionId: state.sessionId, runId: state.runId })
    }

    private interruptVersion(sessionId: string): number {
        return this.interruptVersions.get(sessionId) || 0
    }

    private markSessionInterrupted(sessionId: string): void {
        this.interruptVersions.set(sessionId, this.interruptVersion(sessionId) + 1)
    }

    private replySessionIsCurrent(roomId: string, sessionId: string, interruptVersion: number): boolean {
        return this.roomSessionIsCurrent(roomId, sessionId) && this.interruptVersion(sessionId) === interruptVersion
    }

    private roomSessionIsCurrent(roomId: string, sessionId: string): boolean {
        return Boolean(this.storage?.getRoom?.(roomId))
            && this.activeSessions.get(roomId) === sessionId
    }

    private markWorkspaceDiffAborted(roomId: string): WorkspaceDiffRunState[] {
        const aborted: WorkspaceDiffRunState[] = []
        for (const state of this.workspaceDiffRuns.values()) {
            if (state.roomId === roomId) {
                state.abortRequested = true
                aborted.push(state)
            }
        }
        return aborted
    }

    private async finalizeWorkspaceDiffOnce(
        state: WorkspaceDiffRunState | null,
        status: WorkspaceDiffTerminalStatus,
        parentMessageId?: string | null,
    ): Promise<void> {
        if (!state) return
        const key = this.workspaceDiffKey(state.roomId, state.sessionId, state.runId)
        const current = this.workspaceDiffRuns.get(key)
        if (!current || current.finalized) return
        if (!this.roomSessionIsCurrent(current.roomId, current.sessionId)) {
            this.discardWorkspaceDiffRun(current)
            return
        }
        current.finalized = true
        this.workspaceDiffRuns.delete(key)
        const finalStatus = current.abortRequested ? 'aborted' : status
        let draft
        try {
            draft = completeWorkspaceRunCheckpointDraft({
                sessionId: current.sessionId,
                runId: current.runId,
                workspace: current.workspace,
            })
        } catch (err) {
            logger.warn({ err, roomId: current.roomId, sessionId: current.sessionId, runId: current.runId }, '[GroupChat] failed to complete workspace diff draft')
            return
        }
        if (!draft) return
        try {
            const saved = this.storage?.saveWorkspaceDiffMessageForRun?.({
                roomId: current.roomId,
                senderId: this.agentId,
                senderName: this.name,
                sessionId: current.sessionId,
                runId: current.runId,
                responseRunId: current.responseRunId,
                status: finalStatus,
                workspace: current.workspace,
                draft,
                parentMessageId,
            })
            if (saved?.message) {
                this.workspaceDiffBroadcaster?.(current.roomId, saved.message, saved.totalTokens)
            }
        } catch (err) {
            logger.warn({ err, roomId: current.roomId, sessionId: current.sessionId, runId: current.runId }, '[GroupChat] failed to persist workspace diff message')
        }
    }

    // ─── Hermes Agent Bridge Integration ───────────────────────

    /**
     * Handle an @mention from the server side.
     * Called by AgentClients.processMentions() — no socket round-trip needed.
     * onStatus is called to report context compression progress.
     */
    private groupRuntimeInput(msg: MentionMessage, runtimeContext: GroupRuntimeContext): string | ContentBlock[] {
        const routedPrefix = isAllAgentsMentioned(msg.content)
            ? 'Group chat system: this message mentioned every Agent with @all. You are one of the targets, so reply directly.'
            : `Group chat system: this message mentioned you (${this.name}). Reply directly even if it also mentions other participants; do not return an empty response.`
        const transcript = runtimeContext.history
            .map(item => `${item.role === 'assistant' ? 'Agent' : 'Member'} "${item.senderName}": ${item.content}`)
            .join('\n\n')
        const context = [
            routedPrefix,
            runtimeContext.summary
                ? `The following group chat summary covers everything through the summary anchor:\n<group_chat_summary>\n${runtimeContext.summary}\n</group_chat_summary>`
                : '',
            transcript
                ? `The following group chat history begins after the summary anchor and ends before the current message:\n<group_chat_history>\n${transcript}\n</group_chat_history>`
                : '',
        ].filter(Boolean).join('\n\n')
        const rawInput = msg.input || msg.content
        if (isContentBlockArray(rawInput)) {
            let markedCurrent = false
            return [
                { type: 'text', text: context },
                ...rawInput.map((block) => {
                    if (block.type !== 'text') return block
                    const text = stripMentionRoutingTokens(String(block.text || msg.content), this.name) || msg.content
                    if (markedCurrent) return { ...block, text }
                    markedCurrent = true
                    return { ...block, text: `Current message: ${text}` }
                }),
            ]
        }
        return `${context}\n\nCurrent message: ${stripMentionRoutingTokens(msg.content, this.name) || msg.content}`
    }

    private groupMemoryMessages(
        roomId: string,
        msg: MentionMessage,
        runtimeContext: GroupRuntimeContext,
    ): Array<{
        id: string
        role: 'user' | 'assistant'
        content: string
        metadata: Record<string, unknown>
        createdAt: string
    }> {
        const sessionId = groupRuntimeSessionId(roomId, this.profile, this.name)
        const evidenceId = (messageId: string) => createHash('sha256')
            .update(sessionId)
            .update('\0')
            .update(messageId)
            .digest('hex')
        const messages: Array<{
            id: string
            role: 'user' | 'assistant'
            content: string
            metadata: Record<string, unknown>
            createdAt: string
        }> = runtimeContext.history.map(item => ({
            id: evidenceId(item.id),
            role: item.role,
            content: `${item.senderName}：${item.content}`,
            metadata: {
                senderName: item.senderName,
                groupMessageId: item.id,
            },
            createdAt: new Date(item.timestamp).toISOString(),
        }))
        const currentText = stripMentionRoutingTokens(msg.content, this.name) || msg.content
        messages.push({
            id: evidenceId(msg.messageId || `${msg.senderId}:${msg.timestamp}:${currentText}`),
            role: msg.role === 'assistant' ? 'assistant' : 'user',
            content: `${msg.senderName}：${currentText}`,
            metadata: {
                senderId: msg.senderId,
                senderName: msg.senderName,
                ...(msg.messageId ? { groupMessageId: msg.messageId } : {}),
            },
            createdAt: new Date(msg.timestamp).toISOString(),
        })
        return messages
    }

    private groupSystemPrompt(roomId: string, msg?: MentionMessage): string {
        const room = this.storage?.getRoom?.(roomId)
        const rawMembers = this.storage?.getRoomMembers?.(roomId)
        const rawAgents = this.storage?.getMentionableRoomAgents?.(roomId)
            ?? this.storage?.getRoomAgents?.(roomId)
        const humanMembers = Array.isArray(rawMembers) ? rawMembers : []
        const roomAgents = Array.isArray(rawAgents) ? rawAgents : []
        const members = [
            ...humanMembers.map((member: any) => ({
                userId: String(member.userId || member.id || ''),
                name: String(member.name || ''),
                description: String(member.description || ''),
                kind: 'human' as const,
            })),
            ...roomAgents.map((agent: any) => ({
                userId: String(agent.agentId || agent.id || ''),
                name: String(agent.name || ''),
                description: String(agent.description || ''),
                kind: 'agent' as const,
            })),
        ].filter(member => member.name)
        const instructions = buildAgentInstructions({
            agentName: this.name,
            roomName: String(room?.name || roomId),
            agentDescription: this.description,
            memberNames: members.map(member => member.name),
            members,
        })
        const promptParts = [instructions]
        const remoteWorkspaceApi = room?.remoteWorkspaceApi
        if (
            remoteWorkspaceApi
            && remoteWorkspaceApi.access === 'read-write'
            && typeof remoteWorkspaceApi.endpoint === 'string'
            && typeof remoteWorkspaceApi.token === 'string'
        ) {
            promptParts.push([
                'This run may access the sharing host\'s group-chat workspace through a short-lived HTTP JSON API.',
                'Your current local working directory is separate; use this API only when files must be shared with the room owner or other Agents.',
                `Endpoint: ${remoteWorkspaceApi.endpoint}`,
                `Authorization header: Bearer ${remoteWorkspaceApi.token}`,
                'Send POST requests with Content-Type: application/json.',
                'Supported request bodies:',
                '{"action":"list","path":""}',
                '{"action":"read","path":"relative/file.txt"}',
                '{"action":"write","path":"relative/file.txt","content":"text","expectedSha256":"hash returned by read"}',
                '{"action":"mkdir","path":"relative/directory"}',
                '{"action":"delete","path":"relative/file.txt","expectedSha256":"hash returned by read"}',
                `Binary download: GET ${remoteWorkspaceApi.endpoint}/file?path=<URL-encoded relative path>.`,
                `Binary upload: PUT ${remoteWorkspaceApi.endpoint}/file?path=<URL-encoded relative path> with Content-Type: application/octet-stream and the raw file body.`,
                'A successful binary upload returns the workspace path and automatically sends a separate Agent attachment message whose text body is that workspace-relative path and whose image/file block uses the same format as the message composer. JSON write actions do not send attachment messages. Do not repeat a binary-upload attachment as Markdown or JSON in your final reply.',
                'Downloads return the SHA-256 in the X-Content-SHA256 header. Replacing an existing file requires that value in the X-Expected-SHA256 upload header; new files do not require the header.',
                'Binary uploads and downloads are limited to 20 MiB per file.',
                'Paths must be relative to the shared group-chat workspace. Existing files require the SHA-256 returned by read before write or delete.',
                'The authorization expires when this run finishes. Never repeat the token in chat output.',
            ].join('\n'))
        }
        if (
            msg?.targetOwnerMemberId
            && msg.senderId
            && msg.senderId !== msg.targetOwnerMemberId
        ) {
            promptParts.push(buildNonOwnerRequestSecurityPrompt({
                requesterName: msg.senderName,
                requesterId: msg.senderId,
                ownerMemberId: msg.targetOwnerMemberId,
                workspaceRoot: String(room?.workspace || '').trim(),
            }))
        }
        return promptParts.join('\n\n')
    }

    private groupConversationHistory(runtimeContext: GroupRuntimeContext): Array<{ role: 'user' | 'assistant'; content: string }> {
        const history: Array<{ role: 'user' | 'assistant'; content: string }> = []
        if (runtimeContext.summary) {
            history.push({
                role: 'user',
                content: `[Group chat history summary]\n${runtimeContext.summary}`,
            })
        }
        for (const message of runtimeContext.history) {
            history.push({
                role: message.role,
                content: `${message.senderName}：${message.content}`,
            })
        }
        return history
    }

    private async replyToMentionWithChatRun(
        roomId: string,
        msg: MentionMessage,
        runtimeContext: GroupRuntimeContext,
        onStatus?: (status: 'compressing' | 'replying' | 'ready', extra?: Record<string, unknown>) => void,
    ): Promise<void> {
        if (!this.chatRunService) throw new Error('Chat run service is not ready')
        const responseRunId = groupMessageId(roomId, this.profile, this.name)
        const pushRoot = findPushRunLink('group_root', roomId, msg.handoffChainId || msg.messageId || '')
        if (pushRoot) linkPushRun('group_runtime', roomId, responseRunId, pushRoot)
        const runMessageId = groupMessagePartId(responseRunId, 0)
        const sessionId = groupRuntimeSessionId(roomId, this.profile, this.name)
        this.activeSessions.set(roomId, sessionId)
        const interruptVersion = this.interruptVersion(sessionId)
        const reportStatus = (status: 'compressing' | 'replying' | 'ready') => {
            onStatus?.(status, { agentSessionId: sessionId, runId: responseRunId })
        }
        let streamStarted = false
        let streamEnded = false
        let currentContent = ''
        let reasoningContent = ''
        let sawReasoningDelta = false
        let abortRequested = false
        let workspaceRunState: WorkspaceDiffRunState | null = null
        let toolEventWrites = Promise.resolve()
        const isCurrent = () => this.replySessionIsCurrent(roomId, sessionId, interruptVersion)
        const queueToolEventWrite = (write: () => Promise<void>) => {
            toolEventWrites = toolEventWrites
                .then(write)
                .catch((err: any) => logger.warn(`[AgentClients] failed to record group tool event: ${err.message || err}`))
        }
        const endStream = () => {
            if (!streamStarted || streamEnded) return
            streamEnded = true
            this.emitMessageStreamEnd(roomId, runMessageId, sessionId)
        }
        try {
            this.startTyping(roomId)
            reportStatus('replying')
            this.emitMessageStreamStart(roomId, runMessageId, sessionId, responseRunId)
            streamStarted = true
            const workspace = String(this.storage?.getRoom?.(roomId)?.workspace || '').trim()
            if (workspace) {
                workspaceRunState = this.beginWorkspaceDiffIfNeeded({
                    roomId,
                    sessionId,
                    runId: runMessageId,
                    responseRunId,
                    workspace,
                })
            }
            const codingAgentId = this.agent === 'ekko'
                ? 'ekko-agent'
                : this.agent === 'claude'
                    ? 'claude-code'
                    : this.agent === 'pi'
                        ? 'pi'
                        : this.agent === 'grok'
                            ? 'grok'
                            : this.agent === 'dsh' ? 'dsh' : this.agent === 'opencode'
                                ? 'opencode'
                                : 'codex'
            const usesGlobalCodingAgent = this.agentMode === 'global' && codingAgentId !== 'ekko-agent'
            const groupSystemPrompt = this.groupSystemPrompt(roomId, msg)
            const executionUser = groupRunUser(this.storage, roomId, this.profile, msg)
            const result = await this.chatRunService.runAndWait({
                input: this.groupRuntimeInput(msg, runtimeContext),
                session_id: sessionId,
                ...(usesGlobalCodingAgent ? {} : {
                    model: this.model || undefined,
                    provider: this.provider || undefined,
                }),
                ...(!usesGlobalCodingAgent && this.apiMode ? { apiMode: this.apiMode } : {}),
                instructions: groupSystemPrompt,
                group_system_prompt: groupSystemPrompt,
                group_room_id: roomId,
                group_agent_id: this.agentId,
                workspace: workspace || null,
                source: 'group_chat',
                session_source: 'group_chat',
                coding_agent_id: codingAgentId,
                mode: usesGlobalCodingAgent ? 'global' : 'scoped',
                profile: this.profile,
                ...(this.agentPreset ? { agent_preset: this.agentPreset } : {}),
                ...(!usesGlobalCodingAgent && this.reasoningEffort
                    ? { reasoning_effort: this.reasoningEffort }
                    : {}),
                background_delegation_enabled: false,
                context_compression_enabled: false,
                ...(codingAgentId === 'ekko-agent'
                    ? {
                        memory_messages: this.groupMemoryMessages(roomId, msg, runtimeContext),
                        memory_write_policy: 'automatic' as const,
                        memory_origin: {
                            host: 'hermes-studio',
                            namespace: 'group-chat',
                            contextId: roomId,
                        },
                        memory_recall_scopes: [
                            { type: 'profile' },
                            { type: 'context', namespace: 'studio.group-chat', id: roomId },
                            { type: 'session', id: sessionId },
                        ],
                        memory_write_scopes: [
                            { type: 'profile' },
                            { type: 'context', namespace: 'studio.group-chat', id: roomId },
                            { type: 'session', id: sessionId },
                        ],
                        memory_default_write_scope: {
                            type: 'context',
                            namespace: 'studio.group-chat',
                            id: roomId,
                        },
                    }
                    : {}),
            }, {
                profile: this.profile,
                user: executionUser,
                groupRunIsCurrent: () => isCurrent() && (!executionUser
                    || groupRunUser(this.storage, roomId, this.profile, msg)?.id === executionUser.id),
                ...(pushRoot ? { pushRoot: { kind: pushRoot.kind, profile: pushRoot.profile, runId: pushRoot.run_id } } : {}),
                onEvent: (event, payload = {}) => {
                    // Keep the terminal card after a user interrupt, while still rejecting an old room session.
                    if (event === 'plan.updated' && payload.execution_state !== 'running' && this.roomSessionIsCurrent(roomId, sessionId)) {
                        queueToolEventWrite(() => this.recordTaskPlan(roomId, sessionId, responseRunId, payload))
                        return
                    }
                    if (!isCurrent()) {
                        if (!abortRequested) {
                            abortRequested = true
                            void this.chatRunService?.abortSession(sessionId, 'Interrupted because group chat room state changed')
                        }
                        return
                    }
                    if (event === 'message.delta' && typeof payload.delta === 'string') {
                        currentContent += payload.delta
                        this.emitMessageStreamDelta(roomId, runMessageId, payload.delta, sessionId)
                    } else if ((event === 'reasoning.delta' || event === 'thinking.delta') && typeof payload.delta === 'string') {
                        sawReasoningDelta = true
                        reasoningContent += payload.delta
                        this.emitMessageReasoningDelta(roomId, runMessageId, payload.delta, sessionId)
                    } else if (event === 'plan.updated') {
                        queueToolEventWrite(() => this.recordTaskPlan(roomId, sessionId, responseRunId, payload))
                    } else if (event === 'tool.started') {
                        const toolReasoning = reasoningContent
                        reasoningContent = ''
                        queueToolEventWrite(() => this.recordToolStarted(
                            roomId,
                            sessionId,
                            payload,
                            runMessageId,
                            responseRunId,
                            toolReasoning,
                        ))
                    } else if (event === 'tool.completed' || event === 'tool.failed') {
                        queueToolEventWrite(() => this.recordToolCompleted(roomId, sessionId, { ...payload, event }).then(() => undefined))
                    } else if (event === 'approval.requested') {
                        const { run_id: _runtimeRunId, runId: _runtimeCamelRunId, ...approvalPayload } = payload
                        this.emitApprovalRequested(roomId, {
                            ...approvalPayload,
                            agentSessionId: sessionId,
                            runId: responseRunId,
                        })
                    } else if (event === 'approval.resolved') {
                        this.emitApprovalResolved(roomId, { ...payload, agentSessionId: sessionId })
                    } else if (event === 'clarify.requested') {
                        const { run_id: runtimeRunId, runId: runtimeCamelRunId, ...clarifyPayload } = payload
                        this.emitClarifyRequested(roomId, {
                            ...clarifyPayload,
                            agentSessionId: sessionId,
                            runId: responseRunId,
                            runtimeRunId: String(runtimeRunId || runtimeCamelRunId || ''),
                        })
                    } else if (event === 'clarify.resolved') {
                        this.emitClarifyResolved(roomId, { ...payload, agentSessionId: sessionId })
                    }
                },
            })
            if (!isCurrent()) {
                await toolEventWrites
                await this.completePendingToolsForRun(roomId, sessionId, responseRunId)
                this.discardPendingToolsForRun(responseRunId)
                return
            }
            await toolEventWrites
            const toolResultsPersisted = await this.completePendingToolsForRun(roomId, sessionId, responseRunId)
            if (!toolResultsPersisted) throw new Error('One or more Tool results could not be persisted after bounded retries')
            if (!result.ok) throw new Error(result.error || 'Run failed')
            const finalContent = String(result.output || currentContent || '').trim()
            if (!sawReasoningDelta) reasoningContent = String(result.reasoning || reasoningContent || '')
            if (finalContent) {
                if (!currentContent) this.emitMessageStreamDelta(roomId, runMessageId, finalContent, sessionId)
                this.stopTyping(roomId)
                await this.sendMessage(roomId, finalContent, runMessageId, {
                    role: 'assistant',
                    run_id: responseRunId,
                    mentionDepth: nextMentionDepth(msg),
                    handoffChainId: msg.handoffChainId || msg.messageId || '',
                    continuationAttemptId: msg.continuationAttemptId || '',
                    reasoning: reasoningContent || null,
                    reasoning_content: reasoningContent || null,
                }, sessionId)
            }
            endStream()
            await this.finalizeWorkspaceDiffOnce(workspaceRunState, 'completed', finalContent ? runMessageId : null)
            reportStatus('ready')
        } catch (err) {
            if (!isCurrent()) {
                await toolEventWrites
                await this.completePendingToolsForRun(roomId, sessionId, responseRunId)
                this.discardPendingToolsForRun(responseRunId)
                return
            }
            await toolEventWrites
            await this.completePendingToolsForRun(roomId, sessionId, responseRunId)
            await this.finalizeWorkspaceDiffOnce(workspaceRunState, 'failed', streamStarted ? runMessageId : null)
            await this.sendAgentErrorMessage(roomId, runMessageId, err, msg, reasoningContent, sessionId, responseRunId)
            endStream()
            reportStatus('ready')
        } finally {
            try { endStream() } catch { /* stale room session */ }
            if (this.roomSessionIsCurrent(roomId, sessionId)) {
                try { this.stopTyping(roomId) } catch { /* disconnected */ }
                this.activeSessions.delete(roomId)
            }
            await this.chatRunService.disposeSession?.(sessionId).catch((err: any) => {
                logger.warn(`[AgentClients] failed to dispose temporary group chat session ${sessionId}: ${err.message || err}`)
            })
        }
    }

    async replyToMention(
        roomId: string,
        msg: MentionMessage,
        runtimeContext: GroupRuntimeContext = { summary: '', history: [] },
        onStatus?: (status: 'compressing' | 'replying' | 'ready', extra?: Record<string, unknown>) => void,
    ): Promise<void> {
        logger.debug(`[AgentClients] ${this.name} mentioned by ${msg.senderName}: "${msg.content.slice(0, 50)}"`)
        if (this.agent !== 'hermes') {
            await this.replyToMentionWithChatRun(roomId, msg, runtimeContext, onStatus)
            return
        }
        const runMessageId = groupMessageId(roomId, this.profile, this.name)
        const pushRoot = findPushRunLink('group_root', roomId, msg.handoffChainId || msg.messageId || '')
        if (pushRoot) linkPushRun('group_runtime', roomId, runMessageId, pushRoot)
        let partIndex = 0
        let streamMessageId = groupMessagePartId(runMessageId, partIndex)
        let currentContent = ''
        let totalContent = ''
        let reasoningContent = ''
        let streamStarted = false
        let bridgeStarted = false
        let workspaceRunState: WorkspaceDiffRunState | null = null
        let activeSessionId = ''
        let activeReplyInterruptVersion = 0
        let groupPlan: ReturnType<NonNullable<GroupChatRunService['beginGroupTaskPlanRun']>> | undefined
        let planWrites = Promise.resolve()
        let planFailed = false
        let staleStartedRunStopped = false
        let stopStaleStartedRun: ((reason?: string) => Promise<void>) | null = null
        try {
            // Notify room that agent is typing
            this.startTyping(roomId)

            const conversationHistory = this.groupConversationHistory(runtimeContext)
            const mcpCapabilities = await hermesStudioMcpCapabilities(this.profile)
            let instructions = [this.groupSystemPrompt(roomId, msg), studioMcpUsageGuidelines(mcpCapabilities)].filter(Boolean).join('\n\n')
            const bridge = createGroupPrimaryAgentBridge()
            const sessionId = groupRuntimeSessionId(roomId, this.profile, this.name)
            this.activeSessions.set(roomId, sessionId)
            const replyInterruptVersion = this.interruptVersion(sessionId)
            const reportStatus = (status: 'compressing' | 'replying' | 'ready', extra?: Record<string, unknown>) => {
                onStatus?.(status, { ...extra, agentSessionId: sessionId, runId: runMessageId })
            }
            activeSessionId = sessionId
            activeReplyInterruptVersion = replyInterruptVersion
            stopStaleStartedRun = async (reason = 'Interrupted because group chat room state changed') => {
                if (staleStartedRunStopped) return
                staleStartedRunStopped = true
                if (bridgeStarted) {
                    let destroySession = false
                    try {
                        const result = await bridge.interrupt(sessionId, reason, this.profile)
                        destroySession = result?.synced === false
                    } catch (err: any) {
                        destroySession = true
                        logger.warn(`[AgentClients] ${this.name}: failed to interrupt stale bridge run: ${err.message || err}`)
                    }
                    if (destroySession) {
                        try {
                            await bridge.destroy(sessionId, this.profile)
                        } catch (err: any) {
                            logger.warn(`[AgentClients] ${this.name}: failed to destroy stale bridge session: ${err.message || err}`)
                        }
                    }
                    if (streamStarted) {
                        try {
                            this.emitMessageStreamEnd(roomId, streamMessageId, sessionId)
                        } catch (err: any) {
                            logger.warn(`[AgentClients] ${this.name}: failed to end stale stream: ${err.message || err}`)
                        }
                    }
                }
                await this.completePendingToolsForRun(roomId, sessionId, runMessageId)
                this.discardPendingToolsForRun(runMessageId)
                this.discardWorkspaceDiffRun(workspaceRunState)
                workspaceRunState = null
                try {
                    this.stopTyping(roomId)
                } catch (err: any) {
                    logger.warn(`[AgentClients] ${this.name}: failed to stop typing after stale bridge run: ${err.message || err}`)
                }
                reportStatus('ready')
            }
            const modelContext = await resolveGroupAgentModelContext(this.profile, this.model, this.provider)

            reportStatus('replying')

            // Keep routing explicit while removing only the mention tokens that
            // selected this agent. This avoids making @all look like an
            // instruction for the model to fan out another routing cycle.
            const routedPrefix = isAllAgentsMentioned(msg.content)
                ? 'Group chat system: this message mentioned every Agent with @all. You are one of the targets, so reply directly.'
                : `Group chat system: this message mentioned you (${this.name}). Reply directly even if it also mentions other participants; do not return an empty response.`
            const rawInput = msg.input || msg.content
            const input = isContentBlockArray(rawInput)
                ? rawInput.map((block) => {
                    if (block.type !== 'text') return block
                    const text = stripMentionRoutingTokens(String(block.text || msg.content), this.name)
                    return { ...block, text: `${routedPrefix}\n\nOriginal message: ${text || msg.content}` }
                })
                : `${routedPrefix}\n\nOriginal message: ${stripMentionRoutingTokens(msg.content, this.name) || msg.content}`
            const runPrompt = 'When calling Hermes Web UI endpoints from tools or skills, include the current Hermes profile as the X-Hermes-Profile header if the endpoint supports profile-scoped behavior.'
            instructions = `${instructions}\n\n${runPrompt}`
            groupPlan = mcpCapabilities.interaction ? this.chatRunService?.beginGroupTaskPlanRun?.(sessionId, this.profile, runMessageId,
                () => this.replySessionIsCurrent(roomId, sessionId, replyInterruptVersion),
                snapshot => { planWrites = planWrites.then(() => this.recordTaskPlan(roomId, sessionId, runMessageId, snapshot)).catch(error => { logger.warn(error, '[GroupChat] task plan delivery failed') }) }) : undefined
            const planInput = withTaskPlanTurnContext(input, groupPlan?.contextId)
            const bridgeInput: GroupPrimaryAgentBridgeMessage = isContentBlockArray(planInput)
                ? await convertContentBlocksForAgent(planInput)
                : planInput as string
            if (!this.replySessionIsCurrent(roomId, sessionId, replyInterruptVersion)) {
                await stopStaleStartedRun?.()
                return
            }
            const flushedAssistantParts = new Set<string>()
            let lastChunk: GroupPrimaryAgentBridgeOutput | null = null
            const roomWorkspace = String(this.storage?.getRoom?.(roomId)?.workspace || '').trim()
            const started = await bridge.chat(
                sessionId,
                bridgeInput,
                conversationHistory,
                instructions,
                this.profile,
                {
                    ...(modelContext.model ? { model: modelContext.model } : {}),
                    ...(modelContext.provider ? { provider: modelContext.provider } : {}),
                    ...(this.reasoningEffort ? { reasoning_effort: this.reasoningEffort } : {}),
                    source: 'api_server',
                    ...(roomWorkspace ? { workspace: roomWorkspace } : {}),
                    // Used only if this operation creates the cached AgentSession.
                    background_delegation_enabled: this.backgroundDelegationEnabled,
                },
            )
            bridgeStarted = true
            if (!this.replySessionIsCurrent(roomId, sessionId, replyInterruptVersion)) {
                await stopStaleStartedRun?.()
                return
            }
            if (roomWorkspace) {
                workspaceRunState = this.beginWorkspaceDiffIfNeeded({
                    roomId,
                    sessionId,
                    runId: started.run_id,
                    responseRunId: runMessageId,
                    workspace: roomWorkspace,
                })
            }

            this.emitMessageStreamStart(roomId, streamMessageId, sessionId, runMessageId)
            streamStarted = true
            for await (const chunk of bridge.streamOutput(started.run_id, { timeoutMs: 120000 })) {
                if (!this.replySessionIsCurrent(roomId, sessionId, replyInterruptVersion)) {
                    await stopStaleStartedRun?.()
                    return
                }
                lastChunk = chunk
                reasoningContent = await this.recordBridgeEvents(
                    roomId,
                    sessionId,
                    replyInterruptVersion,
                    instructions,
                    modelContext,
                    chunk,
                    runMessageId,
                    reasoningContent,
                    () => streamMessageId,
                    async (toolReasoning) => {
                        const toolBaseId = streamMessageId
                        if (currentContent.trim()) {
                            if (!this.replySessionIsCurrent(roomId, sessionId, replyInterruptVersion)) {
                                await stopStaleStartedRun?.()
                                currentContent = ''
                                return toolBaseId
                            }
                            await this.sendMessage(roomId, currentContent, streamMessageId, {
                                role: 'assistant',
                                run_id: runMessageId,
                                mentionDepth: nextMentionDepth(msg),
                                handoffChainId: msg.handoffChainId || msg.messageId || '',
                                continuationAttemptId: msg.continuationAttemptId || '',
                                reasoning: toolReasoning || null,
                                reasoning_content: toolReasoning || null,
                            }, sessionId)
                            flushedAssistantParts.add(streamMessageId)
                            currentContent = ''
                        }
                        this.emitMessageStreamEnd(roomId, toolBaseId, sessionId)
                        partIndex += 1
                        streamMessageId = groupMessagePartId(runMessageId, partIndex)
                        this.emitMessageStreamStart(roomId, streamMessageId, sessionId, runMessageId)
                        streamStarted = true
                        return toolBaseId
                    },
                )
                if (!this.replySessionIsCurrent(roomId, sessionId, replyInterruptVersion)) {
                    await stopStaleStartedRun?.()
                    return
                }
                if (chunk.delta) {
                    currentContent += chunk.delta
                    totalContent += chunk.delta
                    this.emitMessageStreamDelta(roomId, streamMessageId, chunk.delta, sessionId)
                }
            }

            const toolResultsPersisted = await this.completePendingToolsForRun(roomId, sessionId, runMessageId)
            if (!toolResultsPersisted) throw new Error('One or more Tool results could not be persisted after bounded retries')

            if (lastChunk?.status === 'error') {
                logger.error(`[AgentClients] ${this.name}: bridge response failed: ${lastChunk.error || 'unknown error'}`)
                if (!this.replySessionIsCurrent(roomId, sessionId, replyInterruptVersion)) {
                    await stopStaleStartedRun?.()
                    return
                }
                await this.sendAgentErrorMessage(roomId, streamMessageId, lastChunk.error || 'Run failed', msg, reasoningContent, sessionId, runMessageId)
                await this.finalizeWorkspaceDiffOnce(workspaceRunState, 'failed', streamStarted ? streamMessageId : null)
                this.emitMessageStreamEnd(roomId, streamMessageId, sessionId)
                this.stopTyping(roomId)
                reportStatus('ready')
                return
            }

            if (!totalContent) {
                currentContent = extractBridgeFinalText(lastChunk)
                totalContent = currentContent
            }
            if (!this.replySessionIsCurrent(roomId, sessionId, replyInterruptVersion)) {
                await stopStaleStartedRun?.()
                return
            }
            logger.debug(`[AgentClients] ${this.name}: bridge response completed, content length=${totalContent.length}`)
            if (currentContent) {
                if (!this.replySessionIsCurrent(roomId, sessionId, replyInterruptVersion)) {
                    await stopStaleStartedRun?.()
                    return
                }
                this.stopTyping(roomId)
                await this.sendMessage(roomId, currentContent, streamMessageId, {
                    role: 'assistant',
                    run_id: runMessageId,
                    mentionDepth: nextMentionDepth(msg),
                    handoffChainId: msg.handoffChainId || msg.messageId || '',
                    continuationAttemptId: msg.continuationAttemptId || '',
                    reasoning: reasoningContent || null,
                    reasoning_content: reasoningContent || null,
                }, sessionId)
                this.emitMessageStreamEnd(roomId, streamMessageId, sessionId)
                await this.finalizeWorkspaceDiffOnce(workspaceRunState, 'completed', streamMessageId)
                reportStatus('ready')
                return
            }
            logger.warn(`[AgentClients] ${this.name}: bridge response completed without content`)
            if (!this.replySessionIsCurrent(roomId, sessionId, replyInterruptVersion)) {
                await stopStaleStartedRun?.()
                return
            }
            this.emitMessageStreamEnd(roomId, streamMessageId, sessionId)
            await this.finalizeWorkspaceDiffOnce(workspaceRunState, 'completed', streamStarted ? streamMessageId : null)
            this.stopTyping(roomId)
            reportStatus('ready')
        } catch (err: any) {
            planFailed = true
            logger.error(`[AgentClients] ${this.name}: error handling message: ${err.message}`)
            if (activeSessionId && !this.replySessionIsCurrent(roomId, activeSessionId, activeReplyInterruptVersion)) {
                await stopStaleStartedRun?.()
                return
            }
            if (workspaceRunState && !bridgeStarted) {
                await stopStaleStartedRun?.('Interrupted after group chat bridge launch failed')
            } else {
                if (activeSessionId) {
                    await this.completePendingToolsForRun(roomId, activeSessionId, runMessageId)
                }
                await this.finalizeWorkspaceDiffOnce(workspaceRunState, 'failed', streamStarted ? streamMessageId : null)
            }
            try {
                await this.sendAgentErrorMessage(roomId, streamMessageId, err, msg, reasoningContent, activeSessionId || undefined, runMessageId)
                if (streamStarted) this.emitMessageStreamEnd(roomId, streamMessageId, activeSessionId || undefined)
            } catch (sendErr: any) {
                logger.warn(`[AgentClients] ${this.name}: failed to send error message: ${sendErr.message}`)
            }
            this.stopTyping(roomId)
            if (activeSessionId) {
                onStatus?.('ready', { agentSessionId: activeSessionId, runId: runMessageId })
            } else {
                onStatus?.('ready', { runId: runMessageId })
            }
        } finally {
            try {
                groupPlan?.finish(!this.replySessionIsCurrent(roomId, activeSessionId, activeReplyInterruptVersion) ? 'interrupted' : planFailed ? 'failed' : 'ended')
                await planWrites
            } catch (error) { logger.warn(error, '[GroupChat] task plan finalization failed') }
            if (activeSessionId) {
                if (this.activeSessions.get(roomId) === activeSessionId) this.activeSessions.delete(roomId)
                await createGroupPrimaryAgentBridge().destroy(activeSessionId, this.profile).catch((err: any) => {
                    if (!isUnknownBridgeSessionError(err)) {
                        logger.warn(`[AgentClients] ${this.name}: failed to destroy temporary bridge session: ${err.message || err}`)
                    }
                })
            }
        }
    }

    private async sendAgentErrorMessage(
        roomId: string,
        messageId: string,
        error: unknown,
        sourceMsg: MentionMessage,
        reasoningContent = '',
        sessionId?: string,
        responseRunId?: string,
    ): Promise<void> {
        const detail = error instanceof Error ? error.message : String(error || 'Run failed')
        const content = detail.startsWith('Error:') ? detail : `Error: ${detail}`
        await this.sendMessage(roomId, content, messageId, {
            role: 'assistant',
            ...(responseRunId ? { run_id: responseRunId } : {}),
            mentionDepth: nextMentionDepth(sourceMsg),
            handoffChainId: sourceMsg.handoffChainId || sourceMsg.messageId || '',
            continuationAttemptId: sourceMsg.continuationAttemptId || '',
            finish_reason: 'error',
            reasoning: reasoningContent || null,
            reasoning_content: reasoningContent || null,
        }, sessionId)
    }

    private async recordBridgeEvents(
        roomId: string,
        sessionId: string,
        interruptVersion: number,
        instructions: string | undefined,
        modelContext: GroupModelContext,
        chunk: GroupPrimaryAgentBridgeOutput,
        responseRunId: string,
        initialReasoning: string,
        getCurrentMessageId: () => string,
        beforeToolStarted: (reasoning: string) => Promise<string>,
    ): Promise<string> {
        let reasoning = initialReasoning
        for (const ev of chunk.events || []) {
            if (!this.replySessionIsCurrent(roomId, sessionId, interruptVersion)) return reasoning
            const eventType = String((ev as any)?.event || '')
            if (eventType === 'bridge.context.ready') {
                this.cacheBridgeContext(sessionId, ev as Record<string, unknown>, instructions, modelContext)
            } else if (eventType === 'tool.started') {
                const toolReasoning = reasoning
                const toolBaseId = await beforeToolStarted(toolReasoning)
                if (!this.replySessionIsCurrent(roomId, sessionId, interruptVersion)) return reasoning
                await this.recordToolStarted(roomId, sessionId, ev as Record<string, unknown>, toolBaseId, responseRunId, toolReasoning)
                reasoning = ''
            } else if (eventType === 'tool.completed' || eventType === 'tool.failed') {
                if (!this.replySessionIsCurrent(roomId, sessionId, interruptVersion)) return reasoning
                await this.recordToolCompleted(roomId, sessionId, ev as Record<string, unknown>)
            } else if (eventType === 'approval.requested') {
                this.emitApprovalRequested(roomId, {
                    event: 'approval.requested',
                    agentSessionId: sessionId,
                    runId: responseRunId,
                    approval_id: (ev as any).approval_id,
                    command: (ev as any).command,
                    description: (ev as any).description,
                    choices: Array.isArray((ev as any).choices) ? (ev as any).choices : undefined,
                    allow_permanent: (ev as any).allow_permanent,
                    timeout_ms: (ev as any).timeout_ms,
                })
            } else if (eventType === 'approval.resolved') {
                this.emitApprovalResolved(roomId, {
                    event: 'approval.resolved',
                    agentSessionId: sessionId,
                    approval_id: (ev as any).approval_id,
                    choice: (ev as any).choice,
                })
            } else if (eventType === 'clarify.requested') {
                this.emitClarifyRequested(roomId, {
                    event: 'clarify.requested',
                    agentSessionId: sessionId,
                    runId: responseRunId,
                    runtimeRunId: String((ev as any).run_id || ''),
                    clarify_id: (ev as any).clarify_id,
                    question: (ev as any).question,
                    choices: Array.isArray((ev as any).choices) ? (ev as any).choices : null,
                    initial_response: (ev as any).initial_response,
                    response_mode: (ev as any).response_mode,
                    timeout_ms: (ev as any).timeout_ms,
                })
            } else if (eventType === 'clarify.resolved') {
                this.emitClarifyResolved(roomId, {
                    event: 'clarify.resolved',
                    agentSessionId: sessionId,
                    clarify_id: (ev as any).clarify_id,
                    resolved: (ev as any).resolved,
                    reason: (ev as any).reason,
                })
            } else {
                const text = groupBridgeReasoningDeltaFromEvent(ev as Record<string, unknown>)
                if (text) {
                    reasoning += text
                    this.emitMessageReasoningDelta(roomId, getCurrentMessageId(), text, sessionId)
                }
            }
        }
        return reasoning
    }

    private async recordTaskPlan(roomId: string, sessionId: string, runId: string, snapshot: unknown): Promise<void> {
        const message = groupTaskPlanMessage(roomId, sessionId, runId, snapshot)
        if (message) await this.sendMessage(roomId, message.content, message.id, message.extra, sessionId)
    }

    private recordToolStarted(
        roomId: string,
        sessionId: string,
        ev: Record<string, unknown>,
        runMessageId: string,
        responseRunId: string,
        reasoning = '',
    ): Promise<void> {
        const toolName = String(ev.tool_name || ev.tool || ev.name || '')
        const rawToolCallId = String(ev.tool_call_id || '').trim()
        const externalToolCallId = groupToolCallId(
            rawToolCallId,
            toolName,
            `${roomId}:${sessionId}:${runMessageId}`,
            this.nextAnonymousToolCallSequence(),
        )
        const toolCallId = toolCorrelationId(roomId, sessionId, externalToolCallId)
        this.acknowledgedToolCallIds.delete(toolCallId)
        if (!rawToolCallId || !this.pendingToolBaseIds.has(toolCallId)) {
            this.trackPendingToolCall(roomId, toolName, toolCallId)
        }
        this.pendingToolBaseIds.set(toolCallId, runMessageId)
        this.pendingToolRunIds.set(toolCallId, responseRunId)
        this.pendingToolNames.set(toolCallId, toolName)
        this.pendingToolExternalIds.set(toolCallId, externalToolCallId)
        const timestamp = Date.now()
        const rawArgs = ev.args ?? ev.arguments ?? ev.input ?? {}
        const args = normalizeToolArgs(rawArgs)
        const toolCall = {
            id: externalToolCallId,
            type: 'function',
            function: {
                name: toolName,
                arguments: JSON.stringify(args),
            },
        }
        const msg: MessageData & Record<string, any> = {
            id: groupToolMessageId(runMessageId, 'toolcall', externalToolCallId),
            roomId,
            senderId: this.id || this.agentId,
            senderName: this.name,
            content: '',
            timestamp,
            run_id: responseRunId,
            role: 'assistant',
            tool_calls: [toolCall],
            finish_reason: 'tool_calls',
            reasoning: reasoning || null,
            reasoning_content: reasoning || null,
        }
        return this.sendMessage(roomId, '', msg.id, {
            role: 'assistant',
            run_id: responseRunId,
            tool_calls: msg.tool_calls,
            finish_reason: 'tool_calls',
            reasoning: reasoning || null,
            reasoning_content: reasoning || null,
            timestamp,
        }, sessionId)
            .then(() => undefined)
            .catch((err: any) => logger.warn(`[AgentClients] failed to record tool call: ${err.message || err}`))
    }

    private async recordToolCompleted(roomId: string, sessionId: string, ev: Record<string, unknown>): Promise<boolean> {
        const rawId = String(ev.tool_call_id || '').trim()
        const scopedRawId = rawId ? toolCorrelationId(roomId, sessionId, rawId) : ''
        if (scopedRawId && this.acknowledgedToolCallIds.has(scopedRawId)) return true
        const initialToolName = String(ev.tool_name || ev.tool || ev.name || '')
        const queuedToolCallId = rawId ? '' : (this.takePendingToolCall(roomId, initialToolName) || '')
        const externalToolCallId = rawId
            || this.pendingToolExternalIds.get(queuedToolCallId)
            || groupToolCallId(
                null,
                initialToolName,
                `${roomId}:${sessionId}:${inferResponseRunId(groupMessageId(roomId, this.profile, this.name))}`,
                this.nextAnonymousToolCallSequence(),
            )
        const toolCallId = scopedRawId || queuedToolCallId || toolCorrelationId(roomId, sessionId, externalToolCallId)
        const toolName = initialToolName || this.pendingToolNames.get(toolCallId) || ''
        const runMessageId = this.pendingToolBaseIds.get(toolCallId) || groupMessagePartId(groupMessageId(roomId, this.profile, this.name), 0)
        const responseRunId = this.pendingToolRunIds.get(toolCallId) || inferResponseRunId(runMessageId)
        this.pendingToolCompletionEvents.set(toolCallId, ev)
        const output = bridgeToolOutput(ev)
        const failed = ev.event === 'tool.failed'
            || ev.is_error === true
            || ev.error === true
            || (typeof ev.error === 'string' && ev.error.trim().length > 0)
        const timestamp = Date.now()
        const msg: MessageData & Record<string, any> = {
            id: groupToolMessageId(runMessageId, 'toolresult', externalToolCallId),
            roomId,
            senderId: this.id || this.agentId,
            senderName: this.name,
            content: output,
            timestamp,
            run_id: responseRunId,
            role: 'tool',
            tool_call_id: externalToolCallId,
            tool_name: toolName || null,
            finish_reason: failed ? 'error' : null,
        }
        try {
            await withTimeout(this.sendMessage(roomId, output, msg.id, {
                role: 'tool',
                run_id: responseRunId,
                tool_call_id: externalToolCallId,
                tool_name: toolName || null,
                finish_reason: failed ? 'error' : null,
                timestamp,
            }, sessionId), TOOL_RESULT_ACK_TIMEOUT_MS, 'Timed out waiting for Tool result persistence acknowledgement')
            this.removePendingToolCall(roomId, toolName, toolCallId)
            this.pendingToolBaseIds.delete(toolCallId)
            this.pendingToolRunIds.delete(toolCallId)
            this.pendingToolNames.delete(toolCallId)
            this.pendingToolExternalIds.delete(toolCallId)
            this.pendingToolCompletionEvents.delete(toolCallId)
            this.rememberAcknowledgedToolCall(toolCallId)
            return true
        } catch (err: any) {
            logger.warn(`[AgentClients] failed to record tool result: ${err.message || err}`)
            return false
        }
    }

    private async completePendingToolsForRun(roomId: string, sessionId: string, responseRunId: string): Promise<boolean> {
        const pendingToolCallIds = Array.from(this.pendingToolRunIds.entries())
            .filter(([, pendingRunId]) => pendingRunId === responseRunId)
            .map(([toolCallId]) => toolCallId)
        let allPersisted = true
        for (const toolCallId of pendingToolCallIds) {
            const completionEvent = this.pendingToolCompletionEvents.get(toolCallId)
            const retryEvent = {
                ...(completionEvent || {
                    tool_name: this.pendingToolNames.get(toolCallId) || '',
                    output: '',
                }),
                tool_call_id: this.pendingToolExternalIds.get(toolCallId) || toolCallId,
            }
            let persisted = false
            for (let attempt = 0; attempt < TOOL_RESULT_FINAL_RETRY_ATTEMPTS; attempt += 1) {
                if (await this.recordToolCompleted(roomId, sessionId, retryEvent)) {
                    persisted = true
                    break
                }
                if (attempt + 1 < TOOL_RESULT_FINAL_RETRY_ATTEMPTS) {
                    await delay(TOOL_RESULT_RETRY_DELAY_MS * (attempt + 1))
                }
            }
            if (!persisted) {
                allPersisted = false
                const toolName = this.pendingToolNames.get(toolCallId) || ''
                const externalToolCallId = this.pendingToolExternalIds.get(toolCallId) || toolCallId
                logger.error(`[AgentClients] terminal Tool result persistence loss after bounded retries: room=${roomId} run=${responseRunId} tool=${toolName || 'unknown'} tool_call_id=${externalToolCallId}`)
                this.removePendingToolCall(roomId, toolName, toolCallId)
                this.pendingToolBaseIds.delete(toolCallId)
                this.pendingToolRunIds.delete(toolCallId)
                this.pendingToolNames.delete(toolCallId)
                this.pendingToolExternalIds.delete(toolCallId)
                this.pendingToolCompletionEvents.delete(toolCallId)
            }
        }
        return allPersisted
    }

    private discardPendingToolsForRun(responseRunId: string): void {
        const staleToolCallIds = new Set(Array.from(this.pendingToolRunIds.entries())
            .filter(([, pendingRunId]) => pendingRunId === responseRunId)
            .map(([toolCallId]) => toolCallId))
        if (!staleToolCallIds.size) return
        for (const [key, list] of this.pendingToolCallIds) {
            const current = list.filter(toolCallId => !staleToolCallIds.has(toolCallId))
            if (current.length) this.pendingToolCallIds.set(key, current)
            else this.pendingToolCallIds.delete(key)
        }
        for (const toolCallId of staleToolCallIds) {
            this.pendingToolBaseIds.delete(toolCallId)
            this.pendingToolRunIds.delete(toolCallId)
            this.pendingToolNames.delete(toolCallId)
            this.pendingToolExternalIds.delete(toolCallId)
            this.pendingToolCompletionEvents.delete(toolCallId)
        }
    }

    private pendingToolKey(roomId: string, toolName: string): string {
        return `${roomId}::${toolName || 'tool'}`
    }

    private rememberAcknowledgedToolCall(toolCallId: string): void {
        this.acknowledgedToolCallIds.delete(toolCallId)
        this.acknowledgedToolCallIds.set(toolCallId, Date.now())
        while (this.acknowledgedToolCallIds.size > ACKNOWLEDGED_TOOL_CALL_LIMIT) {
            const oldest = this.acknowledgedToolCallIds.keys().next().value
            if (!oldest) break
            this.acknowledgedToolCallIds.delete(oldest)
        }
    }

    private trackPendingToolCall(roomId: string, toolName: string, toolCallId: string): void {
        const key = this.pendingToolKey(roomId, toolName)
        const list = this.pendingToolCallIds.get(key) || []
        list.push(toolCallId)
        this.pendingToolCallIds.set(key, list)
    }

    private takePendingToolCall(roomId: string, toolName: string): string | undefined {
        const key = this.pendingToolKey(roomId, toolName)
        const list = this.pendingToolCallIds.get(key)
        if (!list?.length) return undefined
        const id = list.shift()
        if (list.length) this.pendingToolCallIds.set(key, list)
        else this.pendingToolCallIds.delete(key)
        return id
    }

    private removePendingToolCall(roomId: string, toolName: string, toolCallId: string): void {
        const key = this.pendingToolKey(roomId, toolName)
        const list = this.pendingToolCallIds.get(key)
        if (!list?.length) return
        const next = list.filter(id => id !== toolCallId)
        if (next.length) this.pendingToolCallIds.set(key, next)
        else this.pendingToolCallIds.delete(key)
    }

    private nextAnonymousToolCallSequence(): number {
        this.anonymousToolCallSequence += 1
        return this.anonymousToolCallSequence
    }

    private bindEvents(): void {
        const s = this.socket!

        s.on('typing', (data: any) => {
            this.handlers.onTyping?.(data)
        })

        s.on('stop_typing', (data: any) => {
            this.handlers.onStopTyping?.(data)
        })

        s.on('member_joined', (data: any) => {
            this.handlers.onMemberJoined?.(data)
        })

        s.on('member_left', (data: any) => {
            this.handlers.onMemberLeft?.(data)
        })

        s.on('room_updated', (data: any) => {
            this.handlers.onRoomUpdated?.(data)
        })

        s.on('disconnect', (reason) => {
            logger.info({ agentId: this.agentId, reason, willReconnect: s.active }, '[AgentClient] group socket disconnected')
        })

        // Manager reconnect fires before this namespace is connected, when
        // joinRoom still fails ensureConnected(). Rejoin after socket connect.
        s.on('connect', async () => {
            if (s !== this.socket || this.joinedRooms.size === 0) return
            if (this._reconnecting) return
            this._reconnecting = true
            logger.info(`[AgentClients] ${this.name} reconnecting, rejoining ${this.joinedRooms.size} rooms...`)
            const rooms = Array.from(this.joinedRooms)
            for (const roomId of rooms) {
                try {
                    await this.joinRoom(roomId)
                } catch (err: any) {
                    logger.error(`[AgentClients] ${this.name} failed to rejoin room ${roomId}: ${err.message}`)
                }
            }
            this._reconnecting = false
        })
    }
}

export function groupBridgeSessionId(
    roomId: string,
    profile: string,
    name: string,
    sessionSeed: string,
    runtimeConfig: GroupAgentSessionConfig = {},
): string {
    const agent = String(runtimeConfig.agent || 'hermes').trim()
    const agentMode = runtimeConfig.agentMode === 'global' ? 'global' : 'scoped'
    const provider = String(runtimeConfig.provider || '').trim()
    const model = String(runtimeConfig.model || '').trim()
    const apiMode = agent === 'hermes' ? '' : String(runtimeConfig.apiMode || '').trim()
    const reasoningEffort = String(runtimeConfig.reasoningEffort || '').trim()
    const modeKey = agentMode === 'global' ? '_global' : ''
    const runtimeKey = agent !== 'hermes' || provider || model || apiMode || reasoningEffort || modeKey
        ? `_${agent}${modeKey}_${provider}_${model}_${apiMode}_${reasoningEffort}`
        : ''
    const presetKey = runtimeConfig.agentPreset ? `_preset_${runtimeConfig.agentPreset}` : ''
    const rawKey = `gc_${roomId}_${profile}_${name}_${sessionSeed || '0'}${runtimeKey}${presetKey}`
    const safePrefix = rawKey.replace(/[^a-zA-Z0-9_-]/g, '_')
    const keyHash = createHash('sha256').update(rawKey).digest('hex').slice(0, 16)
    const suffix = `_h_${keyHash}`
    return `${safePrefix.slice(0, Math.max(0, 120 - suffix.length))}${suffix}`
}

export function groupRuntimeSessionId(roomId: string, profile: string, name: string): string {
    const prefix = `gc_run_${safeId(roomId)}_${safeId(profile)}_${safeId(name)}`.slice(0, 96)
    return `${prefix}_${randomUUID().replace(/-/g, '')}`
}

function groupMessageId(roomId: string, profile: string, name: string): string {
    const raw = `gcmsg_${safeId(roomId)}_${safeId(profile)}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    return raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 160)
}

function groupMessagePartId(runMessageId: string, partIndex: number): string {
    return `${safeId(runMessageId)}_part_${partIndex}`
}

function inferResponseRunId(messageId: string): string {
    const match = String(messageId || '').match(/^(.+)_part_\d+(?:_tool(?:call|result)_.+)?$/)
    return match?.[1] || String(messageId || '')
}

function groupToolCallId(rawToolCallId: unknown, toolName: string, scope: string, sequence: number): string {
    const raw = String(rawToolCallId || '').trim()
    if (raw) return raw
    return `cli_${safeId(toolName || 'tool')}_${stableToolIdPart(scope)}_${sequence}`
}

function toolCorrelationId(roomId: string, sessionId: string, externalToolCallId: string): string {
    return `${roomId}\u0000${sessionId}\u0000${externalToolCallId}`
}

function safeId(value: string): string {
    return String(value || 'item').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)
}

const TOOL_RESULT_ACK_TIMEOUT_MS = 30_000
const TOOL_RESULT_FINAL_RETRY_ATTEMPTS = 2
const TOOL_RESULT_RETRY_DELAY_MS = 50
const ACKNOWLEDGED_TOOL_CALL_LIMIT = 1_024
const GROUP_CHAT_MESSAGE_ID_MAX_LENGTH = 160

function stableToolIdPart(value: string): string {
    const raw = String(value || 'item')
    if (/^[a-zA-Z0-9_-]{1,80}$/.test(raw)) return raw
    const hash = createHash('sha256').update(raw).digest('hex').slice(0, 12)
    return `${safeId(raw).slice(0, 67)}_${hash}`
}

function groupToolMessageId(
    runMessageId: string,
    kind: 'toolcall' | 'toolresult',
    externalToolCallId: string,
): string {
    const toolIdPart = stableToolIdPart(externalToolCallId)
    const candidate = `${runMessageId}_${kind}_${toolIdPart}`
    if (candidate.length <= GROUP_CHAT_MESSAGE_ID_MAX_LENGTH) return candidate

    const marker = `_${kind}_`
    const hash = createHash('sha256')
        .update(`${runMessageId}\u0000${kind}\u0000${externalToolCallId}`)
        .digest('hex')
        .slice(0, 20)
    const hashSuffix = `_h_${hash}`
    const readableLength = GROUP_CHAT_MESSAGE_ID_MAX_LENGTH - marker.length - hashSuffix.length
    const safeRunMessageId = String(runMessageId || 'message').replace(/[^a-zA-Z0-9_-]/g, '_')
    const runLength = Math.min(safeRunMessageId.length, 96, readableLength - 1)
    let runIdPart = safeRunMessageId.slice(0, runLength)
    const partSuffix = safeRunMessageId.match(/_part_\d+$/)?.[0] || ''
    if (partSuffix && safeRunMessageId.length > runLength && partSuffix.length < runLength) {
        runIdPart = `${safeRunMessageId.slice(0, runLength - partSuffix.length)}${partSuffix}`
    }
    const readableToolIdPart = toolIdPart.slice(0, readableLength - runIdPart.length)
    return `${runIdPart}${marker}${readableToolIdPart}${hashSuffix}`
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
        promise.then(
            value => {
                clearTimeout(timeout)
                resolve(value)
            },
            error => {
                clearTimeout(timeout)
                reject(error)
            },
        )
    })
}

function bridgeToolOutput(ev: Record<string, unknown>): string {
    const value = ev.result ?? ev.output ?? ev.result_preview ?? ev.preview ?? ev.error ?? ''
    return typeof value === 'string' ? value : JSON.stringify(value ?? '')
}

function normalizeToolArgs(value: unknown): Record<string, unknown> {
    if (!value) return {}
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value)
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : { value }
        } catch {
            return { value }
        }
    }
    return typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : { value }
}

function extractBridgeFinalText(chunk: GroupPrimaryAgentBridgeOutput | null): string {
    const result = chunk?.result as any
    const output = result?.final_response || chunk?.output || ''
    return typeof output === 'string' ? output.trim() : ''
}

// ─── AgentClients (roomId -> agents) ──────────────────────────

export class AgentClients {
    private rooms = new Map<string, Map<string, GroupAgentExecutor>>()
    private _storage: any = null
    private _workspaceDiffBroadcaster: WorkspaceDiffBroadcaster | null = null
    private _chatRunService: GroupChatRunService | null = null
    private _roomSummaryService: GroupRoomSummaryService | null = null
    private _activityBroadcaster: AgentActivityBroadcaster | null = null
    private _executionQueueBroadcaster: ExecutionQueueBroadcaster | null = null

    // Each Agent owns an independent FIFO inside a room. Summary-only work uses
    // a separate room-scoped queue so one busy Agent cannot block another.
    private _processingMentionQueues = new Set<string>()
    private _mentionQueues = new Map<string, Array<{
        target: { agent: GroupAgentExecutor; queueId: string | null } | null
        msg: MentionMessage
        resolve: (error: MentionQueueError | null) => void
    }>>()
    private _pausedRooms = new Set<string>()
    private _scheduledAgentCounts = new Map<string, Map<string, number>>()

    private mentionQueueKey(roomId: string, agentId?: string): string {
        return `${roomId}\u0000${agentId || '__summary__'}`
    }

    private mentionQueueRoomId(key: string): string {
        return key.split('\u0000', 1)[0]
    }

    /**
     * Create an agent client and connect it to the server.
     * The agent will NOT auto-join any room — call addAgentToRoom separately.
     */
    async createAgent(config: AgentConfig, handlers?: AgentEventHandler, port?: number): Promise<AgentClient> {
        const client = new AgentClient(config, handlers)
        client.setMentionBuilder((roomId, content) => this.buildAgentReplyMentions(roomId, content, client.agentId))
        await client.connect(port)

        // Auto-apply stored references (fixes propagation for agents created after set*)
        if (this._storage) client.setStorage(this._storage)
        client.setWorkspaceDiffBroadcaster(this._workspaceDiffBroadcaster)
        client.setChatRunService(this._chatRunService)

        logger.info(`[AgentClients] Connected: ${client.name} (${client.agentId})`)
        return client
    }

    /**
     * Connect an agent to a room.
     */
    async addAgentToRoom(roomId: string, client: AgentClient): Promise<JoinResult> {
        let room = this.rooms.get(roomId)
        if (!room) {
            room = new Map()
            this.rooms.set(roomId, room)
        }

        if (typeof (client as any).setMentionBuilder === 'function') {
            client.setMentionBuilder((targetRoomId, content) => this.buildAgentReplyMentions(targetRoomId, content, client.agentId))
        }
        room.set(client.agentId, client)
        try {
            const result = await client.joinRoom(roomId)
            logger.info(`[AgentClients] ${client.name} joined room: ${roomId}`)
            return result
        } catch (err) {
            room.delete(client.agentId)
            if (room.size === 0) this.rooms.delete(roomId)
            await client.disconnect()
            throw err
        }
    }

    /**
     * Register an executor whose transport has already joined the room.
     * Used by authenticated outbound relay connections.
     */
    registerAgentForRoom(roomId: string, executor: GroupAgentExecutor): void {
        let room = this.rooms.get(roomId)
        if (!room) {
            room = new Map()
            this.rooms.set(roomId, room)
        }
        executor.setStorage?.(this._storage)
        executor.setWorkspaceDiffBroadcaster?.(this._workspaceDiffBroadcaster)
        executor.setChatRunService?.(this._chatRunService)
        room.set(executor.agentId, executor)
        logger.info(`[AgentClients] Registered relay executor: ${executor.name} (${executor.agentId})`)
    }

    /**
     * Remove an agent from a room and disconnect it.
     */
    async removeAgentFromRoom(roomId: string, agentId: string): Promise<void> {
        const room = this.rooms.get(roomId)
        if (!room) return

        const client = room.get(agentId)
        if (client) {
            room.delete(agentId)
            await client.disconnect()
            logger.info(`[AgentClients] ${client.name} left room: ${roomId}`)
        }

        if (room.size === 0) {
            this.rooms.delete(roomId)
        }
    }

    /**
     * Get all agents in a room.
     */
    getAgents(roomId: string): GroupAgentExecutor[] {
        const room = this.rooms.get(roomId)
        return room ? Array.from(room.values()) : []
    }

    getConnectedAgents(roomId: string): GroupAgentExecutor[] {
        return this.getAgents(roomId).filter(agent => agent.connected !== false)
    }

    private buildAgentReplyMentions(roomId: string, content: string, senderParticipantId: string): StructuredMentionEntry[] {
        const agents = this.getAgents(roomId)
        if (isAllAgentsMentioned(content)) return [{ type: 'all', displayName: 'all' }]
        return agents
            .filter(agent => agent.agentId !== senderParticipantId && isAgentMentioned(content, agent.name))
            .map(agent => ({
                type: 'agent' as const,
                participantId: agent.agentId,
                displayName: agent.name,
            }))
    }

    /**
     * Get a specific agent in a room.
     */
    getAgent(roomId: string, agentId: string): GroupAgentExecutor | undefined {
        return this.rooms.get(roomId)?.get(agentId)
    }

    activeSessionIds(roomId: string): string[] {
        return this.getAgents(roomId)
            .map(agent => agent.getActiveSessionId(roomId))
            .filter((sessionId): sessionId is string => Boolean(sessionId))
    }

    agentSessionIsCurrent(roomId: string, agentId: string, sessionId: string): boolean {
        return this.getAgent(roomId, agentId)?.isActiveSession(roomId, sessionId) === true
    }

    /**
     * Get all room IDs that have agents.
     */
    getRoomIds(): string[] {
        return Array.from(this.rooms.keys())
    }

    /**
     * Send a message from a specific agent in a room.
     */
    async sendMessage(roomId: string, agentId: string, content: string): Promise<string> {
        const client = this.getAgent(roomId, agentId)
        if (!client) {
            throw new Error(`Agent "${agentId}" not found in room "${roomId}"`)
        }
        return client.sendMessage(roomId, content)
    }

    /**
     * Broadcast a message from all agents in a room.
     */
    async broadcastFromRoom(roomId: string, content: string): Promise<string[]> {
        const agents = this.getAgents(roomId)
        return Promise.all(agents.map((agent) => agent.sendMessage(roomId, content)))
    }

    private buildUnsyncedInterruptError(roomId: string): Error {
        const err = new Error(`Room "${roomId}" still has running bridge sessions; try again after the interrupt completes`) as Error & { status?: number }
        err.status = 409
        return err
    }

    private reportAgentActivity(
        roomId: string,
        agentName: string,
        status: 'compressing' | 'replying' | 'ready',
        runId?: string,
        agentSessionId?: string,
    ): void {
        this._activityBroadcaster?.(roomId, agentName, status, runId, agentSessionId)
        logger.debug(`[AgentClients] room ${roomId} agent ${agentName} status: ${status}`)
    }

    private scheduleAgentActivity(roomId: string, agentName: string): void {
        let roomCounts = this._scheduledAgentCounts.get(roomId)
        if (!roomCounts) {
            roomCounts = new Map()
            this._scheduledAgentCounts.set(roomId, roomCounts)
        }
        const count = roomCounts.get(agentName) || 0
        roomCounts.set(agentName, count + 1)
        if (count === 0) this.reportAgentActivity(roomId, agentName, 'replying')
    }

    private finishAgentActivity(roomId: string, agentName: string): void {
        const roomCounts = this._scheduledAgentCounts.get(roomId)
        const count = roomCounts?.get(agentName) || 0
        if (count > 1) {
            roomCounts!.set(agentName, count - 1)
            return
        }
        roomCounts?.delete(agentName)
        if (roomCounts?.size === 0) this._scheduledAgentCounts.delete(roomId)
        if (count > 0) this.reportAgentActivity(roomId, agentName, 'ready')
    }

    private clearScheduledAgentActivity(roomId: string, agentName: string): void {
        const roomCounts = this._scheduledAgentCounts.get(roomId)
        const hadScheduledWork = (roomCounts?.get(agentName) || 0) > 0
        roomCounts?.delete(agentName)
        if (roomCounts?.size === 0) this._scheduledAgentCounts.delete(roomId)
        for (const [key, queue] of this._mentionQueues) {
            if (this.mentionQueueRoomId(key) !== roomId) continue
            for (let index = queue.length - 1; index >= 0; index -= 1) {
                const entry = queue[index]
                if (entry.target?.agent.name !== agentName) continue
                entry.target.agent.releaseInvocation?.()
                if (entry.target.queueId) this._storage?.failExecutionQueueItem?.(entry.target.queueId, 'Agent was removed')
                queue.splice(index, 1)
                entry.resolve({ message: `Agent "${agentName}" is not connected`, outcomeUnknown: false })
            }
            if (queue.length === 0) this._mentionQueues.delete(key)
        }
        this._executionQueueBroadcaster?.(roomId)
        if (hadScheduledWork) this.reportAgentActivity(roomId, agentName, 'ready')
    }

    private clearMentionQueuesForRoom(roomId: string): void {
        for (const [key, queue] of this._mentionQueues) {
            if (this.mentionQueueRoomId(key) !== roomId) continue
            this._mentionQueues.delete(key)
            for (const entry of queue) {
                if (entry.target) {
                    entry.target.agent.releaseInvocation?.()
                    if (entry.target.queueId) {
                        this._storage?.failExecutionQueueItem?.(entry.target.queueId, 'Room execution queue was cleared')
                    }
                }
                entry.resolve({ message: 'Continuation target Agent is not connected', outcomeUnknown: false })
            }
        }
        this._executionQueueBroadcaster?.(roomId)
        const roomCounts = this._scheduledAgentCounts.get(roomId)
        this._scheduledAgentCounts.delete(roomId)
        for (const agentName of roomCounts?.keys() || []) {
            this.reportAgentActivity(roomId, agentName, 'ready')
        }
    }

    private queueMention(roomId: string, agents: GroupAgentExecutor[], msg: MentionMessage): Promise<MentionQueueError | null> {
        const targets = agents.map(agent => {
            const queued = msg.role === 'user' && msg.messageId
                ? this._storage?.enqueueExecutionQueueItem?.({
                    roomId,
                    messageId: msg.messageId,
                    targetAgentId: agent.agentId,
                    targetAgentName: agent.name,
                    requesterMemberId: msg.senderId,
                    cancelCapabilityHash: msg.executionQueueCapabilityHash || '',
                    textSummary: msg.content,
                })
                : null
            return { agent, queueId: queued?.id || null }
        })

        const pendingTargets: Array<{ target: { agent: GroupAgentExecutor; queueId: string | null } | null; key: string }> =
            targets.length > 0
                ? targets.map(target => ({ target, key: this.mentionQueueKey(roomId, target.agent.agentId) }))
                : [{ target: null, key: this.mentionQueueKey(roomId) }]
        const completions = pendingTargets.map(({ target, key }) => {
            let queue = this._mentionQueues.get(key)
            if (!queue) {
                queue = []
                this._mentionQueues.set(key, queue)
            }
            let resolve!: (error: MentionQueueError | null) => void
            const completed = new Promise<MentionQueueError | null>(done => { resolve = done })
            queue.push({ target, msg, resolve })
            if (target) {
                target.agent.reserveInvocation?.()
                this.scheduleAgentActivity(roomId, target.agent.name)
            }
            return completed
        })
        if (targets.some(target => target.queueId)) {
            this._executionQueueBroadcaster?.(roomId)
        }
        return Promise.all(completions).then(errors => errors.find(Boolean) || null)
    }

    retractQueuedMention(
        roomId: string,
        queueId: string,
        requesterMemberId: string,
        cancelCapabilityHash: string,
        allowAuthenticatedAccountOwnership = false,
    ): { messageId: string; queueIds: string[]; messageCount: number; totalTokens: number; lastActiveAt: number } | null {
        const retracted = this._storage?.retractQueuedMessage?.(
            roomId,
            queueId,
            requesterMemberId,
            cancelCapabilityHash,
            allowAuthenticatedAccountOwnership,
        )
        if (!retracted) return null
        const queueIds = new Set<string>(retracted.queueIds)
        for (const [key, queue] of this._mentionQueues) {
            if (this.mentionQueueRoomId(key) !== roomId) continue
            for (let index = queue.length - 1; index >= 0; index -= 1) {
                const entry = queue[index]
                if (!entry.target?.queueId || !queueIds.has(entry.target.queueId)) continue
                entry.target.agent.releaseInvocation?.()
                this.finishAgentActivity(roomId, entry.target.agent.name)
                queue.splice(index, 1)
                entry.resolve(null)
            }
            if (queue.length === 0) this._mentionQueues.delete(key)
        }
        return retracted
    }

    async interruptAgent(roomId: string, agentName: string): Promise<void> {
        const agent = this.getAgents(roomId).find(a => a.name === agentName)
        if (!agent) throw new Error(`Agent "${agentName}" not found in room "${roomId}"`)
        const synced = await agent.interrupt(roomId)
        if (!synced) throw this.buildUnsyncedInterruptError(roomId)
        this.clearScheduledAgentActivity(roomId, agentName)
    }

    async interruptRoom(roomId: string): Promise<void> {
        const agents = this.getAgents(roomId)
        this._pausedRooms.add(roomId)
        const results = await Promise.allSettled(agents.map(agent => agent.interrupt(roomId)))
        let unsynced = false
        for (const result of results) {
            if (result.status === 'rejected') {
                unsynced = true
                logger.warn(`[AgentClients] failed to interrupt room ${roomId}: ${result.reason?.message || result.reason}`)
            } else if (result.value === false) {
                unsynced = true
                logger.warn(`[AgentClients] bridge interrupt for room ${roomId} was not synchronized`)
            }
        }
        this._pausedRooms.delete(roomId)
        if (unsynced) {
            throw this.buildUnsyncedInterruptError(roomId)
        }
        this.clearMentionQueuesForRoom(roomId)
    }

    /**
     * Disconnect all agents in a room.
     */
    async disconnectRoom(roomId: string): Promise<void> {
        const room = this.rooms.get(roomId)
        if (!room) return

        this.rooms.delete(roomId)
        await Promise.allSettled([...room.values()].map(client => client.disconnect()))
        this.clearMentionQueuesForRoom(roomId)
        this._pausedRooms.delete(roomId)
        logger.info(`[AgentClients] All agents disconnected from room: ${roomId}`)

    }

    resetRoomContext(roomId: string): void {
        this.clearMentionQueuesForRoom(roomId)
        this._pausedRooms.delete(roomId)
        for (const key of this._processingMentionQueues) {
            if (this.mentionQueueRoomId(key) === roomId) this._processingMentionQueues.delete(key)
        }
    }

    /**
     * Disconnect all agents in all rooms.
     */
    async disconnectAll(): Promise<void> {
        const roomIds = new Set(Array.from(this._mentionQueues.keys(), key => this.mentionQueueRoomId(key)))
        for (const roomId of roomIds) {
            this.clearMentionQueuesForRoom(roomId)
        }
        const clients = [...this.rooms.values()].flatMap(room => [...room.values()])
        this.rooms.clear()
        await Promise.allSettled(clients.map(client => client.disconnect()))
        logger.info('[AgentClients] All agents disconnected')
    }

    /**
     * Set message storage for all existing and future agents.
     */
    setStorage(storage: any): void {
        this._storage = storage
        this.rooms.forEach((room) => {
            room.forEach((client) => client.setStorage(storage))
        })
    }

    setWorkspaceDiffBroadcaster(broadcaster: WorkspaceDiffBroadcaster | null): void {
        this._workspaceDiffBroadcaster = broadcaster
        this.rooms.forEach((room) => {
            room.forEach((client) => client.setWorkspaceDiffBroadcaster(broadcaster))
        })
    }

    setChatRunService(service: GroupChatRunService | null): void {
        this._chatRunService = service
        this.rooms.forEach((room) => {
            room.forEach((client) => client.setChatRunService(service))
        })
    }

    setRoomSummaryService(service: GroupRoomSummaryService | null): void {
        this._roomSummaryService = service
    }

    setActivityBroadcaster(broadcaster: AgentActivityBroadcaster | null): void {
        this._activityBroadcaster = broadcaster
    }

    setExecutionQueueBroadcaster(broadcaster: ExecutionQueueBroadcaster | null): void {
        this._executionQueueBroadcaster = broadcaster
    }


    private handoffRuntimeSnapshot(roomId: string, agent: GroupAgentExecutor): Record<string, string> {
        const persisted = this._storage?.getHandoffTargetSnapshot?.(roomId, agent.agentId)
        if (!persisted || typeof persisted !== 'object') return {}
        return {
            ...persisted,
            agentId: String(agent.agentId || ''),
            agent: String(agent.agent || ''),
            agentMode: String(agent.agentMode || 'scoped'),
            profile: String(agent.profile || ''),
            provider: String(agent.provider || ''),
            model: String(agent.model || ''),
            apiMode: String(agent.apiMode || ''),
            reasoningEffort: String(agent.reasoningEffort || ''),
            agentPreset: String(agent.agentPreset || ''),
            name: String(agent.name || ''),
            description: String(agent.description || ''),
        }
    }

    getRoutingCandidates(roomId: string): Array<{ id: string; name: string; description: string }> {
        return this.getConnectedAgents(roomId).map(agent => ({ id: agent.agentId, name: agent.name, description: agent.description || '' }))
    }

    /**
     * Server-side: parse @mentions and forward to matching agents directly.
     * If the room is already processing (compressing/replying), queue the mention.
     */
    async processMentions(roomId: string, msg: MentionMessage): Promise<MentionDeliveryResult> {
        const agents = this.getConnectedAgents(roomId)
        const mentioned = msg.mentions
            ? this.resolveStructuredMentionTargets(agents, msg.mentions, msg.senderId)
            : resolveMentionTargets(agents, msg.content, msg.senderId)
        if (mentioned.length === 0 && msg.role !== 'user') {
            return { targetCount: 0, deliveredCount: 0, errors: [] }
        }

        if (mentioned.length > 0) {
            logger.debug(`[AgentClients] ${mentioned.map(a => a.name).join(', ')} mentioned by ${msg.senderName}`)
        }

        if (msg.continuationAttemptId) {
            if (mentioned.length !== 1) {
                return {
                    targetCount: mentioned.length,
                    deliveredCount: 0,
                    errors: ['Continuation target Agent is not connected'],
                }
            }
            const admission = this._storage?.admitHandoffTarget?.(
                msg.continuationAttemptId,
                mentioned[0].agentId,
                msg as unknown as Record<string, unknown>,
                this.handoffRuntimeSnapshot(roomId, mentioned[0]),
            )
            if (!admission) {
                return { targetCount: 1, deliveredCount: 0, errors: ['Continuation target admission was rejected'] }
            }
            const receipt = this._storage?.claimHandoffDelivery?.(
                msg.continuationAttemptId,
                mentioned[0].agentId,
            )
            if (receipt === 'already') {
                return { targetCount: 1, deliveredCount: 1, errors: [] }
            }
            if (receipt !== 'accepted') {
                return { targetCount: 1, deliveredCount: 0, errors: ['Continuation delivery receipt could not be created'] }
            }
            const accepted = this._storage?.acceptHandoffAttempt?.(
                msg.continuationAttemptId,
                mentioned[0].agentId,
            )
            if (accepted !== 'accepted' && accepted !== 'already') {
                this._storage?.releaseHandoffDelivery?.(msg.continuationAttemptId)
                return { targetCount: 1, deliveredCount: 0, errors: ['Continuation attempt is no longer dispatchable'] }
            }
        }
        const completed = this.queueMention(roomId, mentioned, msg)
        await this._drainRoomQueues(roomId)
        if (msg.continuationAttemptId && mentioned.length === 1) {
            const queueError = await completed
            if (queueError) {
                return {
                    targetCount: 1,
                    deliveredCount: 0,
                    errors: [queueError.message],
                    outcomeUnknown: queueError.outcomeUnknown,
                }
            }
            const status = this._storage?.getHandoffTargetStatus?.(msg.continuationAttemptId)
            if (status?.status !== 'completed') {
                this._storage?.failHandoffTarget?.(
                    msg.continuationAttemptId,
                    'Target invocation completed without a durable Agent message',
                )
                return {
                    targetCount: 1,
                    deliveredCount: 0,
                    errors: ['Continuation target did not publish a durable Agent message'],
                }
            }
        }
        return { targetCount: mentioned.length, deliveredCount: mentioned.length, errors: [] }
    }

    private resolveStructuredMentionTargets(
        agents: GroupAgentExecutor[],
        mentions: StructuredMention[],
        senderId: string,
    ): GroupAgentExecutor[] {
        const candidates = agents.filter(agent => agent.agentId !== senderId)
        if (mentions.some(mention => mention.type === 'all')) return candidates
        const ids = new Set(mentions.flatMap(mention => mention.type === 'agent' ? [mention.participantId] : []))
        return candidates.filter(agent => ids.has(agent.agentId))
    }

    private targetAgentOwnerMemberId(roomId: string, agent: GroupAgentExecutor): string {
        const roomAgents = this._storage?.getRoomAgents?.(roomId)
        const storedAgent = Array.isArray(roomAgents)
            ? roomAgents.find((candidate: any) => (
                String(candidate?.agentId || '') === agent.agentId
                || String(candidate?.name || '') === agent.name
            ))
            : null
        const explicitOwner = String(storedAgent?.ownerMemberId || '').trim()
        if (explicitOwner) return explicitOwner
        if (storedAgent?.executorType === 'remote') return ''

        const ownerAuthUserId = Number(this._storage?.getRoom?.(roomId)?.ownerAuthUserId || 0)
        return Number.isSafeInteger(ownerAuthUserId) && ownerAuthUserId > 0
            ? `auth:${ownerAuthUserId}`
            : ''
    }

    async processSummaryCheck(roomId: string, messageId: string): Promise<void> {
        this.queueMention(roomId, [], {
            messageId,
            content: '',
            senderName: '',
            senderId: '',
            timestamp: Date.now(),
            role: 'user',
        })
        await this._drainRoomQueues(roomId)
    }

    private async _drainRoomQueues(roomId: string): Promise<void> {
        if (this._pausedRooms.has(roomId)) return
        const keys = Array.from(this._mentionQueues.keys()).filter(key => this.mentionQueueRoomId(key) === roomId)
        await Promise.all(keys.map(key => this._drainMentionQueue(roomId, key)))
    }

    // Kept as the room-level test/runtime seam while dispatch is internally
    // partitioned into independent per-Agent queues.
    private async _drainRoomQueue(roomId: string): Promise<void> {
        await this._drainRoomQueues(roomId)
    }

    private async _drainMentionQueue(roomId: string, key: string): Promise<void> {
        if (this._processingMentionQueues.has(key) || this._pausedRooms.has(roomId)) return
        this._processingMentionQueues.add(key)
        try {
            while (!this._pausedRooms.has(roomId)) {
                const queue = this._mentionQueues.get(key)
                const next = queue?.shift()
                if (!next) break
                if (queue?.length === 0) this._mentionQueues.delete(key)

                let queueError: MentionQueueError | null = null
                try {
                    const runtimeContext = this._roomSummaryService
                        ? await this._roomSummaryService.prepareForMessage(roomId, next.msg.messageId)
                        : { summary: '', history: [] }
                    const runnableTarget = next.target && (
                        !next.target.queueId || this._storage?.startExecutionQueueItem?.(next.target.queueId) !== false
                    ) ? next.target : null
                    if (runnableTarget?.queueId) this._executionQueueBroadcaster?.(roomId)
                    const results = runnableTarget ? await Promise.allSettled([Promise.resolve().then(async () => {
                        const { agent } = runnableTarget
                        const onStatus = (status: 'compressing' | 'replying' | 'ready', extra?: Record<string, unknown>) => {
                            const runId = typeof extra?.runId === 'string' ? extra.runId : undefined
                            const agentSessionId = typeof extra?.agentSessionId === 'string'
                                ? extra.agentSessionId
                                : undefined
                            this.reportAgentActivity(roomId, agent.name, status, runId, agentSessionId)
                        }
                        if (next.msg.continuationAttemptId) {
                            if (!agent.connected) {
                                throw new Error('Continuation target Agent is not connected')
                            }
                            const attemptId = next.msg.continuationAttemptId
                            const running = this._storage?.markHandoffTargetRunning?.(
                                attemptId,
                                `handoff:${attemptId}`,
                                Date.now() + 60_000,
                            )
                            const current = this._storage?.getHandoffTargetStatus?.(attemptId)
                            if (!running && current?.status !== 'running') {
                                throw new Error('Continuation target could not claim the invocation')
                            }
                            const started = this._storage?.markHandoffTargetInvocationStarted?.(attemptId)
                            const startedState = this._storage?.getHandoffTargetStatus?.(attemptId)
                            if (!started && !startedState?.invocationStartedAt) {
                                throw new Error('Continuation invocation marker could not be persisted')
                            }
                        }
                        const targetOwnerMemberId = this.targetAgentOwnerMemberId(roomId, agent)
                        const targetMessage = targetOwnerMemberId
                            ? { ...next.msg, targetOwnerMemberId }
                            : next.msg
                        await agent.replyToMention(roomId, targetMessage, runtimeContext, onStatus)
                    })]) : []
                    for (let index = 0; index < results.length; index += 1) {
                        const result = results[index]
                        const target = runnableTarget
                        if (result.status === 'rejected') {
                            const message = result.reason?.message || String(result.reason)
                            queueError ||= {
                                message,
                                outcomeUnknown: result.reason?.outcomeUnknown === true,
                            }
                            if (target?.queueId) this._storage?.finishExecutionQueueItem?.(target.queueId, 'failed', message)
                            logger.error(`[AgentClients] error processing mention for ${target?.agent.name}: ${message}`)
                        } else if (target?.queueId) {
                            this._storage?.finishExecutionQueueItem?.(target.queueId, 'completed')
                        }
                    }
                } finally {
                    if (next.target) {
                        next.target.agent.releaseInvocation?.()
                        this.finishAgentActivity(roomId, next.target.agent.name)
                    }
                    this._executionQueueBroadcaster?.(roomId)
                    next.resolve(queueError)
                }
            }
        } finally {
            this._processingMentionQueues.delete(key)
        }
    }
}

function nextMentionDepth(msg: MentionMessage): number {
    return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, msg.mentionDepth || 0) + 1)
}
