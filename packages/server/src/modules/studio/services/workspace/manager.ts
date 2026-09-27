import { mkdir, stat } from 'fs/promises'
import { homedir } from 'os'
import {
  isAbsolute,
  join,
  relative,
  resolve,
  win32 as pathWin32,
} from 'path'
import { config, getWebUiHome } from '../../public/config'
import { getProfileDir } from '../../public/profile-config'
import { isNearestExistingRealPathWithin, isPathWithin } from '../files/path'

export type WorkspacePathAccess = 'contained' | 'unrestricted'

export interface ResolveWorkspacePathOptions {
  access?: WorkspacePathAccess
  allowAbsolute?: boolean
  allowEmpty?: boolean
  missingWorkspaceMessage?: string
}

export interface ResolvedWorkspacePath {
  relativePath: string
  fullPath: string
  workspace: string
}

function safeWorkspaceSegment(value: string, fallback: string): string {
  const segment = String(value || '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim()
  return !segment || segment === '.' || segment === '..' ? fallback : segment
}

function usesWindowsPath(...values: string[]): boolean {
  return process.platform === 'win32' || values.some(value => /^[a-zA-Z]:[\\/]/.test(value))
}

function pathOperations(...values: string[]) {
  return usesWindowsPath(...values) ? pathWin32 : { isAbsolute, relative, resolve }
}

export function workspaceBaseDirectory(): string {
  return process.env.WORKSPACE_BASE?.trim() || homedir()
}

export type WorkspaceCandidate = unknown | (() => unknown)

export function selectWorkspace(...candidates: WorkspaceCandidate[]): string {
  for (const candidate of candidates) {
    const value = typeof candidate === 'function' ? candidate() : candidate
    if (typeof value !== 'string') continue
    const workspace = value.trim()
    if (workspace) return workspace
  }
  return ''
}

export function defaultHermesWorkspace(profile: string): string {
  return join(getProfileDir(profile || 'default'), 'workspace')
}

export function defaultGroupChatWorkspace(profile: string, roomId: string): string {
  return join(
    config.appHome,
    'group-chat',
    safeWorkspaceSegment(profile, 'default'),
    safeWorkspaceSegment(roomId, 'room'),
  )
}

export function defaultWorkflowWorkspace(profile: string, workflowId: string): string {
  return join(
    config.appHome,
    'workflow',
    safeWorkspaceSegment(profile, 'default'),
    safeWorkspaceSegment(workflowId, 'workflow'),
  )
}

export function defaultCodingAgentWorkspace(profile: string, provider: string): string {
  return join(
    getWebUiHome(),
    'coding-agent',
    'workspace',
    profile || 'default',
    provider || 'provider',
  )
}

export async function ensureWorkspaceDirectory(...candidates: WorkspaceCandidate[]): Promise<string> {
  const workspace = selectWorkspace(...candidates)
  if (!workspace) {
    throw Object.assign(new Error('Workspace is required'), { code: 'workspace_required', status: 400 })
  }
  await mkdir(workspace, { recursive: true })
  return workspace
}

export async function ensureHermesRunWorkspace(profile: string, workspace?: string | null): Promise<string> {
  return ensureWorkspaceDirectory(workspace, defaultHermesWorkspace(profile))
}

export function isAbsoluteWorkspacePath(value: unknown): boolean {
  const path = typeof value === 'string' ? value.trim() : ''
  return !!path && pathOperations(path).isAbsolute(path)
}

/**
 * Absolute folder a chat run uses for a session `workspace` value. Runs hand
 * the stored value straight to mkdir / the child process cwd
 * (ensureHermesRunWorkspace, coding-agent launches), so a relative value
 * resolves against the server's working directory. WORKSPACE_BASE only anchors
 * folder-picker and group-chat selections (resolveWorkspaceDirectory).
 */
export function resolveRunWorkspacePath(workspace: string): string {
  const raw = workspace.trim()
  return pathOperations(raw).resolve(raw)
}

export function workspaceRelativePath(workspace: string, fullPath: string): string {
  return pathOperations(workspace, fullPath).relative(workspace, fullPath).replace(/\\/g, '/')
}

/**
 * Resolve a path for a Studio-owned workspace operation.
 *
 * Local administrator routes use `unrestricted`: the workspace is a default
 * location, not a filesystem sandbox. Capability-scoped remote routes keep the
 * default `contained` policy so a room grant cannot escape its granted root.
 */
export async function resolveWorkspacePath(
  workspaceValue: unknown,
  pathValue: unknown,
  options: ResolveWorkspacePathOptions = {},
): Promise<ResolvedWorkspacePath> {
  const workspace = typeof workspaceValue === 'string' ? workspaceValue.trim() : ''
  if (!workspace) {
    throw Object.assign(new Error(options.missingWorkspaceMessage || 'Workspace not found'), {
      code: 'workspace_not_found',
      status: 404,
    })
  }

  const rawPath = typeof pathValue === 'string' ? pathValue.trim() : ''
  if (!rawPath && !options.allowEmpty) {
    throw Object.assign(new Error('Missing path parameter'), { code: 'missing_path', status: 400 })
  }

  const operations = pathOperations(workspace, rawPath)
  const absolute = !!rawPath && operations.isAbsolute(rawPath)
  const access = options.access || 'contained'
  if (absolute && access === 'contained' && !options.allowAbsolute) {
    throw Object.assign(new Error('Invalid file path'), { code: 'invalid_path', status: 400 })
  }

  const fullPath = absolute
    ? operations.resolve(rawPath)
    : operations.resolve(workspace, rawPath || '.')
  const relativePath = operations.relative(workspace, fullPath).replace(/\\/g, '/')

  if (access === 'contained') {
    if (!isPathWithin(fullPath, workspace) || !await isNearestExistingRealPathWithin(fullPath, workspace)) {
      throw Object.assign(new Error('Invalid file path'), { code: 'invalid_path', status: 400 })
    }
  }

  return { relativePath, fullPath, workspace }
}

/**
 * Validate a user-selected workspace directory without imposing a filesystem
 * root. Relative selections remain anchored to WORKSPACE_BASE/home for backward
 * compatibility; absolute selections may point anywhere on the host.
 */
export async function resolveWorkspaceDirectory(inputPath: unknown): Promise<{ base: string; fullPath: string } | null> {
  const raw = typeof inputPath === 'string' ? inputPath.trim() : ''
  if (!raw) return null

  const base = workspaceBaseDirectory()
  const operations = pathOperations(raw, base)
  const fullPath = operations.isAbsolute(raw)
    ? operations.resolve(raw)
    : operations.resolve(base, raw)
  try {
    const info = await stat(fullPath)
    return info.isDirectory() ? { base, fullPath } : null
  } catch {
    return null
  }
}

export async function assertWorkspaceDirectory(inputPath: unknown): Promise<{ base: string; fullPath: string }> {
  const raw = typeof inputPath === 'string' ? inputPath.trim() : ''
  const resolved = await resolveWorkspaceDirectory(raw)
  if (resolved) return resolved
  const error = new Error(raw ? 'Workspace folder is not allowed' : 'workspace is required') as Error & { status?: number }
  error.status = raw ? 403 : 400
  throw error
}
