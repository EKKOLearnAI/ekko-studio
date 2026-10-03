import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../packages/server/src/modules/studio/services/voice/config-sync', () => ({
  syncVoiceConfigToHermesProfile: vi.fn(async () => ({ stt: 'unchanged', tts: 'synced' })),
}))

function createMockCtx(body: Record<string, any> = {}) {
  const headers: Record<string, string> = {}
  let requestAbortHandler: (() => void) | undefined
  let responseCloseHandler: (() => void) | undefined

  const ctx: any = {
    request: { body },
    req: {
      on: vi.fn((event: string, handler: () => void) => {
        if (event === 'aborted') {
          requestAbortHandler = handler
        }
      }),
    },
    res: {
      writableEnded: false,
      on: vi.fn((event: string, handler: () => void) => {
        if (event === 'close') {
          responseCloseHandler = handler
        }
      }),
    },
    status: 200,
    body: undefined,
    set: vi.fn((name: string, value: string) => {
      headers[name] = value
    }),
  }

  return {
    ctx,
    headers,
    emitRequestAborted() {
      requestAbortHandler?.()
    },
    emitResponseClose({ writableEnded = false } = {}) {
      ctx.res.writableEnded = writableEnded
      responseCloseHandler?.()
    },
  }
}

describe('getTtsProvider', () => {
  it('returns expected providers and undefined for unknown ids', async () => {
    const { getTtsProvider } = await import('../../packages/server/src/modules/studio/services/voice/tts/providers')
    const { edgeTtsProvider } = await import('../../packages/server/src/modules/studio/services/voice/tts/providers/edge')
    const { customTtsProvider, openaiTtsProvider } = await import('../../packages/server/src/modules/studio/services/voice/tts/providers/openai')
    const { mimoTtsProvider } = await import('../../packages/server/src/modules/studio/services/voice/tts/providers/mimo')
    const { doubaoTtsProvider } = await import('../../packages/server/src/modules/studio/services/voice/tts/providers/doubao')

    expect(getTtsProvider('edge')).toBe(edgeTtsProvider)
    expect(getTtsProvider('openai')).toBe(openaiTtsProvider)
    expect(getTtsProvider('custom')).toBe(customTtsProvider)
    expect(getTtsProvider('mimo')).toBe(mimoTtsProvider)
    expect(getTtsProvider('doubao')).toBe(doubaoTtsProvider)
    expect(getTtsProvider('unknown')).toBeUndefined()
  })
})

