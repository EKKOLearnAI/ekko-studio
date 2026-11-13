import { randomBytes } from 'node:crypto'
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import {
    MultipartParseError,
    parseMultipartBoundary,
    parseMultipartFilename,
    splitMultipart,
} from '../http/multipart'
import { drainRejectedRequest, nonDestroyingRequestBody } from '../http/request-body'
import { publicGroupChatInviteRoom } from '../services/group-chat/access'
import {
    findPublishedGroupChatAttachmentPath,
    getGroupChatAttachmentBytes,
    getGroupChatAttachmentDir,
    getGroupChatAttachmentPath,
    MAX_GROUP_CHAT_ATTACHMENT_SIZE,
    MAX_GROUP_CHAT_ROOM_ATTACHMENT_BYTES,
    withGroupChatAttachmentWriteLock,
} from '../services/group-chat/attachments'
import { getGroupChatRuntimeServer } from '../services/group-chat/runtime'

const GROUP_CHAT_UPLOAD_WINDOW_MS = 60_000
const GROUP_CHAT_UPLOADS_PER_ROOM_WINDOW = 30
const GROUP_CHAT_UPLOAD_RATE_ENTRY_LIMIT = 10_000
const roomUploadRates = new Map<string, { count: number; windowStartedAt: number }>()
const MIME_TYPES: Record<string, string> = {
    '.gif': 'image/gif',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
}

function inviteRoom(ctx: any): any | null {
    const server = getGroupChatRuntimeServer()
    if (!server) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return null
    }

    const code = String(ctx.params.code || '').trim()
    const room = code ? server.getStorage().getRoomByInviteCode(code) : null
    if (!room) {
        ctx.status = 404
        ctx.body = { error: 'Room not found' }
        return null
    }
    return room
}

function safeUploadExtension(fileName: string): string {
    const extension = extname(safeDisplayName(fileName)).toLowerCase()
    return /^\.[a-z0-9]{1,12}$/.test(extension) ? extension : ''
}

function safeDisplayName(value: unknown, fallback = 'attachment'): string {
    const normalized = String(value || '').replace(/\\/g, '/')
    const name = basename(normalized)
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim()
        .slice(0, 255)
    return name || fallback
}

export function consumeRoomUploadRate(roomId: string): boolean {
    const now = Date.now()
    for (const [key, entry] of roomUploadRates) {
        if (now - entry.windowStartedAt >= GROUP_CHAT_UPLOAD_WINDOW_MS) roomUploadRates.delete(key)
    }
    if (roomUploadRates.size >= GROUP_CHAT_UPLOAD_RATE_ENTRY_LIMIT && !roomUploadRates.has(roomId)) {
        const oldest = [...roomUploadRates.entries()]
            .sort((left, right) => left[1].windowStartedAt - right[1].windowStartedAt)[0]?.[0]
        if (oldest) roomUploadRates.delete(oldest)
    }
    const entry = roomUploadRates.get(roomId)
    if (!entry || now - entry.windowStartedAt >= GROUP_CHAT_UPLOAD_WINDOW_MS) {
        roomUploadRates.set(roomId, { count: 1, windowStartedAt: now })
        return true
    }
    if (entry.count >= GROUP_CHAT_UPLOADS_PER_ROOM_WINDOW) return false
    entry.count += 1
    return true
}

async function materializePublishedAttachment(
    roomId: string,
    storedName: string,
    publishedPath: string,
): Promise<boolean> {
    return withGroupChatAttachmentWriteLock(roomId, async () => {
        const roomPath = getGroupChatAttachmentPath(roomId, storedName)
        if (!roomPath) return false
        const existing = await lstat(roomPath).catch((error: any) => {
            if (error?.code === 'ENOENT') return null
            throw error
        })
        if (existing?.isFile()) return true
        if (existing) return false

        const sourceInfo = await lstat(publishedPath).catch((error: any) => {
            if (error?.code === 'ENOENT') return null
            throw error
        })
        if (!sourceInfo?.isFile() || sourceInfo.size > MAX_GROUP_CHAT_ATTACHMENT_SIZE) return false
        const currentBytes = await getGroupChatAttachmentBytes(roomId)
        if (currentBytes + sourceInfo.size > MAX_GROUP_CHAT_ROOM_ATTACHMENT_BYTES) return false

        const source = await readFile(publishedPath)
        const uploadDir = getGroupChatAttachmentDir(roomId)
        await mkdir(uploadDir, { recursive: true, mode: 0o700 })
        try {
            await writeFile(roomPath, source, { flag: 'wx', mode: 0o600 })
        } catch (error: any) {
            if (error?.code !== 'EEXIST') throw error
        }
        return true
    })
}

export async function resolveInvite(ctx: any): Promise<void> {
    const room = inviteRoom(ctx)
    if (!room) return
    ctx.body = { room: publicGroupChatInviteRoom(room) }
}

export async function uploadInviteAttachment(ctx: any): Promise<void> {
    const room = inviteRoom(ctx)
    if (!room) return
    await uploadRoomAttachment(ctx, room)
}

