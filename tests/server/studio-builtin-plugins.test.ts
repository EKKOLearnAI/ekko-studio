import { afterEach, expect, it } from 'vitest'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { PluginManager } from '../../packages/server/src/modules/studio/services/plugins/manager'
import { reconcileBuiltinPlugins } from '../../packages/server/src/modules/studio/services/plugins/builtin'
import { builtinPluginIds } from '../../packages/server/src/modules/studio/services/plugins/builtin-directory'

const who = { userId: 1, profile: 'work' }, cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
function openManager(home: string) {
  const manager = new PluginManager(home, { authorize() {}, api: async () => null, emit() {}, log() {} })
  cleanup.push(() => manager.close())
  return manager
}
async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'studio-builtin-'))
  cleanup.push(() => rm(home, { recursive: true, force: true }))
  return { home, manager: openManager(home) }
}
async function legacyInstallation(home: string, manager: PluginManager) {
  // Simulate an older bundled record using a local fixture, without OMP code.
  const source = join(home, 'legacy-package')
  await cp(resolve('tests/fixtures/plugins/custom-agent'), source, { recursive: true })
  const manifestPath = join(source, 'plugin.json'), packagePath = join(source, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')), pkg = JSON.parse(await readFile(packagePath, 'utf8'))
  manifest.id = 'omp'; manifest.version = pkg.version = '0.2.1'
  await writeFile(manifestPath, JSON.stringify(manifest)); await writeFile(packagePath, JSON.stringify(pkg))
  await manager.install(who, source, 0)
  await manager.update(who, 'omp', manager.snapshot().revision, { enabled: true })
  await manager.runtime(who, 'omp').invoke('rpc', 'save-settings', { prefix: 'Saved settings' }, who)
  const dataDir = manager.runtime(who, 'omp').context().paths.dataDir
  await mkdir(dataDir, { recursive: true }); await writeFile(join(dataDir, 'engine.json'), 'retained native files')
  const state = manager.store.read()
  state.records.omp.source = 'builtin:omp'; state.builtinVersions = { omp: '0.2.1' }
  manager.store.write(state, state.revision)
  return { source, dataDir, manifest, pkg }
}

it('starts without bundled plugins and requires explicit installation and activation of independent plugins', async () => {
  const { manager } = await setup()
  expect(builtinPluginIds()).toEqual([])
  await reconcileBuiltinPlugins(manager, who)
  expect(manager.snapshot().plugins).toEqual([])
  expect(manager.registeredAgents()).toEqual([])
  await manager.install(who, resolve('tests/fixtures/plugins/custom-agent'), 0)
  await reconcileBuiltinPlugins(manager, who)
  expect(manager.snapshot().plugins).toMatchObject([{ manifest: { id: 'custom-agent' }, enabled: false }])
  await manager.update(who, 'custom-agent', manager.snapshot().revision, { enabled: true })
  expect(manager.registeredAgents().map(agent => agent.id)).toEqual(['plugin:custom-agent/assistant'])
})

it.each([true, false])('retains an existing bundled installation and its data after removal from the catalog (enabled: %s)', async enabled => {
  const { home, manager } = await setup()
  const { dataDir } = await legacyInstallation(home, manager)
  if (!enabled) await manager.update(who, 'omp', manager.snapshot().revision, { enabled: false })
  await manager.close()
  const restored = openManager(home)
  await restored.restore()
  const before = restored.store.read()
  await reconcileBuiltinPlugins(restored, who)
  expect(restored.store.read()).toEqual(before)
  expect(restored.snapshot().plugins).toMatchObject([{ manifest: { id: 'omp', version: '0.2.1' }, source: 'builtin:omp', enabled, status: enabled ? 'active' : 'disabled' }])
  expect(await restored.store.storage('omp', () => {}).namespace('settings', String(who.userId), who.profile).get('prefix')).toBe('Saved settings')
  expect(await readFile(join(dataDir, 'engine.json'), 'utf8')).toBe('retained native files')
  if (enabled) expect(restored.runtime(who, 'omp').context().paths.dataDir).toBe(dataDir)
})

it('updates a historical bundled plugin from an independent source without losing data or reinstalling it after removal', async () => {
  const { home, manager } = await setup()
  const { source, dataDir, manifest, pkg } = await legacyInstallation(home, manager)
  manifest.version = pkg.version = '1.0.0'
  await writeFile(join(source, 'plugin.json'), JSON.stringify(manifest)); await writeFile(join(source, 'package.json'), JSON.stringify(pkg))
  await manager.install(who, source, manager.snapshot().revision, 'omp')
  expect(manager.snapshot().plugins).toMatchObject([{ source, manifest: { version: '1.0.0' }, enabled: true }])
  expect(await manager.runtime(who, 'omp').invoke('rpc', 'get-settings', null, who)).toEqual({ prefix: 'Saved settings' })
  expect(manager.runtime(who, 'omp').context().paths.dataDir).toBe(dataDir)
  await manager.update(who, 'omp', manager.snapshot().revision, { action: 'uninstall' })
  await reconcileBuiltinPlugins(manager, who)
  expect(manager.snapshot().plugins).toEqual([])
  expect(await readFile(join(dataDir, 'engine.json'), 'utf8')).toBe('retained native files')
})
