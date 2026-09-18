import { registerAppEventState, publishAppState, stateEvent, planStateEvent } from '../services/webhooks/app-event-state'
import type { BusinessEvent } from '../services/webhooks/business-events'
import { authenticatedPushActor, prepareRunPushSnapshot } from '../services/notifications/push-registration'
import { bindRunPushTarget, findPushRunLink, linkPushRun, pushRunTransaction, type PushActor } from '../repositories/run-push-store'
import { parseGroupTaskPlan } from '../services/group-chat/task-plan'
import { bindLegacyAppEvents } from '../services/webhooks/legacy-app-events'
import { registerGroupEventAccess } from '../services/webhooks/app-events'
import { publishGroupMessage, publishGroupInteraction } from '../services/webhooks/domain-events'
import { Server, Socket, Namespace } from 'socket.io'
import type { Server as HttpServer } from 'http'
import { mkdirSync } from 'fs'
import { basename, join } from 'path'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { logger } from '../public/logging'
import { getDb } from '../infrastructure/database'
import { normalizeMessageContentForStorage, normalizeMessageContentForStorageRole } from '../repositories/message-content'
import {
    AgentClients,
    GROUP_CHAT_AGENT_SOCKET_SECRET,
    groupBridgeSessionId,
    type GroupChatRunService,
    type StructuredMention,
} from '../services/group-chat/agent-clients'
import { countTokens } from '../services/context-compressor'
import {
    createGroupPrimaryAgentBridge,
    drainGroupPrimaryAgentSessions,
    respondToGroupEkkoClarification,
    respondToGroupEkkoToolApproval,
} from '../public/group-chat-agent-runtime'
import { insertWorkspaceRunChange, deleteWorkspaceRunChangesForRoom, type SaveWorkspaceRunChangeInput, type WorkspaceRunChangeSummary } from '../repositories/workspace-run-changes-store'
import { authenticateUserToken, isAuthEnabled, type AuthenticatedUser } from '../public/auth'
import { getUserAvatar } from '../public/users'
import { config } from '../public/config'
import { createSocketIoCorsOrigin, shouldRejectUpgradeOrigin } from '../public/security'
import { paginateRecentGroupMessagesCanonical, sliceGroupMessagesCanonical, type GroupMessageCursorCutoff } from '../services/group-chat/group-message-ordering'
import { GroupRoomSummaryService, type GroupRoomSummary } from '../services/group-chat/room-summary'
import { isAgentMentioned, isAllAgentsMentioned, isReservedMentionName, resolveMentionTargets } from '../services/group-chat/mention-routing'
import { isGroupChatRoomOwner } from '../services/group-chat/access'
import { normalizeHumanGroupChatContent, type PublishedGroupChatAttachmentBlock } from '../services/group-chat/attachments'
import { revokeGroupAgentConnector } from '../services/group-chat/agent-relay-store'
import type { ContentBlock } from '../services/chat-run/types'
import {
    DEFAULT_GROUP_CHAT_AGENT_HANDOFF_DEPTH,
    resolveGroupChatAgentHandoffPolicy,
    shouldRouteGroupChatAgentHandoff,
    type GroupChatAgentHandoffPolicy,
} from '../services/group-chat/handoff-depth'
import { buildOutboundToolMessage } from '../services/chat-run/resume-payload'
import { defaultGroupChatWorkspace } from '../services/group-chat/workspace-files'

export { defaultGroupChatWorkspace } from '../services/group-chat/workspace-files'

// ─── Types ────────────────────────────────────────────────────

interface ChatMessage {
    id: string
    roomId: string
    senderId: string
    senderName: string
    senderType?: 'member' | 'agent'
    senderAgentRecordId?: string
    senderAvatar?: string
    senderAgentType?: RoomAgent['agent']
    senderAgentProfile?: string
    senderAgentProvider?: string
    senderAgentModel?: string
    senderAgentDescription?: string
    senderOwnerMemberId?: string
    content: string
    timestamp: number
    run_id?: string | null
    role?: string
    tool_call_id?: string | null
    tool_calls?: any[] | null
    tool_name?: string | null
    finish_reason?: string | null
    reasoning?: string | null
    reasoning_details?: string | null
    reasoning_content?: string | null
    persistedAt?: number
    mentions?: StructuredMention[]
    mentionDepth?: number
    handoffChainId?: string
    agentSessionId?: string
}

const GROUP_CHAT_FULL_PAYLOAD_TOOL_NAMES = ['workspace_diff'] as const

function buildOutboundGroupMessage(message: ChatMessage): ChatMessage {
    return buildOutboundToolMessage(message as ChatMessage & Record<string, unknown>, {
        preserveToolNames: GROUP_CHAT_FULL_PAYLOAD_TOOL_NAMES,
    }) as ChatMessage
}

type IncomingGroupChatMessage = Omit<Partial<ChatMessage>, 'content'> & {
    push_snapshot?: unknown
    roomId?: string
    content: string | Array<Record<string, unknown>>
    id?: string
    mentionDepth?: number
    handoffChainId?: string
    executionQueueCapability?: string
}

interface PendingGroupApprovalRoute {
    roomId: string
    agentName: string
    ownerMemberId: string
    agentSessionId: string
    runId: string
    approvalId: string
    command: string
    description: string
    choices: string[]
    allowPermanent: boolean
    timeoutMs: number
    requestedAt: number
}

interface PendingGroupClarifyRoute {
    roomId: string
    agentName: string
    agentSessionId: string
    runId: string
    runtimeRunId: string
    clarifyId: string
    question: string
    choices: string[] | null
    initialResponse: string
    responseMode: string
    timeoutMs: number
    requestedAt: number
}

export interface GroupExecutionQueueItem {
    id: string
    roomId: string
    messageId: string
    targetAgentId: string
    targetAgentName: string
    requesterMemberId: string
    textSummary: string
    sequence: number
    position?: number
    status: 'queued' | 'running' | 'completed' | 'cancelled' | 'failed'
    createdAt: number
    startedAt: number | null
    finishedAt: number | null
    lastError: string | null
}

interface StoredGroupExecutionQueueItem extends GroupExecutionQueueItem {
    cancelCapabilityHash: string
}

interface RetractedQueuedMessage {
    messageId: string
    queueIds: string[]
    messageCount: number
    totalTokens: number
    lastActiveAt: number
}

const EXECUTION_QUEUE_PUBLIC_COLUMNS = [
    'id',
    'roomId',
    'messageId',
    'targetAgentId',
    'targetAgentName',
    'requesterMemberId',
    'textSummary',
    'sequence',
    'status',
    'createdAt',
    'startedAt',
    'finishedAt',
    'lastError',
].join(', ')

function executionQueueCapabilityHash(value: unknown): string {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) return ''
    return createHash('sha256').update(value.toLowerCase()).digest('hex')
}

function executionQueueCapabilityMatches(actualHash: string, expectedHash: string): boolean {
    if (!/^[a-f0-9]{64}$/.test(actualHash) || !/^[a-f0-9]{64}$/.test(expectedHash)) return false
    return timingSafeEqual(Buffer.from(actualHash, 'hex'), Buffer.from(expectedHash, 'hex'))
}

function contentToStorageString(content: unknown): string {
    if (typeof content === 'string') return content
    return JSON.stringify(content ?? '')
}

function humanStructuredContent(content: unknown): Array<Record<string, unknown>> | null {
    if (Array.isArray(content)) return content
    if (typeof content !== 'string') return null
    const trimmed = content.trim()
    if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null
    try {
        const parsed = JSON.parse(trimmed)
        return Array.isArray(parsed) ? parsed : null
    } catch {
        return null
    }
}

function messageContentForStorage(role: string | undefined, content: string): string {
    return normalizeMessageContentForStorageRole(role, content)
}

function contentToText(content: unknown): string {
    if (typeof content === 'string') {
        const trimmed = content.trim()
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
            try {
                return contentToText(JSON.parse(trimmed))
            } catch {
                return content
            }
        }
        return content
    }
    if (Array.isArray(content)) {
        return content.map((block: any) => {
            if (block?.type === 'text') return block.text || ''
            if (block?.type === 'image') return `[Image: ${block.name || block.path || ''}]`
            if (block?.type === 'file') return `[File: ${block.name || block.path || ''}]`
            return ''
        }).filter(Boolean).join('\n')
    }
    return content == null ? '' : String(content)
}

interface RoomAgent {
    id: string
    roomId: string
    agentId: string
    agent: 'hermes' | 'ekko' | 'codex' | 'claude' | 'pi' | 'grok' | 'opencode' | 'dsh'
    agentMode: 'scoped' | 'global'
    profile: string
    provider: string
    model: string
    apiMode: string
    agentPreset?: string
    reasoningEffort: string
    name: string
    description: string
    avatar: string
    invited: number
    executorType: 'server' | 'remote'
    ownerMemberId: string
    connectorId: string
    remoteOrigin: string
}

interface GroupAgentActivity {
    roomId: string
    agentId: string
    runId: string
    agentName: string
    agent: RoomAgent['agent']
    avatar: string
    status: 'compressing' | 'replying' | 'ready'
    agentSessionId?: string
}

interface RoomAgentMetadata {
    agent?: 'hermes' | 'ekko' | 'codex' | 'claude' | 'pi' | 'grok' | 'opencode' | 'dsh'
    agentMode?: 'scoped' | 'global'
    provider?: string
    model?: string
    apiMode?: string
    agentPreset?: string
    reasoningEffort?: string
    avatar?: string
    executorType?: 'server' | 'remote'
    ownerMemberId?: string
    connectorId?: string
    remoteOrigin?: string
}

export const ROOM_PARTICIPANT_NAME_CONFLICT = 'ROOM_PARTICIPANT_NAME_CONFLICT'

export class RoomParticipantNameConflictError extends Error {
    readonly code = ROOM_PARTICIPANT_NAME_CONFLICT

    constructor() {
        super('Name is already in use in this room')
        this.name = 'RoomParticipantNameConflictError'
    }
}

function canonicalParticipantName(name: string): string {
    return name.trim().normalize('NFKC').toLocaleLowerCase()
}

const GROUP_MEMBER_AVATAR_MAX_LENGTH = 1_500_000

function normalizeRoomMemberAvatar(value: unknown): string {
    if (value === undefined || value === null || value === '') return ''
    if (typeof value !== 'string' || value.length > GROUP_MEMBER_AVATAR_MAX_LENGTH) {
        throw new Error('Invalid member avatar')
    }
    let parsed: any
    try {
        parsed = JSON.parse(value)
    } catch {
        throw new Error('Invalid member avatar')
    }
    if (parsed?.type === 'generated' && typeof parsed.seed === 'string' && parsed.seed.trim() && parsed.seed.length <= 200) {
        return JSON.stringify({ type: 'generated', seed: parsed.seed.trim() })
    }
    if (
        parsed?.type === 'image' &&
        typeof parsed.dataUrl === 'string' &&
        /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(parsed.dataUrl) &&
        parsed.dataUrl.length <= GROUP_MEMBER_AVATAR_MAX_LENGTH
    ) {
        return JSON.stringify({ type: 'image', dataUrl: parsed.dataUrl })
    }
    throw new Error('Invalid member avatar')
}

export interface RoomInfo {
    id: string
    name: string
    inviteCode: string | null
    summaryProfile: string
    summaryProvider: string
    summaryModel: string
    summaryApiMode: string
    summaryEveryTurns: number
    summaryGeneration: number
    triggerTokens: number
    maxHistoryTokens: number
    tailMessageCount: number
    totalTokens: number
    tokenAccountingVersion: number
    sessionSeed: string
    workspace: string
    ownerAuthUserId: number | null
    allowGuestAgents: number
    guestAgentApproval: 'owner'
    maxGuestAgentsPerMember: number
    allowRemoteWorkspaceAccess: number
    agentHandoffEnabled: number
    agentHandoffMaxDepth: number | null
    agentHandoffUnlimited: number
    createdAt: number
    lastActiveAt?: number
}

const ROOM_SELECT_COLUMNS = [
    'id',
    'name',
    'inviteCode',
    'summaryProfile',
    'summaryProvider',
    'summaryModel',
    'summaryApiMode',
    'summaryEveryTurns',
    'summaryGeneration',
    'triggerTokens',
    'maxHistoryTokens',
    'tailMessageCount',
    'totalTokens',
    'tokenAccountingVersion',
    'sessionSeed',
    'workspace',
    'ownerAuthUserId',
    'allowGuestAgents',
    'guestAgentApproval',
    'maxGuestAgentsPerMember',
    'allowRemoteWorkspaceAccess',
    'agentHandoffEnabled',
    'agentHandoffMaxDepth',
    'agentHandoffUnlimited',
    'createdAt',
].join(', ')

const ROOM_AGENT_SELECT_COLUMNS = [
    'id',
    'roomId',
    'agentId',
    'agent',
    'agentMode',
    'profile',
    'provider',
    'model',
    'apiMode',
    'reasoningEffort',
    'agentPreset',
    'name',
    'description',
    'avatar',
    'invited',
    'executorType',
    'ownerMemberId',
    'connectorId',
    'remoteOrigin',
].join(', ')

const MESSAGE_SELECT_COLUMNS = [
    'id',
    'roomId',
    'senderId',
    'senderName',
    'senderType',
    'senderAgentRecordId',
    'content',
    'timestamp',
    'persistedAt',
    'mentions',
    'run_id',
    'role',
    'tool_call_id',
    'tool_calls',
    'tool_name',
    'finish_reason',
    'reasoning',
    'reasoning_details',
    'reasoning_content',
].join(', ')

function roomActivityAtSql(messageAlias: string): string {
    return `COALESCE(
        MAX(CASE
            WHEN COALESCE(${messageAlias}.role, '') <> 'tool'
             AND COALESCE(${messageAlias}.finish_reason, '') <> 'streaming'
            THEN NULLIF(${messageAlias}.persistedAt, 0)
        END),
        NULLIF(r.createdAt, 0),
        0
    )`
}

export interface RoomSummaryConfig {
    summaryProfile?: string
    summaryProvider?: string
    summaryModel?: string
    summaryApiMode?: string
    summaryEveryTurns?: number
}

export interface RoomAgentHandoffConfig {
    agentHandoffEnabled?: boolean
    agentHandoffMaxDepth?: number | null
    agentHandoffUnlimited?: boolean
}

interface SaveWorkspaceDiffMessageArgs {
    roomId: string
    senderId: string
    senderName: string
    sessionId: string
    runId: string
    responseRunId?: string
    status: 'completed' | 'failed' | 'aborted'
    workspace: string
    draft: SaveWorkspaceRunChangeInput
    parentMessageId?: string | null
}

interface Member {
    id: string
    userId: string
    name: string
    description: string
    joinedAt: number
    online: boolean
    socketId: string
    source?: 'human' | 'agent'
    avatar: string
    authUserId?: number | null
}

type MemberView = Pick<Member, 'id' | 'userId' | 'name' | 'description' | 'joinedAt' | 'avatar'> & {
    connectionStatus: 'online' | 'offline'
}

function authenticatedGroupUserId(authUserId: number): string {
    return `auth:${authUserId}`
}

function authenticatedUserProfiles(user: AuthenticatedUser | undefined): string[] {
    return Array.isArray(user?.profiles) ? user.profiles.map(String).filter(Boolean) : []
}

let _tablesEnsured = false

interface PendingSessionDelete {
    session_id: string
    profile_name: string
    status: string
    attempt_count: number
    last_error: string | null
    created_at: number
    updated_at: number
    next_attempt_at: number
}

interface GroupChatSessionProfile {
    session_id: string
    room_id: string
    agent_id: string
    profile_name: string
    created_at: number
}

export interface PendingSessionDeleteDrainResult {
    deleted: string[]
    failed: Array<{ sessionId: string; error: string }>
}

function parseJsonArray(value: unknown): any[] | null {
    if (value == null || value === '') return null
    if (Array.isArray(value)) return value
    if (typeof value !== 'string') return null
    try {
        const parsed = JSON.parse(value)
        return Array.isArray(parsed) ? parsed : null
    } catch {
        return null
    }
}

function parseStructuredMentions(value: unknown): StructuredMention[] {
    const parsed = parseJsonArray(value)
    if (!parsed) return []
    return parsed.flatMap((mention): StructuredMention[] => {
        if (!mention || typeof mention !== 'object') return []
        if (mention.type === 'all') return [{ type: 'all' }]
        if (mention.type === 'agent' && typeof mention.participantId === 'string' && mention.participantId) {
            return [{ type: 'agent', participantId: mention.participantId }]
        }
        return []
    })
}

function normalizeMessageRole(role: unknown): string {
    const value = String(role || '').trim()
    return ['user', 'assistant', 'tool', 'command'].includes(value) ? value : 'user'
}