export async function uploadRoomAttachment(ctx: any, room: { id: string }): Promise<void> {
    if (!consumeRoomUploadRate(room.id)) {
        ctx.status = 429
        ctx.set('Retry-After', '60')
        ctx.body = { error: 'Too many group chat uploads, please try again later' }
        return
    }

    const contentType = ctx.get('content-type') || ''
    if (!contentType.startsWith('multipart/form-data')) {
        ctx.status = 400
        ctx.body = { error: 'Expected multipart/form-data' }
        return
    }
    const boundary = parseMultipartBoundary(contentType)
    if (!boundary) {
        ctx.status = 400
        ctx.body = { error: 'Missing boundary' }
        return
    }

    let oversize = false
    await withGroupChatAttachmentWriteLock(room.id, async () => {
        let chunks: Buffer[] = []
        let totalSize = 0
        for await (const chunk of nonDestroyingRequestBody(ctx.req)) {
            totalSize += chunk.length
            if (totalSize > MAX_GROUP_CHAT_ATTACHMENT_SIZE) {
                oversize = true
                break
            }
            chunks.push(chunk)
        }
        if (oversize) {
            chunks = []
            return
        }

        const pendingFiles: Array<{ name: string; storedName: string; data: Buffer }> = []
        for (const part of splitMultipart(Buffer.concat(chunks), boundary)) {
            const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'))
            if (headerEnd === -1) continue
            const header = part.subarray(0, headerEnd).toString('utf-8')
            let originalName: string | null
            try {
                originalName = parseMultipartFilename(header)
            } catch (error) {
                if (error instanceof MultipartParseError) {
                    ctx.status = 400
                    ctx.body = { error: error.message }
                    return
                }
                throw error
            }
            if (!originalName) continue
            const name = safeDisplayName(originalName)
            const storedName = `${randomBytes(16).toString('hex')}${safeUploadExtension(name)}`
            pendingFiles.push({
                name,
                storedName,
                data: part.subarray(headerEnd + 4, part.length - 2),
            })
        }

        if (!pendingFiles.length) {
            ctx.status = 400
            ctx.body = { error: 'No attachment was provided' }
            return
        }
        const incomingBytes = pendingFiles.reduce((total, file) => total + file.data.length, 0)
        const existingBytes = await getGroupChatAttachmentBytes(room.id)
        if (existingBytes + incomingBytes > MAX_GROUP_CHAT_ROOM_ATTACHMENT_BYTES) {
            ctx.status = 413
            ctx.body = { error: 'Group chat attachment storage quota exceeded' }
            return
        }

        const uploadDir = getGroupChatAttachmentDir(room.id)
        await mkdir(uploadDir, { recursive: true, mode: 0o700 })
        const files: Array<{ name: string; path: string }> = []
        for (const file of pendingFiles) {
            const filePath = getGroupChatAttachmentPath(room.id, file.storedName)
            if (!filePath) continue
            await writeFile(filePath, file.data, { flag: 'wx', mode: 0o600 })
            files.push({ name: file.name, path: file.storedName })
        }
        ctx.body = { files }
    })

    if (oversize) {
        await drainRejectedRequest(ctx.req)
        ctx.status = 413
        ctx.body = { error: 'Group chat attachment is too large (max 20MB)' }
    }
}

export async function readInviteAttachment(ctx: any): Promise<void> {
    const room = inviteRoom(ctx)
    if (!room) return
    await readRoomAttachment(ctx, room)
}

export async function readRoomAttachment(ctx: any, room: { id: string }): Promise<void> {
    const storedName = String(ctx.params.file || '')
    const roomAttachmentPath = getGroupChatAttachmentPath(room.id, storedName)
    if (!roomAttachmentPath) {
        ctx.status = 400
        ctx.body = { error: 'Invalid attachment path' }
        return
    }

    try {
        let filePath = roomAttachmentPath
        let info = await lstat(filePath).catch((error: any) => {
            if (error?.code === 'ENOENT') return null
            throw error
        })
        if (!info) {
            const server = getGroupChatRuntimeServer()
            const storage = server?.getStorage()
            const messages = typeof storage?.getMessagesForContext === 'function'
                ? storage.getMessagesForContext(room.id)
                : typeof storage?.getRecentMessagesForUI === 'function'
                    ? storage.getRecentMessagesForUI(room.id, 1000, 0)
                    : []
            const agents = typeof storage?.getRoomAgents === 'function'
                ? storage.getRoomAgents(room.id)
                : []
            const publishedPath = findPublishedGroupChatAttachmentPath(storedName, messages || [], agents || [])
            if (!publishedPath) {
                ctx.status = 404
                ctx.body = { error: 'Attachment not found' }
                return
            }
            const materialized = await materializePublishedAttachment(room.id, storedName, publishedPath)
            if (!materialized) {
                ctx.status = 404
                ctx.body = { error: 'Attachment not found' }
                return
            }
            info = await lstat(filePath).catch((error: any) => {
                if (error?.code === 'ENOENT') return null
                throw error
            })
        }
        if (!info) {
            ctx.status = 404
            ctx.body = { error: 'Attachment not found' }
            return
        }
        if (!info.isFile()) {
            ctx.status = 404
            ctx.body = { error: 'Attachment not found' }
            return
        }
        if (info.size > MAX_GROUP_CHAT_ATTACHMENT_SIZE) {
            ctx.status = 413
            ctx.body = { error: 'Group chat attachment is too large (max 20MB)' }
            return
        }
        const displayName = safeDisplayName(ctx.query.name, storedName)
        const mime = MIME_TYPES[extname(storedName).toLowerCase()] || 'application/octet-stream'
        const disposition = mime.startsWith('image/') ? 'inline' : 'attachment'
        ctx.set('Content-Type', mime)
        ctx.set('Content-Disposition', `${disposition}; filename="${encodeURIComponent(displayName)}"; filename*=UTF-8''${encodeURIComponent(displayName)}`)
        ctx.set('Content-Length', String(info.size))
        ctx.set('Cache-Control', 'no-store')
        ctx.set('X-Content-Type-Options', 'nosniff')
        ctx.body = await readFile(filePath)
    } catch (error: any) {
        if (error?.code === 'ENOENT') {
            ctx.status = 404
            ctx.body = { error: 'Attachment not found' }
            return
        }
        throw error
    }
}
