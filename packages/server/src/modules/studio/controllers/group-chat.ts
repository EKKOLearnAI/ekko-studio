import { randomBytes } from 'node:crypto'
import {
    GROUP_CHAT_MESSAGE_WINDOW,
    ROOM_PARTICIPANT_NAME_CONFLICT,
    type GroupChatServer,
} from '../public/group-chat'
import { isReservedMentionName } from '../services/group-chat/mention-routing'
import { deleteGroupChatAttachments } from '../services/group-chat/attachments'
import { revokeGroupAgentConnector } from '../services/group-chat/agent-relay-store'
import { assertAllowedWorkspaceFolder } from '../public/workspace-files'
import {
    canManageGroupChatRoom as canManageRoom,
    canReadGroupChatRoom as canReadRoom,
    groupChatUserProfiles as userProfiles,
    isGroupChatRoomOwner,
} from '../services/group-chat/access'
import { setGroupChatRuntimeServer } from '../services/group-chat/runtime'
import * as inviteCtrl from './group-chat-invite'
import * as uploadCtrl from './group-chat-upload'
import * as agentPresetCtrl from './group-agent-presets'
import {
    AGENT_NOT_INSTALLED,
    assertAgentAvailable,
} from '../services/agent-availability'

let chatServer: GroupChatServer | null = null
const roomAgentUpdates = new Set<string>()
const roomDeletions = new Set<string>()

export function setGroupChatServer(server: GroupChatServer | null) {
    chatServer = server
    setGroupChatRuntimeServer(server)
}

export function getGroupChatServer(): GroupChatServer | null {
    return chatServer
}

async function authorizedAttachmentRoom(ctx: any): Promise<any | null> {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return null
    }
    const roomId = String(ctx.params.roomId || '').trim()
    const storage = chatServer.getStorage()
    const room = roomId ? storage.getRoom(roomId) : null
    if (!room) {
        ctx.status = 404
        ctx.body = { error: 'Room not found' }
        return null
    }
    if (!canReadRoom(storage, roomId, ctx.state?.user)) {
        ctx.status = 403
        ctx.body = { error: 'Access denied' }
        return null
    }
    return room
}

export async function uploadRoomAttachment(ctx: any) {
    const room = await authorizedAttachmentRoom(ctx)
    if (room) await inviteCtrl.uploadRoomAttachment(ctx, room)
}

export async function openRoomAttachmentUpload(ctx: any) {
    const room = await authorizedAttachmentRoom(ctx)
    if (room) await uploadCtrl.open(ctx, room)
}

export async function appendRoomAttachmentUploadChunk(ctx: any) {
    const room = await authorizedAttachmentRoom(ctx)
    if (room) await uploadCtrl.appendChunk(ctx, room)
}

export async function completeRoomAttachmentUpload(ctx: any) {
    const room = await authorizedAttachmentRoom(ctx)
    if (room) await uploadCtrl.complete(ctx, room)
}

export async function abortRoomAttachmentUpload(ctx: any) {
    const room = await authorizedAttachmentRoom(ctx)
    if (room) await uploadCtrl.abort(ctx, room)
}

export async function readRoomAttachment(ctx: any) {
    const room = await authorizedAttachmentRoom(ctx)
    if (room) await inviteCtrl.readRoomAttachment(ctx, room)
}

function generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

function generateInviteCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    return Array.from(randomBytes(16), byte => chars[byte & 31]).join('')
}

function contentPreview(content: unknown): string {
    const value = typeof content === 'string' ? content : JSON.stringify(content ?? '')
    return value.length > 500 ? `${value.slice(0, 500)}…` : value
}

type AgentInput = {
    presetId?: string
    agent?: 'hermes' | 'ekko' | 'codex' | 'claude' | 'pi' | 'grok' | 'opencode' | 'dsh' | 'cursor'
    agentMode?: 'scoped' | 'global'
    priorAgentMode?: 'scoped' | 'global' | ''
    profile: string
    provider?: string
    model?: string
    apiMode?: string
    agentPreset?: string
    reasoningEffort?: string
    name?: string
    description?: string
    avatar?: string
    invited?: boolean | number
}

async function resolvePresetInput(user: any, input: AgentInput): Promise<AgentInput> {
    const presetId = typeof input.presetId === 'string' ? input.presetId.trim() : ''
    if (!presetId) return input
    return agentPresetCtrl.resolveGroupAgentPresetForApplication(user, presetId)
}

type RoomSummaryInput = {
    profile?: string
    provider?: string
    model?: string
    apiMode?: string
    everyTurns?: number
}

