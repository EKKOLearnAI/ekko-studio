import { parseGroupTaskPlanMessage, isOlderGroupTaskPlan } from '@/utils/task-plan'
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useSettingsStore } from './settings'
import { primeCompletionSound } from '@/utils/completion-sound'
import {
    isPendingInteractionExpiredError,
    notifyPendingInteractionExpired,
    pendingInteractionDeadline,
    type PendingInteractionSubmitResult,
} from '@/utils/pending-interaction'
import { getActiveProfileName, getStoredUsername } from '@/api/client'
import { fetchCurrentUser } from '@/api/studio/auth'
import { formatMessageWithReference, type Attachment, type ContentBlock, type MessageReference } from './chat'
import {
    connectGroupChat,
    disconnectGroupChat,
    getSocket,
    getStoredUserId,
    getStoredUserName,
    type RoomInfo,
    type RoomAgent,
    type RoomAgentSummary,
    type GroupAgentActivity,
    type GroupMessageRoutingDecision,
    type RoomAgentHandoffChain,
    type RoomAgentInput,
    type RoomSummaryConfig,
    type RoomSummaryState,
    type RoomSummaryReview,
    type ChatMessage,
    type GroupChatMention,
    type GroupExecutionQueueItem,
    type GroupWorkspaceDiffPayload,
    type MemberInfo,
    createRoom,
    listRooms,
    getRoomDetail,
    joinRoomByCode,
    addAgent,
    updateAgent,
    listAgents,
    removeAgent,
    removeRoomMember as removeRoomMemberApi,
    cloneRoom as cloneRoomApi,
    deleteRoom as deleteRoomApi,
    clearRoomContext,
    updateInviteCode as updateInviteCodeApi,
    updateRoomWorkspace as updateRoomWorkspaceApi,
} from '@/api/studio/group-chat'
import {
    getGroupChatAttachmentUrl,
    uploadGroupChatAttachments,
} from '@/api/studio/group-chat-attachments'
import { groupMessageAgent } from '@/utils/group-agent-avatar'

type GroupChatSocket = ReturnType<typeof connectGroupChat>
export const GROUP_CHAT_MEMBER_REMOVED = 'ROOM_MEMBER_REMOVED'

async function uploadGroupFiles(
    attachments: Attachment[],
    roomId: string,
    inviteCode = '',
): Promise<{ name: string; path: string }[]> {
    return uploadGroupChatAttachments({ roomId, inviteCode: inviteCode || undefined }, attachments)
}

function buildGroupContentBlocks(content: string, attachments: Attachment[], files: { name: string; path: string }[]): ContentBlock[] {
    const blocks: ContentBlock[] = []
    if (content.trim()) blocks.push({ type: 'text', text: content.trim() })
    for (let i = 0; i < files.length; i += 1) {
        const file = files[i]
        const attachment = attachments[i]
        if (attachment?.type.startsWith('image/')) {
            blocks.push({
                type: 'image',
                name: file.name,
                path: file.path,
                media_type: attachment.type,
            })
        } else {
            blocks.push({
                type: 'file',
                name: file.name,
                path: file.path,
                media_type: attachment?.type,
            })
        }
    }
    return blocks
}

