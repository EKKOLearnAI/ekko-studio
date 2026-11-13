import { createHash, randomBytes } from 'node:crypto'
import { constants as fsConstants, lstatSync } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, resolve } from 'node:path'
import MarkdownIt from 'markdown-it'
import { config } from '../../public/config'
import { isPathWithin } from '../files/path'

const MAX_GROUP_CHAT_CONTENT_BLOCKS = 32
const STORED_ATTACHMENT_NAME_PATTERN = /^[a-f0-9]{32}(?:\.[a-z0-9]{1,12})?$/
const SAFE_IMAGE_MEDIA_TYPES: Record<string, string> = {
    '.gif': 'image/gif',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
}
const ATTACHMENT_MEDIA_TYPES: Record<string, string> = {
    ...SAFE_IMAGE_MEDIA_TYPES,
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.m4a': 'audio/mp4',
    '.md': 'text/markdown',
    '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
    '.ogg': 'audio/ogg',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.wav': 'audio/wav',
    '.webm': 'video/webm',
    '.zip': 'application/zip',
}
export const MAX_GROUP_CHAT_ATTACHMENT_SIZE = 20 * 1024 * 1024
export const MAX_GROUP_CHAT_ROOM_ATTACHMENT_BYTES = 500 * 1024 * 1024
const roomAttachmentWriteQueues = new Map<string, Promise<unknown>>()

function roomAttachmentSegment(roomId: string): string {
    return createHash('sha256').update(roomId).digest('hex')
}

export function getGroupChatAttachmentDir(roomId: string): string {
    return resolve(config.appHome, 'group-chat', 'attachments', roomAttachmentSegment(roomId))
}

export function getGroupChatAttachmentPath(roomId: string, storedName: string): string | null {
    const normalizedName = basename(storedName)
    if (!normalizedName || normalizedName !== storedName) return null
    const roomDir = getGroupChatAttachmentDir(roomId)
    const filePath = resolve(roomDir, normalizedName)
    return isPathWithin(filePath, roomDir) ? filePath : null
}

export async function getGroupChatAttachmentBytes(roomId: string): Promise<number> {
    const directory = getGroupChatAttachmentDir(roomId)
    try {
        const entries = await readdir(directory, { withFileTypes: true })
        let total = 0
        for (const entry of entries) {
            if (!entry.isFile()) continue
            total += (await stat(resolve(directory, entry.name))).size
        }
        return total
    } catch (error: any) {
        if (error?.code === 'ENOENT') return 0
        throw error
    }
}

export async function deleteGroupChatAttachments(roomId: string): Promise<void> {
    await rm(getGroupChatAttachmentDir(roomId), { recursive: true, force: true })
}

export async function withGroupChatAttachmentWriteLock<T>(roomId: string, task: () => Promise<T>): Promise<T> {
    const previous = roomAttachmentWriteQueues.get(roomId) || Promise.resolve()
    const current = previous.catch(() => undefined).then(task)
    roomAttachmentWriteQueues.set(roomId, current)
    try {
        return await current
    } finally {
        if (roomAttachmentWriteQueues.get(roomId) === current) roomAttachmentWriteQueues.delete(roomId)
    }
}

export type PublishedGroupChatAttachmentBlock = {
    type: 'image' | 'file'
    name: string
    path: string
    media_type: string
}

/**
 * Copy an Agent-produced workspace artifact into the room's private attachment
 * store so its message remains downloadable even if the workspace file changes.
 */
