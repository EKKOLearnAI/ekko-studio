import { randomBytes } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { appendFile, chmod, copyFile, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import { config } from '../../public/config'
import {
    getGroupChatAttachmentBytes,
    getGroupChatAttachmentDir,
    getGroupChatAttachmentPath,
    MAX_GROUP_CHAT_ATTACHMENT_SIZE,
    MAX_GROUP_CHAT_ROOM_ATTACHMENT_BYTES,
    withGroupChatAttachmentWriteLock,
} from './attachments'

export const GROUP_CHAT_UPLOAD_CHUNK_BYTES = 256 * 1024
const GROUP_CHAT_UPLOAD_SESSION_TTL_MS = 5 * 60 * 1000
const UPLOAD_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/

interface GroupChatUploadSession {
    id: string
    owner: string
    roomId: string
    name: string
    size: number
    receivedBytes: number
    partPath: string
    timer: ReturnType<typeof setTimeout>
    writing: boolean
}

export class GroupChatUploadError extends Error {
    readonly code: string
    readonly status: number

    constructor(code: string, message: string, status = 400) {
        super(message)
        this.name = 'GroupChatUploadError'
        this.code = code
        this.status = status
    }
}

const sessions = new Map<string, GroupChatUploadSession>()

export async function openGroupChatUpload(input: {
    id: unknown
    owner: string
    roomId: string
    name: unknown
    size: unknown
}): Promise<{ id: string; nextOffset: number; maxChunkBytes: number }> {
    const id = String(input.id || '').trim()
    if (!UPLOAD_ID_PATTERN.test(id)) throw new GroupChatUploadError('invalid_upload_id', 'Invalid upload id')
    if (sessions.has(id)) throw new GroupChatUploadError('upload_exists', 'Upload id is already active', 409)
    const name = safeDisplayName(input.name)
    const size = Number(input.size)
    if (!Number.isSafeInteger(size) || size <= 0) {
        throw new GroupChatUploadError('invalid_upload_size', 'Invalid upload size')
    }
    if (size > MAX_GROUP_CHAT_ATTACHMENT_SIZE) {
        throw new GroupChatUploadError('upload_too_large', 'Group chat attachment is too large (max 20MB)', 413)
    }

    const existingBytes = await getGroupChatAttachmentBytes(input.roomId)
    if (existingBytes + size > MAX_GROUP_CHAT_ROOM_ATTACHMENT_BYTES) {
        throw new GroupChatUploadError(
            'attachment_quota_exceeded',
            'Group chat attachment storage quota exceeded',
            413,
        )
    }

    const stagingDir = resolve(config.appHome, 'group-chat', 'upload-sessions')
    await mkdir(stagingDir, { recursive: true, mode: 0o700 })
    const partPath = resolve(stagingDir, `${randomBytes(16).toString('hex')}.part`)
    await writeFile(partPath, new Uint8Array(), { flag: 'wx', mode: 0o600 })
    const session: GroupChatUploadSession = {
        id,
        owner: input.owner,
        roomId: input.roomId,
        name,
        size,
        receivedBytes: 0,
        partPath,
        timer: setTimeout(() => undefined, 1),
        writing: false,
    }
    clearTimeout(session.timer)
    session.timer = expiryTimer(session)
    sessions.set(id, session)
    return { id, nextOffset: 0, maxChunkBytes: GROUP_CHAT_UPLOAD_CHUNK_BYTES }
}

export async function appendGroupChatUploadChunk(input: {
    id: unknown
    owner: string
    roomId: string
    offset: unknown
    bytes: Uint8Array
}): Promise<{ id: string; nextOffset: number; done: boolean }> {
    const session = ownedSession(input.id, input.owner, input.roomId)
    const offset = Number(input.offset)
    if (!Number.isSafeInteger(offset) || offset !== session.receivedBytes) {
        throw new GroupChatUploadError('invalid_upload_offset', `Expected upload offset ${session.receivedBytes}`, 409)
    }
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) {
        throw new GroupChatUploadError('invalid_upload_chunk', 'Upload chunk is empty')
    }
    if (input.bytes.byteLength > GROUP_CHAT_UPLOAD_CHUNK_BYTES) {
        throw new GroupChatUploadError(
            'upload_chunk_too_large',
            `Upload chunks are limited to ${GROUP_CHAT_UPLOAD_CHUNK_BYTES} bytes`,
            413,
        )
    }
    if (session.receivedBytes + input.bytes.byteLength > session.size) {
        throw new GroupChatUploadError('upload_size_mismatch', 'Upload exceeds its declared size', 409)
    }
    if (session.writing) throw new GroupChatUploadError('upload_busy', 'Another upload chunk is still being written', 409)

    session.writing = true
    try {
        await appendFile(session.partPath, input.bytes)
        session.receivedBytes += input.bytes.byteLength
        refreshExpiry(session)
        return {
            id: session.id,
            nextOffset: session.receivedBytes,
            done: session.receivedBytes === session.size,
        }
    } finally {
        session.writing = false
    }
}