function normalizeMentionDepth(depth: unknown): number {
    const value = Number(depth)
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function maxAgentMentionDepth(): number {
    const value = Number(process.env.HERMES_GROUP_CHAT_MAX_AGENT_MENTION_DEPTH)
    if (!Number.isFinite(value) || value <= 0) return 4
    return Math.min(10, Math.floor(value))
}

function normalizePendingInteractionTimeout(value: unknown): number {
    const timeoutMs = Number(value)
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return 300_000
    return Math.min(600_000, Math.max(1_000, Math.trunc(timeoutMs)))
}

function isExpiredInteractionError(value: unknown): boolean {
    const message = String(value || '').toLowerCase()
    return message.includes('unknown approval request')
        || message.includes('unknown clarification request')
        || message.includes('approval is no longer pending')
        || message.includes('approval is not pending')
        || message.includes('clarification is no longer pending')
        || message.includes('clarification is not pending')
}

export const GROUP_CHAT_MESSAGE_WINDOW = 500
const GROUP_CHAT_CONTEXT_MESSAGE_WINDOW = GROUP_CHAT_MESSAGE_WINDOW
const GROUP_CHAT_TIMESTAMP_BOUNDARY_OVERFLOW = 100
const GROUP_CHAT_SUMMARY_SCAN_LIMIT = 10_000
const GROUP_CHAT_TOKEN_ACCOUNTING_VERSION = 1

function storedGroupAgentRunIdentity(row: any): {
    ownerId: string
    runId?: string
    idPrefix?: string
} | null {
    const role = String(row?.role || '')
    if (role !== 'assistant' && role !== 'tool') return null
    const ownerId = String(row?.senderAgentRecordId || row?.senderId || '').trim()
    if (!ownerId) return null
    const runId = String(row?.run_id || '').trim()
    if (runId) return { ownerId, runId }
    const match = String(row?.id || '').match(/^(.+)_part_\d+(?:_tool(?:call|result)_.+)?$/)
    return match?.[1] ? { ownerId, idPrefix: `${match[1]}_part_` } : null
}

class ChatStorage {
    private readonly trustedAgentMessageMetadata = new Map<string, { mentionDepth: number; handoffChainId: string; continuationAttemptId: string }>()
    private roomAgentOnlineProvider: ((roomId: string, agentId: string) => boolean) | null = null

    private db() { return getDb() }

    setRoomAgentOnlineProvider(provider: ((roomId: string, agentId: string) => boolean) | null): void {
        this.roomAgentOnlineProvider = provider
    }

    private mapStoredMessageRow(
        row: any,
        agentCache = new Map<string, RoomAgent | null>(),
        roomCache = new Map<string, RoomInfo | undefined>(),
    ): ChatMessage {
        const role = String(row.role || 'user')
        const mayBeAgent = row.senderType === 'agent'
            || Boolean(row.senderAgentRecordId)
            || (!row.senderType && (role === 'assistant' || role === 'tool'))
        const agentCacheKey = `${row.roomId || ''}\u0000${row.senderAgentRecordId || row.senderId || ''}`
        let agent = mayBeAgent ? agentCache.get(agentCacheKey) : null
        if (mayBeAgent && agent === undefined) {
            agent = this.getHistoricalMessageAgent(row)
            agentCache.set(agentCacheKey, agent)
        }
        const roomId = String(row.roomId || '')
        let room = agent ? roomCache.get(roomId) : undefined
        if (agent && room === undefined && !roomCache.has(roomId)) {
            room = this.getRoom(roomId)
            roomCache.set(roomId, room)
        }
        const ownerMemberId = agent?.ownerMemberId
            || (
                agent?.executorType === 'server' && Number(room?.ownerAuthUserId || 0) > 0
                    ? authenticatedGroupUserId(Number(room?.ownerAuthUserId))
                    : ''
            )
        const storedMentions = Object.prototype.hasOwnProperty.call(row, 'mentions')
            ? { mentions: parseStructuredMentions(row.mentions) }
            : {}
        return {
            ...row,
            senderType: agent || mayBeAgent ? 'agent' : 'member',
            ...(agent ? {
                senderAgentRecordId: agent.id,
                senderAvatar: agent.avatar || '',
                senderAgentType: agent.agent,
                senderAgentProfile: agent.profile || '',
                senderAgentProvider: agent.provider || '',
                senderAgentModel: agent.model || '',
                senderAgentDescription: agent.description || '',
                senderOwnerMemberId: ownerMemberId,
            } : {}),
            tool_calls: parseJsonArray(row.tool_calls),
            ...storedMentions,
        }
    }

    private getHistoricalMessageAgent(message: Pick<ChatMessage, 'roomId' | 'senderId' | 'senderName' | 'senderAgentRecordId'>): RoomAgent | null {
        const db = this.db()
        if (!db) return null
        const recordId = String(message.senderAgentRecordId || '').trim()
        if (recordId) {
            return (db.prepare(
                `SELECT ${ROOM_AGENT_SELECT_COLUMNS} FROM gc_room_agents WHERE roomId = ? AND id = ?`
            ).get(message.roomId, recordId) as RoomAgent | undefined) || null
        }
        return (db.prepare(
            `SELECT ${ROOM_AGENT_SELECT_COLUMNS}
             FROM gc_room_agents
             WHERE roomId = ? AND (id = ? OR agentId = ?)
             ORDER BY removedAt ASC
             LIMIT 1`
        ).get(message.roomId, message.senderId, message.senderId) as RoomAgent | undefined) || null
    }

    private snapshotMessageSender(msg: ChatMessage, existing?: ChatMessage | null): ChatMessage {
        if (existing?.senderType) {
            return {
                ...msg,
                senderType: existing.senderType,
                senderAgentRecordId: existing.senderAgentRecordId || '',
            }
        }
        if (msg.senderType) return msg

        const agent = this.getRoomAgents(msg.roomId).find(candidate =>
            candidate.id === msg.senderId
            || candidate.agentId === msg.senderId
            || candidate.name === msg.senderName
        )
        if (agent) {
            return {
                ...msg,
                senderType: 'agent',
                senderAgentRecordId: agent.id,
            }
        }

        return {
            ...msg,
            senderType: 'member',
            senderAgentRecordId: '',
        }
    }

    private compactMessageAgentMetadata(messages: ChatMessage[]): ChatMessage[] {
        const seenAgentRecords = new Set<string>()
        return messages.map((message) => {
            const recordId = String(message.senderAgentRecordId || '').trim()
            if (!recordId || !message.senderAgentType || !seenAgentRecords.has(recordId)) {
                if (recordId && message.senderAgentType) seenAgentRecords.add(recordId)
                return message
            }
            const {
                senderAvatar: _senderAvatar,
                senderAgentType: _senderAgentType,
                senderAgentProfile: _senderAgentProfile,
                senderAgentProvider: _senderAgentProvider,
                senderAgentModel: _senderAgentModel,
                senderAgentDescription: _senderAgentDescription,
                senderOwnerMemberId: _senderOwnerMemberId,
                ...compact
            } = message
            return compact
        })
    }

    init(): void {
        const db = this.db()
        if (!db) return
        if (!_tablesEnsured) {
            // Tables are now created centrally in initAllHermesTables()
            // Only create indexes here
            try { db.exec('CREATE INDEX IF NOT EXISTS idx_gc_messages_room ON gc_messages(roomId, timestamp)') } catch { /* ignore */ }
            try { db.exec('CREATE INDEX IF NOT EXISTS idx_gc_messages_history_page ON gc_messages(roomId, timestamp DESC, id DESC)') } catch { /* ignore */ }
            try { db.exec('CREATE INDEX IF NOT EXISTS idx_gc_room_agents_room ON gc_room_agents(roomId)') } catch { /* ignore */ }
            try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_gc_room_members_unique ON gc_room_members(roomId, userId)') } catch { /* ignore */ }
            try { db.exec('CREATE INDEX IF NOT EXISTS idx_gc_pending_session_deletes_profile ON gc_pending_session_deletes(profile_name, status, next_attempt_at, created_at)') } catch { /* ignore */ }
            try { db.exec('CREATE INDEX IF NOT EXISTS idx_gc_session_profiles_profile ON gc_session_profiles(profile_name, created_at)') } catch { /* ignore */ }
            _tablesEnsured = true
        }
        db.prepare(
            `UPDATE gc_room_agents
             SET removedAt = COALESCE((
                 SELECT c.revokedAt FROM gc_agent_connectors c
                 WHERE c.id = gc_room_agents.connectorId AND c.status = 'revoked'
             ), ?)
             WHERE executorType = 'remote'
               AND removedAt = 0
               AND connectorId != ''
               AND EXISTS (
                 SELECT 1 FROM gc_agent_connectors c
                 WHERE c.id = gc_room_agents.connectorId AND c.status = 'revoked'
               )`
        ).run(Date.now())
        const now = Date.now()
        // Group runs cannot survive a server restart; never leave their persisted cards spinning.
        const interruptedPlan = db.prepare('UPDATE gc_messages SET content = ? WHERE id = ?')
        for (const row of db.prepare("SELECT id, content FROM gc_messages WHERE role = 'tool' AND tool_name = 'task_plan'").all() as Array<{ id: string; content: string }>) {
            const plan = parseGroupTaskPlan(row.content)
            if (!plan || plan.execution_state !== 'running') continue
            interruptedPlan.run(JSON.stringify({ ...plan, revision: plan.revision + 1, execution_state: 'interrupted', updated_at: now,
                plan: plan.plan.map(step => ({ ...step, status: step.status === 'in_progress' ? 'pending' : step.status })),
            }), row.id)
        }
        db.prepare(
            `UPDATE gc_execution_queue
             SET status = 'failed', finishedAt = ?, lastError = 'Studio restarted before queued work started'
             WHERE status = 'queued'`,
        ).run(now)
        db.prepare(
            `UPDATE gc_execution_queue
             SET status = 'failed', finishedAt = ?, lastError = 'Studio restarted while work was running'
             WHERE status = 'running'`,
        ).run(now)
        // A source-side receipt is only durable admission. It is never
        // completion: only a target inbox row with terminal evidence can
        // advance the source chain to resumed.
        db.prepare(
            `UPDATE gc_handoff_attempts
             SET status = 'completed', updatedAt = ?
             WHERE status IN ('admitted', 'dispatched')
               AND attemptId IN (SELECT attemptId FROM gc_handoff_inbox WHERE status = 'completed')`,
        ).run(now)
        db.prepare(
            `UPDATE gc_handoff_deliveries SET status = 'completed', updatedAt = ?
             WHERE status = 'accepted'
               AND attemptId IN (SELECT attemptId FROM gc_handoff_inbox WHERE status = 'completed')`,
        ).run(now)
        db.prepare(
            `UPDATE gc_handoff_outbox SET status = 'completed', updatedAt = ?
             WHERE status IN ('delivered', 'dispatched', 'dispatching')
               AND attemptId IN (SELECT attemptId FROM gc_handoff_inbox WHERE status = 'completed')`,
        ).run(now)
        db.prepare(
            `UPDATE gc_handoff_chains
             SET status = 'resumed', continueUsed = 1, stopReason = '', lastError = NULL, updatedAt = ?
             WHERE status = 'claimed'
               AND attemptId IN (SELECT attemptId FROM gc_handoff_inbox WHERE status = 'completed')`,
        ).run(now)
        const remoteOutcomeUnknownError = 'Remote target invocation outcome is unknown after restart'
        const inFlightRemoteAttempts = db.prepare(
            `SELECT attemptId FROM gc_handoff_inbox
             WHERE status = 'running'
               AND invocationStartedAt IS NOT NULL
               AND json_valid(targetSnapshot) = 1
               AND json_extract(targetSnapshot, '$.executorType') = 'remote'`,
        ).all() as Array<{ attemptId: string }>
        for (const row of inFlightRemoteAttempts) {
            this.markRemoteHandoffOutcomeUnknown(String(row.attemptId), remoteOutcomeUnknownError)
        }
        db.prepare(
            `UPDATE gc_handoff_inbox
             SET status = 'failed_manual', lastError = 'Target invocation was in flight during restart',
                 stateVersion = stateVersion + 1, leaseUntil = 0, updatedAt = ?
             WHERE status = 'running' AND invocationStartedAt IS NOT NULL`,
        ).run(now)
        db.prepare(
            `UPDATE gc_handoff_attempts
             SET status = 'failed',
                 lastError = COALESCE((
                   SELECT inbox.lastError FROM gc_handoff_inbox AS inbox
                   WHERE inbox.attemptId = gc_handoff_attempts.attemptId
                     AND inbox.status = 'failed_manual'
                 ), 'Target invocation failed'),
                 leaseUntil = 0, updatedAt = ?
             WHERE attemptId IN (
               SELECT attemptId FROM gc_handoff_inbox WHERE status = 'failed_manual'
             ) AND status NOT IN ('completed', 'outcome_unknown')`,
        ).run(now)
        db.prepare(
            `UPDATE gc_handoff_deliveries SET status = 'failed', updatedAt = ?
             WHERE attemptId IN (
               SELECT attemptId FROM gc_handoff_inbox WHERE status = 'failed_manual'
             ) AND status != 'completed'`,
        ).run(now)
        db.prepare(
            `UPDATE gc_handoff_outbox SET status = 'failed', updatedAt = ?
             WHERE attemptId IN (
               SELECT attemptId FROM gc_handoff_inbox WHERE status = 'failed_manual'
             ) AND status != 'completed'`,
        ).run(now)
        db.prepare(
            `UPDATE gc_handoff_chains
             SET status = 'stopped', stopReason = 'continue_failed',
                 lastError = COALESCE((
                   SELECT inbox.lastError FROM gc_handoff_inbox AS inbox
                   WHERE inbox.attemptId = gc_handoff_chains.attemptId
                     AND inbox.status = 'failed_manual'
                 ), 'Target invocation failed'),
                 updatedAt = ?
             WHERE status = 'claimed' AND continueUsed = 0
               AND attemptId IN (
                 SELECT attemptId FROM gc_handoff_inbox WHERE status = 'failed_manual'
               )`,
        ).run(now)
        db.prepare(
            `UPDATE gc_handoff_inbox
             SET status = 'admitted', executionId = NULL, leaseUntil = 0, updatedAt = ?
             WHERE status = 'running' AND invocationStartedAt IS NULL AND leaseUntil < ?`,
        ).run(now, now)
        db.prepare(
            `UPDATE gc_handoff_attempts
             SET status = 'claimed', leaseUntil = ?, attemptCount = attemptCount + 1, updatedAt = ?
             WHERE status = 'admitted' AND attemptId IN (
               SELECT attemptId FROM gc_handoff_inbox
               WHERE status = 'admitted' AND invocationStartedAt IS NULL
             )`,
        ).run(now + 30_000, now)
        db.prepare(
            `UPDATE gc_handoff_outbox
             SET status = 'pending', availableAt = ?, updatedAt = ?
             WHERE status = 'delivered' AND attemptId IN (
               SELECT attemptId FROM gc_handoff_attempts WHERE status = 'claimed'
             )`,
        ).run(now, now)
        db.prepare(
            `UPDATE gc_handoff_attempts
             SET status = 'claimed', leaseUntil = ?, attemptCount = attemptCount + 1, updatedAt = ?
             WHERE status IN ('dispatching', 'dispatched')
               AND attemptId NOT IN (SELECT attemptId FROM gc_handoff_inbox WHERE status IN ('completed', 'failed_manual', 'cancelled'))`,
        ).run(now + 30_000, now)
        db.prepare(
            `UPDATE gc_handoff_outbox
             SET status = 'pending', availableAt = ?, updatedAt = ?
             WHERE status IN ('dispatched', 'dispatching')
               AND attemptId IN (SELECT attemptId FROM gc_handoff_attempts WHERE status = 'claimed')`,
        ).run(now, now)
        db.prepare(
            `UPDATE gc_handoff_attempts SET status = 'failed', lastError = 'Continuation lease expired during restart', updatedAt = ?
             WHERE status = 'claimed' AND leaseUntil < ?`,
        ).run(now, now)
        db.prepare(
            `UPDATE gc_handoff_chains
             SET status = 'stopped', stopReason = 'continue_failed', lastError = 'Continuation lease expired during restart', updatedAt = ?
             WHERE status = 'claimed' AND attemptId IN (
               SELECT attemptId FROM gc_handoff_attempts WHERE status = 'failed'
             )`,
        ).run(now)
    }

    saveSessionProfile(sessionId: string, roomId: string, agentId: string, profileName: string): void {
        this.db()?.prepare(
            'INSERT INTO gc_session_profiles (session_id, room_id, agent_id, profile_name, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET room_id = excluded.room_id, agent_id = excluded.agent_id, profile_name = excluded.profile_name'
        ).run(sessionId, roomId, agentId, profileName, Date.now())
    }

    getSessionProfile(sessionId: string): GroupChatSessionProfile | null {
        return (this.db()?.prepare(
            'SELECT session_id, room_id, agent_id, profile_name, created_at FROM gc_session_profiles WHERE session_id = ?'
        ).get(sessionId) as GroupChatSessionProfile | undefined) ?? null
    }

    deleteSessionProfile(sessionId: string): void {
        this.db()?.prepare('DELETE FROM gc_session_profiles WHERE session_id = ?').run(sessionId)
    }

    listPendingSessionDeletes(profileName: string, limit = 50): PendingSessionDelete[] {
        const rows = this.db()?.prepare(
            `SELECT session_id, profile_name, status, attempt_count, last_error, created_at, updated_at, next_attempt_at
             FROM gc_pending_session_deletes
             WHERE profile_name = ? AND status = 'pending' AND next_attempt_at <= ?
             ORDER BY created_at ASC
             LIMIT ?`
        ).all(profileName, Date.now(), limit) || []
        return rows.map((row: any) => ({
            session_id: String(row.session_id || ''),
            profile_name: String(row.profile_name || ''),
            status: String(row.status || 'pending'),
            attempt_count: Number(row.attempt_count || 0),
            last_error: row.last_error == null ? null : String(row.last_error),
            created_at: Number(row.created_at || 0),
            updated_at: Number(row.updated_at || 0),
            next_attempt_at: Number(row.next_attempt_at || 0),
        }))
    }

    enqueuePendingSessionDelete(sessionId: string, profileName: string): void {
        const now = Date.now()
        this.db()?.prepare(
            `INSERT INTO gc_pending_session_deletes (session_id, profile_name, status, attempt_count, last_error, created_at, updated_at, next_attempt_at)
             VALUES (?, ?, 'pending', 0, NULL, ?, ?, 0)
             ON CONFLICT(session_id) DO UPDATE SET
               profile_name = excluded.profile_name,
               status = 'pending',
               updated_at = excluded.updated_at,
               next_attempt_at = 0`
        ).run(sessionId, profileName, now, now)
    }

    claimPendingSessionDeletes(profileName: string, limit = 50): PendingSessionDelete[] {
        const rows = this.listPendingSessionDeletes(profileName, limit)
        if (rows.length === 0) return []
        const now = Date.now()
        const stmt = this.db()?.prepare(
            `UPDATE gc_pending_session_deletes
             SET status = 'processing', updated_at = ?
             WHERE session_id = ? AND status = 'pending'`
        )
        const claimed: PendingSessionDelete[] = []
        for (const row of rows) {
            const result = stmt?.run(now, row.session_id)
            if (result?.changes) {
                claimed.push({ ...row, status: 'processing', updated_at: now })
            }
        }
        return claimed
    }

    markPendingSessionDeleteFailed(sessionId: string, error: string): void {
        const now = Date.now()
        this.db()?.prepare(
            `UPDATE gc_pending_session_deletes
             SET status = 'pending',
                 attempt_count = attempt_count + 1,
                 last_error = ?,
                 updated_at = ?,
                 next_attempt_at = ?
             WHERE session_id = ?`
        ).run(error, now, now + 60_000, sessionId)
    }

    removePendingSessionDelete(sessionId: string): void {
        this.db()?.prepare('DELETE FROM gc_pending_session_deletes WHERE session_id = ?').run(sessionId)
    }

    getPendingDeletedSessionIds(): Set<string> {
        const rows = (this.db()?.prepare(
            `SELECT session_id FROM gc_pending_session_deletes WHERE status IN ('pending', 'processing')`
        ).all() || []) as Array<{ session_id: string }>
        return new Set(rows.map(row => row.session_id))
    }

    // ─── Rooms ────────────────────────────────────────────────

    getRoom(roomId: string): RoomInfo | undefined {
        return this.db()?.prepare(`SELECT ${ROOM_SELECT_COLUMNS} FROM gc_rooms WHERE id = ?`).get(roomId) as any
    }

    getRoomActivityAt(roomId: string): number {
        const row = this.db()?.prepare(
            `SELECT ${roomActivityAtSql('m')} AS lastActiveAt
             FROM gc_rooms r
             LEFT JOIN gc_messages m ON m.roomId = r.id
             WHERE r.id = ?
             GROUP BY r.id`,
        ).get(roomId) as { lastActiveAt?: number } | undefined
        return Number(row?.lastActiveAt || 0)
    }

    getRoomByInviteCode(code: string): RoomInfo | undefined {
        return this.db()?.prepare(`SELECT ${ROOM_SELECT_COLUMNS} FROM gc_rooms WHERE inviteCode = ?`).get(code) as any
    }

    getAllRooms(): RoomInfo[] {
        return (this.db()?.prepare(
            `SELECT ${ROOM_SELECT_COLUMNS.split(', ').map(column => `r.${column}`).join(', ')},
                    ${roomActivityAtSql('m')} AS lastActiveAt
             FROM gc_rooms r
             LEFT JOIN gc_messages m ON m.roomId = r.id
             GROUP BY r.id
             ORDER BY lastActiveAt DESC, r.id ASC`,
        ).all() || []) as any[]
    }

    getRoomsForProfiles(profiles: string[]): RoomInfo[] {
        const uniqueProfiles = [...new Set(profiles.map(profile => profile.trim()).filter(Boolean))]
        if (!uniqueProfiles.length) return []
        const placeholders = uniqueProfiles.map(() => '?').join(', ')
        return (this.db()?.prepare(
            `SELECT ${ROOM_SELECT_COLUMNS.split(', ').map(column => `r.${column}`).join(', ')},
                    ${roomActivityAtSql('m')} AS lastActiveAt
             FROM gc_rooms r
             INNER JOIN gc_room_agents a ON a.roomId = r.id
             LEFT JOIN gc_messages m ON m.roomId = r.id
             WHERE a.removedAt = 0
               AND a.executorType = 'server'
               AND a.profile IN (${placeholders})
             GROUP BY r.id
             ORDER BY lastActiveAt DESC, r.id ASC`
        ).all(...uniqueProfiles) || []) as any[]
    }

    getRoomsForAuthUser(authUserId: number): RoomInfo[] {
        if (!Number.isFinite(authUserId) || authUserId <= 0) return []
        return (this.db()?.prepare(
            `SELECT ${ROOM_SELECT_COLUMNS.split(', ').map(column => `r.${column}`).join(', ')},
                    ${roomActivityAtSql('messages')} AS lastActiveAt
             FROM gc_rooms r
             INNER JOIN gc_room_members m ON m.roomId = r.id
             LEFT JOIN gc_messages messages ON messages.roomId = r.id
             WHERE m.authUserId = ?
             GROUP BY r.id
             ORDER BY lastActiveAt DESC, r.id ASC`
        ).all(authUserId) || []) as any[]
    }

    getOwnedRoomsForAuthUser(authUserId: number): RoomInfo[] {
        if (!Number.isFinite(authUserId) || authUserId <= 0) return []
        return (this.db()?.prepare(
            `SELECT ${ROOM_SELECT_COLUMNS.split(', ').map(column => `r.${column}`).join(', ')},
                    ${roomActivityAtSql('m')} AS lastActiveAt
             FROM gc_rooms r
             LEFT JOIN gc_messages m ON m.roomId = r.id
             WHERE r.ownerAuthUserId = ?
             GROUP BY r.id
             ORDER BY lastActiveAt DESC, r.id ASC`
        ).all(authUserId) || []) as any[]
    }

    saveRoom(id: string, name: string, inviteCode?: string, config?: RoomSummaryConfig & RoomAgentHandoffConfig & { workspace?: string; ownerAuthUserId?: number | null }): void {
        const rawOwnerAuthUserId = Number(config?.ownerAuthUserId ?? 0)
        const ownerAuthUserId = Number.isFinite(rawOwnerAuthUserId) && rawOwnerAuthUserId > 0 ? Math.floor(rawOwnerAuthUserId) : null
        this.db()?.prepare(
            `INSERT OR IGNORE INTO gc_rooms (
                id, name, inviteCode, summaryProfile, summaryProvider, summaryModel,
                summaryApiMode, summaryEveryTurns, workspace, ownerAuthUserId, createdAt,
                agentHandoffEnabled, agentHandoffMaxDepth, agentHandoffUnlimited,
                tokenAccountingVersion
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
            id,
            name,
            inviteCode || null,
            String(config?.summaryProfile || 'default').trim() || 'default',
            String(config?.summaryProvider || '').trim(),
            String(config?.summaryModel || '').trim(),
            String(config?.summaryApiMode || '').trim(),
            Math.max(1, Math.floor(Number(config?.summaryEveryTurns || 20))),
            config?.workspace || '',
            ownerAuthUserId,
            Date.now(),
            config?.agentHandoffEnabled === false ? 0 : 1,
            config?.agentHandoffMaxDepth == null ? null : Math.max(1, Math.floor(Number(config.agentHandoffMaxDepth))),
            config?.agentHandoffUnlimited ? 1 : 0,
            GROUP_CHAT_TOKEN_ACCOUNTING_VERSION,
        )
    }

    setRoomOwnerAuthUserId(roomId: string, authUserId: number): void {
        if (!Number.isFinite(authUserId) || authUserId <= 0) return
        this.db()?.prepare('UPDATE gc_rooms SET ownerAuthUserId = ? WHERE id = ?').run(authUserId, roomId)
    }

    updateRoomGuestAgentPolicy(
        roomId: string,
        policy: {
            allowGuestAgents: boolean
            maxGuestAgentsPerMember: number
            allowRemoteWorkspaceAccess: boolean
        },
    ): RoomInfo | null {
        const maxAgents = Math.min(5, Math.max(1, Math.floor(policy.maxGuestAgentsPerMember || 1)))
        const allowRemoteWorkspaceAccess = policy.allowGuestAgents && policy.allowRemoteWorkspaceAccess
        this.db()?.prepare(
            `UPDATE gc_rooms
             SET allowGuestAgents = ?, guestAgentApproval = 'owner',
                 maxGuestAgentsPerMember = ?, allowRemoteWorkspaceAccess = ?
             WHERE id = ?`,
        ).run(policy.allowGuestAgents ? 1 : 0, maxAgents, allowRemoteWorkspaceAccess ? 1 : 0, roomId)
        return this.getRoom(roomId) || null
    }

    updateRoomConfig(roomId: string, config: RoomSummaryConfig & RoomAgentHandoffConfig): void {
        const sets: string[] = []
        const vals: any[] = []
        if (config.summaryProfile !== undefined) { sets.push('summaryProfile = ?'); vals.push(config.summaryProfile) }
        if (config.summaryProvider !== undefined) { sets.push('summaryProvider = ?'); vals.push(config.summaryProvider) }
        if (config.summaryModel !== undefined) { sets.push('summaryModel = ?'); vals.push(config.summaryModel) }
        if (config.summaryApiMode !== undefined) { sets.push('summaryApiMode = ?'); vals.push(config.summaryApiMode) }
        if (config.summaryEveryTurns !== undefined) { sets.push('summaryEveryTurns = ?'); vals.push(config.summaryEveryTurns) }
        if (config.agentHandoffEnabled !== undefined) { sets.push('agentHandoffEnabled = ?'); vals.push(config.agentHandoffEnabled ? 1 : 0) }
        if (config.agentHandoffMaxDepth !== undefined) {
            sets.push('agentHandoffMaxDepth = ?')
            vals.push(config.agentHandoffMaxDepth == null ? null : Math.max(1, Math.floor(Number(config.agentHandoffMaxDepth))))
        }
        if (config.agentHandoffUnlimited !== undefined) { sets.push('agentHandoffUnlimited = ?'); vals.push(config.agentHandoffUnlimited ? 1 : 0) }
        if (sets.length === 0) return
        sets.push('summaryGeneration = summaryGeneration + 1')
        vals.push(roomId)
        this.db()?.prepare(`UPDATE gc_rooms SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
    }

    getRoomAgentHandoffPolicy(roomId: string): GroupChatAgentHandoffPolicy {
        const room = this.getRoom(roomId)
        return resolveGroupChatAgentHandoffPolicy({
            enabled: room?.agentHandoffEnabled == null || Number(room.agentHandoffEnabled) === 1,
            maxDepth: room?.agentHandoffMaxDepth,
            unlimited: Number(room?.agentHandoffUnlimited || 0) === 1,
        }, process.env.HERMES_GROUP_CHAT_MAX_AGENT_MENTION_DEPTH)
    }

    recordHandoffStop(roomId: string, chainId: string, sourceMessageId: string, depth: number, targetAgentId: string, policy: GroupChatAgentHandoffPolicy): void {
        const now = Date.now()
        const targetSnapshot = JSON.stringify(this.getHandoffTargetSnapshot(roomId, targetAgentId) || {})
        this.db()?.prepare(
            `INSERT INTO gc_handoff_chains
              (chainId, roomId, sourceMessageId, currentDepth, maxDepth, unlimited, targetAgentId, targetSnapshot, status, stopReason, createdAt, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'stopped', 'max_depth', ?, ?)
             ON CONFLICT(chainId) DO UPDATE SET
               currentDepth = excluded.currentDepth,
               targetAgentId = excluded.targetAgentId,
               targetSnapshot = excluded.targetSnapshot,
               updatedAt = excluded.updatedAt
             WHERE gc_handoff_chains.status = 'stopped'
               AND gc_handoff_chains.stopReason = 'max_depth'
               AND gc_handoff_chains.continueUsed = 0
               AND gc_handoff_chains.attemptId IS NULL`
        ).run(chainId, roomId, sourceMessageId, depth, policy.maxDepth, policy.unlimited ? 1 : 0, targetAgentId, targetSnapshot, now, now)
    }

    getHandoffChain(roomId: string, chainId: string): any | null {
        return this.db()?.prepare('SELECT * FROM gc_handoff_chains WHERE roomId = ? AND chainId = ?').get(roomId, chainId) || null
    }

    private actionableHandoffChainWhere(alias = 'chain'): string {
        const effectiveDefaultDepth = resolveGroupChatAgentHandoffPolicy(
            { enabled: true, maxDepth: null, unlimited: false },
            process.env.HERMES_GROUP_CHAT_MAX_AGENT_MENTION_DEPTH,
        ).maxDepth ?? DEFAULT_GROUP_CHAT_AGENT_HANDOFF_DEPTH
        const ecmaTrimCharacters = [
            "' '",
            'char(9)', 'char(10)', 'char(11)', 'char(12)', 'char(13)',
            'char(160)', 'char(5760)',
            'char(8192)', 'char(8193)', 'char(8194)', 'char(8195)', 'char(8196)', 'char(8197)',
            'char(8198)', 'char(8199)', 'char(8200)', 'char(8201)', 'char(8202)',
            'char(8232)', 'char(8233)', 'char(8239)', 'char(8287)', 'char(12288)', 'char(65279)',
        ].join(' || ')
        return `${alias}.status = 'stopped'
               AND (
                 ${alias}.stopReason = 'max_depth'
                 OR (
                   ${alias}.stopReason = 'continue_failed'
                   AND ${alias}.attemptId IS NOT NULL
                   AND typeof(${alias}.lastError) = 'text'
                   AND length(trim(${alias}.lastError, ${ecmaTrimCharacters})) > 0
                   AND EXISTS (
                     SELECT 1 FROM gc_handoff_attempts AS failed_attempt
                     WHERE failed_attempt.attemptId = ${alias}.attemptId
                       AND failed_attempt.chainId = ${alias}.chainId
                       AND failed_attempt.roomId = ${alias}.roomId
                       AND failed_attempt.status = 'failed'
                   )
                 )
               )
               AND ${alias}.continueUsed = 0
               AND ${alias}.unlimited = 0
               AND typeof(${alias}.maxDepth) = 'integer'
               AND typeof(${alias}.currentDepth) = 'integer'
               AND ${alias}.maxDepth >= 1
               AND ${alias}.maxDepth < ${Number.MAX_SAFE_INTEGER}
               AND ${alias}.currentDepth >= ${alias}.maxDepth
               AND ${alias}.currentDepth < ${Number.MAX_SAFE_INTEGER}
               AND EXISTS (
                 SELECT 1 FROM gc_rooms AS policy_room
                 WHERE policy_room.id = ${alias}.roomId
                   AND COALESCE(policy_room.agentHandoffEnabled, 1) = 1
                   AND COALESCE(policy_room.agentHandoffUnlimited, 0) = 0
                   AND (
                     (policy_room.agentHandoffMaxDepth IS NULL AND ${alias}.maxDepth = ${effectiveDefaultDepth})
                     OR (
                       typeof(policy_room.agentHandoffMaxDepth) = 'integer'
                       AND policy_room.agentHandoffMaxDepth >= 1
                       AND policy_room.agentHandoffMaxDepth < ${Number.MAX_SAFE_INTEGER}
                       AND policy_room.agentHandoffMaxDepth = ${alias}.maxDepth
                     )
                   )
               )`
    }

    private getActionableHandoffChain(roomId: string, chainId: string): any | null {
        const chain = this.db()?.prepare(
            `SELECT chain.* FROM gc_handoff_chains AS chain
             INNER JOIN gc_messages AS source
               ON source.id = chain.sourceMessageId AND source.roomId = chain.roomId
             INNER JOIN gc_room_agents AS target
               ON target.agentId = chain.targetAgentId AND target.roomId = chain.roomId
             WHERE chain.roomId = ? AND chain.chainId = ?
               AND ${this.actionableHandoffChainWhere('chain')}`,
        ).get(roomId, chainId) as any
        if (!chain) return null
        const currentSnapshot = this.getHandoffTargetSnapshot(roomId, String(chain.targetAgentId))
        if (!currentSnapshot || JSON.stringify(currentSnapshot) !== String(chain.targetSnapshot || '{}')) return null
        return chain
    }

    getStoppedHandoffChains(roomId: string): any[] {
        const db = this.db()
        if (!db) return []
        const actionable = (db.prepare(
            `SELECT chain.* FROM gc_handoff_chains AS chain
             INNER JOIN gc_messages AS source
               ON source.id = chain.sourceMessageId AND source.roomId = chain.roomId
             INNER JOIN gc_room_agents AS target
               ON target.agentId = chain.targetAgentId AND target.roomId = chain.roomId
             WHERE chain.roomId = ?
               AND ${this.actionableHandoffChainWhere('chain')}`,
        ).all(roomId) || []) as any[]
        const visibleActionable = actionable.filter(chain => {
            const currentSnapshot = this.getHandoffTargetSnapshot(roomId, String(chain.targetAgentId))
            return currentSnapshot && JSON.stringify(currentSnapshot) === String(chain.targetSnapshot || '{}')
        })
        const outcomeUnknown = (db.prepare(
            `SELECT chain.* FROM gc_handoff_chains AS chain
             INNER JOIN gc_messages AS source
               ON source.id = chain.sourceMessageId AND source.roomId = chain.roomId
             WHERE chain.roomId = ?
               AND chain.status = 'outcome_unknown'
               AND chain.stopReason = 'outcome_unknown'
               AND chain.continueUsed = 1
               AND chain.attemptId IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM gc_handoff_attempts AS attempt
                 WHERE attempt.attemptId = chain.attemptId
                   AND attempt.chainId = chain.chainId
                   AND attempt.roomId = chain.roomId
                   AND attempt.status = 'outcome_unknown'
               )`,
        ).all(roomId) || []) as any[]
        return [...visibleActionable, ...outcomeUnknown]
            .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))
    }

    claimHandoffContinuation(roomId: string, chainId: string): any | null {
        const db = this.db()
        if (!db) return null
        return this.withImmediateTransaction(db, () => {
            const chain = this.getActionableHandoffChain(roomId, chainId)
            if (!chain) return null
            const source = this.getMessage(String(chain.sourceMessageId))
            if (!source || source.roomId !== roomId) return null
            const attemptId = randomUUID()
            const now = Date.now()
            const payload = JSON.stringify({
                messageId: source.id,
                content: String(source.content || ''),
                input: String(source.content || ''),
                senderName: source.senderName,
                senderId: source.senderId,
                timestamp: source.timestamp,
                role: source.role,
                mentionDepth: Number(chain.currentDepth) - 1,
                handoffChainId: chain.chainId,
                mentions: [{ type: 'agent', participantId: String(chain.targetAgentId) }],
            })
            const targetSnapshot = String(chain.targetSnapshot || '{}')
            const payloadDigest = createHash('sha256').update(payload).digest('hex')
            const previousAttemptId = String(chain.attemptId || '')
            const claimed = db.prepare(
                `UPDATE gc_handoff_chains
                 SET status = 'claimed', attemptId = ?, updatedAt = ?
                 WHERE roomId = ? AND chainId = ? AND targetSnapshot = ? AND ${this.actionableHandoffChainWhere('gc_handoff_chains')}`,
            ).run(attemptId, now, roomId, chainId, targetSnapshot)
            if (!claimed.changes) return null
            db.prepare(
                `INSERT INTO gc_handoff_attempts
                   (attemptId, chainId, roomId, sourceInstanceId, targetAgentId, targetSnapshot, payloadDigest, replacesAttemptId, status, leaseUntil, attemptCount, createdAt, updatedAt)
                 VALUES (?, ?, ?, 'studio', ?, ?, ?, ?, 'claimed', ?, 1, ?, ?)`,
            ).run(
                attemptId,
                chainId,
                roomId,
                String(chain.targetAgentId),
                targetSnapshot,
                payloadDigest,
                previousAttemptId || null,
                now + 30_000,
                now,
                now,
            )
            db.prepare(
                `INSERT INTO gc_handoff_outbox
                   (attemptId, roomId, payload, status, availableAt, createdAt, updatedAt)
                 VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
            ).run(attemptId, roomId, payload, now, now, now)
            return this.getHandoffChain(roomId, chainId)
        })
    }

    getHandoffAttempt(attemptId: string): any | null {
        return this.db()?.prepare('SELECT * FROM gc_handoff_attempts WHERE attemptId = ?').get(attemptId) || null
    }

    claimHandoffOutbox(attemptId?: string): any | null {
        const db = this.db()
        if (!db) return null
        const now = Date.now()
        const leaseUntil = now + 30_000
        return this.withImmediateTransaction(db, () => {
            const row = db.prepare(
                `SELECT o.*, a.targetAgentId
                 FROM gc_handoff_outbox o
                 JOIN gc_handoff_attempts a ON a.attemptId = o.attemptId
                 WHERE o.status IN ('pending', 'dispatching') AND o.availableAt <= ?
                   AND a.status = 'claimed'
                   ${attemptId ? 'AND o.attemptId = ?' : ''}
                 ORDER BY o.availableAt ASC, o.createdAt ASC
                 LIMIT 1`,
            ).get(...(attemptId ? [now, attemptId] : [now])) as any
            if (!row) return null
            const claimed = db.prepare(
                `UPDATE gc_handoff_outbox SET status = 'dispatching', availableAt = ?, updatedAt = ?
                 WHERE attemptId = ? AND status IN ('pending', 'dispatching') AND availableAt <= ?`,
            ).run(leaseUntil, now, row.attemptId, now)
            if (!claimed.changes) return null
            db.prepare(
                `UPDATE gc_handoff_attempts
                 SET leaseUntil = ?, attemptCount = attemptCount + 1, updatedAt = ?
                 WHERE attemptId = ? AND status = 'claimed'`,
            ).run(leaseUntil, now, row.attemptId)
            return { ...row, status: 'dispatching', leaseUntil }
        })
    }

    requeueHandoffOutbox(attemptId: string, error: string, maxAttempts = 3): void {
        const db = this.db()
        if (!db) return
        const now = Date.now()
        const attempt = this.getHandoffAttempt(attemptId)
        if (!attempt || attempt.status === 'completed') return
        const message = error.slice(0, 2000)
        if (Number(attempt.attemptCount || 0) >= maxAttempts) {
            const chain = db.prepare('SELECT roomId, chainId FROM gc_handoff_chains WHERE attemptId = ?').get(attemptId) as any
            db.prepare(`UPDATE gc_handoff_attempts SET status = 'failed', lastError = ?, updatedAt = ? WHERE attemptId = ?`)
                .run(message, now, attemptId)
            db.prepare(`UPDATE gc_handoff_outbox SET status = 'failed', updatedAt = ? WHERE attemptId = ?`)
                .run(now, attemptId)
            if (chain) {
                db.prepare(
                    `UPDATE gc_handoff_chains SET status = 'stopped', stopReason = 'continue_failed', lastError = ?, updatedAt = ?
                     WHERE roomId = ? AND chainId = ? AND attemptId = ? AND continueUsed = 0`,
                ).run(message, now, chain.roomId, chain.chainId, attemptId)
            }
            return
        }
        db.prepare(`UPDATE gc_handoff_attempts SET status = 'claimed', lastError = ?, leaseUntil = ?, updatedAt = ? WHERE attemptId = ?`)
            .run(message, now + 1_000, now, attemptId)
        db.prepare(`UPDATE gc_handoff_outbox SET status = 'pending', availableAt = ?, updatedAt = ? WHERE attemptId = ?`)
            .run(now + 1_000, now, attemptId)
    }

    deferHandoffOutbox(attemptId: string, error: string, delayMs = 5_000): void {
        const db = this.db()
        if (!db) return
        const now = Date.now()
        db.prepare(
            `UPDATE gc_handoff_attempts
             SET status = 'claimed', lastError = ?, leaseUntil = ?, attemptCount = MAX(0, attemptCount - 1), updatedAt = ?
             WHERE attemptId = ? AND status != 'completed'`,
        ).run(error.slice(0, 2000), now + delayMs, now, attemptId)
        db.prepare(
            `UPDATE gc_handoff_outbox SET status = 'pending', availableAt = ?, updatedAt = ?
             WHERE attemptId = ? AND status != 'completed'`,
        ).run(now + delayMs, now, attemptId)
    }

    finishHandoffOutbox(attemptId: string): void {
        this.db()?.prepare(`UPDATE gc_handoff_outbox SET status = 'completed', updatedAt = ? WHERE attemptId = ?`).run(Date.now(), attemptId)
    }

    claimHandoffDelivery(attemptId: string, targetAgentId: string): 'accepted' | 'already' | null {
        const db = this.db()
        if (!db) return null
        const now = Date.now()
        try {
            db.prepare(
                `INSERT INTO gc_handoff_deliveries (attemptId, targetAgentId, status, createdAt, updatedAt)
                 VALUES (?, ?, 'accepted', ?, ?)`,
            ).run(attemptId, targetAgentId, now, now)
            return 'accepted'
        } catch {
            const row = db.prepare(
                `SELECT d.targetAgentId, d.status, a.status AS attemptStatus
                 FROM gc_handoff_deliveries d
                 LEFT JOIN gc_handoff_attempts a ON a.attemptId = d.attemptId
                 WHERE d.attemptId = ?`,
            ).get(attemptId) as any
            if (!row || String(row.targetAgentId) !== targetAgentId) return null
            if (row.status === 'accepted' && row.attemptStatus === 'dispatched') return 'already'
            // A restart reopens the durable attempt. Allow exactly one
            // recovered queue admission; while dispatched/completed, replay is
            // an idempotent no-op.
            if (row.status === 'accepted' && row.attemptStatus === 'claimed') {
                db.prepare(
                    `UPDATE gc_handoff_deliveries SET updatedAt = ? WHERE attemptId = ?`,
                ).run(now, attemptId)
                return 'accepted'
            }
            return 'already'
        }
    }

    releaseHandoffDelivery(attemptId: string): void {
        this.db()?.prepare(`DELETE FROM gc_handoff_deliveries WHERE attemptId = ? AND status = 'accepted'`).run(attemptId)
    }

    admitHandoffTarget(
        attemptId: string,
        targetAgentId: string,
        payload: Record<string, unknown>,
        targetSnapshot: Record<string, unknown> = {},
    ): { status: 'admitted' | 'already'; inboxId: string; receipt: string; stateVersion: number } | null {
        const db = this.db()
        if (!db) return null
        const attempt = this.getHandoffAttempt(attemptId)
        if (!attempt || String(attempt.targetAgentId) !== targetAgentId) return null
        const transportAttemptId = typeof payload.continuationAttemptId === 'string'
            ? payload.continuationAttemptId.trim()
            : ''
        if (transportAttemptId && transportAttemptId !== attemptId) return null
        // continuationAttemptId is dispatcher-owned transport metadata. The
        // attempt already authenticates it separately, so keep it out of the
        // canonical payload that was frozen when the outbox row was created.
        const { continuationAttemptId: _transportAttemptId, ...canonicalPayload } = payload
        const payloadText = JSON.stringify(canonicalPayload)
        const payloadDigest = createHash('sha256').update(payloadText).digest('hex')
        const snapshotText = JSON.stringify(targetSnapshot)
        if (String(attempt.sourceInstanceId || 'studio') !== 'studio'
            || (String(attempt.payloadDigest || '') && String(attempt.payloadDigest) !== payloadDigest)
            || (String(attempt.targetSnapshot || '{}') !== snapshotText)) return null
        const now = Date.now()
        return this.withImmediateTransaction(db, () => {
            const existing = db.prepare(
                'SELECT inboxId, receipt, status, stateVersion, payloadDigest, targetSnapshot FROM gc_handoff_inbox WHERE sourceInstanceId = ? AND attemptId = ?',
            ).get('studio', attemptId) as any
            if (existing) {
                if (String(existing.payloadDigest) !== payloadDigest || String(existing.targetSnapshot) !== snapshotText) return null
                return {
                    status: 'already',
                    inboxId: String(existing.inboxId),
                    receipt: String(existing.receipt),
                    stateVersion: Number(existing.stateVersion),
                }
            }
            const inboxId = randomUUID()
            const receipt = randomBytes(24).toString('hex')
            db.prepare(
                `INSERT INTO gc_handoff_inbox
                 (inboxId, sourceInstanceId, attemptId, targetAgentId, targetSnapshot, payloadDigest, payload, receipt, status, stateVersion, createdAt, updatedAt)
                 VALUES (?, 'studio', ?, ?, ?, ?, ?, ?, 'admitted', 1, ?, ?)`,
            ).run(inboxId, attemptId, targetAgentId, snapshotText, payloadDigest, payloadText, receipt, now, now)
            return { status: 'admitted', inboxId, receipt, stateVersion: 1 }
        })
    }

    getHandoffTargetStatus(attemptId: string, receipt?: string): any | null {
        const row = this.db()?.prepare(
            'SELECT * FROM gc_handoff_inbox WHERE sourceInstanceId = ? AND attemptId = ?',
        ).get('studio', attemptId) as any
        if (!row || (receipt && String(row.receipt) !== receipt)) return null
        return row
    }

    markHandoffTargetRunning(attemptId: string, executionId: string, leaseUntil: number): boolean {
        const result = this.db()?.prepare(
            `UPDATE gc_handoff_inbox
             SET status = 'running', stateVersion = stateVersion + 1, executionId = ?, leaseUntil = ?, updatedAt = ?
             WHERE sourceInstanceId = 'studio' AND attemptId = ? AND status = 'admitted'`,
        ).run(executionId, leaseUntil, Date.now(), attemptId)
        return Boolean(result?.changes)
    }

    markHandoffTargetInvocationStarted(attemptId: string): boolean {
        const now = Date.now()
        const result = this.db()?.prepare(
            `UPDATE gc_handoff_inbox SET invocationStartedAt = ?, updatedAt = ?
             WHERE sourceInstanceId = 'studio' AND attemptId = ? AND status = 'running' AND invocationStartedAt IS NULL`,
        ).run(now, now, attemptId)
        return Boolean(result?.changes)
    }

    completeHandoffTarget(attemptId: string, terminalMessageId: string): boolean {
        const result = this.db()?.prepare(
            `UPDATE gc_handoff_inbox
             SET status = 'completed', stateVersion = stateVersion + 1, terminalMessageId = ?, leaseUntil = 0, updatedAt = ?
             WHERE sourceInstanceId = 'studio' AND attemptId = ? AND status IN ('admitted', 'running')`,
        ).run(terminalMessageId, Date.now(), attemptId)
        return Boolean(result?.changes)
    }

    registerTrustedAgentMessageMetadata(roomId: string, messageId: string, mentionDepth: unknown, handoffChainId: unknown, continuationAttemptId?: unknown): void {
        const depth = typeof mentionDepth === 'number' && Number.isFinite(mentionDepth)
            ? Math.max(0, Math.floor(mentionDepth))
            : null
        const chainId = typeof handoffChainId === 'string' ? handoffChainId.trim() : ''
        if (depth == null || !chainId) return
        const attemptId = typeof continuationAttemptId === 'string' ? continuationAttemptId.trim() : ''
        this.trustedAgentMessageMetadata.set(`${roomId}:${messageId}`, {
            mentionDepth: depth,
            handoffChainId: chainId,
            continuationAttemptId: attemptId,
        })
    }

    consumeTrustedAgentMessageMetadata(roomId: string, messageId: string): { mentionDepth: number; handoffChainId: string; continuationAttemptId: string } | null {
        const key = `${roomId}:${messageId}`
        const metadata = this.trustedAgentMessageMetadata.get(key) || null
        this.trustedAgentMessageMetadata.delete(key)
        return metadata
    }

    markRemoteHandoffOutcomeUnknown(attemptId: string, error: string): any | null {
        const db = this.db()
        if (!db) return null
        const diagnostic = error.slice(0, 2000)
        return this.withImmediateTransaction(db, () => {
            const state = db.prepare(
                `SELECT attempt.chainId, attempt.roomId
                 FROM gc_handoff_inbox AS inbox
                 INNER JOIN gc_handoff_attempts AS attempt ON attempt.attemptId = inbox.attemptId
                 INNER JOIN gc_handoff_chains AS chain
                   ON chain.attemptId = attempt.attemptId
                  AND chain.chainId = attempt.chainId
                  AND chain.roomId = attempt.roomId
                 WHERE inbox.sourceInstanceId = 'studio'
                   AND inbox.attemptId = ?
                   AND inbox.status = 'running'
                   AND inbox.invocationStartedAt IS NOT NULL
                   AND json_valid(inbox.targetSnapshot) = 1
                   AND json_extract(inbox.targetSnapshot, '$.executorType') = 'remote'
                   AND attempt.status != 'completed'
                   AND chain.status = 'claimed'
                   AND chain.continueUsed = 0`,
            ).get(attemptId) as { chainId: string; roomId: string } | undefined
            if (!state) return null
            const now = Date.now()
            const inbox = db.prepare(
                `UPDATE gc_handoff_inbox
                 SET status = 'outcome_unknown', stateVersion = stateVersion + 1,
                     lastError = ?, leaseUntil = 0, updatedAt = ?
                 WHERE sourceInstanceId = 'studio' AND attemptId = ?
                   AND status = 'running' AND invocationStartedAt IS NOT NULL`,
            ).run(diagnostic, now, attemptId)
            const attempt = db.prepare(
                `UPDATE gc_handoff_attempts
                 SET status = 'outcome_unknown', lastError = ?, leaseUntil = 0, updatedAt = ?
                 WHERE attemptId = ? AND status != 'completed'`,
            ).run(diagnostic, now, attemptId)
            const outbox = db.prepare(
                `UPDATE gc_handoff_outbox SET status = 'outcome_unknown', updatedAt = ?
                 WHERE attemptId = ? AND status != 'completed'`,
            ).run(now, attemptId)
            const delivery = db.prepare(
                `UPDATE gc_handoff_deliveries SET status = 'outcome_unknown', updatedAt = ?
                 WHERE attemptId = ? AND status != 'completed'`,
            ).run(now, attemptId)
            const chain = db.prepare(
                `UPDATE gc_handoff_chains
                 SET status = 'outcome_unknown', stopReason = 'outcome_unknown', continueUsed = 1,
                     lastError = ?, updatedAt = ?
                 WHERE roomId = ? AND chainId = ? AND attemptId = ?
                   AND status = 'claimed' AND continueUsed = 0`,
            ).run(diagnostic, now, state.roomId, state.chainId, attemptId)
            if (![inbox, attempt, chain].every(result => result.changes === 1)) {
                throw new Error('Remote handoff outcome-unknown transition was incomplete')
            }
            return this.getHandoffChain(state.roomId, state.chainId)
        })
    }

    failHandoffTarget(attemptId: string, error: string): boolean {
        const result = this.db()?.prepare(
            `UPDATE gc_handoff_inbox
             SET status = 'failed_manual', stateVersion = stateVersion + 1, lastError = ?, leaseUntil = 0, updatedAt = ?
             WHERE sourceInstanceId = 'studio' AND attemptId = ? AND status = 'running'`,
        ).run(error.slice(0, 2000), Date.now(), attemptId)
        return Boolean(result?.changes)
    }

    acceptHandoffAttempt(attemptId: string, targetAgentId: string): 'accepted' | 'already' | null {
        const db = this.db()
        if (!db) return null
        const now = Date.now()
        const attempt = this.getHandoffAttempt(attemptId)
        if (!attempt || String(attempt.targetAgentId) !== targetAgentId) return null
        const target = this.getHandoffTargetStatus(attemptId)
        if (!target || !['admitted', 'running', 'completed'].includes(String(target.status))) return null
        if (attempt.status === 'admitted' || attempt.status === 'dispatched' || attempt.status === 'completed') return 'already'
        if (attempt.status !== 'claimed' || Number(attempt.leaseUntil) < now) return null
        const result = db.prepare(
            `UPDATE gc_handoff_attempts
             SET status = 'admitted', updatedAt = ?
             WHERE attemptId = ? AND status = 'claimed' AND leaseUntil >= ?`,
        ).run(now, attemptId, now)
        if (!result.changes) return null
        db.prepare(`UPDATE gc_handoff_outbox SET status = 'delivered', updatedAt = ? WHERE attemptId = ?`).run(now, attemptId)
        return 'accepted'
    }

    completeHandoffContinuation(roomId: string, chainId: string): any | null {
        const chain = this.getHandoffChain(roomId, chainId)
        if (!chain || !chain.attemptId) return null
        const target = this.getHandoffTargetStatus(String(chain.attemptId))
        if (!target || String(target.status) !== 'completed' || !String(target.terminalMessageId || '')) return null
        const now = Date.now()
        const result = this.db()?.prepare(
            `UPDATE gc_handoff_attempts SET status = 'completed', updatedAt = ?
             WHERE attemptId = ? AND status IN ('admitted', 'dispatched')`,
        ).run(now, chain.attemptId)
        if (!result?.changes && this.getHandoffAttempt(chain.attemptId)?.status !== 'completed') return null
        this.db()?.prepare(
            `UPDATE gc_handoff_deliveries SET status = 'completed', updatedAt = ? WHERE attemptId = ?`,
        ).run(now, chain.attemptId)
        this.db()?.prepare(
            `UPDATE gc_handoff_outbox SET status = 'completed', updatedAt = ? WHERE attemptId = ?`,
        ).run(now, chain.attemptId)
        this.db()?.prepare(
            `UPDATE gc_handoff_chains
             SET continueUsed = 1, status = 'resumed', stopReason = '', lastError = NULL, updatedAt = ?
             WHERE roomId = ? AND chainId = ? AND attemptId = ?`,
        ).run(now, roomId, chainId, chain.attemptId)
        return this.getHandoffChain(roomId, chainId)
    }

    failHandoffContinuation(roomId: string, chainId: string, error: string): any | null {
        const chain = this.getHandoffChain(roomId, chainId)
        if (!chain || !chain.attemptId) return null
        const now = Date.now()
        this.db()?.prepare(
            `UPDATE gc_handoff_attempts SET status = 'failed', lastError = ?, updatedAt = ? WHERE attemptId = ? AND status != 'completed'`,
        ).run(error.slice(0, 2000), now, chain.attemptId)
        this.db()?.prepare(
            `UPDATE gc_handoff_outbox SET status = 'failed', updatedAt = ? WHERE attemptId = ?`,
        ).run(now, chain.attemptId)
        this.db()?.prepare(
            `UPDATE gc_handoff_deliveries SET status = 'failed', updatedAt = ?
             WHERE attemptId = ? AND status != 'completed'`,
        ).run(now, chain.attemptId)
        this.db()?.prepare(
            `UPDATE gc_handoff_chains
             SET status = 'stopped', stopReason = 'continue_failed', lastError = ?, updatedAt = ?
             WHERE roomId = ? AND chainId = ? AND attemptId = ? AND continueUsed = 0`,
        ).run(error.slice(0, 2000), now, roomId, chainId, chain.attemptId)
        return this.getHandoffChain(roomId, chainId)
    }

    updateRoomName(roomId: string, name: string): void {
        this.db()?.prepare('UPDATE gc_rooms SET name = ? WHERE id = ?').run(name, roomId)
    }

    updateRoomInviteCode(roomId: string, inviteCode: string): void {
        this.db()?.prepare('UPDATE gc_rooms SET inviteCode = ? WHERE id = ?').run(inviteCode, roomId)
    }

    updateRoomTotalTokens(roomId: string, tokens: number): void {
        this.db()?.prepare('UPDATE gc_rooms SET totalTokens = ? WHERE id = ?').run(tokens, roomId)
    }

    getRoomWorkspace(roomId: string): string {
        return String(this.getRoom(roomId)?.workspace || '')
    }

    updateRoomWorkspace(roomId: string, workspace: string): RoomInfo | null {
        const room = this.getRoom(roomId)
        if (!room) return null
        const nextWorkspace = String(workspace || '')
        if (String(room.workspace || '') === nextWorkspace) return room
        const seed = this.newRoomSessionSeed()
        this.db()?.prepare('UPDATE gc_rooms SET workspace = ?, sessionSeed = ? WHERE id = ?').run(nextWorkspace, seed, roomId)
        return this.getRoom(roomId) || null
    }

    private newRoomSessionSeed(): string {
        return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    }

    rotateRoomSessionSeed(roomId: string): string {
        const seed = this.newRoomSessionSeed()
        this.db()?.prepare('UPDATE gc_rooms SET sessionSeed = ? WHERE id = ?').run(seed, roomId)
        return seed
    }

    estimateTokens(text: string): number {
        const cjk = (text.match(/[\u2e80-\u9fff\uac00-\ud7af\u3000-\u303f\uff00-\uffef]/g) || []).length
        const other = text.length - cjk
        return Math.ceil(cjk * 1.5 + other / 4)
    }

    private contentToUsageText(content: unknown): string {
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

    private messageUsageTokens(message: Pick<ChatMessage, 'role' | 'content' | 'tool_calls' | 'reasoning' | 'reasoning_content' | 'tool_name'>): number {
        if (message.tool_name === 'task_plan') return 0
        const role = message.role || 'user'
        if (role === 'user') return countTokens(this.contentToUsageText(message.content))
        if (role !== 'assistant' && role !== 'tool') return 0
        const reasoning = message.reasoning_content ?? message.reasoning
        return countTokens(this.contentToUsageText(message.content))
            + countTokens(String(message.tool_calls || ''))
            + countTokens(String(reasoning || ''))
    }

    // ─── Messages ─────────────────────────────────────────────

    private getRecentMessageRows(
        roomId: string,
        limit: number,
        options: { excludeWorkspaceDiff?: boolean; throughMessageId?: string } = {},
    ): any[] {
        const db = this.db()
        const boundedLimit = Math.max(0, Math.floor(limit))
        if (!db || boundedLimit === 0) return []

        const where = ['roomId = ?']
        const params: Array<string | number> = [roomId]
        if (options.excludeWorkspaceDiff) {
            where.push("COALESCE(tool_name, '') NOT IN ('workspace_diff', 'task_plan')")
        }
        if (options.throughMessageId) {
            const through = db.prepare(
                'SELECT timestamp, id FROM gc_messages WHERE roomId = ? AND id = ?'
            ).get(roomId, options.throughMessageId) as { timestamp: number; id: string } | undefined
            if (through) {
                where.push('(timestamp, id) <= (?, ?)')
                params.push(through.timestamp, through.id)
            }
        }

        const predicate = where.join(' AND ')
        const boundary = db.prepare(
            `SELECT timestamp FROM gc_messages
             WHERE ${predicate}
             ORDER BY timestamp DESC, id DESC
             LIMIT 1 OFFSET ?`
        ).get(...params, boundedLimit - 1) as { timestamp: number } | undefined
        return db.prepare(
            `SELECT ${MESSAGE_SELECT_COLUMNS} FROM gc_messages
             WHERE ${predicate}${boundary ? ' AND timestamp >= ?' : ''}
             ORDER BY timestamp DESC, id DESC
             LIMIT ?`
        ).all(
            ...params,
            ...(boundary ? [boundary.timestamp] : []),
            boundedLimit + GROUP_CHAT_TIMESTAMP_BOUNDARY_OVERFLOW,
        ) as any[]
    }

    getRecentMessagesForUI(roomId: string, limit = 150, offset = 0): ChatMessage[] {
        const safeLimit = Math.max(0, Math.floor(Number(limit) || 0))
        const safeOffset = Math.max(0, Math.floor(Number(offset) || 0))
        const rows = this.getRecentMessageRows(roomId, safeLimit + safeOffset)
        const page = paginateRecentGroupMessagesCanonical(rows, { limit: safeLimit, offset: safeOffset })
        const agentCache = new Map<string, RoomAgent | null>()
        const roomCache = new Map<string, RoomInfo | undefined>()
        return this.compactMessageAgentMetadata(
            page.map(row => this.mapStoredMessageRow(row, agentCache, roomCache)),
        ).map(buildOutboundGroupMessage)
    }

    getRunTaskPlanMessages(roomId: string, runIds: string[]): Array<{ run_id: string; content: string }> {
        const db = this.db()
        if (!db || !runIds.length) return []
        const rows: Array<{ run_id: string; content: string }> = []
        for (let start = 0; start < runIds.length; start += 200) {
            const ids = runIds.slice(start, start + 200)
            rows.push(...db.prepare(`SELECT run_id, content FROM gc_messages
                WHERE roomId = ? AND tool_name = 'task_plan' AND role = 'tool' AND senderType = 'agent'
                AND run_id IN (${ids.map(() => '?').join(',')}) ORDER BY timestamp ASC, id ASC`)
                .all(roomId, ...ids) as Array<{ run_id: string; content: string }>)
        }
        return rows
    }

    getHistoryPageForUI(
        roomId: string,
        limit = 150,
        beforeMessageId?: string,
    ): { messages: ChatMessage[]; hasMore: boolean; cursorFound: boolean } {
        const db = this.db()
        const safeLimit = Math.min(150, Math.max(1, Math.floor(Number(limit) || 150)))
        if (!db) return { messages: [], hasMore: false, cursorFound: !beforeMessageId }

        const params: Array<string | number> = [roomId]
        let cursorFound = true
        let cursorPredicate = ''
        if (beforeMessageId) {
            const cursor = db.prepare(
                'SELECT timestamp, id FROM gc_messages WHERE roomId = ? AND id = ?',
            ).get(roomId, beforeMessageId) as { timestamp: number; id: string } | undefined
            cursorFound = Boolean(cursor)
            if (!cursor) return { messages: [], hasMore: false, cursorFound: false }
            cursorPredicate = ' AND (timestamp < ? OR (timestamp = ? AND id < ?))'
            params.push(cursor.timestamp, cursor.timestamp, cursor.id)
        }

        let pageRowsDescending = db.prepare(
            `SELECT ${MESSAGE_SELECT_COLUMNS} FROM gc_messages
             WHERE roomId = ?${cursorPredicate}
             ORDER BY timestamp DESC, id DESC
             LIMIT ?`,
        ).all(...params, safeLimit) as any[]

        const boundary = pageRowsDescending.at(-1)
        const runIdentity = storedGroupAgentRunIdentity(boundary)
        if (boundary && runIdentity) {
            const runPredicate = runIdentity.runId
                ? 'run_id = ?'
                : "(COALESCE(run_id, '') = '' AND INSTR(id, ?) = 1)"
            const oldestRunRow = db.prepare(
                `SELECT timestamp, id FROM gc_messages
                 WHERE roomId = ?${cursorPredicate}
                   AND role IN ('assistant', 'tool')
                   AND COALESCE(NULLIF(senderAgentRecordId, ''), senderId) = ?
                   AND ${runPredicate}
                 ORDER BY timestamp ASC, id ASC
                 LIMIT 1`,
            ).get(
                ...params,
                runIdentity.ownerId,
                runIdentity.runId || runIdentity.idPrefix!,
            ) as { timestamp: number; id: string } | undefined

            if (
                oldestRunRow
                && (
                    oldestRunRow.timestamp !== boundary.timestamp
                    || oldestRunRow.id !== boundary.id
                )
            ) {
                pageRowsDescending = db.prepare(
                    `SELECT ${MESSAGE_SELECT_COLUMNS} FROM gc_messages
                     WHERE roomId = ?${cursorPredicate}
                       AND (timestamp > ? OR (timestamp = ? AND id >= ?))
                     ORDER BY timestamp DESC, id DESC`,
                ).all(
                    ...params,
                    oldestRunRow.timestamp,
                    oldestRunRow.timestamp,
                    oldestRunRow.id,
                ) as any[]
            }
        }

        const oldestPageRow = pageRowsDescending.at(-1)
        const hasMore = Boolean(oldestPageRow && db.prepare(
            `SELECT 1 FROM gc_messages
             WHERE roomId = ?
               AND (timestamp < ? OR (timestamp = ? AND id < ?))
             LIMIT 1`,
        ).get(roomId, oldestPageRow.timestamp, oldestPageRow.timestamp, oldestPageRow.id))
        const pageRows = pageRowsDescending.reverse()
        const agentCache = new Map<string, RoomAgent | null>()
        const roomCache = new Map<string, RoomInfo | undefined>()
        const messages = this.compactMessageAgentMetadata(
            pageRows.map(row => this.mapStoredMessageRow(row, agentCache, roomCache)),
        ).map(buildOutboundGroupMessage)
        return { messages, hasMore, cursorFound }
    }

    getMessagesForContext(roomId: string, cutoff?: GroupMessageCursorCutoff): ChatMessage[] {
        const rows = this.getRecentMessageRows(roomId, GROUP_CHAT_CONTEXT_MESSAGE_WINDOW, {
            excludeWorkspaceDiff: true,
            throughMessageId: cutoff?.throughMessageId,
        })
        const agentCache = new Map<string, RoomAgent | null>()
        const roomCache = new Map<string, RoomInfo | undefined>()
        return sliceGroupMessagesCanonical(
            rows.map(row => this.mapStoredMessageRow(row, agentCache, roomCache)),
            cutoff,
        ).messages
    }

    getMessagesForSummaryBatch(
        roomId: string,
        options: { afterMessageId?: string; throughMessageId?: string; limit: number },
    ): ChatMessage[] {
        const db = this.db()
        const limit = Math.min(1_000, Math.max(1, Math.floor(options.limit)))
        if (!db) return []
        // Keep this set aligned with ECMAScript String.trim() so rows that the
        // cleaner considers empty cannot consume the fail-closed scan limit.
        const trimWhitespace = [
            9, 10, 11, 12, 13, 32, 160, 5760,
            8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202,
            8232, 8233, 8239, 8287, 12288, 65279,
        ].map(codePoint => `CHAR(${codePoint})`).join(' || ')
        const trimmedContent = `LTRIM(content, ${trimWhitespace})`
        const firstCloseBracket = `INSTR(${trimmedContent}, ']')`
        const serializedTraceBody = `LTRIM(SUBSTR(${trimmedContent}, ${firstCloseBracket} + 2), ${trimWhitespace})`
        const hasSerializedMarker = (value: string, marker: string) => {
            const markerLength = marker.length
            const nextCharacter = `SUBSTR(${value}, ${markerLength + 1}, 1)`
            return `(${value} LIKE '${marker}%'
                AND (${nextCharacter} = '' OR ${nextCharacter} NOT GLOB '[A-Za-z0-9_]'))`
        }
        const bodyCallingTool = hasSerializedMarker(serializedTraceBody, '[Calling tool')
        const bodyToolResult = hasSerializedMarker(serializedTraceBody, '[Tool result')
        const directCallingTool = hasSerializedMarker(trimmedContent, '[Calling tool')
        const directToolResult = hasSerializedMarker(trimmedContent, '[Tool result')
        const serializedToolTrace = `(
            (${firstCloseBracket} > 1
                AND SUBSTR(${trimmedContent}, 1, 1) = '['
                AND SUBSTR(${trimmedContent}, ${firstCloseBracket} + 1, 1) = ':'
                AND (${bodyCallingTool} OR ${bodyToolResult}))
            OR ${directCallingTool}
            OR ${directToolResult}
        )`
        const where = [
            'roomId = ?',
            "role IN ('user', 'assistant')",
            `TRIM(content, ${trimWhitespace}) <> ''`,
            "COALESCE(tool_name, '') = ''",
            "COALESCE(tool_call_id, '') = ''",
            "COALESCE(tool_calls, '[]') IN ('', '[]')",
            "COALESCE(finish_reason, '') NOT IN ('tool_calls', 'streaming')",
            `NOT ${serializedToolTrace}`,
        ]
        const params: Array<string | number> = [roomId]
        const after = options.afterMessageId
            ? db.prepare('SELECT timestamp FROM gc_messages WHERE roomId = ? AND id = ?')
                .get(roomId, options.afterMessageId) as { timestamp: number } | undefined
            : undefined
        if (after) {
            where.push('timestamp >= ?')
            params.push(after.timestamp)
        }
        const through = options.throughMessageId
            ? db.prepare('SELECT timestamp FROM gc_messages WHERE roomId = ? AND id = ?')
                .get(roomId, options.throughMessageId) as { timestamp: number } | undefined
            : undefined
        if (through) {
            where.push('timestamp <= ?')
            params.push(through.timestamp)
        }
        const rows = db.prepare(
            `SELECT ${MESSAGE_SELECT_COLUMNS} FROM gc_messages
             WHERE ${where.join(' AND ')}
             ORDER BY timestamp ASC, id ASC
             LIMIT ?`
        ).all(...params, GROUP_CHAT_SUMMARY_SCAN_LIMIT + 1) as any[]
        if (rows.length > GROUP_CHAT_SUMMARY_SCAN_LIMIT) {
            throw new Error(`Group summary scan exceeded ${GROUP_CHAT_SUMMARY_SCAN_LIMIT} eligible messages`)
        }
        const agentCache = new Map<string, RoomAgent | null>()
        const roomCache = new Map<string, RoomInfo | undefined>()
        const sliced = sliceGroupMessagesCanonical(
            rows.map(row => this.mapStoredMessageRow(row, agentCache, roomCache)),
            { afterMessageId: options.afterMessageId, throughMessageId: options.throughMessageId },
        )
        if (options.afterMessageId && !sliced.afterMessageFound) return []
        if (options.throughMessageId && !sliced.throughMessageFound) return []
        return sliced.messages.slice(0, limit)
    }

    getMessageCount(roomId: string): number {
        const row = this.db()?.prepare(
            'SELECT COUNT(*) as total FROM gc_messages WHERE roomId = ?'
        ).get(roomId) as { total: number } | undefined
        return row?.total || 0
    }

    getMessage(messageId: string): ChatMessage | null {
        const row = this.db()?.prepare(
            `SELECT ${MESSAGE_SELECT_COLUMNS} FROM gc_messages WHERE id = ?`
        ).get(messageId) as any
        if (!row) return null
        return this.mapStoredMessageRow(row)
    }

    addMessage(msg: ChatMessage): void {
        this.upsertMessage(msg)
    }

    upsertMessage(msg: ChatMessage, existing?: ChatMessage | null): ChatMessage {
        const storedMessage = this.snapshotMessageSender(msg, existing ?? this.getMessage(msg.id))
        const toolCallsJson = storedMessage.tool_calls ? JSON.stringify(storedMessage.tool_calls) : null
        const mentionsJson = JSON.stringify(storedMessage.mentions || [])
        const persistedContent = messageContentForStorage(storedMessage.role, storedMessage.content)
        const persistedAt = storedMessage.persistedAt ?? Date.now()
        this.db()?.prepare(
            `INSERT INTO gc_messages (
                id, roomId, senderId, senderName, senderType, senderAgentRecordId,
                content, timestamp, persistedAt, mentions, run_id, role, tool_call_id,
                tool_calls, tool_name, finish_reason, reasoning, reasoning_details, reasoning_content
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            + ` ON CONFLICT(id) DO UPDATE SET
                roomId = excluded.roomId,
                senderId = excluded.senderId,
                senderName = excluded.senderName,
                senderType = excluded.senderType,
                senderAgentRecordId = excluded.senderAgentRecordId,
                content = excluded.content,
                timestamp = excluded.timestamp,
                persistedAt = excluded.persistedAt,
                mentions = excluded.mentions,
                run_id = excluded.run_id,
                role = excluded.role,
                tool_call_id = excluded.tool_call_id,
                tool_calls = excluded.tool_calls,
                tool_name = excluded.tool_name,
                finish_reason = excluded.finish_reason,
                reasoning = excluded.reasoning,
                reasoning_details = excluded.reasoning_details,
                reasoning_content = excluded.reasoning_content`
        ).run(
            storedMessage.id,
            storedMessage.roomId,
            storedMessage.senderId,
            storedMessage.senderName,
            storedMessage.senderType || 'member',
            storedMessage.senderAgentRecordId || '',
            persistedContent,
            storedMessage.timestamp,
            persistedAt,
            mentionsJson,
            storedMessage.run_id ?? null,
            storedMessage.role || 'user',
            storedMessage.tool_call_id ?? null,
            toolCallsJson,
            storedMessage.tool_name ?? null,
            storedMessage.finish_reason ?? null,
            storedMessage.reasoning ?? null,
            storedMessage.reasoning_details ?? null,
            storedMessage.reasoning_content ?? null,
        )
        const persistedMessage = this.mapStoredMessageRow({
            ...storedMessage,
            content: persistedContent,
            persistedAt,
            mentions: mentionsJson,
            tool_calls: toolCallsJson,
        })
        // The storage column is historically NOT NULL and stores absent
        // metadata as "[]". Preserve the caller-visible three-state protocol
        // for the live routing path even though the on-disk representation is
        // legacy-compatible.
        if (storedMessage.mentions === undefined) persistedMessage.mentions = undefined
        return persistedMessage
    }

    saveWorkspaceDiffMessageForRun(args: SaveWorkspaceDiffMessageArgs): { message: ChatMessage; totalTokens: number; change: WorkspaceRunChangeSummary } | null {
        const db = this.db()
        if (!db) return null
        const idPrefix = 'gcmsg_workspace_diff_'
        const runIdPart = args.runId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(-64) || 'run'
        const roomIdBudget = Math.max(24, 180 - idPrefix.length - runIdPart.length - 1)
        const roomIdPart = args.roomId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, roomIdBudget) || 'room'
        const messageId = `${idPrefix}${roomIdPart}_${runIdPart}`
        db.exec('BEGIN IMMEDIATE')
        try {
            const roomExists = db.prepare('SELECT 1 FROM gc_rooms WHERE id = ?').get(args.roomId)
            if (!roomExists) {
                db.exec('ROLLBACK')
                return null
            }
            this.ensureCurrentRoomTokenAccounting(args.roomId)
            const workspaceLabel = basename(args.workspace) || 'workspace'
            const redactedDraft: SaveWorkspaceRunChangeInput = {
                ...args.draft,
                room_id: args.roomId,
                message_id: messageId,
                assistant_message_id: args.parentMessageId || '',
                workspace: workspaceLabel,
            }
            const change = insertWorkspaceRunChange(db, redactedDraft)
            if (!change) {
                db.exec('ROLLBACK')
                return null
            }
            const files = change.files.map((file) => {
                const draftFile = redactedDraft.files.find(candidate => candidate.path === file.path && candidate.change_type === file.change_type)
                return {
                    id: file.id,
                    path: file.path,
                    change_type: file.change_type,
                    additions: file.additions,
                    deletions: file.deletions,
                    patch: draftFile?.patch || null,
                    binary: file.binary,
                    truncated: file.truncated,
                }
            })
            const payload = {
                kind: 'workspace_diff',
                version: 1,
                room_id: args.roomId,
                session_id: args.sessionId,
                run_id: args.runId,
                status: args.status,
                change_id: change.change_id,
                workspace_basename: workspaceLabel,
                files_changed: change.files_changed,
                additions: change.additions,
                deletions: change.deletions,
                truncated: change.truncated,
                files,
                ...(args.parentMessageId ? { parent_message_id: args.parentMessageId } : {}),
            }
            const message: ChatMessage = {
                id: messageId,
                roomId: args.roomId,
                senderId: args.senderId,
                senderName: args.senderName,
                content: JSON.stringify(payload),
                timestamp: Date.now(),
                run_id: args.responseRunId || null,
                role: 'tool',
                tool_call_id: `workspace_diff:${args.runId}`,
                tool_calls: null,
                tool_name: 'workspace_diff',
            }
            const storedMessage = this.upsertMessage(message)
            // workspace_diff messages are deliberately excluded from the shared
            // context window, so they cannot change its token total.
            const totalTokens = Number(this.getRoom(args.roomId)?.totalTokens || 0)
            db.exec('COMMIT')
            return { message: storedMessage, totalTokens, change }
        } catch (err) {
            try { db.exec('ROLLBACK') } catch { /* ignore */ }
            throw err
        }
    }

    private contextWindowMessageIdsForTokenDelta(roomId: string): string[] {
        const db = this.db()
        if (!db) return []
        const boundary = db.prepare(
            `SELECT timestamp FROM gc_messages
             WHERE roomId = ? AND COALESCE(tool_name, '') NOT IN ('workspace_diff', 'task_plan')
             ORDER BY timestamp DESC, id DESC
             LIMIT 1 OFFSET ?`,
        ).get(roomId, GROUP_CHAT_CONTEXT_MESSAGE_WINDOW - 1) as { timestamp: number } | undefined
        const rows = db.prepare(
            `SELECT id FROM gc_messages
             WHERE roomId = ? AND COALESCE(tool_name, '') NOT IN ('workspace_diff', 'task_plan')${boundary ? ' AND timestamp >= ?' : ''}
             ORDER BY timestamp DESC, id DESC
             LIMIT ?`,
        ).all(
            roomId,
            ...(boundary ? [boundary.timestamp] : []),
            GROUP_CHAT_CONTEXT_MESSAGE_WINDOW + GROUP_CHAT_TIMESTAMP_BOUNDARY_OVERFLOW,
        ) as Array<{ id: string }>
        return rows.map(row => String(row.id))
    }

    private ensureCurrentRoomTokenAccounting(roomId: string): void {
        const db = this.db()
        if (!db) return
        const room = db.prepare(
            'SELECT tokenAccountingVersion FROM gc_rooms WHERE id = ?',
        ).get(roomId) as { tokenAccountingVersion: number } | undefined
        if (!room || Number(room.tokenAccountingVersion) >= GROUP_CHAT_TOKEN_ACCOUNTING_VERSION) return

        const totalTokens = this.contextWindowMessageIdsForTokenDelta(roomId)
            .reduce((total, id) => {
                const message = this.getMessage(id)
                return total + (message ? this.messageUsageTokens(message) : 0)
            }, 0)
        db.prepare(
            'UPDATE gc_rooms SET totalTokens = ?, tokenAccountingVersion = ? WHERE id = ?',
        ).run(totalTokens, GROUP_CHAT_TOKEN_ACCOUNTING_VERSION, roomId)
    }

    private incrementalRoomTotalTokens(
        roomId: string,
        changedMessageId: string,
        existing: ChatMessage | null,
        storedMessage: ChatMessage,
        previousIds: string[],
        nextIds: string[],
    ): number {
        const previous = new Set(previousIds)
        const next = new Set(nextIds)
        let total = Number(this.getRoom(roomId)?.totalTokens || 0)
        for (const id of previous) {
            if (next.has(id) && id !== changedMessageId) continue
            const message = id === changedMessageId ? existing : this.getMessage(id)
            if (message) total -= this.messageUsageTokens(message)
        }
        for (const id of next) {
            if (previous.has(id) && id !== changedMessageId) continue
            const message = id === changedMessageId ? storedMessage : this.getMessage(id)
            if (message) total += this.messageUsageTokens(message)
        }
        return Math.max(0, total)
    }

    saveMessageAndRefreshRoom(msg: ChatMessage, options: { preserveExistingTimestamp?: boolean } = {}): { message: ChatMessage; totalTokens: number } {
        const db = this.db()
        if (!db) return { message: msg, totalTokens: 0 }
        db.exec('SAVEPOINT group_message_save')
        try {
            const existing = this.getMessage(msg.id)
            if (msg.tool_name === 'task_plan' || existing?.tool_name === 'task_plan') {
                const plan = msg.role === 'tool' ? parseGroupTaskPlan(msg.content) : null
                if (!plan || msg.run_id !== plan.run_id) throw new Error('Invalid group task plan')
                if (existing) {
                    const previous = parseGroupTaskPlan(existing.content)
                    if (existing.roomId !== msg.roomId || existing.senderId !== msg.senderId || !previous
                        || previous.session_id !== plan.session_id || previous.plan_id !== plan.plan_id || previous.run_id !== plan.run_id) {
                        throw new Error('Group task plan identity mismatch')
                    }
                    if (previous.revision >= plan.revision) {
                        const totalTokens = Number(this.getRoom(existing.roomId)?.totalTokens || 0)
                        db.exec('RELEASE group_message_save')
                        return { message: existing, totalTokens }
                    }
                    msg = { ...msg, timestamp: existing.timestamp }
                }
            }
            if (existing?.tool_name === 'workspace_diff') {
                this.ensureCurrentRoomTokenAccounting(existing.roomId)
                const totalTokens = Number(this.getRoom(existing.roomId)?.totalTokens || 0)
                db.exec('RELEASE group_message_save')
                return { message: existing, totalTokens }
            }
            const movedFromRoomId = existing && existing.roomId !== msg.roomId ? existing.roomId : null
            this.ensureCurrentRoomTokenAccounting(msg.roomId)
            if (movedFromRoomId) this.ensureCurrentRoomTokenAccounting(movedFromRoomId)
            const previousSourceIds = movedFromRoomId
                ? this.contextWindowMessageIdsForTokenDelta(movedFromRoomId)
                : null
            const previousIds = this.contextWindowMessageIdsForTokenDelta(msg.roomId)
            const safeMsg = msg.tool_name === 'workspace_diff'
                ? { ...msg, role: 'user', tool_call_id: null, tool_calls: null, tool_name: null }
                : msg
            const message = existing && options.preserveExistingTimestamp ? { ...safeMsg, timestamp: existing.timestamp } : safeMsg
            const storedMessage = this.upsertMessage(message, existing)
            const nextIds = this.contextWindowMessageIdsForTokenDelta(msg.roomId)
            const totalTokens = this.incrementalRoomTotalTokens(
                msg.roomId,
                storedMessage.id,
                existing,
                storedMessage,
                previousIds,
                nextIds,
            )
            this.updateRoomTotalTokens(msg.roomId, totalTokens)
            if (movedFromRoomId && previousSourceIds) {
                const nextSourceIds = this.contextWindowMessageIdsForTokenDelta(movedFromRoomId)
                const sourceTotalTokens = this.incrementalRoomTotalTokens(
                    movedFromRoomId,
                    storedMessage.id,
                    existing,
                    storedMessage,
                    previousSourceIds,
                    nextSourceIds,
                )
                this.updateRoomTotalTokens(movedFromRoomId, sourceTotalTokens)
            }
            db.exec('RELEASE group_message_save')
            return { message: storedMessage, totalTokens }
        } catch (err) {
            try { db.exec('ROLLBACK TO group_message_save'); db.exec('RELEASE group_message_save') } catch { /* ignore */ }
            throw err
        }
    }

    private deleteWorkspaceDiffChanges(roomId: string): void {
        const db = this.db()
        if (!db) return
        deleteWorkspaceRunChangesForRoom(db, roomId)
    }

    private withImmediateTransaction<T>(db: any, fn: () => T): T {
        if (db.inTransaction || db.isTransaction) {
            return fn()
        }
        db.exec('BEGIN IMMEDIATE')
        try {
            const result = fn()
            db.exec('COMMIT')
            return result
        } catch (err) {
            try { db.exec('ROLLBACK') } catch { /* ignore */ }
            throw err
        }
    }

    clearRoomContext(roomId: string): void {
        const db = this.db()
        if (!db) return
        this.withImmediateTransaction(db, () => {
            this.deleteWorkspaceDiffChanges(roomId)
            db.prepare(
                `UPDATE gc_agent_connectors
                 SET status = 'revoked', revokedAt = ?, lastSeenAt = ?
                 WHERE roomId = ? AND status != 'revoked'`,
            ).run(Date.now(), Date.now(), roomId)
            db.prepare('DELETE FROM gc_agent_pairing_requests WHERE roomId = ?').run(roomId)
            db.prepare(
                'DELETE FROM gc_handoff_deliveries WHERE attemptId IN (SELECT attemptId FROM gc_handoff_attempts WHERE roomId = ?)',
            ).run(roomId)
            db.prepare(
                'DELETE FROM gc_handoff_inbox WHERE attemptId IN (SELECT attemptId FROM gc_handoff_attempts WHERE roomId = ?)',
            ).run(roomId)
            db.prepare('DELETE FROM gc_handoff_outbox WHERE roomId = ?').run(roomId)
            db.prepare('DELETE FROM gc_handoff_attempts WHERE roomId = ?').run(roomId)
            db.prepare('DELETE FROM gc_handoff_chains WHERE roomId = ?').run(roomId)
            db.prepare('DELETE FROM gc_execution_queue WHERE roomId = ?').run(roomId)
            db.prepare('DELETE FROM gc_messages WHERE roomId = ?').run(roomId)
            db.prepare('DELETE FROM gc_room_agents WHERE roomId = ? AND removedAt > 0').run(roomId)
            db.prepare('DELETE FROM gc_context_snapshots WHERE roomId = ?').run(roomId)
            db.prepare('DELETE FROM gc_room_summaries WHERE roomId = ?').run(roomId)
            db.prepare('UPDATE gc_rooms SET totalTokens = 0, sessionSeed = ?, summaryGeneration = summaryGeneration + 1 WHERE id = ?').run(`${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, roomId)
        })
    }

    enqueueExecutionQueueItem(input: {
        roomId: string
        messageId: string
        targetAgentId: string
        targetAgentName: string
        requesterMemberId: string
        cancelCapabilityHash: string
        textSummary: string
    }): StoredGroupExecutionQueueItem {
        const db = this.db()
        if (!db) throw new Error('Database unavailable')
        return this.withImmediateTransaction(db, () => {
            const existing = db.prepare(
                'SELECT * FROM gc_execution_queue WHERE messageId = ? AND targetAgentId = ?',
            ).get(input.messageId, input.targetAgentId) as StoredGroupExecutionQueueItem | undefined
            if (existing) return existing
            const sequenceRow = db.prepare(
                'SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM gc_execution_queue WHERE roomId = ?',
            ).get(input.roomId) as { sequence: number }
            const item: StoredGroupExecutionQueueItem = {
                id: randomUUID(),
                ...input,
                textSummary: input.textSummary.replace(/\s+/g, ' ').trim().slice(0, 160),
                sequence: Number(sequenceRow.sequence),
                status: 'queued',
                createdAt: Date.now(),
                startedAt: null,
                finishedAt: null,
                lastError: null,
            }
            db.prepare(
                `INSERT INTO gc_execution_queue (
                    id, roomId, messageId, targetAgentId, targetAgentName,
                    requesterMemberId, cancelCapabilityHash, textSummary, sequence, status,
                    createdAt, startedAt, finishedAt, lastError
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
            ).run(
                item.id,
                item.roomId,
                item.messageId,
                item.targetAgentId,
                item.targetAgentName,
                item.requesterMemberId,
                item.cancelCapabilityHash,
                item.textSummary,
                item.sequence,
                item.status,
                item.createdAt,
            )
            return item
        })
    }

    getExecutionQueueItem(id: string): StoredGroupExecutionQueueItem | null {
        const row = this.db()?.prepare('SELECT * FROM gc_execution_queue WHERE id = ?').get(id)
        return (row as unknown as StoredGroupExecutionQueueItem | undefined) || null
    }

    listQueuedExecutionItems(roomId: string): GroupExecutionQueueItem[] {
        const rows = (this.db()?.prepare(
            `SELECT ${EXECUTION_QUEUE_PUBLIC_COLUMNS} FROM gc_execution_queue
             WHERE roomId = ? AND status = 'queued'
             ORDER BY sequence ASC`,
        ).all(roomId) || []) as unknown as GroupExecutionQueueItem[]
        const agentPositions = new Map<string, number>()
        return rows.map((item) => {
            const position = (agentPositions.get(item.targetAgentId) || 0) + 1
            agentPositions.set(item.targetAgentId, position)
            return { ...item, position }
        })
    }

    startExecutionQueueItem(id: string): boolean {
        const result = this.db()?.prepare(
            `UPDATE gc_execution_queue
             SET status = 'running', startedAt = ?, lastError = NULL
             WHERE id = ? AND status = 'queued'`,
        ).run(Date.now(), id)
        return Number(result?.changes || 0) === 1
    }

    finishExecutionQueueItem(id: string, status: 'completed' | 'failed', lastError?: string): void {
        this.db()?.prepare(
            `UPDATE gc_execution_queue
             SET status = ?, finishedAt = ?, lastError = ?
             WHERE id = ? AND status = 'running'`,
        ).run(status, Date.now(), status === 'failed' ? String(lastError || 'Execution failed') : null, id)
    }

    failExecutionQueueItem(id: string, lastError: string): void {
        this.db()?.prepare(
            `UPDATE gc_execution_queue
             SET status = 'failed', finishedAt = ?, lastError = ?
             WHERE id = ? AND status IN ('queued', 'running')`,
        ).run(Date.now(), String(lastError || 'Execution failed'), id)
    }

    retractQueuedMessage(
        roomId: string,
        queueId: string,
        requesterMemberId: string,
        cancelCapabilityHash: string,
        allowAuthenticatedAccountOwnership = false,
    ): RetractedQueuedMessage | null {
        const db = this.db()
        if (!db || !requesterMemberId || (!cancelCapabilityHash && !allowAuthenticatedAccountOwnership)) return null
        return this.withImmediateTransaction(db, () => {
            const selected = db.prepare(
                'SELECT * FROM gc_execution_queue WHERE id = ? AND roomId = ?',
            ).get(queueId, roomId) as StoredGroupExecutionQueueItem | undefined
            if (!selected) return null

            const message = this.getMessage(selected.messageId)
            const siblings = db.prepare(
                'SELECT * FROM gc_execution_queue WHERE roomId = ? AND messageId = ? ORDER BY sequence ASC',
            ).all(roomId, selected.messageId) as unknown as StoredGroupExecutionQueueItem[]
            if (!message
                || message.roomId !== roomId
                || message.role !== 'user'
                || message.senderId !== requesterMemberId
                || siblings.length === 0
                || siblings.some(item => (
                    item.status !== 'queued'
                    || item.requesterMemberId !== requesterMemberId
                    || (!allowAuthenticatedAccountOwnership
                        && !executionQueueCapabilityMatches(item.cancelCapabilityHash, cancelCapabilityHash))
                ))) {
                return null
            }

            this.ensureCurrentRoomTokenAccounting(roomId)
            const previousIds = this.contextWindowMessageIdsForTokenDelta(roomId)
            const cancelledAt = Date.now()
            const queueIds = siblings.map(item => item.id)
            const placeholders = queueIds.map(() => '?').join(', ')
            const cancelled = db.prepare(
                `UPDATE gc_execution_queue
                 SET status = 'cancelled', finishedAt = ?, lastError = NULL
                 WHERE id IN (${placeholders}) AND status = 'queued'`,
            ).run(cancelledAt, ...queueIds)
            if (Number(cancelled.changes || 0) !== queueIds.length) {
                throw new Error('Queued work changed during retraction')
            }

            const deleted = db.prepare(
                `DELETE FROM gc_messages
                 WHERE id = ? AND roomId = ? AND senderId = ? AND role = 'user'`,
            ).run(selected.messageId, roomId, requesterMemberId)
            if (Number(deleted.changes || 0) !== 1) {
                throw new Error('Queued message changed during retraction')
            }

            const nextIds = this.contextWindowMessageIdsForTokenDelta(roomId)
            const totalTokens = this.incrementalRoomTotalTokens(
                roomId,
                selected.messageId,
                message,
                message,
                previousIds,
                nextIds,
            )
            db.prepare(
                `UPDATE gc_rooms
                 SET totalTokens = ?, summaryGeneration = summaryGeneration + 1
                 WHERE id = ?`,
            ).run(totalTokens, roomId)
            db.prepare('DELETE FROM gc_room_summaries WHERE roomId = ?').run(roomId)

            return {
                messageId: selected.messageId,
                queueIds,
                messageCount: this.getMessageCount(roomId),
                totalTokens,
                lastActiveAt: this.getRoomActivityAt(roomId),
            }
        })
    }

    // ─── Room Agents ──────────────────────────────────────────

    getRoomAgents(roomId: string): RoomAgent[] {
        return (this.db()?.prepare(
            `SELECT ${ROOM_AGENT_SELECT_COLUMNS} FROM gc_room_agents WHERE roomId = ? AND removedAt = 0`
        ).all(roomId) || []) as unknown as RoomAgent[]
    }

    getMentionableRoomAgents(roomId: string): RoomAgent[] {
        const agents = this.getRoomAgents(roomId)
        if (!this.roomAgentOnlineProvider) return agents
        return agents.filter(agent => this.roomAgentOnlineProvider?.(roomId, agent.agentId) === true)
    }

    assertParticipantNameAvailable(
        roomId: string,
        name: string,
        options: { excludeAgentRef?: string; excludeMemberId?: string } = {},
    ): void {
        const canonicalName = canonicalParticipantName(name)
        if (!canonicalName) return

        const conflictingAgent = this.getRoomAgents(roomId).find(agent =>
            agent.id !== options.excludeAgentRef &&
            agent.agentId !== options.excludeAgentRef &&
            canonicalParticipantName(agent.name) === canonicalName
        )
        if (conflictingAgent) throw new RoomParticipantNameConflictError()

        const conflictingMember = this.getRoomMembers(roomId).find(member =>
            member.id !== options.excludeMemberId &&
            canonicalParticipantName(member.name) === canonicalName
        )
        if (conflictingMember) throw new RoomParticipantNameConflictError()
    }

    addRoomAgent(
        roomId: string,
        agentId: string,
        profile: string,
        name: string,
        description: string,
        invited: number,
        metadata: RoomAgentMetadata = {},
    ): RoomAgent {
        this.assertParticipantNameAvailable(roomId, name)
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
        const agent = metadata.agent || 'hermes'
        const agentMode = metadata.agentMode === 'global' ? 'global' : 'scoped'
        const provider = agentMode === 'global' ? '' : String(metadata.provider || '').trim()
        const model = agentMode === 'global' ? '' : String(metadata.model || '').trim()
        const apiMode = agent === 'hermes' || agentMode === 'global' ? '' : String(metadata.apiMode || '').trim()
        const reasoningEffort = agentMode === 'global' ? '' : String(metadata.reasoningEffort || '').trim()
        const agentPreset = typeof metadata.agentPreset === 'string' ? metadata.agentPreset.trim() : ''
        const avatar = String(metadata.avatar || '').trim()
        const executorType = metadata.executorType === 'remote' ? 'remote' : 'server'
        const ownerMemberId = String(metadata.ownerMemberId || '').trim()
        const connectorId = String(metadata.connectorId || '').trim()
        const remoteOrigin = String(metadata.remoteOrigin || '').trim()
        this.db()?.prepare(
            `INSERT INTO gc_room_agents (
                id, roomId, agentId, agent, agentMode, profile, provider, model, apiMode,
                reasoningEffort, agentPreset, name, description, avatar, invited,
                executorType, ownerMemberId, connectorId, remoteOrigin
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
            id, roomId, agentId, agent, agentMode, profile, provider, model, apiMode,
            reasoningEffort, agentPreset, name, description, avatar, invited,
            executorType, ownerMemberId, connectorId, remoteOrigin,
        )
        return {
            id, roomId, agentId, agent, agentMode, profile, provider, model, apiMode,
            reasoningEffort, agentPreset, name, description, avatar, invited,
            executorType, ownerMemberId, connectorId, remoteOrigin,
        }
    }

    getRoomAgent(roomId: string, agentRef: string): RoomAgent | null {
        return (this.db()?.prepare(
            `SELECT ${ROOM_AGENT_SELECT_COLUMNS}
             FROM gc_room_agents
             WHERE roomId = ? AND removedAt = 0 AND (id = ? OR agentId = ?)`
        ).get(roomId, agentRef, agentRef) as any) ?? null
    }

    getRoomAgentByAgentId(roomId: string, agentId: string): RoomAgent | null {
        return (this.db()?.prepare(
            `SELECT ${ROOM_AGENT_SELECT_COLUMNS}
             FROM gc_room_agents
             WHERE roomId = ? AND removedAt = 0 AND agentId = ?`
        ).get(roomId, agentId) as any) ?? null
    }

    getHandoffTargetSnapshot(roomId: string, agentId: string): Record<string, string> | null {
        const target = this.getRoomAgentByAgentId(roomId, agentId)
        if (!target) return null
        return {
            id: String(target.id || ''),
            agentId: String(target.agentId || ''),
            agent: String(target.agent || ''),
            agentMode: String(target.agentMode || 'scoped'),
            profile: String(target.profile || ''),
            provider: String(target.provider || ''),
            model: String(target.model || ''),
            apiMode: String(target.apiMode || ''),
            reasoningEffort: String(target.reasoningEffort || ''),
            agentPreset: String(target.agentPreset || ''),
            name: String(target.name || ''),
            description: String(target.description || ''),
            executorType: String(target.executorType || ''),
            ownerMemberId: String(target.ownerMemberId || ''),
            connectorId: String(target.connectorId || ''),
            remoteOrigin: String(target.remoteOrigin || ''),
        }
    }

    updateRoomAgent(
        roomId: string,
        agentRef: string,
        profile: string,
        name: string,
        description: string,
        metadata: RoomAgentMetadata = {},
    ): RoomAgent | null {
        const existing = this.getRoomAgent(roomId, agentRef)
        if (!existing) return null
        this.assertParticipantNameAvailable(roomId, name, { excludeAgentRef: existing.id })
        const agent = metadata.agent || 'hermes'
        const agentMode = metadata.agentMode === 'global' ? 'global' : 'scoped'
        const provider = agentMode === 'global' ? '' : String(metadata.provider || '').trim()
        const model = agentMode === 'global' ? '' : String(metadata.model || '').trim()
        const apiMode = agent === 'hermes' || agentMode === 'global' ? '' : String(metadata.apiMode || '').trim()
        const reasoningEffort = agentMode === 'global' ? '' : String(metadata.reasoningEffort || '').trim()
        const agentPreset = typeof metadata.agentPreset === 'string' ? metadata.agentPreset.trim() : ''
        const avatar = String(metadata.avatar || '').trim()
        this.db()?.prepare(
            `UPDATE gc_room_agents
             SET agent = ?, agentMode = ?, profile = ?, provider = ?, model = ?, apiMode = ?, reasoningEffort = ?, agentPreset = ?, name = ?, description = ?, avatar = ?
             WHERE roomId = ? AND removedAt = 0 AND (id = ? OR agentId = ?)`
        ).run(agent, agentMode, profile, provider, model, apiMode, reasoningEffort, agentPreset, name, description, avatar, roomId, agentRef, agentRef)
        return this.getRoomAgent(roomId, agentRef)
    }

    updateRoomAgentRelayMetadata(
        roomId: string,
        agentRef: string,
        metadata: { connectorId: string; remoteOrigin: string },
    ): RoomAgent | null {
        this.db()?.prepare(
            `UPDATE gc_room_agents
             SET executorType = 'remote', connectorId = ?, remoteOrigin = ?
             WHERE roomId = ? AND removedAt = 0 AND (id = ? OR agentId = ?)`,
        ).run(metadata.connectorId, metadata.remoteOrigin, roomId, agentRef, agentRef)
        return this.getRoomAgent(roomId, agentRef)
    }

    removeRoomAgent(roomId: string, agentRef: string): void {
        const db = this.db()
        if (!db) return
        const agent = this.getRoomAgent(roomId, agentRef)
        if (!agent) return
        this.removeRoomMembersForAgent(roomId, agent)
        db.prepare(
            `UPDATE gc_messages
             SET senderType = 'agent', senderAgentRecordId = ?
             WHERE roomId = ?
               AND COALESCE(senderAgentRecordId, '') = ''
               AND (
                    senderId = ?
                    OR senderId = ?
                    OR (senderName = ? AND role IN ('assistant', 'tool'))
               )`
        ).run(agent.id, roomId, agent.id, agent.agentId, agent.name)
        db.prepare(
            `UPDATE gc_room_agents
             SET removedAt = ?, connectorId = '', remoteOrigin = ''
             WHERE roomId = ? AND removedAt = 0 AND id = ?`
        ).run(Date.now(), roomId, agent.id)
    }

    // ─── Rolling Room Summary ───────────────────────────────

    getRoomSummary(roomId: string): GroupRoomSummary | null {
        return (this.db()?.prepare(
            `SELECT roomId, summary, summaryThroughMessageId, summaryThroughMessageTimestamp,
                    summarizedTurnCount, status, version, updatedAt, lastError
             FROM gc_room_summaries WHERE roomId = ?`
        ).get(roomId) as any) ?? null
    }

    getRoomSummaryDrainThroughMessageId(roomId: string): string {
        return String((this.db()?.prepare(
            'SELECT summaryDrainThroughMessageId FROM gc_room_summaries WHERE roomId = ?',
        ).get(roomId) as { summaryDrainThroughMessageId?: string } | undefined)?.summaryDrainThroughMessageId || '')
    }

    saveRoomSummary(summary: GroupRoomSummary): void {
        this.db()?.prepare(
            `INSERT INTO gc_room_summaries (
                roomId, summary, summaryThroughMessageId, summaryThroughMessageTimestamp,
                summarizedTurnCount, status, version, updatedAt, lastError,
                summaryRunToken, summaryLeaseExpiresAt, summaryRunGeneration, summaryDrainThroughMessageId
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', 0, 0, '')
             ON CONFLICT(roomId) DO UPDATE SET
                summary = excluded.summary,
                summaryThroughMessageId = excluded.summaryThroughMessageId,
                summaryThroughMessageTimestamp = excluded.summaryThroughMessageTimestamp,
                summarizedTurnCount = excluded.summarizedTurnCount,
                status = excluded.status,
                version = excluded.version,
                updatedAt = excluded.updatedAt,
                lastError = excluded.lastError,
                summaryRunToken = '',
                summaryLeaseExpiresAt = 0,
                summaryRunGeneration = 0,
                summaryDrainThroughMessageId = ''`
        ).run(
            summary.roomId,
            summary.summary,
            summary.summaryThroughMessageId,
            summary.summaryThroughMessageTimestamp,
            summary.summarizedTurnCount,
            summary.status,
            summary.version,
            summary.updatedAt,
            summary.lastError,
        )
    }

    saveRoomSummaryIfCurrent(
        summary: GroupRoomSummary,
        expectedGeneration: number,
        expectedVersion: number,
        expectedAnchor: string,
    ): boolean {
        const generation = Math.max(0, Math.floor(Number(expectedGeneration) || 0))
        const version = Math.max(0, Math.floor(Number(expectedVersion) || 0))
        const anchor = String(expectedAnchor || '')
        const result = this.db()?.prepare(
            `INSERT INTO gc_room_summaries (
                roomId, summary, summaryThroughMessageId, summaryThroughMessageTimestamp,
                summarizedTurnCount, status, version, updatedAt, lastError,
                summaryRunToken, summaryLeaseExpiresAt, summaryRunGeneration, summaryDrainThroughMessageId
             )
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 0, 0, ''
             WHERE ? = 0 AND ? = '' AND EXISTS (
               SELECT 1 FROM gc_rooms r WHERE r.id = ? AND r.summaryGeneration = ?
             )
             ON CONFLICT(roomId) DO UPDATE SET
                summary = excluded.summary,
                summaryThroughMessageId = excluded.summaryThroughMessageId,
                summaryThroughMessageTimestamp = excluded.summaryThroughMessageTimestamp,
                summarizedTurnCount = excluded.summarizedTurnCount,
                status = excluded.status,
                version = excluded.version,
                updatedAt = excluded.updatedAt,
                lastError = excluded.lastError,
                summaryRunToken = '',
                summaryLeaseExpiresAt = 0,
                summaryRunGeneration = 0,
                summaryDrainThroughMessageId = ''
             WHERE gc_room_summaries.version = ?
               AND gc_room_summaries.summaryThroughMessageId = ?
               AND EXISTS (
                 SELECT 1 FROM gc_rooms r WHERE r.id = ? AND r.summaryGeneration = ?
               )`
        ).run(
            summary.roomId, summary.summary, summary.summaryThroughMessageId,
            summary.summaryThroughMessageTimestamp, summary.summarizedTurnCount,
            summary.status, summary.version, summary.updatedAt, summary.lastError,
            version, anchor, summary.roomId, generation,
            version, anchor, summary.roomId, generation,
        )
        return Number(result?.changes || 0) === 1
    }

    claimRoomSummaryRun(
        roomId: string,
        expected: GroupRoomSummary,
        runToken: string,
        leaseExpiresAt: number,
        generation?: number,
        drainThroughMessageId: string = '',
    ): boolean {
        const db = this.db()
        if (!db) return false
        const persistedGeneration = Number((db.prepare(
            'SELECT summaryGeneration FROM gc_rooms WHERE id = ?',
        ).get(roomId) as { summaryGeneration?: number } | undefined)?.summaryGeneration || 0)
        const effectiveGeneration = generation === undefined
            ? persistedGeneration
            : Math.max(0, Math.floor(Number(generation) || 0))
        db.prepare(
            `INSERT INTO gc_room_summaries (
                roomId, summary, summaryThroughMessageId, summaryThroughMessageTimestamp,
                summarizedTurnCount, status, version, updatedAt, lastError,
                summaryRunToken, summaryLeaseExpiresAt, summaryRunGeneration, summaryDrainThroughMessageId
             )
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 0, 0, ''
             WHERE EXISTS (
               SELECT 1 FROM gc_rooms r WHERE r.id = ? AND r.summaryGeneration = ?
             )
             ON CONFLICT(roomId) DO NOTHING`
        ).run(
            expected.roomId,
            expected.summary,
            expected.summaryThroughMessageId,
            expected.summaryThroughMessageTimestamp,
            expected.summarizedTurnCount,
            expected.status,
            expected.version,
            expected.updatedAt,
            expected.lastError,
            roomId,
            effectiveGeneration,
        )
        const result = db.prepare(
            `UPDATE gc_room_summaries
             SET status = 'summarizing', updatedAt = ?, lastError = NULL,
                 summaryRunToken = ?, summaryLeaseExpiresAt = ?, summaryRunGeneration = ?,
                 summaryDrainThroughMessageId = CASE
                   WHEN summaryDrainThroughMessageId = '' THEN ? ELSE summaryDrainThroughMessageId END
             WHERE roomId = ? AND version = ? AND summaryThroughMessageId = ?
               AND status != 'summarizing' AND summaryRunToken = ''
               AND EXISTS (
                 SELECT 1 FROM gc_rooms r WHERE r.id = ? AND r.summaryGeneration = ?
               )`
        ).run(
            Date.now(), runToken, leaseExpiresAt, effectiveGeneration, drainThroughMessageId, roomId,
            expected.version, expected.summaryThroughMessageId, roomId, effectiveGeneration,
        )
        return Number(result.changes || 0) === 1
    }

    renewRoomSummaryRun(roomId: string, runToken: string, leaseExpiresAt: number): boolean {
        const result = this.db()?.prepare(
            `UPDATE gc_room_summaries
             SET summaryLeaseExpiresAt = ?
             WHERE roomId = ? AND summaryRunToken = ? AND status = 'summarizing'
               AND summaryRunGeneration = (
                 SELECT summaryGeneration FROM gc_rooms WHERE id = ?
               )`
        ).run(leaseExpiresAt, roomId, runToken, roomId)
        return Number(result?.changes || 0) === 1
    }

    commitRoomSummaryRun(
        roomId: string,
        runToken: string,
        summary: GroupRoomSummary,
        drainComplete: boolean = true,
    ): boolean {
        const result = this.db()?.prepare(
            `UPDATE gc_room_summaries
             SET summary = ?, summaryThroughMessageId = ?, summaryThroughMessageTimestamp = ?,
                 summarizedTurnCount = ?, status = ?, version = ?, updatedAt = ?, lastError = ?,
                 summaryRunToken = '', summaryLeaseExpiresAt = 0, summaryRunGeneration = 0,
                 summaryDrainThroughMessageId = CASE WHEN ? THEN '' ELSE summaryDrainThroughMessageId END
             WHERE roomId = ? AND summaryRunToken = ? AND status = 'summarizing'
               AND summaryRunGeneration = (
                 SELECT summaryGeneration FROM gc_rooms WHERE id = ?
               )`
        ).run(
            summary.summary,
            summary.summaryThroughMessageId,
            summary.summaryThroughMessageTimestamp,
            summary.summarizedTurnCount,
            summary.status,
            summary.version,
            summary.updatedAt,
            summary.lastError,
            drainComplete ? 1 : 0,
            roomId,
            runToken,
            roomId,
        )
        return Number(result?.changes || 0) === 1
    }

    invalidateRoomSummaryRun(roomId: string): void {
        this.db()?.prepare(
            `UPDATE gc_room_summaries
             SET summaryRunToken = '', summaryLeaseExpiresAt = 0, summaryRunGeneration = 0,
                 summaryDrainThroughMessageId = '',
                 status = CASE WHEN status = 'summarizing' THEN 'failed' ELSE status END,
                 lastError = CASE WHEN status = 'summarizing' THEN 'Summary run was invalidated' ELSE lastError END,
                 updatedAt = ?
             WHERE roomId = ? AND summaryRunToken != ''`
        ).run(Date.now(), roomId)
    }

    recoverExpiredRoomSummaryRun(roomId: string, now: number): boolean {
        const result = this.db()?.prepare(
            `UPDATE gc_room_summaries
             SET status = 'failed', lastError = 'Summary run was interrupted', updatedAt = ?,
                 summaryRunToken = '', summaryLeaseExpiresAt = 0, summaryRunGeneration = 0
             WHERE roomId = ? AND status = 'summarizing'
               AND (summaryRunToken = '' OR (summaryLeaseExpiresAt > 0 AND summaryLeaseExpiresAt <= ?))`
        ).run(now, roomId, now)
        return Number(result?.changes || 0) === 1
    }

    deleteRoom(roomId: string): void {
        const db = this.db()
        if (!db) return
        this.withImmediateTransaction(db, () => {
            this.deleteWorkspaceDiffChanges(roomId)
            db.prepare('DELETE FROM gc_execution_queue WHERE roomId = ?').run(roomId)
            db.prepare('DELETE FROM gc_messages WHERE roomId = ?').run(roomId)
            db.prepare('DELETE FROM gc_handoff_deliveries WHERE attemptId IN (SELECT attemptId FROM gc_handoff_attempts WHERE roomId = ?)').run(roomId)
            db.prepare('DELETE FROM gc_handoff_inbox WHERE attemptId IN (SELECT attemptId FROM gc_handoff_attempts WHERE roomId = ?)').run(roomId)
            db.prepare('DELETE FROM gc_handoff_outbox WHERE roomId = ?').run(roomId)
            db.prepare('DELETE FROM gc_handoff_attempts WHERE roomId = ?').run(roomId)
            db.prepare('DELETE FROM gc_handoff_chains WHERE roomId = ?').run(roomId)
            db.prepare('DELETE FROM gc_room_agents WHERE roomId = ?').run(roomId)
            db.prepare('DELETE FROM gc_room_members WHERE roomId = ?').run(roomId)
            db.prepare('DELETE FROM gc_context_snapshots WHERE roomId = ?').run(roomId)
            db.prepare('DELETE FROM gc_room_summaries WHERE roomId = ?').run(roomId)
            db.prepare('DELETE FROM gc_rooms WHERE id = ?').run(roomId)
        })
    }

    // ─── Room Members ──────────────────────────────────────

    getRoomMembers(roomId: string): { id: string; userId: string; name: string; description: string; joinedAt: number; avatar: string }[] {
        const members = (this.db()?.prepare(
            `SELECT m.id, m.userId, m.userName as name, m.description, m.joinedAt, m.avatar, m.authUserId
             FROM gc_room_members m
             WHERE m.roomId = ?
               AND NOT EXISTS (
                 SELECT 1 FROM gc_room_agents a
                 WHERE a.roomId = m.roomId
                   AND a.removedAt = 0
                   AND (a.agentId = m.userId OR (m.userId NOT GLOB '????????-????-????-????-????????????' AND COALESCE(m.description, '') = '' AND a.name = m.userName))
               )
             ORDER BY m.joinedAt`
        ).all(roomId) || []) as unknown as {
            id: string
            userId: string
            name: string
            description: string
            joinedAt: number
            avatar: string
            authUserId?: number | null
        }[]

        for (const member of members) {
            try {
                if (typeof member.authUserId === 'number' && member.authUserId > 0) {
                    member.avatar = getUserAvatar(member.authUserId) || member.avatar || ''
                }
            } catch {
                // ignore individual lookup failures
            }
        }
        return members.map(({ authUserId: _authUserId, ...member }) => member)
    }

    removeRoomMembersForAgent(roomId: string, agent: Pick<RoomAgent, 'agentId' | 'name'>): void {
        this.db()?.prepare(
            `DELETE FROM gc_room_members
             WHERE roomId = ?
               AND (userId = ? OR (userId NOT GLOB '????????-????-????-????-????????????' AND COALESCE(description, '') = '' AND userName = ?))`
        ).run(roomId, agent.agentId, agent.name)
    }

    removeRoomMember(roomId: string, userId: string): void {
        this.db()?.prepare(
            'DELETE FROM gc_room_members WHERE roomId = ? AND userId = ?'
        ).run(roomId, userId)
    }

    addRoomMember(roomId: string, userId: string, userName: string, description: string, avatar: string = '', authUserId?: number): void {
        const existing = this.getMemberByUserId(roomId, userId) ||
            (typeof authUserId === 'number' && authUserId > 0 ? this.getMemberByAuthUserId(roomId, authUserId) : null)
        this.assertParticipantNameAvailable(roomId, userName, { excludeMemberId: existing?.id })

        let resolvedAvatar = avatar
        if (!resolvedAvatar && typeof authUserId === 'number' && authUserId > 0) {
            try {
                resolvedAvatar = getUserAvatar(authUserId) || ''
            } catch {
                // ignore lookup failures
            }
        }
        if (existing) {
            const nextAvatar = resolvedAvatar || existing.avatar || ''
            const nextAuthUserId = typeof authUserId === 'number' && authUserId > 0
                ? authUserId
                : existing.authUserId ?? null
            // Update name/description/avatar on rejoin, refresh updatedAt
            this.db()?.prepare(
                'UPDATE gc_room_members SET userId = ?, userName = ?, description = ?, avatar = ?, authUserId = ?, updatedAt = ? WHERE id = ?'
            ).run(userId, userName, description, nextAvatar, nextAuthUserId, Date.now(), existing.id)
            return
        }
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
        const now = Date.now()
        this.db()?.prepare(
            'INSERT INTO gc_room_members (id, roomId, userId, userName, description, joinedAt, updatedAt, avatar, authUserId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(id, roomId, userId, userName, description, now, now, resolvedAvatar, authUserId ?? null)
    }

    getMemberByUserId(roomId: string, userId: string): Member | null {
        return (this.db()?.prepare(
            'SELECT id, userId, userName as name, description, joinedAt, avatar, authUserId FROM gc_room_members WHERE roomId = ? AND userId = ?'
        ).get(roomId, userId) as any) ?? null
    }

    getMemberByAuthUserId(roomId: string, authUserId: number): Member | null {
        return (this.db()?.prepare(
            'SELECT id, userId, userName as name, description, joinedAt, avatar, authUserId FROM gc_room_members WHERE roomId = ? AND authUserId = ? ORDER BY updatedAt DESC LIMIT 1'
        ).get(roomId, authUserId) as any) ?? null
    }

    updateMemberActivity(roomId: string, userId: string): void {
        this.db()?.prepare(
            'UPDATE gc_room_members SET updatedAt = ? WHERE roomId = ? AND userId = ?'
        ).run(Date.now(), roomId, userId)
    }
}

export async function drainPendingSessionDeletes(profileName: string): Promise<PendingSessionDeleteDrainResult> {
    const deleterResult = await drainGroupPrimaryAgentSessions(profileName)
    return {
        deleted: deleterResult.deleted,
        failed: deleterResult.failed.map((id: string) => ({ sessionId: id, error: 'unknown' })),
    }
}

// ─── ChatRoom (in-memory, for online members) ─────────────────

class ChatRoom {
    readonly id: string
    name: string
    readonly members = new Map<string, Member>()
    private readonly socketUsers = new Map<string, string>()

    constructor(id: string, name?: string) {
        this.id = id
        this.name = name || id
    }

    addOrUpdateMember(socketId: string, userId: string, name: string, description: string, source: 'human' | 'agent' = 'human', avatar: string = ''): Member {
        this.socketUsers.set(socketId, userId)
        const existing = this.members.get(userId)
        if (existing) {
            existing.name = name
            existing.description = description
            existing.online = true
            existing.socketId = socketId
            existing.source = source
            if (avatar) existing.avatar = avatar
            return existing
        }
        const member: Member = { id: socketId, userId, name, description, joinedAt: Date.now(), online: true, socketId, source, avatar }
        this.members.set(userId, member)
        return member
    }

    removeMember(socketId: string): void {
        const userId = this.socketUsers.get(socketId)
        if (!userId) return
        this.socketUsers.delete(socketId)
        const member = this.members.get(userId)
        if (!member) return
        const replacementSocketId = Array.from(this.socketUsers.entries()).find(([, mappedUserId]) => mappedUserId === userId)?.[0]
        member.online = Boolean(replacementSocketId)
        if (member.socketId === socketId && replacementSocketId) {
            member.socketId = replacementSocketId
        }
    }

    removeUser(userId: string): Member | null {
        const member = this.members.get(userId) || null
        if (member) {
            this.members.delete(userId)
            for (const [socketId, mappedUserId] of this.socketUsers) {
                if (mappedUserId === userId) this.socketUsers.delete(socketId)
            }
        }
        return member
    }

    getMembersList(): Member[] {
        return Array.from(this.members.values()).filter(member => member.source !== 'agent')
    }

    getOnlineMemberBySocketId(socketId: string): Member | undefined {
        const userId = this.socketUsers.get(socketId)
        if (!userId) return undefined
        const member = this.members.get(userId)
        return member?.online ? member : undefined
    }

    hasOnlineMember(socketId: string): boolean {
        return this.getOnlineMemberBySocketId(socketId) !== undefined
    }
}

// ─── GroupChat Server ────────────────────────────────────────

export class GroupChatServer {
    private io: Server
    private nsp: Namespace
    private storage: ChatStorage
    private rooms = new Map<string, ChatRoom>()
    /** Map: socket.id → persistent userId */
    private socketUserMap = new Map<string, string>()
    /** Map: userId → { name, description } (from auth) */
    private userInfoMap = new Map<string, { name: string; description: string }>()
    /** Map: socket.id → requested participant source from handshake */
    private socketRequestedSourceMap = new Map<string, 'human' | 'agent'>()
    /** Map: socket.id → numeric users.id from the web UI auth (for avatar resolution) */
    private socketAuthUserIdMap = new Map<string, number>()
    readonly agentClients = new AgentClients()
    private roomSummaryService: GroupRoomSummaryService
    private _restoreScheduled = false
    private handoffDispatcherTimer: ReturnType<typeof setInterval> | null = null
    private handoffDispatcherRunning = false
    private chatRunService: GroupChatRunService | null = null
    /** roomId -> (userId -> { userName, socketId, timer }) */
    private typingState = new Map<string, Map<string, { userName: string; socketId: string; timer: ReturnType<typeof setTimeout> }>>()
    /**
     * Transient activity restored to browsers when they join/reconnect.
     * Keep the runtime session id internally so a terminal event from the
     * just-finished ephemeral run can clear its own status without clearing a
     * newer run for the same Agent.
     */
    private contextStatusState = new Map<string, Map<string, {
        agentName: string
        status: string
        agentSessionId?: string
        runId?: string
    }>>()
    /** Stable room + persisted Agent row + run activity visible across authorized rooms. */
    private roomAgentActivityState = new Map<string, Map<string, GroupAgentActivity>>()
    /** room-scoped approval locator -> validated room and runtime session that requested it. */
    private pendingApprovalRoutes = new Map<string, PendingGroupApprovalRoute>()
    private pendingApprovalTimers = new Map<string, ReturnType<typeof setTimeout>>()
    /** room-scoped clarification locator -> validated room and runtime session that requested it. */
    private pendingClarifyRoutes = new Map<string, PendingGroupClarifyRoute>()
    private pendingClarifyTimers = new Map<string, ReturnType<typeof setTimeout>>()

    private pendingApprovalRouteKey(roomId: string, approvalId: string): string {
        return `${roomId}:${approvalId}`
    }

    private pendingClarifyRouteKey(roomId: string, clarifyId: string): string {
        return `${roomId}:${clarifyId}`
    }

    private takePendingApprovalRoute(routeKey: string): PendingGroupApprovalRoute | undefined {
        const route = this.pendingApprovalRoutes.get(routeKey)
        this.pendingApprovalRoutes.delete(routeKey)
        const timer = this.pendingApprovalTimers.get(routeKey)
        if (timer) clearTimeout(timer)
        this.pendingApprovalTimers.delete(routeKey)
        return route
    }

    private takePendingClarifyRoute(routeKey: string): PendingGroupClarifyRoute | undefined {
        const route = this.pendingClarifyRoutes.get(routeKey)
        this.pendingClarifyRoutes.delete(routeKey)
        const timer = this.pendingClarifyTimers.get(routeKey)
        if (timer) clearTimeout(timer)
        this.pendingClarifyTimers.delete(routeKey)
        return route
    }

    private schedulePendingApprovalExpiry(routeKey: string, route: PendingGroupApprovalRoute): void {
        const existing = this.pendingApprovalTimers.get(routeKey)
        if (existing) clearTimeout(existing)
        const timer = setTimeout(() => {
            if (this.pendingApprovalRoutes.get(routeKey) !== route) return
            this.expirePendingAgentInteractions(
                route.roomId,
                route.agentName,
                [route.approvalId],
                [],
                'Approval timed out',
            )
        }, route.timeoutMs + 1_000)
        timer.unref?.()
        this.pendingApprovalTimers.set(routeKey, timer)
    }

    private schedulePendingClarifyExpiry(routeKey: string, route: PendingGroupClarifyRoute): void {
        const existing = this.pendingClarifyTimers.get(routeKey)
        if (existing) clearTimeout(existing)
        const timer = setTimeout(() => {
            if (this.pendingClarifyRoutes.get(routeKey) !== route) return
            this.expirePendingAgentInteractions(
                route.roomId,
                route.agentName,
                [],
                [route.clarifyId],
                'Clarification timed out',
            )
        }, route.timeoutMs + 1_000)
        timer.unref?.()
        this.pendingClarifyTimers.set(routeKey, timer)
    }

    private pendingApprovalSnapshots(roomId: string | null, socket: Socket) {
        const pendingRoutes = this.pendingApprovalRoutes
        if (!pendingRoutes) return []
        return [...pendingRoutes.values()]
            .filter(route => (!roomId || route.roomId === roomId) && this.canSocketHandleAgentApproval(socket, route))
            .map(route => ({
                roomId: route.roomId,
                agentName: route.agentName,
                approval_id: route.approvalId,
                command: route.command,
                description: route.description,
                choices: route.choices,
                allow_permanent: route.allowPermanent,
                timeout_ms: route.timeoutMs,
                requested_at: route.requestedAt,
                remaining_timeout_ms: Math.max(0, route.timeoutMs - (Date.now() - route.requestedAt)),
            }))
    }

    private pendingClarifySnapshots(roomId: string | null) {
        const pendingRoutes = this.pendingClarifyRoutes
        if (!pendingRoutes) return []
        return [...pendingRoutes.values()]
            .filter(route => !roomId || route.roomId === roomId)
            .map(route => ({
                roomId: route.roomId,
                agentName: route.agentName,
                clarify_id: route.clarifyId,
                question: route.question,
                choices: route.choices,
                initial_response: route.initialResponse,
                response_mode: route.responseMode,
                timeout_ms: route.timeoutMs,
                requested_at: route.requestedAt,
                remaining_timeout_ms: Math.max(0, route.timeoutMs - (Date.now() - route.requestedAt)),
            }))
    }
    /** roomId -> blocked Bridge session ids from room-level interrupts/rotations. */
    private fencedRoomAgentSessions = new Map<string, Set<string>>()
    /** A short-lived proof that an invite guest actually joined as this room member. */
    private guestAgentRequestTokens = new Map<string, { hash: Buffer; expiresAt: number; socketId: string }>()

    constructor(httpServers: HttpServer | HttpServer[]) {
        this.storage = new ChatStorage()
        this.storage.init()
        const servers = Array.isArray(httpServers) ? httpServers : [httpServers]

        this.io = new Server(servers[0], {
            cors: { origin: createSocketIoCorsOrigin(config.corsOrigins) },
            maxHttpBufferSize: 2_000_000,
            allowRequest: (req, callback) => {
                if (shouldRejectUpgradeOrigin(req, config.corsOrigins)) {
                    logger.warn({
                        origin: req.headers.origin || '',
                        host: req.headers.host || '',
                        url: req.url || '',
                    }, '[Socket.IO] rejected upgrade origin')
                    callback('origin not allowed', false)
                    return
                }
                callback(null, true)
            },
            pingInterval: 25_000,
            pingTimeout: 90_000,
            connectionStateRecovery: {
                maxDisconnectionDuration: 2 * 60_000,
                skipMiddlewares: true,
            },
        })
        servers.slice(1).forEach((httpServer) => this.io.attach(httpServer))
        this.nsp = this.io.of('/group-chat')
        const eventSocket = (user: AuthenticatedUser) => ({ id: '', data: { authUser: user } } as unknown as Socket)
        const removeGroupEventAccess = registerGroupEventAccess({ canReceive: (user, roomId, event) => {
            const socket = eventSocket(user)
            if (!this.canSocketObserveRoom(socket, roomId)) return false
            if (event?.type.startsWith('group.approval.')) return this.canSocketHandleAgentApproval(socket,
                { roomId, ownerMemberId: String(event.payload.owner_member_id || '') })
            if (event?.type.startsWith('group.clarification.')) return this.canSocketManageRoom(socket, roomId)
            return true
        } })
        const removeGroupState = registerAppEventState('group', (user) => {
            const result: BusinessEvent[] = []
            const socket = eventSocket(user)
            for (const [roomId, activities] of this.roomAgentActivityState) {
                if (!this.canSocketObserveRoom(socket, roomId)) continue
                const profile = this.storage.getRoom(roomId)?.summaryProfile || 'default'
                for (const activity of activities.values()) result.push(this.groupActivityEvent(activity))
                const runs = new Set([...activities.values()].map(activity => activity.runId))
                for (const message of this.storage.getRunTaskPlanMessages(roomId, [...runs])) {
                    try {
                        const event = planStateEvent(profile, { room_id: roomId, run_id: message.run_id || undefined }, JSON.parse(message.content))
                        if (event) result.push(event)
                    } catch { /* malformed persisted card */ }
                }
            }
            for (const route of this.pendingApprovalRoutes.values()) {
                if (!this.canSocketHandleAgentApproval(socket, route)) continue
                result.push(stateEvent('group.approval.requested', this.storage.getRoom(route.roomId)?.summaryProfile || 'default',
                    { room_id: route.roomId, run_id: route.runId, approval_id: route.approvalId },
                    { owner_member_id: route.ownerMemberId, timeout_ms: route.timeoutMs, requested_at: route.requestedAt }))
            }
            for (const route of this.pendingClarifyRoutes.values()) {
                if (!this.canSocketManageRoom(socket, route.roomId)) continue
                result.push(stateEvent('group.clarification.requested', this.storage.getRoom(route.roomId)?.summaryProfile || 'default',
                    { room_id: route.roomId, run_id: route.runId, clarification_id: route.clarifyId },
                    { timeout_ms: route.timeoutMs, requested_at: route.requestedAt }))
            }
            return result
        })
        for (const server of servers) server.once('close', () => { removeGroupEventAccess(); removeGroupState() })
        this.nsp.use(this.authMiddleware.bind(this))
        this.nsp.on('connection', this.onConnection.bind(this))

        // Restore persisted rooms into memory
        this.storage.getAllRooms().forEach((row) => {
            this.rooms.set(row.id, new ChatRoom(row.id, row.name))
        })

        logger.info('[GroupChat] Socket.IO ready at /group-chat')

        this.roomSummaryService = new GroupRoomSummaryService(this.storage, (summary) => {
            this.nsp.to(summary.roomId).emit('room_summary_updated', summary)
        })
        this.agentClients.setStorage(this.storage)
        this.storage.setRoomAgentOnlineProvider((roomId, agentId) =>
            this.agentClients.getAgent(roomId, agentId)?.connected === true
        )
        this.agentClients.setRoomSummaryService(this.roomSummaryService)
        this.agentClients.setActivityBroadcaster((roomId, agentName, status, runId, agentSessionId) => {
            let roomStatuses = this.contextStatusState.get(roomId)
            if (status === 'ready') {
                roomStatuses?.delete(agentName)
                if (roomStatuses?.size === 0) this.contextStatusState.delete(roomId)
            } else {
                if (!roomStatuses) {
                    roomStatuses = new Map()
                    this.contextStatusState.set(roomId, roomStatuses)
                }
                roomStatuses.set(agentName, {
                    agentName,
                    status,
                    ...(agentSessionId ? { agentSessionId } : {}),
                    ...(runId ? { runId } : {}),
                })
            }
            this.nsp.to(roomId).emit('context_status', { roomId, agentName, status })
            if (runId) this.updateRoomAgentActivity(roomId, agentName, status, runId, agentSessionId)
        })
        this.agentClients.setExecutionQueueBroadcaster((roomId) => {
            this.broadcastExecutionQueue(roomId)
        })
        this.agentClients.setWorkspaceDiffBroadcaster((roomId, msg, totalTokens) => {
            this.nsp.to(roomId).emit('message', buildOutboundGroupMessage(msg))
            this.nsp.to(roomId).emit('room_updated', { roomId, totalTokens })
        })
        // Restore agent connections — call restoreWhenReady() after server is listening.
        // The dispatcher starts only after local runtime restoration completes.
        this._restoreScheduled = false
    }

    getIO(): Server {
        return this.io
    }

    getStorage(): ChatStorage {
        return this.storage
    }

    private executionQueueSnapshot(roomId: string): GroupExecutionQueueItem[] {
        return typeof this.storage.listQueuedExecutionItems === 'function'
            ? this.storage.listQueuedExecutionItems(roomId)
            : []
    }

    private readonly notifiedGroupMessages = new Set<string>()

    private notifyGroupReply(roomId: string, message: ChatMessage): void {
        const room = this.storage.getRoom(roomId)
        if (!room) return
        // Publish persisted message facts; the App adapter chooses which replies notify.
        const plan = message.tool_name === 'task_plan' ? parseGroupTaskPlan(message.content) : null
        const eventKey = plan ? `${message.id}:plan:${plan.revision}` : message.id
        if (this.notifiedGroupMessages.has(eventKey)) return
        this.notifiedGroupMessages.add(eventKey)
        if (this.notifiedGroupMessages.size > 2000) this.notifiedGroupMessages.delete(this.notifiedGroupMessages.values().next().value!)
        publishGroupMessage(room, message as unknown as Record<string, unknown>, this.storage.getRoomAgents(roomId))
    }

    private broadcastExecutionQueue(roomId: string): void {
        this.nsp.to(roomId).emit('execution_queue_updated', {
            roomId,
            items: this.executionQueueSnapshot(roomId),
        })
    }

    async dispatchPendingHandoffs(): Promise<number> {
        if (this.handoffDispatcherRunning) return 0
        this.handoffDispatcherRunning = true
        let dispatched = 0
        try {
            while (true) {
                const outbox = this.storage.claimHandoffOutbox()
                if (!outbox) break
                const attemptId = String(outbox.attemptId)
                try {
                    const payload = JSON.parse(String(outbox.payload || '{}')) as any
                    const delivery = await this.agentClients.processMentions(String(outbox.roomId), {
                        ...payload,
                        continuationAttemptId: attemptId,
                    })
                    if (delivery.targetCount === 0 || delivery.deliveredCount !== delivery.targetCount || delivery.errors.length > 0) {
                        const deliveryError = new Error(delivery.errors.join('; ') || 'Continuation target Agent is not connected') as Error & {
                            outcomeUnknown?: boolean
                        }
                        deliveryError.outcomeUnknown = delivery.outcomeUnknown === true
                        throw deliveryError
                    }
                    const attempt = this.storage.getHandoffAttempt(attemptId)
                    const chain = attempt
                        ? this.storage.getHandoffChain(String(attempt.roomId), String(attempt.chainId))
                        : null
                    if (!chain || !this.storage.completeHandoffContinuation(String(chain.roomId), String(chain.chainId))) {
                        throw new Error('Continuation delivery was accepted but could not be durably completed')
                    }
                    this.broadcastHandoffUpdate(
                        String(chain.roomId),
                        this.storage.getHandoffChain(String(chain.roomId), String(chain.chainId)),
                    )
                    this.storage.finishHandoffOutbox(attemptId)
                    dispatched++
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error)
                    const attempt = this.storage.getHandoffAttempt(attemptId)
                    const target = this.storage.getHandoffTargetStatus(attemptId)
                    if (target?.status === 'completed' && String(target.terminalMessageId || '')) {
                        const chain = attempt
                            ? this.storage.getHandoffChain(String(attempt.roomId), String(attempt.chainId))
                            : null
                        const completed = chain
                            ? this.storage.completeHandoffContinuation(String(chain.roomId), String(chain.chainId))
                            : null
                        if (completed) {
                            this.storage.finishHandoffOutbox(attemptId)
                            this.broadcastHandoffUpdate(String(completed.roomId), completed)
                        } else {
                            this.storage.requeueHandoffOutbox(
                                attemptId,
                                'Durable target completion could not be finalized on the source chain',
                            )
                        }
                    } else if (target?.status === 'failed_manual') {
                        this.storage.failHandoffContinuation(
                            String(attempt?.roomId || outbox.roomId),
                            String(attempt?.chainId || ''),
                            String(target.lastError || message),
                        )
                    } else if (/target Agent is not connected/i.test(message)) {
                        this.storage.deferHandoffOutbox(attemptId, message)
                    } else if ((error as any)?.outcomeUnknown === true) {
                        const diagnostic = `Remote target invocation outcome is unknown: ${message}`
                        const unknown = this.storage.markRemoteHandoffOutcomeUnknown(attemptId, diagnostic)
                        if (!unknown) {
                            logger.error({ attemptId }, '[GroupChat] failed to persist remote outcome-unknown state')
                        }
                    } else if (target?.invocationStartedAt) {
                        this.storage.failHandoffTarget(attemptId, message)
                        this.storage.failHandoffContinuation(
                            String(attempt?.roomId || outbox.roomId),
                            String(attempt?.chainId || ''),
                            message,
                        )
                    } else {
                        this.storage.requeueHandoffOutbox(attemptId, message)
                    }
                    if (attempt?.roomId && attempt?.chainId) {
                        this.broadcastHandoffUpdate(
                            String(attempt.roomId),
                            this.storage.getHandoffChain(String(attempt.roomId), String(attempt.chainId)),
                        )
                    }
                    dispatched++
                }
            }
        } finally {
            this.handoffDispatcherRunning = false
        }
        return dispatched
    }

    private consumeTrustedAgentMessageMetadata(roomId: string, messageId: string): { mentionDepth: number; handoffChainId: string; continuationAttemptId: string } | null {
        return this.storage.consumeTrustedAgentMessageMetadata?.(roomId, messageId) || null
    }

    getRoomSummaryService(): GroupRoomSummaryService {
        return this.roomSummaryService
    }

    getChatRunService(): GroupChatRunService | null {
        return this.chatRunService
    }

    publishAgentAttachmentMessage(input: {
        roomId: string
        agentId: string
        runId: string
        workspacePath: string
        attachment: PublishedGroupChatAttachmentBlock
        agentSnapshot?: {
            name: string
            agent: RoomAgent['agent']
            profile: string
            provider: string
            model: string
            description: string
            avatar: string
            ownerMemberId: string
        }
    }): ChatMessage {
        const room = this.storage.getRoom(input.roomId)
        const agent = this.storage.getRoomAgentByAgentId(input.roomId, input.agentId)
        const snapshot = input.agentSnapshot
        if (!room || (!agent && !snapshot?.name)) throw new Error('Group chat Agent is no longer available')

        const message: ChatMessage = {
            id: this.generateId(),
            roomId: input.roomId,
            senderId: agent?.agentId || input.agentId,
            senderName: agent?.name || snapshot!.name,
            senderType: 'agent',
            senderAgentRecordId: agent?.id || '',
            senderAvatar: agent?.avatar || snapshot?.avatar || '',
            senderAgentType: agent?.agent || snapshot?.agent,
            senderAgentProfile: agent?.profile || snapshot?.profile || '',
            senderAgentProvider: agent?.provider || snapshot?.provider || '',
            senderAgentModel: agent?.model || snapshot?.model || '',
            senderAgentDescription: agent?.description || snapshot?.description || '',
            senderOwnerMemberId: agent?.ownerMemberId || snapshot?.ownerMemberId || '',
            content: JSON.stringify([
                { type: 'text', text: input.workspacePath },
                input.attachment,
            ]),
            timestamp: Date.now(),
            persistedAt: Date.now(),
            run_id: input.runId || null,
            role: 'assistant',
        }
        const saved = this.storage.saveMessageAndRefreshRoom(message)
        this.nsp.to(input.roomId).emit('message', buildOutboundGroupMessage(saved.message))
        this.nsp.to(input.roomId).emit('room_updated', {
            roomId: input.roomId,
            totalTokens: saved.totalTokens,
        })
        return saved.message
    }

    authorizeGuestAgentRequestToken(roomId: string, userId: string, token: string): boolean {
        const key = `${roomId}\u0000${userId}`
        const entry = this.guestAgentRequestTokens.get(key)
        if (!entry || entry.expiresAt <= Date.now() || !token) {
            if (entry?.expiresAt && entry.expiresAt <= Date.now()) this.guestAgentRequestTokens.delete(key)
            return false
        }
        const actual = createHash('sha256').update(token).digest()
        return actual.length === entry.hash.length && timingSafeEqual(actual, entry.hash)
    }

    private issueGuestAgentRequestToken(roomId: string, userId: string, socketId: string): string {
        const token = randomBytes(32).toString('base64url')
        this.guestAgentRequestTokens.set(`${roomId}\u0000${userId}`, {
            hash: createHash('sha256').update(token).digest(),
            expiresAt: Date.now() + 60 * 60_000,
            socketId,
        })
        return token
    }

    broadcastAgentPairingRequest(roomId: string, request: Record<string, unknown>): void {
        this.emitToRoomManagers(roomId, 'agent_pairing_requested', { roomId, request })
    }

    broadcastAgentPairingUpdated(roomId: string, request: Record<string, unknown>): void {
        this.emitToRoomManagers(roomId, 'agent_pairing_updated', { roomId, request })
    }

    broadcastGuestAgentPolicy(roomId: string, room: RoomInfo): void {
        this.nsp.to(roomId).emit('room_updated', {
            roomId,
            allowGuestAgents: Number(room.allowGuestAgents || 0),
            guestAgentApproval: 'owner',
            maxGuestAgentsPerMember: Math.max(1, Number(room.maxGuestAgentsPerMember || 1)),
            allowRemoteWorkspaceAccess: Number(room.allowRemoteWorkspaceAccess || 0),
        })
    }

    ensureDefaultRoomWorkspace(roomId: string, profile: string): string {
        const workspace = defaultGroupChatWorkspace(profile, roomId)
        mkdirSync(workspace, { recursive: true })
        return workspace
    }

    updateRoomName(roomId: string, name: string): RoomInfo | null {
        const normalizedName = String(name || '').trim()
        const runtimeRoom = this.rooms.get(roomId)
        if (!normalizedName) return null
        this.storage.updateRoomName(roomId, normalizedName)
        if (runtimeRoom) runtimeRoom.name = normalizedName
        return this.broadcastRoomMetadata(roomId)
    }

    broadcastRoomMetadata(roomId: string): RoomInfo | null {
        const room = this.storage.getRoom(roomId) || null
        if (!room) return null
        this.nsp.to(roomId).emit('room_updated', {
            roomId,
            name: room.name,
            inviteCode: room.inviteCode,
            totalTokens: room.totalTokens,
            agentHandoffEnabled: room.agentHandoffEnabled,
            agentHandoffMaxDepth: room.agentHandoffMaxDepth,
            agentHandoffUnlimited: room.agentHandoffUnlimited,
        })
        return room
    }

    broadcastHandoffUpdate(roomId: string, chain: any): void {
        if (chain) this.nsp.to(roomId).emit('handoff_updated', chain)
    }

    getRoomAgentViews(
        roomId: string,
        _includeManageFields = false,
        viewerMemberId = '',
    ): Array<Record<string, unknown>> {
        const room = typeof this.storage.getRoom === 'function'
            ? this.storage.getRoom(roomId)
            : null
        const roomOwnerAuthUserId = Number(room?.ownerAuthUserId || 0)
        const roomOwnerMemberId = roomOwnerAuthUserId > 0
            ? authenticatedGroupUserId(roomOwnerAuthUserId)
            : ''
        return this.storage.getRoomAgents(roomId).map(agent => {
            const { ownerMemberId, connectorId, remoteOrigin, ...visible } = agent
            const executor = this.agentClients?.getAgent?.(roomId, agent.agentId)
            const displayOwnerMemberId = ownerMemberId
                || (agent.executorType === 'server' ? roomOwnerMemberId : '')
            const canManageAgent = agent.executorType === 'remote'
                && Boolean(viewerMemberId)
                && displayOwnerMemberId === viewerMemberId
            return {
                ...visible,
                connectionStatus: executor?.connected ? 'online' : 'offline',
                ...(displayOwnerMemberId ? { ownerMemberId: displayOwnerMemberId } : {}),
                ...(canManageAgent ? { connectorId, remoteOrigin } : {}),
            }
        })
    }

    private getRoomMemberViews(roomId: string, room = this.rooms.get(roomId)): MemberView[] {
        const storedMembers = typeof this.storage.getRoomMembers === 'function'
            ? this.storage.getRoomMembers(roomId)
            : []
        if (storedMembers.length > 0) {
            return storedMembers.map(member => ({
                ...member,
                connectionStatus: room?.members.get(member.userId)?.online === true ? 'online' : 'offline',
            }))
        }
        return (room?.getMembersList() || []).map(({
            id,
            userId,
            name,
            description,
            joinedAt,
            avatar,
            online,
        }) => ({
            id,
            userId,
            name,
            description,
            joinedAt,
            avatar,
            connectionStatus: online ? 'online' : 'offline',
        }))
    }

    broadcastRoomAgents(roomId: string): Array<Record<string, unknown>> {
        const agents = this.getRoomAgentViews(roomId, false)
        this.nsp.to(roomId).emit('agents_updated', {
            roomId,
            agents,
        })
        this.emitToRoomManagers(roomId, 'agents_updated', {
            roomId,
            agents: this.getRoomAgentViews(roomId, true),
        })
        for (const socket of this.nsp.sockets?.values?.() || []) {
            if (
                !socket.rooms?.has(roomId)
                || this.socketRequestedSourceMap.get(socket.id) === 'agent'
                || this.canSocketManageRoom(socket, roomId)
            ) continue
            const userId = this.socketUserMap.get(socket.id)
            if (!userId) continue
            socket.emit('agents_updated', {
                roomId,
                agents: this.getRoomAgentViews(roomId, false, userId),
            })
        }
        return agents
    }

    removeRoomMember(roomId: string, userId: string): MemberView[] | null {
        const normalizedUserId = String(userId || '').trim()
        if (!normalizedUserId) return null
        const room = this.rooms.get(roomId)
        const storedMember = typeof this.storage.getMemberByUserId === 'function'
            ? this.storage.getMemberByUserId(roomId, normalizedUserId)
            : null
        const onlineMember = room?.members.get(normalizedUserId) || null
        if (!storedMember && !onlineMember) return null

        const roomTyping = this.typingState.get(roomId)
        const typingEntry = roomTyping?.get(normalizedUserId)
        if (typingEntry) {
            clearTimeout(typingEntry.timer)
            roomTyping!.delete(normalizedUserId)
            if (roomTyping!.size === 0) this.typingState.delete(roomId)
            this.nsp.to(roomId).emit('stop_typing', {
                roomId,
                userId: normalizedUserId,
            })
        }

        room?.removeUser(normalizedUserId)
        this.storage.removeRoomMember?.(roomId, normalizedUserId)

        for (const socket of this.nsp.sockets?.values?.() || []) {
            if (
                this.socketUserMap.get(socket.id) !== normalizedUserId
                || !socket.rooms?.has(roomId)
            ) continue
            socket.emit('member_kicked', { roomId })
            socket.leave(roomId)
        }

        const members = this.getRoomMemberViews(roomId, room)
        this.nsp.to(roomId).emit('member_left', {
            roomId,
            memberId: normalizedUserId,
            memberName: onlineMember?.name || storedMember?.name || normalizedUserId,
            members,
        })
        return members
    }

    setChatRunService(service: GroupChatRunService | null): void {
        this.chatRunService = service
        this.agentClients.setChatRunService(service)
    }

    getRoomIds(): string[] {
        return Array.from(this.rooms.keys())
    }

    fenceCurrentRoomAgentSessions(roomId: string): () => void {
        const activeIds = typeof this.agentClients?.activeSessionIds === 'function'
            ? this.agentClients.activeSessionIds(roomId)
            : []
        const ids = new Set(activeIds)
        if (ids.size === 0 && typeof this.storage?.getRoomAgents === 'function') {
            const room = this.storage.getRoom(roomId)
            for (const agent of this.storage.getRoomAgents(roomId) || []) {
                ids.add(groupBridgeSessionId(roomId, agent.profile, agent.name, String(room?.sessionSeed || '0'), {
                    agent: agent.agent,
                    agentMode: agent.agentMode,
                    provider: agent.provider,
                    model: agent.model,
                    apiMode: agent.apiMode,
                    reasoningEffort: agent.reasoningEffort,
                    agentPreset: agent.agentPreset,
                }))
            }
        }
        if (!ids.size) return () => {}
        if (!this.fencedRoomAgentSessions) this.fencedRoomAgentSessions = new Map<string, Set<string>>()
        let fenced = this.fencedRoomAgentSessions.get(roomId)
        if (!fenced) {
            fenced = new Set<string>()
            this.fencedRoomAgentSessions.set(roomId, fenced)
        }
        for (const id of ids) fenced.add(id)
        let released = false
        return () => {
            if (released) return
            released = true
            const current = this.fencedRoomAgentSessions.get(roomId)
            if (!current) return
            for (const id of ids) current.delete(id)
            if (!current.size) this.fencedRoomAgentSessions.delete(roomId)
        }
    }

    private isRoomAgentSessionFenced(roomId: string, sessionId: string): boolean {
        return this.fencedRoomAgentSessions?.get(roomId)?.has(sessionId) === true
    }

    async clearRoomRuntimeState(roomId: string): Promise<void> {
        const roomTyping = this.typingState.get(roomId)
        if (roomTyping) {
            for (const entry of roomTyping.values()) clearTimeout(entry.timer)
            this.typingState.delete(roomId)
        }
        this.contextStatusState.delete(roomId)
        this.clearRoomAgentActivities(roomId)
        this.clearPendingApprovalRoutes(roomId)
        this.clearPendingClarifyRoutes(roomId)
        const releaseSessionFence = this.fenceCurrentRoomAgentSessions(roomId)
        try {
            await this.agentClients.interruptRoom(roomId)
        } catch (err) {
            releaseSessionFence()
            throw err
        }
        this.agentClients.resetRoomContext(roomId)
        this.nsp.to(roomId).emit('room_cleared', { roomId, totalTokens: 0 })
        this.nsp.to(roomId).emit('room_updated', { roomId, totalTokens: 0 })
    }

    async deleteRoomRuntimeState(roomId: string): Promise<void> {
        const roomTyping = this.typingState.get(roomId)
        if (roomTyping) {
            for (const entry of roomTyping.values()) clearTimeout(entry.timer)
            this.typingState.delete(roomId)
        }
        this.contextStatusState.delete(roomId)
        this.clearRoomAgentActivities(roomId)
        this.clearPendingApprovalRoutes(roomId)
        this.clearPendingClarifyRoutes(roomId)
        const releaseSessionFence = this.fenceCurrentRoomAgentSessions(roomId)
        try {
            await this.agentClients.interruptRoom(roomId)
        } catch (err) {
            releaseSessionFence()
            throw err
        }
        await this.agentClients.disconnectRoom(roomId)
        this.rooms.delete(roomId)
        this.nsp.in(roomId).socketsLeave(roomId)
        this.fencedRoomAgentSessions?.delete(roomId)
    }

    // ─── Restore Agents ─────────────────────────────────────────

    /**
     * Restore persisted agent connections. Safe to call multiple times;
     * will only execute once.
     */
    async restoreWhenReady(): Promise<void> {
        if (this._restoreScheduled) return
        this._restoreScheduled = true
        await this.restoreAgents()
        this.startHandoffDispatcher()
    }

    private startHandoffDispatcher(): void {
        if (this.handoffDispatcherTimer) return
        this.handoffDispatcherTimer = setInterval(() => {
            void this.dispatchPendingHandoffs().catch((error) => {
                logger.warn(`[GroupChat] handoff dispatcher tick failed: ${error instanceof Error ? error.message : String(error)}`)
            })
        }, 1_000)
        this.handoffDispatcherTimer.unref?.()
    }

    private async restoreAgents(): Promise<void> {
        const rooms = this.storage.getAllRooms()
        let total = 0

        for (const room of rooms) {
            const agents = this.storage.getRoomAgents(room.id)
            for (const agent of agents) {
                if (agent.executorType === 'remote') continue
                try {
                    const client = await this.agentClients.createAgent({
                        agentId: agent.agentId,
                        agent: agent.agent,
                        agentMode: agent.agentMode,
                        profile: agent.profile,
                        provider: agent.provider,
                        model: agent.model,
                        apiMode: agent.apiMode,
                        reasoningEffort: agent.reasoningEffort,
                        agentPreset: agent.agentPreset,
                        name: agent.name,
                        description: agent.description,
                        invited: agent.invited,
                        backgroundDelegationEnabled: false,
                    })
                    await this.agentClients.addAgentToRoom(room.id, client)
                    total++
                } catch (err: any) {
                    logger.error(`[GroupChat] Failed to restore agent ${agent.name} in room ${room.id}: ${err.message}`)
                }
            }
        }

        if (total > 0) {
            logger.info(`[GroupChat] Restored ${total} agent(s) across ${rooms.length} room(s)`)
        }
    }

    // ─── Auth ───────────────────────────────────────────────────

    private async authMiddleware(socket: Socket, next: (err?: Error) => void): Promise<void> {
        const auth = socket.handshake.auth as {
            source?: string
            agentSocketSecret?: string
            token?: string
            inviteCode?: string
        }
        const isAgentSocket = auth.source === 'agent' && auth.agentSocketSecret === GROUP_CHAT_AGENT_SOCKET_SECRET
        if (isAgentSocket) {
            next()
            return
        }

        const inviteCode = typeof auth.inviteCode === 'string' ? auth.inviteCode.trim() : ''
        if (inviteCode) {
            const invitedRoom = inviteCode ? this.storage.getRoomByInviteCode(inviteCode) : null
            if (!invitedRoom) return next(new Error('Unauthorized'))
            socket.data.inviteGuestRoomId = invitedRoom.id
            next()
            return
        }

        const token = auth.token || socket.handshake.query.token || ''
        if (await isAuthEnabled()) {
            const user = await authenticateUserToken(String(token))
            if (!user) return next(new Error('Unauthorized'))
            socket.data.authUser = user
        }
        try { socket.data.pushActor = await authenticatedPushActor(String(token)) }
        catch { return next(new Error('App device authentication failed')) }
        next()
    }

    // ─── Connection ─────────────────────────────────────────────

    private onConnection(socket: Socket): void {
        bindLegacyAppEvents(socket, 'group', event => Boolean(event.subject.room_id && this.canSocketObserveRoom(socket, event.subject.room_id)))
        const auth = socket.handshake.auth as { userId?: string; name?: string; description?: string; source?: string; agentSocketSecret?: string; authUserId?: number }
        const requestedSource = auth.source === 'agent' && auth.agentSocketSecret === GROUP_CHAT_AGENT_SOCKET_SECRET ? 'agent' : 'human'
        const authenticatedUser = socket.data.authUser as AuthenticatedUser | undefined
        const authUserId = requestedSource === 'human'
            ? authenticatedUser?.id ?? (typeof auth.authUserId === 'number' && auth.authUserId > 0 ? auth.authUserId : undefined)
            : undefined
        const userId = authUserId ? authenticatedGroupUserId(authUserId) : auth.userId || socket.id
        const userName = auth.name || authenticatedUser?.username || `User-${userId.slice(0, 6)}`
        const description = auth.description || ''

        this.socketUserMap.set(socket.id, userId)
        this.socketRequestedSourceMap.set(socket.id, requestedSource)
        this.userInfoMap.set(userId, { name: userName, description })
        if (typeof authUserId === 'number') {
            this.socketAuthUserIdMap.set(socket.id, authUserId)
        }

        logger.debug(`[GroupChat] Connected: ${userName} (socket=${socket.id}, user=${userId})`)

        socket.on('join', (data: { roomId?: string; name?: string; historyLimit?: number }, ack?: (response?: unknown) => void) => this.handleJoin(socket, data, ack))
        socket.on('load_pending_approvals', (_data: unknown, ack?: (response?: unknown) => void) => {
            ack?.({
                pendingApprovals: this.pendingApprovalSnapshots(null, socket),
                pendingClarifies: this.pendingClarifySnapshots(null)
                    .filter(request => this.canSocketManageRoom(socket, request.roomId)),
            })
        })
        socket.on('load_room_agent_activities', (_data: unknown, ack?: (response?: unknown) => void) => {
            this.handleLoadRoomAgentActivities(socket, {}, ack)
        })
        socket.on('load_messages', (data: { roomId?: string; offset?: number; limit?: number; before?: string; history?: boolean }, ack?: (response?: unknown) => void) => this.handleLoadMessages(socket, data, ack))
        socket.on('update_member_profile', (data: { roomId?: string; name?: string; description?: string } | undefined, ack?: (response?: unknown) => void) => this.handleUpdateMemberProfile(socket, data, ack))
        socket.on('message', (data: IncomingGroupChatMessage, ack?: (response?: unknown) => void) => this.handleMessage(socket, data, ack))
        socket.on('message_stream_start', (data: { roomId?: string; id?: string; senderId?: string; senderName?: string; timestamp?: number; run_id?: string; agentSessionId?: string }) => this.handleMessageStreamStart(socket, data))
        socket.on('message_stream_delta', (data: { roomId?: string; id?: string; delta?: string }) => this.handleMessageStreamDelta(socket, data))
        socket.on('message_reasoning_delta', (data: { roomId?: string; id?: string; delta?: string }) => this.handleMessageReasoningDelta(socket, data))
        socket.on('message_stream_end', (data: { roomId?: string; id?: string }) => this.handleMessageStreamEnd(socket, data))
        socket.on('typing', (data: { roomId?: string }) => this.handleTyping(socket, data))
        socket.on('stop_typing', (data: { roomId?: string }) => this.handleStopTyping(socket, data))
        socket.on('context_status', (data: { roomId?: string; agentName?: string; status?: string; runId?: string }) => this.handleContextStatus(socket, data))
        socket.on('cancel_execution_queue_item', (data: { roomId?: string; queueId?: string; executionQueueCapability?: string }, ack?: (response?: unknown) => void) => this.handleCancelExecutionQueueItem(socket, data, ack))
        socket.on('interrupt_agent', (data: { roomId?: string; agentName?: string }, ack?: (response?: unknown) => void) => this.handleInterruptAgent(socket, data, ack))
        socket.on('remove_agent', (data: { roomId?: string; agentId?: string }, ack?: (response?: unknown) => void) => this.handleRemoveAgent(socket, data, ack))
        socket.on('approval.requested', (data: { roomId?: string; agentName?: string; approval_id?: string; command?: string; description?: string; choices?: string[]; allow_permanent?: boolean; timeout_ms?: number; agentSessionId?: string; runId?: string }) => this.handleApprovalRequested(socket, data))
        socket.on('approval.resolved', (data: { roomId?: string; agentName?: string; approval_id?: string; choice?: string; agentSessionId?: string }) => this.handleApprovalResolved(socket, data))
        socket.on('approval.respond', (data: { roomId?: string; approval_id?: string; choice?: string }, ack?: (response?: unknown) => void) => this.handleApprovalRespond(socket, data, ack))
        socket.on('clarify.requested', (data: { roomId?: string; agentName?: string; clarify_id?: string; question?: string; choices?: string[] | null; initial_response?: string; response_mode?: string; timeout_ms?: number; agentSessionId?: string; runId?: string; runtimeRunId?: string }) => this.handleClarifyRequested(socket, data))
        socket.on('clarify.resolved', (data: { roomId?: string; agentName?: string; clarify_id?: string; resolved?: boolean; reason?: string; agentSessionId?: string }) => this.handleClarifyResolved(socket, data))
        socket.on('clarify.respond', (data: { roomId?: string; clarify_id?: string; response?: string }, ack?: (response?: unknown) => void) => this.handleClarifyRespond(socket, data, ack))
        socket.on('disconnect', () => this.handleDisconnect(socket))
    }

    // ─── Handlers ───────────────────────────────────────────────

    private canSocketJoinRoom(socket: Socket, roomId: string, room: RoomInfo | undefined, existingMember: Member | null, inviteCode?: string): boolean {
        if (!room) return typeof this.storage.getRoom !== 'function'
        const inviteGuestRoomId = socket.data?.inviteGuestRoomId
        if (typeof inviteGuestRoomId === 'string') return inviteGuestRoomId === roomId
        const requested = typeof inviteCode === 'string' ? inviteCode.trim() : ''
        if (requested && room.inviteCode && requested === room.inviteCode) return true
        const authUser = socket.data?.authUser as AuthenticatedUser | undefined
        if (!authUser) return Boolean(existingMember || !room.inviteCode)
        if (authUser.role === 'super_admin') return true
        if (typeof authUser.id === 'number' && Number(room.ownerAuthUserId || 0) === authUser.id) return true
        if (existingMember) return true
        const profiles = authenticatedUserProfiles(authUser)
        return profiles.length > 0 && typeof this.storage.getRoomsForProfiles === 'function' && this.storage.getRoomsForProfiles(profiles).some(candidate => candidate.id === roomId)
    }

    private canSocketManageRoom(socket: Socket, roomId: string): boolean {
        if (this.socketRequestedSourceMap?.get(socket.id) === 'agent') return false
        if (typeof socket.data?.inviteGuestRoomId === 'string') return false
        const room = typeof this.storage.getRoom === 'function' ? this.storage.getRoom(roomId) : undefined
        if (!room) return false
        const authUser = socket.data?.authUser as AuthenticatedUser | undefined
        if (!authUser) {
            // With authentication disabled, handshake userId/authUserId values are client-controlled.
            // They may identify a joined in-context member, but must never grant off-room global
            // approval visibility or authority based on persisted membership alone.
            const joined = this.getOnlineRoomMember(socket, roomId)
            return Boolean(joined && joined.member.source === 'human')
        }
        if (authUser.role === 'super_admin') return true
        if (typeof authUser.id === 'number' && Number(room.ownerAuthUserId || 0) === authUser.id) return true
        const profiles = authenticatedUserProfiles(authUser)
        return profiles.length > 0 && typeof this.storage.getRoomsForProfiles === 'function' && this.storage.getRoomsForProfiles(profiles).some(candidate => candidate.id === roomId)
    }

    private canSocketObserveRoom(socket: Socket, roomId: string): boolean {
        if (this.socketRequestedSourceMap?.get(socket.id) === 'agent') return false
        if (typeof socket.data?.inviteGuestRoomId === 'string') return false
        const authUser = socket.data?.authUser as AuthenticatedUser | undefined
        if (!authUser) return false
        const userId = this.socketUserMap?.get(socket.id)
            || (typeof authUser.id === 'number' ? authenticatedGroupUserId(authUser.id) : '')
        const existingMember = userId && typeof this.storage.getMemberByUserId === 'function'
            ? this.storage.getMemberByUserId(roomId, userId)
            : null
        const authMember = typeof authUser.id === 'number' && typeof this.storage.getMemberByAuthUserId === 'function'
            ? this.storage.getMemberByAuthUserId(roomId, authUser.id)
            : null
        if (existingMember || authMember) return true
        const room = typeof this.storage.getRoom === 'function' ? this.storage.getRoom(roomId) : undefined
        if (!room) return false
        return this.canSocketJoinRoom(socket, roomId, room, null)
    }

    private roomAgentActivityKey(agentId: string, runId: string): string {
        return `${agentId}\u0000${runId}`
    }

    private publicRoomAgentActivity(activity: GroupAgentActivity): Omit<GroupAgentActivity, 'agentSessionId'> {
        const { agentSessionId: _agentSessionId, ...visible } = activity
        return visible
    }

    private groupActivityEvent(activity: GroupAgentActivity): BusinessEvent {
        return stateEvent('group.run.updated', this.storage.getRoom(activity.roomId)?.summaryProfile || 'default',
            { room_id: activity.roomId, run_id: activity.runId },
            { state: { roomId: activity.roomId, agentId: activity.agentId, runId: activity.runId, status: activity.status } })
    }

    private emitRoomAgentActivity(activity: GroupAgentActivity): void {
        publishAppState(this.groupActivityEvent(activity))
        const payload = this.publicRoomAgentActivity(activity)
        const sockets = this.nsp.sockets?.values?.()
        if (!sockets) return
        for (const socket of sockets) {
            if (this.canSocketObserveRoom(socket, activity.roomId)) {
                socket.emit('room_agent_activity', payload)
            }
        }
    }

    private updateRoomAgentActivity(
        roomId: string,
        agentName: string,
        status: 'compressing' | 'replying' | 'ready',
        rawRunId: string,
        agentSessionId = '',
    ): void {
        const runId = rawRunId.trim().slice(0, 500)
        if (!runId) return
        const roomAgent = this.storage.getRoomAgents(roomId)
            .find(candidate => candidate.name === agentName)
        if (!roomAgent) return
        const key = this.roomAgentActivityKey(roomAgent.id, runId)
        const activity: GroupAgentActivity = {
            roomId,
            agentId: roomAgent.id,
            runId,
            agentName: roomAgent.name,
            agent: roomAgent.agent,
            avatar: roomAgent.avatar,
            status,
            ...(agentSessionId ? { agentSessionId } : {}),
        }
        const activityState = this.roomAgentActivityState || (this.roomAgentActivityState = new Map())
        const roomActivities = activityState.get(roomId)
        if (status === 'ready') {
            roomActivities?.delete(key)
            if (roomActivities?.size === 0) activityState.delete(roomId)
        } else {
            const next = roomActivities || new Map<string, GroupAgentActivity>()
            next.set(key, activity)
            if (!roomActivities) activityState.set(roomId, next)
        }
        this.emitRoomAgentActivity(activity)
    }

    private clearRoomAgentActivities(roomId: string, agentId?: string): void {
        const roomActivities = this.roomAgentActivityState?.get(roomId)
        if (!roomActivities) return
        for (const [key, activity] of roomActivities) {
            if (agentId && activity.agentId !== agentId) continue
            roomActivities.delete(key)
            this.emitRoomAgentActivity({ ...activity, status: 'ready' })
        }
        if (roomActivities.size === 0) this.roomAgentActivityState.delete(roomId)
    }

    private handleLoadRoomAgentActivities(
        socket: Socket,
        _data: unknown,
        ack?: (response?: unknown) => void,
    ): void {
        const activities: Array<Omit<GroupAgentActivity, 'agentSessionId'>> = []
        for (const [roomId, roomActivities] of this.roomAgentActivityState || []) {
            if (!this.canSocketObserveRoom(socket, roomId)) continue
            for (const activity of roomActivities.values()) {
                activities.push(this.publicRoomAgentActivity(activity))
            }
        }
        ack?.({ activities })
    }

    private groupAgentOwnerMemberId(roomId: string, agentName: string): string {
        const agent = this.storage.getRoomAgents(roomId)
            .find(candidate => candidate.name === agentName)
        if (!agent) return ''
        const explicitOwner = String(agent.ownerMemberId || '').trim()
        if (explicitOwner) return explicitOwner
        if (agent.executorType !== 'server') return ''
        const roomOwnerAuthUserId = Number(this.storage.getRoom(roomId)?.ownerAuthUserId || 0)
        return roomOwnerAuthUserId > 0
            ? authenticatedGroupUserId(roomOwnerAuthUserId)
            : ''
    }

    private canSocketHandleAgentApproval(
        socket: Socket,
        route: Pick<PendingGroupApprovalRoute, 'roomId' | 'ownerMemberId'>,
    ): boolean {
        if (!route.ownerMemberId || this.socketRequestedSourceMap?.get(socket.id) === 'agent') return false
        const authUser = socket.data?.authUser as AuthenticatedUser | undefined
        if (typeof authUser?.id === 'number') {
            return authenticatedGroupUserId(authUser.id) === route.ownerMemberId
        }
        const joined = this.getOnlineRoomMember(socket, route.roomId)
        return Boolean(
            joined
            && joined.member.source === 'human'
            && joined.member.userId === route.ownerMemberId
            && this.socketUserMap.get(socket.id) === route.ownerMemberId,
        )
    }

    private emitToAgentApprovalOwner(
        route: Pick<PendingGroupApprovalRoute, 'roomId' | 'ownerMemberId'> & Partial<Pick<PendingGroupApprovalRoute, 'runId'>>,
        event: string,
        payload: Record<string, unknown>,
    ): void {
        if (event === 'approval.requested' || event === 'approval.resolved') {
            const room = this.storage.getRoom(route.roomId)
            if (room) publishGroupInteraction(room, `group.${event}`, route.runId || '', String(payload.approval_id || ''),
                typeof payload.resolved === 'boolean' ? payload.resolved : undefined, { ...payload, owner_member_id: route.ownerMemberId })
        }
        const sockets = this.nsp.sockets?.values?.()
        if (!sockets) return
        for (const socket of sockets) {
            if (this.canSocketHandleAgentApproval(socket, route)) socket.emit(event, payload)
        }
    }

    private canSocketMentionAll(socket: Socket, roomId: string): boolean {
        if (this.socketRequestedSourceMap?.get(socket.id) === 'agent') return false
        if (typeof socket.data?.inviteGuestRoomId === 'string') return false
        return isGroupChatRoomOwner(
            this.storage,
            roomId,
            socket.data?.authUser as AuthenticatedUser | undefined,
        )
    }

    private canSocketInterruptAgent(socket: Socket, roomId: string, agentName: string): boolean {
        if (this.canSocketManageRoom(socket, roomId)) return true
        if (this.socketRequestedSourceMap?.get(socket.id) === 'agent') return false
        const requesterMemberId = this.socketUserMap?.get(socket.id)
        if (!requesterMemberId) return false
        const agent = this.storage.getRoomAgents(roomId)
            .find(candidate => candidate.name === agentName)
        return agent?.executorType === 'remote'
            && agent.ownerMemberId === requesterMemberId
    }

    private canSocketRemoveAgent(socket: Socket, roomId: string, agent: RoomAgent): boolean {
        if (this.canSocketManageRoom(socket, roomId)) return true
        if (this.socketRequestedSourceMap?.get(socket.id) === 'agent') return false
        const requesterMemberId = this.socketUserMap?.get(socket.id)
        return agent.executorType === 'remote'
            && Boolean(requesterMemberId)
            && agent.ownerMemberId === requesterMemberId
    }

    private getOnlineRoomMember(socket: Socket, roomId: string): { room: ChatRoom; member: Member } | null {
        const room = this.rooms.get(roomId)
        const member = room?.getOnlineMemberBySocketId(socket.id)
        return room && member ? { room, member } : null
    }

    private isAgentEventSocket(socket: Socket, roomId: string, agentName?: string): boolean {
        const joined = this.getOnlineRoomMember(socket, roomId)
        if (!joined || joined.member.source !== 'agent') return false
        return !agentName || joined.member.name === agentName
    }

    private emitToRoomManagers(roomId: string, event: string, payload: Record<string, unknown>): void {
        if (event === 'clarify.requested' || event === 'clarify.resolved') {
            const room = this.storage.getRoom(roomId)
            if (room) publishGroupInteraction(room, event === 'clarify.requested' ? 'group.clarification.requested' : 'group.clarification.resolved',
                String(payload.runId || ''), String(payload.clarify_id || ''), typeof payload.resolved === 'boolean' ? payload.resolved : undefined, payload)
        }
        const emitted = new Set<string>()
        const sockets = this.nsp.sockets?.values?.()
        if (!sockets) return
        for (const socket of sockets) {
            if (emitted.has(socket.id) || this.socketRequestedSourceMap?.get(socket.id) === 'agent') continue
            if (!this.canSocketManageRoom(socket, roomId)) continue
            socket.emit(event, payload)
            emitted.add(socket.id)
        }
    }

    private agentSessionIsCurrent(roomId: string, member: Member | undefined, agentSessionId: unknown): boolean {
        const sessionId = typeof agentSessionId === 'string' ? agentSessionId.trim() : ''
        if (!sessionId || member?.source !== 'agent') return false
        if (typeof this.agentClients?.agentSessionIsCurrent === 'function') {
            return this.agentClients.agentSessionIsCurrent(roomId, member.userId, sessionId)
                && !this.isRoomAgentSessionFenced(roomId, sessionId)
        }
        const room = this.storage?.getRoom?.(roomId)
        const roomAgent = this.storage?.getRoomAgentByAgentId?.(roomId, member.userId)
        if (!room || !roomAgent) return false
        const expected = groupBridgeSessionId(roomId, roomAgent.profile, roomAgent.name, String(room.sessionSeed || '0'), {
            agent: roomAgent.agent,
            agentMode: roomAgent.agentMode,
            provider: roomAgent.provider,
            model: roomAgent.model,
            apiMode: roomAgent.apiMode,
            reasoningEffort: roomAgent.reasoningEffort,
            agentPreset: roomAgent.agentPreset,
        })
        return sessionId === expected && !this.isRoomAgentSessionFenced(roomId, sessionId)
    }

    private canPersistAgentMessageForCurrentSession(
        roomId: string,
        member: Member | undefined,
        data: Pick<IncomingGroupChatMessage, 'role' | 'tool_calls' | 'tool_call_id' | 'agentSessionId'>,
    ): boolean {
        if (member?.source !== 'agent') return true
        const role = normalizeMessageRole(data.role)
        const isRunTrace = role === 'assistant' || role === 'tool' || Array.isArray(data.tool_calls) || Boolean(data.tool_call_id)
        if (!isRunTrace) return true
        return this.agentSessionIsCurrent(roomId, member, data.agentSessionId)
    }

    private getCurrentAgentEventMember(socket: Socket, roomId: string, agentName: string, agentSessionId?: unknown): Member | null {
        const joined = this.getOnlineRoomMember(socket, roomId)
        if (!joined || joined.member.source !== 'agent') return null
        if (agentName && joined.member.name !== agentName) return null
        if (!this.agentSessionIsCurrent(roomId, joined.member, agentSessionId)) return null
        return joined.member
    }

    private handleJoin(socket: Socket, data: { roomId?: string; name?: string; description?: string; avatar?: string; inviteCode?: string; historyLimit?: number }, ack?: (res: any) => void): void {
        const socketId = socket.id
        const userId = this.socketUserMap.get(socketId) || socketId
        const requestedSource = this.socketRequestedSourceMap.get(socketId) || 'human'
        const roomId = data.roomId || 'general'
        const storedRoom = typeof this.storage.getRoom === 'function' ? this.storage.getRoom(roomId) : undefined
        const roomAgent = this.storage.getRoomAgentByAgentId(roomId, userId)
        if (requestedSource === 'agent' && !roomAgent) {
            ack?.({ error: 'Access denied' })
            return
        }
        const source = requestedSource === 'agent' && roomAgent ? 'agent' : 'human'
        if (source === 'human' && roomAgent) {
            ack?.({ error: 'Reserved member identity' })
            return
        }
        const socketAuthUserId = this.socketAuthUserIdMap.get(socket.id)
        const existingMember = this.storage.getMemberByUserId(roomId, userId) ||
            (typeof socketAuthUserId === 'number' ? this.storage.getMemberByAuthUserId(roomId, socketAuthUserId) : null)
        if (source !== 'agent' && !this.canSocketJoinRoom(socket, roomId, storedRoom, existingMember, data.inviteCode)) {
            ack?.({ error: 'Access denied' })
            return
        }
        const userInfo = this.userInfoMap.get(userId) || {
            name: `User-${userId.slice(0, 6)}`,
            description: '',
        }
        const requestedName = typeof data.name === 'string' ? data.name.trim() : ''
        const requestedDescription = typeof data.description === 'string' ? data.description.trim() : ''
        const isInviteGuest = typeof socket.data?.inviteGuestRoomId === 'string'
        if (isInviteGuest && !requestedName) {
            ack?.({ code: 'ROOM_PARTICIPANT_NAME_REQUIRED', error: 'Name is required' })
            return
        }
        // On rejoin, prefer the per-room DB record over the join-request name
        // so switching rooms doesn't overwrite a member's per-room identity.
        // Invite guests explicitly confirm their name before every entry, so
        // their requested name may update the persisted browser identity.
        const userName = isInviteGuest && requestedName
            ? requestedName
            : existingMember?.name || requestedName || userInfo.name
        const description = existingMember?.description || requestedDescription || userInfo.description
        if (isReservedMentionName(userName)) {
            ack?.({ code: 'ROOM_PARTICIPANT_NAME_RESERVED', error: '`all` is reserved for @all mentions' })
            return
        }
        let requestedAvatar = ''
        if (isInviteGuest) {
            try {
                requestedAvatar = normalizeRoomMemberAvatar(data.avatar)
            } catch {
                ack?.({ code: 'ROOM_PARTICIPANT_AVATAR_INVALID', error: 'Invalid member avatar' })
                return
            }
        }

        // Update stored user info
        this.userInfoMap.set(userId, { name: userName, description })

        let room = this.rooms.get(roomId)
        if (!room) {
            if (!storedRoom && typeof this.storage.getRoom === 'function') {
                ack?.({ error: 'Room not found' })
                return
            }
            room = new ChatRoom(roomId)
            this.rooms.set(roomId, room)
            if (!storedRoom) this.storage.saveRoom(roomId, roomId)
        }

        // Look up the user's avatar via their numeric users.id from the web UI session.
        // Falls back to name-based lookup for clients that don't pass authUserId.
        let userAvatar = isInviteGuest
            ? requestedAvatar || existingMember?.avatar || ''
            : existingMember?.avatar || ''
        let authUserId: number | undefined
        if (source !== 'agent') {
            authUserId = this.socketAuthUserIdMap.get(socket.id)
            if (typeof authUserId === 'number') {
                try {
                    userAvatar = getUserAvatar(authUserId) || ''
                } catch (err) {
                    logger.info(`[GroupChat] avatar lookup by id=${authUserId} failed: ${(err as Error).message}`)
                }
            }
        }

        // Persist only human members. Agent sockets are runtime participants
        // tracked through gc_room_agents and AgentClients; storing them in
        // gc_room_members makes member counts grow on reconnect/restore.
        if (source !== 'agent') {
            try {
                this.storage.addRoomMember(roomId, userId, userName, description, userAvatar, authUserId)
            } catch (err: any) {
                if (err?.code === ROOM_PARTICIPANT_NAME_CONFLICT) {
                    ack?.({ code: err.code, error: err.message })
                    return
                }
                logger.error(`[GroupChat] Failed to persist room member: ${err?.message || err}`)
                ack?.({ error: 'Failed to join room' })
                return
            }
        }

        // Add to in-memory online participants (keyed by userId)
        room.addOrUpdateMember(socketId, userId, userName, description, source, userAvatar)
        socket.join(roomId)

        if (source !== 'agent') {
            const members = this.getRoomMemberViews(roomId, room)
            socket.to(roomId).emit('member_joined', {
                roomId,
                memberId: userId,
                memberName: userName,
                members,
            })
        }

        // Load history from SQLite
        const historyLimit = Math.min(150, Math.max(1, Number.isFinite(data.historyLimit) ? Math.floor(Number(data.historyLimit)) : 150))
        const messages = this.storage.getRecentMessagesForUI(roomId, historyLimit, 0)
        const total = this.storage.getMessageCount?.(roomId) ?? messages.length
        const historyTruncated = total > GROUP_CHAT_MESSAGE_WINDOW
        const agents = this.getRoomAgentViews(
            roomId,
            this.canSocketManageRoom(socket, roomId),
            userId,
        )

        ack?.({
            roomId,
            roomName: room.name,
            members: this.getRoomMemberViews(roomId, room),
            messages,
            agents,
            rooms: typeof socket.data?.inviteGuestRoomId === 'string' ? [roomId] : this.getRoomIds(),
            total,
            offset: 0,
            limit: messages.length,
            hasMore: messages.length < total,
            historyTruncated,
            typingUsers: this.getTypingUsers(roomId),
            contextStatuses: this.getContextStatuses(roomId),
            roomSummary: this.roomSummaryService.getState(roomId),
            executionQueue: this.executionQueueSnapshot(roomId),
            pendingApprovals: this.pendingApprovalSnapshots(roomId, socket),
            pendingClarifies: this.canSocketManageRoom(socket, roomId) ? this.pendingClarifySnapshots(roomId) : [],
            ...(isInviteGuest && source !== 'agent'
                ? { agentLinkToken: this.issueGuestAgentRequestToken(roomId, userId, socket.id) }
                : {}),
        })

        logger.debug(`[GroupChat] ${userName} (user=${userId}) joined room: ${roomId}`)
    }

    private handleLoadMessages(
        socket: Socket,
        data: { roomId?: string; offset?: number; limit?: number; before?: string; history?: boolean } | undefined,
        ack?: (res: any) => void,
    ): void {
        const roomId = typeof data?.roomId === 'string' ? data.roomId.trim() : ''
        if (!roomId || !this.getOnlineRoomMember(socket, roomId)) {
            ack?.({ error: 'Access denied' })
            return
        }

        const offset = Math.max(0, Number.isFinite(data?.offset) ? Math.floor(Number(data?.offset)) : 0)
        const limit = Math.min(150, Math.max(1, Number.isFinite(data?.limit) ? Math.floor(Number(data?.limit)) : 150))
        const beforeMessageId = typeof data?.before === 'string' ? data.before.trim() : ''
        const historyPage = beforeMessageId || data?.history
            ? this.storage.getHistoryPageForUI(roomId, limit, beforeMessageId || undefined)
            : null
        if (historyPage && !historyPage.cursorFound) {
            ack?.({ error: 'History cursor not found' })
            return
        }
        const messages = historyPage?.messages
            ?? this.storage.getRecentMessagesForUI(roomId, limit, offset)
        const storedTotal = this.storage.getMessageCount?.(roomId) ?? messages.length
        ack?.({
            messages,
            total: storedTotal,
            offset,
            limit,
            hasMore: historyPage?.hasMore ?? offset + messages.length < storedTotal,
            historyTruncated: storedTotal > GROUP_CHAT_MESSAGE_WINDOW,
        })
    }

    private handleUpdateMemberProfile(
        socket: Socket,
        data: { roomId?: string; name?: string; description?: string } | undefined,
        ack?: (res: any) => void,
    ): void {
        const roomId = typeof data?.roomId === 'string' ? data.roomId.trim() : ''
        const name = typeof data?.name === 'string' ? data.name.trim() : ''
        const description = typeof data?.description === 'string' ? data.description.trim() : ''
        if (!roomId || !name) {
            ack?.({ error: 'roomId and name are required' })
            return
        }
        if (isReservedMentionName(name)) {
            ack?.({ code: 'ROOM_PARTICIPANT_NAME_RESERVED', error: '`all` is reserved for @all mentions' })
            return
        }
        if (name.length > 120 || description.length > 2000) {
            ack?.({ error: 'Member profile is too long' })
            return
        }

        const joined = this.getOnlineRoomMember(socket, roomId)
        if (!joined || joined.member.source !== 'human') {
            ack?.({ error: 'Access denied' })
            return
        }

        try {
            const userId = joined.member.userId
            const authUserId = this.socketAuthUserIdMap.get(socket.id)
            const avatar = joined.member.avatar || ''
            this.storage.addRoomMember(roomId, userId, name, description, avatar, authUserId)
            joined.room.addOrUpdateMember(socket.id, userId, name, description, 'human', avatar)
            this.userInfoMap.set(userId, { name, description })

            const members = this.getRoomMemberViews(roomId, joined.room)
            this.nsp.to(roomId).emit('member_updated', {
                roomId,
                memberId: userId,
                memberName: name,
                members,
            })
            ack?.({ member: joined.room.getOnlineMemberBySocketId(socket.id), members })
        } catch (err) {
            if ((err as any)?.code === ROOM_PARTICIPANT_NAME_CONFLICT) {
                ack?.({ code: ROOM_PARTICIPANT_NAME_CONFLICT, error: (err as Error).message })
                return
            }
            logger.error(`[GroupChat] Failed to update member profile: ${(err as Error).message}`)
            ack?.({ error: 'Failed to update member profile' })
        }
    }

    private normalizeStructuredMentions(
        roomId: string,
        member: Member | undefined,
        content: string,
        rawMentions: unknown,
    ): { mentions?: StructuredMention[]; error?: string } {
        const senderId = member?.userId || ''
        const senderIsAgent = member?.source === 'agent'
        if (rawMentions === undefined) {
            const roomAgents = senderIsAgent && typeof this.storage.getRoomAgents === 'function'
                ? this.storage.getRoomAgents(roomId) as RoomAgent[]
                : []
            if (senderIsAgent && (isAllAgentsMentioned(content) || resolveMentionTargets(roomAgents, content, senderId).length > 0)) {
                return { error: 'Agent mentions require structured metadata' }
            }
            return senderIsAgent ? { mentions: [] } : {}
        }
        if (!Array.isArray(rawMentions)) return { error: 'Invalid structured mentions' }
        if (rawMentions.length === 0) return { mentions: [] }
        const roomAgents = this.storage.getRoomAgents(roomId) as RoomAgent[]
        const visibleAllMention = isAllAgentsMentioned(content)
        const visibleParticipantIds = new Set(
            roomAgents
                .filter(agent => agent.agentId !== senderId && isAgentMentioned(content, agent.name))
                .map(agent => agent.agentId),
        )

        const normalized: StructuredMention[] = []
        const participantIds = new Set<string>()
        let allSeen = false
        for (const rawMention of rawMentions) {
            if (!rawMention || typeof rawMention !== 'object' || Array.isArray(rawMention)) {
                return { error: 'Invalid structured mentions' }
            }
            const mention = rawMention as Record<string, unknown>
            if (mention.type === 'all') {
                if (allSeen || normalized.length > 0 || mention.displayName !== 'all' || !visibleAllMention) {
                    return { error: 'Invalid structured mentions' }
                }
                allSeen = true
                normalized.push({ type: 'all' })
                continue
            }
            if (mention.type !== 'agent'
                || typeof mention.participantId !== 'string'
                || typeof mention.displayName !== 'string'
                || allSeen
                || participantIds.has(mention.participantId)
                || mention.participantId === senderId) {
                return { error: 'Invalid structured mentions' }
            }
            const target = roomAgents.find(agent => agent.agentId === mention.participantId)
            if (!target || target.name !== mention.displayName || !isAgentMentioned(content, target.name)) {
                return { error: 'Invalid structured mentions' }
            }
            participantIds.add(target.agentId)
            normalized.push({ type: 'agent', participantId: target.agentId })
        }

        if (senderIsAgent) {
            const structuredAll = normalized.length === 1 && normalized[0].type === 'all'
            const visibleAgentMentionIds = [...visibleParticipantIds]
            if (visibleAllMention
                ? !structuredAll || visibleAgentMentionIds.length > 0
                : structuredAll
                    || participantIds.size !== visibleAgentMentionIds.length
                    || visibleAgentMentionIds.some(participantId => !participantIds.has(participantId))) {
                return { error: 'Invalid structured mentions' }
            }
        }
        return { mentions: normalized }
    }

    private handleMessage(socket: Socket, data: IncomingGroupChatMessage, ack?: (res: any) => void): void {
        if (!data || (typeof data.content !== 'string' && !Array.isArray(data.content))) {
            ack?.({ error: 'Invalid message content' })
            return
        }
        const socketId = socket.id
        const roomId = data.roomId || 'general'
        const room = this.rooms.get(roomId)

        if (!room || !room.hasOnlineMember(socketId)) {
            ack?.({ error: 'Not in room' })
            return
        }

        const member = room.getOnlineMemberBySocketId(socketId)
        if (!this.canPersistAgentMessageForCurrentSession(roomId, member, data)) {
            ack?.({ error: 'Stale room session' })
            return
        }
        const userId = member?.userId || socketId
        const userName = member?.name || `User-${socketId.slice(0, 6)}`
        const isHumanMessage = member?.source === 'human'
        const role = isHumanMessage ? 'user' : normalizeMessageRole(data.role)
        const canCarryMentions = role === 'user' || role === 'assistant'
        let messageContent: unknown = data.content
        let runtimeInput: ContentBlock[] | undefined = Array.isArray(data.content)
            ? data.content as ContentBlock[]
            : undefined
        const structuredHumanContent = isHumanMessage ? humanStructuredContent(data.content) : null
        if (structuredHumanContent) {
            try {
                const normalized = normalizeHumanGroupChatContent(roomId, structuredHumanContent)
                messageContent = normalized.storageContent
                runtimeInput = normalized.runtimeInput
            } catch (error) {
                ack?.({
                    code: 'GROUP_CHAT_ATTACHMENT_INVALID',
                    error: error instanceof Error ? error.message : 'Invalid group chat attachment',
                })
                return
            }
        }
        const requestsAllMention = Array.isArray(data.mentions)
            ? data.mentions.some(mention => Boolean(mention)
                && typeof mention === 'object'
                && !Array.isArray(mention)
                && (mention as Record<string, unknown>).type === 'all')
            : isAllAgentsMentioned(contentToText(messageContent))
        if (canCarryMentions && requestsAllMention && !this.canSocketMentionAll(socket, roomId)) {
            ack?.({
                code: 'GROUP_CHAT_ALL_MENTION_FORBIDDEN',
                error: 'Only the room owner can mention @all',
            })
            return
        }
        const content = contentToStorageString(messageContent)
        const mentionResult = canCarryMentions
            ? this.normalizeStructuredMentions(roomId, member, contentToText(messageContent), data.mentions)
            : {}
        if (mentionResult.error) {
            ack?.({ error: mentionResult.error })
            return
        }

        const msg: ChatMessage = {
            id: this.normalizeClientMessageId(data.id) || this.generateId(),
            roomId,
            senderId: userId,
            senderName: userName,
            content,
            timestamp: this.normalizeMessageTimestamp(data.timestamp, role),
            persistedAt: Date.now(),
            ...(mentionResult.mentions !== undefined ? { mentions: mentionResult.mentions } : {}),
            run_id: !isHumanMessage && typeof data.run_id === 'string' && data.run_id.trim()
                ? data.run_id.trim()
                : null,
            role,
            tool_call_id: !isHumanMessage ? data.tool_call_id ?? null : null,
            tool_calls: !isHumanMessage && Array.isArray(data.tool_calls) ? data.tool_calls : null,
            tool_name: !isHumanMessage ? data.tool_name ?? null : null,
            finish_reason: !isHumanMessage ? data.finish_reason ?? null : null,
            reasoning: !isHumanMessage ? data.reasoning ?? null : null,
            reasoning_details: !isHumanMessage ? data.reasoning_details ?? null : null,
            reasoning_content: !isHumanMessage ? data.reasoning_content ?? null : null,
        }

        const isAgentReply = msg.role === 'assistant' && member?.source === 'agent'
        const trustedMetadata = isAgentReply ? this.consumeTrustedAgentMessageMetadata(roomId, msg.id) : null
        const pushActor = isHumanMessage ? socket.data?.pushActor as PushActor | null : null
        let saved: ReturnType<ChatStorage['saveMessageAndRefreshRoom']>
        try {
            const save = () => {
                if (pushActor) {
                    const target = bindRunPushTarget({ kind: 'group', profile: this.storage.getRoom(roomId)?.summaryProfile || 'default', runId: msg.id }, roomId, pushActor, {
                        ciphertext: prepareRunPushSnapshot(pushActor, data.push_snapshot),
                        platform: String((data.push_snapshot as any)?.platform || 'unknown'),
                    })
                    linkPushRun('group_root', roomId, msg.id, target)
                } else if (trustedMetadata?.handoffChainId) {
                    const root = findPushRunLink('group_root', roomId, trustedMetadata.handoffChainId)
                    if (root) linkPushRun('group_message', roomId, msg.id, root)
                }
                return this.storage.saveMessageAndRefreshRoom(msg)
            }
            saved = pushActor || trustedMetadata ? pushRunTransaction(save) : save()
        }
        catch (error) {
            logger.warn(error, '[GroupChat] message persistence failed')
            ack?.({ error: 'Message could not be saved' })
            return
        }
        const savedMsg = saved.message
        const totalTokens = saved.totalTokens

        this.nsp.to(roomId).emit('message', buildOutboundGroupMessage(savedMsg))
        this.notifyGroupReply(roomId, savedMsg)
        this.nsp.to(roomId).emit('room_updated', { roomId, totalTokens })
        ack?.({ id: savedMsg.id })

        const structuredAgentTargetId = isAgentReply && Array.isArray(savedMsg.mentions)
            ? String(savedMsg.mentions.find(mention => mention.type === 'agent')?.participantId || '')
            : ''
        const hasStructuredAgentTargets = Boolean(structuredAgentTargetId)
        // Agent sockets are untrusted transport. Only metadata issued by this
        // server for the exact message may participate in chained routing.
        const mentionDepth = isAgentReply
            ? (trustedMetadata?.mentionDepth ?? Number.MAX_SAFE_INTEGER)
            : normalizeMentionDepth(data.mentionDepth)
        const handoffChainId = isAgentReply
            ? (trustedMetadata?.handoffChainId || '')
            : savedMsg.id
        const continuationAttemptId = trustedMetadata?.continuationAttemptId || ''
        // Any human who has successfully joined the room may interact with its
        // Agents. Room management remains separately protected by
        // canSocketManageRoom, so invite guests cannot mutate settings, approve
        // tools, or interrupt an Agent.
        const canRouteHumanMentions = savedMsg.role === 'user' && member?.source === 'human'
        const handoffPolicy = typeof this.storage.getRoomAgentHandoffPolicy === 'function'
            ? this.storage.getRoomAgentHandoffPolicy(roomId)
            : resolveGroupChatAgentHandoffPolicy({}, process.env.HERMES_GROUP_CHAT_MAX_AGENT_MENTION_DEPTH)
        const shouldRouteMentions = canRouteHumanMentions ||
            (hasStructuredAgentTargets && shouldRouteGroupChatAgentHandoff(mentionDepth, handoffPolicy))

        if (continuationAttemptId) {
            if (savedMsg.finish_reason === 'error') {
                this.storage.failHandoffTarget(
                    continuationAttemptId,
                    contentToText(savedMsg.content) || 'Continuation Agent run failed',
                )
            } else {
                this.storage.completeHandoffTarget(continuationAttemptId, savedMsg.id)
            }
        }

        if (shouldRouteMentions) {
            // Server-side @mention routing — parse mentions and invoke agents directly.
            // Agent replies are allowed to mention other agents, but mentionDepth
            // bounds chained agent-to-agent handoffs so one prompt cannot loop forever.
            this.agentClients.processMentions(roomId, {
                messageId: savedMsg.id,
                content: contentToText(savedMsg.content),
                input: runtimeInput,
                senderName: savedMsg.senderName,
                senderId: savedMsg.senderId,
                timestamp: savedMsg.timestamp,
                role: savedMsg.role,
                mentionDepth,
                handoffChainId,
                mentions: savedMsg.mentions,
                executionQueueCapabilityHash: isHumanMessage
                    ? executionQueueCapabilityHash(data.executionQueueCapability)
                    : '',
            }).catch((err) => {
                logger.error(`[GroupChat] processMentions error: ${err.message}`)
            }).finally(() => {
                if (typeof this.agentClients.processSummaryCheck !== 'function') return
                this.agentClients.processSummaryCheck(roomId, savedMsg.id).catch((err) => {
                    logger.error(`[GroupChat] summary check error: ${err.message}`)
                })
            })
        } else {
            if (
            isAgentReply
            && hasStructuredAgentTargets
            && trustedMetadata
            && handoffPolicy.enabled
            && !handoffPolicy.unlimited
            && Number.isFinite(handoffPolicy.maxDepth)
            && mentionDepth >= Number(handoffPolicy.maxDepth)
            && typeof this.storage.recordHandoffStop === 'function'
            ) {
                this.storage.recordHandoffStop(
                    roomId,
                    `handoff:${savedMsg.id}`,
                    savedMsg.id,
                    mentionDepth,
                    structuredAgentTargetId,
                    handoffPolicy,
                )
                this.broadcastHandoffUpdate(
                    roomId,
                    this.storage.getHandoffChain(roomId, `handoff:${savedMsg.id}`),
                )
            }
            if ((savedMsg.role === 'user' || savedMsg.role === 'assistant')
                && typeof this.agentClients.processSummaryCheck === 'function') {
                this.agentClients.processSummaryCheck(roomId, savedMsg.id).catch((err) => {
                    logger.error(`[GroupChat] summary check error: ${err.message}`)
                })
            }
        }
    }

    private handleMessageStreamStart(socket: Socket, data: { roomId?: string; id?: string; senderId?: string; senderName?: string; timestamp?: number; run_id?: string; agentSessionId?: string }): void {
        const roomId = data.roomId || 'general'
        const member = this.getCurrentAgentEventMember(socket, roomId, '', data.agentSessionId)
        if (!member) return
        const id = this.normalizeClientMessageId(data.id)
        if (!id) return
        const agent = this.storage.getRoomAgentByAgentId(roomId, member.userId)

        this.nsp.to(roomId).emit('message_stream_start', {
            id,
            roomId,
            senderId: member.userId,
            senderName: member.name,
            ...(agent?.id ? { senderAgentRecordId: agent.id } : {}),
            content: '',
            timestamp: data.timestamp || Date.now(),
            run_id: typeof data.run_id === 'string' && data.run_id.trim() ? data.run_id.trim() : null,
            role: 'assistant',
            finish_reason: 'streaming',
        })
    }

    private handleMessageStreamDelta(socket: Socket, data: { roomId?: string; id?: string; delta?: string; agentSessionId?: string }): void {
        const roomId = data.roomId || 'general'
        if (!this.getCurrentAgentEventMember(socket, roomId, '', data.agentSessionId)) return
        const id = this.normalizeClientMessageId(data.id)
        if (!id || !data.delta) return
        this.nsp.to(roomId).emit('message_stream_delta', {
            roomId,
            id,
            delta: String(data.delta),
        })
    }

    private handleMessageReasoningDelta(socket: Socket, data: { roomId?: string; id?: string; delta?: string; agentSessionId?: string }): void {
        const roomId = data.roomId || 'general'
        if (!this.getCurrentAgentEventMember(socket, roomId, '', data.agentSessionId)) return
        const id = this.normalizeClientMessageId(data.id)
        if (!id || !data.delta) return
        this.nsp.to(roomId).emit('message_reasoning_delta', {
            roomId,
            id,
            delta: String(data.delta),
        })
    }

    private handleMessageStreamEnd(socket: Socket, data: { roomId?: string; id?: string; agentSessionId?: string }): void {
        const roomId = data.roomId || 'general'
        if (!this.getCurrentAgentEventMember(socket, roomId, '', data.agentSessionId)) return
        const id = this.normalizeClientMessageId(data.id)
        if (!id) return
        this.nsp.to(roomId).emit('message_stream_end', { roomId, id })
    }

    private handleTyping(socket: Socket, data: { roomId?: string }): void {
        const roomId = data.roomId || 'general'
        const joined = this.getOnlineRoomMember(socket, roomId)
        if (!joined) return
        const userId = joined.member.userId
        const userName = joined.member.name

        // Track typing state for rejoin recovery
        let roomTyping = this.typingState.get(roomId)
        if (!roomTyping) {
            roomTyping = new Map()
            this.typingState.set(roomId, roomTyping)
        }
        const existing = roomTyping.get(userId)
        if (existing) clearTimeout(existing.timer)
        roomTyping.set(userId, {
            userName,
            socketId: socket.id,
            timer: setTimeout(() => {
                roomTyping!.delete(userId)
                if (roomTyping!.size === 0) this.typingState.delete(roomId)
            }, 30000),
        })

        socket.to(roomId).emit('typing', {
            roomId,
            userId,
            userName,
        })
    }

    private handleStopTyping(socket: Socket, data: { roomId?: string }): void {
        const roomId = data.roomId || 'general'
        const joined = this.getOnlineRoomMember(socket, roomId)
        if (!joined) return
        const userId = joined.member.userId

        // Remove from typing state
        const roomTyping = this.typingState.get(roomId)
        const entry = roomTyping?.get(userId)
        if (entry?.socketId !== socket.id) return
        clearTimeout(entry.timer)
        roomTyping!.delete(userId)
        if (roomTyping!.size === 0) this.typingState.delete(roomId)

        socket.to(roomId).emit('stop_typing', {
            roomId,
            userId,
        })
    }

    private handleContextStatus(socket: Socket, data: { roomId?: string; agentName?: string; status?: string; totalTokens?: number; agentSessionId?: string; runId?: string }): void {
        const roomId = data.roomId || 'general'
        const agentName = data.agentName || ''
        const status = data.status || ''
        const agentSessionId = typeof data.agentSessionId === 'string' ? data.agentSessionId.trim() : ''

        if (!agentName) return
        if (status !== 'compressing' && status !== 'replying' && status !== 'ready') return

        if (status === 'ready') {
            const joined = this.getOnlineRoomMember(socket, roomId)
            if (!joined || joined.member.source !== 'agent' || joined.member.name !== agentName) return
            const roomStatuses = this.contextStatusState.get(roomId)
            const activeStatus = roomStatuses?.get(agentName)
            if (!roomStatuses || !activeStatus) return
            // Fresh group runs remove their active session immediately after
            // emitting ready. Match the status that started the run instead of
            // consulting the already-disposed runtime session.
            if (!activeStatus.agentSessionId || activeStatus.agentSessionId !== agentSessionId) return
            roomStatuses.delete(agentName)
            if (roomStatuses.size === 0) this.contextStatusState.delete(roomId)
        } else {
            const agentMember = this.getCurrentAgentEventMember(socket, roomId, agentName, agentSessionId)
            if (!agentMember) return
            let roomStatuses = this.contextStatusState.get(roomId)
            if (!roomStatuses) {
                roomStatuses = new Map()
                this.contextStatusState.set(roomId, roomStatuses)
            }
            roomStatuses.set(agentName, {
                agentName,
                status,
                ...(agentSessionId ? { agentSessionId } : {}),
                ...(typeof data.runId === 'string' && data.runId.trim() ? { runId: data.runId.trim() } : {}),
            })
        }

        // Relay to all other sockets in the room
        socket.to(roomId).emit('context_status', {
            roomId,
            agentName,
            status,
        })
        if (typeof data.runId === 'string' && data.runId.trim()) {
            this.updateRoomAgentActivity(roomId, agentName, status, data.runId, agentSessionId)
        }
    }

    private async handleInterruptAgent(socket: Socket, data: { roomId?: string; agentName?: string }, ack?: (response?: unknown) => void): Promise<void> {
        const roomId = data.roomId
        const agentName = data.agentName
        if (!roomId || !agentName) {
            ack?.({ error: 'roomId and agentName are required' })
            return
        }
        const room = this.rooms.get(roomId)
        if (!room?.hasOnlineMember(socket.id)) {
            ack?.({ error: 'Not in room' })
            return
        }
        if (!this.canSocketInterruptAgent(socket, roomId, agentName)) {
            ack?.({ error: 'Access denied' })
            return
        }
        const activeGeneration = this.contextStatusState.get(roomId)?.get(agentName)
        const interruptedApprovals = this.takePendingApprovalsForGeneration(
            roomId,
            agentName,
            activeGeneration?.agentSessionId || '',
            activeGeneration?.runId || '',
        )
        const interruptedClarifications = this.takePendingEkkoClarificationsForGeneration(
            roomId,
            agentName,
            activeGeneration?.agentSessionId || '',
            activeGeneration?.runId || '',
        )
        try {
            await this.agentClients.interruptAgent(roomId, agentName)
            await Promise.all([
                this.settleInterruptedApprovals(interruptedApprovals),
                this.settleInterruptedEkkoClarifications(interruptedClarifications),
            ])
            const roomStatuses = this.contextStatusState.get(roomId)
            roomStatuses?.delete(agentName)
            if (roomStatuses?.size === 0) this.contextStatusState.delete(roomId)
            const agent = this.storage && typeof this.storage.getRoomAgents === 'function'
                ? this.storage.getRoomAgents(roomId).find(candidate => candidate.name === agentName)
                : null
            if (agent) this.clearRoomAgentActivities(roomId, agent.id)
            this.nsp.to(roomId).emit('context_status', { roomId, agentName, status: 'ready' })
            ack?.({ ok: true })
        } catch (err: any) {
            await Promise.all([
                this.settleInterruptedApprovals(interruptedApprovals),
                this.settleInterruptedEkkoClarifications(interruptedClarifications),
            ])
            logger.warn(`[GroupChat] failed to interrupt agent ${agentName} in room ${roomId}: ${err.message}`)
            ack?.({ error: err.message || 'interrupt failed' })
        }
    }

    private handleCancelExecutionQueueItem(
        socket: Socket,
        data: { roomId?: string; queueId?: string; executionQueueCapability?: string } | undefined,
        ack?: (response?: unknown) => void,
    ): void {
        const roomId = typeof data?.roomId === 'string' ? data.roomId.trim() : ''
        const queueId = typeof data?.queueId === 'string' ? data.queueId.trim() : ''
        const cancelCapabilityHash = executionQueueCapabilityHash(data?.executionQueueCapability)
        const joined = roomId ? this.getOnlineRoomMember(socket, roomId) : null
        if (!roomId || !queueId || !joined || joined.member.source !== 'human') {
            ack?.({ error: 'Access denied' })
            return
        }
        const authUser = socket.data?.authUser as AuthenticatedUser | undefined
        const authenticatedRequesterMemberId = typeof authUser?.id === 'number'
            ? authenticatedGroupUserId(authUser.id)
            : ''
        const accountOwnsItem = Boolean(authenticatedRequesterMemberId)
            && authenticatedRequesterMemberId === joined.member.userId
        const item = this.storage.getExecutionQueueItem(queueId)
        if (!item
            || item.roomId !== roomId
            || (item.requesterMemberId !== joined.member.userId)
            || (!accountOwnsItem
                && !executionQueueCapabilityMatches(item.cancelCapabilityHash, cancelCapabilityHash))) {
            ack?.({ error: 'Access denied' })
            return
        }
        const retracted = this.agentClients.retractQueuedMention(
            roomId,
            queueId,
            joined.member.userId,
            cancelCapabilityHash,
            accountOwnsItem,
        )
        if (!retracted) {
            ack?.({ error: 'Queue item is no longer cancellable', status: this.storage.getExecutionQueueItem(queueId)?.status })
            return
        }
        this.nsp.to(roomId).emit('message_retracted', {
            roomId,
            messageId: retracted.messageId,
            messageCount: retracted.messageCount,
            totalTokens: retracted.totalTokens,
            lastActiveAt: retracted.lastActiveAt,
        })
        this.broadcastExecutionQueue(roomId)
        this.nsp.to(roomId).emit('room_updated', {
            roomId,
            totalTokens: retracted.totalTokens,
            lastActiveAt: retracted.lastActiveAt,
        })
        ack?.({ ok: true, status: 'retracted', messageId: retracted.messageId })
    }

    private async handleRemoveAgent(
        socket: Socket,
        data: { roomId?: string; agentId?: string },
        ack?: (response?: unknown) => void,
    ): Promise<void> {
        const roomId = typeof data?.roomId === 'string' ? data.roomId.trim() : ''
        const agentId = typeof data?.agentId === 'string' ? data.agentId.trim() : ''
        if (!roomId || !agentId) {
            ack?.({ error: 'roomId and agentId are required' })
            return
        }
        const joined = this.getOnlineRoomMember(socket, roomId)
        if (!joined || joined.member.source !== 'human') {
            ack?.({ error: 'Not in room' })
            return
        }
        const agent = this.storage.getRoomAgent(roomId, agentId)
        if (!agent) {
            ack?.({ error: 'Agent not found' })
            return
        }
        if (!this.canSocketRemoveAgent(socket, roomId, agent)) {
            ack?.({ error: 'Access denied' })
            return
        }

        if (agent.executorType === 'remote' && agent.connectorId) {
            revokeGroupAgentConnector(agent.connectorId)
        }
        this.storage.removeRoomAgent(roomId, agent.id)
        this.clearRoomAgentActivities(roomId, agent.id)
        await this.agentClients.removeAgentFromRoom(roomId, agent.agentId)
        this.broadcastRoomAgents(roomId)
        ack?.({
            ok: true,
            agents: this.getRoomAgentViews(roomId, false, joined.member.userId),
            members: this.storage.getRoomMembers(roomId),
        })
    }

    private handleApprovalRequested(socket: Socket, data: { roomId?: string; agentName?: string; approval_id?: string; command?: string; description?: string; choices?: string[]; allow_permanent?: boolean; timeout_ms?: number; agentSessionId?: string; runId?: string }): void {
        const roomId = data.roomId
        const agentName = data.agentName || ''
        if (!roomId || !data.approval_id || !this.getCurrentAgentEventMember(socket, roomId, agentName, data.agentSessionId)) return
        const choices = Array.isArray(data.choices) ? data.choices : ['once', 'session', 'deny']
        const routeKey = this.pendingApprovalRouteKey(roomId, data.approval_id)
        this.takePendingApprovalRoute(routeKey)
        const pendingRoute: PendingGroupApprovalRoute = {
            roomId,
            agentName,
            ownerMemberId: this.groupAgentOwnerMemberId(roomId, agentName),
            agentSessionId: String(data.agentSessionId || '').trim(),
            runId: String(data.runId || '').trim(),
            approvalId: data.approval_id,
            command: data.command || '',
            description: data.description || '',
            choices,
            allowPermanent: Boolean(data.allow_permanent),
            timeoutMs: normalizePendingInteractionTimeout(data.timeout_ms),
            requestedAt: Date.now(),
        }
        this.pendingApprovalRoutes.set(routeKey, pendingRoute)
        this.schedulePendingApprovalExpiry(routeKey, pendingRoute)
        if (!pendingRoute.ownerMemberId) {
            logger.warn(`[GroupChat] approval ${data.approval_id} has no Agent owner in room ${roomId}`)
        }
        this.emitToAgentApprovalOwner(pendingRoute, 'approval.requested', {
            event: 'approval.requested',
            roomId,
            agentName,
            approval_id: data.approval_id,
            command: data.command || '',
            description: data.description || '',
            choices,
            allow_permanent: Boolean(data.allow_permanent),
            timeout_ms: pendingRoute.timeoutMs,
            remaining_timeout_ms: pendingRoute.timeoutMs,
            requested_at: pendingRoute.requestedAt,
        })
    }

    private takePendingApprovalsForGeneration(
        roomId: string,
        agentName: string,
        agentSessionId: string,
        runId: string,
    ): PendingGroupApprovalRoute[] {
        if (!agentSessionId || !runId || !(this.pendingApprovalRoutes instanceof Map)) return []
        const routes: PendingGroupApprovalRoute[] = []
        for (const [routeKey, route] of this.pendingApprovalRoutes) {
            if (route.roomId !== roomId
                || route.agentName !== agentName
                || route.agentSessionId !== agentSessionId
                || !route.runId
                || route.runId !== runId) {
                continue
            }
            const claimed = this.takePendingApprovalRoute(routeKey)
            if (claimed) routes.push(claimed)
        }
        return routes
    }

    private async settleInterruptedApprovals(routes: PendingGroupApprovalRoute[]): Promise<void> {
        for (const route of routes) {
            let resolved = false
            const executor = this.agentClients.getAgents(route.roomId).find(agent =>
                agent.name === route.agentName && typeof agent.respondApproval === 'function'
            )
            try {
                resolved = Boolean(await executor?.respondApproval?.(route.approvalId, 'deny'))
                if (!resolved) {
                    resolved = Boolean((await createGroupPrimaryAgentBridge().approvalRespond(route.approvalId, 'deny') as any)?.resolved)
                }
            } catch (err: any) {
                if (!isExpiredInteractionError(err?.message || err)) {
                    logger.warn(`[GroupChat] failed to cancel interrupted approval ${route.approvalId}: ${err?.message || err}`)
                }
            }
            this.emitToAgentApprovalOwner(route, 'approval.resolved', {
                event: 'approval.resolved',
                roomId: route.roomId,
                agentName: route.agentName,
                approval_id: route.approvalId,
                choice: 'deny',
                reason: 'Agent run interrupted',
                resolved,
            })
        }
    }

    private handleApprovalResolved(socket: Socket, data: { roomId?: string; agentName?: string; approval_id?: string; choice?: string; agentSessionId?: string }): void {
        const roomId = data.roomId
        const agentName = data.agentName || ''
        if (!roomId || !data.approval_id || !this.getCurrentAgentEventMember(socket, roomId, agentName, data.agentSessionId)) return
        const routeKey = this.pendingApprovalRouteKey(roomId, data.approval_id)
        const pendingRoute = this.pendingApprovalRoutes.get(routeKey)
        if (pendingRoute?.roomId === roomId && pendingRoute.agentName === agentName) {
            this.takePendingApprovalRoute(routeKey)
        }
        const ownerMemberId = pendingRoute?.ownerMemberId || this.groupAgentOwnerMemberId(roomId, agentName)
        this.emitToAgentApprovalOwner({ roomId, ownerMemberId, runId: pendingRoute?.runId }, 'approval.resolved', {
            event: 'approval.resolved',
            roomId,
            agentName,
            approval_id: data.approval_id,
            choice: data.choice || '',
        })
    }

    private async handleApprovalRespond(socket: Socket, data: { roomId?: string; approval_id?: string; choice?: string }, ack?: (response?: unknown) => void): Promise<void> {
        const roomId = data.roomId
        if (!roomId || !data.approval_id) {
            ack?.({ error: 'roomId and approval_id are required' })
            return
        }
        const room = this.rooms.get(roomId)
        if (!room) {
            ack?.({ error: 'Not in room' })
            return
        }
        const pendingRoutes = this.pendingApprovalRoutes
        if (!pendingRoutes) {
            ack?.({ error: 'Access denied' })
            return
        }
        const routeKey = this.pendingApprovalRouteKey(roomId, data.approval_id)
        const pendingRoute = pendingRoutes.get(routeKey)
        if (!pendingRoute || pendingRoute.roomId !== roomId) {
            ack?.({ error: 'Approval is not pending in this room' })
            return
        }
        if (!this.canSocketHandleAgentApproval(socket, pendingRoute)) {
            ack?.({ error: 'Access denied' })
            return
        }
        const remoteExecutor = this.agentClients.getAgents(roomId).find(agent =>
            agent.name === pendingRoute.agentName && typeof agent.respondApproval === 'function'
        )
        if (remoteExecutor?.respondApproval) {
            try {
                const resolved = await remoteExecutor.respondApproval(data.approval_id, data.choice || 'deny')
                if (resolved) {
                    this.takePendingApprovalRoute(routeKey)
                    ack?.({ ok: true, resolved: true })
                    return
                }
            } catch (err: any) {
                if (isExpiredInteractionError(err?.message || err)) {
                    this.expirePendingAgentInteractions(
                        roomId,
                        pendingRoute.agentName,
                        [data.approval_id],
                        [],
                        err?.message || 'Approval expired',
                    )
                    ack?.({ ok: true, resolved: true, stale: true })
                    return
                }
                ack?.({ error: err.message || 'approval response failed' })
                return
            }
        }
        const ekkoResult = pendingRoute.agentSessionId
            ? respondToGroupEkkoToolApproval(
                pendingRoute.agentSessionId,
                data.approval_id,
                data.choice,
            )
            : null
        if (ekkoResult?.handled) {
            if (!ekkoResult.resolved) {
                ack?.({ error: 'Approval does not belong to the active Agent session' })
                return
            }
            this.takePendingApprovalRoute(routeKey)
            ack?.({ ok: true, resolved: true })
            return
        }
        try {
            const result = await createGroupPrimaryAgentBridge().approvalRespond(data.approval_id, data.choice || 'deny')
            const resolved = Boolean((result as any)?.resolved)
            if (resolved) this.takePendingApprovalRoute(routeKey)
            ack?.({ ok: true, resolved })
        } catch (err: any) {
            logger.warn(`[GroupChat] failed to respond approval ${data.approval_id}: ${err.message}`)
            if (isExpiredInteractionError(err?.message || err)) {
                this.expirePendingAgentInteractions(
                    roomId,
                    pendingRoute.agentName,
                    [data.approval_id],
                    [],
                    err?.message || 'Approval expired',
                )
                ack?.({ ok: true, resolved: true, stale: true })
                return
            }
            ack?.({ error: err.message || 'approval response failed' })
        }
    }

    private takePendingEkkoClarificationsForGeneration(
        roomId: string,
        agentName: string,
        agentSessionId: string,
        runId: string,
    ): PendingGroupClarifyRoute[] {
        if (!agentSessionId || !runId) return []
        const ekkoExecutor = this.agentClients.getAgents(roomId).find(agent =>
            agent.name === agentName && agent.agent === 'ekko' && typeof agent.cancelClarify === 'function'
        )
        if (!ekkoExecutor) return []

        const routes: PendingGroupClarifyRoute[] = []
        for (const [routeKey, route] of this.pendingClarifyRoutes) {
            if (
                route.roomId !== roomId
                || route.agentName !== agentName
                || route.agentSessionId !== agentSessionId
                || route.runId !== runId
                || !route.runtimeRunId
            ) {
                continue
            }
            const claimed = this.takePendingClarifyRoute(routeKey)
            if (claimed) routes.push(claimed)
        }
        return routes
    }

    private async settleInterruptedEkkoClarifications(routes: PendingGroupClarifyRoute[]): Promise<void> {
        for (const route of routes) {
            const executor = this.agentClients.getAgents(route.roomId).find(agent =>
                agent.name === route.agentName && agent.agent === 'ekko' && typeof agent.cancelClarify === 'function'
            )
            let runtimeResolved = false
            try {
                runtimeResolved = Boolean(await executor?.cancelClarify?.(
                    route.clarifyId,
                    route.agentSessionId,
                    route.runtimeRunId,
                ))
            } catch (err: any) {
                logger.warn(`[GroupChat] failed to cancel interrupted Ekko clarification ${route.clarifyId}: ${err?.message || err}`)
            }
            this.emitToRoomManagers(route.roomId, 'clarify.resolved', {
                runId: route.runId,
                event: 'clarify.resolved',
                roomId: route.roomId,
                agentName: route.agentName,
                clarify_id: route.clarifyId,
                resolved: false,
                reason: 'Agent run interrupted',
                runtime_resolved: runtimeResolved,
            })
        }
    }

    private handleClarifyRequested(socket: Socket, data: { roomId?: string; agentName?: string; clarify_id?: string; question?: string; choices?: string[] | null; initial_response?: string; response_mode?: string; timeout_ms?: number; agentSessionId?: string; runId?: string; runtimeRunId?: string }): void {
        const roomId = data.roomId
        const agentName = data.agentName || ''
        if (!roomId || !data.clarify_id || !this.getCurrentAgentEventMember(socket, roomId, agentName, data.agentSessionId)) return
        const timeoutMs = normalizePendingInteractionTimeout(data.timeout_ms)
        const routeKey = this.pendingClarifyRouteKey(roomId, data.clarify_id)
        this.takePendingClarifyRoute(routeKey)
        const route: PendingGroupClarifyRoute = {
            roomId,
            agentName,
            agentSessionId: String(data.agentSessionId || '').trim(),
            runId: String(data.runId || '').trim(),
            runtimeRunId: String(data.runtimeRunId || '').trim(),
            clarifyId: data.clarify_id,
            question: data.question || '',
            choices: Array.isArray(data.choices) ? data.choices.map(String) : null,
            initialResponse: String(data.initial_response || '').slice(0, 20_000),
            responseMode: ['select', 'input', 'editor'].includes(String(data.response_mode || ''))
                ? String(data.response_mode)
                : '',
            timeoutMs,
            requestedAt: Date.now(),
        }
        this.pendingClarifyRoutes.set(routeKey, route)
        this.schedulePendingClarifyExpiry(routeKey, route)
        this.emitToRoomManagers(roomId, 'clarify.requested', {
            runId: route.runId,
            event: 'clarify.requested',
            roomId,
            agentName,
            clarify_id: route.clarifyId,
            question: route.question,
            choices: route.choices,
            initial_response: route.initialResponse,
            response_mode: route.responseMode,
            timeout_ms: route.timeoutMs,
            remaining_timeout_ms: route.timeoutMs,
            requested_at: route.requestedAt,
        })
    }

    private handleClarifyResolved(socket: Socket, data: { roomId?: string; agentName?: string; clarify_id?: string; resolved?: boolean; reason?: string; agentSessionId?: string }): void {
        const roomId = data.roomId
        const agentName = data.agentName || ''
        if (!roomId || !data.clarify_id || !this.getCurrentAgentEventMember(socket, roomId, agentName, data.agentSessionId)) return
        const route = this.takePendingClarifyRoute(this.pendingClarifyRouteKey(roomId, data.clarify_id))
        if (!route || route.agentName !== agentName) return
        this.emitToRoomManagers(roomId, 'clarify.resolved', {
            runId: route.runId,
            event: 'clarify.resolved',
            roomId,
            agentName,
            clarify_id: data.clarify_id,
            resolved: data.resolved !== false,
            reason: data.reason || '',
        })
    }

    private async handleClarifyRespond(socket: Socket, data: { roomId?: string; clarify_id?: string; response?: string }, ack?: (response?: unknown) => void): Promise<void> {
        const roomId = data.roomId
        if (!roomId || !data.clarify_id) {
            ack?.({ error: 'roomId and clarify_id are required' })
            return
        }
        if (!this.rooms.get(roomId)) {
            ack?.({ error: 'Not in room' })
            return
        }
        if (!this.canSocketManageRoom(socket, roomId)) {
            ack?.({ error: 'Access denied' })
            return
        }
        const routeKey = this.pendingClarifyRouteKey(roomId, data.clarify_id)
        const pendingRoute = this.pendingClarifyRoutes.get(routeKey)
        if (!pendingRoute || pendingRoute.roomId !== roomId) {
            ack?.({ error: 'Clarification is not pending in this room' })
            return
        }
        const response = typeof data.response === 'string' ? data.response : String(data.response ?? '')
        const remoteExecutor = this.agentClients.getAgents(roomId).find(agent =>
            agent.name === pendingRoute.agentName && typeof agent.respondClarify === 'function'
        )
        if (remoteExecutor?.respondClarify) {
            try {
                const resolved = await remoteExecutor.respondClarify(data.clarify_id, response)
                if (resolved) {
                    this.takePendingClarifyRoute(routeKey)
                    ack?.({ ok: true, resolved: true })
                    return
                }
            } catch (err: any) {
                if (isExpiredInteractionError(err?.message || err)) {
                    this.expirePendingAgentInteractions(
                        roomId,
                        pendingRoute.agentName,
                        [],
                        [data.clarify_id],
                        err?.message || 'Clarification expired',
                    )
                    ack?.({ ok: true, resolved: true, stale: true })
                    return
                }
                ack?.({ error: err.message || 'clarification response failed' })
                return
            }
        }
        const ekkoResult = pendingRoute.agentSessionId
            ? respondToGroupEkkoClarification(pendingRoute.agentSessionId, data.clarify_id, response)
            : null
        if (ekkoResult?.handled) {
            if (!ekkoResult.resolved) {
                ack?.({ error: 'Clarification does not belong to the active Agent session' })
                return
            }
            this.takePendingClarifyRoute(routeKey)
            ack?.({ ok: true, resolved: true })
            return
        }
        try {
            const result = await createGroupPrimaryAgentBridge().clarifyRespond(data.clarify_id, response)
            const resolved = Boolean((result as any)?.resolved)
            if (resolved) this.takePendingClarifyRoute(routeKey)
            ack?.({ ok: true, resolved })
        } catch (err: any) {
            logger.warn(`[GroupChat] failed to respond clarification ${data.clarify_id}: ${err.message}`)
            if (isExpiredInteractionError(err?.message || err)) {
                this.expirePendingAgentInteractions(
                    roomId,
                    pendingRoute.agentName,
                    [],
                    [data.clarify_id],
                    err?.message || 'Clarification expired',
                )
                ack?.({ ok: true, resolved: true, stale: true })
                return
            }
            ack?.({ error: err.message || 'clarification response failed' })
        }
    }

    expirePendingAgentInteractions(
        roomId: string,
        agentName: string,
        approvalIds: string[],
        clarifyIds: string[],
        reason: string,
    ): void {
        const boundedReason = String(reason || 'Pending interaction expired').slice(0, 500)
        for (const approvalId of new Set(approvalIds)) {
            const routeKey = this.pendingApprovalRouteKey(roomId, approvalId)
            const route = this.pendingApprovalRoutes.get(routeKey)
            if (!route || route.agentName !== agentName) continue
            this.takePendingApprovalRoute(routeKey)
            this.emitToAgentApprovalOwner(route, 'approval.resolved', {
                event: 'approval.resolved',
                roomId,
                agentName,
                approval_id: approvalId,
                choice: 'deny',
                reason: boundedReason,
            })
        }
        for (const clarifyId of new Set(clarifyIds)) {
            const routeKey = this.pendingClarifyRouteKey(roomId, clarifyId)
            const route = this.pendingClarifyRoutes.get(routeKey)
            if (!route || route.agentName !== agentName) continue
            this.takePendingClarifyRoute(routeKey)
            this.emitToRoomManagers(roomId, 'clarify.resolved', {
                runId: route.runId,
                event: 'clarify.resolved',
                roomId,
                agentName,
                clarify_id: clarifyId,
                resolved: false,
                reason: boundedReason,
            })
        }
    }

    private clearPendingApprovalRoutes(roomId: string): void {
        const pendingRoutes = this.pendingApprovalRoutes
        if (!pendingRoutes) return
        for (const [routeKey, route] of pendingRoutes) {
            if (route.roomId === roomId) this.takePendingApprovalRoute(routeKey)
        }
    }

    private clearPendingClarifyRoutes(roomId: string): void {
        const pendingRoutes = this.pendingClarifyRoutes
        if (!pendingRoutes) return
        for (const [routeKey, route] of pendingRoutes) {
            if (route.roomId === roomId) this.takePendingClarifyRoute(routeKey)
        }
    }

    private handleDisconnect(socket: Socket): void {
        const socketId = socket.id
        const userId = this.socketUserMap.get(socketId)
        const userName = userId ? this.userInfoMap.get(userId)?.name : undefined
        const inviteGuestRoomId = typeof socket.data?.inviteGuestRoomId === 'string'
            ? socket.data.inviteGuestRoomId
            : ''
        if (userId && inviteGuestRoomId) {
            const key = `${inviteGuestRoomId}\u0000${userId}`
            if (this.guestAgentRequestTokens.get(key)?.socketId === socketId) {
                this.guestAgentRequestTokens.delete(key)
            }
        }

        logger.debug(`[GroupChat] Disconnected: ${userName || socketId} (socket=${socketId}, user=${userId || socketId})`)

        // Clean up typing state for this socket
        for (const [roomId, roomTyping] of this.typingState) {
            const entry = roomTyping.get(userId || socketId)
            if (entry?.socketId === socketId) {
                clearTimeout(entry.timer)
                roomTyping.delete(userId || socketId)
                if (roomTyping.size === 0) this.typingState.delete(roomId)
                this.nsp.to(roomId).emit('stop_typing', {
                    roomId,
                    userId: userId || socketId,
                })
            }
        }

        if (this.socketRequestedSourceMap.get(socketId) === 'agent') {
            for (const [roomId, room] of this.rooms) {
                const member = room.getOnlineMemberBySocketId(socketId)
                if (member?.source !== 'agent') continue
                const roomAgent = this.storage.getRoomAgentByAgentId(roomId, member.userId)
                if (roomAgent) this.clearRoomAgentActivities(roomId, roomAgent.id)
                const roomStatuses = this.contextStatusState.get(roomId)
                roomStatuses?.delete(member.name)
                if (roomStatuses?.size === 0) this.contextStatusState.delete(roomId)
                this.nsp.to(roomId).emit('context_status', {
                    roomId,
                    agentName: member.name,
                    status: 'ready',
                })
            }
        }

        this.leaveAllRooms(socket, socketId)
        this.socketUserMap.delete(socketId)
        this.socketRequestedSourceMap.delete(socketId)
        this.socketAuthUserIdMap.delete(socketId)
        // Don't delete userInfoMap — it persists across reconnects
    }

    // ─── Helpers ────────────────────────────────────────────────

    private getTypingUsers(roomId: string): Array<{ userId: string; userName: string }> {
        const roomTyping = this.typingState.get(roomId)
        if (!roomTyping) return []
        return Array.from(roomTyping.entries()).map(([userId, entry]) => ({ userId, userName: entry.userName }))
    }

    private getContextStatuses(roomId: string): Array<{ agentName: string; status: string }> {
        const roomStatuses = this.contextStatusState.get(roomId)
        if (!roomStatuses) return []
        return Array.from(roomStatuses.values()).map(({ agentName, status }) => ({ agentName, status }))
    }

    private leaveAllRooms(socket: Socket, socketId: string): void {
        this.rooms.forEach((room, rid) => {
            if (room.hasOnlineMember(socketId)) {
                const member = room.getOnlineMemberBySocketId(socketId)
                room.removeMember(socketId)
                socket.leave(rid)
                if (member?.source !== 'agent' && !member?.online) {
                    this.nsp.to(rid).emit('member_left', {
                        roomId: rid,
                        memberId: member?.userId || socketId,
                        memberName: member?.name || `User-${socketId.slice(0, 6)}`,
                        members: this.getRoomMemberViews(rid, room),
                    })
                }
            }
        })
    }

    private generateId(): string {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
    }

    private normalizeClientMessageId(id?: string): string | null {
        const cleaned = String(id || '').trim()
        if (!cleaned || cleaned.length > 160) return null
        return /^[a-zA-Z0-9_-]+$/.test(cleaned) ? cleaned : null
    }

    private normalizeMessageTimestamp(timestamp?: unknown, role?: unknown): number {
        const normalizedRole = normalizeMessageRole(role)
        if (normalizedRole !== 'user') {
            const value = Number(timestamp)
            if (Number.isFinite(value) && value > 0) return value
        }
        return Date.now()
    }
}