function uid(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

const STREAM_FINAL_CONTENT_RECOVERY_DELAY_MS = 300
export const GROUP_CHAT_STREAM_FLUSH_INTERVAL_MS = 50
export const GROUP_CHAT_MESSAGE_PAGE_SIZE = 150
const GROUP_CHAT_JOIN_TIMEOUT_MS = 30000
const GROUP_CHAT_TYPING_HEARTBEAT_MS = 2500
const GROUP_CHAT_TYPING_IDLE_MS = 4000
const GROUP_CHAT_REMOTE_TYPING_TTL_MS = 5000
const GROUP_CHAT_EXECUTION_QUEUE_CAPABILITY_PREFIX = 'gc_execution_queue_capability:'

function normalizeLocalFilePath(path: string): string {
    return /^[a-zA-Z]:\\/.test(path) ? path.replace(/\\/g, '/') : path
}

function hasText(value?: string | null): boolean {
    return !!value?.trim()
}

function executionQueueCapability(roomId: string): string {
    const key = `${GROUP_CHAT_EXECUTION_QUEUE_CAPABILITY_PREFIX}${roomId}`
    const stored = localStorage.getItem(key)
    if (stored && /^[a-f0-9]{64}$/i.test(stored)) return stored.toLowerCase()
    const bytes = new Uint8Array(32)
    globalThis.crypto.getRandomValues(bytes)
    const capability = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
    localStorage.setItem(key, capability)
    return capability
}

function authenticatedGroupUserId(authUserId: number): string {
    return `auth:${authUserId}`
}

function getStoredGroupUserName(): string {
    return getStoredUserName()?.trim() || ''
}

function getStoredGroupUserAvatar(): string {
    return localStorage.getItem('gc_user_avatar')?.trim() || ''
}

function hasToolCalls(message: ChatMessage): boolean {
    return !!message.tool_calls?.length
}

function needsFinalContentRecovery(message: ChatMessage): boolean {
    return message.role === 'assistant' && !hasText(message.content) && hasText(message.reasoning) && !hasToolCalls(message)
}

function mergeFinalMessage(existing: ChatMessage | null, msg: ChatMessage): ChatMessage {
    if (existing && isOlderGroupTaskPlan(existing, msg)) return existing
    return {
        ...msg,
        content: hasText(msg.content) ? msg.content : existing?.content || msg.content || '',
        reasoning: hasText(msg.reasoning) ? msg.reasoning : existing?.reasoning ?? msg.reasoning ?? null,
        reasoning_content: hasText(msg.reasoning_content) ? msg.reasoning_content : existing?.reasoning_content ?? msg.reasoning_content ?? null,
        isStreaming: false,
        firstSeenAt: existing?.firstSeenAt ?? msg.firstSeenAt,
        attachments: existing?.attachments || msg.attachments,
    }
}

export interface GroupPendingApproval {
    roomId: string
    agentName: string
    approvalId: string
    command: string
    description: string
    choices: Array<'once' | 'session' | 'always' | 'deny'>
    allowPermanent: boolean
    isMemoryWrite: boolean
    requestedAt: number
    countdownDeadline: number
}

export interface GroupPendingClarify {
    roomId: string
    agentName: string
    clarifyId: string
    question: string
    choices: string[] | null
    initialResponse: string
    responseMode: string
    timeoutMs: number
    requestedAt: number
    countdownDeadline: number
}

export const useGroupChatStore = defineStore('groupChat', () => {
    // ─── State ─────────────────────────────────────────────
    const connected = ref(false)
    const currentRoomId = ref<string | null>(null)
    const rooms = ref<RoomInfo[]>([])
    const messages = ref<ChatMessage[]>([])
    const pendingStreamDeltas = new Map<string, {
        roomId: string
        messageId: string
        content: string
        reasoning: string
    }>()
    let streamFlushTimer: ReturnType<typeof setTimeout> | null = null
    const messageReferences = ref<Map<string, MessageReference>>(new Map())
    const activeMessageReference = computed(() => {
        const roomId = currentRoomId.value
        return roomId ? messageReferences.value.get(roomId) || null : null
    })
    const members = ref<MemberInfo[]>([])
    const agents = ref<RoomAgent[]>([])
    const roomName = ref('')
    const isJoining = ref(false)
    const error = ref<string | null>(null)
    const typingUsers = ref<Map<string, { name: string; timer: ReturnType<typeof setTimeout>; sequence: number }>>(new Map())
    let remoteTypingSequence = 0
    const realtimeJoinedRoomId = ref<string | null>(null)
    const realtimeJoinedSocketId = ref<string | null>(null)
    const contextStatuses = ref<Map<string, { agentName: string; status: string }>>(new Map())
    const activeAgentRuns = ref<Map<string, GroupAgentActivity>>(new Map())
    const roomSummaryStates = ref<Map<string, RoomSummaryState>>(new Map())
    const roomSummaryReviews = ref<Map<string, RoomSummaryReview>>(new Map())
    const handoffChains = ref<Map<string, RoomAgentHandoffChain>>(new Map())
    const executionQueue = ref<GroupExecutionQueueItem[]>([])
    const messageRoutingDecisions = ref<Map<string, GroupMessageRoutingDecision>>(new Map())
    const autoPlaySpeechEnabled = ref(false)
    const pendingApprovals = ref<Map<string, GroupPendingApproval>>(new Map())
    const pendingClarifies = ref<Map<string, GroupPendingClarify>>(new Map())

    function pendingApprovalKey(roomId: string, approvalId: string): string {
        return `${roomId}:${approvalId}`
    }
    function pendingClarifyKey(roomId: string, clarifyId: string): string {
        return `${roomId}:${clarifyId}`
    }
    const totalMessages = ref(0)
    const loadedMessageCount = ref(0)
    const hasMoreBefore = ref(false)
    const isLoadingOlderMessages = ref(false)
    const olderMessagesError = ref<string | null>(null)
    const currentUserAvatar = ref('')
    const inviteGuest = ref(false)
    const activeInviteCode = ref('')
    const agentLinkToken = ref('')
    const agentPairingRevision = ref(0)
    const historicalMessageAgents = ref<RoomAgent[]>([])
    const messageAgents = computed(() => {
        const activeIds = new Set(agents.value.map(agent => agent.id))
        return [
            ...agents.value,
            ...historicalMessageAgents.value.filter(agent => !activeIds.has(agent.id)),
        ]
    })

    function resetMessagePaging() {
        totalMessages.value = 0
        loadedMessageCount.value = 0
        hasMoreBefore.value = false
        isLoadingOlderMessages.value = false
        olderMessagesError.value = null
    }

    function streamDeltaKey(roomId: string, messageId: string): string {
        return `${roomId}\u0000${messageId}`
    }

    function clearStreamFlushTimer() {
        if (streamFlushTimer === null) return
        clearTimeout(streamFlushTimer)
        streamFlushTimer = null
    }

    function clearPendingStreamDeltas() {
        clearStreamFlushTimer()
        pendingStreamDeltas.clear()
    }

    function flushPendingStreamDeltas(roomId?: string, messageId?: string) {
        const entries = Array.from(pendingStreamDeltas.entries()).filter(([, pending]) => (
            (!roomId || pending.roomId === roomId) &&
            (!messageId || pending.messageId === messageId)
        ))
        for (const [key, pending] of entries) {
            pendingStreamDeltas.delete(key)
            if (pending.roomId !== currentRoomId.value) continue
            const message = messages.value.find(item => item.id === pending.messageId)
            if (!message?.isStreaming) continue
            if (pending.content) message.content = (message.content || '') + pending.content
            if (pending.reasoning) {
                message.reasoning = (message.reasoning || '') + pending.reasoning
                message.reasoning_content = (message.reasoning_content || '') + pending.reasoning
            }
        }
        if (pendingStreamDeltas.size === 0) clearStreamFlushTimer()
    }

    function scheduleStreamDeltaFlush() {
        if (streamFlushTimer !== null) return
        streamFlushTimer = setTimeout(() => {
            streamFlushTimer = null
            flushPendingStreamDeltas()
        }, GROUP_CHAT_STREAM_FLUSH_INTERVAL_MS)
    }

    function queueStreamDelta(
        data: { roomId: string; id: string; delta: string },
        field: 'content' | 'reasoning',
    ) {
        if (data.roomId !== currentRoomId.value || !data.delta) return
        const message = messages.value.find(item => item.id === data.id)
        if (!message?.isStreaming) return
        const key = streamDeltaKey(data.roomId, data.id)
        const pending = pendingStreamDeltas.get(key) || {
            roomId: data.roomId,
            messageId: data.id,
            content: '',
            reasoning: '',
        }
        pending[field] += data.delta
        pendingStreamDeltas.set(key, pending)
        scheduleStreamDeltaFlush()
    }

    function applyMessagePaging(res: { messages: ChatMessage[]; total?: number; hasMore?: boolean }) {
        loadedMessageCount.value = res.messages.length
        totalMessages.value = res.total ?? res.messages.length
        hasMoreBefore.value = res.hasMore ?? loadedMessageCount.value < totalMessages.value
    }

    function setAutoPlaySpeech(enabled: boolean) {
        autoPlaySpeechEnabled.value = enabled
    }

    function sortRoomsByActivity() {
        rooms.value = [...rooms.value].sort((a, b) =>
            Number(b.lastActiveAt || b.createdAt || 0) - Number(a.lastActiveAt || a.createdAt || 0)
            || Number(b.createdAt || 0) - Number(a.createdAt || 0)
            || b.id.localeCompare(a.id),
        )
    }

    function recordPersistedRoomActivity(roomId: string, timestamp: number) {
        const room = rooms.value.find(item => item.id === roomId)
        if (!room || !Number.isFinite(timestamp)) return
        room.lastActiveAt = Math.max(Number(room.lastActiveAt || room.createdAt || 0), timestamp)
        sortRoomsByActivity()
    }

    function setMessageReference(roomId: string, reference: MessageReference) {
        const next = new Map(messageReferences.value)
        next.set(roomId, reference)
        messageReferences.value = next
    }

    function clearMessageReference(roomId: string) {
        if (!messageReferences.value.has(roomId)) return
        const next = new Map(messageReferences.value)
        next.delete(roomId)
        messageReferences.value = next
    }

    function playMessageSpeech(messageId: string, content: string, profile: string) {
        window.dispatchEvent(new CustomEvent('auto-play-speech', {
            detail: { messageId, content, profile },
        }))
    }

    async function recoverMissingFinalContent(roomId: string, messageId: string) {
        if (inviteGuest.value) return
        if (currentRoomId.value !== roomId) return
        const idx = messages.value.findIndex(m => m.id === messageId)
        if (idx < 0 || !needsFinalContentRecovery(messages.value[idx])) return

        try {
            const res = await getRoomDetail(roomId)
            const recovered = res.messages.find(m => m.id === messageId)
            if (!recovered || !hasText(recovered.content)) return

            const currentIdx = messages.value.findIndex(m => m.id === messageId)
            if (currentIdx < 0 || !needsFinalContentRecovery(messages.value[currentIdx])) return
            messages.value[currentIdx] = mergeFinalMessage(messages.value[currentIdx], recovered)
            messages.value = [...messages.value]
        } catch {
            // Keep the reasoning-only bubble visible; a later final message event can still merge it.
        }
    }

    function scheduleMissingFinalContentRecovery(roomId: string, messageId: string) {
        setTimeout(() => {
            void recoverMissingFinalContent(roomId, messageId)
        }, STREAM_FINAL_CONTENT_RECOVERY_DELAY_MS)
    }

    function settleAgentActivity(agentName: string) {
        flushPendingStreamDeltas(currentRoomId.value || undefined)
        contextStatuses.value.delete(agentName)
        messages.value = messages.value
            .map(m => (
                m.senderName === agentName && m.isStreaming
                    ? { ...m, isStreaming: false }
                    : m
            ))
            .filter(m => !(
                m.senderName === agentName &&
                m.role !== 'tool' &&
                !m.content?.trim() &&
                !m.reasoning?.trim() &&
                !m.tool_calls?.length
            ))
        contextStatuses.value = new Map(contextStatuses.value)
    }

    function activeAgentRunKey(roomId: string, agentId: string, runId: string): string {
        return `${roomId}\u0000${agentId}\u0000${runId}`
    }

    function replaceActiveAgentRuns(activities: unknown): void {
        const next = new Map<string, GroupAgentActivity>()
        if (Array.isArray(activities)) {
            for (const activity of activities) {
                if (
                    !activity ||
                    typeof activity.roomId !== 'string' ||
                    typeof activity.agentId !== 'string' ||
                    typeof activity.runId !== 'string' ||
                    (activity.status !== 'compressing' && activity.status !== 'replying')
                ) continue
                next.set(
                    activeAgentRunKey(activity.roomId, activity.agentId, activity.runId),
                    activity as GroupAgentActivity,
                )
            }
        }
        activeAgentRuns.value = next
    }

    function applyActiveAgentRun(activity: GroupAgentActivity): void {
        if (!activity.roomId || !activity.agentId || !activity.runId) return
        const key = activeAgentRunKey(activity.roomId, activity.agentId, activity.runId)
        const next = new Map(activeAgentRuns.value)
        if (activity.status === 'ready') next.delete(key)
        else next.set(key, activity)
        activeAgentRuns.value = next
    }

    function clearActiveAgentRunsForRoom(roomId: string, agentId?: string): void {
        const next = new Map(activeAgentRuns.value)
        for (const [key, activity] of next) {
            if (activity.roomId === roomId && (!agentId || activity.agentId === agentId)) {
                next.delete(key)
            }
        }
        activeAgentRuns.value = next
    }

    function activeAgentRunsForRoom(roomId: string): GroupAgentActivity[] {
        return [...activeAgentRuns.value.values()].filter(activity => activity.roomId === roomId)
    }

    function activeAgentIdsForRoom(roomId: string): string[] {
        return [...new Set(activeAgentRunsForRoom(roomId).map(activity => activity.agentId))]
    }

    function isAgentRunActive(roomId: string, agentId: string, runId: string | null | undefined): boolean {
        if (!roomId || !agentId || !runId) return false
        return activeAgentRuns.value.has(activeAgentRunKey(roomId, agentId, runId))
    }

    // Computed: returns first active status for backward compat
    const contextStatus = computed(() => {
        for (const [, status] of contextStatuses.value) {
            return status
        }
        return null
    })
    const activePendingApproval = computed(() => {
        if (!currentRoomId.value) return null
        for (const approval of pendingApprovals.value.values()) {
            if (approval.roomId === currentRoomId.value) return approval
        }
        return null
    })
    const activePendingClarify = computed(() => {
        if (!currentRoomId.value) return null
        for (const clarify of pendingClarifies.value.values()) {
            if (clarify.roomId === currentRoomId.value) return clarify
        }
        return null
    })

    function upsertPendingApproval(data: { roomId: string; agentName?: string; approval_id?: string; command?: string; description?: string; choices?: string[]; allow_permanent?: boolean; timeout_ms?: number; remaining_timeout_ms?: number; requested_at?: number }) {
        if (!data.roomId || !data.approval_id) return
        const description = data.description || ''
        const normalizedDescription = description.trim().toLowerCase().replace(/\s+/g, ' ')
        const isMemoryWrite = !Boolean(data.allow_permanent) && (
            normalizedDescription === 'save to memory' ||
            normalizedDescription.startsWith('save to memory:') ||
            normalizedDescription.startsWith('save to memory?')
        )
        const choices = (Array.isArray(data.choices) ? data.choices : ['once', 'session', 'deny'])
            .filter((choice): choice is GroupPendingApproval['choices'][number] =>
                choice === 'once' || choice === 'session' || choice === 'always' || choice === 'deny')
        pendingApprovals.value.set(pendingApprovalKey(data.roomId, data.approval_id), {
            roomId: data.roomId,
            agentName: data.agentName || '',
            approvalId: data.approval_id,
            command: data.command || '',
            description,
            choices: isMemoryWrite ? ['once', 'deny'] : choices.length ? choices : ['once', 'session', 'deny'],
            allowPermanent: Boolean(data.allow_permanent),
            isMemoryWrite,
            requestedAt: Number(data.requested_at) || Date.now(),
            countdownDeadline: pendingInteractionDeadline(data.remaining_timeout_ms, data.timeout_ms),
        })
    }

    function upsertPendingClarify(data: { roomId: string; agentName?: string; clarify_id?: string; question?: string; choices?: string[] | null; initial_response?: string; response_mode?: string; timeout_ms?: number; remaining_timeout_ms?: number; requested_at?: number }) {
        if (!data.roomId || !data.clarify_id) return
        pendingClarifies.value.set(pendingClarifyKey(data.roomId, data.clarify_id), {
            roomId: data.roomId,
            agentName: data.agentName || '',
            clarifyId: data.clarify_id,
            question: data.question || '',
            choices: Array.isArray(data.choices) ? data.choices.map(String) : null,
            initialResponse: String(data.initial_response || ''),
            responseMode: String(data.response_mode || ''),
            timeoutMs: Number(data.timeout_ms) || 300_000,
            requestedAt: Number(data.requested_at) || Date.now(),
            countdownDeadline: pendingInteractionDeadline(data.remaining_timeout_ms, data.timeout_ms),
        })
    }

    function replaceRoomPendingInteractions(roomId: string, approvals: unknown, clarifies: unknown) {
        for (const [key, pending] of pendingApprovals.value) {
            if (pending.roomId === roomId) pendingApprovals.value.delete(key)
        }
        for (const [key, pending] of pendingClarifies.value) {
            if (pending.roomId === roomId) pendingClarifies.value.delete(key)
        }
        if (Array.isArray(approvals)) {
            for (const pending of approvals) upsertPendingApproval(pending as any)
        }
        if (Array.isArray(clarifies)) {
            for (const pending of clarifies) upsertPendingClarify(pending as any)
        }
        pendingApprovals.value = new Map(pendingApprovals.value)
        pendingClarifies.value = new Map(pendingClarifies.value)
    }

    function replacePendingApprovalSnapshots(approvals: unknown) {
        if (!Array.isArray(approvals)) return
        pendingApprovals.value.clear()
        for (const pending of approvals) upsertPendingApproval(pending as any)
        pendingApprovals.value = new Map(pendingApprovals.value)
    }
    const userId = ref(getStoredUserId())
    const userName = ref(getStoredGroupUserName() || getStoredUsername() || '')

    function upsertRoom(room: RoomInfo | undefined | null) {
        if (!room) return
        const idx = rooms.value.findIndex(existing => existing.id === room.id)
        if (idx >= 0) rooms.value[idx] = room
        else rooms.value.push(room)
    }

    function summarizeRoomAgents(roomAgents: RoomAgent[]): RoomAgentSummary[] {
        return roomAgents.map(({ id, roomId, agentId, agent, name, avatar }) => ({
            id,
            roomId,
            agentId,
            agent,
            name,
            avatar,
        }))
    }

    function projectRoomAgents(roomId: string, roomAgents: RoomAgent[]) {
        const room = rooms.value.find(candidate => candidate.id === roomId)
        if (!room) return
        room.agents = summarizeRoomAgents(roomAgents)
        rooms.value = [...rooms.value]
    }

    function roomAgentsForRoom(roomId: string): RoomAgentSummary[] {
        if (roomId === currentRoomId.value) return summarizeRoomAgents(agents.value)
        return rooms.value.find(room => room.id === roomId)?.agents || []
    }

    function clearRemoteTypingState() {
        for (const entry of typingUsers.value.values()) clearTimeout(entry.timer)
        typingUsers.value = new Map()
    }

    function refreshRemoteTypingUser(userId: string, userName: string) {
        const existing = typingUsers.value.get(userId)
        if (existing) clearTimeout(existing.timer)
        const sequence = ++remoteTypingSequence
        const timer = setTimeout(() => {
            if (typingUsers.value.get(userId)?.sequence !== sequence) return
            typingUsers.value.delete(userId)
            typingUsers.value = new Map(typingUsers.value)
        }, GROUP_CHAT_REMOTE_TYPING_TTL_MS)
        typingUsers.value.set(userId, { name: userName, timer, sequence })
        typingUsers.value = new Map(typingUsers.value)
    }

    function isUserTyping(memberUserId: string) {
        return typingUsers.value.has(memberUserId)
    }

    function applyRoomSummaryState(summary: RoomSummaryState) {
        if (!summary?.roomId) return
        const previous = roomSummaryStates.value.get(summary.roomId)
        if (previous && (previous.version > summary.version
            || (previous.version === summary.version && previous.updatedAt > summary.updatedAt))) return
        roomSummaryStates.value.set(summary.roomId, summary)
        roomSummaryStates.value = new Map(roomSummaryStates.value)
    }

    async function acceptRoutingSuggestion(messageId: string): Promise<void> {
        const socket = getSocket(); const roomId = currentRoomId.value
        if (!socket || !roomId) throw new Error('Group chat socket not connected')
        await new Promise<void>((resolve, reject) => socket.emit('accept_routing_suggestion', { roomId, messageId }, (res?: { ok?: boolean; error?: string }) => res?.ok ? resolve() : reject(new Error(res?.error || 'Suggestion failed'))))
    }

    function applyRoomSummaryReview(review: RoomSummaryReview) {
        if (!review?.roomId) return
        const previous = roomSummaryReviews.value.get(review.roomId)
        if (previous && (previous.createdAt > review.createdAt || previous.sourceVersion > review.sourceVersion)) return
        roomSummaryReviews.value.set(review.roomId, review)
        roomSummaryReviews.value = new Map(roomSummaryReviews.value)
    }

    function clearCurrentRoomTransientState() {
        emitStopTyping()
        clearRemoteTypingState()
        contextStatuses.value.clear()
        executionQueue.value = []
    }

    function snapshotCurrentMessageAgents(roomAgents: RoomAgent[]) {
        if (!roomAgents.length || !messages.value.length) return
        const historicalById = new Map(historicalMessageAgents.value.map(agent => [agent.id, agent]))
        for (const agent of roomAgents) {
            historicalById.set(agent.id, {
                ...agent,
                connectionStatus: 'offline',
                historical: true,
            })
        }
        historicalMessageAgents.value = [...historicalById.values()]
        let changed = false
        messages.value = messages.value.map((chatMessage) => {
            const agent = roomAgents.find(candidate =>
                candidate.id === chatMessage.senderAgentRecordId
                || candidate.agentId === chatMessage.senderId
                || candidate.name === chatMessage.senderName
            )
            if (!agent) return chatMessage
            changed = true
            return {
                ...chatMessage,
                senderType: 'agent',
                senderAgentRecordId: agent.id,
                senderAvatar: agent.avatar || '',
                senderAgentType: agent.agent,
                senderAgentProfile: agent.profile || '',
                senderAgentProvider: agent.provider || '',
                senderAgentModel: agent.model || '',
                senderAgentDescription: agent.description || '',
                senderOwnerMemberId: agent.ownerMemberId || '',
            }
        })
        if (!changed) return
        messages.value = [...messages.value]
    }

    function mergeRoomAgentRoster(nextAgents: RoomAgent[], previousAgents = agents.value) {
        const previousById = new Map(previousAgents.map(agent => [agent.id, agent]))
        return nextAgents.map((agent) => {
            const previous = previousById.get(agent.id)
            const ownerMemberId = agent.ownerMemberId || previous?.ownerMemberId
            const ownsRemoteAgent = agent.executorType === 'remote'
                && ownerMemberId === userId.value
            const { connectorId, remoteOrigin, ...visibleAgent } = agent
            return {
                ...visibleAgent,
                ...(ownerMemberId ? { ownerMemberId } : {}),
                ...(ownsRemoteAgent && (connectorId || previous?.connectorId)
                    ? { connectorId: connectorId || previous?.connectorId }
                    : {}),
                ...(ownsRemoteAgent && (remoteOrigin || previous?.remoteOrigin)
                    ? { remoteOrigin: remoteOrigin || previous?.remoteOrigin }
                    : {}),
            }
        })
    }

    function captureHistoricalMessageAgents(chatMessages: ChatMessage[]) {
        const historicalById = new Map(historicalMessageAgents.value.map(agent => [agent.id, agent]))
        let changed = false
        for (const chatMessage of chatMessages) {
            if (!chatMessage.senderAgentRecordId || !chatMessage.senderAgentType) continue
            const historicalAgent = groupMessageAgent(chatMessage, [])
            if (!historicalAgent) continue
            historicalById.set(historicalAgent.id, historicalAgent)
            changed = true
        }
        if (changed) historicalMessageAgents.value = [...historicalById.values()]
    }

    function applyRealtimeJoinState(res: any, options: { syncMessages?: boolean } = {}) {
        members.value = res.members || []
        if (res.agents) {
            snapshotCurrentMessageAgents(agents.value)
            agents.value = mergeRoomAgentRoster(res.agents)
            if (res.roomId) projectRoomAgents(res.roomId, agents.value)
        }
        if (res.roomName) roomName.value = res.roomName
        if (typeof res.agentLinkToken === 'string') agentLinkToken.value = res.agentLinkToken
        const currentMember = members.value.find(member => member.userId === userId.value)
        if (currentMember?.name) userName.value = currentMember.name
        if (currentMember?.avatar) currentUserAvatar.value = currentMember.avatar
        if (options.syncMessages && Array.isArray(res.messages)) {
            // Deltas received before the snapshot are already represented in it.
            // Flush before replacing rows so the batching timer cannot replay them.
            flushPendingStreamDeltas(currentRoomId.value || undefined)
            captureHistoricalMessageAgents(res.messages)
            const byId = new Map(messages.value.map(message => [message.id, message]))
            for (const message of res.messages) {
                const existing = byId.get(message.id)
                if (existing && isOlderGroupTaskPlan(existing, message)) continue
                const isStreaming = message.isStreaming === true || message.finish_reason === 'streaming'
                // A late snapshot must not reopen a message already finalized here.
                if (isStreaming && existing && !existing.isStreaming && existing.finish_reason !== 'streaming') continue
                byId.set(message.id, isStreaming
                    ? { ...existing, ...message, isStreaming: true }
                    : mergeFinalMessage(existing || null, message))
            }
            messages.value = Array.from(byId.values()).sort((a, b) => a.timestamp - b.timestamp)
            if (typeof res.total === 'number' || typeof res.hasMore === 'boolean') {
                applyMessagePaging(res)
            } else {
                loadedMessageCount.value = Math.max(loadedMessageCount.value, messages.value.length)
                totalMessages.value = Math.max(totalMessages.value, loadedMessageCount.value)
            }
        }

        // Restore typing state from server. Replace the local transient map so
        // a reconnect cannot leave stale typers from the pre-reconnect socket.
        clearRemoteTypingState()
        if (res.typingUsers) {
            for (const u of res.typingUsers) {
                if (u.userId === userId.value) continue
                refreshRemoteTypingUser(u.userId, u.userName)
            }
        }

        // Restore context statuses from server
        if (res.contextStatuses) {
            contextStatuses.value = new Map(
                res.contextStatuses.map((s: any) => [s.agentName, s])
            )
        } else {
            contextStatuses.value.clear()
        }
        if (res.roomSummary?.roomId === currentRoomId.value) applyRoomSummaryState(res.roomSummary)
        executionQueue.value = Array.isArray(res.executionQueue) ? res.executionQueue : []
        messageRoutingDecisions.value = new Map((Array.isArray(res.routingDecisions) ? res.routingDecisions : []).map((decision: GroupMessageRoutingDecision) => [decision.messageId, decision]))
        if (typeof res.roomId === 'string' && res.roomId) {
            replaceRoomPendingInteractions(res.roomId, res.pendingApprovals, res.pendingClarifies)
        }
    }

    let connectPromise: Promise<void> | null = null
    let boundSocket: GroupChatSocket | null = null
    let connectionGeneration = 0
    let roomSelectionSequence = 0
    let pendingRealtimeJoin: { key: string; promise: Promise<void> } | null = null

    async function waitForRealtimeSocket(socket: GroupChatSocket): Promise<void> {
        if (socket.connected) return
        await new Promise<void>((resolve, reject) => {
            let settled = false
            let timeout: ReturnType<typeof setTimeout> | null = null
            const cleanup = () => {
                if (timeout) clearTimeout(timeout)
                socket.off?.('connect', onConnect)
            }
            const finish = (fn: () => void) => {
                if (settled) return
                settled = true
                cleanup()
                fn()
            }
            const onConnect = () => finish(resolve)
            timeout = setTimeout(() => finish(() => reject(new Error('Group chat socket connection timed out'))), GROUP_CHAT_JOIN_TIMEOUT_MS)
            socket.once('connect', onConnect)
        })
    }

    async function ensureRealtimeSocket(): Promise<GroupChatSocket> {
        let socket = getSocket()
        if (socket) return socket
        await connect()
        socket = getSocket({ requireConnected: false })
        if (!socket) throw new Error('Group chat socket not connected')
        await waitForRealtimeSocket(socket)
        const connectedSocket = getSocket()
        if (!connectedSocket) throw new Error('Group chat socket not connected')
        return connectedSocket
    }

    async function joinRealtimeRoom(roomId: string, options: { syncMessages?: boolean; inviteCode?: string } = {}) {
        const selectionSequence = roomSelectionSequence
        const socket = await ensureRealtimeSocket()
        if (selectionSequence !== roomSelectionSequence) return
        const socketId = socket.id
        if (!socketId) throw new Error('Group chat socket not connected')
        if (
            realtimeJoinedRoomId.value === roomId &&
            realtimeJoinedSocketId.value === socketId
        ) return

        const joinKey = `${socketId}:${roomId}:${selectionSequence}`
        if (pendingRealtimeJoin?.key === joinKey) {
            await pendingRealtimeJoin.promise
            return
        }

        // Browser storage is only a first-join default. Once the member row
        // exists, the server keeps the room-specific profile authoritative.
        const storedName = getStoredGroupUserName()
        const storedDescription = localStorage.getItem('gc_user_description')
        const storedAvatar = getStoredGroupUserAvatar()

        const joinGeneration = connectionGeneration
        const joinPromise = new Promise<void>((resolve, reject) => {
            let settled = false
            const timeout = setTimeout(() => {
                if (settled) return
                settled = true
                reject(new Error('Group chat room join timed out'))
            }, GROUP_CHAT_JOIN_TIMEOUT_MS)
            const finish = (fn: () => void) => {
                if (settled) return
                settled = true
                clearTimeout(timeout)
                fn()
            }

            socket.emit('join', {
                roomId,
                inviteCode: options.inviteCode,
                name: storedName || undefined,
                description: storedDescription || undefined,
                avatar: storedAvatar || undefined,
            }, (res: any) => {
                if (currentRoomId.value !== roomId || selectionSequence !== roomSelectionSequence) {
                    finish(resolve)
                    return
                }
                if (
                    connectionGeneration !== joinGeneration ||
                    !socket.connected ||
                    socket.id !== socketId
                ) {
                    finish(() => reject(new Error('Group chat socket changed while joining room')))
                    return
                }
                if (res?.error) {
                    error.value = res.error
                    const joinError = Object.assign(new Error(res.error), {
                        code: typeof res.code === 'string' ? res.code : undefined,
                    })
                    finish(() => reject(joinError))
                    return
                }
                applyRealtimeJoinState(res, options)
                realtimeJoinedRoomId.value = roomId
                realtimeJoinedSocketId.value = socketId
                finish(resolve)
            })
        })

        pendingRealtimeJoin = { key: joinKey, promise: joinPromise }
        try {
            await joinPromise
        } finally {
            if (pendingRealtimeJoin?.promise === joinPromise) pendingRealtimeJoin = null
        }
    }

    async function ensureRealtimeRoomReady(roomId: string): Promise<GroupChatSocket> {
        await joinRealtimeRoom(roomId)
        const socket = getSocket()
        if (
            !socket ||
            currentRoomId.value !== roomId ||
            realtimeJoinedRoomId.value !== roomId ||
            realtimeJoinedSocketId.value !== socket.id
        ) {
            throw new Error('Group chat room changed before the realtime join completed')
        }
        return socket
    }

    // ─── Computed ───────────────────────────────────────────
    const sortedMessages = computed(() => mapGroupMessages(
        [...messages.value].sort((a, b) => (a.firstSeenAt ?? a.timestamp) - (b.firstSeenAt ?? b.timestamp)),
        new Set(contextStatuses.value.keys()),
    ))

    const memberNames = computed(() => {
        return members.value.map(m => m.name)
    })

    const typingNames = computed(() => {
        return Array.from(typingUsers.value.values()).map(u => u.name)
    })

    const typingText = computed(() => {
        const names = typingNames.value
        if (names.length === 0) return ''
        if (names.length === 1) return `${names[0]} is typing...`
        if (names.length === 2) return `${names[0]} and ${names[1]} are typing...`
        return `${names[0]} and ${names.length - 1} others are typing...`
    })

    // ─── Connection ────────────────────────────────────────
    async function connect(options: { inviteCode?: string; guest?: boolean } = {}) {
        if (options.guest) {
            inviteGuest.value = true
            // A store that previously connected as an authenticated account may
            // still hold auth:<id> in memory. Invite guests always use the
            // browser-persisted UUID so navigation, refreshes, and reconnects
            // keep the same guest identity.
            userId.value = getStoredUserId()
            currentUserAvatar.value = getStoredGroupUserAvatar()
        }
        if (options.inviteCode?.trim()) activeInviteCode.value = options.inviteCode.trim()
        if (connectPromise) return connectPromise
        const promise = connectOnce()
        connectPromise = promise
        try {
            await promise
        } finally {
            if (connectPromise === promise) connectPromise = null
        }
    }

    async function connectOnce() {
        let authUserId: number | undefined
        const connectionName = getStoredGroupUserName()
        if (!inviteGuest.value) {
            try {
                const user = await fetchCurrentUser()
                authUserId = user.id
                userId.value = authenticatedGroupUserId(user.id)
                if (!connectionName) userName.value = user.username
                currentUserAvatar.value = user.avatar || ''
            } catch { /* non-critical: avatar fallback handles missing id */ }
        }
        const socket = connectGroupChat({
            userId: userId.value,
            userName: connectionName || undefined,
            authUserId,
            inviteCode: inviteGuest.value ? activeInviteCode.value : undefined,
        })
        console.log('[GroupChat] connecting...', { userId: userId.value, userName: userName.value })

        if (boundSocket === socket) {
            connected.value = socket.connected
            return
        }
        boundSocket = socket

        const handleConnected = () => {
            console.log('[GroupChat] connected, socket id:', socket.id)
            connectionGeneration += 1
            connected.value = true
            realtimeJoinedRoomId.value = null
            realtimeJoinedSocketId.value = null
            error.value = null
            socket.emit('load_pending_approvals', {}, (res: { pendingApprovals?: unknown } | undefined) => {
                replacePendingApprovalSnapshots(res?.pendingApprovals)
            })
            socket.emit('load_room_agent_activities', {}, (res: { activities?: unknown } | undefined) => {
                replaceActiveAgentRuns(res?.activities)
            })
            const roomId = currentRoomId.value
            if (roomId) {
                void joinRealtimeRoom(roomId, {
                    syncMessages: true,
                    inviteCode: activeInviteCode.value || undefined,
                }).catch((err: any) => {
                    error.value = err.message
                })
            }
        }

        socket.on('connect', handleConnected)

        socket.on('disconnect', (reason) => {
            console.log('[GroupChat] disconnected:', reason)
            connectionGeneration += 1
            connected.value = false
            realtimeJoinedRoomId.value = null
            realtimeJoinedSocketId.value = null
            pendingRealtimeJoin = null
            clearPendingStreamDeltas()
            resetLocalTypingState()
            clearRemoteTypingState()
            contextStatuses.value.clear()
            activeAgentRuns.value = new Map()
        })

        socket.on('connect_error', (err: Error) => {
            console.error('[GroupChat] connect_error:', err.message)
            error.value = err.message
            connected.value = false
            realtimeJoinedRoomId.value = null
            realtimeJoinedSocketId.value = null
        })

        socket.on('message', (msg: ChatMessage) => {
            if (msg.role !== 'tool' && msg.finish_reason !== 'streaming') {
                recordPersistedRoomActivity(msg.roomId, Number(msg.persistedAt || msg.timestamp || 0))
            }
            if (msg.roomId === currentRoomId.value) {
                // A persisted message can seal or transform another live row in
                // the same agent run. Apply all queued room deltas first so the
                // final event remains authoritative without losing token text.
                flushPendingStreamDeltas(msg.roomId)
                captureHistoricalMessageAgents([msg])
                if (msg.role === 'assistant' && msg.tool_calls?.length) {
                    const responseRunId = inferredGroupResponseRunId(msg)
                    messages.value = messages.value.map(message => (
                        message.isStreaming &&
                        message.senderId === msg.senderId &&
                        inferredGroupResponseRunId(message) === responseRunId
                            ? { ...message, reasoning: '', reasoning_content: '' }
                            : message
                    ))
                }
                const idx = messages.value.findIndex(m => m.id === msg.id)
                const existing = idx >= 0 ? messages.value[idx] : null
                const resolvedMsg = mergeFinalMessage(existing, msg)
                if (idx >= 0) {
                    messages.value[idx] = resolvedMsg
                    messages.value = [...messages.value]
                } else {
                    messages.value.push(resolvedMsg)
                    loadedMessageCount.value += 1
                    totalMessages.value = Math.max(totalMessages.value + 1, loadedMessageCount.value)
                }
                if (autoPlaySpeechEnabled.value && resolvedMsg.role === 'assistant' && resolvedMsg.content?.trim()) {
                    const messageAgent = agents.value.find(agent =>
                        agent.agentId === resolvedMsg.senderId || agent.name === resolvedMsg.senderName
                    )
                    const profile = messageAgent?.profile || getActiveProfileName() || 'default'
                    setTimeout(() => playMessageSpeech(resolvedMsg.id, resolvedMsg.content, profile), 300)
                }
            }
        })

        socket.on('message_stream_start', (msg: ChatMessage) => {
            if (msg.roomId !== currentRoomId.value) return
            flushPendingStreamDeltas(msg.roomId, msg.id)
            messages.value = messages.value.filter(m => !(
                m.roomId === msg.roomId &&
                m.senderId === msg.senderId &&
                m.id !== msg.id &&
                m.isStreaming &&
                !m.content?.trim() &&
                !m.reasoning?.trim() &&
                !m.tool_calls?.length
            ))
            msg.isStreaming = true
            msg.firstSeenAt = msg.firstSeenAt ?? msg.timestamp ?? Date.now()
            const idx = messages.value.findIndex(m => m.id === msg.id)
            if (idx >= 0) {
                const existing = messages.value[idx]
                if (!existing.isStreaming) return
                Object.assign(existing, msg, {
                    content: hasText(msg.content) ? msg.content : existing.content || '',
                    reasoning: hasText(msg.reasoning) ? msg.reasoning : existing.reasoning,
                    reasoning_content: hasText(msg.reasoning_content) ? msg.reasoning_content : existing.reasoning_content,
                    isStreaming: true,
                })
            } else {
                messages.value.push(msg)
                loadedMessageCount.value += 1
                totalMessages.value = Math.max(totalMessages.value + 1, loadedMessageCount.value)
            }
        })

        socket.on('message_stream_delta', (data: { roomId: string; id: string; delta: string }) => {
            queueStreamDelta(data, 'content')
        })

        socket.on('message_reasoning_delta', (data: { roomId: string; id: string; delta: string }) => {
            queueStreamDelta(data, 'reasoning')
        })

        socket.on('message_stream_end', (data: { roomId: string; id: string }) => {
            if (data.roomId !== currentRoomId.value) return
            flushPendingStreamDeltas(data.roomId, data.id)
            const idx = messages.value.findIndex(m => m.id === data.id)
            if (
                idx >= 0 &&
                !messages.value[idx].content?.trim() &&
                !messages.value[idx].reasoning?.trim() &&
                !messages.value[idx].tool_calls?.length
            ) {
                messages.value.splice(idx, 1)
            } else if (idx >= 0) {
                messages.value[idx].isStreaming = false
                if (needsFinalContentRecovery(messages.value[idx])) {
                    scheduleMissingFinalContentRecovery(data.roomId, data.id)
                }
            }
        })

        socket.on('member_joined', (data: { roomId: string; members: MemberInfo[] }) => {
            if (data.roomId === currentRoomId.value) {
                members.value = data.members
            }
        })

        socket.on('member_left', (data: { roomId: string; members: MemberInfo[] }) => {
            if (data.roomId === currentRoomId.value) {
                members.value = data.members
            }
        })

        socket.on('member_kicked', (data: { roomId: string }) => {
            if (data.roomId !== currentRoomId.value) return
            error.value = GROUP_CHAT_MEMBER_REMOVED
            currentRoomId.value = null
            realtimeJoinedRoomId.value = null
            realtimeJoinedSocketId.value = null
            clearPendingStreamDeltas()
            messages.value = []
            resetMessagePaging()
            members.value = []
            agents.value = []
            roomName.value = ''
            clearRemoteTypingState()
            contextStatuses.value.clear()
            clearActiveAgentRunsForRoom(data.roomId)
            executionQueue.value = []
            pendingApprovals.value.clear()
            pendingClarifies.value.clear()
        })

        socket.on('member_updated', (data: { roomId: string; members: MemberInfo[] }) => {
            if (data.roomId === currentRoomId.value) {
                members.value = data.members
                const currentMember = members.value.find(member => member.userId === userId.value)
                if (currentMember?.name) userName.value = currentMember.name
            }
        })

        socket.on('agents_updated', (data: { roomId: string; agents: RoomAgent[] }) => {
            if (data.roomId === currentRoomId.value) {
                snapshotCurrentMessageAgents(agents.value)
                agents.value = Array.isArray(data.agents)
                    ? mergeRoomAgentRoster(data.agents)
                    : []
                projectRoomAgents(data.roomId, agents.value)
            }
        })

        socket.on('typing', (data: { roomId: string; userId: string; userName: string }) => {
            if (data.roomId !== currentRoomId.value || data.userId === userId.value) return
            refreshRemoteTypingUser(data.userId, data.userName)
        })

        socket.on('stop_typing', (data: { roomId: string; userId: string }) => {
            if (data.roomId === currentRoomId.value && typingUsers.value.has(data.userId)) {
                const entry = typingUsers.value.get(data.userId)!
                clearTimeout(entry.timer)
                typingUsers.value.delete(data.userId)
                typingUsers.value = new Map(typingUsers.value)
            }
        })

        socket.on('context_status', (data: { roomId: string; agentName: string; status: string }) => {
            if (data.roomId === currentRoomId.value) {
                if (data.status === 'ready') {
                    settleAgentActivity(data.agentName)
                } else {
                    contextStatuses.value.set(data.agentName, { agentName: data.agentName, status: data.status })
                    // Trigger reactivity
                    contextStatuses.value = new Map(contextStatuses.value)
                }
            }
        })

        socket.on('room_agent_activity', (data: GroupAgentActivity) => {
            applyActiveAgentRun(data)
        })

        socket.on('execution_queue_updated', (data: { roomId: string; items?: GroupExecutionQueueItem[] }) => {
            if (data.roomId !== currentRoomId.value) return
            executionQueue.value = Array.isArray(data.items) ? data.items : []
        })

        socket.on('message_retracted', (data: {
            roomId: string
            messageId: string
            messageCount?: number
            totalTokens?: number
            lastActiveAt?: number
        }) => {
            if (!data.roomId || !data.messageId) return
            executionQueue.value = executionQueue.value.filter(item => item.messageId !== data.messageId)
            const room = rooms.value.find(item => item.id === data.roomId)
            if (room) {
                if (typeof data.totalTokens === 'number') room.totalTokens = data.totalTokens
                if (typeof data.lastActiveAt === 'number') room.lastActiveAt = data.lastActiveAt
                sortRoomsByActivity()
            }
            roomSummaryStates.value.delete(data.roomId)
            roomSummaryStates.value = new Map(roomSummaryStates.value)
            const reference = messageReferences.value.get(data.roomId)
            if (reference?.id === data.messageId) clearMessageReference(data.roomId)
            if (data.roomId !== currentRoomId.value) return
            flushPendingStreamDeltas(data.roomId, data.messageId)
            const removed = messages.value.some(message => message.id === data.messageId)
            messages.value = messages.value.filter(message => message.id !== data.messageId)
            if (removed) loadedMessageCount.value = Math.max(0, loadedMessageCount.value - 1)
            totalMessages.value = typeof data.messageCount === 'number'
                ? Math.max(0, data.messageCount)
                : Math.max(0, totalMessages.value - (removed ? 1 : 0))
            hasMoreBefore.value = loadedMessageCount.value < totalMessages.value
        })

        socket.on('message_routing_updated', (decision: GroupMessageRoutingDecision) => { messageRoutingDecisions.value.set(decision.messageId, decision); messageRoutingDecisions.value = new Map(messageRoutingDecisions.value) })
        socket.on('room_summary_updated', applyRoomSummaryState)
        socket.on('room_summary_review_updated', applyRoomSummaryReview)

        socket.on('handoff_updated', (chain: RoomAgentHandoffChain) => {
            if (!chain?.chainId || chain.roomId !== currentRoomId.value) return
            handoffChains.value.set(chain.chainId, chain)
            handoffChains.value = new Map(handoffChains.value)
        })

        socket.on('approval.requested', (data: { roomId: string; agentName?: string; approval_id?: string; command?: string; description?: string; choices?: string[]; allow_permanent?: boolean; timeout_ms?: number; remaining_timeout_ms?: number; requested_at?: number }) => {
            upsertPendingApproval(data)
            pendingApprovals.value = new Map(pendingApprovals.value)
        })

        socket.on('approval.resolved', (data: { roomId?: string; approval_id?: string; resolved?: boolean }) => {
            if (!data.roomId || !data.approval_id || data.resolved === false) return
            pendingApprovals.value.delete(pendingApprovalKey(data.roomId, data.approval_id))
            pendingApprovals.value = new Map(pendingApprovals.value)
        })

        socket.on('clarify.requested', (data: { roomId: string; agentName?: string; clarify_id?: string; question?: string; choices?: string[] | null; initial_response?: string; response_mode?: string; timeout_ms?: number; remaining_timeout_ms?: number; requested_at?: number }) => {
            upsertPendingClarify(data)
            pendingClarifies.value = new Map(pendingClarifies.value)
        })

        socket.on('clarify.resolved', (data: { roomId?: string; clarify_id?: string }) => {
            if (!data.roomId || !data.clarify_id) return
            pendingClarifies.value.delete(pendingClarifyKey(data.roomId, data.clarify_id))
            pendingClarifies.value = new Map(pendingClarifies.value)
        })

        socket.on('agent_pairing_requested', (data: { roomId?: string }) => {
            if (data.roomId === currentRoomId.value) agentPairingRevision.value += 1
        })

        socket.on('agent_pairing_updated', (data: { roomId?: string }) => {
            if (data.roomId === currentRoomId.value) agentPairingRevision.value += 1
        })

        socket.on('room_updated', (data: {
            roomId: string
            totalTokens?: number
            name?: string
            allowGuestAgents?: number
            guestAgentApproval?: 'owner'
            maxGuestAgentsPerMember?: number
            allowRemoteWorkspaceAccess?: number
            agentHandoffEnabled?: number
            agentHandoffMaxDepth?: number | null
            agentHandoffUnlimited?: number
            lastActiveAt?: number
        }) => {
            const room = rooms.value.find(r => r.id === data.roomId)
            if (!room) return
            if (typeof data.totalTokens === 'number') room.totalTokens = data.totalTokens
            if (typeof data.lastActiveAt === 'number') {
                room.lastActiveAt = data.lastActiveAt
                sortRoomsByActivity()
            }
            if (typeof data.allowGuestAgents === 'number') room.allowGuestAgents = data.allowGuestAgents
            if (data.guestAgentApproval === 'owner') room.guestAgentApproval = data.guestAgentApproval
            if (typeof data.maxGuestAgentsPerMember === 'number') {
                room.maxGuestAgentsPerMember = data.maxGuestAgentsPerMember
            }
            if (typeof data.allowRemoteWorkspaceAccess === 'number') {
                room.allowRemoteWorkspaceAccess = data.allowRemoteWorkspaceAccess
            }
            const handoffPolicyChanged = Object.prototype.hasOwnProperty.call(data, 'agentHandoffEnabled')
                || Object.prototype.hasOwnProperty.call(data, 'agentHandoffMaxDepth')
                || Object.prototype.hasOwnProperty.call(data, 'agentHandoffUnlimited')
            if (typeof data.agentHandoffEnabled === 'number') {
                room.agentHandoffEnabled = data.agentHandoffEnabled
            }
            if (typeof data.agentHandoffMaxDepth === 'number' || data.agentHandoffMaxDepth === null) {
                room.agentHandoffMaxDepth = data.agentHandoffMaxDepth
            }
            if (typeof data.agentHandoffUnlimited === 'number') {
                room.agentHandoffUnlimited = data.agentHandoffUnlimited
            }
            if (handoffPolicyChanged) {
                for (const [chainId, chain] of handoffChains.value) {
                    if (chain.roomId === data.roomId) handoffChains.value.delete(chainId)
                }
                handoffChains.value = new Map(handoffChains.value)
            }
            if (typeof data.name === 'string' && data.name.trim()) {
                room.name = data.name.trim()
                if (currentRoomId.value === data.roomId) roomName.value = room.name
            }
            rooms.value = [...rooms.value]
        })

        socket.on('room_cleared', (data: { roomId: string; totalTokens: number }) => {
            const room = rooms.value.find(r => r.id === data.roomId)
            if (room) room.totalTokens = data.totalTokens
            roomSummaryStates.value.delete(data.roomId)
            roomSummaryStates.value = new Map(roomSummaryStates.value)
            for (const [chainId, chain] of handoffChains.value) {
                if (chain.roomId === data.roomId) handoffChains.value.delete(chainId)
            }
            handoffChains.value = new Map(handoffChains.value)
            clearActiveAgentRunsForRoom(data.roomId)
            if (data.roomId === currentRoomId.value) {
                clearPendingStreamDeltas()
                messages.value = []
                historicalMessageAgents.value = []
                resetMessagePaging()
                clearRemoteTypingState()
                contextStatuses.value.clear()
                executionQueue.value = []
                pendingApprovals.value.clear()
                pendingClarifies.value.clear()
            }
        })

        if (socket.connected) handleConnected()
    }

    function disconnect() {
        roomSelectionSequence += 1
        connectionGeneration += 1
        resetLocalTypingState()
        clearRemoteTypingState()
        disconnectGroupChat()
        boundSocket = null
        connectPromise = null
        pendingRealtimeJoin = null
        clearPendingStreamDeltas()
        connected.value = false
        realtimeJoinedRoomId.value = null
        realtimeJoinedSocketId.value = null
        currentRoomId.value = null
        messages.value = []
        historicalMessageAgents.value = []
        resetMessagePaging()
        members.value = []
        agents.value = []
        roomName.value = ''
        contextStatuses.value.clear()
        activeAgentRuns.value = new Map()
        executionQueue.value = []
        roomSummaryStates.value.clear()
        handoffChains.value.clear()
        pendingApprovals.value.clear()
        pendingClarifies.value.clear()
        inviteGuest.value = false
        activeInviteCode.value = ''
        agentLinkToken.value = ''
    }

    function setUserInfo(name: string, description: string, avatar?: string) {
        userName.value = name
        localStorage.setItem('gc_user_name', name)
        localStorage.setItem('gc_user_description', description)
        if (avatar !== undefined) {
            currentUserAvatar.value = avatar
            if (avatar) localStorage.setItem('gc_user_avatar', avatar)
            else localStorage.removeItem('gc_user_avatar')
        }
    }

    async function updateCurrentMemberProfile(name: string, description = '') {
        const roomId = currentRoomId.value
        const normalizedName = name.trim()
        const normalizedDescription = description.trim()
        if (!roomId) throw new Error('Join a room before updating your profile')
        if (!normalizedName) throw new Error('Name is required')
        const socket = await ensureRealtimeRoomReady(roomId)

        await new Promise<void>((resolve, reject) => {
            socket.emit('update_member_profile', {
                roomId,
                name: normalizedName,
                description: normalizedDescription,
            }, (res: { error?: string; members?: MemberInfo[] }) => {
                if (res?.error) {
                    reject(new Error(res.error))
                    return
                }
                if (res?.members) members.value = res.members
                userName.value = normalizedName
                setUserInfo(normalizedName, normalizedDescription)
                resolve()
            })
        })
    }

    // ─── Room Actions ──────────────────────────────────────
    async function joinRoom(roomId: string) {
        const sequence = ++roomSelectionSequence
        isJoining.value = true
        error.value = null

        try {
            const res = await getRoomDetail(roomId)
            if (sequence !== roomSelectionSequence) return
            clearCurrentRoomTransientState()
            clearPendingStreamDeltas()
            upsertRoom({ ...res.room, agents: summarizeRoomAgents(res.agents || []) })
            currentRoomId.value = res.room.id
            realtimeJoinedRoomId.value = null
            realtimeJoinedSocketId.value = null
            roomName.value = res.room.name
            historicalMessageAgents.value = []
            captureHistoricalMessageAgents(res.messages)
            messages.value = res.messages
            handoffChains.value = new Map((res.handoffChains || []).map(chain => [chain.chainId, chain]))
            applyMessagePaging(res)
            agents.value = res.agents
            projectRoomAgents(res.room.id, agents.value)
            members.value = res.members || []
            await joinRealtimeRoom(res.room.id, { syncMessages: true })
        } catch (err: any) {
            if (sequence !== roomSelectionSequence) return
            error.value = err.message
            throw err
        } finally {
            if (sequence === roomSelectionSequence) isJoining.value = false
        }
    }

    async function loadOlderMessages(): Promise<boolean> {
        const roomId = currentRoomId.value
        if (!roomId || isLoadingOlderMessages.value || !hasMoreBefore.value) return false
        const before = messages.value[0]?.id
        if (!before) return false
        isLoadingOlderMessages.value = true
        olderMessagesError.value = null
        try {
            const limit = GROUP_CHAT_MESSAGE_PAGE_SIZE
            const res = inviteGuest.value
                ? await new Promise<{
                    messages: ChatMessage[]
                    total?: number
                    hasMore?: boolean
                }>((resolve, reject) => {
                    const socket = getSocket()
                    if (!socket) {
                        reject(new Error('Group chat socket not connected'))
                        return
                    }
                    socket.emit('load_messages', { roomId, before, limit, history: true }, (response: any) => {
                        if (response?.error) reject(new Error(response.error))
                        else resolve(response)
                    })
                })
                : await getRoomDetail(roomId, { before, limit, history: true })
            if (currentRoomId.value !== roomId) return false
            const existingIds = new Set(messages.value.map(message => message.id))
            captureHistoricalMessageAgents(res.messages)
            const olderMessages = res.messages.filter(message => !existingIds.has(message.id))
            messages.value = [...olderMessages, ...messages.value]
            loadedMessageCount.value = messages.value.length
            totalMessages.value = res.total ?? totalMessages.value
            hasMoreBefore.value = res.hasMore ?? loadedMessageCount.value < totalMessages.value
            return olderMessages.length > 0
        } catch (err: any) {
            olderMessagesError.value = err.message
            return false
        } finally {
            isLoadingOlderMessages.value = false
        }
    }

    async function sendMessage(content: string, attachments?: Attachment[], mentions?: GroupChatMention[]) {
        if (!currentRoomId.value) return
        const { display } = useSettingsStore()
        if (display.bell_on_complete || display.approval_bell) primeCompletionSound()
        const roomId = currentRoomId.value
        const messageId = uid()
        const messageReference = messageReferences.value.get(roomId) || null
        const submittedContent = messageReference
            ? formatMessageWithReference(messageReference, content)
            : content.trim()
        clearMessageReference(roomId)
        let finalContent: string | ContentBlock[] = submittedContent
        let optimisticMessage: ChatMessage | null = null
        if (attachments?.length) {
            const guestInviteCode = inviteGuest.value ? activeInviteCode.value : ''
            const uploaded = await uploadGroupFiles(attachments, roomId, guestInviteCode)
            finalContent = buildGroupContentBlocks(submittedContent, attachments, uploaded)
            const urlMap = new Map(uploaded.map(f => {
                const path = normalizeLocalFilePath(f.path)
                const url = getGroupChatAttachmentUrl({
                    roomId,
                    inviteCode: guestInviteCode || undefined,
                }, path, f.name)
                return [f.name, url]
            }))
            optimisticMessage = {
                id: messageId,
                roomId,
                senderId: userId.value,
                senderName: userName.value || 'You',
                content: JSON.stringify(finalContent),
                timestamp: Date.now(),
                role: 'user',
                attachments: attachments.map(att => ({ ...att, url: urlMap.get(att.name) || att.url, file: undefined })),
            }
        }

        const socket = await ensureRealtimeRoomReady(roomId)
        if (optimisticMessage) {
            messages.value.push(optimisticMessage)
            loadedMessageCount.value += 1
            totalMessages.value = Math.max(totalMessages.value + 1, loadedMessageCount.value)
        }

        emitStopTyping(roomId)
        return new Promise<void>((resolve, reject) => {
            socket.emit('message', {
                roomId,
                id: messageId,
                content: finalContent,
                mentions,
                executionQueueCapability: executionQueueCapability(roomId),
            }, (res: { id?: string; error?: string }) => {
                if (res.error) {
                    messages.value = messages.value.filter(m => m.id !== messageId)
                    reject(new Error(res.error))
                    return
                }
                resolve()
            })
        })
    }

    async function loadRooms() {
        try {
            const res = await listRooms()
            rooms.value = res.rooms
            sortRoomsByActivity()
        } catch (err: any) {
            error.value = err.message
        }
    }

    async function createNewRoom(
        name: string,
        inviteCode: string,
        agentList?: RoomAgentInput[],
        summary?: RoomSummaryConfig,
        workspace?: string,
        memberProfile?: { name: string; description?: string },
    ) {
        try {
            const res = await createRoom({
                name,
                inviteCode,
                memberName: memberProfile?.name,
                memberDescription: memberProfile?.description,
                agents: agentList,
                summary: {
                    profile: summary?.summaryProfile || getActiveProfileName() || 'default',
                    provider: summary?.summaryProvider || '',
                    model: summary?.summaryModel || '',
                    apiMode: summary?.summaryApiMode || 'chat_completions',
                    everyTurns: summary?.summaryEveryTurns || 20,
                },
                workspace: workspace || undefined,
            })
            upsertRoom({ ...res.room, agents: summarizeRoomAgents(res.agents || []) })
            return res
        } catch (err: any) {
            error.value = err.message
            throw err
        }
    }

    async function joinByCode(code: string, options: { guest?: boolean } = {}) {
        const sequence = ++roomSelectionSequence
        try {
            const normalizedCode = code.trim()
            if (!normalizedCode) throw new Error('Invite code is required')
            const res = await joinRoomByCode(normalizedCode)
            if (sequence !== roomSelectionSequence) return
            clearCurrentRoomTransientState()
            clearPendingStreamDeltas()
            inviteGuest.value = options.guest === true
            activeInviteCode.value = normalizedCode
            upsertRoom(res.room)
            currentRoomId.value = res.room.id
            realtimeJoinedRoomId.value = null
            realtimeJoinedSocketId.value = null
            roomName.value = res.room.name
            await connect({ inviteCode: normalizedCode, guest: options.guest })
            if (sequence !== roomSelectionSequence) return
            await joinRealtimeRoom(res.room.id, { syncMessages: true, inviteCode: normalizedCode })
            return res.room
        } catch (err: any) {
            if (sequence !== roomSelectionSequence) return
            error.value = err.message
            throw err
        }
    }

    async function deleteRoom(roomId: string) {
        try {
            await deleteRoomApi(roomId)
            rooms.value = rooms.value.filter(r => r.id !== roomId)
            clearActiveAgentRunsForRoom(roomId)
            roomSummaryStates.value.delete(roomId)
            roomSummaryStates.value = new Map(roomSummaryStates.value)
            for (const [chainId, chain] of handoffChains.value) {
                if (chain.roomId === roomId) handoffChains.value.delete(chainId)
            }
            handoffChains.value = new Map(handoffChains.value)
            clearMessageReference(roomId)
            if (currentRoomId.value === roomId) {
                resetLocalTypingState()
                clearRemoteTypingState()
                currentRoomId.value = null
                realtimeJoinedRoomId.value = null
                realtimeJoinedSocketId.value = null
                clearPendingStreamDeltas()
                messages.value = []
                historicalMessageAgents.value = []
                resetMessagePaging()
                members.value = []
                agents.value = []
                roomName.value = ''
            }
        } catch (err: any) {
            error.value = err.message
            throw err
        }
    }

    async function cloneRoom(roomId: string, data?: { name?: string; inviteCode?: string }) {
        try {
            const res = await cloneRoomApi(roomId, data)
            upsertRoom({ ...res.room, agents: summarizeRoomAgents(res.agents || []) })
            return res
        } catch (err: any) {
            error.value = err.message
            throw err
        }
    }

    async function clearCurrentRoomContext() {
        if (!currentRoomId.value) return
        const roomId = currentRoomId.value
        try {
            const res = await clearRoomContext(roomId)
            clearMessageReference(roomId)
            if (currentRoomId.value === roomId) {
                clearPendingStreamDeltas()
                messages.value = []
                historicalMessageAgents.value = []
                resetMessagePaging()
                clearRemoteTypingState()
                contextStatuses.value.clear()
            }
            clearActiveAgentRunsForRoom(roomId)
            roomSummaryStates.value.delete(roomId)
            roomSummaryStates.value = new Map(roomSummaryStates.value)
            const idx = rooms.value.findIndex(r => r.id === roomId)
            if (idx >= 0 && res.room) {
                // Clearing history leaves the Agent roster intact. This response
                // contains room metadata only; retain the sidebar's cached roster.
                rooms.value[idx] = { ...rooms.value[idx], ...res.room }
            }
            return res
        } catch (err: any) {
            error.value = err.message
            throw err
        }
    }

    async function setRoomWorkspace(roomId: string, workspace: string) {
        try {
            const res = await updateRoomWorkspaceApi(roomId, workspace)
            if (res.room) {
                upsertRoom(res.room)
                if (currentRoomId.value === roomId) roomName.value = res.room.name
            }
            return res.room
        } catch (err: any) {
            error.value = err.message
            throw err
        }
    }

    async function setRoomInviteCode(roomId: string, inviteCode: string) {
        const nextCode = inviteCode.trim()
        if (!nextCode) throw new Error('inviteCode is required')
        try {
            await updateInviteCodeApi(roomId, nextCode)
            const room = rooms.value.find(r => r.id === roomId)
            if (room) {
                room.inviteCode = nextCode
                rooms.value = [...rooms.value]
            }
            return nextCode
        } catch (err: any) {
            error.value = err.message
            throw err
        }
    }

    // ─── Agent Actions ─────────────────────────────────────
    async function loadAgents(roomId: string) {
        try {
            const res = await listAgents(roomId)
            snapshotCurrentMessageAgents(agents.value)
            agents.value = mergeRoomAgentRoster(res.agents)
            projectRoomAgents(roomId, agents.value)
        } catch { /* ignore */ }
    }

    async function addAgentToRoom(roomId: string, data: RoomAgentInput) {
        try {
            const res = await addAgent(roomId, data)
            const index = agents.value.findIndex(agent =>
                agent.id === res.agent.id || agent.agentId === res.agent.agentId
            )
            if (index >= 0) {
                agents.value = mergeRoomAgentRoster(agents.value.map((agent, agentIndex) => (
                    agentIndex === index ? res.agent : agent
                )))
            } else {
                agents.value = [...agents.value, res.agent]
            }
            projectRoomAgents(roomId, agents.value)
            return res.agent
        } catch (err: any) {
            error.value = err.message
            throw err
        }
    }

    async function updateAgentInRoom(roomId: string, agentId: string, data: RoomAgentInput) {
        try {
            const res = await updateAgent(roomId, agentId, data)
            agents.value = mergeRoomAgentRoster(res.agents ?? agents.value.map(agent => (
                agent.id === agentId || agent.agentId === agentId ? res.agent : agent
            )))
            projectRoomAgents(roomId, agents.value)
            if (res.members) members.value = res.members
            return res.agent
        } catch (err: any) {
            error.value = err.message
            throw err
        }
    }

    async function removeAgentFromRoom(roomId: string, agentId: string) {
        try {
            snapshotCurrentMessageAgents(agents.value)
            const target = agents.value.find(agent => agent.id === agentId || agent.agentId === agentId)
            const ownsRemoteAgent = target?.executorType === 'remote'
                && target.ownerMemberId === userId.value
            const res = ownsRemoteAgent
                ? await removeOwnedRemoteAgent(roomId, agentId)
                : await removeAgent(roomId, agentId)
            agents.value = mergeRoomAgentRoster(
                res.agents ?? agents.value.filter(a => a.id !== agentId && a.agentId !== agentId),
            )
            projectRoomAgents(roomId, agents.value)
            if (target) clearActiveAgentRunsForRoom(roomId, target.id)
            if (res.members) members.value = res.members
        } catch (err: any) {
            error.value = err.message
            throw err
        }
    }

    async function removeOwnedRemoteAgent(
        roomId: string,
        agentId: string,
    ): Promise<{ agents?: RoomAgent[]; members?: MemberInfo[] }> {
        const socket = await ensureRealtimeRoomReady(roomId)
        return new Promise((resolve, reject) => {
            socket.emit('remove_agent', { roomId, agentId }, (res: any) => {
                if (res?.error) reject(new Error(res.error))
                else resolve(res || {})
            })
        })
    }

    async function removeMemberFromRoom(roomId: string, memberUserId: string) {
        try {
            snapshotCurrentMessageAgents(agents.value)
            const res = await removeRoomMemberApi(roomId, memberUserId)
            members.value = res.members ?? members.value.filter(member => member.userId !== memberUserId)
            agents.value = mergeRoomAgentRoster(
                res.agents ?? agents.value.filter(agent => agent.ownerMemberId !== memberUserId),
            )
            projectRoomAgents(roomId, agents.value)
        } catch (err: any) {
            error.value = err.message
            throw err
        }
    }

    // ─── Typing ────────────────────────────────────────────
    let _typingTimer: ReturnType<typeof setTimeout> | null = null
    let _typingRoomId: string | null = null
    let _lastTypingEmitAt = 0

    function resetLocalTypingState() {
        if (_typingTimer) clearTimeout(_typingTimer)
        _typingTimer = null
        _typingRoomId = null
        _lastTypingEmitAt = 0
    }

    function emitTyping() {
        const socket = getSocket()
        const roomId = currentRoomId.value
        if (
            !socket ||
            !roomId ||
            realtimeJoinedRoomId.value !== roomId ||
            realtimeJoinedSocketId.value !== socket.id
        ) return

        const now = Date.now()
        if (
            _typingRoomId !== roomId ||
            now - _lastTypingEmitAt >= GROUP_CHAT_TYPING_HEARTBEAT_MS
        ) {
            socket.emit('typing', { roomId })
            _typingRoomId = roomId
            _lastTypingEmitAt = now
        }
        if (_typingTimer) clearTimeout(_typingTimer)
        _typingTimer = setTimeout(() => emitStopTyping(roomId), GROUP_CHAT_TYPING_IDLE_MS)
    }

    function emitStopTyping(roomId = _typingRoomId || currentRoomId.value || '') {
        const wasTyping = Boolean(roomId) && _typingRoomId === roomId
        resetLocalTypingState()
        const socket = getSocket()
        if (
            !socket ||
            !roomId ||
            !wasTyping ||
            realtimeJoinedRoomId.value !== roomId ||
            realtimeJoinedSocketId.value !== socket.id
        ) return
        socket.emit('stop_typing', { roomId })
    }

    async function interruptAgent(agentName: string) {
        const roomId = currentRoomId.value
        if (!roomId) return
        const socket = await ensureRealtimeRoomReady(roomId)
        await new Promise<void>((resolve, reject) => {
            socket.emit('interrupt_agent', { roomId, agentName }, (res: any) => {
                if (res?.error) reject(new Error(res.error))
                else {
                    // The server also broadcasts ready. Clear optimistically on
                    // the successful acknowledgement so the breathing state
                    // cannot linger if that broadcast races a reconnect.
                    settleAgentActivity(agentName)
                    resolve()
                }
            })
        })
    }

    async function respondApprovalFor(roomId: string, approvalId: string, choice: GroupPendingApproval['choices'][number]): Promise<PendingInteractionSubmitResult> {
        const key = pendingApprovalKey(roomId, approvalId)
        const pending = pendingApprovals.value.get(key)
        if (!pending) return 'missing'
        const socket = await ensureRealtimeSocket()
        let resolved = false
        let stale = false
        try {
            await new Promise<void>((resolve, reject) => {
                socket.emit('approval.respond', {
                    roomId: pending.roomId,
                    approval_id: pending.approvalId,
                    choice,
                }, (res: any) => {
                    if (res?.error) reject(new Error(res.error))
                    else {
                        resolved = res?.resolved !== false
                        stale = res?.stale === true
                        resolve()
                    }
                })
            })
        } catch (error) {
            if (!isPendingInteractionExpiredError(error)) throw error
            stale = true
            resolved = true
        }
        if (resolved) {
            pendingApprovals.value.delete(key)
            pendingApprovals.value = new Map(pendingApprovals.value)
        }
        if (stale) {
            notifyPendingInteractionExpired()
            return 'expired'
        }
        return 'submitted'
    }

    async function respondApproval(choice: GroupPendingApproval['choices'][number]): Promise<PendingInteractionSubmitResult> {
        const pending = activePendingApproval.value
        if (!pending) return 'missing'
        return respondApprovalFor(pending.roomId, pending.approvalId, choice)
    }

    async function respondClarifyFor(roomId: string, clarifyId: string, response: string): Promise<PendingInteractionSubmitResult> {
        const key = pendingClarifyKey(roomId, clarifyId)
        const pending = pendingClarifies.value.get(key)
        if (!pending) return 'missing'
        const socket = await ensureRealtimeSocket()
        let resolved = false
        let stale = false
        try {
            await new Promise<void>((resolve, reject) => {
                socket.emit('clarify.respond', {
                    roomId: pending.roomId,
                    clarify_id: pending.clarifyId,
                    response,
                }, (res: any) => {
                    if (res?.error) reject(new Error(res.error))
                    else {
                        resolved = res?.resolved !== false
                        stale = res?.stale === true
                        resolve()
                    }
                })
            })
        } catch (error) {
            if (!isPendingInteractionExpiredError(error)) throw error
            stale = true
            resolved = true
        }
        if (resolved) {
            pendingClarifies.value.delete(key)
            pendingClarifies.value = new Map(pendingClarifies.value)
        }
        if (stale) {
            notifyPendingInteractionExpired()
            return 'expired'
        }
        return 'submitted'
    }

    async function respondClarify(response: string): Promise<PendingInteractionSubmitResult> {
        const pending = activePendingClarify.value
        if (!pending) return 'missing'
        return respondClarifyFor(pending.roomId, pending.clarifyId, response)
    }

    async function cancelExecutionQueueItem(queueId: string) {
        const roomId = currentRoomId.value
        if (!roomId) return
        const socket = await ensureRealtimeRoomReady(roomId)
        await new Promise<void>((resolve, reject) => {
            socket.emit('cancel_execution_queue_item', {
                roomId,
                queueId,
                executionQueueCapability: executionQueueCapability(roomId),
            }, (res: any) => {
                if (res?.error) {
                    reject(new Error(res.error))
                    return
                }
                resolve()
            })
        })
    }

    return {
        // State
        connected,
        currentRoomId,
        rooms,
        messages,
        members,
        agents,
        messageAgents,
        roomName,
        isJoining,
        error,
        contextStatus,
        contextStatuses,
        activeAgentRuns,
        roomSummaryStates,
        roomSummaryReviews,
        applyRoomSummaryState,
        applyRoomSummaryReview,
        handoffChains,
        executionQueue,
        messageRoutingDecisions,
        acceptRoutingSuggestion,
        pendingApprovals,
        pendingClarifies,
        activePendingApproval,
        activePendingClarify,
        autoPlaySpeechEnabled,
        activeMessageReference,
        totalMessages,
        loadedMessageCount,
        hasMoreBefore,
        isLoadingOlderMessages,
        olderMessagesError,
        userId,
        userName,
        currentUserAvatar,
        inviteGuest,
        activeInviteCode,
        agentLinkToken,
        agentPairingRevision,
        // Computed
        sortedMessages,
        activeAgentRunsForRoom,
        activeAgentIdsForRoom,
        roomAgentsForRoom,
        isAgentRunActive,
        memberNames,
        typingNames,
        typingText,
        isUserTyping,
        // Actions
        connect,
        disconnect,
        setUserInfo,
        updateCurrentMemberProfile,
        setAutoPlaySpeech,
        setMessageReference,
        clearMessageReference,
        joinRoom,
        loadOlderMessages,
        sendMessage,
        loadRooms,
        emitTyping,
        emitStopTyping,
        interruptAgent,
        respondApproval,
        respondApprovalFor,
        respondClarify,
        respondClarifyFor,
        cancelExecutionQueueItem,
        createNewRoom,
        joinByCode,
        deleteRoom,
        cloneRoom,
        clearCurrentRoomContext,
        setRoomWorkspace,
        setRoomInviteCode,
        loadAgents,
        addAgentToRoom,
        updateAgentInRoom,
        removeAgentFromRoom,
        removeMemberFromRoom,
    }
})

function hasRuntimeToolPayload(value: unknown): boolean {
    return value !== null && value !== undefined && value !== ''
}

function runtimeToolPayloadOrUndefined(value: unknown): unknown | undefined {
    return hasRuntimeToolPayload(value) ? value : undefined
}

function runtimePayloadText(value: unknown): string {
    if (!hasRuntimeToolPayload(value)) return ''
    if (typeof value === 'string') return value
    try {
        const serialized = JSON.stringify(value)
        if (serialized !== undefined) return serialized
    } catch {
        // Fall through to String(value) for non-serializable runtime payloads.
    }
    return String(value)
}

function parseWorkspaceDiffPayload(value: unknown): unknown {
    const text = runtimePayloadText(value)
    if (!text) return undefined
    try {
        const parsed = JSON.parse(text)
        return parsed?.kind === 'workspace_diff' ? parsed : value
    } catch {
        return value
    }
}

function groupWorkspaceDiffPayload(value: unknown): GroupWorkspaceDiffPayload | null {
    const parsed = parseWorkspaceDiffPayload(value)
    return parsed && typeof parsed === 'object' && (parsed as any).kind === 'workspace_diff'
        ? parsed as GroupWorkspaceDiffPayload
        : null
}

function inferredGroupResponseRunId(message: ChatMessage): string {
    const explicit = String(message.run_id || '').trim()
    if (explicit) return explicit
    const match = String(message.id || '').match(/^(.+)_part_\d+(?:_tool(?:call|result)_.+)?$/)
    return match?.[1] || ''
}

function groupToolPairKey(message: ChatMessage, toolCallId: string): string {
    const runId = inferredGroupResponseRunId(message)
    return `${runId || 'legacy'}\u0000${toolCallId}`
}

function attachWorkspaceDiffsToParentMessages(messages: ChatMessage[]): ChatMessage[] {
    const hasWorkspaceDiff = messages.some(message =>
        (message.toolName || message.tool_name) === 'workspace_diff',
    )
    const hasAttachedWorkspaceChanges = messages.some(message => message.workspaceChanges?.length)
    if (!hasWorkspaceDiff && !hasAttachedWorkspaceChanges) return messages

    const mapped: ChatMessage[] = messages.map(message => ({ ...message, workspaceChanges: [] }))
    const assistantById = new Map(
        mapped
            .filter(message => message.role === 'assistant')
            .map(message => [message.id, message]),
    )
    return mapped.filter(message => {
        if ((message.toolName || message.tool_name) !== 'workspace_diff') return true
        const payload = groupWorkspaceDiffPayload(message.toolResult ?? message.content)
        const parentMessageId = String(payload?.parent_message_id || '').trim()
        const parent = parentMessageId ? assistantById.get(parentMessageId) : undefined
        if (payload && parent) parent.workspaceChanges!.push(payload)
        return false
    })
}

function segmentGroupReasoningSnapshots(messages: ChatMessage[]): ChatMessage[] {
    const previousByRun = new Map<string, string>()
    return messages.map(message => {
        if (message.role !== 'assistant') return message
        if (!message.tool_calls?.length && !runtimePayloadText(message.content).trim()) return message
        const runId = inferredGroupResponseRunId(message)
        const current = String(message.reasoning || message.reasoning_content || '')
        if (!runId || !current) return message
        const key = `${message.senderId}\u0000${runId}`
        const previous = previousByRun.get(key) || ''
        previousByRun.set(key, current)
        if (!previous || !current.startsWith(previous)) return message
        const segment = current.slice(previous.length).trimStart()
        return {
            ...message,
            reasoning: segment || null,
            reasoning_content: segment || null,
        }
    })
}

function mapGroupMessages(msgs: ChatMessage[], activeAgentNames = new Set<string>()): ChatMessage[] {
    msgs = segmentGroupReasoningSnapshots(msgs)
    const toolNameMap = new Map<string, string>()
    const toolArgsMap = new Map<string, unknown>()
    const activeRunByAgent = new Map<string, string>()
    for (const msg of msgs) {
        const runId = inferredGroupResponseRunId(msg)
        if (runId && activeAgentNames.has(msg.senderName)) activeRunByAgent.set(msg.senderName, runId)
        if (msg.role === 'assistant' && msg.tool_calls?.length) {
            for (const tc of msg.tool_calls) {
                if (!tc?.id) continue
                const pairKey = groupToolPairKey(msg, tc.id)
                if (tc.function?.name) {
                    toolNameMap.set(pairKey, tc.function.name)
                    toolNameMap.set(`legacy\u0000${tc.id}`, tc.function.name)
                }
                if (hasRuntimeToolPayload(tc.function?.arguments)) {
                    toolArgsMap.set(pairKey, tc.function.arguments)
                    toolArgsMap.set(`legacy\u0000${tc.id}`, tc.function.arguments)
                }
            }
        }
    }

    const result: ChatMessage[] = []
    for (const [index, msg] of msgs.entries()) {
        if (
            msg.role === 'assistant' &&
            !msg.isStreaming &&
            !msg.tool_calls?.length &&
            !runtimePayloadText((msg as any).content).trim() &&
            msg.reasoning?.trim()
        ) {
            const matchingToolCall = msgs.slice(index + 1).find(candidate =>
                candidate.role === 'assistant' &&
                candidate.tool_calls?.length &&
                String(candidate.id).startsWith(`${String(msg.id)}_toolcall_`),
            )
            if (matchingToolCall?.reasoning?.trim() === msg.reasoning.trim()) continue
        }

        if (
            msg.role !== 'tool' &&
            !msg.tool_calls?.length &&
            !runtimePayloadText((msg as any).content).trim() &&
            !msg.reasoning?.trim() &&
            !msg.isStreaming
        ) {
            continue
        }

        if (msg.role === 'assistant' && msg.tool_calls?.length && !runtimePayloadText((msg as any).content).trim()) {
            for (const tc of msg.tool_calls) {
                result.push({
                    ...msg,
                    id: `${msg.id}_${tc.id}`,
                    run_id: inferredGroupResponseRunId(msg) || msg.run_id,
                    role: 'tool',
                    content: '',
                    toolName: tc.function?.name || undefined,
                    toolCallId: tc.id,
                    toolArgs: runtimeToolPayloadOrUndefined(tc.function?.arguments),
                    toolStatus: msg.isStreaming || activeRunByAgent.get(msg.senderName) === inferredGroupResponseRunId(msg)
                        ? 'running'
                        : 'interrupted',
                })
            }
            continue
        }

        const taskPlan = parseGroupTaskPlanMessage(msg)
        if (taskPlan) {
            result.push({ ...msg, role: 'assistant', content: '', taskPlan })
            continue
        }
        if (msg.role === 'tool') {
            const tcId = msg.tool_call_id || ''
            const pairKey = groupToolPairKey(msg, tcId)
            const legacyPairKey = `legacy\u0000${tcId}`
            const toolName = msg.tool_name || toolNameMap.get(pairKey) || toolNameMap.get(legacyPairKey) || undefined
            const toolArgs = toolArgsMap.has(pairKey)
                ? toolArgsMap.get(pairKey)
                : toolArgsMap.get(legacyPairKey)
            let preview = ''
            const toolResult = toolName === 'workspace_diff'
                ? parseWorkspaceDiffPayload((msg as any).content)
                : runtimeToolPayloadOrUndefined((msg as any).content)
            const contentText = runtimePayloadText((msg as any).content)
            if (contentText) {
                try {
                    const parsed = typeof (msg as any).content === 'string'
                        ? JSON.parse(contentText)
                        : (msg as any).content
                    preview = parsed?.url || parsed?.title || parsed?.preview || parsed?.summary || ''
                } catch {
                    preview = contentText.slice(0, 80)
                }
            }
            const placeholderIdx = result.findIndex(
                m => m.role === 'tool' &&
                    m.toolCallId === tcId &&
                    !m.toolResult &&
                    (!inferredGroupResponseRunId(msg) || inferredGroupResponseRunId(m) === inferredGroupResponseRunId(msg))
            )
            const merged: ChatMessage = {
                ...msg,
                id: placeholderIdx !== -1 ? result[placeholderIdx].id : msg.id,
                run_id: inferredGroupResponseRunId(msg) || result[placeholderIdx]?.run_id || msg.run_id,
                senderId: placeholderIdx !== -1 ? result[placeholderIdx].senderId : msg.senderId,
                senderName: placeholderIdx !== -1 ? result[placeholderIdx].senderName : msg.senderName,
                timestamp: placeholderIdx !== -1 ? result[placeholderIdx].timestamp : msg.timestamp,
                role: 'tool',
                content: '',
                toolName: toolName || (placeholderIdx !== -1 ? result[placeholderIdx].toolName : undefined),
                toolCallId: tcId || undefined,
                toolArgs: toolArgs !== undefined ? toolArgs : (placeholderIdx !== -1 ? result[placeholderIdx].toolArgs : undefined),
                toolPreview: typeof preview === 'string' ? preview.slice(0, 100) || undefined : undefined,
                toolResult,
                reasoning: msg.reasoning?.trim()
                    ? msg.reasoning
                    : placeholderIdx !== -1
                        ? result[placeholderIdx].reasoning
                        : undefined,
                toolStatus: msg.finish_reason === 'error' ? 'error' : 'done',
            }
            if (placeholderIdx !== -1) result[placeholderIdx] = merged
            else result.push(merged)
            continue
        }

        result.push(msg)
    }
    return attachWorkspaceDiffsToParentMessages(result)
}

export function groupAgentRunMessages(messages: ChatMessage[]): ChatMessage[] {
    const result: ChatMessage[] = []
    const groupedByRun = new Map<string, ChatMessage>()
    for (const message of messages) {
        const runId = inferredGroupResponseRunId(message)
        if (!runId || (message.role !== 'assistant' && message.role !== 'tool')) {
            result.push(message)
            continue
        }
        const ownerId = String(message.senderAgentRecordId || message.senderId || '').trim()
        const groupKey = `${ownerId}\u0000${runId}`
        const existing = groupedByRun.get(groupKey)
        if (existing) {
            existing.runItems!.push(message)
            existing.isStreaming = existing.runItems!.some(item => item.isStreaming || item.toolStatus === 'running')
            continue
        }
        const grouped: ChatMessage = {
            ...message,
            id: `group-agent-run:${ownerId}:${runId}`,
            run_id: runId,
            role: 'agent_run',
            content: '',
            reasoning: null,
            reasoning_content: null,
            tool_calls: null,
            runItems: [message],
            isStreaming: Boolean(message.isStreaming || message.toolStatus === 'running'),
        }
        groupedByRun.set(groupKey, grouped)
        result.push(grouped)
    }
    for (const grouped of groupedByRun.values()) {
        grouped.runItems!.sort((left, right) => Number(Boolean(left.taskPlan)) - Number(Boolean(right.taskPlan)) || left.timestamp - right.timestamp)
    }
    return result
}
