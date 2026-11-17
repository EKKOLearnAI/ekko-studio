import { expect, it } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginManager } from '../../packages/server/src/modules/studio/services/plugins/manager'
import { PluginResources } from '../../packages/server/src/modules/studio/services/plugins/resources'

// Optional sibling package check; never clones a private repository in normal CI.
const source = process.env.STUDIO_TEST_VERSION_PREVIEW_PLUGIN
it.skipIf(!source)('installs the real independent package, calls RPC, reloads and uninstalls without losing legacy data', async () => {
  const home = await mkdtemp(join(tmpdir(), 'studio-preview-package-')), resources = new PluginResources()
  const who = { userId: 42, profile: 'default' }
  const sourceDir = join(home, 'hermes-web-ui-pereview'), homeDir = join(home, 'hermes-web-ui-pereview-home')
  resources.register('studio.version-preview', () => ({ sourceDir, homeDir }))
  const manager = new PluginManager(join(home, 'plugins'), {
    authorize() {}, api: async () => { throw new Error('Plugin preview must never call a built-in API') }, emit() {}, log() {},
    environment: () => ({ webUiHome: home, studio: { name: 'ekko-studio', version: '0.8.25', repositoryUrl: 'https://github.com/example/studio' }, isPreview: false }),
    claimResource: (name, owner) => resources.claim(name, owner),
  })
  try {
    await mkdir(homeDir); await writeFile(join(homeDir, 'database.db'), 'existing preview database')
    await mkdir(sourceDir); await writeFile(join(sourceDir, 'package.json'), JSON.stringify({ name: 'ekko-studio' })); await writeFile(join(sourceDir, '.preview-tag'), 'main')
    const revision = () => manager.snapshot().revision
    await manager.install(who, source!, revision())
    await manager.update(who, 'version-preview', revision(), { enabled: true })
    let runtime = manager.runtime(who, 'version-preview')
    expect(await runtime.invoke('rpc', 'status', null, who)).toMatchObject({ current_tag: 'main', has_package: true })
    expect(resources.claimed('studio.version-preview')).toBe(true)
    await expect(runtime.invoke('rpc', 'prepare', { tag: '../bad' }, who)).rejects.toThrow()
    await manager.update(who, 'version-preview', revision(), { action: 'reload' })
    runtime = manager.runtime(who, 'version-preview')
    expect(await runtime.invoke('rpc', 'stop', null, who)).toMatchObject({ success: true })
    await manager.update(who, 'version-preview', revision(), { action: 'uninstall' })
    expect(resources.claimed('studio.version-preview')).toBe(false)
    expect(await readFile(join(homeDir, 'database.db'), 'utf8')).toBe('existing preview database')
    await access(join(sourceDir, '.preview-tag'))
  } finally { await manager.close(); await rm(home, { recursive: true, force: true }) }
}, 30000)
