import { getDb } from '../infrastructure/database'
import { WORKSPACE_DIRECTORIES_TABLE } from '../infrastructure/database/schemas'

export interface WorkspaceDirectory {
  path: string
  isFavorite: boolean
  lastUsed: number
  useCount: number
  createdAt: number
  updatedAt: number
}

export function listWorkspaceDirectories(userId: number): WorkspaceDirectory[] {
  const rows = getDb()!.prepare(`SELECT * FROM ${WORKSPACE_DIRECTORIES_TABLE}
    WHERE user_id = ? ORDER BY last_used DESC, created_at, id`).all(userId)
  return rows.map(row => ({
    path: String(row.path), isFavorite: Boolean(row.is_favorite),
    lastUsed: Number(row.last_used), useCount: Number(row.use_count),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  }))
}

export function recordWorkspaceDirectory(userId: number, path: string, pathKey: string): void {
  const now = Date.now()
  getDb()!.prepare(`INSERT INTO ${WORKSPACE_DIRECTORIES_TABLE}
    (user_id, path, path_key, last_used, use_count, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(user_id, path_key) DO UPDATE SET
      last_used = excluded.last_used, use_count = use_count + 1, updated_at = excluded.updated_at`)
    .run(userId, path, pathKey, now, now, now)
}

export function setWorkspaceDirectoryFavorite(userId: number, path: string, pathKey: string, favorite: boolean): void {
  const now = Date.now()
  getDb()!.prepare(`INSERT INTO ${WORKSPACE_DIRECTORIES_TABLE}
    (user_id, path, path_key, is_favorite, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, path_key) DO UPDATE SET
      is_favorite = excluded.is_favorite, updated_at = excluded.updated_at`)
    .run(userId, path, pathKey, favorite ? 1 : 0, now, now)
}