export async function storeAgentGroupChatAttachment(
    roomId: string,
    sourcePath: string,
    displayName: string,
): Promise<PublishedGroupChatAttachmentBlock> {
    const safeName = safeAttachmentDisplayName(displayName, 'attachment')
    const extension = extname(safeName).toLowerCase()
    const safeExtension = /^\.[a-z0-9]{1,12}$/.test(extension) ? extension : ''

    return withGroupChatAttachmentWriteLock(roomId, async () => {
        const sourceInfo = await lstat(sourcePath)
        if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.size > MAX_GROUP_CHAT_ATTACHMENT_SIZE) {
            throw Object.assign(new Error('Invalid group chat Agent attachment'), {
                code: 'invalid_attachment',
                status: 400,
            })
        }
        const existingBytes = await getGroupChatAttachmentBytes(roomId)
        if (existingBytes + sourceInfo.size > MAX_GROUP_CHAT_ROOM_ATTACHMENT_BYTES) {
            throw Object.assign(new Error('Group chat attachment storage quota exceeded'), {
                code: 'attachment_quota_exceeded',
                status: 413,
            })
        }

        const uploadDir = getGroupChatAttachmentDir(roomId)
        await mkdir(uploadDir, { recursive: true, mode: 0o700 })
        let storedName = ''
        let storedPath = ''
        for (let attempt = 0; attempt < 3; attempt += 1) {
            storedName = `${randomBytes(16).toString('hex')}${safeExtension}`
            storedPath = getGroupChatAttachmentPath(roomId, storedName) || ''
            if (!storedPath) continue
            try {
                await copyFile(sourcePath, storedPath, fsConstants.COPYFILE_EXCL)
                await chmod(storedPath, 0o600)
                break
            } catch (error: any) {
                if (error?.code !== 'EEXIST') {
                    await rm(storedPath, { force: true }).catch(() => undefined)
                    throw error
                }
                if (attempt === 2) throw error
                storedPath = ''
            }
        }
        if (!storedName || !storedPath) throw new Error('Failed to store group chat Agent attachment')

        const mediaType = ATTACHMENT_MEDIA_TYPES[extension] || 'application/octet-stream'
        return {
            type: SAFE_IMAGE_MEDIA_TYPES[extension] ? 'image' : 'file',
            name: safeName,
            path: storedName,
            media_type: mediaType,
        }
    })
}

type GroupChatContentBlock =
    | { type: 'text'; text: string }
    | { type: 'image'; name: string; path: string; media_type: string }
    | { type: 'file'; name: string; path: string; media_type: string }

export type NormalizedHumanGroupChatContent = {
    storageContent: GroupChatContentBlock[]
    runtimeInput: GroupChatContentBlock[]
}

function safeAttachmentDisplayName(value: unknown, fallback: string): string {
    const normalized = String(value || '').replace(/\\/g, '/')
    return basename(normalized)
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim()
        .slice(0, 255) || fallback
}

function safeAttachmentMediaType(value: unknown): string {
    const mediaType = String(value || '').trim().toLowerCase()
    return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mediaType)
        ? mediaType
        : 'application/octet-stream'
}

/**
 * Never trust a human Socket.IO client to provide a local attachment path.
 * Rebind every attachment block to an existing regular file in this room's
 * private attachment directory before it can be passed to an Agent runtime.
 */
export function normalizeHumanGroupChatContent(
    roomId: string,
    content: Array<Record<string, unknown>>,
): NormalizedHumanGroupChatContent {
    if (content.length > MAX_GROUP_CHAT_CONTENT_BLOCKS) {
        throw new Error('Too many group chat content blocks')
    }

    const storageContent: GroupChatContentBlock[] = []
    const runtimeInput: GroupChatContentBlock[] = []
    for (const rawBlock of content) {
        if (!rawBlock || typeof rawBlock !== 'object' || Array.isArray(rawBlock)) {
            throw new Error('Invalid group chat content block')
        }
        if (rawBlock.type === 'text') {
            if (typeof rawBlock.text !== 'string') throw new Error('Invalid group chat text block')
            const block: GroupChatContentBlock = { type: 'text', text: rawBlock.text }
            storageContent.push(block)
            runtimeInput.push(block)
            continue
        }
        if (rawBlock.type !== 'image' && rawBlock.type !== 'file') {
            throw new Error('Unsupported group chat content block')
        }

        const untrustedPath = typeof rawBlock.path === 'string' ? rawBlock.path.replace(/\\/g, '/') : ''
        const storedName = basename(untrustedPath)
        if (!STORED_ATTACHMENT_NAME_PATTERN.test(storedName)) {
            throw new Error('Invalid group chat attachment')
        }
        const filePath = getGroupChatAttachmentPath(roomId, storedName)
        if (!filePath) throw new Error('Invalid group chat attachment')
        let info
        try {
            info = lstatSync(filePath)
        } catch {
            throw new Error('Group chat attachment was not uploaded to this room')
        }
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_GROUP_CHAT_ATTACHMENT_SIZE) {
            throw new Error('Invalid group chat attachment')
        }

        const extension = extname(storedName).toLowerCase()
        const type = rawBlock.type
        if (type === 'image' && !SAFE_IMAGE_MEDIA_TYPES[extension]) {
            throw new Error('Invalid group chat image attachment')
        }
        const name = safeAttachmentDisplayName(rawBlock.name, storedName)
        const mediaType = type === 'image'
            ? SAFE_IMAGE_MEDIA_TYPES[extension]
            : safeAttachmentMediaType(rawBlock.media_type)
        storageContent.push({ type, name, path: storedName, media_type: mediaType })
        runtimeInput.push({ type, name, path: filePath, media_type: mediaType })
    }
    return { storageContent, runtimeInput }
}

