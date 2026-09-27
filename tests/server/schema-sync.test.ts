import { beforeAll, beforeEach, describe, expect, it, vi, afterEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { unlinkSync, existsSync, mkdirSync, copyFileSync, writeFileSync, readFileSync } from 'fs'
import { resolve } from 'path'

// Test database path
const TEST_DB_DIR = resolve(process.cwd(), 'packages/server/data/test')
const TEST_DB_PATH = resolve(TEST_DB_DIR, 'test-hermes.db')

// Global test database instance
let testDbInstance: DatabaseSync | null = null

// Mock getDb to return our test database
vi.mock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
  getDb: () => testDbInstance,
  getStoragePath: () => TEST_DB_PATH,
}))

// Helper to get the actual database instance
function getTestDb(): DatabaseSync {
  if (!testDbInstance) {
    throw new Error('Test database not initialized. Call beforeAll() first.')
  }
  return testDbInstance
}

// Helper to check if table exists
function tableExists(db: DatabaseSync, tableName: string): boolean {
  const result = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
  ).get(tableName)
  return !!result
}

// Helper to get table columns
function getTableColumns(db: DatabaseSync, tableName: string): Map<string, string> {
  const columns = db.prepare(`PRAGMA table_info("${tableName}")`).all() as Array<{
    name: string
    type: string
    pk: number
  }>
  const columnMap = new Map<string, string>()
  for (const col of columns) {
    columnMap.set(col.name, col.type)
  }
  return columnMap
}

