import { getDb, isSqliteAvailable } from '../infrastructure/database'
import { SESSION_CATEGORIES_TABLE, SESSIONS_TABLE } from '../infrastructure/database/schemas'

export const SESSION_CATEGORY_NAME_MAX_LENGTH = 40

export interface SessionCategoryRow {
  id: number
  name: string
  created_at: number
  updated_at: number
}

function mapCategoryRow(row: Record<string, unknown>): SessionCategoryRow {
  return {
    id: Number(row.id),
    name: String(row.name || ''),
    created_at: Number(row.created_at || 0),
    updated_at: Number(row.updated_at || 0),
  }
}

export function normalizeSessionCategoryName(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/\s+/g, ' ')
}

export function listSessionCategories(): SessionCategoryRow[] {
  if (!isSqliteAvailable()) return []
  const db = getDb()!
  const rows = db.prepare(
    `SELECT id, name, created_at, updated_at FROM ${SESSION_CATEGORIES_TABLE} ORDER BY name COLLATE NOCASE, id`,
  ).all() as Record<string, unknown>[]
  return rows.map(mapCategoryRow)
}

export function getSessionCategory(id: number): SessionCategoryRow | null {
  if (!isSqliteAvailable()) return null
  const db = getDb()!
  const row = db.prepare(
    `SELECT id, name, created_at, updated_at FROM ${SESSION_CATEGORIES_TABLE} WHERE id = ?`,
  ).get(id) as Record<string, unknown> | undefined
  return row ? mapCategoryRow(row) : null
}

export function findSessionCategoryByName(name: string): SessionCategoryRow | null {
  if (!isSqliteAvailable()) return null
  const db = getDb()!
  const row = db.prepare(
    `SELECT id, name, created_at, updated_at FROM ${SESSION_CATEGORIES_TABLE} WHERE name = ? COLLATE NOCASE`,
  ).get(name) as Record<string, unknown> | undefined
  return row ? mapCategoryRow(row) : null
}

export function createSessionCategory(name: string): SessionCategoryRow {
  const normalizedName = normalizeSessionCategoryName(name)
  if (!normalizedName) throw new Error('Category name is required')
  if (normalizedName.length > SESSION_CATEGORY_NAME_MAX_LENGTH) {
    throw new Error(`Category name must be ${SESSION_CATEGORY_NAME_MAX_LENGTH} characters or fewer`)
  }
  if (!isSqliteAvailable()) {
    const now = Math.floor(Date.now() / 1000)
    return { id: 0, name: normalizedName, created_at: now, updated_at: now }
  }
  const existing = findSessionCategoryByName(normalizedName)
  if (existing) return existing

  const db = getDb()!
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    `INSERT OR IGNORE INTO ${SESSION_CATEGORIES_TABLE} (name, created_at, updated_at) VALUES (?, ?, ?)`,
  ).run(normalizedName, now, now)
  const category = findSessionCategoryByName(normalizedName)
  if (!category) throw new Error('Failed to create category')
  return category
}

export function renameSessionCategory(id: number, name: string): SessionCategoryRow | null {
  const normalizedName = normalizeSessionCategoryName(name)
  if (!normalizedName) throw new Error('Category name is required')
  if (normalizedName.length > SESSION_CATEGORY_NAME_MAX_LENGTH) {
    throw new Error(`Category name must be ${SESSION_CATEGORY_NAME_MAX_LENGTH} characters or fewer`)
  }
  if (!isSqliteAvailable()) return null
  const db = getDb()!
  const now = Math.floor(Date.now() / 1000)
  const result = db.prepare(
    `UPDATE ${SESSION_CATEGORIES_TABLE} SET name = ?, updated_at = ? WHERE id = ?`,
  ).run(normalizedName, now, id)
  return result.changes > 0 ? getSessionCategory(id) : null
}

export function deleteSessionCategory(id: number): boolean {
  if (!isSqliteAvailable()) return false
  const db = getDb()!
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(`UPDATE ${SESSIONS_TABLE} SET category_id = NULL WHERE category_id = ?`).run(id)
    const result = db.prepare(`DELETE FROM ${SESSION_CATEGORIES_TABLE} WHERE id = ?`).run(id)
    db.exec('COMMIT')
    return result.changes > 0
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function setSessionCategory(sessionId: string, categoryId: number | null): boolean {
  if (!isSqliteAvailable()) return false
  if (categoryId !== null && !getSessionCategory(categoryId)) return false
  const db = getDb()!
  const result = db.prepare(
    `UPDATE ${SESSIONS_TABLE} SET category_id = ? WHERE id = ?`,
  ).run(categoryId, sessionId)
  return result.changes > 0
}