const GROUP_AGENT_REASONING_EFFORTS = new Set(['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const GROUP_AGENT_TYPES = new Set(['hermes', 'ekko', 'codex', 'claude', 'pi', 'grok', 'opencode', 'dsh', 'cursor'])
const GROUP_AGENT_API_MODES = new Set(['chat_completions', 'codex_responses', 'anthropic_messages'])
const GLOBAL_MODE_GROUP_AGENTS = new Set(['codex', 'claude', 'pi', 'grok', 'opencode', 'dsh', 'cursor'])
const GROUP_AGENT_AVATAR_MAX_LENGTH = 1_500_000

function normalizeRoomAgentAvatar(value: unknown): string {
    if (value === undefined || value === null || value === '') return ''
    if (typeof value !== 'string' || value.length > GROUP_AGENT_AVATAR_MAX_LENGTH) {
        throw new Error('Invalid agent avatar')
    }
    let parsed: any
    try {
        parsed = JSON.parse(value)
    } catch {
        throw new Error('Invalid agent avatar')
    }
    if (parsed?.type === 'generated' && typeof parsed.seed === 'string' && parsed.seed.trim() && parsed.seed.length <= 200) {
        return JSON.stringify({ type: 'generated', seed: parsed.seed.trim() })
    }
    if (
        parsed?.type === 'image' &&
        typeof parsed.dataUrl === 'string' &&
        /^data:image\/(?:png|jpeg|webp);base64,/i.test(parsed.dataUrl) &&
        parsed.dataUrl.length <= GROUP_AGENT_AVATAR_MAX_LENGTH
    ) {
        return JSON.stringify({ type: 'image', dataUrl: parsed.dataUrl })
    }
    throw new Error('Invalid agent avatar')
}

function sanitizeAgentConnectReason(reason?: string): string {
    return (reason || 'agent runtime connection failed')
        .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]')
        .replace(/(api[_-]?key|token|secret|password)=([^\s]+)/gi, '$1=[REDACTED]')
        .split('\n')[0]
        .slice(0, 240)
}

function agentConnectFailureBody(profile: string, err: any) {
    return {
        code: 'PROFILE_AGENT_CONNECT_FAILED',
        error: `Failed to connect agent "${profile}" to room`,
        profile,
        reason: sanitizeAgentConnectReason(err?.message),
    }
}

function applyParticipantNameConflict(ctx: any, err: any): boolean {
    if (err?.code !== ROOM_PARTICIPANT_NAME_CONFLICT) return false
    ctx.status = 409
    ctx.body = { code: ROOM_PARTICIPANT_NAME_CONFLICT, error: err.message }
    return true
}

function applyAgentAvailabilityError(ctx: any, err: any): boolean {
    if (err?.code !== AGENT_NOT_INSTALLED) return false
    ctx.status = Number(err.status || 409)
    ctx.body = { code: err.code, error: err.message, agent: err.agent }
    return true
}

async function createRoomAgentRuntimeClient(server: GroupChatServer, agentId: string, input: AgentInput) {
    const agent = String(input.agent || 'hermes').trim() as AgentInput['agent']
    assertAgentAvailable(agent)
    const profile = input.profile.trim()
    return server.agentClients.createAgent({
        agentId,
        agent: agent || 'hermes',
        agentMode: input.agentMode === 'global' ? 'global' : 'scoped',
        profile,
        provider: String(input.provider || '').trim(),
        model: String(input.model || '').trim(),
        apiMode: agent === 'hermes' ? '' : String(input.apiMode || '').trim(),
        reasoningEffort: String(input.reasoningEffort || '').trim(),
        agentPreset: input.agentPreset,
        name: input.name || profile,
        description: input.description || '',
        invited: input.invited ? 1 : 0,
        backgroundDelegationEnabled: false,
    })
}

export function serializeRoom(room: any, includeManageFields: boolean, canMentionAll = false) {
    if (!room) return room
    const {
        ownerAuthUserId: _ownerAuthUserId,
        summaryGeneration: _summaryGeneration,
        summaryRunToken: _summaryRunToken,
        summaryLeaseExpiresAt: _summaryLeaseExpiresAt,
        summaryRunGeneration: _summaryRunGeneration,
        ...rest
    } = room
    const ownerAuthUserId = Number(room.ownerAuthUserId || 0)
    const serialized = {
        ...rest,
        canManage: includeManageFields,
        canMentionAll,
        ownerMemberId: ownerAuthUserId > 0 ? `auth:${ownerAuthUserId}` : '',
    }
    if (Object.prototype.hasOwnProperty.call(room, 'inviteCode')) {
        serialized.inviteCode = includeManageFields ? room.inviteCode ?? null : null
    }
    if (Object.prototype.hasOwnProperty.call(room, 'workspace')) {
        serialized.workspace = includeManageFields ? String(room.workspace || '') : ''
    }
    return serialized
}

function persistRoomCreator(
    storage: ReturnType<GroupChatServer['getStorage']>,
    roomId: string,
    user: any,
    memberName?: string,
    memberDescription?: string,
): void {
    if (typeof user?.id !== 'number' || user.id <= 0) return
    storage.setRoomOwnerAuthUserId?.(roomId, user.id)
    const username = memberName?.trim() || String(user.username || `User-${user.id}`)
    storage.addRoomMember(roomId, `auth:${user.id}`, username, memberDescription?.trim() || '', '', user.id)
}

function visibleRoomsForUser(storage: ReturnType<GroupChatServer['getStorage']>, user: any) {
    if (!user) return storage.getAllRooms().map(room => serializeRoom(room, true, true))
    if (user.role === 'super_admin') {
        return storage.getAllRooms().map(room => serializeRoom(
            room,
            true,
            isGroupChatRoomOwner(storage, room.id, user),
        ))
    }
    const byId = new Map<string, { room: any; includeWorkspace: boolean }>()
    const addRoom = (room: any, includeWorkspace: boolean) => {
        if (!room) return
        const existing = byId.get(room.id)
        if (!existing || includeWorkspace) byId.set(room.id, { room, includeWorkspace: includeWorkspace || existing?.includeWorkspace === true })
    }
    for (const room of storage.getRoomsForProfiles(userProfiles(user))) addRoom(room, true)
    if (typeof user.id === 'number') {
        if (typeof storage.getOwnedRoomsForAuthUser === 'function') {
            for (const room of storage.getOwnedRoomsForAuthUser(user.id)) addRoom(room, true)
        }
        if (typeof storage.getRoomsForAuthUser === 'function') {
            for (const room of storage.getRoomsForAuthUser(user.id)) addRoom(room, canManageRoom(storage, room.id, user))
        }
    }
    return [...byId.values()]
        .sort((a, b) => Number(b.room.lastActiveAt || 0) - Number(a.room.lastActiveAt || 0) || a.room.id.localeCompare(b.room.id))
        .map(({ room, includeWorkspace }) => serializeRoom(
            room,
            includeWorkspace,
            isGroupChatRoomOwner(storage, room.id, user),
        ))
}

function roomAgentSummaries(storage: ReturnType<GroupChatServer['getStorage']>, roomId: string) {
    const agents = typeof storage.getRoomAgents === 'function'
        ? storage.getRoomAgents(roomId)
        : []
    return agents.map((agent: any) => ({
        id: agent.id,
        roomId: agent.roomId,
        agentId: agent.agentId,
        agent: agent.agent,
        name: agent.name,
        avatar: agent.avatar || '',
    }))
}

async function connectAndPersistRoomAgent(server: GroupChatServer, roomId: string, input: AgentInput, agentId = generateId()) {
    const agent = String(input.agent || 'hermes').trim() as AgentInput['agent']
    if (!GROUP_AGENT_TYPES.has(agent || '')) {
        throw new Error('Invalid agent')
    }
    if (input.agentMode !== undefined && input.agentMode !== 'scoped' && input.agentMode !== 'global') {
        throw new Error('Invalid agentMode')
    }
    const profile = input.profile.trim()
    const agentMode = agent === 'cursor' ? 'global' : input.agentMode === 'global' ? 'global' : 'scoped'
    if (agentMode === 'global' && !GLOBAL_MODE_GROUP_AGENTS.has(agent || '')) {
        throw new Error('Global mode is only available for Claude, Codex, Pi, Grok, OpenCode, DSH, and Cursor')
    }
    const provider = agentMode === 'global' ? '' : String(input.provider || '').trim()
    const model = agentMode === 'global' ? '' : String(input.model || '').trim()
    const apiMode = agent === 'hermes' || agentMode === 'global' ? '' : String(input.apiMode || '').trim()
    const reasoningEffort = agentMode === 'global' ? '' : String(input.reasoningEffort || '').trim()
    const name = input.name || profile
    const description = input.description || ''
    const avatar = normalizeRoomAgentAvatar(input.avatar)
    const invited = input.invited ? 1 : 0
    const storage = server.getStorage()
    storage.assertParticipantNameAvailable?.(roomId, name)
    const client = await createRoomAgentRuntimeClient(server, agentId, {
        ...input,
        agent,
        agentMode,
        provider,
        model,
        apiMode,
        reasoningEffort,
    })

    let persisted: any
    try {
        persisted = storage.addRoomAgent(roomId, agentId, profile, name, description, invited, {
            agent: agent || 'hermes',
            agentMode,
            priorAgentMode: input.priorAgentMode === 'global' || input.priorAgentMode === 'scoped' ? input.priorAgentMode : '',
            provider,
            model,
            apiMode,
            reasoningEffort,
            agentPreset: input.agentPreset,
            ...(avatar ? { avatar } : {}),
        })
        await server.agentClients.addAgentToRoom(roomId, client)
        return persisted
    } catch (err) {
        if (persisted) storage.removeRoomAgent(roomId, persisted.id || agentId)
        else await client.disconnect?.()
        await server.agentClients.removeAgentFromRoom(roomId, client.agentId)
        throw err
    }
}

// Create room
export async function createRoom(ctx: any) {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const createInput = ctx.request.body as {
        name?: string
        inviteCode?: string
        agents?: {
            presetId?: string
            agent?: 'hermes' | 'ekko' | 'codex' | 'claude' | 'pi' | 'grok' | 'opencode' | 'dsh' | 'cursor'
            agentMode?: 'scoped' | 'global'
            profile: string
            provider?: string
            model?: string
            apiMode?: string
            agentPreset?: string
            reasoningEffort?: string
            name?: string
            description?: string
            avatar?: string
            invited?: boolean
        }[]
        summary?: RoomSummaryInput
        workspace?: string
        memberName?: string
        memberDescription?: string
    }
    const { name, inviteCode, agents, summary, workspace, memberName, memberDescription } = createInput
    if (!name || !inviteCode) {
        ctx.status = 400
        ctx.body = { error: 'name and inviteCode are required' }
        return
    }
    const hasSummaryConfig = summary !== undefined
    const summaryProfile = String(summary?.profile || 'default').trim() || 'default'
    const summaryProvider = String(summary?.provider || '').trim()
    const summaryModel = String(summary?.model || '').trim()
    const summaryApiMode = String(summary?.apiMode || 'chat_completions').trim()
    const summaryEveryTurns = Math.floor(Number(summary?.everyTurns ?? 20))
    if (hasSummaryConfig && (!summaryProvider || !summaryModel)) {
        ctx.status = 400
        ctx.body = { error: 'summary profile, provider and model are required' }
        return
    }
    if (hasSummaryConfig && !GROUP_AGENT_API_MODES.has(summaryApiMode)) {
        ctx.status = 400
        ctx.body = { error: 'Invalid summary apiMode' }
        return
    }
    if (hasSummaryConfig && (!Number.isFinite(summaryEveryTurns) || summaryEveryTurns < 1 || summaryEveryTurns > 1000)) {
        ctx.status = 400
        ctx.body = { error: 'summary everyTurns must be between 1 and 1000' }
        return
    }
    if (
        (memberName !== undefined && typeof memberName !== 'string') ||
        (memberDescription !== undefined && typeof memberDescription !== 'string')
    ) {
        ctx.status = 400
        ctx.body = { error: 'memberName and memberDescription must be strings' }
        return
    }
    if ((memberName?.trim().length || 0) > 120 || (memberDescription?.trim().length || 0) > 2000) {
        ctx.status = 400
        ctx.body = { error: 'Member profile is too long' }
        return
    }
    let resolvedAgents: AgentInput[]
    try {
        resolvedAgents = await Promise.all((agents || []).map(agent => resolvePresetInput(ctx.state?.user, agent)))
    } catch (err: any) {
        ctx.status = Number(err?.status || 409)
        ctx.body = { code: err?.code, error: err?.message || 'Agent preset is unavailable' }
        return
    }
    try {
        for (const agent of resolvedAgents) assertAgentAvailable(agent.agent || 'hermes')
    } catch (err: any) {
        ctx.status = Number(err?.status || 400)
        ctx.body = { code: err?.code, error: err?.message || 'Invalid agent', agent: err?.agent }
        return
    }
    const invalidAgentMode = resolvedAgents.find(agent => (
        (agent.agentMode !== undefined && agent.agentMode !== 'scoped' && agent.agentMode !== 'global')
        || (agent.agentMode === 'global' && !GLOBAL_MODE_GROUP_AGENTS.has(agent.agent || 'hermes'))
    ))
    if (invalidAgentMode) {
        ctx.status = 400
        ctx.body = {
            error: invalidAgentMode.agentMode === 'global'
                ? 'Global mode is only available for Claude, Codex, Pi, Grok, OpenCode, DSH, and Cursor'
                : 'Invalid agentMode',
        }
        return
    }
    const reservedAgent = resolvedAgents.find(a => isReservedMentionName(a.name || a.profile))
    if (reservedAgent) {
        ctx.status = 400
        ctx.body = { error: '`all` is reserved for @all mentions' }
        return
    }

    const roomId = generateId()
    const storage = chatServer.getStorage()
    let normalizedWorkspace = ''
    if (workspace !== undefined) {
        if (typeof workspace !== 'string') {
            ctx.status = 400
            ctx.body = { error: 'workspace must be a string' }
            return
        }
        const rawWorkspace = workspace.trim()
        if (rawWorkspace) {
            try {
                normalizedWorkspace = (await assertAllowedWorkspaceFolder(rawWorkspace)).fullPath
            } catch (err: any) {
                ctx.status = Number(err?.status || 403)
                ctx.body = { error: err?.message || 'Workspace folder is not allowed' }
                return
            }
        }
    }
    if (!normalizedWorkspace) {
        normalizedWorkspace = chatServer.ensureDefaultRoomWorkspace(roomId, summaryProfile)
    }
    const roomConfig = {
        summaryProfile,
        summaryProvider,
        summaryModel,
        summaryApiMode,
        summaryEveryTurns,
        workspace: normalizedWorkspace,
    }
    storage.saveRoom(roomId, name, inviteCode, roomConfig)
    persistRoomCreator(storage, roomId, ctx.state?.user, memberName, memberDescription)

    const addedAgents = []
    const agentResults = []
    for (const a of resolvedAgents) {
        try {
            const agent = await connectAndPersistRoomAgent(chatServer, roomId, {
                agent: a.agent,
                agentMode: a.agentMode,
                priorAgentMode: a.priorAgentMode,
                profile: a.profile,
                provider: a.provider,
                model: a.model,
                apiMode: a.apiMode,
                reasoningEffort: a.reasoningEffort,
                agentPreset: a.agentPreset,
                name: a.name || a.profile,
                description: a.description || '',
                avatar: a.avatar,
                invited: a.invited,
            })
            addedAgents.push(agent)
            agentResults.push({ profile: a.profile, ok: true, agent })
        } catch (err: any) {
            console.error(`[GroupChat] Failed to connect agent ${a.profile} to room ${roomId}: ${sanitizeAgentConnectReason(err.message)}`)
            agentResults.push({ ok: false, ...agentConnectFailureBody(a.profile, err) })
        }
    }

    const room = storage.getRoom(roomId)
    ctx.body = {
        room: serializeRoom(room, true, isGroupChatRoomOwner(storage, roomId, ctx.state?.user)),
        agents: addedAgents,
        agentResults,
    }
}

// Clone room roles/config without copying the conversation context.
export async function cloneRoom(ctx: any) {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const storage = chatServer.getStorage()
    const sourceRoom = storage.getRoom(ctx.params.roomId)
    if (!sourceRoom) {
        ctx.status = 404
        ctx.body = { error: 'Room not found' }
        return
    }
    if (!canManageRoom(storage, sourceRoom.id, ctx.state?.user)) {
        ctx.status = 403
        ctx.body = { error: 'Access denied' }
        return
    }

    const { name, inviteCode } = ctx.request.body as { name?: string; inviteCode?: string }
    const roomId = generateId()
    const code = inviteCode?.trim() || generateInviteCode()
    storage.saveRoom(roomId, name?.trim() || `${sourceRoom.name} Copy`, code, {
        summaryProfile: sourceRoom.summaryProfile,
        summaryProvider: sourceRoom.summaryProvider,
        summaryModel: sourceRoom.summaryModel,
        summaryApiMode: sourceRoom.summaryApiMode,
        summaryEveryTurns: sourceRoom.summaryEveryTurns,
        workspace: sourceRoom.workspace || '',
        agentHandoffEnabled: Number(sourceRoom.agentHandoffEnabled ?? 1) === 1,
        agentHandoffMaxDepth: sourceRoom.agentHandoffMaxDepth ?? null,
        agentHandoffUnlimited: Number(sourceRoom.agentHandoffUnlimited || 0) === 1,
    })
    persistRoomCreator(storage, roomId, ctx.state?.user)

    const addedAgents = []
    const agentResults = []
    for (const sourceAgent of storage.getRoomAgents(sourceRoom.id)) {
        if (sourceAgent.executorType === 'remote') continue
        try {
            const agent = await connectAndPersistRoomAgent(chatServer, roomId, {
                agent: sourceAgent.agent,
                agentMode: sourceAgent.agentMode,
                priorAgentMode: sourceAgent.priorAgentMode,
                profile: sourceAgent.profile,
                provider: sourceAgent.provider,
                model: sourceAgent.model,
                apiMode: sourceAgent.apiMode,
                reasoningEffort: sourceAgent.reasoningEffort,
                agentPreset: sourceAgent.agentPreset,
                name: sourceAgent.name,
                description: sourceAgent.description,
                avatar: sourceAgent.avatar,
                invited: sourceAgent.invited,
            })
            addedAgents.push(agent)
            agentResults.push({ profile: sourceAgent.profile, ok: true, agent })
        } catch (err: any) {
            console.error(`[GroupChat] Failed to connect cloned agent ${sourceAgent.profile} to room ${roomId}: ${sanitizeAgentConnectReason(err.message)}`)
            agentResults.push({ ok: false, ...agentConnectFailureBody(sourceAgent.profile, err) })
        }
    }

    const room = storage.getRoom(roomId)
    ctx.body = {
        room: serializeRoom(room, true, isGroupChatRoomOwner(storage, roomId, ctx.state?.user)),
        agents: addedAgents,
        agentResults,
    }
}

// Get room detail and messages
export async function getRoom(ctx: any) {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const storage = chatServer.getStorage()
    const room = storage.getRoom(ctx.params.roomId)
    if (!room) {
        ctx.status = 404
        ctx.body = { error: 'Room not found' }
        return
    }
    const canManage = canManageRoom(storage, room.id, ctx.state?.user)
    if (!canManage && !canReadRoom(storage, room.id, ctx.state?.user)) {
        ctx.status = 403
        ctx.body = { error: 'Access denied' }
        return
    }

    const offset = ctx.query?.offset ? Math.max(0, parseInt(ctx.query.offset as string, 10) || 0) : 0
    const limit = ctx.query?.limit
        ? Math.min(150, Math.max(1, parseInt(ctx.query.limit as string, 10) || 150))
        : 150
    const beforeMessageId = String(ctx.query?.before || '').trim()
    const historyPage = beforeMessageId || ctx.query?.history === '1'
        ? storage.getHistoryPageForUI(ctx.params.roomId, limit, beforeMessageId || undefined)
        : null
    if (historyPage && !historyPage.cursorFound) {
        ctx.status = 400
        ctx.body = { error: 'History cursor not found' }
        return
    }
    const messages = historyPage?.messages
        ?? storage.getRecentMessagesForUI(ctx.params.roomId, limit, offset)
    const storedTotal = storage.getMessageCount(ctx.params.roomId)
    const total = storedTotal
    const agents = typeof chatServer.getRoomAgentViews === 'function'
        ? chatServer.getRoomAgentViews(ctx.params.roomId, canManage)
        : storage.getRoomAgents(ctx.params.roomId)
    const members = storage.getRoomMembers(ctx.params.roomId)
    ctx.body = {
        room: serializeRoom(room, canManage, isGroupChatRoomOwner(storage, room.id, ctx.state?.user)),
        messages,
        agents,
        members,
        handoffChains: storage.getStoppedHandoffChains?.(ctx.params.roomId) || [],
        total,
        offset,
        limit,
        hasMore: historyPage?.hasMore ?? offset + messages.length < total,
        historyTruncated: storedTotal > GROUP_CHAT_MESSAGE_WINDOW,
    }
}

// List rooms
export async function listRooms(ctx: any) {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const user = ctx.state?.user
    const storage = chatServer.getStorage()
    const visibleRooms = visibleRoomsForUser(storage, user).map(room => ({
        ...room,
        agents: roomAgentSummaries(storage, room.id),
    }))
    const paginated = ctx.query?.offset !== undefined || ctx.query?.limit !== undefined
    const offset = paginated && ctx.query?.offset
        ? Math.max(0, parseInt(ctx.query.offset as string, 10) || 0)
        : 0
    const limit = paginated && ctx.query?.limit
        ? Math.min(50, Math.max(1, parseInt(ctx.query.limit as string, 10) || 50))
        : visibleRooms.length
    const rooms = visibleRooms.slice(offset, offset + limit)
    ctx.body = paginated ? {
        rooms,
        total: visibleRooms.length,
        offset,
        limit,
        hasMore: offset + rooms.length < visibleRooms.length,
    } : { rooms }
}

// Update room invite code
export async function updateRoomInviteCode(ctx: any) {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const storage = chatServer.getStorage()
    const room = storage.getRoom(ctx.params.roomId)
    if (!room) {
        ctx.status = 404
        ctx.body = { error: 'Room not found' }
        return
    }
    if (!canManageRoom(storage, ctx.params.roomId, ctx.state?.user)) {
        ctx.status = 403
        ctx.body = { error: 'Access denied' }
        return
    }

    const { inviteCode } = ctx.request.body as { inviteCode?: string }
    if (!inviteCode) {
        ctx.status = 400
        ctx.body = { error: 'inviteCode is required' }
        return
    }

    storage.updateRoomInviteCode(ctx.params.roomId, inviteCode)
    chatServer.broadcastRoomMetadata(ctx.params.roomId)
    ctx.body = { success: true }
}

// Add agent to room
export async function addRoomAgent(ctx: any) {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    let body: AgentInput
    try {
        body = await resolvePresetInput(ctx.state?.user, ctx.request.body as AgentInput)
    } catch (err: any) {
        ctx.status = Number(err?.status || 409)
        ctx.body = { code: err?.code, error: err?.message || 'Agent preset is unavailable' }
        return
    }
    const { agent, agentMode, priorAgentMode, profile, provider, model, apiMode, reasoningEffort, agentPreset, name, description, avatar, invited } = body as {
        agent?: string
        agentMode?: string
        priorAgentMode?: string
        profile?: string
        provider?: string
        model?: string
        apiMode?: string
        agentPreset?: string
        reasoningEffort?: string
        name?: string
        description?: string
        avatar?: string
        invited?: boolean
    }
    const normalizedProfile = typeof profile === 'string' ? profile.trim() : ''
    const normalizedAgent = typeof agent === 'string' ? agent.trim() : 'hermes'
    const normalizedAgentMode = normalizedAgent === 'cursor' || agentMode === 'global' ? 'global' : 'scoped'
    const normalizedProvider = normalizedAgentMode === 'global' ? '' : typeof provider === 'string' ? provider.trim() : ''
    const normalizedModel = normalizedAgentMode === 'global' ? '' : typeof model === 'string' ? model.trim() : ''
    const normalizedApiMode = normalizedAgent === 'hermes' || normalizedAgentMode === 'global'
        ? ''
        : typeof apiMode === 'string' ? apiMode.trim() : ''
    const normalizedReasoningEffort = normalizedAgentMode === 'global'
        ? ''
        : typeof reasoningEffort === 'string' ? reasoningEffort.trim() : ''
    let normalizedAvatar = ''
    try {
        normalizedAvatar = normalizeRoomAgentAvatar(avatar)
    } catch (err: any) {
        ctx.status = 400
        ctx.body = { error: err.message }
        return
    }
    if (!normalizedProfile) {
        ctx.status = 400
        ctx.body = { error: 'profile is required' }
        return
    }
    if (!GROUP_AGENT_TYPES.has(normalizedAgent)) {
        ctx.status = 400
        ctx.body = { error: 'Invalid agent' }
        return
    }
    if (agentMode !== undefined && agentMode !== 'scoped' && agentMode !== 'global') {
        ctx.status = 400
        ctx.body = { error: 'Invalid agentMode' }
        return
    }
    if (normalizedAgentMode === 'global' && !GLOBAL_MODE_GROUP_AGENTS.has(normalizedAgent)) {
        ctx.status = 400
        ctx.body = { error: 'Global mode is only available for Claude, Codex, Pi, Grok, OpenCode, DSH, and Cursor' }
        return
    }
    if (Boolean(normalizedProvider) !== Boolean(normalizedModel)) {
        ctx.status = 400
        ctx.body = { error: 'provider and model must be provided together' }
        return
    }
    if (normalizedAgent !== 'hermes' && normalizedAgentMode !== 'global' && !GROUP_AGENT_API_MODES.has(normalizedApiMode)) {
        ctx.status = 400
        ctx.body = { error: 'Invalid apiMode' }
        return
    }
    if (!GROUP_AGENT_REASONING_EFFORTS.has(normalizedReasoningEffort)) {
        ctx.status = 400
        ctx.body = { error: 'Invalid reasoningEffort' }
        return
    }
    if (isReservedMentionName(name || normalizedProfile)) {
        ctx.status = 400
        ctx.body = { error: '`all` is reserved for @all mentions' }
        return
    }

    const storage = chatServer.getStorage()
    if (typeof storage.getRoom === 'function' && !storage.getRoom(ctx.params.roomId)) {
        ctx.status = 404
        ctx.body = { error: 'Room not found' }
        return
    }
    if (!canManageRoom(storage, ctx.params.roomId, ctx.state?.user)) {
        ctx.status = 403
        ctx.body = { error: 'Access denied' }
        return
    }

    try {
        const agent = await connectAndPersistRoomAgent(chatServer, ctx.params.roomId, {
            agent: normalizedAgent as AgentInput['agent'],
            agentMode: normalizedAgentMode,
            priorAgentMode: priorAgentMode === 'global' || priorAgentMode === 'scoped' ? priorAgentMode : '',
            profile: normalizedProfile,
            provider: normalizedProvider,
            model: normalizedModel,
            apiMode: normalizedApiMode,
            reasoningEffort: normalizedReasoningEffort,
            agentPreset: typeof agentPreset === 'string' ? agentPreset.trim() : undefined,
            name: name || normalizedProfile,
            description: description || '',
            avatar: normalizedAvatar,
            invited,
        })
        chatServer.broadcastRoomAgents(ctx.params.roomId)
        ctx.body = { agent }
    } catch (err: any) {
        if (applyParticipantNameConflict(ctx, err)) return
        if (applyAgentAvailabilityError(ctx, err)) return
        console.error(`[GroupChat] Failed to connect agent ${normalizedProfile} to room ${ctx.params.roomId}: ${sanitizeAgentConnectReason(err.message)}`)
        ctx.status = 502
        ctx.body = agentConnectFailureBody(normalizedProfile, err)
    }
}

// Update an agent and replace only its group-chat runtime client.
export async function updateRoomAgent(ctx: any) {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const { agent, agentMode, priorAgentMode, profile, provider, model, apiMode, reasoningEffort, agentPreset, name, description, avatar } = ctx.request.body as {
        agent?: string
        agentMode?: string
        priorAgentMode?: string
        profile?: string
        provider?: string
        model?: string
        apiMode?: string
        agentPreset?: string
        reasoningEffort?: string
        name?: string
        description?: string
        avatar?: string
    }
    const normalizedProfile = typeof profile === 'string' ? profile.trim() : ''
    const normalizedAgent = typeof agent === 'string' ? agent.trim() : 'hermes'
    const normalizedAgentMode = normalizedAgent === 'cursor' || agentMode === 'global' ? 'global' : 'scoped'
    const normalizedProvider = normalizedAgentMode === 'global' ? '' : typeof provider === 'string' ? provider.trim() : ''
    const normalizedModel = normalizedAgentMode === 'global' ? '' : typeof model === 'string' ? model.trim() : ''
    const normalizedApiMode = normalizedAgent === 'hermes' || normalizedAgentMode === 'global'
        ? ''
        : typeof apiMode === 'string' ? apiMode.trim() : ''
    const normalizedReasoningEffort = normalizedAgentMode === 'global'
        ? ''
        : typeof reasoningEffort === 'string' ? reasoningEffort.trim() : ''
    const normalizedName = typeof name === 'string' ? name.trim() : ''
    const normalizedDescription = typeof description === 'string' ? description.trim() : ''
    let normalizedAvatar = ''
    try {
        normalizedAvatar = normalizeRoomAgentAvatar(avatar)
    } catch (err: any) {
        ctx.status = 400
        ctx.body = { error: err.message }
        return
    }
    if (!normalizedProfile) {
        ctx.status = 400
        ctx.body = { error: 'profile is required' }
        return
    }
    if (!GROUP_AGENT_TYPES.has(normalizedAgent)) {
        ctx.status = 400
        ctx.body = { error: 'Invalid agent' }
        return
    }
    if (agentMode !== undefined && agentMode !== 'scoped' && agentMode !== 'global') {
        ctx.status = 400
        ctx.body = { error: 'Invalid agentMode' }
        return
    }
    if (normalizedAgentMode === 'global' && !GLOBAL_MODE_GROUP_AGENTS.has(normalizedAgent)) {
        ctx.status = 400
        ctx.body = { error: 'Global mode is only available for Claude, Codex, Pi, Grok, OpenCode, DSH, and Cursor' }
        return
    }
    if (Boolean(normalizedProvider) !== Boolean(normalizedModel)) {
        ctx.status = 400
        ctx.body = { error: 'provider and model must be provided together' }
        return
    }
    if (normalizedAgent !== 'hermes' && normalizedAgentMode !== 'global' && !GROUP_AGENT_API_MODES.has(normalizedApiMode)) {
        ctx.status = 400
        ctx.body = { error: 'Invalid apiMode' }
        return
    }
    if (!GROUP_AGENT_REASONING_EFFORTS.has(normalizedReasoningEffort)) {
        ctx.status = 400
        ctx.body = { error: 'Invalid reasoningEffort' }
        return
    }
    if (isReservedMentionName(normalizedName || normalizedProfile)) {
        ctx.status = 400
        ctx.body = { error: '`all` is reserved for @all mentions' }
        return
    }

    const roomId = ctx.params.roomId
    const requestedAgentId = ctx.params.agentId
    const storage = chatServer.getStorage()
    if (typeof storage.getRoom === 'function' && !storage.getRoom(roomId)) {
        ctx.status = 404
        ctx.body = { error: 'Room not found' }
        return
    }
    if (!canManageRoom(storage, roomId, ctx.state?.user)) {
        ctx.status = 403
        ctx.body = { error: 'Access denied' }
        return
    }
    const previous = storage.getRoomAgent(roomId, requestedAgentId)
    if (!previous) {
        ctx.status = 404
        ctx.body = { error: 'Agent not found' }
        return
    }
    if (roomDeletions.has(roomId)) {
        ctx.status = 409
        ctx.body = { error: 'Room deletion is already in progress' }
        return
    }
    if (previous.executorType === 'remote') {
        ctx.status = 409
        ctx.body = { error: 'Remote Agents must be changed from their connected Hermes service or re-paired' }
        return
    }

    const nextInput: AgentInput = {
        agent: normalizedAgent as AgentInput['agent'],
        agentMode: normalizedAgentMode,
        priorAgentMode: priorAgentMode === 'global' || priorAgentMode === 'scoped' ? priorAgentMode : '',
        profile: normalizedProfile,
        provider: normalizedProvider,
        model: normalizedModel,
        apiMode: normalizedApiMode,
        reasoningEffort: normalizedReasoningEffort,
        agentPreset: typeof agentPreset === 'string' ? agentPreset.trim() : undefined,
        name: normalizedName || normalizedProfile,
        description: normalizedDescription,
        avatar: normalizedAvatar,
        invited: previous.invited,
    }
    try {
        storage.assertParticipantNameAvailable?.(roomId, nextInput.name || nextInput.profile, {
            excludeAgentRef: previous.id,
        })
    } catch (err: any) {
        if (applyParticipantNameConflict(ctx, err)) return
        ctx.status = 500
        ctx.body = { error: 'Failed to validate participant name' }
        return
    }
    const updateKey = `${roomId}:${previous.agentId}`
    if (roomAgentUpdates.has(updateKey)) {
        ctx.status = 409
        ctx.body = { error: 'Agent configuration update is already in progress' }
        return
    }
    roomAgentUpdates.add(updateKey)
    let replacement: Awaited<ReturnType<typeof createRoomAgentRuntimeClient>> | null = null
    let runtimeSwapped = false
    try {
        // Establish the new gateway connection before interrupting the current room client.
        replacement = await createRoomAgentRuntimeClient(chatServer, previous.agentId, nextInput)
        await chatServer.agentClients.removeAgentFromRoom(roomId, previous.agentId)
        runtimeSwapped = true
        await chatServer.agentClients.addAgentToRoom(roomId, replacement)
        const updated = storage.updateRoomAgent(
            roomId,
            requestedAgentId,
            nextInput.profile,
            nextInput.name || nextInput.profile,
            nextInput.description || '',
            {
                agent: nextInput.agent,
                agentMode: nextInput.agentMode,
                priorAgentMode: nextInput.priorAgentMode === 'global' || nextInput.priorAgentMode === 'scoped' ? nextInput.priorAgentMode : '',
                provider: nextInput.provider,
                model: nextInput.model,
                apiMode: nextInput.apiMode,
                reasoningEffort: nextInput.reasoningEffort,
                agentPreset: nextInput.agentPreset,
                ...(nextInput.avatar ? { avatar: nextInput.avatar } : {}),
            },
        )
        if (!updated) throw new Error('Agent persistence update failed')
        const agents = chatServer.broadcastRoomAgents(roomId)
        ctx.body = {
            agent: updated,
            agents,
            members: storage.getRoomMembers(roomId),
        }
    } catch (err: any) {
        if (runtimeSwapped) {
            await chatServer.agentClients.removeAgentFromRoom(roomId, previous.agentId)
            try {
                const restored = await createRoomAgentRuntimeClient(chatServer, previous.agentId, previous)
                await chatServer.agentClients.addAgentToRoom(roomId, restored)
            } catch (restoreErr: any) {
                console.error(`[GroupChat] Failed to restore agent ${previous.profile} in room ${roomId}: ${sanitizeAgentConnectReason(restoreErr.message)}`)
            }
        } else {
            await replacement?.disconnect?.()
        }
        if (applyParticipantNameConflict(ctx, err)) return
        if (applyAgentAvailabilityError(ctx, err)) return
        console.error(`[GroupChat] Failed to update agent ${normalizedProfile} in room ${roomId}: ${sanitizeAgentConnectReason(err.message)}`)
        ctx.status = 502
        ctx.body = agentConnectFailureBody(normalizedProfile, err)
    } finally {
        roomAgentUpdates.delete(updateKey)
    }
}

// List agents in room
export async function listRoomAgents(ctx: any) {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const storage = chatServer.getStorage()
    if (typeof storage.getRoom === 'function' && !storage.getRoom(ctx.params.roomId)) {
        ctx.status = 404
        ctx.body = { error: 'Room not found' }
        return
    }
    if (!canReadRoom(storage, ctx.params.roomId, ctx.state?.user)) {
        ctx.status = 403
        ctx.body = { error: 'Access denied' }
        return
    }

    const agents = chatServer.getRoomAgentViews(
        ctx.params.roomId,
        canManageRoom(storage, ctx.params.roomId, ctx.state?.user),
    )
    ctx.body = { agents }
}

// Remove a human member and any remote Agents that member brought into the room.
export async function removeRoomMember(ctx: any) {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const roomId = String(ctx.params.roomId || '').trim()
    const userId = String(ctx.params.userId || '').trim()
    const storage = chatServer.getStorage()
    const room = storage.getRoom(roomId)
    if (!room) {
        ctx.status = 404
        ctx.body = { error: 'Room not found' }
        return
    }
    if (!isGroupChatRoomOwner(storage, roomId, ctx.state?.user)) {
        ctx.status = 403
        ctx.body = { error: 'Only the room owner can remove members' }
        return
    }
    const ownerAuthUserId = Number(room.ownerAuthUserId || 0)
    if (
        !userId
        || (ownerAuthUserId > 0 && userId === `auth:${ownerAuthUserId}`)
        || (typeof ctx.state?.user?.id === 'number' && userId === `auth:${ctx.state.user.id}`)
    ) {
        ctx.status = 400
        ctx.body = { error: 'The room owner cannot be removed' }
        return
    }

    const member = storage.getMemberByUserId?.(roomId, userId)
    if (!member) {
        ctx.status = 404
        ctx.body = { error: 'Member not found' }
        return
    }

    const removedAgents = storage.getRoomAgents(roomId)
        .filter(agent => agent.executorType === 'remote' && agent.ownerMemberId === userId)
    for (const agent of removedAgents) {
        if (agent.connectorId) revokeGroupAgentConnector(agent.connectorId)
        storage.removeRoomMembersForAgent(roomId, agent)
        storage.removeRoomAgent(roomId, agent.id)
        await chatServer.agentClients.removeAgentFromRoom(roomId, agent.agentId)
    }

    const members = chatServer.removeRoomMember(roomId, userId)
    if (!members) {
        ctx.status = 404
        ctx.body = { error: 'Member not found' }
        return
    }
    const agents = removedAgents.length
        ? chatServer.broadcastRoomAgents(roomId)
        : chatServer.getRoomAgentViews(roomId, false)
    ctx.body = { success: true, members, agents }
}

// Remove agent from room
export async function removeRoomAgent(ctx: any) {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const roomId = ctx.params.roomId
    const requestedAgentId = ctx.params.agentId
    const storage = chatServer.getStorage()
    if (!canManageRoom(storage, roomId, ctx.state?.user)) {
        ctx.status = 403
        ctx.body = { error: 'Access denied' }
        return
    }
    const agent = storage.getRoomAgent(roomId, requestedAgentId)
    if (!agent) {
        ctx.status = 404
        ctx.body = { error: 'Agent not found' }
        return
    }
    if (roomDeletions.has(roomId)) {
        ctx.status = 409
        ctx.body = { error: 'Room deletion is already in progress' }
        return
    }
    if (roomAgentUpdates.has(`${roomId}:${agent.agentId}`)) {
        ctx.status = 409
        ctx.body = { error: 'Agent configuration update is already in progress' }
        return
    }

    if (agent.executorType === 'remote' && agent.connectorId) {
        revokeGroupAgentConnector(agent.connectorId)
    }
    storage.removeRoomMembersForAgent(roomId, agent)
    storage.removeRoomAgent(roomId, requestedAgentId)
    await chatServer.agentClients.removeAgentFromRoom(roomId, agent.agentId)
    const agents = chatServer.broadcastRoomAgents(roomId)
    ctx.body = {
        success: true,
        agents,
        members: storage.getRoomMembers(roomId),
    }
}

// Delete room
export async function removeRoom(ctx: any) {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const roomId = ctx.params.roomId
    const storage = chatServer.getStorage()
    if (!storage.getRoom(roomId)) {
        ctx.status = 404
        ctx.body = { error: 'Room not found' }
        return
    }
    if (!canManageRoom(storage, roomId, ctx.state?.user)) {
        ctx.status = 403
        ctx.body = { error: 'Access denied' }
        return
    }
    if ([...roomAgentUpdates].some(key => key.startsWith(`${roomId}:`))) {
        ctx.status = 409
        ctx.body = { error: 'Agent configuration update is already in progress' }
        return
    }
    if (roomDeletions.has(roomId)) {
        ctx.status = 409
        ctx.body = { error: 'Room deletion is already in progress' }
        return
    }
    roomDeletions.add(roomId)
    // Interrupt active bridge runs, then evict sockets and disconnect agents before deleting persisted data.
    try {
        await chatServer.getRoomSummaryService().runExclusive(roomId, async () => {
            await chatServer!.deleteRoomRuntimeState(roomId)
            await deleteGroupChatAttachments(roomId)
            storage.deleteRoom(roomId)
        })
    } catch (err: any) {
        ctx.status = Number(err?.status || 409)
        ctx.body = { error: err?.message || 'Room interrupt did not complete' }
        return
    } finally {
        roomDeletions.delete(roomId)
    }
    ctx.body = { success: true }
}

// Clear current room context while keeping members, agents, and room config.
export async function clearRoomContext(ctx: any) {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const roomId = ctx.params.roomId
    const storage = chatServer.getStorage()
    const room = storage.getRoom(roomId)
    if (!room) {
        ctx.status = 404
        ctx.body = { error: 'Room not found' }
        return
    }
    if (!canManageRoom(storage, roomId, ctx.state?.user)) {
        ctx.status = 403
        ctx.body = { error: 'Access denied' }
        return
    }
    try {
        await chatServer.getRoomSummaryService().runExclusive(roomId, async () => {
            await chatServer!.clearRoomRuntimeState(roomId)
            storage.clearRoomContext(roomId)
        })
    } catch (err: any) {
        ctx.status = Number(err?.status || 409)
        ctx.body = { error: err?.message || 'Room interrupt did not complete' }
        return
    }
    ctx.body = {
        success: true,
        room: serializeRoom(
            storage.getRoom(roomId),
            true,
            isGroupChatRoomOwner(storage, roomId, ctx.state?.user),
        ),
    }
}

// Update room name and rolling-summary config
export async function updateRoomConfig(ctx: any) {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const roomId = ctx.params.roomId
    const { name, summaryProfile, summaryProvider, summaryModel, summaryApiMode, summaryEveryTurns, agentHandoffEnabled, agentHandoffMaxDepth, agentHandoffUnlimited } = ctx.request.body as {
        name?: string
        summaryProfile?: string
        summaryProvider?: string
        summaryModel?: string
        summaryApiMode?: string
        summaryEveryTurns?: number
        agentHandoffEnabled?: boolean
        agentHandoffMaxDepth?: number | null
        agentHandoffUnlimited?: boolean
    }

    const storage = chatServer.getStorage()
    const room = storage.getRoom(roomId)
    if (!room) {
        ctx.status = 404
        ctx.body = { error: 'Room not found' }
        return
    }
    if (!canManageRoom(storage, roomId, ctx.state?.user)) {
        ctx.status = 403
        ctx.body = { error: 'Access denied' }
        return
    }

    const hasNameUpdate = name !== undefined
    const hasSummaryUpdate = [
        summaryProfile,
        summaryProvider,
        summaryModel,
        summaryApiMode,
        summaryEveryTurns,
    ].some(value => value !== undefined)
    const hasHandoffUpdate = [agentHandoffEnabled, agentHandoffMaxDepth, agentHandoffUnlimited].some(value => value !== undefined)
    if (!hasNameUpdate && !hasSummaryUpdate && !hasHandoffUpdate) {
        ctx.status = 400
        ctx.body = { error: 'No room config changes supplied' }
        return
    }

    const normalizedName = hasNameUpdate && typeof name === 'string' ? name.trim() : room.name
    if (hasNameUpdate && (typeof name !== 'string' || !normalizedName || normalizedName.length > 120)) {
        ctx.status = 400
        ctx.body = { error: 'Room name must be between 1 and 120 characters' }
        return
    }

    const profile = String(summaryProfile ?? room.summaryProfile).trim()
    const provider = String(summaryProvider ?? room.summaryProvider).trim()
    const model = String(summaryModel ?? room.summaryModel).trim()
    const apiMode = String(summaryApiMode ?? room.summaryApiMode).trim()
    const everyTurns = Math.floor(Number(summaryEveryTurns ?? room.summaryEveryTurns))
    if (hasSummaryUpdate) {
        if (!profile || !provider || !model) {
            ctx.status = 400
            ctx.body = { error: 'summary profile, provider and model are required' }
            return
        }
        if (!GROUP_AGENT_API_MODES.has(apiMode)) {
            ctx.status = 400
            ctx.body = { error: 'Invalid summary apiMode' }
            return
        }
        if (!Number.isFinite(everyTurns) || everyTurns < 1 || everyTurns > 1000) {
            ctx.status = 400
            ctx.body = { error: 'summaryEveryTurns must be between 1 and 1000' }
            return
        }
    }
    if (agentHandoffMaxDepth !== undefined && agentHandoffMaxDepth !== null
        && (!Number.isInteger(Number(agentHandoffMaxDepth)) || Number(agentHandoffMaxDepth) < 1 || Number(agentHandoffMaxDepth) > 100)) {
        ctx.status = 400
        ctx.body = { error: 'agentHandoffMaxDepth must be between 1 and 100 or null' }
        return
    }

    await chatServer.getRoomSummaryService().runExclusive(roomId, () => {
        if (hasNameUpdate && normalizedName !== room.name) {
            chatServer!.updateRoomName(roomId, normalizedName)
        }
        if (hasSummaryUpdate || hasHandoffUpdate) {
            storage.updateRoomConfig(roomId, {
                ...(hasSummaryUpdate ? {
                    summaryProfile: profile,
                    summaryProvider: provider,
                    summaryModel: model,
                    summaryApiMode: apiMode,
                    summaryEveryTurns: everyTurns,
                } : {}),
                agentHandoffEnabled,
                agentHandoffMaxDepth,
                agentHandoffUnlimited,
            })
        }
    })
    chatServer.broadcastRoomMetadata(roomId)
    ctx.body = {
        room: serializeRoom(
            storage.getRoom(roomId),
            true,
            isGroupChatRoomOwner(storage, roomId, ctx.state?.user),
        ),
    }
}

export async function continueRoomHandoff(ctx: any) {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }
    const storage = chatServer.getStorage()
    const { roomId, chainId } = ctx.params
    if (!storage.getRoom(roomId)) {
        ctx.status = 404
        ctx.body = { error: 'Room not found' }
        return
    }
    if (!canManageRoom(storage, roomId, ctx.state?.user)) {
        ctx.status = 403
        ctx.body = { error: 'Access denied' }
        return
    }
    const existing = storage.getHandoffChain(roomId, chainId)
    if (!existing) {
        ctx.status = 404
        ctx.body = { error: 'Handoff chain not found' }
        return
    }
    if (existing.status === 'resumed' && Number(existing.continueUsed) === 1) {
        ctx.body = { success: true, replay: true, chain: existing }
        return
    }
    if (existing.status === 'outcome_unknown') {
        ctx.status = 409
        ctx.body = {
            code: 'HANDOFF_OUTCOME_UNKNOWN',
            error: 'Remote handoff outcome is unknown; automatic retry is disabled',
            chain: existing,
        }
        return
    }
    const chain = storage.claimHandoffContinuation(roomId, chainId)
    if (!chain || !chain.attemptId) {
        if (existing.status === 'claimed' && existing.attemptId) {
            ctx.status = 202
            ctx.body = {
                success: true,
                attemptId: existing.attemptId,
                status: existing.status,
                chain: existing,
            }
            return
        }
        ctx.status = 409
        ctx.body = { error: 'Handoff chain is already being continued or is no longer available', chain: existing }
        return
    }
    const source = storage.getMessage(String(chain.sourceMessageId))
    if (!source) {
        const failed = storage.failHandoffContinuation(roomId, chainId, 'Handoff source message is no longer available')
        ctx.status = 409
        ctx.body = { error: 'Handoff source message is no longer available', chain: failed || storage.getHandoffChain(roomId, chainId) }
        return
    }
    ctx.status = 202
    chatServer.broadcastHandoffUpdate(roomId, storage.getHandoffChain(roomId, chainId))
    ctx.body = {
        success: true,
        attemptId: chain.attemptId,
        status: 'continuing',
        chain: storage.getHandoffChain(roomId, chainId),
    }
}

