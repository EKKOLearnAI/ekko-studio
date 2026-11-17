import { resolve as pathResolve } from 'path'
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'fs/promises'
import { canManageGroupChatRoom } from '../services/group-chat/access'
import { getGroupChatRuntimeServer } from '../services/group-chat/runtime'
import {
    groupWorkspaceRelativePath,
} from '../services/group-chat/workspace-files'
import { resolveWorkspacePath } from '../services/workspace/manager'
import {
    serveWorkspaceFile,
    fileContent,
    statIfPresent,
    renameWithoutOverwrite,
    decorateWorkspaceEntries,
    getWorkspaceFileGitDiff,
    isSensitivePath,
    MAX_EDIT_SIZE,
} from '../public/workspace-files'

function managedRoom(ctx: any): { room: any; storage: ReturnType<NonNullable<ReturnType<typeof getGroupChatRuntimeServer>>['getStorage']> } {
    const server = getGroupChatRuntimeServer()
    if (!server) throw Object.assign(new Error('Group chat not initialized'), { status: 503, code: 'group_chat_unavailable' })
    const storage = server.getStorage()
    const room = storage.getRoom(ctx.params.roomId)
    if (!room) throw Object.assign(new Error('Room not found'), { status: 404, code: 'not_found' })
    if (!canManageGroupChatRoom(storage, room.id, ctx.state?.user)) {
        throw Object.assign(new Error('Access denied'), { status: 403, code: 'permission_denied' })
    }
    return { room, storage }
}

function roomWorkspace(ctx: any): string {
    return String(managedRoom(ctx).room.workspace || '').trim()
}

function handleWorkspaceError(ctx: any, error: any): void {
    ctx.status = Number(error?.status || (error?.code === 'ENOENT' ? 404 : error?.code === 'EEXIST' ? 409 : 500))
    ctx.body = {
        error: error?.message || 'Failed to access group chat workspace',
        code: error?.code || 'workspace_file_error',
    }
}

async function resolveRoomPath(ctx: any, path: unknown, options: { allowEmpty?: boolean; allowAbsolute?: boolean } = {}) {
    return resolveWorkspacePath(roomWorkspace(ctx), path, {
        access: 'unrestricted',
        allowAbsolute: true,
        allowEmpty: options.allowEmpty,
        missingWorkspaceMessage: 'Room workspace not found',
    })
}

async function resolveRoomPreviewPath(ctx: any, path: unknown) {
    return resolveRoomPath(ctx, path, { allowAbsolute: true })
}

export async function listWorkspaceFiles(ctx: any): Promise<void> {
    try {
        const { relativePath, fullPath, workspace } = await resolveRoomPath(ctx, ctx.query.path, { allowEmpty: true })
        const info = await stat(fullPath)
        if (!info.isDirectory()) throw Object.assign(new Error('Not a directory'), { status: 400, code: 'not_a_directory' })
        const dirEntries = await readdir(fullPath, { withFileTypes: true })
        const entries = (await Promise.all(dirEntries.map(async entry => {
            const entryFullPath = pathResolve(fullPath, entry.name)
            const entryStat = await statIfPresent(entryFullPath)
            if (!entryStat) return null
            return {
                name: entry.name,
                path: groupWorkspaceRelativePath(workspace, entryFullPath),
                absolutePath: entryFullPath,
                isDir: entryStat.isDirectory(),
                size: entryStat.size,
                modTime: entryStat.mtime.toISOString(),
            }
        }))).filter(entry => entry !== null)
        entries.sort((a, b) => a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1)
        const decorated = await decorateWorkspaceEntries(workspace, relativePath, entries)
        ctx.body = {
            entries: decorated.entries,
            path: relativePath,
            absolutePath: fullPath,
            ...decorated.directoryDecoration,
        }
    } catch (error) {
        handleWorkspaceError(ctx, error)
    }
}

export async function readWorkspaceFile(ctx: any): Promise<void> {
    try {
        const { relativePath, fullPath } = await resolveRoomPath(ctx, ctx.query.path)
        const info = await stat(fullPath)
        if (!info.isFile()) throw Object.assign(new Error('Not a file'), { status: 400, code: 'not_a_file' })
        if (info.size > MAX_EDIT_SIZE) throw Object.assign(new Error('File too large to edit'), { status: 413, code: 'file_too_large' })
        const data = await readFile(fullPath)
        ctx.body = { content: data.toString('utf-8'), path: relativePath, size: data.length }
    } catch (error) {
        handleWorkspaceError(ctx, error)
    }
}