describe('tts synthesize controller', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.doUnmock('../../packages/server/src/modules/studio/services/voice/tts/providers')
    vi.doUnmock('../../packages/server/src/modules/studio/controllers/tts')
    vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
  })

  it('returns 400 for an unknown provider', async () => {
    const getTtsProvider = vi.fn(() => undefined)
    vi.doMock('../../packages/server/src/modules/studio/services/voice/tts/providers', () => ({
      getTtsProvider,
    }))

    const ctrl = await import('../../packages/server/src/modules/studio/controllers/tts')
    const { ctx } = createMockCtx({ provider: 'nope', text: 'hello' })

    await ctrl.synthesize(ctx)

    expect(getTtsProvider).toHaveBeenCalledWith('nope')
    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({ error: 'unknown TTS provider' })
  })

  it('saves TTS settings when the legacy provider table has no unique index', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
    }))

    try {
      const schemas = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
      schemas.initAllHermesTables()
      db.exec('DROP INDEX IF EXISTS idx_tts_provider_settings_user_provider')
      db.exec('DROP TABLE tts_provider_settings')
      db.exec(`
        CREATE TABLE tts_provider_settings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile TEXT NOT NULL DEFAULT 'default',
          provider TEXT NOT NULL,
          settings_json TEXT NOT NULL DEFAULT '{}',
          secrets_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `)
      db.exec('DROP TABLE tts_user_settings')
      db.exec(`
        CREATE TABLE tts_user_settings (
          profile TEXT PRIMARY KEY DEFAULT 'default',
          active_provider TEXT NOT NULL DEFAULT 'edge',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `)

      const ctrl = await import('../../packages/server/src/modules/studio/controllers/tts')
      const { ctx } = createMockCtx({
        settings: {
          model: 'tts-1',
          voice: 'alloy',
        },
        secrets: {
          apiKey: 'server-secret',
        },
      })
      ctx.state = { user: { id: 7 } }
      ctx.params = { provider: 'openai' }
      ctx.query = {}
      ctx.get = vi.fn(() => '')

      await ctrl.saveSettings(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body.setting).toMatchObject({
        provider: 'openai',
        settings: {
          model: 'tts-1',
          voice: 'alloy',
        },
        secrets: {
          apiKey: '[stored]',
        },
      })

      const profileRow = db.prepare(
        'SELECT settings_json, secrets_json FROM tts_profile_provider_settings WHERE profile = ? AND provider = ?'
      ).get('default', 'openai') as { settings_json: string; secrets_json: string }
      expect(JSON.parse(profileRow.settings_json)).toMatchObject({ model: 'tts-1', voice: 'alloy' })
      expect(JSON.parse(profileRow.secrets_json)).toEqual({ apiKey: 'server-secret' })
    } finally {
      db.close()
      vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
    }
  })

  it('deletes a stored TTS provider row and falls back to Edge when it was active', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
    }))

    try {
      const schemas = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
      schemas.initAllHermesTables()
      const ctrl = await import('../../packages/server/src/modules/studio/controllers/tts')
      const { ctx: saveCtx } = createMockCtx({
        settings: { model: 'tts-1', voice: 'alloy' },
        secrets: { apiKey: 'server-secret' },
      })
      saveCtx.state = { user: { id: 7 } }
      saveCtx.params = { provider: 'openai' }
      saveCtx.query = {}
      saveCtx.get = vi.fn(() => '')
      await ctrl.saveSettings(saveCtx)

      const { ctx: deleteCtx } = createMockCtx()
      deleteCtx.state = { user: { id: 7 } }
      deleteCtx.params = { provider: 'openai' }
      deleteCtx.query = {}
      deleteCtx.get = vi.fn(() => '')
      await ctrl.deleteProvider(deleteCtx)

      expect(deleteCtx.status).toBe(200)
      expect(deleteCtx.body).toEqual({
        success: true,
        deleted: true,
        activeProvider: 'edge',
      })
      expect(db.prepare(
        'SELECT COUNT(*) AS count FROM tts_profile_provider_settings WHERE profile = ? AND provider = ?'
      ).get('default', 'openai').count).toBe(0)
      const activeRow = db.prepare('SELECT active_provider FROM tts_profile_settings WHERE profile = ?').get('default') as { active_provider: string }
      expect(activeRow.active_provider).toBe('edge')
    } finally {
      db.close()
      vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
    }
  })

  it('rejects deleting the built-in Edge TTS provider', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
    }))

    try {
      const schemas = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
      schemas.initAllHermesTables()
      const ctrl = await import('../../packages/server/src/modules/studio/controllers/tts')
      const { ctx } = createMockCtx()
      ctx.state = { user: { id: 7 } }
      ctx.params = { provider: 'edge' }
      ctx.query = {}
      ctx.get = vi.fn(() => '')

      await ctrl.deleteProvider(ctx)

      expect(ctx.status).toBe(400)
      expect(ctx.body).toEqual({ error: 'built-in TTS provider cannot be deleted' })
    } finally {
      db.close()
      vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
    }
  })

  it('preserves numeric Edge TTS rate and pitch settings on save', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
    }))

    try {
      const schemas = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
      schemas.initAllHermesTables()

      const ctrl = await import('../../packages/server/src/modules/studio/controllers/tts')
      const { ctx } = createMockCtx({
        settings: {
          voice: 'zh-CN-YunxiNeural',
          rate: 1.35,
          pitch: -6,
        },
      })
      ctx.state = { user: { id: 7 } }
      ctx.params = { provider: 'edge' }
      ctx.query = {}
      ctx.get = vi.fn(() => '')

      await ctrl.saveSettings(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body.setting).toMatchObject({
        provider: 'edge',
        settings: {
          voice: 'zh-CN-YunxiNeural',
          rate: '1.35',
          pitch: '-6',
        },
      })

      const listCtx = createMockCtx().ctx
      listCtx.state = { user: { id: 7 } }
      listCtx.query = {}
      listCtx.get = vi.fn(() => '')

      await ctrl.listSettings(listCtx)
      expect(listCtx.body.settings).toEqual([
        expect.objectContaining({
          provider: 'edge',
          settings: expect.objectContaining({
            rate: '1.35',
            pitch: '-6',
          }),
        }),
      ])
    } finally {
      db.close()
      vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
    }
  })

  it('repairs preexisting profile TTS tables before saving settings', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
    }))

    try {
      db.exec(`
        CREATE TABLE tts_profile_provider_settings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile TEXT NOT NULL DEFAULT 'default',
          provider TEXT NOT NULL,
          settings_json TEXT NOT NULL DEFAULT '{}',
          secrets_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `)
      db.exec(`
        CREATE TABLE tts_profile_settings (
          profile TEXT NOT NULL DEFAULT 'default',
          active_provider TEXT NOT NULL DEFAULT 'edge',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `)
      db.prepare(
        'INSERT INTO tts_profile_provider_settings (profile, provider, settings_json, secrets_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('default', 'edge', '{"voice":"old"}', '{}', 1, 1)
      db.prepare(
        'INSERT INTO tts_profile_provider_settings (profile, provider, settings_json, secrets_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('default', 'edge', '{"voice":"newer"}', '{}', 2, 2)
      db.prepare(
        'INSERT INTO tts_profile_settings (profile, active_provider, created_at, updated_at) VALUES (?, ?, ?, ?)'
      ).run('default', 'edge', 1, 1)
      db.prepare(
        'INSERT INTO tts_profile_settings (profile, active_provider, created_at, updated_at) VALUES (?, ?, ?, ?)'
      ).run('default', 'openai', 2, 2)

      const schemas = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
      schemas.initAllHermesTables()

      const ctrl = await import('../../packages/server/src/modules/studio/controllers/tts')
      const { ctx } = createMockCtx({
        settings: { voice: 'zh-CN-XiaoxiaoNeural' },
      })
      ctx.state = { user: { id: 7 } }
      ctx.params = { provider: 'edge' }
      ctx.query = {}
      ctx.get = vi.fn(() => '')

      await ctrl.saveSettings(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body.setting.settings.voice).toBe('zh-CN-XiaoxiaoNeural')
      expect(db.prepare('SELECT COUNT(*) AS count FROM tts_profile_provider_settings WHERE profile = ? AND provider = ?').get('default', 'edge').count).toBe(1)
      expect(db.prepare('SELECT COUNT(*) AS count FROM tts_profile_settings WHERE profile = ?').get('default').count).toBe(1)
    } finally {
      db.close()
      vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
    }
  })

  it('uses the active TTS provider when request provider is omitted', async () => {
    const audio = Buffer.from('active-audio')
    const provider = {
      synthesize: vi.fn().mockResolvedValue({
        audio,
        contentType: 'audio/mpeg',
        engine: 'doubao',
        provider: 'doubao',
      }),
    }
    const getTtsProvider = vi.fn(() => provider)
    const getActiveTtsProvider = vi.fn(() => 'doubao')
    const getTtsProviderSetting = vi.fn(() => null)
    vi.doMock('../../packages/server/src/modules/studio/services/voice/tts/providers', () => ({
      getTtsProvider,
    }))
    vi.doMock('../../packages/server/src/modules/studio/repositories/tts-settings-store', async (importOriginal) => ({
      ...await importOriginal<typeof import('../../packages/server/src/modules/studio/repositories/tts-settings-store')>(),
      getActiveTtsProvider,
      getTtsProviderSetting,
    }))

    const ctrl = await import('../../packages/server/src/modules/studio/controllers/tts')
    const { ctx } = createMockCtx({ text: 'hello' })
    ctx.state = { user: { id: 7 } }

    await ctrl.synthesize(ctx)

    expect(getActiveTtsProvider).toHaveBeenCalledWith('default')
    expect(getTtsProvider).toHaveBeenCalledWith('doubao')
    expect(provider.synthesize).toHaveBeenCalledWith(
      { text: 'hello', signal: expect.any(AbortSignal) },
      {},
    )
  })

  it('falls back to Edge TTS when request and active providers are missing', async () => {
    const audio = Buffer.from('edge-audio')
    const provider = {
      synthesize: vi.fn().mockResolvedValue({
        audio,
        contentType: 'audio/mpeg',
        engine: 'edge',
        provider: 'edge',
      }),
    }
    const getTtsProvider = vi.fn(() => provider)
    const getActiveTtsProvider = vi.fn(() => null)
    const getTtsProviderSetting = vi.fn(() => null)
    const listTtsProviderSettings = vi.fn(() => [])
    vi.doMock('../../packages/server/src/modules/studio/services/voice/tts/providers', () => ({
      getTtsProvider,
    }))
    vi.doMock('../../packages/server/src/modules/studio/repositories/tts-settings-store', async (importOriginal) => ({
      ...await importOriginal<typeof import('../../packages/server/src/modules/studio/repositories/tts-settings-store')>(),
      getActiveTtsProvider,
      getTtsProviderSetting,
      listTtsProviderSettings,
    }))

    const ctrl = await import('../../packages/server/src/modules/studio/controllers/tts')
    const { ctx } = createMockCtx({ text: 'hello' })
    ctx.state = { user: { id: 7 } }

    await ctrl.synthesize(ctx)

    expect(getActiveTtsProvider).toHaveBeenCalledWith('default')
    expect(listTtsProviderSettings).toHaveBeenCalledWith('default')
    expect(getTtsProvider).toHaveBeenCalledWith('edge')
    expect(provider.synthesize).toHaveBeenCalledWith(
      { text: 'hello', signal: expect.any(AbortSignal) },
      {},
    )
  })

  it('returns 400 for missing or blank text', async () => {
    const provider = { synthesize: vi.fn() }
    const getTtsProvider = vi.fn(() => provider)
    vi.doMock('../../packages/server/src/modules/studio/services/voice/tts/providers', () => ({
      getTtsProvider,
    }))

    const ctrl = await import('../../packages/server/src/modules/studio/controllers/tts')
    const { ctx } = createMockCtx({ provider: 'mimo', text: '   ' })

    await ctrl.synthesize(ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({ error: 'text is required' })
    expect(provider.synthesize).not.toHaveBeenCalled()
  })

  it('returns 400 when options is not an object', async () => {
    const provider = { synthesize: vi.fn() }
    const getTtsProvider = vi.fn(() => provider)
    vi.doMock('../../packages/server/src/modules/studio/services/voice/tts/providers', () => ({
      getTtsProvider,
    }))

    const ctrl = await import('../../packages/server/src/modules/studio/controllers/tts')

    for (const options of ['voice=verse', null, ['verse']]) {
      const { ctx } = createMockCtx({ provider: 'mimo', text: 'hello', options })

      await ctrl.synthesize(ctx)

      expect(ctx.status).toBe(400)
      expect(ctx.body).toEqual({ error: 'options must be an object' })
    }

    expect(provider.synthesize).not.toHaveBeenCalled()
  })

  it('calls the provider, returns audio headers, and writes the audio buffer body', async () => {
    const audio = Buffer.from('mimo-audio')
    const provider = {
      synthesize: vi.fn().mockResolvedValue({
        audio,
        contentType: 'audio/wav',
        engine: 'mimo',
        provider: 'mimo',
      }),
    }
    const getTtsProvider = vi.fn(() => provider)
    vi.doMock('../../packages/server/src/modules/studio/services/voice/tts/providers', () => ({
      getTtsProvider,
    }))

    const ctrl = await import('../../packages/server/src/modules/studio/controllers/tts')
    const { ctx, headers } = createMockCtx({
      provider: 'mimo',
      text: 'Hello world',
      options: { voice: 'verse' },
    })

    await ctrl.synthesize(ctx)

    expect(provider.synthesize).toHaveBeenCalledTimes(1)
    expect(provider.synthesize).toHaveBeenCalledWith(
      {
        text: 'Hello world',
        signal: expect.any(AbortSignal),
      },
      { voice: 'verse' },
    )
    expect(headers).toEqual({
      'Content-Type': 'audio/wav',
      'Content-Length': String(audio.length),
      'X-TTS-Engine': 'mimo',
      'X-TTS-Provider': 'mimo',
    })
    expect(ctx.body).toBe(audio)
  })

  it('keeps request API keys when no stored TTS setting exists', async () => {
    const audio = Buffer.from('openai-audio')
    const provider = {
      synthesize: vi.fn().mockResolvedValue({
        audio,
        contentType: 'audio/mpeg',
        engine: 'openai',
        provider: 'openai',
      }),
    }
    const getTtsProvider = vi.fn(() => provider)
    const getTtsProviderSetting = vi.fn(() => null)
    vi.doMock('../../packages/server/src/modules/studio/services/voice/tts/providers', () => ({
      getTtsProvider,
    }))
    vi.doMock('../../packages/server/src/modules/studio/repositories/tts-settings-store', async (importOriginal) => ({
      ...await importOriginal<typeof import('../../packages/server/src/modules/studio/repositories/tts-settings-store')>(),
      getTtsProviderSetting,
    }))

    const ctrl = await import('../../packages/server/src/modules/studio/controllers/tts')
    const { ctx } = createMockCtx({
      provider: 'openai',
      text: 'Hello world',
      options: {
        baseUrl: 'https://api.openai.com/v1/audio/speech',
        apiKey: 'request-secret',
        model: 'tts-1',
        voice: 'alloy',
      },
    })
    ctx.state = { user: { id: 7 } }

    await ctrl.synthesize(ctx)

    expect(getTtsProviderSetting).toHaveBeenCalledWith('default', 'openai', { includeSecrets: true })
    expect(provider.synthesize).toHaveBeenCalledWith(
      { text: 'Hello world', signal: expect.any(AbortSignal) },
      {
        baseUrl: 'https://api.openai.com/v1/audio/speech',
        apiKey: 'request-secret',
        model: 'tts-1',
        voice: 'alloy',
      },
    )
  })

  it('uses request API keys only when the stored TTS setting has no secret', async () => {
    const audio = Buffer.from('openai-audio')
    const provider = {
      synthesize: vi.fn().mockResolvedValue({
        audio,
        contentType: 'audio/mpeg',
        engine: 'openai',
        provider: 'openai',
      }),
    }
    const getTtsProvider = vi.fn(() => provider)
    const getTtsProviderSetting = vi.fn(() => ({
      provider: 'openai',
      label: 'OpenAI TTS',
      settings: {
        baseUrl: 'https://stored.example.test/v1/audio/speech',
        model: 'stored-model',
      },
      secrets: {},
    }))
    vi.doMock('../../packages/server/src/modules/studio/services/voice/tts/providers', () => ({
      getTtsProvider,
    }))
    vi.doMock('../../packages/server/src/modules/studio/repositories/tts-settings-store', async (importOriginal) => ({
      ...await importOriginal<typeof import('../../packages/server/src/modules/studio/repositories/tts-settings-store')>(),
      getTtsProviderSetting,
    }))

    const ctrl = await import('../../packages/server/src/modules/studio/controllers/tts')
    const { ctx } = createMockCtx({
      provider: 'openai',
      text: 'Hello world',
      options: {
        apiKey: 'request-secret',
        voice: 'alloy',
      },
    })
    ctx.state = { user: { id: 7 } }

    await ctrl.synthesize(ctx)

    expect(provider.synthesize).toHaveBeenCalledWith(
      { text: 'Hello world', signal: expect.any(AbortSignal) },
      {
        baseUrl: 'https://stored.example.test/v1/audio/speech',
        model: 'stored-model',
        apiKey: 'request-secret',
        voice: 'alloy',
      },
    )
  })

  it('does not let request API keys replace a stored TTS secret', async () => {
    const audio = Buffer.from('openai-audio')
    const provider = {
      synthesize: vi.fn().mockResolvedValue({
        audio,
        contentType: 'audio/mpeg',
        engine: 'openai',
        provider: 'openai',
      }),
    }
    const getTtsProvider = vi.fn(() => provider)
    const getTtsProviderSetting = vi.fn(() => ({
      provider: 'openai',
      label: 'OpenAI TTS',
      settings: {
        baseUrl: 'https://stored.example.test/v1/audio/speech',
        model: 'stored-model',
      },
      secrets: {
        apiKey: 'stored-secret',
      },
    }))
    vi.doMock('../../packages/server/src/modules/studio/services/voice/tts/providers', () => ({
      getTtsProvider,
    }))
    vi.doMock('../../packages/server/src/modules/studio/repositories/tts-settings-store', async (importOriginal) => ({
      ...await importOriginal<typeof import('../../packages/server/src/modules/studio/repositories/tts-settings-store')>(),
      getTtsProviderSetting,
    }))

    const ctrl = await import('../../packages/server/src/modules/studio/controllers/tts')
    const { ctx } = createMockCtx({
      provider: 'openai',
      text: 'Hello world',
      options: {
        apiKey: 'request-secret',
        voice: 'alloy',
      },
    })
    ctx.state = { user: { id: 7 } }

    await ctrl.synthesize(ctx)

    expect(provider.synthesize).toHaveBeenCalledWith(
      { text: 'Hello world', signal: expect.any(AbortSignal) },
      {
        baseUrl: 'https://stored.example.test/v1/audio/speech',
        model: 'stored-model',
        apiKey: 'stored-secret',
        voice: 'alloy',
      },
    )
  })

  it('aborts the provider signal on client disconnect, but not on normal request close', async () => {
    const audio = Buffer.from('late-audio')
    let capturedSignal: AbortSignal | undefined
    let resolveSynthesize: (() => void) | undefined
    const provider = {
      synthesize: vi.fn().mockImplementation(async ({ signal }: { signal?: AbortSignal }) => {
        capturedSignal = signal
        await new Promise<void>((resolve) => {
          resolveSynthesize = resolve
        })
        return {
          audio,
          contentType: 'audio/mpeg',
          engine: 'mimo',
          provider: 'mimo',
        }
      }),
    }
    const getTtsProvider = vi.fn(() => provider)
    vi.doMock('../../packages/server/src/modules/studio/services/voice/tts/providers', () => ({
      getTtsProvider,
    }))

    const ctrl = await import('../../packages/server/src/modules/studio/controllers/tts')
    const { ctx, emitRequestAborted, emitResponseClose } = createMockCtx({ provider: 'mimo', text: 'Hello world' })

    const pending = ctrl.synthesize(ctx)

    expect(ctx.req.on).toHaveBeenCalledWith('aborted', expect.any(Function))
    expect(ctx.res.on).toHaveBeenCalledWith('close', expect.any(Function))
    expect(capturedSignal?.aborted).toBe(false)

    emitResponseClose({ writableEnded: true })
    expect(capturedSignal?.aborted).toBe(false)

    emitRequestAborted()
    expect(capturedSignal?.aborted).toBe(true)

    resolveSynthesize?.()
    await pending
  })

  it('returns 499 when the provider aborts', async () => {
    const abortError = Object.assign(new Error('client went away'), { name: 'AbortError' })
    const provider = {
      synthesize: vi.fn().mockRejectedValue(abortError),
    }
    const getTtsProvider = vi.fn(() => provider)
    vi.doMock('../../packages/server/src/modules/studio/services/voice/tts/providers', () => ({
      getTtsProvider,
    }))

    const ctrl = await import('../../packages/server/src/modules/studio/controllers/tts')
    const { ctx } = createMockCtx({ provider: 'mimo', text: 'Hello world' })

    await ctrl.synthesize(ctx)

    expect(ctx.status).toBe(499)
    expect(ctx.body).toEqual({ error: 'TTS request aborted' })
    expect(JSON.stringify(ctx.body)).not.toContain('client went away')
  })

  it('returns sanitized provider details when the provider fails', async () => {
    const provider = {
      synthesize: vi.fn().mockRejectedValue(new Error('MiMo TTS returned 401: apiKey=*** body')),
    }
    const getTtsProvider = vi.fn(() => provider)
    vi.doMock('../../packages/server/src/modules/studio/services/voice/tts/providers', () => ({
      getTtsProvider,
    }))

    const ctrl = await import('../../packages/server/src/modules/studio/controllers/tts')
    const { ctx } = createMockCtx({ provider: 'mimo', text: 'Hello world' })

    await ctrl.synthesize(ctx)

    expect(ctx.status).toBe(401)
    expect(ctx.body).toEqual({
      error: 'TTS synthesis failed',
      detail: 'MiMo TTS returned 401: apiKey=[redacted] body',
    })
    expect(JSON.stringify(ctx.body)).not.toContain('***')
  })

  it('probes OpenAI-compatible model endpoints, ranks models, and redacts errors', async () => {
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [
          { id: 'gpt-4o-mini' },
          { id: 'whisper-large-v3' },
          { id: 'tts-1-hd' },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'bad sk-test-secret-value key' } }), { status: 401, statusText: 'Unauthorized' }))
    globalThis.fetch = fetchMock as any

    try {
      const ctrl = await import('../../packages/server/src/modules/studio/controllers/tts')
      const { ctx } = createMockCtx({
        kind: 'tts',
        provider: 'custom',
        compatibility: 'openai-compatible',
        baseUrl: 'https://api.example.com/openai/v1/audio/speech/',
        apiKey: 'sk-test-secret-value',
      })
      ctx.state = { user: { id: 1 } }

      await ctrl.probeProvider(ctx)

      expect(fetchMock).toHaveBeenCalledWith('https://api.example.com/openai/v1/models', expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer sk-test-secret-value' }),
      }))
      expect(ctx.body.ok).toBe(true)
      expect(ctx.body.models[0].id).toBe('tts-1-hd')
      expect(ctx.body.recommendedModel).toBe('tts-1-hd')
      expect(ctx.body.normalizedBaseUrl).toBe('https://api.example.com/openai/v1/audio/speech')

      const failed = createMockCtx({
        kind: 'stt',
        provider: 'custom',
        compatibility: 'openai-compatible',
        baseUrl: 'https://api.example.com/openai/v1',
        apiKey: 'sk-test-secret-value',
      })
      failed.ctx.state = { user: { id: 1 } }
      await ctrl.probeProvider(failed.ctx)

      expect(failed.ctx.status).toBe(200)
      expect(failed.ctx.body.ok).toBe(false)
      expect(failed.ctx.body.errorSummary).toContain('Authentication failed')
      expect(JSON.stringify(failed.ctx.body)).not.toContain('sk-test-secret-value')
      expect(failed.ctx.body.manualModelAllowed).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('does not call upstream discovery for manual custom endpoint probes', async () => {
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as any

    try {
      const ctrl = await import('../../packages/server/src/modules/studio/controllers/tts')
      const { ctx } = createMockCtx({
        kind: 'stt',
        provider: 'custom',
        compatibility: 'manual',
        baseUrl: 'https://manual.example.test/v1/',
        apiKey: 'sk-test-secret-value',
      })
      ctx.state = { user: { id: 1 } }

      await ctrl.probeProvider(ctx)

      expect(fetchMock).not.toHaveBeenCalled()
      expect(ctx.body).toEqual({
        ok: true,
        models: [],
        recommendedModel: '',
        errorSummary: '',
        manualModelAllowed: true,
        normalizedBaseUrl: 'https://manual.example.test/v1',
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('allows local or private network provider probe targets', async () => {
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      data: [{ id: 'tts-local' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    globalThis.fetch = fetchMock as any

    try {
      const ctrl = await import('../../packages/server/src/modules/studio/controllers/tts')
      const { ctx } = createMockCtx({
        kind: 'tts',
        provider: 'custom',
        compatibility: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:8080/v1',
        apiKey: 'sk-tes...alue',
      })
      ctx.state = { user: { id: 1 } }

      await ctrl.probeProvider(ctx)

      expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8080/v1/models', expect.any(Object))
      expect(ctx.status).toBe(200)
      expect(ctx.body.ok).toBe(true)
      expect(ctx.body.models).toEqual([expect.objectContaining({ id: 'tts-local' })])
      expect(JSON.stringify(ctx.body)).not.toContain('sk-tes...alue')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('tts routes', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.doUnmock('../../packages/server/src/modules/studio/routes/tts')
    vi.doUnmock('../../packages/server/src/modules/studio/controllers/tts')
  })

  it('registers public legacy routes separately from the protected synthesize route', async () => {
    const generate = vi.fn(async (ctx: any) => { ctx.body = { route: 'generate' } })
    const openaiProxy = vi.fn(async (ctx: any) => { ctx.body = { route: 'openaiProxy' } })
    const synthesize = vi.fn(async (ctx: any) => { ctx.body = { route: 'synthesize' } })
    const listSettings = vi.fn(async (ctx: any) => { ctx.body = { route: 'listSettings' } })
    const saveSettings = vi.fn(async (ctx: any) => { ctx.body = { route: 'saveSettings' } })
    const saveActiveProvider = vi.fn(async (ctx: any) => { ctx.body = { route: 'saveActiveProvider' } })
    const deleteProvider = vi.fn(async (ctx: any) => { ctx.body = { route: 'deleteProvider' } })
    const deleteBaseUrlPreset = vi.fn(async (ctx: any) => { ctx.body = { route: 'deleteBaseUrlPreset' } })
    const deleteSecret = vi.fn(async (ctx: any) => { ctx.body = { route: 'deleteSecret' } })
    const probeProvider = vi.fn(async (ctx: any) => { ctx.body = { route: 'probeProvider' } })
    const mcuAudio = vi.fn(async (ctx: any) => { ctx.body = { route: 'mcuAudio' } })
    const synthesizeVoiceProxy = vi.fn(async (ctx: any) => { ctx.body = { route: 'synthesizeVoiceProxy' } })
    const synthesizeVoiceProxyOpenAi = vi.fn(async (ctx: any) => { ctx.body = { route: 'synthesizeVoiceProxyOpenAi' } })

    vi.doMock('../../packages/server/src/modules/studio/controllers/tts', () => ({
      generate,
      openaiProxy,
      mcuAudio,
      synthesize,
      listSettings,
      saveSettings,
      saveActiveProvider,
      deleteProvider,
      deleteBaseUrlPreset,
      deleteSecret,
      probeProvider,
      synthesizeVoiceProxy,
      synthesizeVoiceProxyOpenAi,
    }))

    const { ttsRoutes, ttsProtectedRoutes } = await import('../../packages/server/src/modules/studio/routes/tts')
    const paths = ttsRoutes.stack.map((entry: any) => entry.path)
    const protectedPaths = ttsProtectedRoutes.stack.map((entry: any) => entry.path)

    expect(paths).toEqual(expect.arrayContaining([
      '/api/studio/tts',
      '/api/tts/proxy/audio/speech',
      '/api/studio/mcu/audio/:file',
    ]))
    expect(paths).not.toContain('/api/studio/tts/synthesize')
    expect(protectedPaths).toEqual(expect.arrayContaining([
      '/api/studio/tts/settings',
      '/api/studio/voice/proxy/:profile/v1/tts',
      '/api/studio/voice/proxy/:profile/v1/audio/speech',
      '/api/studio/tts/settings/active',
      '/api/studio/tts/settings/:provider',
      '/api/studio/tts/settings/:provider',
      '/api/studio/tts/settings/:provider/base-url-preset',
      '/api/studio/tts/settings/:provider/secret/:secretName',
      '/api/voice/providers/probe',
      '/api/studio/tts/synthesize',
    ]))

    const synthLayer: any = ttsProtectedRoutes.stack.find((entry: any) => entry.path === '/api/studio/tts/synthesize')
    const ctx: any = { request: { body: {} }, body: null }

    await synthLayer.stack[0](ctx, undefined)

    expect(synthesize).toHaveBeenCalledWith(ctx, undefined)
    expect(ctx.body).toEqual({ route: 'synthesize' })
  })
})

describe('route registration ordering', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.doUnmock('../../packages/server/src/bootstrap/routes')
  })

  it('mounts protected synthesize routes after requireAuth', async () => {
    const ttsPublicMiddleware = async () => {}
    const ttsProtectedMiddleware = async () => {}

    vi.doMock('../../packages/server/src/modules/studio/routes/tts', () => ({
      ttsRoutes: { routes: vi.fn(() => ttsPublicMiddleware) },
      ttsProtectedRoutes: { routes: vi.fn(() => ttsProtectedMiddleware) },
    }))

    const { registerRoutes } = await import('../../packages/server/src/bootstrap/routes')
    const use = vi.fn()
    const app = { use }
    const requireAuth = vi.fn(async () => {})

    registerRoutes(app as any, [requireAuth] as any)
    const mountedMiddleware = use.mock.calls.map(([middleware]) => middleware)

    expect(mountedMiddleware.indexOf(ttsPublicMiddleware)).toBeGreaterThanOrEqual(0)
    expect(mountedMiddleware.indexOf(requireAuth)).toBeGreaterThan(mountedMiddleware.indexOf(ttsPublicMiddleware))
    expect(mountedMiddleware.indexOf(ttsProtectedMiddleware)).toBeGreaterThan(mountedMiddleware.indexOf(requireAuth))
  }, 15_000)
})
