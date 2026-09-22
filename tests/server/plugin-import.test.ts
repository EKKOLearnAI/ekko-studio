import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdmZip from 'adm-zip'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Installing a plugin used to require a shell inside the container. These cover
 * the archive contract and the refusals that keep an upload from writing
 * outside the profile's plugins directory.
 */
describe('plugin import', () => {
  let home = ''

  beforeEach(() => {
    vi.resetModules()
    home = mkdtempSync(join(tmpdir(), 'hermes-plugin-import-'))
    vi.doMock('../../packages/server/src/modules/hermes/services/profiles/profile', () => ({
      getActiveProfileDir: () => home,
      getProfileDir: (profile: string) => join(home, 'profiles', profile),
    }))
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    vi.doUnmock('../../packages/server/src/modules/hermes/services/profiles/profile')
    vi.resetModules()
  })

  function zipOf(entries: Record<string, string>): Buffer {
    const zip = new AdmZip()
    for (const [path, content] of Object.entries(entries)) {
      zip.addFile(path, Buffer.from(content, 'utf-8'))
    }
    return zip.toBuffer()
  }

  async function service() {
    return import('../../packages/server/src/modules/hermes/services/plugins/import')
  }

  it('installs a plugin whose archive holds one top-level directory', async () => {
    const { importPluginArchive } = await service()
    const result = await importPluginArchive({
      archive: zipOf({
        'my-plugin/plugin.yaml': 'name: my-plugin\nversion: 1.0.0\n',
        'my-plugin/main.py': 'print("hi")\n',
      }),
      filename: 'anything.zip',
    })

    expect(result.name).toBe('my-plugin')
    expect(result.replaced).toBe(false)
    expect(result.files).toBe(2)
    expect(readFileSync(join(home, 'plugins', 'my-plugin', 'plugin.yaml'), 'utf-8')).toContain('name: my-plugin')
  })

  it('names the plugin after the archive when the manifest sits at the root', async () => {
    const { importPluginArchive } = await service()
    const result = await importPluginArchive({
      archive: zipOf({ 'plugin.yml': 'name: rooted\n' }),
      filename: 'rooted.zip',
    })

    expect(result.name).toBe('rooted')
    expect(existsSync(join(home, 'plugins', 'rooted', 'plugin.yml'))).toBe(true)
  })

  it('installs into the requested profile rather than the active one', async () => {
    const { importPluginArchive } = await service()
    await importPluginArchive({
      archive: zipOf({ 'scoped/plugin.yaml': 'name: scoped\n' }),
      filename: 'scoped.zip',
      profile: 'work',
    })

    expect(existsSync(join(home, 'profiles', 'work', 'plugins', 'scoped', 'plugin.yaml'))).toBe(true)
    expect(existsSync(join(home, 'plugins', 'scoped'))).toBe(false)
  })

  it('refuses an archive with no manifest', async () => {
    const { importPluginArchive } = await service()
    await expect(importPluginArchive({
      archive: zipOf({ 'thing/readme.md': '# not a plugin\n' }),
      filename: 'thing.zip',
    })).rejects.toThrow(/plugin.yaml/)
    expect(existsSync(join(home, 'plugins', 'thing'))).toBe(false)
  })

  it('refuses an archive with several top-level directories', async () => {
    const { importPluginArchive } = await service()
    await expect(importPluginArchive({
      archive: zipOf({ 'a/plugin.yaml': 'name: a\n', 'b/plugin.yaml': 'name: b\n' }),
      filename: 'two.zip',
    })).rejects.toThrow(/single top-level plugin directory/)
  })

  it('refuses an entry that would escape the plugins directory', async () => {
    const { importPluginArchive } = await service()
    // AdmZip normalises a traversal path on the way in, so write the hostile
    // entry name directly — the way a hand-built archive would carry it.
    const zip = new AdmZip()
    zip.addFile('placeholder/plugin.yaml', Buffer.from('name: placeholder\n', 'utf-8'))
    zip.getEntries()[0].entryName = '../../escaped/plugin.yaml'

    await expect(importPluginArchive({ archive: zip.toBuffer(), filename: 'evil.zip' }))
      .rejects.toThrow(/traversal|plugin\.yaml|single top-level/)
    expect(existsSync(join(home, 'escaped'))).toBe(false)
    expect(existsSync(join(tmpdir(), 'escaped'))).toBe(false)
  })

  it('does not replace an installed plugin unless replacement was asked for', async () => {
    const { importPluginArchive, PluginImportError } = await service()
    const first = zipOf({ 'dup/plugin.yaml': 'name: dup\nversion: 1\n' })
    await importPluginArchive({ archive: first, filename: 'dup.zip' })

    const second = zipOf({ 'dup/plugin.yaml': 'name: dup\nversion: 2\n' })
    const error = await importPluginArchive({ archive: second, filename: 'dup.zip' }).catch(e => e)
    expect(error).toBeInstanceOf(PluginImportError)
    expect(error.status).toBe(409)
    // The installed copy is untouched by the refused import.
    expect(readFileSync(join(home, 'plugins', 'dup', 'plugin.yaml'), 'utf-8')).toContain('version: 1')

    const replaced = await importPluginArchive({ archive: second, filename: 'dup.zip', overwrite: true })
    expect(replaced.replaced).toBe(true)
    expect(readFileSync(join(home, 'plugins', 'dup', 'plugin.yaml'), 'utf-8')).toContain('version: 2')
  })

  it('drops archive noise instead of installing it', async () => {
    const { importPluginArchive } = await service()
    const result = await importPluginArchive({
      archive: zipOf({
        '__MACOSX/._plugin.yaml': 'junk',
        'clean/plugin.yaml': 'name: clean\n',
      }),
      filename: 'clean.zip',
    })

    expect(result.name).toBe('clean')
    expect(existsSync(join(home, 'plugins', '__MACOSX'))).toBe(false)
  })

  it('rejects a plugin name that is not a safe path segment', async () => {
    const { isValidPluginName } = await service()
    expect(isValidPluginName('good-plugin_1.0')).toBe(true)
    expect(isValidPluginName('../evil')).toBe(false)
    expect(isValidPluginName('.hidden')).toBe(false)
    expect(isValidPluginName('with space')).toBe(false)
    expect(isValidPluginName('')).toBe(false)
  })
})
