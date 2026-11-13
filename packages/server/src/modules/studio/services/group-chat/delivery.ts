import { readdir, stat, unlink, statfs } from 'fs/promises'
import { join } from 'path'
import { logger } from '../../public/logging'
import { canManageGroupChatRoom } from './access'
import { getGroupChatRuntimeServer } from './runtime'

/** 交付目录总占用上限（默认 100MB，可用环境变量 GROUP_CHAT_DELIVERY_LIMIT_BYTES 覆盖）。 */
const DEFAULT_DELIVERY_LIMIT_BYTES = 100 * 1024 * 1024
/** 一键清理时保留的最新交付文件数（GROUP_CHAT_DELIVERY_KEEP_LATEST 可覆盖）。 */
const DEFAULT_CLEANUP_KEEP_LATEST = 5
/** 自动清理的保留期（天，GROUP_CHAT_DELIVERY_RETENTION_DAYS 可覆盖）。 */
const DEFAULT_DELIVERY_RETENTION_DAYS = 90
/** 全局磁盘最低可用空间（字节，GROUP_CHAT_DELIVERY_GLOBAL_MIN_FREE_BYTES 可覆盖）。 */
const DEFAULT_GLOBAL_MIN_FREE_BYTES = 5 * 1024 * 1024 * 1024
/** 自动清理扫描间隔。 */
const AUTO_CLEAN_SCAN_INTERVAL_MS = 6 * 3600 * 1000

function envNumber(name: string, fallback: number): number {
    const value = Number(process.env[name])
    return Number.isFinite(value) && value > 0 ? value : fallback
}

function envFlag(name: string, fallback: boolean): boolean {
    const value = String(process.env[name] || '').trim().toLowerCase()
    if (!value) return fallback
    return ['1', 'true', 'yes', 'on'].includes(value)
}

export function deliveryKeepLatest(): number {
    return envNumber('GROUP_CHAT_DELIVERY_KEEP_LATEST', DEFAULT_CLEANUP_KEEP_LATEST)
}

function deliveryRetentionMs(): number {
    return envNumber('GROUP_CHAT_DELIVERY_RETENTION_DAYS', DEFAULT_DELIVERY_RETENTION_DAYS) * 24 * 3600 * 1000
}

export function deliveryAutoCleanEnabled(): boolean {
    return envFlag('GROUP_CHAT_DELIVERY_AUTO_CLEAN', true)
}

function globalMinFreeBytes(): number {
    return envNumber('GROUP_CHAT_DELIVERY_GLOBAL_MIN_FREE_BYTES', DEFAULT_GLOBAL_MIN_FREE_BYTES)
}

function deliveryLimitBytes(): number {
    return envNumber('GROUP_CHAT_DELIVERY_LIMIT_BYTES', DEFAULT_DELIVERY_LIMIT_BYTES)
}

interface DeliveryEntry {
    name: string
    mtime: number
    size: number
}

/** 列出交付目录内文件（按修改时间倒序）。 */
async function statDeliveryDir(dir: string): Promise<DeliveryEntry[]> {
    try {
        const dirents = await readdir(dir, { withFileTypes: true })
        const files = dirents.filter(entry => entry.isFile())
        const withMeta = await Promise.all(files.map(async entry => {
            try {
                const info = await stat(join(dir, entry.name))
                return { name: entry.name, mtime: info.mtimeMs, size: info.size }
            } catch {
                return { name: entry.name, mtime: 0, size: 0 }
            }
        }))
        return withMeta.sort((a, b) => b.mtime - a.mtime)
    } catch {
        return []
    }
}

async function removeFiles(dir: string, names: string[]): Promise<number> {
    let bytes = 0
    for (const name of names) {
        try {
            const info = await stat(join(dir, name))
            await unlink(join(dir, name))
            bytes += info.size
        } catch { /* 单个文件删除失败忽略 */ }
    }
    return bytes
}

async function freeBytesOnRoot(): Promise<number> {
    try {
        const info = await statfs('/')
        return info.bavail * info.bsize
    } catch {
        return Infinity
    }
}

function deliveryDir(ctx: any): string | null {
    const server = getGroupChatRuntimeServer()
    if (!server) throw Object.assign(new Error('Group chat not initialized'), { status: 503, code: 'group_chat_unavailable' })
    const storage = server.getStorage()
    const room = storage.getRoom(ctx.params.roomId)
    if (!room) throw Object.assign(new Error('Room not found'), { status: 404, code: 'not_found' })
    if (!canManageGroupChatRoom(storage, room.id, ctx.state?.user)) {
        throw Object.assign(new Error('Access denied'), { status: 403, code: 'permission_denied' })
    }
    const workspace = String((room as { workspace?: string }).workspace || '').trim()
    if (!workspace) return null
    return join(workspace, '交付')
}