export async function completeGroupChatUpload(input: {
    id: unknown
    owner: string
    roomId: string
}): Promise<{ name: string; path: string }> {
    const session = ownedSession(input.id, input.owner, input.roomId)
    if (session.writing) throw new GroupChatUploadError('upload_busy', 'An upload chunk is still being written', 409)
    if (session.receivedBytes !== session.size) {
        throw new GroupChatUploadError(
            'upload_incomplete',
            `Upload is incomplete (${session.receivedBytes}/${session.size})`,
            409,
        )
    }
    const info = await stat(session.partPath)
    if (!info.isFile() || info.size !== session.size) {
        await discardSession(session)
        throw new GroupChatUploadError('upload_size_mismatch', 'Stored upload size does not match the declaration', 409)
    }

    return withGroupChatAttachmentWriteLock(session.roomId, async () => {
        const existingBytes = await getGroupChatAttachmentBytes(session.roomId)
        if (existingBytes + session.size > MAX_GROUP_CHAT_ROOM_ATTACHMENT_BYTES) {
            await discardSession(session)
            throw new GroupChatUploadError(
                'attachment_quota_exceeded',
                'Group chat attachment storage quota exceeded',
                413,
            )
        }

        const uploadDir = getGroupChatAttachmentDir(session.roomId)
        await mkdir(uploadDir, { recursive: true, mode: 0o700 })
        const extension = safeUploadExtension(session.name)
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const storedName = `${randomBytes(16).toString('hex')}${extension}`
            const savedPath = getGroupChatAttachmentPath(session.roomId, storedName)
            if (!savedPath) continue
            try {
                await copyFile(session.partPath, savedPath, fsConstants.COPYFILE_EXCL)
                await chmod(savedPath, 0o600)
                await rm(session.partPath, { force: true })
                forgetSession(session)
                return { name: session.name, path: storedName }
            } catch (error: any) {
                if (error?.code === 'EEXIST' && attempt < 2) continue
                await rm(savedPath, { force: true }).catch(() => undefined)
                throw error
            }
        }
        throw new GroupChatUploadError('upload_store_failed', 'Failed to store group chat attachment', 500)
    })
}

export async function abortGroupChatUpload(input: {
    id: unknown
    owner: string
    roomId: string
}): Promise<void> {
    await discardSession(ownedSession(input.id, input.owner, input.roomId))
}

function ownedSession(idInput: unknown, owner: string, roomId: string): GroupChatUploadSession {
    const id = String(idInput || '').trim()
    const session = sessions.get(id)
    if (!session) throw new GroupChatUploadError('upload_not_found', 'Upload session was not found', 404)
    if (session.owner !== owner || session.roomId !== roomId) {
        throw new GroupChatUploadError('upload_forbidden', 'Upload session does not belong to this room member', 403)
    }
    return session
}

function safeDisplayName(value: unknown): string {
    const name = basename(String(value || '').replace(/\0/g, '')).trim().slice(0, 255)
    if (!name || name === '.' || name === '..') {
        throw new GroupChatUploadError('invalid_upload_name', 'Invalid upload name')
    }
    return name
}

function safeUploadExtension(name: string): string {
    const extension = extname(name).toLowerCase()
    return /^\.[a-z0-9]{1,12}$/.test(extension) ? extension : ''
}

function refreshExpiry(session: GroupChatUploadSession): void {
    clearTimeout(session.timer)
    session.timer = expiryTimer(session)
}

function expiryTimer(session: GroupChatUploadSession): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
        if (sessions.get(session.id) !== session) return
        void discardSession(session)
    }, GROUP_CHAT_UPLOAD_SESSION_TTL_MS)
    timer.unref()
    return timer
}

function forgetSession(session: GroupChatUploadSession): void {
    clearTimeout(session.timer)
    if (sessions.get(session.id) === session) sessions.delete(session.id)
}

async function discardSession(session: GroupChatUploadSession): Promise<void> {
    forgetSession(session)
    await rm(session.partPath, { force: true }).catch(() => undefined)
}
