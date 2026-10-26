import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

describe('user theme storage', () => {
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
    vi.doUnmock('../../packages/server/src/modules/studio/public/config')
    vi.resetModules()
  })

  async function initStore() {
    const schemas = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    schemas.initAllHermesTables()
    return {
      schemas,
      store: await import('../../packages/server/src/modules/studio/repositories/user-theme-store'),
    }
  }

  it('creates the user theme table and returns defaults', async () => {
    const { schemas, store } = await initStore()
    const table = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
    ).get(schemas.USER_THEMES_TABLE)

    expect(table).toBeTruthy()
    expect(store.getUserTheme(4)).toMatchObject({
      userId: 4,
      fontSize: 14,
      textColor: null,
      accentColor: null,
      backgroundFilename: null,
    })
  })

  it('stores isolated theme settings for each user', async () => {
    const { store } = await initStore()

    const first = store.saveUserTheme(1, {
      fontSize: 18,
      textColor: '#123456',
      accentColor: '#abcdef',
    })
    const second = store.saveUserTheme(2, {
      fontSize: 12,
      accentColor: '#ff8800',
    })

    expect(first).toMatchObject({
      userId: 1,
      fontSize: 18,
      textColor: '#123456',
      accentColor: '#abcdef',
    })
    expect(second).toMatchObject({
      userId: 2,
      fontSize: 12,
      textColor: null,
      accentColor: '#ff8800',
    })
    expect(store.getUserTheme(1)).toMatchObject(first)
  })

  it('rejects invalid sizes and colors', async () => {
    const { store } = await initStore()

    expect(() => store.saveUserTheme(1, { fontSize: 30 }))
      .toThrow(/between 12 and 20/)
    expect(() => store.saveUserTheme(1, { textColor: 'red' }))
      .toThrow(/six-digit hex color/)
  })

  it('persists sparse regional overrides per user and resets inheritance', async () => {
    const { store } = await initStore()
    const appearance = { global: { backgroundColor: '#123456', opacity: 0.4 }, regions: { input: { radius: 0, opacity: 0 } } }
    store.saveUserTheme(1, { appearance })
    expect(store.getUserTheme(1).appearance).toEqual(appearance)
    expect(store.getUserTheme(2).appearance).toEqual({ global: {}, regions: {} })
    expect(() => store.saveUserTheme(1, { appearance: { global: { opacity: 2 } } })).toThrow('Invalid theme appearance')
    expect(store.getUserTheme(1).appearance).toEqual(appearance)
    expect(store.saveUserTheme(1, { appearance: null }).appearance).toEqual({ global: {}, regions: {} })
  })

  it('migrates legacy settings without losing colors or changing the wallpaper cache key on saves', async () => {
    const schemas = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    db.exec(`CREATE TABLE ${schemas.USER_THEMES_TABLE} (
      user_id INTEGER PRIMARY KEY, font_size INTEGER, text_color TEXT, accent_color TEXT,
      background_filename TEXT, background_original_name TEXT, background_mime TEXT,
      created_at INTEGER, updated_at INTEGER
    )`)
    db.prepare(`INSERT INTO ${schemas.USER_THEMES_TABLE} VALUES (1, 16, '#123456', NULL, 'wall.png', 'wall.png', 'image/png', 100, 200)`).run()
    const { store } = await initStore()
    expect(store.getUserTheme(1)).toMatchObject({ fontSize: 16, textColor: '#123456', appearance: { global: {}, regions: {} }, backgroundUpdatedAt: 200 })
    const appearance = { global: { radius: 12 }, regions: {} }
    const updated = store.saveUserTheme(1, { appearance })
    expect(store.toUserThemePayload(updated).background?.updatedAt).toBe(200)
    expect(store.saveUserTheme(1, { fontSize: 20 }).backgroundUpdatedAt).toBe(200)
    const uploaded = store.saveUserThemeBackground(1, { filename: 'new.png', originalName: 'new.png', mime: 'image/png' })
    expect(uploaded.backgroundUpdatedAt).toBeGreaterThan(200)
    expect(uploaded.appearance).toEqual(appearance)
    expect(store.clearUserThemeBackground(1).appearance).toEqual(appearance)
  })

  it('keeps color settings when the background metadata changes', async () => {
    const { store } = await initStore()
    store.saveUserTheme(1, {
      fontSize: 17,
      textColor: '#111111',
      accentColor: '#2255ff',
    })

    const withBackground = store.saveUserThemeBackground(1, {
      filename: '0123456789abcdef0123456789abcdef.png',
      originalName: 'wallpaper.png',
      mime: 'image/png',
    })
    expect(withBackground).toMatchObject({
      fontSize: 17,
      textColor: '#111111',
      accentColor: '#2255ff',
      backgroundFilename: '0123456789abcdef0123456789abcdef.png',
      backgroundOriginalName: 'wallpaper.png',
    })

    const cleared = store.clearUserThemeBackground(1)
    expect(cleared).toMatchObject({
      fontSize: 17,
      textColor: '#111111',
      accentColor: '#2255ff',
      backgroundFilename: null,
    })
  })

  it('stores validated background files outside SQLite and removes them cleanly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-theme-test-'))
    vi.doMock('../../packages/server/src/modules/studio/public/config', () => ({
      config: { appHome: root },
    }))

    try {
      await initStore()
      const service = await import('../../packages/server/src/modules/studio/services/theme/user-theme')
      const png = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x00,
      ])

      const saved = await service.replaceThemeBackground(3, '../../wallpaper.png', png)
      expect(saved).toMatchObject({
        userId: 3,
        backgroundOriginalName: 'wallpaper.png',
        backgroundMime: 'image/png',
      })
      expect(saved.backgroundFilename).toMatch(/^[a-f0-9]{32}\.png$/)

      const loaded = await service.readThemeBackground(3)
      expect(loaded?.mime).toBe('image/png')
      expect(loaded?.data).toEqual(png)

      await service.removeThemeBackground(3)
      expect(await service.readThemeBackground(3)).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('preserves legacy settings as the first theme and switches isolated snapshots', async () => {
    const { store } = await initStore()
    const appearance = { global: { opacity: 0.25 }, regions: { input: { radius: 0 } } }
    store.saveUserTheme(1, { fontSize: 18, appearance })
    const first = store.listThemePresets(1)
    expect(first.themes).toHaveLength(1)
    expect(first.themes[0]).toMatchObject({ fontSize: 18, appearance })
    expect(store.listThemePresets(1).activeId).toBe(first.activeId)
    const fresh = store.createThemePreset(1, { name: 'Night', brightness: 'dark', style: 'comic' })
    expect(fresh.theme).toMatchObject({ fontSize: 14, brightness: 'dark', style: 'comic', background: null })
    store.saveUserTheme(1, { presetId: fresh.activeId, accentColor: '#4488ff' })
    const restored = store.activateThemePreset(1, first.activeId)
    expect(restored.theme).toMatchObject({ fontSize: 18, appearance, accentColor: null, brightness: 'dark', style: 'comic' })
    expect(store.activateThemePreset(1, fresh.activeId).theme.accentColor).toBe('#4488ff')
  })

  it('duplicates and renames themes without sharing editable settings', async () => {
    const { store } = await initStore()
    store.saveUserTheme(1, { brightness: 'light', style: 'ink', appearance: { global: { radius: 20 }, regions: {} } })
    const original = store.listThemePresets(1).activeId
    const duplicate = store.createThemePreset(1, { name: 'Copy', sourceId: original })
    expect(duplicate.theme).toMatchObject({ brightness: 'light', style: 'ink', appearance: { global: { radius: 20 } } })
    store.saveUserTheme(1, { appearance: { global: { radius: 4 }, regions: {} } })
    const renamed = store.renameThemePreset(1, duplicate.activeId, '  Compact  ')
    expect(renamed.themes.find(item => item.id === duplicate.activeId)?.name).toBe('Compact')
    expect(store.activateThemePreset(1, original).theme.appearance.global.radius).toBe(20)
    expect(() => store.renameThemePreset(1, original, ' ')).toThrow(/name/)
    expect(() => store.createThemePreset(1, { name: 'x'.repeat(81) })).toThrow(/name/)
    expect(() => store.saveUserTheme(1, { brightness: 'invalid' })).toThrow(/mode/)
  })

  it('rejects cross-user operations and writes targeting an inactive theme', async () => {
    const { store } = await initStore()
    const first = store.listThemePresets(1).activeId
    const second = store.createThemePreset(1, { name: 'Other' }).activeId
    for (const action of [
      () => store.activateThemePreset(2, first),
      () => store.renameThemePreset(2, first, 'stolen'),
      () => store.deleteThemePreset(2, first),
      () => store.createThemePreset(2, { name: 'stolen', sourceId: first }),
    ]) expect(action).toThrow(/not found/)
    expect(store.getUserTheme(2).createdAt).toBe(0)
    expect(() => store.saveUserTheme(1, { presetId: first, fontSize: 20 })).toThrow(/active theme changed/)
    expect(() => store.clearUserThemeBackground(1, first)).toThrow(/active theme changed/)
    expect(store.getUserTheme(1)).toMatchObject({ activePresetId: second, fontSize: 14 })
  })

  it('switches away when deleting the active theme and preserves the final theme', async () => {
    const { store } = await initStore()
    const first = store.listThemePresets(1).activeId
    const second = store.createThemePreset(1, { name: 'Other' }).activeId
    const result = store.deleteThemePreset(1, second)
    expect(result.activeId).toBe(first)
    expect(result.themes).toHaveLength(1)
    expect(store.getUserTheme(1).activePresetId).toBe(first)
    expect(() => store.deleteThemePreset(1, first)).toThrow(/at least one/)
  })

  it('rolls back a new theme and preference adoption if activation cannot be saved', async () => {
    const { store, schemas } = await initStore()
    const original = store.listThemePresets(1)
    const before = store.getUserTheme(1)
    db.exec(`CREATE TRIGGER reject_theme_activation BEFORE UPDATE ON ${schemas.USER_THEMES_TABLE}
      WHEN NEW.active_preset_id != OLD.active_preset_id
      BEGIN SELECT RAISE(ABORT, 'activation failed'); END`)
    expect(() => store.createThemePreset(1, { name: 'Other', brightness: 'dark', style: 'comic' })).toThrow('activation failed')
    expect(store.listThemePresets(1).themes).toHaveLength(1)
    expect(store.listThemePresets(1).activeId).toBe(original.activeId)
    expect(store.getUserTheme(1)).toEqual(before)
  })

  it('keeps copied wallpapers alive until their last theme reference is deleted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studio-theme-library-'))
    vi.doMock('../../packages/server/src/modules/studio/public/config', () => ({ config: { appHome: root } }))
    try {
      const { store } = await initStore()
      const service = await import('../../packages/server/src/modules/studio/services/theme/user-theme')
      const { access, readdir } = await import('fs/promises')
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      const original = store.listThemePresets(1).activeId
      const upload = await service.replaceThemeBackground(1, 'original.png', png, original)
      const copy = store.createThemePreset(1, { name: 'Copy', sourceId: original }).activeId
      await service.replaceThemeBackground(1, 'copy.png', png, copy)
      expect((await service.readThemeBackground(1, original))?.data).toEqual(png)
      expect((await service.readThemeBackground(1, copy))?.updatedAt).toBeGreaterThan(upload.backgroundUpdatedAt)
      expect(store.getThemePreset(1, original).backgroundOriginalName).toBe('original.png')
      expect(store.getThemePreset(1, copy).backgroundOriginalName).toBe('copy.png')
      await expect(service.readThemeBackground(2, original)).rejects.toThrow(/not found/)
      await service.deleteThemePreset(1, original)
      await expect(access(join(root, 'theme-backgrounds', '1', upload.backgroundFilename!))).rejects.toThrow()
      expect(await readdir(join(root, 'theme-backgrounds', '1'))).toHaveLength(1)
      await service.removeAllUserThemeAssets(1)
      await expect(access(join(root, 'theme-backgrounds', '1'))).rejects.toThrow()
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('does not attach an upload to a different theme if activation changes during file IO', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studio-theme-upload-race-'))
    vi.doMock('../../packages/server/src/modules/studio/public/config', () => ({ config: { appHome: root } }))
    try {
      const { store } = await initStore()
      const service = await import('../../packages/server/src/modules/studio/services/theme/user-theme')
      const { readdir } = await import('fs/promises')
      const first = store.listThemePresets(1).activeId
      const uploading = service.replaceThemeBackground(1, 'wall.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), first)
      store.createThemePreset(1, { name: 'Other' })
      await expect(uploading).rejects.toThrow(/active theme changed/)
      expect(store.getUserTheme(1).backgroundFilename).toBeNull()
      expect(await readdir(join(root, 'theme-backgrounds', '1'))).toEqual([])
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