export async function diffWorkspaceFile(ctx: any): Promise<void> {
    try {
        const { relativePath, fullPath, workspace } = await resolveRoomPath(ctx, ctx.query.path)
        const info = await stat(fullPath)
        if (!info.isFile()) throw Object.assign(new Error('Not a file'), { status: 400, code: 'not_a_file' })
        ctx.body = await getWorkspaceFileGitDiff(workspace, relativePath)
    } catch (error) {
        handleWorkspaceError(ctx, error)
    }
}

export async function readWorkspaceFileContent(ctx: any): Promise<void> {
    try {
        const { relativePath, fullPath } = await resolveRoomPreviewPath(ctx, ctx.query.path)
        const download = ctx.query?.download === '1'
        const text = ctx.query?.text === '1'
        await serveWorkspaceFile(ctx, fullPath, relativePath, download, text)
    } catch (error) {
        handleWorkspaceError(ctx, error)
    }
}

export async function writeWorkspaceFile(ctx: any): Promise<void> {
    try {
        const body = ctx.request.body as { path?: unknown; content?: unknown; createOnly?: boolean }
        const { relativePath, fullPath } = await resolveRoomPath(ctx, body?.path)
        if (isSensitivePath(relativePath)) throw Object.assign(new Error('Cannot modify sensitive file'), { status: 403, code: 'permission_denied' })
        const data = fileContent(body?.content)
        if (data.length > MAX_EDIT_SIZE) throw Object.assign(new Error('Content too large'), { status: 413, code: 'file_too_large' })
        await writeFile(fullPath, data, { flag: body?.createOnly === true ? 'wx' : 'w' })
        ctx.body = { ok: true, path: relativePath }
    } catch (error) {
        handleWorkspaceError(ctx, error)
    }
}

export async function mkdirWorkspaceFile(ctx: any): Promise<void> {
    try {
        const { fullPath } = await resolveRoomPath(ctx, (ctx.request.body as { path?: unknown })?.path)
        await mkdir(fullPath, { recursive: true })
        ctx.body = { ok: true }
    } catch (error) {
        handleWorkspaceError(ctx, error)
    }
}

export async function deleteWorkspaceFile(ctx: any): Promise<void> {
    try {
        const body = ctx.request.body as { path?: unknown; recursive?: unknown }
        const { relativePath, fullPath } = await resolveRoomPath(ctx, body?.path)
        if (isSensitivePath(relativePath)) throw Object.assign(new Error('Cannot delete sensitive file'), { status: 403, code: 'permission_denied' })
        const info = await stat(fullPath)
        await rm(fullPath, info.isDirectory() ? { recursive: Boolean(body?.recursive), force: false } : undefined)
        ctx.body = { ok: true }
    } catch (error) {
        handleWorkspaceError(ctx, error)
    }
}

export async function renameWorkspaceFile(ctx: any): Promise<void> {
    try {
        const body = ctx.request.body as { oldPath?: unknown; newPath?: unknown }
        const oldTarget = await resolveRoomPath(ctx, body?.oldPath)
        const newTarget = await resolveRoomPath(ctx, body?.newPath)
        if (isSensitivePath(oldTarget.relativePath) || isSensitivePath(newTarget.relativePath)) {
            throw Object.assign(new Error('Cannot rename sensitive file'), { status: 403, code: 'permission_denied' })
        }
        await renameWithoutOverwrite(oldTarget.fullPath, newTarget.fullPath)
        ctx.body = { ok: true }
    } catch (error) {
        handleWorkspaceError(ctx, error)
    }
}

export async function copyWorkspaceFile(ctx: any): Promise<void> {
    try {
        const body = ctx.request.body as { srcPath?: unknown; destPath?: unknown }
        const source = await resolveRoomPath(ctx, body?.srcPath)
        const destination = await resolveRoomPath(ctx, body?.destPath)
        if (isSensitivePath(destination.relativePath)) throw Object.assign(new Error('Cannot overwrite sensitive file'), { status: 403, code: 'permission_denied' })
        const info = await stat(source.fullPath)
        if (!info.isFile()) throw Object.assign(new Error('Not a file'), { status: 400, code: 'not_a_file' })
        await copyFile(source.fullPath, destination.fullPath)
        ctx.body = { ok: true }
    } catch (error) {
        handleWorkspaceError(ctx, error)
    }
}