function handleError(ctx: any, error: any): void {
    ctx.status = Number(error?.status || 500)
    ctx.body = { error: error?.message || 'Delivery directory error', code: error?.code || 'delivery_error' }
}

/** GET 交付目录用量统计（总大小 / 文件数 / 上限 / 是否超限）。 */
export async function deliveryUsage(ctx: any): Promise<void> {
    try {
        const dir = deliveryDir(ctx)
        const limitBytes = deliveryLimitBytes()
        if (!dir) {
            ctx.body = { totalBytes: 0, fileCount: 0, limitBytes, overLimit: false }
            return
        }
        const entries = await statDeliveryDir(dir)
        const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0)
        ctx.body = { totalBytes, fileCount: entries.length, limitBytes, overLimit: totalBytes > limitBytes }
    } catch (error) {
        handleError(ctx, error)
    }
}

/** POST 一键清理：保留最新 N 个交付文件，删除其余。返回被删除的文件名。 */
export async function cleanupDelivery(ctx: any): Promise<void> {
    try {
        const dir = deliveryDir(ctx)
        if (!dir) {
            ctx.body = { deleted: [], deletedBytes: 0 }
            return
        }
        const entries = await statDeliveryDir(dir)
        const keep = entries.slice(0, deliveryKeepLatest())
        const keepSet = new Set(keep.map(entry => entry.name))
        const toDelete = entries.filter(entry => !keepSet.has(entry.name)).map(entry => entry.name)
        const deletedBytes = await removeFiles(dir, toDelete)
        ctx.body = { deleted: toDelete, deletedBytes }
    } catch (error) {
        handleError(ctx, error)
    }
}

/**
 * 自动清理扫描：对「交付」目录超限或设备磁盘紧张的房间，删除超过保留期的
 * 「讨论总结」文件（系统可再生成）；Agent 交付物（分析文书等）永不自动删除，
 * 仅可由手动清理移除。始终保留最新 N 个文件。
 */
export async function runAutoDeliveryCleanup(): Promise<{ scanned: number; cleaned: number; deletedBytes: number; diskFreeBytes: number }> {
    const result = { scanned: 0, cleaned: 0, deletedBytes: 0, diskFreeBytes: Infinity }
    try {
        const server = getGroupChatRuntimeServer()
        if (!server) return result
        const storage = server.getStorage()
        const rooms = (storage as { getAllRooms?: () => Array<{ id: string; workspace?: string }> }).getAllRooms?.() || []
        const diskFree = await freeBytesOnRoot()
        result.diskFreeBytes = diskFree
        const diskTight = diskFree < globalMinFreeBytes()
        const limit = deliveryLimitBytes()
        const retentionMs = deliveryRetentionMs()
        const keepLatest = deliveryKeepLatest()
        const now = Date.now()
        for (const room of rooms) {
            const workspace = String(room.workspace || '').trim()
            if (!workspace) continue
            const dir = join(workspace, '交付')
            const entries = await statDeliveryDir(dir)
            if (entries.length === 0) continue
            result.scanned += 1
            const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0)
            if (totalBytes <= limit && !diskTight) continue
            const keepSet = new Set(entries.slice(0, keepLatest).map(entry => entry.name))
            const toDelete: string[] = []
            for (const entry of entries) {
                if (keepSet.has(entry.name)) continue
                const tooOld = now - entry.mtime > retentionMs
                // 只自动删「讨论总结」文件（系统可再生成）；Agent 交付物受保护，不自动删。
                if (tooOld && entry.name.startsWith('讨论总结-')) toDelete.push(entry.name)
            }
            if (toDelete.length) {
                const bytes = await removeFiles(dir, toDelete)
                result.cleaned += toDelete.length
                result.deletedBytes += bytes
                logger.info({ roomId: room.id, deleted: toDelete, bytes }, '[delivery] auto cleanup executed')
            }
        }
    } catch (err) {
        logger.warn({ err }, '[delivery] auto cleanup scan failed')
    }
    return result
}

let cleanupTimer: NodeJS.Timeout | null = null

/** 启动自动清理定时器（幂等；每次启动先执行一次扫描）。 */
export function scheduleAutoDeliveryCleanup(): void {
    if (cleanupTimer || !deliveryAutoCleanEnabled()) return
    void runAutoDeliveryCleanup().catch(() => {})
    cleanupTimer = setInterval(() => {
        void runAutoDeliveryCleanup().catch(() => {})
    }, AUTO_CLEAN_SCAN_INTERVAL_MS)
    cleanupTimer.unref?.()
}

export function stopAutoDeliveryCleanup(): void {
    if (cleanupTimer) clearInterval(cleanupTimer)
    cleanupTimer = null
}
