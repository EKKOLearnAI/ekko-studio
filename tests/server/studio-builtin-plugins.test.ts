import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { PluginManager } from '../../packages/server/src/modules/studio/services/plugins/manager'
import { reconcileBuiltinPlugins } from '../../packages/server/src/modules/studio/services/plugins/builtin'

const who = { userId: 1, profile: 'work' }, cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'studio-builtin-')); cleanup.push(() => rm(home, { recursive: true, force: true }))
  const manager = new PluginManager(home, { authorize() {}, api: async () => null, emit() {}, log() {} }); cleanup.push(() => manager.close())
  return manager
}
it('registers the bundled OMP runtime and retains disable/uninstall decisions across reconciliation', async () => {
  const manager = await setup()
  await reconcileBuiltinPlugins(manager, who)
  expect(manager.snapshot().plugins).toMatchObject([{ manifest: { id: 'omp' }, source: 'builtin:omp', status: 'active' }])
  expect(manager.registeredAgents().map(agent => agent.id)).toEqual(['plugin:omp/omp'])
  await manager.update(who, 'omp', manager.store.read().revision, { enabled: false })
  await reconcileBuiltinPlugins(manager, who)
  expect(manager.snapshot().plugins[0].enabled).toBe(false)
  await manager.update(who, 'omp', manager.store.read().revision, { action: 'uninstall' })
  await reconcileBuiltinPlugins(manager, who)
  expect(manager.snapshot().plugins).toEqual([])
})
it('retires only old examples from this checkout while retaining their stored data', async () => {
  const manager = await setup()
  await manager.install(who, resolve('tests/fixtures/plugins/notebook'), 0)
  const store = manager.store.storage('notebook', () => {})
  await store.set('keep', 'user notes')
  const state = manager.store.read()
  state.records.notebook.source = resolve('examples/plugins/notebook')
  manager.store.write(state, state.revision)
  await reconcileBuiltinPlugins(manager, who)
  expect(manager.snapshot().plugins.map(plugin => plugin.manifest.id)).toEqual(['omp'])
  expect(await store.get('keep')).toBe('user notes')
})
it('keeps deliberately installed fixtures and preserves builtin configuration/data during package updates', async () => {
  const manager = await setup()
  await manager.install(who, resolve('tests/fixtures/plugins/notebook'), 0)
  await reconcileBuiltinPlugins(manager, who)
  expect(manager.snapshot().plugins.map(plugin => plugin.manifest.id)).toEqual(['notebook', 'omp'])
  const path = manager.runtime(who, 'omp').context().paths.dataDir
  await manager.update(who, 'omp', manager.store.read().revision, { enabled: false })
  const state = manager.store.read(); state.records.omp.manifest.version = '0.0.1'; manager.store.write(state, state.revision)
  await reconcileBuiltinPlugins(manager, who)
  expect(manager.snapshot().plugins.find(plugin => plugin.manifest.id === 'omp')).toMatchObject({ enabled: false, manifest: { version: '0.1.4' } })
  await manager.update(who, 'omp', manager.store.read().revision, { enabled: true })
  expect(manager.runtime(who, 'omp').context().paths.dataDir).toBe(path)
})
