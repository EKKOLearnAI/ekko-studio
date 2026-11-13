import { mkdir, stat } from 'fs/promises'
import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'

/** Execution admission must never recreate a missing selected directory or use another cwd. */
export function requireExistingWorkspaceDirectory(value: string): string {
  const directory = normalizeDirectoryTarget(String(value || '').trim())
  try {
    if (!directory || !isAbsolute(directory) || !statSync(directory).isDirectory()) throw new Error('Invalid directory')
    accessSync(directory, constants.R_OK | constants.W_OK | constants.X_OK)
    return realpathSync(directory)
  } catch {
    throw Object.assign(new Error(`Workspace directory is unavailable: ${directory || '(not selected)'}`), {
      status: 409, code: 'WORKSPACE_UNAVAILABLE',
    })
  }
}

/**
 * `D:`, `D:\\` and `D:/` all name the root of a Windows drive, but only the
 * last two are unambiguous: `D:` is drive-relative, so it resolves against the
 * process's current directory on that drive and can point somewhere else
 * entirely.
 */
const WINDOWS_DRIVE_ROOT = /^[a-zA-Z]:[\\/]*$/

/**
 * Codes Windows returns when the directory Node asked for is already there.
 * `CreateDirectory` reports access denied (EPERM) rather than "already exists"
 * for a path it cannot create — including a drive root, which is a mount point
 * and never creatable.
 */
const EXISTING_DIRECTORY_CODES = new Set(['EEXIST', 'EPERM', 'EACCES'])

export function isWindowsDriveRoot(target: string): boolean {
  return process.platform === 'win32' && WINDOWS_DRIVE_ROOT.test(String(target || '').trim())
}

/** Turn a bare drive letter into the canonical drive root, so `D:` cannot resolve to a drive-relative directory. */
export function normalizeDirectoryTarget(target: string): string {
  const raw = String(target || '')
  if (!isWindowsDriveRoot(raw)) return raw
  return `${raw.trim().slice(0, 2)}\\`
}

/**
 * Ensure a directory exists.
 *
 * `mkdir(root, { recursive: true })` throws EPERM on Windows even though the
 * drive root always exists, because Node only swallows EEXIST/ENOTDIR while
 * walking the recursive path. A drive root is therefore accepted as-is, and a
 * permission error that leaves an existing directory behind counts as success
 * too — otherwise selecting a drive root as the workspace fails every run
 * before it starts.
 */
export async function ensureDirectory(target: string, options: { mode?: number } = {}): Promise<string> {
  const directory = normalizeDirectoryTarget(target)
  if (!directory) return directory
  if (isWindowsDriveRoot(directory)) return directory
  try {
    await mkdir(directory, { ...options, recursive: true })
  } catch (error) {
    if (!isExistingDirectoryError(error)) throw error
    if (!await isDirectory(directory)) throw error
  }
  return directory
}

function isExistingDirectoryError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  return EXISTING_DIRECTORY_CODES.has(String((error as NodeJS.ErrnoException).code))
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory()
  } catch {
    return false
  }
}
