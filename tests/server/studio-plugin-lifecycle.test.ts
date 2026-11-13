import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, access, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as installer from '../../packages/server/src/modules/studio/services/plugins/installer'
import { PluginManager } from '../../packages/server/src/modules/studio/services/plugins/manager'
import { PluginDevelopment } from '../../packages/server/src/modules/studio/services/plugins/development'
import { registerPlugin } from '../../bin/plugin-development.mjs'

const who = { userId: 1, profile: 'default' }, cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })

it('keeps installation, development linking, switching, upgrade failure, uninstall and reinstall consistent in the real host', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'plugin-lifecycle-'))); cleanup.push(() => rm(home, { recursive: true, force: true }))
  const packageAt = async (name: string, version: string, broken = false) => {
    const directory = join(home, name); await mkdir(directory)
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'notes', version, type: 'module' }))
    await writeFile(join(directory, 'plugin.json'), JSON.stringify({ id: 'notes', name: 'Notes', version, apiVersion: 1,
      repository: 'https://github.com/example/notes', permissions: [], server: 'server.mjs', configSchema: { type: 'object', properties: { prefix: { type: 'string' } } } }))
    await writeFile(join(directory, 'server.mjs'), broken ? 'export function apply() { throw new Error("broken release") }'
      : `export function apply(ctx) { ctx.extensions.rpc.register('version', async () => '${version}') }`)
    return directory
  }
  const project = await packageAt('development', '0.1.6'), release = await packageAt('release', '0.1.4')
  const next = await packageAt('next', '0.1.7'), broken = await packageAt('broken', '0.1.7', true)
  const source = (commit: string) => 'github:example/notes#' + commit.repeat(40)
  const realInstall = installer.installPackage
  vi.spyOn(installer, 'installPackage').mockImplementation((root, input) => realInstall(root, ({ [source('a')]: release, [source('b')]: next, [source('c')]: broken })[input] || input))
  const manager = new PluginManager(join(home, 'plugins'), { authorize() {}, api: async () => null, emit() {}, log() {} })
  cleanup.push(() => manager.close())
  const development = new PluginDevelopment(manager, () => {}); cleanup.push(() => development.close())
  const revision = () => manager.snapshot().revision
  await manager.install(who, source('a'), revision(), 'notes', { expectedVersion: '0.1.4' })
  await manager.update(who, 'notes', revision(), { enabled: true, config: { prefix: 'saved setting' } })
  const storage = manager.store.storage('notes', () => {}); await storage.set('saved', 'saved data')
  await registerPlugin(project, home)
  await development.start(who, 'notes', revision())
  expect(manager.snapshot().plugins[0]).toMatchObject({ manifest: { version: '0.1.6' }, developmentDirectory: project, config: { prefix: 'saved setting' } })
  await development.unlink(who, 'notes', revision())
  expect(manager.snapshot().plugins[0]).toMatchObject({ manifest: { version: '0.1.6' }, source: project, status: 'active' })
  expect(manager.snapshot().plugins[0].developmentDirectory).toBeUndefined()
  await registerPlugin(project, home)
  await manager.install(who, source('a'), revision(), 'notes', { expectedVersion: '0.1.4' })
  await development.tick(); await development.tick()
  expect(manager.snapshot().plugins[0]).toMatchObject({ manifest: { version: '0.1.4' }, source: source('a'), status: 'active', config: { prefix: 'saved setting' } })
  await expect(manager.install(who, source('c'), revision(), 'notes', { expectedVersion: '0.1.7' })).rejects.toThrow('broken release')
  expect(manager.snapshot().plugins[0]).toMatchObject({ manifest: { version: '0.1.4' }, status: 'active', source: source('a') })
  await manager.install(who, source('b'), revision(), 'notes', { expectedVersion: '0.1.7' })
  expect(manager.snapshot().plugins[0]).toMatchObject({ manifest: { version: '0.1.7' }, previousVersion: '0.1.4', config: { prefix: 'saved setting' } })
  await expect(manager.update(who, 'notes', revision() - 1, { action: 'uninstall' })).rejects.toMatchObject({ code: 'PLUGIN_REVISION' })
  await manager.update(who, 'notes', revision(), { action: 'uninstall' })
  await development.tick(); await development.tick()
  expect(manager.snapshot().plugins).toEqual([])
  expect(() => manager.runtime(who, 'notes')).toThrow('unavailable')
  expect(await storage.get('saved')).toBe('saved data')
  await access(join(project, 'server.mjs'))
  expect((await development.list()).projects).toHaveLength(1)
  await manager.install(who, source('a'), revision(), 'notes', { expectedVersion: '0.1.4' })
  expect(manager.snapshot().plugins[0]).toMatchObject({ manifest: { version: '0.1.4' }, source: source('a'), status: 'disabled' })
  expect(await storage.get('saved')).toBe('saved data')
})
