import {
    GROUP_CHAT_UPLOAD_CHUNK_BYTES,
    GroupChatUploadError,
    abortGroupChatUpload,
    appendGroupChatUploadChunk,
    completeGroupChatUpload,
    openGroupChatUpload,
} from '../services/group-chat/chunked-upload'
import { consumeRoomUploadRate } from './group-chat-invite'

function requestOwner(ctx: any): string {
    return String(ctx.state?.user?.id || ctx.state?.user?.username || 'local')
}

function handleError(ctx: any, error: unknown): void {
    if (error instanceof GroupChatUploadError) {
        ctx.status = error.status
        ctx.body = { error: error.message, code: error.code }
        return
    }
    throw error
}

export async function open(ctx: any, room: { id: string }): Promise<void> {
    if (!consumeRoomUploadRate(room.id)) {
        ctx.status = 429
        ctx.set('Retry-After', '60')
        ctx.body = { error: 'Too many group chat uploads, please try again later' }
        return
    }
    try {
        const body = ctx.request.body && typeof ctx.request.body === 'object' && !Array.isArray(ctx.request.body)
            ? ctx.request.body as Record<string, unknown>
            : {}
        ctx.body = await openGroupChatUpload({
            id: body.id,
            name: body.name,
            size: body.size,
            owner: requestOwner(ctx),
            roomId: room.id,
        })
    } catch (error) {
        handleError(ctx, error)
    }
}

export async function appendChunk(ctx: any, room: { id: string }): Promise<void> {
    try {
        const chunks: Buffer[] = []
        let byteLength = 0
        for await (const rawChunk of ctx.req) {
            const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
            byteLength += chunk.byteLength
            if (byteLength > GROUP_CHAT_UPLOAD_CHUNK_BYTES) {
                throw new GroupChatUploadError(
                    'upload_chunk_too_large',
                    `Upload chunks are limited to ${GROUP_CHAT_UPLOAD_CHUNK_BYTES} bytes`,
                    413,
                )
            }
            chunks.push(chunk)
        }
        ctx.body = await appendGroupChatUploadChunk({
            id: ctx.params.id,
            offset: ctx.query.offset,
            bytes: Uint8Array.from(Buffer.concat(chunks)),
            owner: requestOwner(ctx),
            roomId: room.id,
        })
    } catch (error) {
        handleError(ctx, error)
    }
}

export async function complete(ctx: any, room: { id: string }): Promise<void> {
    try {
        const file = await completeGroupChatUpload({
            id: ctx.params.id,
            owner: requestOwner(ctx),
            roomId: room.id,
        })
        ctx.body = { files: [file] }
    } catch (error) {
        handleError(ctx, error)
    }
}

export async function abort(ctx: any, room: { id: string }): Promise<void> {
    try {
        await abortGroupChatUpload({
            id: ctx.params.id,
            owner: requestOwner(ctx),
            roomId: room.id,
        })
        ctx.body = { ok: true }
    } catch (error) {
        handleError(ctx, error)
    }
}
