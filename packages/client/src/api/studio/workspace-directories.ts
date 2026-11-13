import { request } from '@/api/client'

export interface WorkspaceDirectory {
  path: string
  isFavorite: boolean
  lastUsed: number
  useCount: number
  createdAt: number
  updatedAt: number
}

export interface WorkspaceDirectoriesResponse { directories: WorkspaceDirectory[] }

export function sameWorkspaceDirectoryPath(left: string, right: string): boolean {
  if (!left.trim() || !right.trim()) return false
  const key = (path: string) => /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\')
    ? path.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
    : path.replace(/\/+$/, '')
  return key(left.trim()) === key(right.trim())
}

const endpoint = '/api/studio/workspace/directories'
export function fetchWorkspaceDirectories() {
  return request<WorkspaceDirectoriesResponse>(endpoint)
}
export function recordWorkspaceDirectory(path: string) {
  return request<WorkspaceDirectoriesResponse>(endpoint, { method: 'POST', body: JSON.stringify({ path }) })
}
export function setWorkspaceDirectoryFavorite(path: string, favorite: boolean) {
  return request<WorkspaceDirectoriesResponse>(endpoint, { method: 'PATCH', body: JSON.stringify({ path, favorite }) })
}
