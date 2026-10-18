import AdmZip from 'adm-zip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_THEME_ARCHIVE_BYTES, MAX_THEME_MANIFEST_BYTES } from '../../packages/shared/theme-archive'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=', 'base64')
const settings = {
  brightness: 'dark', style: 'comic', fontSize: 18, textColor: '#ddeeff', accentColor: '#5588bb',
  appearance: { global: { opacity: 0.3, radius: 12, backgroundColor: '#123456', gradientColor: '#654321', fontFamily: 'mono' },
    regions: { card: { opacity: 0, blur: 16 }, input: { radius: 0 }, chrome: { borderColor: '#123456' } } },
}
const manifest = () => ({ format: 'ekko-studio-theme', version: 1, name: '夜色 Theme', settings, background: null })
function archive(value: unknown = manifest(), image?: Buffer) {
  const zip = new AdmZip()
  zip.addFile('theme.json', Buffer.from(JSON.stringify(value)))
  if (image) zip.addFile('background.png', image)
  return zip.toBuffer()
}

describe('theme ZIP archives', () => {
  let db: any
  let root: string
  let store: typeof import('../../packages/server/src/modules/studio/repositories/user-theme-store')
  let service: typeof import('../../packages/server/src/modules/studio/services/theme/archive')
  let backgrounds: typeof import('../../packages/server/src/modules/studio/services/theme/user-theme')

  beforeEach(async () => {
    vi.resetModules()
    root = await mkdtemp(join(tmpdir(), 'studio-theme-archive-'))
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({ getDb: () => db }))
    vi.doMock('../../packages/server/src/modules/studio/public/config', () => ({ config: { appHome: root } }))
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
    store = await import('../../packages/server/src/modules/studio/repositories/user-theme-store')
    service = await import('../../packages/server/src/modules/studio/services/theme/archive')
    backgrounds = await import('../../packages/server/src/modules/studio/services/theme/user-theme')
  })
  afterEach(async () => {
    db?.close()
    await rm(root, { recursive: true, force: true })
    vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
    vi.doUnmock('../../packages/server/src/modules/studio/public/config')
    vi.resetModules()
  })

  it('round-trips settings and wallpaper into a new owned theme without exporting server identity', async () => {
    const initial = store.createThemePreset(1, { name: '夜色 Theme' })
    store.saveUserTheme(1, settings)
    await backgrounds.replaceThemeBackground(1, '风景.png', png)
    const exported = await service.exportThemeArchive(1, initial.activeId)
    const zip = new AdmZip(exported.data)
    expect(zip.getEntries().map(entry => entry.entryName).sort()).toEqual(['background.png', 'theme.json'])
    const document = JSON.parse(zip.readAsText('theme.json'))
    expect(document).toEqual({ ...manifest(), background: { file: 'background.png', name: '风景.png' } })
    expect(JSON.stringify(document)).not.toMatch(/userId|activePresetId|backgroundFilename|updatedAt/)
    expect(zip.readFile('background.png')).toEqual(png)
    const original = store.getUserTheme(1)
    const imported = await service.importThemeArchive(1, exported.data)
    expect(imported.activeId).not.toBe(initial.activeId)
    expect(imported.theme).toMatchObject(settings)
    expect(imported.themes.filter(theme => theme.name === '夜色 Theme')).toHaveLength(2)
    expect(store.getThemePreset(1, initial.activeId)).toEqual(original)
    expect(store.getUserTheme(1).backgroundFilename).not.toBe(original.backgroundFilename)
    expect(imported.theme.background!.updatedAt).toBeGreaterThan(original.backgroundUpdatedAt)
    const secondUser = await service.importThemeArchive(2, exported.data)
    expect(secondUser.theme).toMatchObject(settings)
    await backgrounds.deleteThemePreset(1, imported.activeId)
    expect((await backgrounds.readThemeBackground(1, initial.activeId))!.data).toEqual(png)
    expect((await backgrounds.readThemeBackground(2, secondUser.activeId))!.data).toEqual(png)
    await expect(service.exportThemeArchive(2, initial.activeId)).rejects.toMatchObject({ status: 404 })
  })

  it('imports themes without a wallpaper and preserves legacy device modes on the previous theme', async () => {
    const first = store.listThemePresets(1)
    const exported = await service.exportThemeArchive(1, first.activeId, { brightness: 'dark', style: 'comic' })
    expect(JSON.parse(new AdmZip(exported.data).readAsText('theme.json')).settings).toMatchObject({ brightness: 'dark', style: 'comic' })
    const imported = await service.importThemeArchive(1, archive(), { brightness: 'light', style: 'ink' })
    expect(imported.theme.background).toBeNull()
    expect(store.getThemePreset(1, first.activeId)).toMatchObject({ brightness: 'light', style: 'ink' })
    expect(await readdir(join(root, 'theme-backgrounds')).catch(() => [])).toEqual([])
  })

  it('fails an export with a missing wallpaper rather than producing an incomplete archive', async () => {
    const first = store.listThemePresets(1)
    store.saveUserThemeBackground(1, { filename: `${'a'.repeat(32)}.png`, originalName: 'gone.png', mime: 'image/png' })
    await expect(service.exportThemeArchive(1, first.activeId)).rejects.toMatchObject({ status: 409 })
  })

  it.each([
    ['not a ZIP', () => Buffer.from('not a zip')],
    ['future version', () => archive({ ...manifest(), version: 99 })],
    ['invalid settings', () => archive({ ...manifest(), settings: { ...settings, appearance: { global: { opacity: 4 } } } })],
    ['missing image', () => archive({ ...manifest(), background: { file: 'background.png', name: 'wall.png' } })],
    ['unreferenced image', () => archive(manifest(), png)],
    ['invalid image', () => archive({ ...manifest(), background: { file: 'background.png', name: 'wall.png' } }, Buffer.from('<svg />'))],
    ['invalid name', () => archive({ ...manifest(), name: '' })],
  ])('rejects %s without changing active settings or adding assets', async (_name, make) => {
    const before = store.listThemePresets(1)
    await expect(service.importThemeArchive(1, make())).rejects.toThrow()
    expect(store.listThemePresets(1)).toEqual(before)
    expect(await readdir(join(root, 'theme-backgrounds')).catch(() => [])).toEqual([])
  })

  it('rejects unsafe names, duplicate entries, links, encrypted entries and bad checksums', async () => {
    const before = store.listThemePresets(1)
    for (const mode of ['path', 'duplicate', 'link', 'encrypted', 'crc']) {
      const zip = new AdmZip(archive())
      if (mode === 'path') zip.addFile('../escape.txt', Buffer.from('x'))
      if (mode === 'duplicate') zip.addFile('themeXjson', Buffer.from('{}'))
      if (mode === 'link') zip.getEntry('theme.json')!.attr = (0o120777 << 16) >>> 0
      const data = zip.toBuffer()
      if (mode === 'duplicate') {
        for (let offset = data.indexOf('themeXjson'); offset !== -1; offset = data.indexOf('themeXjson')) data.write('theme.json', offset)
      }
      const central = data.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
      if (mode === 'encrypted') data.writeUInt16LE(data.readUInt16LE(central + 8) | 1, central + 8)
      if (mode === 'crc') data.writeUInt32LE(123, central + 16)
      await expect(service.importThemeArchive(1, data)).rejects.toThrow()
    }
    expect(store.listThemePresets(1)).toEqual(before)
  })

  it('limits both upload size and actual expanded data even if entry headers lie', async () => {
    await expect(service.importThemeArchive(1, Buffer.alloc(MAX_THEME_ARCHIVE_BYTES + 1))).rejects.toMatchObject({ status: 413 })
    const zip = new AdmZip()
    zip.addFile('theme.json', Buffer.alloc(MAX_THEME_MANIFEST_BYTES * 4, 32))
    const data = zip.toBuffer()
    const central = data.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    data.writeUInt32LE(20, central + 24)
    data.writeUInt32LE(20, 22)
    await expect(service.importThemeArchive(1, data)).rejects.toMatchObject({ status: 400 })
  })

  it('rolls back the library and removes staged wallpaper when persistence fails', async () => {
    const before = store.listThemePresets(1)
    db.exec("CREATE TRIGGER reject_theme_import BEFORE INSERT ON user_theme_presets WHEN NEW.name = '夜色 Theme' BEGIN SELECT RAISE(ABORT, 'write failed'); END;")
    const data = archive({ ...manifest(), background: { file: 'background.png', name: 'wall.png' } }, png)
    await expect(service.importThemeArchive(1, data)).rejects.toThrow('write failed')
    expect(store.listThemePresets(1)).toEqual(before)
    expect(await readdir(join(root, 'theme-backgrounds', '1'))).toEqual([])
  })
})