type PublishedAttachmentMessage = {
    senderId?: string
    senderName?: string
    role?: string
    content?: unknown
}

type PublishedAttachmentAgent = {
    agentId?: string
    executorType?: string
}

const publishedImageMarkdown = new MarkdownIt({ html: false, linkify: false })

function publishedMarkdownImagePaths(content: unknown): string[] {
    if (typeof content !== 'string' || !content.includes('![')) return []
    const paths: string[] = []
    const visit = (tokens: ReturnType<typeof publishedImageMarkdown.parse>) => {
        for (const token of tokens) {
            if (token.type === 'image') {
                try {
                    const path = decodeURIComponent(token.attrGet('src') || '')
                    if (isAbsolute(path) && !path.startsWith('//') && !path.startsWith('/api/')
                        && SAFE_PUBLISHED_IMAGE_EXTENSIONS.has(extname(path).toLowerCase())) paths.push(resolve(path))
                } catch { /* Malformed image destinations do not grant file access. */ }
            }
            if (token.children) visit(token.children)
        }
    }
    visit(publishedImageMarkdown.parse(content, {}))
    return paths
}

const SAFE_PUBLISHED_IMAGE_EXTENSIONS = new Set(['.gif', '.jpeg', '.jpg', '.png', '.webp'])
const LEGACY_UPLOAD_NAME_PATTERN = /^[a-f0-9]{16}(?:\.[a-z0-9]{1,12})?$/

function contentBlocks(content: unknown): any[] {
    if (Array.isArray(content)) return content
    if (typeof content !== 'string') return []
    const trimmed = content.trim()
    if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return []
    try {
        const parsed = JSON.parse(trimmed)
        return Array.isArray(parsed) ? parsed : []
    } catch {
        return []
    }
}

export function findPublishedGroupChatAttachmentPath(
    storedName: string,
    messages: PublishedAttachmentMessage[],
    agents: PublishedAttachmentAgent[],
): string | null {
    if (!storedName || basename(storedName) !== storedName) return null
    const agentIds = new Set(agents.map(agent => String(agent.agentId || '')).filter(Boolean))
    const localAgentIds = new Set(agents.filter(agent => agent.executorType !== 'remote')
        .map(agent => String(agent.agentId || '')).filter(Boolean))

    for (const message of messages) {
        const isAgentMessage = (
            message.role === 'assistant' || message.role === 'tool' || message.role === 'agent_run'
        ) && agentIds.has(String(message.senderId || ''))
        // A remote Agent's absolute path belongs to another machine and must
        // never authorize reading a matching path on the room host.
        if (message.role === 'assistant' && localAgentIds.has(String(message.senderId || ''))) {
            const path = publishedMarkdownImagePaths(message.content).find(path => basename(path) === storedName)
            if (path) return path
        }
        for (const block of contentBlocks(message.content)) {
            if (block?.type !== 'image' || typeof block.path !== 'string') continue
            const publishedPath = resolve(block.path)
            if (basename(publishedPath) !== storedName) continue
            const isLegacyUpload = LEGACY_UPLOAD_NAME_PATTERN.test(storedName) &&
                isPathWithin(publishedPath, config.uploadDir)
            const isSafeAgentImage = isAgentMessage &&
                SAFE_PUBLISHED_IMAGE_EXTENSIONS.has(extname(publishedPath).toLowerCase())
            if (isLegacyUpload || isSafeAgentImage) return publishedPath
        }
    }
    return null
}