export async function listRoomHandoffs(ctx: any) {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }
    const { roomId } = ctx.params
    const storage = chatServer.getStorage()
    if (!storage.getRoom(roomId)) {
        ctx.status = 404
        ctx.body = { error: 'Room not found' }
        return
    }
    if (!canReadRoom(storage, roomId, ctx.state?.user)) {
        ctx.status = 403
        ctx.body = { error: 'Access denied' }
        return
    }
    ctx.body = { chains: storage.getStoppedHandoffChains(roomId) }
}

// Update room workspace
export async function updateRoomWorkspace(ctx: any) {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const storage = chatServer.getStorage()
    const roomId = ctx.params.roomId
    const room = storage.getRoom(roomId)
    if (!room) {
        ctx.status = 404
        ctx.body = { error: 'Room not found' }
        return
    }
    if (!canManageRoom(storage, roomId, ctx.state?.user)) {
        ctx.status = 403
        ctx.body = { error: 'Access denied' }
        return
    }

    const { workspace } = ctx.request.body as { workspace: string }
    if (typeof workspace !== 'string') {
        ctx.status = 400
        ctx.body = { error: 'workspace must be a string' }
        return
    }

    try {
        const rawWorkspace = workspace.trim()
        const normalized = rawWorkspace ? (await assertAllowedWorkspaceFolder(rawWorkspace)).fullPath : ''
        if (normalized !== String(room.workspace || '')) {
            const releaseSessionFence = chatServer.fenceCurrentRoomAgentSessions(roomId)
            try {
                await chatServer.agentClients.interruptRoom(roomId)
            } catch (err) {
                releaseSessionFence()
                throw err
            }
        }
        ctx.body = {
            room: serializeRoom(
                storage.updateRoomWorkspace(roomId, normalized),
                true,
                isGroupChatRoomOwner(storage, roomId, ctx.state?.user),
            ),
        }
    } catch (err: any) {
        ctx.status = Number(err?.status || 403)
        ctx.body = { error: err?.message || 'Workspace folder is not allowed' }
    }
}

