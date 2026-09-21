import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('Hermes schema initialization', () => {
  let db: any = null

  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
    }))
  })

  afterEach(() => {
    db?.close()
    db = null
    vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
    vi.resetModules()
  })

  it('initializes all tables with correct schemas', async () => {
    const { initAllHermesTables, USAGE_TABLE, SESSIONS_TABLE, SESSION_CATEGORIES_TABLE, MESSAGES_TABLE, GC_ROOMS_TABLE, GC_MESSAGES_TABLE, GC_ROOM_AGENTS_TABLE, USERS_TABLE, USER_PROFILES_TABLE, SOCIAL_MESSAGE_ACCOUNTS_TABLE, SOCIAL_MESSAGE_RUNTIME_STATES_TABLE, DEVICES_TABLE, MCU_DEVICES_TABLE } =
      await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')

    expect(() => initAllHermesTables()).not.toThrow()

    // Verify core tables exist
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>
    expect(tables.map(t => t.name)).toContain(USAGE_TABLE)
    expect(tables.map(t => t.name)).toContain(SESSIONS_TABLE)
    expect(tables.map(t => t.name)).toContain(SESSION_CATEGORIES_TABLE)
    expect(tables.map(t => t.name)).toContain(MESSAGES_TABLE)
    expect(tables.map(t => t.name)).toContain(GC_ROOMS_TABLE)
    expect(tables.map(t => t.name)).toContain(GC_MESSAGES_TABLE)
    expect(tables.map(t => t.name)).toContain(GC_ROOM_AGENTS_TABLE)
    expect(tables.map(t => t.name)).toContain(USERS_TABLE)
    expect(tables.map(t => t.name)).toContain(USER_PROFILES_TABLE)
    expect(tables.map(t => t.name)).toContain(SOCIAL_MESSAGE_ACCOUNTS_TABLE)
    expect(tables.map(t => t.name)).toContain(SOCIAL_MESSAGE_RUNTIME_STATES_TABLE)
    expect(tables.map(t => t.name)).toContain(DEVICES_TABLE)
    expect(tables.map(t => t.name)).toContain(MCU_DEVICES_TABLE)

    // Verify USAGE_TABLE structure
    const usageCols = db.prepare(`PRAGMA table_info("${USAGE_TABLE}")`).all() as Array<{ name: string }>
    expect(usageCols.some(c => c.name === 'id')).toBe(true)
    expect(usageCols.some(c => c.name === 'session_id')).toBe(true)
    expect(usageCols.some(c => c.name === 'input_tokens')).toBe(true)
    expect(usageCols.some(c => c.name === 'output_tokens')).toBe(true)

    const sessionCols = db.prepare(`PRAGMA table_info("${SESSIONS_TABLE}")`).all() as Array<{ name: string }>
    expect(sessionCols.some(c => c.name === 'source')).toBe(true)
    expect(sessionCols.some(c => c.name === 'agent')).toBe(true)
    expect(sessionCols.some(c => c.name === 'category_id')).toBe(true)
    expect(sessionCols.some(c => c.name === 'push_enabled')).toBe(true)
    const sessionIndexes = db.prepare(`PRAGMA index_list("${SESSIONS_TABLE}")`).all() as Array<{ name: string }>
    expect(sessionIndexes.some(index => index.name === 'idx_sessions_category_id')).toBe(true)

    const userCols = db.prepare(`PRAGMA table_info("${USERS_TABLE}")`).all() as Array<{ name: string }>
    expect(userCols.some(c => c.name === 'id')).toBe(true)
    expect(userCols.some(c => c.name === 'username')).toBe(true)
    expect(userCols.some(c => c.name === 'password_hash')).toBe(true)
    expect(userCols.some(c => c.name === 'role')).toBe(true)

    const profileCols = db.prepare(`PRAGMA table_info("${USER_PROFILES_TABLE}")`).all() as Array<{ name: string }>
    expect(profileCols.some(c => c.name === 'user_id')).toBe(true)
    expect(profileCols.some(c => c.name === 'profile_name')).toBe(true)
    expect(profileCols.some(c => c.name === 'is_default')).toBe(true)

    const socialAccountCols = db.prepare(`PRAGMA table_info("${SOCIAL_MESSAGE_ACCOUNTS_TABLE}")`).all() as Array<{ name: string }>
    expect(socialAccountCols.some(c => c.name === 'credentials_json')).toBe(true)
    expect(socialAccountCols.some(c => c.name === 'active')).toBe(true)
    expect(socialAccountCols.some(c => c.name === 'recipient')).toBe(true)
    expect(socialAccountCols.some(c => c.name === 'binding_locale')).toBe(true)
    expect(socialAccountCols.some(c => c.name === 'binding_notified')).toBe(true)
    const socialAccountIndexes = db.prepare(`PRAGMA index_list("${SOCIAL_MESSAGE_ACCOUNTS_TABLE}")`).all() as Array<{ name: string; unique: number }>
    expect(socialAccountIndexes).toContainEqual(expect.objectContaining({
      name: 'uniq_social_message_accounts_active_user',
      unique: 1,
    }))

    const roomAgentCols = db.prepare(`PRAGMA table_info("${GC_ROOM_AGENTS_TABLE}")`).all() as Array<{ name: string }>
    expect(roomAgentCols.some(c => c.name === 'agent')).toBe(true)
    expect(roomAgentCols.some(c => c.name === 'profile')).toBe(true)
    expect(roomAgentCols.some(c => c.name === 'provider')).toBe(true)
    expect(roomAgentCols.some(c => c.name === 'model')).toBe(true)
    expect(roomAgentCols.some(c => c.name === 'apiMode')).toBe(true)
    expect(roomAgentCols.some(c => c.name === 'reasoningEffort')).toBe(true)
    expect(roomAgentCols.some(c => c.name === 'avatar')).toBe(true)

    const groupMessageCols = db.prepare(`PRAGMA table_info("${GC_MESSAGES_TABLE}")`).all() as Array<{ name: string }>
    expect(groupMessageCols.some(c => c.name === 'run_id')).toBe(true)

    const deviceCols = db.prepare(`PRAGMA table_info("${DEVICES_TABLE}")`).all() as Array<{ name: string }>
    expect(deviceCols.some(c => c.name === 'id')).toBe(true)
    expect(deviceCols.some(c => c.name === 'status')).toBe(true)
    expect(deviceCols.some(c => c.name === 'device_public_key')).toBe(true)

    const mcuDeviceCols = db.prepare(`PRAGMA table_info("${MCU_DEVICES_TABLE}")`).all() as Array<{ name: string }>
    expect(mcuDeviceCols.some(c => c.name === 'id')).toBe(true)
    expect(mcuDeviceCols.some(c => c.name === 'name')).toBe(true)
    expect(mcuDeviceCols.some(c => c.name === 'device_code')).toBe(true)
    expect(mcuDeviceCols.some(c => c.name === 'is_official')).toBe(true)
    expect(mcuDeviceCols.some(c => c.name === 'created_at')).toBe(true)
  })

  it('preserves existing data when adding safe schema columns', async () => {
    const { initAllHermesTables, USAGE_TABLE, USAGE_SCHEMA } =
      await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')

    // Create table with minimal schema
    db.exec(`CREATE TABLE "${USAGE_TABLE}" (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, created_at INTEGER NOT NULL)`)

    // Insert test data
    db.prepare(`INSERT INTO "${USAGE_TABLE}" (session_id, created_at) VALUES (?, ?)`).run('test-session', Date.now())

    // Run initialization (should add safe missing columns)
    expect(() => initAllHermesTables()).not.toThrow()

    // Verify data is preserved
    const row = db.prepare(`SELECT * FROM "${USAGE_TABLE}" WHERE session_id = ?`).get('test-session')
    expect(row).toBeTruthy()
    expect(row.session_id).toBe('test-session')

    // Verify safe new columns were added
    const cols = db.prepare(`PRAGMA table_info("${USAGE_TABLE}")`).all() as Array<{ name: string }>
    expect(cols.some(c => c.name === 'input_tokens')).toBe(true)
    expect(cols.some(c => c.name === 'output_tokens')).toBe(true)
  })

  it('adds room agent model configuration columns to a legacy group chat table', async () => {
    const { initAllHermesTables, GC_ROOM_AGENTS_TABLE } =
      await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')

    db.exec(`CREATE TABLE "${GC_ROOM_AGENTS_TABLE}" (
      id TEXT PRIMARY KEY,
      roomId TEXT NOT NULL,
      agentId TEXT NOT NULL,
      profile TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      invited INTEGER NOT NULL DEFAULT 0
    )`)
    db.prepare(
      `INSERT INTO "${GC_ROOM_AGENTS_TABLE}" (id, roomId, agentId, profile, name, description, invited)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('row-1', 'room-1', 'agent-1', 'default', 'Worker', '', 0)

    expect(() => initAllHermesTables()).not.toThrow()

    const row = db.prepare(`SELECT * FROM "${GC_ROOM_AGENTS_TABLE}" WHERE id = ?`).get('row-1')
    expect(row).toMatchObject({
      agent: 'hermes',
      provider: '',
      model: '',
      apiMode: '',
      reasoningEffort: '',
      avatar: '',
      name: 'Worker',
    })
  })

  it('adds category, reasoning effort, and push setting columns to an existing sessions table', async () => {
    const { initAllHermesTables, SESSIONS_SCHEMA, SESSIONS_TABLE } =
      await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    const legacyColumns = Object.entries(SESSIONS_SCHEMA)
      .filter(([name]) => name !== 'category_id' && name !== 'reasoning_effort' && name !== 'push_enabled')
      .map(([name, definition]) => `"${name}" ${definition}`)
      .join(', ')
    db.exec(`CREATE TABLE "${SESSIONS_TABLE}" (${legacyColumns})`)
    db.prepare(`INSERT INTO "${SESSIONS_TABLE}" (id, started_at, last_active) VALUES (?, ?, ?)`)
      .run('legacy-session', 1, 1)

    expect(() => initAllHermesTables()).not.toThrow()

    const columns = db.prepare(`PRAGMA table_info("${SESSIONS_TABLE}")`).all() as Array<{ name: string }>
    expect(columns.some(column => column.name === 'category_id')).toBe(true)
    expect(columns.some(column => column.name === 'reasoning_effort')).toBe(true)
    expect(columns.some(column => column.name === 'push_enabled')).toBe(true)
    expect(db.prepare(`SELECT push_enabled FROM "${SESSIONS_TABLE}" WHERE id = ?`).get('legacy-session'))
      .toEqual({ push_enabled: 1 })
    const indexes = db.prepare(`PRAGMA index_list("${SESSIONS_TABLE}")`).all() as Array<{ name: string }>
    expect(indexes.some(index => index.name === 'idx_sessions_category_id')).toBe(true)
  })

  it('adds nullable Workflow budget evidence columns without losing legacy rows', async () => {
    const {
      initAllHermesTables,
      WORKFLOW_RUNS_SCHEMA,
      WORKFLOW_RUNS_TABLE,
      WORKFLOW_RUN_NODE_SESSIONS_SCHEMA,
      WORKFLOW_RUN_NODE_SESSIONS_TABLE,
    } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    const createLegacyTable = (table: string, schema: Record<string, string>, omitted: string[]) => {
      const columns = Object.entries(schema)
        .filter(([name]) => !omitted.includes(name))
        .map(([name, definition]) => `"${name}" ${definition}`)
        .join(', ')
      db.exec(`CREATE TABLE "${table}" (${columns})`)
    }
    createLegacyTable(WORKFLOW_RUNS_TABLE, WORKFLOW_RUNS_SCHEMA, ['requested_timeout_ms', 'deadline_at'])
    createLegacyTable(WORKFLOW_RUN_NODE_SESSIONS_TABLE, WORKFLOW_RUN_NODE_SESSIONS_SCHEMA, ['remaining_timeout_ms_at_start'])

    db.prepare(`INSERT INTO "${WORKFLOW_RUNS_TABLE}" (id, workflow_id, profile, workspace, start_node_ids_json, status, snapshot_nodes_json, snapshot_edges_json, compiled_loops_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('legacy-run', 'workflow-1', 'default', '', '[]', 'completed', '[]', '[]', '[]', 1)
    db.prepare(`INSERT INTO "${WORKFLOW_RUN_NODE_SESSIONS_TABLE}" (id, run_id, workflow_id, node_id, execution_id, iteration_path_json, consumed_edge_evaluation_ids_json, session_id, profile, agent, agent_mode, status, sequence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('legacy-node', 'legacy-run', 'workflow-1', 'node-1', 'node-1', '[]', '[]', 'session-1', 'default', 'hermes', '', 'completed', 0, 1, 1)

    expect(() => initAllHermesTables()).not.toThrow()
    expect(() => initAllHermesTables()).not.toThrow()
    const run = db.prepare(`SELECT requested_timeout_ms, deadline_at FROM "${WORKFLOW_RUNS_TABLE}" WHERE id = ?`).get('legacy-run')
    const node = db.prepare(`SELECT remaining_timeout_ms_at_start FROM "${WORKFLOW_RUN_NODE_SESSIONS_TABLE}" WHERE id = ?`).get('legacy-node')
    expect(run).toEqual({ requested_timeout_ms: null, deadline_at: null })
    expect(node).toEqual({ remaining_timeout_ms_at_start: null })
  })

  it('handles single-column primary key tables correctly', async () => {
    const { initAllHermesTables, GC_ROOM_AGENTS_TABLE } =
      await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')

    expect(() => initAllHermesTables()).not.toThrow()

    // Verify table has primary key and required columns
    const tableInfo = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(GC_ROOM_AGENTS_TABLE) as { sql: string }
    expect(tableInfo.sql).toContain('PRIMARY KEY')
    expect(tableInfo.sql).toContain('id')
    expect(tableInfo.sql).toContain('roomId')
    expect(tableInfo.sql).toContain('agentId')

    // Verify we can insert multiple entries with unique id
    db.prepare(`INSERT INTO "${GC_ROOM_AGENTS_TABLE}" (id, roomId, agentId, profile, name, description, invited) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('agent-1', 'room-1', 'agent-1', 'default', 'Agent 1', '', 0)
    db.prepare(`INSERT INTO "${GC_ROOM_AGENTS_TABLE}" (id, roomId, agentId, profile, name, description, invited) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('agent-2', 'room-1', 'agent-2', 'default', 'Agent 2', '', 0)

    const count = db.prepare(`SELECT COUNT(*) as count FROM "${GC_ROOM_AGENTS_TABLE}"`).get() as { count: number }
    expect(count.count).toBe(2)

    // Verify duplicate primary key is rejected
    expect(() => {
      db.prepare(`INSERT INTO "${GC_ROOM_AGENTS_TABLE}" (id, roomId, agentId, profile, name, description, invited) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run('agent-1', 'room-1', 'agent-1', 'default', 'Agent 1 Duplicate', '', 0)
    }).toThrow()
  })
})
