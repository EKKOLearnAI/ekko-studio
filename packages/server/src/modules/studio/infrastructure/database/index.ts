import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { config } from '../../public/config'

const isDev = process.env.NODE_ENV !== 'production'
const isTest = process.env.VITEST === 'true' || process.env.NODE_ENV === 'test'

const testDbDirOverride = process.env.HERMES_WEB_UI_TEST_DB_DIR?.trim()

// In WSL, always use home directory to avoid cross-filesystem issues
const DB_DIR = isTest
  ? testDbDirOverride
    ? resolve(testDbDirOverride)
    : resolve(process.cwd(), 'packages/server/data/test-runtime')
  : isDev
  ? resolve(process.cwd(), 'packages/server/data')
  : config.appHome
const DB_PATH = resolve(DB_DIR, 'hermes-web-ui.db')
const JSON_PATH = resolve(DB_DIR, 'hermes-web-ui.json')

// --- SQLite availability check ---

const SQLITE_AVAILABLE = (() => {
  const [major, minor] = process.versions.node.split('.').map(Number)
  return major > 22 || (major === 22 && minor >= 5)
})()

export function isSqliteAvailable(): boolean {
  return SQLITE_AVAILABLE
}

// --- SQLite backend ---

let _db: DatabaseSync | null = null

export function getDb(): DatabaseSync | null {
  if (!SQLITE_AVAILABLE) return null
  if (!_db) {
    mkdirSync(DB_DIR, { recursive: true })
    const candidate = new DatabaseSync(DB_PATH)
    try {
      // Install the busy handler before changing journal mode so a transient
      // lock during startup does not immediately abort the whole bootstrap.
      candidate.exec('PRAGMA busy_timeout=5000')
      // Use WAL mode for better concurrency and WSL compatibility
      if (isTest) {
        candidate.exec('PRAGMA journal_mode=WAL')
        candidate.exec('PRAGMA synchronous=NORMAL')
        candidate.exec('PRAGMA foreign_keys=ON')
      } else if (isDev) {
        candidate.exec('PRAGMA journal_mode=WAL')
        candidate.exec('PRAGMA synchronous=NORMAL')
        candidate.exec('PRAGMA foreign_keys=ON')
      } else {
        candidate.exec('PRAGMA journal_mode=WAL')
        candidate.exec('PRAGMA synchronous=NORMAL')
        candidate.exec('PRAGMA foreign_keys=ON')
      }
      _db = candidate
    } catch (error) {
      try {
        candidate.close()
      } catch {
        // Preserve the original initialization error.
      }
      throw error
    }
  }
  return _db
}

// --- JSON fallback backend ---

type JsonData = Record<string, Record<string, Record<string, any>>>

function readJsonStore(): JsonData {
  if (!existsSync(JSON_PATH)) return {}
  try {
    return JSON.parse(readFileSync(JSON_PATH, 'utf-8'))
  } catch {
    return {}
  }
}

function writeJsonStore(data: JsonData): void {
  mkdirSync(DB_DIR, { recursive: true })
  writeFileSync(JSON_PATH, JSON.stringify(data, null, 2), 'utf-8')
}

/**
 * Get a record from the JSON store.
 * @param table  Table name (namespace)
 * @param key    Primary key
 */
export function jsonGet(table: string, key: string): Record<string, any> | undefined {
  const data = readJsonStore()
  return data[table]?.[key]
}

/**
 * Set a record in the JSON store.
 * @param table  Table name (namespace)
 * @param key    Primary key
 * @param value  Record data
 */
export function jsonSet(table: string, key: string, value: Record<string, any>): void {
  const data = readJsonStore()
  if (!data[table]) data[table] = {}
  data[table][key] = value
  writeJsonStore(data)
}

/**
 * Get all records from a table in the JSON store.
 */
export function jsonGetAll(table: string): Record<string, Record<string, any>> {
  const data = readJsonStore()
  return data[table] || {}
}

/**
 * Delete a record from the JSON store.
 */
export function jsonDelete(table: string, key: string): void {
  const data = readJsonStore()
  if (data[table]) {
    delete data[table][key]
    writeJsonStore(data)
  }
}

/**
 * Get the storage path for debugging.
 */
export function getStoragePath(): string {
  return SQLITE_AVAILABLE ? DB_PATH : JSON_PATH
}

/**
 * Close the SQLite database connection.
 */
export function closeDb(): void {
  if (_db) {
    try {
      _db.close()
    } catch { /* best-effort */ }
    _db = null
  }
}
