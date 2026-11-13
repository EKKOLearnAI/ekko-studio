import { canManageGroupChatRoom } from '../services/group-chat/access'
import { getGroupChatRuntimeServer } from '../services/group-chat/runtime'

function discussionServer() {
    const server = getGroupChatRuntimeServer()
    if (!server) {
        throw Object.assign(new Error('Group chat not initialized'), { status: 503, code: 'group_chat_unavailable' })
    }
    return server
}

function managedRoom(storage: any, roomId: string, ctx: any) {
    const room = storage.getRoom(roomId)
    if (!room) throw Object.assign(new Error('Room not found'), { status: 404, code: 'not_found' })
    if (!canManageGroupChatRoom(storage, room.id, ctx.state?.user)) {
        throw Object.assign(new Error('Access denied'), { status: 403, code: 'permission_denied' })
    }
    return room
}

function readJudge(body: Record<string, any>): Record<string, string> | undefined {
    const judge = body.judge
    if (!judge || typeof judge !== 'object') return undefined
    const result: Record<string, string> = {}
    if (typeof judge.profile === 'string') result.profile = judge.profile
    if (typeof judge.provider === 'string') result.provider = judge.provider
    if (typeof judge.model === 'string') result.model = judge.model
    if (typeof judge.apiMode === 'string') result.apiMode = judge.apiMode
    return result
}

function handleDiscussionError(ctx: any, error: any, fallback: string): void {
    ctx.status = Number(error?.status || 500)
    ctx.body = { error: error?.message || fallback, code: error?.code || 'discussion_error' }
}

export async function startDiscussion(ctx: any): Promise<void> {
    try {
        const server = discussionServer()
        const storage = server.getStorage()
        const roomId = String(ctx.params.roomId || '')
        managedRoom(storage, roomId, ctx)
        const body = (ctx.request?.body || {}) as Record<string, any>
        const state = await server.startDiscussion(roomId, {
            goal: String(body.goal || ''),
            attachments: Array.isArray(body.attachments) ? body.attachments.map(String) : undefined,
            agentOrder: Array.isArray(body.agentOrder) ? body.agentOrder.map(String) : undefined,
            maxRounds: typeof body.maxRounds === 'number' ? body.maxRounds : undefined,
            maxMessages: typeof body.maxMessages === 'number' ? body.maxMessages : undefined,
            minRounds: typeof body.minRounds === 'number' ? body.minRounds : undefined,
            reporterId: typeof body.reporterId === 'string' ? body.reporterId : undefined,
            judge: readJudge(body),
        })
        ctx.status = 201
        ctx.body = { discussion: state }
    } catch (error) {
        handleDiscussionError(ctx, error, 'Failed to start discussion')
    }
}

export async function getDiscussion(ctx: any): Promise<void> {
    try {
        const server = discussionServer()
        const storage = server.getStorage()
        const roomId = String(ctx.params.roomId || '')
        managedRoom(storage, roomId, ctx)
        ctx.body = { discussion: server.getDiscussion(roomId) }
    } catch (error) {
        handleDiscussionError(ctx, error, 'Failed to get discussion')
    }
}

export async function stopDiscussion(ctx: any): Promise<void> {
    try {
        const server = discussionServer()
        const storage = server.getStorage()
        const roomId = String(ctx.params.roomId || '')
        managedRoom(storage, roomId, ctx)
        ctx.body = { discussion: await server.stopDiscussion(roomId) }
    } catch (error) {
        handleDiscussionError(ctx, error, 'Failed to stop discussion')
    }
}
