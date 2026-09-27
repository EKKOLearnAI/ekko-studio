import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('session category store', () => {
  let db: any = null

  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
      isSqliteAvailable: () => true,
    }))
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
  })

  afterEach(() => {
    db?.close()
    db = null
    vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
    vi.resetModules()
  })

  it('creates normalized global categories without case-insensitive duplicates', async () => {
    const { createSessionCategory, listSessionCategories } = await import(
      '../../packages/server/src/modules/studio/repositories/session-category-store'
    )

    const created = createSessionCategory('  Client   Work  ')
    const existing = createSessionCategory('client work')

    expect(created.name).toBe('Client Work')
    expect(existing.id).toBe(created.id)
    expect(listSessionCategories()).toEqual([created])
  })

  it('stores one nullable category id directly on a session', async () => {
    const { createSessionCategory, deleteSessionCategory, renameSessionCategory, setSessionCategory } = await import(
      '../../packages/server/src/modules/studio/repositories/session-category-store'
    )
    const { createSession, getSession } = await import('../../packages/server/src/modules/studio/repositories/session-store')
    const category = createSessionCategory('Work')
    createSession({ id: 'session-1', profile: 'profile-a', category_id: category.id })
    createSession({ id: 'session-2', profile: 'profile-b', category_id: category.id })

    expect(getSession('session-1')?.category_id).toBe(category.id)
    expect(getSession('session-2')?.category_id).toBe(category.id)
    expect(setSessionCategory('session-1', null)).toBe(true)
    expect(getSession('session-1')?.category_id).toBeNull()
    expect(setSessionCategory('session-1', 999)).toBe(false)

    const renamed = renameSessionCategory(category.id, 'Client Work')
    expect(renamed?.name).toBe('Client Work')
    expect(setSessionCategory('session-1', category.id)).toBe(true)
    expect(deleteSessionCategory(category.id)).toBe(true)
    expect(getSession('session-1')?.category_id).toBeNull()
  })

  it('stores, replaces and clears a shared preset without letting create-or-return overwrite it', async () => {
    const {
      createSessionCategory,
      getSessionCategory,
      insertSessionCategory,
      listSessionCategories,
      setSessionCategoryPreset,
    } = await import('../../packages/server/src/modules/studio/repositories/session-category-store')

    const created = insertSessionCategory('AI Passport', { agent: 'claude-code', model: 'claude-opus-5-5', workspace: '/p/a' })
    expect(created.preset).toEqual({ agent: 'claude-code', model: 'claude-opus-5-5', workspace: '/p/a' })

    // Typing an existing name in the New Chat panel returns the category and keeps its preset.
    const again = createSessionCategory('ai passport')
    expect(again.id).toBe(created.id)
    expect(again.preset).toEqual(created.preset)

    const updated = setSessionCategoryPreset(created.id, { model: 'claude-sonnet-5' })
    expect(updated?.preset).toEqual({ model: 'claude-sonnet-5' })
    expect(listSessionCategories()[0].preset).toEqual({ model: 'claude-sonnet-5' })

    expect(setSessionCategoryPreset(created.id, null)?.preset).toBeNull()
    expect(getSessionCategory(created.id)?.preset).toBeNull()
    expect(setSessionCategoryPreset(999, { model: 'x' })).toBeNull()
  })

  it('lets the unique index reject a duplicate strict create instead of returning the other category', async () => {
    const { SessionCategoryNameConflictError, insertSessionCategory, listSessionCategories } = await import(
      '../../packages/server/src/modules/studio/repositories/session-category-store'
    )
    // Two "+ New Category" saves racing for the same name: the first wins, the second gets a conflict.
    const first = insertSessionCategory('Client Work', { model: 'a' })
    let conflict: unknown
    try {
      insertSessionCategory('client   WORK', { model: 'b' })
    } catch (error) {
      conflict = error
    }
    expect(conflict).toBeInstanceOf(SessionCategoryNameConflictError)
    expect((conflict as any).status).toBe(409)
    expect(listSessionCategories().map(row => [row.id, row.name, row.preset])).toEqual([[first.id, 'Client Work', { model: 'a' }]])
  })

  it('folds only ASCII case in names (SQLite NOCASE), which the client duplicate check mirrors', async () => {
    const { SessionCategoryNameConflictError, insertSessionCategory } = await import(
      '../../packages/server/src/modules/studio/repositories/session-category-store'
    )
    insertSessionCategory('Été', null)
    expect(insertSessionCategory('été', null).name).toBe('été')
    expect(() => insertSessionCategory('ÉTÉ', null)).not.toThrow()
    expect(() => insertSessionCategory('éTé', null)).toThrow(SessionCategoryNameConflictError)
  })

  it('deletes the preset with its category and never exposes a raw API key column', async () => {
    const { deleteSessionCategory, findSessionCategoryByName, insertSessionCategory } = await import(
      '../../packages/server/src/modules/studio/repositories/session-category-store'
    )
    const category = insertSessionCategory('Personal', { agent: 'hermes', model: 'm' })
    expect(deleteSessionCategory(category.id)).toBe(true)
    expect(findSessionCategoryByName('Personal')).toBeNull()
    expect(db.prepare('SELECT COUNT(*) AS count FROM session_categories').get().count).toBe(0)
    const columns = db.prepare('PRAGMA table_info(session_categories)').all().map((col: any) => col.name)
    expect(columns).toEqual(['id', 'name', 'preset', 'created_at', 'updated_at'])
  })

  it('reads stored presets leniently: drops only unknown, credential or invalid fields', async () => {
    const { createSessionCategory, listSessionCategories } = await import(
      '../../packages/server/src/modules/studio/repositories/session-category-store'
    )
    const category = createSessionCategory('Broken')
    db.prepare('UPDATE session_categories SET preset = ? WHERE id = ?').run('{not json', category.id)
    const insert = db.prepare('INSERT INTO session_categories (name, preset, created_at, updated_at) VALUES (?, ?, 1, 1)')
    insert.run('Leaked', JSON.stringify({ model: 'm', apiKey: 'sk-secret' }))
    insert.run('Mixed', JSON.stringify({
      agent: 'claude-code',
      model: 'claude-opus-5-5',
      apiMode: 'soap',
      reasoningEffort: 'high',
      futureField: { nested: true },
      workspace: '/work/app',
    }))
    insert.run('Combo', JSON.stringify({ agent: 'codex', modelKind: 'moa', agentPreset: 'planner', provider: 'openai' }))
    insert.run('Relative', JSON.stringify({ workspace: 'relative/dir', model: 'm' }))
    insert.run('UrlSecret', JSON.stringify({ agent: 'claude-code', baseUrl: 'https://u:p@gw.test/v1', model: 'm' }))
    const rows = Object.fromEntries(listSessionCategories().map(row => [row.name, row.preset]))
    expect(rows).toEqual({
      Broken: null,
      Combo: { agent: 'codex', provider: 'openai' },
      Leaked: { model: 'm' },
      Mixed: { agent: 'claude-code', model: 'claude-opus-5-5', workspace: '/work/app' },
      // Relative workspaces are kept as entered, like the New Chat panel.
      Relative: { model: 'm', workspace: 'relative/dir' },
      UrlSecret: { agent: 'claude-code', model: 'm' },
    })
  })
})

describe('session category preset migration', () => {
  it('adds the preset column to an existing categories table without losing rows', async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    const legacyDb = new DatabaseSync(':memory:')
    legacyDb.exec(`CREATE TABLE session_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL COLLATE NOCASE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`)
    legacyDb.prepare('INSERT INTO session_categories (name, created_at, updated_at) VALUES (?, 1, 1)').run('Old')
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      getDb: () => legacyDb,
      getStoragePath: () => ':memory:',
      isSqliteAvailable: () => true,
    }))
    try {
      const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
      initAllHermesTables()
      const { listSessionCategories } = await import('../../packages/server/src/modules/studio/repositories/session-category-store')
      expect(listSessionCategories()).toEqual([expect.objectContaining({ name: 'Old', preset: null })])
    } finally {
      legacyDb.close()
      vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
      vi.resetModules()
    }
  })
})