// Helper to get table primary key from SQL
function getTablePrimaryKey(db: DatabaseSync, tableName: string): string | null {
  const tableInfo = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name=?`
  ).get(tableName) as { sql: string } | undefined

  const sql = tableInfo?.sql || ''

  // First, check for composite primary key: PRIMARY KEY (col1, col2)
  const pkMatch = sql.match(/PRIMARY KEY\s*\(([^)]+)\)/i)
  if (pkMatch) {
    return pkMatch[1].replace(/\s+/g, '')
  }

  // Then, check for inline primary key: col TEXT PRIMARY KEY
  const inlinePkMatch = sql.match(/"(\w+)"\s+\w+\s+PRIMARY KEY/i)
  if (inlinePkMatch) {
    return inlinePkMatch[1]
  }

  return null
}

describe('Database Schema Synchronization', () => {
  beforeAll(() => {
    // Create test directory
    if (!existsSync(TEST_DB_DIR)) {
      mkdirSync(TEST_DB_DIR, { recursive: true })
    }
  })

  beforeEach(() => {
    // Clean up any existing test database
    try { unlinkSync(TEST_DB_PATH) } catch {}
    try { unlinkSync(TEST_DB_PATH + '-wal') } catch {}
    try { unlinkSync(TEST_DB_PATH + '-shm') } catch {}

    // Create new test database
    testDbInstance = new DatabaseSync(TEST_DB_PATH)
    testDbInstance.exec('PRAGMA journal_mode=WAL')
    testDbInstance.exec('PRAGMA synchronous=NORMAL')

    // Reset modules to ensure fresh imports
    vi.resetModules()
  })

  afterEach(() => {
    // Close test database
    if (testDbInstance) {
      testDbInstance.close()
      testDbInstance = null
    }

    // Clean up test database and backup files
    try { unlinkSync(TEST_DB_PATH) } catch {}
    try { unlinkSync(TEST_DB_PATH + '-wal') } catch {}
    try { unlinkSync(TEST_DB_PATH + '-shm') } catch {}
  })

  describe('Normal initialization - fresh database creation', () => {
    it('creates all tables with correct schemas when database does not exist', async () => {
      const {
        initAllHermesTables,
        USAGE_TABLE,
        USAGE_SCHEMA,
        SESSIONS_TABLE,
        SESSIONS_SCHEMA,
        WORKFLOWS_TABLE,
        WORKFLOWS_SCHEMA,
        WORKFLOW_RUNS_TABLE,
        WORKFLOW_RUNS_SCHEMA,
        WORKFLOW_RUN_NODE_SESSIONS_TABLE,
        WORKFLOW_RUN_NODE_SESSIONS_SCHEMA,
        MCU_DEVICES_TABLE,
        MCU_DEVICES_SCHEMA,
        SOCIAL_MESSAGE_ACCOUNTS_TABLE,
        SOCIAL_MESSAGE_ACCOUNTS_SCHEMA,
        SOCIAL_MESSAGE_RUNTIME_STATES_TABLE,
        SOCIAL_MESSAGE_RUNTIME_STATES_SCHEMA,
      } =
        await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')

      initAllHermesTables()

      const db = getTestDb()

      // Verify USAGE_TABLE was created
      expect(tableExists(db, USAGE_TABLE)).toBe(true)

      // Verify USAGE_TABLE has correct columns
      const usageCols = getTableColumns(db, USAGE_TABLE)
      expect(usageCols.size).toBe(Object.keys(USAGE_SCHEMA).length)
      expect(usageCols.has('id')).toBe(true)
      expect(usageCols.has('session_id')).toBe(true)
      expect(usageCols.has('input_tokens')).toBe(true)
      const usageRunIndex = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_session_usage_run'`,
      ).get()
      expect(usageRunIndex).toBeTruthy()

      // Verify SESSIONS_TABLE was created
      expect(tableExists(db, SESSIONS_TABLE)).toBe(true)

      // Verify SESSIONS_TABLE has correct columns
      const sessionsCols = getTableColumns(db, SESSIONS_TABLE)
      expect(sessionsCols.size).toBe(Object.keys(SESSIONS_SCHEMA).length)
      expect(sessionsCols.has('id')).toBe(true)
      expect(sessionsCols.has('profile')).toBe(true)
      expect(sessionsCols.has('source')).toBe(true)
      expect(sessionsCols.has('agent_session_id')).toBe(true)
      expect(sessionsCols.has('agent_native_session_id')).toBe(true)
      expect(sessionsCols.has('push_enabled')).toBe(true)

      expect(tableExists(db, SOCIAL_MESSAGE_ACCOUNTS_TABLE)).toBe(true)
      const socialAccountCols = getTableColumns(db, SOCIAL_MESSAGE_ACCOUNTS_TABLE)
      expect(socialAccountCols.size).toBe(Object.keys(SOCIAL_MESSAGE_ACCOUNTS_SCHEMA).length)
      expect(socialAccountCols.has('active')).toBe(true)
      expect(socialAccountCols.has('binding_locale')).toBe(true)
      expect(socialAccountCols.has('binding_notified')).toBe(true)
      expect(getTablePrimaryKey(db, SOCIAL_MESSAGE_ACCOUNTS_TABLE)).toBe('user_id,platform')
      expect(tableExists(db, SOCIAL_MESSAGE_RUNTIME_STATES_TABLE)).toBe(true)
      const runtimeStateCols = getTableColumns(db, SOCIAL_MESSAGE_RUNTIME_STATES_TABLE)
      expect(runtimeStateCols.size).toBe(Object.keys(SOCIAL_MESSAGE_RUNTIME_STATES_SCHEMA).length)

      // Verify workflow tables were created
      expect(tableExists(db, WORKFLOWS_TABLE)).toBe(true)
      const workflowCols = getTableColumns(db, WORKFLOWS_TABLE)
      expect(workflowCols.size).toBe(Object.keys(WORKFLOWS_SCHEMA).length)
      expect(workflowCols.has('name')).toBe(true)
      expect(workflowCols.has('profile')).toBe(true)
      expect(workflowCols.has('workspace')).toBe(true)
      expect(workflowCols.has('nodes_json')).toBe(true)
      expect(workflowCols.has('edges_json')).toBe(true)
      expect(workflowCols.has('viewport_json')).toBe(true)

      expect(tableExists(db, WORKFLOW_RUNS_TABLE)).toBe(true)
      const workflowRunCols = getTableColumns(db, WORKFLOW_RUNS_TABLE)
      expect(workflowRunCols.size).toBe(Object.keys(WORKFLOW_RUNS_SCHEMA).length)
      expect(workflowRunCols.has('workflow_id')).toBe(true)
      expect(workflowRunCols.has('workspace')).toBe(true)
      expect(workflowRunCols.has('start_node_ids_json')).toBe(true)
      expect(workflowRunCols.has('snapshot_nodes_json')).toBe(true)
      expect(workflowRunCols.has('snapshot_edges_json')).toBe(true)

      expect(tableExists(db, WORKFLOW_RUN_NODE_SESSIONS_TABLE)).toBe(true)
      const workflowRunNodeSessionCols = getTableColumns(db, WORKFLOW_RUN_NODE_SESSIONS_TABLE)
      expect(workflowRunNodeSessionCols.size).toBe(Object.keys(WORKFLOW_RUN_NODE_SESSIONS_SCHEMA).length)
      expect(workflowRunNodeSessionCols.has('run_id')).toBe(true)
      expect(workflowRunNodeSessionCols.has('workflow_id')).toBe(true)
      expect(workflowRunNodeSessionCols.has('node_id')).toBe(true)
      expect(workflowRunNodeSessionCols.has('session_id')).toBe(true)
      expect(workflowRunNodeSessionCols.has('status')).toBe(true)
      expect(workflowRunNodeSessionCols.has('agent')).toBe(true)

      expect(tableExists(db, MCU_DEVICES_TABLE)).toBe(true)
      const mcuDeviceCols = getTableColumns(db, MCU_DEVICES_TABLE)
      expect(mcuDeviceCols.size).toBe(Object.keys(MCU_DEVICES_SCHEMA).length)
      expect(mcuDeviceCols.has('id')).toBe(true)
      expect(mcuDeviceCols.has('name')).toBe(true)
      expect(mcuDeviceCols.has('device_code')).toBe(true)
      expect(mcuDeviceCols.has('is_official')).toBe(true)
      expect(mcuDeviceCols.has('created_at')).toBe(true)

      db.prepare(`INSERT INTO "${MCU_DEVICES_TABLE}" (name, device_code, is_official) VALUES (?, ?, ?)`)
        .run('MCU 1', 'device-code-1', 1)
      expect(() => {
        db.prepare(`INSERT INTO "${MCU_DEVICES_TABLE}" (name, device_code, is_official) VALUES (?, ?, ?)`)
          .run('MCU Duplicate', 'device-code-1', 0)
      }).toThrow()
    })
  })

  describe('Safe additive schema changes', () => {
    it('adds the workflow quality table when upgrading an already-current node session schema', async () => {
      const {
        initAllHermesTables,
        WORKFLOW_RUN_NODE_SESSIONS_SCHEMA,
        WORKFLOW_RUN_NODE_SESSIONS_TABLE,
        WORKFLOW_RUN_NODE_SESSIONS_INDEXES,
        WORKFLOW_RUN_QUALITY_EVALUATIONS_TABLE,
      } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
      const db = getTestDb()
      const columns = Object.entries(WORKFLOW_RUN_NODE_SESSIONS_SCHEMA)
        .map(([name, definition]) => `"${name}" ${definition}`)
        .join(', ')
      db.exec(`CREATE TABLE "${WORKFLOW_RUN_NODE_SESSIONS_TABLE}" (${columns})`)
      for (const sql of Object.values(WORKFLOW_RUN_NODE_SESSIONS_INDEXES)) db.exec(sql)
      expect(tableExists(db, WORKFLOW_RUN_QUALITY_EVALUATIONS_TABLE)).toBe(false)

      expect(() => initAllHermesTables()).not.toThrow()
      expect(tableExists(db, WORKFLOW_RUN_QUALITY_EVALUATIONS_TABLE)).toBe(true)
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='uniq_workflow_quality_attempt'`).get()).toBeTruthy()
      expect(() => initAllHermesTables()).not.toThrow()
    })

    it('migrates legacy workflow node sessions before creating the execution identity index', async () => {
      const {
        initAllHermesTables,
        WORKFLOW_RUN_NODE_SESSIONS_TABLE,
      } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
      const db = getTestDb()

      db.exec(`
        CREATE TABLE "${WORKFLOW_RUN_NODE_SESSIONS_TABLE}" (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          workflow_id TEXT NOT NULL,
          node_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          profile TEXT NOT NULL DEFAULT 'default',
          agent TEXT NOT NULL DEFAULT '',
          agent_mode TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'queued',
          sequence INTEGER NOT NULL DEFAULT 0,
          started_at INTEGER,
          finished_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          error TEXT
        );
        CREATE UNIQUE INDEX uniq_workflow_run_node_sessions_run_node
          ON "${WORKFLOW_RUN_NODE_SESSIONS_TABLE}"(run_id, node_id);
      `)
      const insert = db.prepare(`
        INSERT INTO "${WORKFLOW_RUN_NODE_SESSIONS_TABLE}"
          (id, run_id, workflow_id, node_id, session_id, sequence, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      insert.run('legacy-a', 'run-1', 'workflow-1', 'node-a', 'session-a', 0, 100, 100)
      insert.run('legacy-b', 'run-1', 'workflow-1', 'node-b', 'session-b', 1, 101, 101)

      expect(() => initAllHermesTables()).not.toThrow()

      const rows = db.prepare(`
        SELECT id, run_id, node_id, execution_id, iteration_path_json,
               consumed_edge_evaluation_ids_json, session_id
        FROM "${WORKFLOW_RUN_NODE_SESSIONS_TABLE}"
        ORDER BY sequence
      `).all()
      expect(rows).toEqual([
        {
          id: 'legacy-a', run_id: 'run-1', node_id: 'node-a', execution_id: 'node-a',
          iteration_path_json: '[]', consumed_edge_evaluation_ids_json: '[]', session_id: 'session-a',
        },
        {
          id: 'legacy-b', run_id: 'run-1', node_id: 'node-b', execution_id: 'node-b',
          iteration_path_json: '[]', consumed_edge_evaluation_ids_json: '[]', session_id: 'session-b',
        },
      ])
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`)
        .get('uniq_workflow_run_node_sessions_run_node')).toBeUndefined()
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`)
        .get('uniq_workflow_run_node_sessions_run_execution')).toBeTruthy()

      expect(() => initAllHermesTables()).not.toThrow()
      expect(db.prepare(`SELECT COUNT(*) AS count FROM "${WORKFLOW_RUN_NODE_SESSIONS_TABLE}"`).get())
        .toEqual({ count: 2 })
    })

    it('repairs a partially migrated workflow node session table after a failed startup', async () => {
      const {
        initAllHermesTables,
        WORKFLOW_RUN_NODE_SESSIONS_TABLE,
      } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
      const db = getTestDb()

      db.exec(`
        CREATE TABLE "${WORKFLOW_RUN_NODE_SESSIONS_TABLE}" (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          workflow_id TEXT NOT NULL,
          node_id TEXT NOT NULL,
          execution_id TEXT NOT NULL DEFAULT '',
          iteration_path_json TEXT NOT NULL DEFAULT '[]',
          consumed_edge_evaluation_ids_json TEXT NOT NULL DEFAULT '[]',
          session_id TEXT NOT NULL,
          profile TEXT NOT NULL DEFAULT 'default',
          agent TEXT NOT NULL DEFAULT '',
          agent_mode TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'queued',
          sequence INTEGER NOT NULL DEFAULT 0,
          started_at INTEGER,
          finished_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          error TEXT
        )
      `)
      const insert = db.prepare(`
        INSERT INTO "${WORKFLOW_RUN_NODE_SESSIONS_TABLE}"
          (id, run_id, workflow_id, node_id, session_id, sequence, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      insert.run('partial-a', 'run-2', 'workflow-1', 'node-a', 'session-a', 0, 100, 100)
      insert.run('partial-b', 'run-2', 'workflow-1', 'node-b', 'session-b', 1, 101, 101)

      expect(() => initAllHermesTables()).not.toThrow()
      expect(db.prepare(`
        SELECT execution_id FROM "${WORKFLOW_RUN_NODE_SESSIONS_TABLE}" ORDER BY sequence
      `).all()).toEqual([{ execution_id: 'node-a' }, { execution_id: 'node-b' }])
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`)
        .get('uniq_workflow_run_node_sessions_run_execution')).toBeTruthy()
    })

    it('archives incompatible legacy edge evidence before creating the current table', async () => {
      const {
        initAllHermesTables,
        WORKFLOW_RUN_EDGE_EVALUATIONS_TABLE,
      } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
      const db = getTestDb()
      const archiveTable = `${WORKFLOW_RUN_EDGE_EVALUATIONS_TABLE}__legacy_v1`

      db.exec(`
        CREATE TABLE "${WORKFLOW_RUN_EDGE_EVALUATIONS_TABLE}" (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          workflow_id TEXT NOT NULL,
          source_execution_id TEXT,
          consumed_by_execution_id TEXT,
          edge_id TEXT NOT NULL,
          source_node_id TEXT NOT NULL,
          target_node_id TEXT NOT NULL,
          iteration_path_json TEXT NOT NULL DEFAULT '[]',
          loop_id TEXT,
          status TEXT NOT NULL DEFAULT 'not_taken',
          delivery_status TEXT NOT NULL DEFAULT 'pending',
          reason TEXT NOT NULL DEFAULT '',
          context_json TEXT NOT NULL DEFAULT '{}',
          sequence INTEGER NOT NULL DEFAULT 0,
          evaluated_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        )
      `)
      db.prepare(`
        INSERT INTO "${WORKFLOW_RUN_EDGE_EVALUATIONS_TABLE}"
          (id, run_id, workflow_id, edge_id, source_node_id, target_node_id, evaluated_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('legacy-edge', 'run-1', 'workflow-1', 'edge-1', 'node-a', 'node-b', 100, 100)

      expect(() => initAllHermesTables()).not.toThrow()

      const currentColumns = getTableColumns(db, WORKFLOW_RUN_EDGE_EVALUATIONS_TABLE)
      expect(currentColumns.has('source_outcome')).toBe(true)
      expect(currentColumns.has('route')).toBe(true)
      expect(currentColumns.has('orchestration_json')).toBe(true)
      expect(currentColumns.has('condition_evaluation_json')).toBe(true)
      expect(db.prepare(`SELECT COUNT(*) AS count FROM "${WORKFLOW_RUN_EDGE_EVALUATIONS_TABLE}"`).get())
        .toEqual({ count: 0 })
      expect(db.prepare(`SELECT id, context_json FROM "${archiveTable}"`).get())
        .toEqual({ id: 'legacy-edge', context_json: '{}' })

      expect(() => initAllHermesTables()).not.toThrow()
      expect(db.prepare(`SELECT COUNT(*) AS count FROM "${archiveTable}"`).get())
        .toEqual({ count: 1 })
    })


    it('adds assistant turn attribution to legacy workspace changes without losing audit rows', async () => {
      const {
        syncTable,
        WORKSPACE_RUN_CHANGES_TABLE,
        WORKSPACE_RUN_CHANGES_SCHEMA,
        WORKSPACE_RUN_CHANGES_INDEXES,
      } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
      const db = getTestDb()
      const legacySchema = Object.fromEntries(
        Object.entries(WORKSPACE_RUN_CHANGES_SCHEMA).filter(([name]) => name !== 'assistant_message_id'),
      )
      const columnSql = Object.entries(legacySchema)
        .map(([name, definition]) => `"${name}" ${definition}`)
        .join(', ')
      db.exec(`CREATE TABLE "${WORKSPACE_RUN_CHANGES_TABLE}" (${columnSql})`)
      db.prepare(`
        INSERT INTO "${WORKSPACE_RUN_CHANGES_TABLE}"
          (change_id, session_id, workspace, created_at)
        VALUES (?, ?, ?, ?)
      `).run('legacy-change', 'session-1', '/tmp/repo', 42)

      syncTable(WORKSPACE_RUN_CHANGES_TABLE, WORKSPACE_RUN_CHANGES_SCHEMA, {
        indexes: WORKSPACE_RUN_CHANGES_INDEXES,
      })

      expect(getTableColumns(db, WORKSPACE_RUN_CHANGES_TABLE).has('assistant_message_id')).toBe(true)
      expect(db.prepare(`
        SELECT change_id, session_id, assistant_message_id
        FROM "${WORKSPACE_RUN_CHANGES_TABLE}"
      `).get()).toEqual({
        change_id: 'legacy-change',
        session_id: 'session-1',
        assistant_message_id: '',
      })
    })

    it('adds missing safe columns to existing table without rebuilding', async () => {
      const { syncTable, USAGE_TABLE, USAGE_SCHEMA } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')

      // Create initial table without some columns
      const db = getTestDb()
      db.exec(`CREATE TABLE "${USAGE_TABLE}" (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, created_at INTEGER NOT NULL)`)

      // Insert test data
      db.prepare(`INSERT INTO "${USAGE_TABLE}" (session_id, created_at) VALUES (?, ?)`).run('test-1', Date.now())

      // Sync with full schema
      syncTable(USAGE_TABLE, USAGE_SCHEMA, { primaryKey: 'id' })

      // Verify safe missing columns now exist
      const cols = getTableColumns(db, USAGE_TABLE)
      expect(cols.has('input_tokens')).toBe(true)
      expect(cols.has('output_tokens')).toBe(true)
      expect(cols.has('cache_read_tokens')).toBe(true)
      expect(cols.has('cache_write_tokens')).toBe(true)
      expect(cols.has('run_id')).toBe(true)
      expect(cols.has('source')).toBe(true)
      expect(cols.has('agent')).toBe(true)
      expect(cols.has('provider')).toBe(true)
      expect(cols.has('is_estimated')).toBe(true)

      // Verify data integrity (should be preserved)
      const row = db.prepare(`SELECT * FROM "${USAGE_TABLE}" WHERE session_id = ?`).get('test-1')
      expect(row).toBeTruthy()
      expect(row.session_id).toBe('test-1')
    })

    it('adds created_at to legacy session_usage tables missing the column', async () => {
      const { syncTable, USAGE_TABLE, USAGE_SCHEMA } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')

      const db = getTestDb()
      db.exec(`CREATE TABLE "${USAGE_TABLE}" (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL)`)
      db.prepare(`INSERT INTO "${USAGE_TABLE}" (session_id) VALUES (?)`).run('legacy-session')

      syncTable(USAGE_TABLE, USAGE_SCHEMA, { primaryKey: 'id' })

      const cols = getTableColumns(db, USAGE_TABLE)
      expect(cols.has('created_at')).toBe(true)

      const row = db.prepare(`SELECT session_id, created_at FROM "${USAGE_TABLE}" WHERE session_id = ?`).get('legacy-session')
      expect(row).toMatchObject({ session_id: 'legacy-session', created_at: 0 })
    })
  })

  describe('Schema sync with single-column primary keys', () => {
    it('creates table with single-column primary key', async () => {
      const { syncTable, GC_ROOM_AGENTS_TABLE, GC_ROOM_AGENTS_SCHEMA } =
        await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')

      syncTable(GC_ROOM_AGENTS_TABLE, GC_ROOM_AGENTS_SCHEMA, {
        primaryKey: 'id',
      })

      const db = getTestDb()

      // Verify table exists
      expect(tableExists(db, GC_ROOM_AGENTS_TABLE)).toBe(true)

      // Verify single-column primary key
      const pk = getTablePrimaryKey(db, GC_ROOM_AGENTS_TABLE)
      expect(pk).toBe('id')

      // Verify all columns exist
      const cols = getTableColumns(db, GC_ROOM_AGENTS_TABLE)
      expect(cols.has('id')).toBe(true)
      expect(cols.has('roomId')).toBe(true)
      expect(cols.has('agentId')).toBe(true)
      expect(cols.has('profile')).toBe(true)
      expect(cols.has('name')).toBe(true)

      // Verify primary key constraint works (unique id required)
      db.prepare(`INSERT INTO "${GC_ROOM_AGENTS_TABLE}" (id, roomId, agentId, profile, name, description, invited) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run('agent-1', 'room-1', 'agent-1', 'default', 'Agent 1', '', 0)

      db.prepare(`INSERT INTO "${GC_ROOM_AGENTS_TABLE}" (id, roomId, agentId, profile, name, description, invited) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run('agent-2', 'room-1', 'agent-2', 'default', 'Agent 2', '', 0)

      // Verify both rows exist
      const rows = db.prepare(`SELECT COUNT(*) as count FROM "${GC_ROOM_AGENTS_TABLE}"`).get() as { count: number }
      expect(rows.count).toBe(2)

      // Verify duplicate primary key is rejected
      expect(() => {
        db.prepare(`INSERT INTO "${GC_ROOM_AGENTS_TABLE}" (id, roomId, agentId, profile, name, description, invited) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run('agent-1', 'room-1', 'agent-1', 'default', 'Agent 1 Duplicate', '', 0)
      }).toThrow()
    })
  })

  describe('Destructive schema changes are not applied automatically', () => {
    it('does not rebuild table when primary key differs', async () => {
      const { syncTable, GC_ROOM_MEMBERS_TABLE, GC_ROOM_MEMBERS_SCHEMA } =
        await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')

      const db = getTestDb()

      // Create table with roomId as primary key and all necessary columns
      db.exec(`CREATE TABLE "${GC_ROOM_MEMBERS_TABLE}" (roomId TEXT PRIMARY KEY, userId TEXT, userName TEXT, description TEXT DEFAULT '', joinedAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL)`)

      // Insert test data
      db.prepare(`INSERT INTO "${GC_ROOM_MEMBERS_TABLE}" (roomId, userId, userName, description, joinedAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`)
        .run('room-1', 'user-1', 'User 1', '', Date.now(), Date.now())

      // Sync with id-based primary key schema
      syncTable(GC_ROOM_MEMBERS_TABLE, GC_ROOM_MEMBERS_SCHEMA, {
        primaryKey: 'id',
      })

      // Verify existing primary key was left untouched
      const tableCols = db.prepare(`PRAGMA table_info("${GC_ROOM_MEMBERS_TABLE}")`).all() as Array<{ name: string; pk: number }>
      expect(tableCols.find(c => c.name === 'roomId')?.pk).toBe(1)

      // Verify data was preserved
      const row = db.prepare(`SELECT * FROM "${GC_ROOM_MEMBERS_TABLE}" WHERE roomId = ? AND userId = ?`).get('room-1', 'user-1')
      expect(row).toBeTruthy()
      expect(row.roomId).toBe('room-1')
      expect(row.userId).toBe('user-1')
    })

    it('does not rebuild table when column types differ', async () => {
      const { syncTable, USAGE_TABLE, USAGE_SCHEMA } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')

      const db = getTestDb()

      // Create table with wrong column type (INTEGER instead of TEXT for session_id)
      db.exec(`CREATE TABLE "${USAGE_TABLE}" (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL, created_at INTEGER NOT NULL)`)

      // Insert test data
      db.prepare(`INSERT INTO "${USAGE_TABLE}" (session_id, created_at) VALUES (?, ?)`).run(12345, Date.now())

      // Sync with correct schema
      syncTable(USAGE_TABLE, USAGE_SCHEMA, { primaryKey: 'id' })

      // Verify column type was left untouched
      const cols = getTableColumns(db, USAGE_TABLE)
      expect(cols.get('session_id')).toBe('INTEGER')

      // Verify data was preserved
      const rows = db.prepare(`SELECT COUNT(*) as count FROM "${USAGE_TABLE}"`).get() as { count: number }
      expect(rows.count).toBe(1)
    })
  })

  describe('Index synchronization', () => {
    it('creates specified indexes on table', async () => {
      const { syncTable, MESSAGES_TABLE, MESSAGES_SCHEMA } =
        await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')

      syncTable(MESSAGES_TABLE, MESSAGES_SCHEMA, {
        indexes: {
          idx_messages_session_id: 'CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id)',
        },
      })

      const db = getTestDb()

      // Verify index was created
      const indexes = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`).get('idx_messages_session_id')
      expect(indexes).toBeTruthy()
    })

    it('does not alter indexes on existing tables', async () => {
      const { syncTable, MESSAGES_TABLE, MESSAGES_SCHEMA } =
        await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')

      const db = getTestDb()

      // Create table and an extra index
      db.exec(`CREATE TABLE "${MESSAGES_TABLE}" (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, content TEXT)`)
      db.exec(`CREATE INDEX idx_extra ON "${MESSAGES_TABLE}"(content)`)

      // Sync without the extra index
      syncTable(MESSAGES_TABLE, MESSAGES_SCHEMA, {
        indexes: {
          idx_messages_session_id: 'CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id)',
        },
      })

      // Verify extra index remains
      const extraIndex = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`).get('idx_extra')
      expect(extraIndex).toBeTruthy()

      // Verify expected index was not added to an existing table
      const correctIndex = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`).get('idx_messages_session_id')
      expect(correctIndex).toBeFalsy()
    })
  })

  describe('Data preservation during schema sync', () => {
    it('preserves data when adding safe columns', async () => {
      const { syncTable, USAGE_TABLE, USAGE_SCHEMA } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')

      const db = getTestDb()

      // Create minimal table
      db.exec(`CREATE TABLE "${USAGE_TABLE}" (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, created_at INTEGER NOT NULL)`)

      // Insert test data (only columns that exist)
      const sessionId = 'test-session-123'
      db.prepare(`INSERT INTO "${USAGE_TABLE}" (session_id, created_at) VALUES (?, ?)`).run(sessionId, Date.now())

      // Sync with full schema (should add safe columns only)
      syncTable(USAGE_TABLE, USAGE_SCHEMA, { primaryKey: 'id' })

      // Verify data is still there
      const row = db.prepare(`SELECT * FROM "${USAGE_TABLE}" WHERE session_id = ?`).get(sessionId)
      expect(row).toBeTruthy()
      expect(row.session_id).toBe(sessionId)

      const cols = getTableColumns(db, USAGE_TABLE)
      expect(cols.has('input_tokens')).toBe(true)
    })

    it('preserves data and existing table definition when primary key is missing', async () => {
      const { syncTable, GC_ROOM_AGENTS_TABLE, GC_ROOM_AGENTS_SCHEMA } =
        await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')

      const db = getTestDb()

      // Create table without id primary key but with all columns
      db.exec(`CREATE TABLE "${GC_ROOM_AGENTS_TABLE}" (id TEXT NOT NULL, roomId TEXT NOT NULL, agentId TEXT NOT NULL, profile TEXT NOT NULL, name TEXT NOT NULL, description TEXT DEFAULT '', invited INTEGER DEFAULT 0)`)

      // Insert test data (only columns that exist)
      db.prepare(`INSERT INTO "${GC_ROOM_AGENTS_TABLE}" (id, roomId, agentId, profile, name, description, invited) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run('agent-1', 'room-1', 'agent-1', 'default', 'Test Agent', '', 0)

      // Sync with id primary key expectation; should not rebuild existing table
      syncTable(GC_ROOM_AGENTS_TABLE, GC_ROOM_AGENTS_SCHEMA, {
        primaryKey: 'id',
      })

      expect(getTablePrimaryKey(db, GC_ROOM_AGENTS_TABLE)).toBe(null)

      // Verify data was preserved
      const row = db.prepare(`SELECT * FROM "${GC_ROOM_AGENTS_TABLE}" WHERE id = ?`)
        .get('agent-1')
      expect(row).toBeTruthy()
      expect(row.id).toBe('agent-1')
      expect(row.roomId).toBe('room-1')
      expect(row.agentId).toBe('agent-1')
      expect(row.name).toBe('Test Agent')
    })
  })

  describe('Column preservation', () => {
    it('keeps extra columns on existing table', async () => {
      const { syncTable, USAGE_TABLE, USAGE_SCHEMA } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')

      // Create table with extra columns
      const db = getTestDb()
      db.exec(`CREATE TABLE "${USAGE_TABLE}" (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, created_at INTEGER NOT NULL, extra_col TEXT, another_extra INTEGER)`)

      // Insert test data (only for columns that exist)
      db.prepare(`INSERT INTO "${USAGE_TABLE}" (session_id, created_at, extra_col, another_extra) VALUES (?, ?, ?, ?)`)
        .run('test-1', Date.now(), 'value', 123)

      // Sync with schema (should keep extra columns)
      syncTable(USAGE_TABLE, USAGE_SCHEMA, { primaryKey: 'id' })

      // Verify extra columns are preserved
      const cols = getTableColumns(db, USAGE_TABLE)
      expect(cols.has('extra_col')).toBe(true)
      expect(cols.has('another_extra')).toBe(true)

      // Verify data is still there
      const row = db.prepare(`SELECT * FROM "${USAGE_TABLE}" WHERE session_id = ?`).get('test-1')
      expect(row).toBeTruthy()
      expect(row.session_id).toBe('test-1')
    })
  })

  describe('Model context profile migration', () => {
    it('moves legacy rows to default profile and replaces the global unique index', async () => {
      const {
        initAllHermesTables,
        LEGACY_MODEL_CONTEXT_INDEX,
        MODEL_CONTEXT_TABLE,
      } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
      const db = getTestDb()
      db.exec(`CREATE TABLE "${MODEL_CONTEXT_TABLE}" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        context_limit INTEGER NOT NULL
      )`)
      db.exec(`CREATE UNIQUE INDEX ${LEGACY_MODEL_CONTEXT_INDEX} ON "${MODEL_CONTEXT_TABLE}"(provider, model)`)
      db.prepare(`INSERT INTO "${MODEL_CONTEXT_TABLE}" (provider, model, context_limit) VALUES (?, ?, ?)`)
        .run('deepseek', 'shared-model', 64000)

      expect(() => initAllHermesTables()).not.toThrow()

      const legacyRow = db.prepare(
        `SELECT profile, context_limit FROM "${MODEL_CONTEXT_TABLE}" WHERE provider = ? AND model = ?`,
      ).get('deepseek', 'shared-model') as { profile: string; context_limit: number }
      expect(legacyRow).toEqual({ profile: 'default', context_limit: 64000 })
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`).get(LEGACY_MODEL_CONTEXT_INDEX))
        .toBeUndefined()
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_model_context_profile_provider_model'`).get())
        .toBeTruthy()

      expect(() => db.prepare(
        `INSERT INTO "${MODEL_CONTEXT_TABLE}" (profile, provider, model, context_limit) VALUES (?, ?, ?, ?)`,
      ).run('research', 'deepseek', 'shared-model', 128000)).not.toThrow()
      expect(() => db.prepare(
        `INSERT INTO "${MODEL_CONTEXT_TABLE}" (profile, provider, model, context_limit) VALUES (?, ?, ?, ?)`,
      ).run('default', 'deepseek', 'shared-model', 128000)).toThrow()
    })
  })
})
