import { normalize as pathNormalize } from 'path'
import {
    defaultGroupChatWorkspace,
    resolveWorkspacePath,
    workspaceRelativePath,
} from '../workspace/manager'

export { defaultGroupChatWorkspace }

export function normalizeGroupWorkspaceRelativePath(value: unknown, options: { allowEmpty?: boolean } = {}): string {
    const raw = typeof value === 'string' ? value.trim() : ''
    if (!raw && options.allowEmpty) return ''
    if (!raw) throw Object.assign(new Error('Missing path parameter'), { code: 'missing_path', status: 400 })
    if (raw.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(raw)) {
        throw Object.assign(new Error('Invalid file path'), { code: 'invalid_path', status: 400 })
    }
    const normalized = pathNormalize(raw).replace(/\\/g, '/')
    if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
        throw Object.assign(new Error('Invalid file path'), { code: 'invalid_path', status: 400 })
    }
    return normalized
}

export function groupWorkspaceRelativePath(workspace: string, fullPath: string): string {
    return workspaceRelativePath(workspace, fullPath)
}

export async function resolveGroupWorkspacePath(
    workspaceValue: unknown,
    pathValue: unknown,
    options: { allowEmpty?: boolean; allowAbsolute?: boolean } = {},
): Promise<{ relativePath: string; fullPath: string; workspace: string }> {
    const rawPath = typeof pathValue === 'string' ? pathValue.trim() : ''
    const isAbsolute = rawPath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(rawPath)
    const normalizedPath = isAbsolute && options.allowAbsolute
        ? rawPath
        : normalizeGroupWorkspaceRelativePath(pathValue, { allowEmpty: options.allowEmpty })
    return resolveWorkspacePath(workspaceValue, normalizedPath, {
        allowAbsolute: options.allowAbsolute,
        allowEmpty: options.allowEmpty,
        missingWorkspaceMessage: 'Room workspace not found',
    })
}
