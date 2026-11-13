import { stat } from 'fs/promises'
import { win32 as pathWin32 } from 'path'
import { isRealPathWithin } from './path'
import {
  assertWorkspaceDirectory,
  resolveWorkspaceDirectory,
  workspaceBaseDirectory,
} from '../workspace/manager'

export function workspaceBaseOverride(): string {
  return process.env.WORKSPACE_BASE?.trim() || ''
}

export function useWindowsDriveWorkspaceMode(): boolean {
  return process.platform === 'win32' && !workspaceBaseOverride()
}

function windowsDriveRoot(pathValue: string): string | null {
  const match = /^([a-zA-Z]:)[\\/]?$/.exec(pathValue.trim())
  return match ? `${match[1].toUpperCase()}\\` : null
}

export function normalizeWindowsWorkspacePath(inputPath: string): { base: string; fullPath: string } | null {
  const raw = String(inputPath || '').trim()
  if (!/^[a-zA-Z]:[\\/]/.test(raw)) return null
  const fullPath = pathWin32.resolve(raw)
  const root = windowsDriveRoot(pathWin32.parse(fullPath).root)
  if (!root) return null
  const rel = pathWin32.relative(root, fullPath)
  if (rel.startsWith('..') || pathWin32.isAbsolute(rel)) return null
  return { base: root, fullPath }
}

export async function isWorkspaceListPathAllowed(
  fullPath: string,
  basePath: string,
  statFn: typeof stat,
  options: { trustWindowsDriveRoot?: boolean; trustWindowsJunctions?: boolean; realPathWithinFn?: typeof isRealPathWithin } = {},
): Promise<boolean> {
  try {
    const info = await statFn(fullPath)
    if (!info.isDirectory()) return false
    if (process.platform === 'win32' && options.trustWindowsDriveRoot) return true
    return await (options.realPathWithinFn || isRealPathWithin)(fullPath, basePath)
  } catch {
    return false
  }
}

export async function resolveAllowedWorkspaceFolder(inputPath: string): Promise<{ base: string; fullPath: string } | null> {
  return resolveWorkspaceDirectory(inputPath)
}

export async function assertAllowedWorkspaceFolder(inputPath: string): Promise<{ base: string; fullPath: string }> {
  return assertWorkspaceDirectory(inputPath)
}

export { workspaceBaseDirectory }
