import { resolve, join, win32 } from 'path'
import { config, getWebUiHome } from '../../public/config'
import { getProfileDir, listProfileNamesFromDisk } from '../../public/profile-config'
import {
  listWorkspaceDirectories, recordWorkspaceDirectory, setWorkspaceDirectoryFavorite,
} from '../../repositories/workspace-directory-store'
import { workspaceBaseDirectory } from './manager'

export function normalizeWorkspaceDirectory(path: string): string {
  if (process.platform === 'win32' || /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\')) {
    return win32.resolve(path)
  }
  return resolve(workspaceBaseDirectory(), path)
}

function pathKey(path: string): string {
  return process.platform === 'win32' || /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\')
    ? path.toLowerCase() : path
}

function generatedWorkspaceRoots(): string[] {
  return [
    join(config.appHome, 'group-chat'), join(config.appHome, 'workflow'),
    join(getWebUiHome(), 'coding-agent', 'workspace'),
    join(config.appHome, '.ekko', 'workspace'),
    ...listProfileNamesFromDisk().map(profile => join(getProfileDir(profile), 'workspace')),
  ].map(root => pathKey(normalizeWorkspaceDirectory(root)))
}

export function isGeneratedWorkspaceDirectory(path: string, roots = generatedWorkspaceRoots()): boolean {
  const key = pathKey(path)
  return roots.some(normalized => {
    const separator = normalized.includes('\\') ? '\\' : '/'
    return key === normalized || key.startsWith(`${normalized}${separator}`)
  })
}

export function getUserWorkspaceDirectories(userId: number) {
  const roots = generatedWorkspaceRoots()
  return { directories: listWorkspaceDirectories(userId).filter(entry => !isGeneratedWorkspaceDirectory(entry.path, roots)) }
}

export function saveUserWorkspaceDirectory(userId: number, input: string, favorite?: boolean) {
  const path = normalizeWorkspaceDirectory(input.trim())
  // Only explicit selections reach this service. Runtime fallback workspaces
  // are never harvested from sessions and cannot enter the shortcut list.
  if (!isGeneratedWorkspaceDirectory(path)) {
    if (favorite === undefined) recordWorkspaceDirectory(userId, path, pathKey(path))
    else setWorkspaceDirectoryFavorite(userId, path, pathKey(path), favorite)
  }
  return getUserWorkspaceDirectories(userId)
}
