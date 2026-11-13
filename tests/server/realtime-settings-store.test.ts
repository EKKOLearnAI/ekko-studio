import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('realtime profile settings schema', () => {
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

  async function initStore() {
    const schemas = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    schemas.initAllHermesTables()
    return {
      schemas,
      store: await import('../../packages/server/src/modules/studio/repositories/realtime-settings-store'),
    }
  }

  it('creates the realtime_profile_settings table during store init', async () => {
    const { schemas } = await initStore()

    const tableNames = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
      .map((row: any) => row.name)
    expect(tableNames).toContain(schemas.REALTIME_PROFILE_SETTINGS_TABLE)

    const columns = db.prepare(`PRAGMA table_info(${schemas.REALTIME_PROFILE_SETTINGS_TABLE})`).all()
      .map((row: any) => row.name)
    expect(columns).toEqual(expect.arrayContaining([
      'profile',
      'settings_json',
      'secrets_json',
      'created_at',
      'updated_at',
    ]))
  })

  it('stores settings and masks secrets on read', async () => {
    const { store } = await initStore()

    const saved = store.saveRealtimeModelSetting('default', {
      settings: { model: 'qwen3.8-omni-flash-realtime', voice: 'Tina' },
      secrets: { apiKey: 'sk-secret-value' },
    })

    expect(saved).toMatchObject({
      profile: 'default',
      settings: { model: 'qwen3.8-omni-flash-realtime', voice: 'Tina' },
      secrets: { apiKey: '[stored]' },
    })
    expect(JSON.stringify(saved)).not.toContain('sk-secret-value')

    const fetched = store.getRealtimeModelSetting('default')
    expect(fetched).toEqual(saved)
    expect(JSON.stringify(fetched)).not.toContain('sk-secret-value')
  })

  it('returns raw secrets only for owner paths that opt in', async () => {
    const { store } = await initStore()

    store.saveRealtimeModelSetting('default', {
      settings: { model: 'qwen3-omni-flash-realtime', voice: 'Ethan' },
      secrets: { apiKey: 'sk-secret-value' },
    })

    expect(store.getRealtimeModelSetting('default', { includeSecrets: true })).toMatchObject({
      profile: 'default',
      settings: { model: 'qwen3-omni-flash-realtime', voice: 'Ethan' },
      secrets: { apiKey: 'sk-secret-value' },
    })
  })

  it('keeps rows isolated per profile', async () => {
    const { store } = await initStore()

    store.saveRealtimeModelSetting('default', {
      settings: { model: 'qwen3.8-omni-flash-realtime', voice: 'Tina' },
      secrets: { apiKey: 'sk-default' },
    })
    store.saveRealtimeModelSetting('english', {
      settings: { model: 'qwen3-omni-flash-realtime', voice: 'Serena' },
      secrets: { apiKey: 'sk-english' },
    })

    expect(store.getRealtimeModelSetting('default', { includeSecrets: true })).toMatchObject({
      settings: { model: 'qwen3.8-omni-flash-realtime', voice: 'Tina' },
      secrets: { apiKey: 'sk-default' },
    })
    expect(store.getRealtimeModelSetting('english', { includeSecrets: true })).toMatchObject({
      settings: { model: 'qwen3-omni-flash-realtime', voice: 'Serena' },
      secrets: { apiKey: 'sk-english' },
    })
  })

  it('updates settings in place and clears the api key when sent empty', async () => {
    const { store } = await initStore()

    store.saveRealtimeModelSetting('default', {
      settings: { model: 'qwen3.8-omni-flash-realtime', voice: 'Tina' },
      secrets: { apiKey: 'sk-secret-value' },
    })

    store.saveRealtimeModelSetting('default', {
      settings: { model: 'qwen3.8-omni-plus-realtime', voice: 'Ryan' },
      secrets: { apiKey: '' },
    })

    const fetched = store.getRealtimeModelSetting('default', { includeSecrets: true })
    expect(fetched).toMatchObject({
      settings: { model: 'qwen3.8-omni-plus-realtime', voice: 'Ryan' },
      secrets: {},
    })
  })

  it('keeps the stored key when the masked [stored] marker is sent back', async () => {
    const { store } = await initStore()

    store.saveRealtimeModelSetting('default', {
      settings: { model: 'qwen3.8-omni-flash-realtime', voice: 'Tina' },
      secrets: { apiKey: 'sk-secret-value' },
    })

    store.saveRealtimeModelSetting('default', {
      settings: { model: 'qwen3.8-omni-flash-realtime', voice: 'Ethan' },
      secrets: { apiKey: '[stored]' },
    })

    expect(store.getRealtimeModelSetting('default', { includeSecrets: true })).toMatchObject({
      settings: { model: 'qwen3.8-omni-flash-realtime', voice: 'Ethan' },
      secrets: { apiKey: 'sk-secret-value' },
    })
  })

  it('deletes the row', async () => {
    const { store } = await initStore()

    store.saveRealtimeModelSetting('default', {
      settings: { model: 'qwen3.8-omni-flash-realtime', voice: 'Tina' },
      secrets: { apiKey: 'sk-secret-value' },
    })

    expect(store.deleteRealtimeModelSetting('default')).toBe(true)
    expect(store.getRealtimeModelSetting('default')).toBeNull()
    expect(store.deleteRealtimeModelSetting('default')).toBe(false)
  })

  it('normalizes the empty profile name to default', async () => {
    const { store } = await initStore()

    store.saveRealtimeModelSetting('', {
      settings: { model: 'qwen3.8-omni-flash-realtime', voice: 'Tina' },
      secrets: { apiKey: 'sk-secret-value' },
    })

    expect(store.getRealtimeModelSetting('default', { includeSecrets: true })).toMatchObject({
      profile: 'default',
      secrets: { apiKey: 'sk-secret-value' },
    })
  })

  // -------------------------------------------------------------------------
  // MiniMax provider — settings + secrets are stored alongside the DashScope
  // ones. Independent updates to one provider must not wipe the other.
  // -------------------------------------------------------------------------
  it('stores the MiniMax ASR provider fields alongside the DashScope key', async () => {
    const { store } = await initStore()

    store.saveRealtimeModelSetting('default', {
      settings: {
        model: 'qwen3.8-omni-flash-realtime',
        voice: 'Tina',
        asrProvider: 'minimax',
        minimaxAsrModel: 'asr-1.0',
        minimaxBaseUrl: 'https://api.minimaxi.com',
      },
      secrets: {
        apiKey: 'sk-dashscope',
        minimaxApiKey: 'minimax-secret',
      },
    })

    const fetched = store.getRealtimeModelSetting('default', { includeSecrets: true })
    expect(fetched).toMatchObject({
      settings: {
        model: 'qwen3.8-omni-flash-realtime',
        voice: 'Tina',
        asrProvider: 'minimax',
        minimaxAsrModel: 'asr-1.0',
        minimaxBaseUrl: 'https://api.minimaxi.com',
      },
      secrets: {
        apiKey: 'sk-dashscope',
        minimaxApiKey: 'minimax-secret',
      },
    })
  })

  it('masks MiniMax secrets on default read but exposes them on opt-in', async () => {
    const { store } = await initStore()

    store.saveRealtimeModelSetting('default', {
      settings: { asrProvider: 'minimax' },
      secrets: { apiKey: 'sk-dashscope', minimaxApiKey: 'minimax-secret' },
    })

    const masked = store.getRealtimeModelSetting('default')
    expect(masked).toMatchObject({
      secrets: { apiKey: '[stored]', minimaxApiKey: '[stored]' },
    })
    expect(JSON.stringify(masked)).not.toContain('minimax-secret')

    const raw = store.getRealtimeModelSetting('default', { includeSecrets: true })
    expect(raw).toMatchObject({
      secrets: { apiKey: 'sk-dashscope', minimaxApiKey: 'minimax-secret' },
    })
  })

  it('keeps the DashScope key when only the MiniMax key is updated', async () => {
    const { store } = await initStore()

    store.saveRealtimeModelSetting('default', {
      settings: { asrProvider: 'minimax' },
      secrets: { apiKey: 'sk-dashscope', minimaxApiKey: 'minimax-old' },
    })

    store.saveRealtimeModelSetting('default', {
      settings: { asrProvider: 'minimax' },
      secrets: { minimaxApiKey: 'minimax-new' },
    })

    expect(store.getRealtimeModelSetting('default', { includeSecrets: true })).toMatchObject({
      secrets: { apiKey: 'sk-dashscope', minimaxApiKey: 'minimax-new' },
    })
  })

  it('rejects http MiniMax base URLs (defence-in-depth)', async () => {
    const { store } = await initStore()

    store.saveRealtimeModelSetting('default', {
      settings: { minimaxBaseUrl: 'http://api.minimaxi.com' },
      secrets: {},
    })

    const fetched = store.getRealtimeModelSetting('default', { includeSecrets: true })
    expect(fetched?.settings.minimaxBaseUrl).toBeUndefined()
  })

  it('rejects unknown ASR provider values', async () => {
    const { store } = await initStore()

    store.saveRealtimeModelSetting('default', {
      settings: { asrProvider: 'unknown-provider' },
      secrets: {},
    })

    const fetched = store.getRealtimeModelSetting('default', { includeSecrets: true })
    // Unknown provider is dropped by the sanitizer; the asrProvider key is
    // absent from the resulting settings object instead of carrying `undefined`.
    expect(fetched?.settings).not.toHaveProperty('asrProvider')
  })
})