export async function getRoomSummary(ctx: any) {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const roomId = ctx.params.roomId
    const storage = chatServer.getStorage()
    const room = storage.getRoom(roomId)
    if (!room) {
        ctx.status = 404
        ctx.body = { error: 'Room not found' }
        return
    }
    if (!canManageRoom(storage, roomId, ctx.state?.user) && !canReadRoom(storage, roomId, ctx.state?.user)) {
        ctx.status = 403
        ctx.body = { error: 'Access denied' }
        return
    }

    const summary = chatServer.getRoomSummaryService().getState(roomId)
    const anchorMessage = summary.summaryThroughMessageId
        ? storage.getMessage(summary.summaryThroughMessageId)
        : null
    ctx.body = {
        summary,
        anchor: anchorMessage ? {
            id: anchorMessage.id,
            timestamp: anchorMessage.timestamp,
            senderName: anchorMessage.senderName,
            role: anchorMessage.role,
            content: contentPreview(anchorMessage.content),
        } : null,
    }
}

export async function updateRoomSummary(ctx: any) {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }
    const roomId = ctx.params.roomId
    const storage = chatServer.getStorage()
    if (!storage.getRoom(roomId)) {
        ctx.status = 404
        ctx.body = { error: 'Room not found' }
        return
    }
    if (!canManageRoom(storage, roomId, ctx.state?.user)) {
        ctx.status = 403
        ctx.body = { error: 'Access denied' }
        return
    }
    const text = (ctx.request.body as { summary?: string })?.summary
    if (typeof text !== 'string' || text.length > 200_000) {
        ctx.status = 400
        ctx.body = { error: 'summary must be a string no longer than 200000 characters' }
        return
    }
    const summary = await chatServer.getRoomSummaryService().updateSummaryText(roomId, text.trim())
    ctx.body = { summary }
}
