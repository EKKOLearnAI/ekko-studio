import { afterEach, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, access, realpath, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PluginDevelopment } from '../../packages/server/src/modules/studio/services/plugins/development'
import { PluginManager } from '../../packages/server/src/modules/studio/services/plugins/manager'
import { registerPlugin, scaffoldPlugin } from '../../bin/plugin-development.mjs'
import { builtinPluginDirectory } from '../../packages/server/src/modules/studio/services/plugins/builtin-directory'
import { reconcileBuiltinPlugins } from '../../packages/server/src/modules/studio/services/plugins/builtin'

const who = { userId: 1, profile: 'default' }, cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanups.splice(0).reverse()) await dispose() })
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'plugin-development-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const source = join(home, 'project')
  await scaffoldPlugin(source, 'notes'); await registerPlugin(source, home)
  const manager = new PluginManager(join(home, 'plugins'), { authorize() {}, emit() {}, log() {}, api: async () => null })
  cleanups.push(() => manager.close())
  const authorize = vi.fn(), changed = vi.fn(async () => {})
  const development = new PluginDevelopment(manager, authorize, changed)
  cleanups.push(() => development.close())
  const put = (text: string) => writeFile(join(source, 'server.mjs'), text)
  const value = () => manager.runtime(who, 'notes').invoke('rpc', 'read', null, who)
  return { home, source, manager, development, authorize, changed, put, value }
}
const code = (value: string) => `export function apply(ctx) { ctx.extensions.rpc.register('read', async () => ${JSON.stringify(value)}); ctx.lifecycle.add(() => {}); }`

it('loads the standalone OMP project from an arbitrary directory and preserves settings across development reloads', async () => {
  const home = await mkdtemp(join(tmpdir(), 'omp-development-')); cleanups.push(() => rm(home, { recursive: true, force: true }))
  const source = join(home, 'independent projects/omp')
  await cp(builtinPluginDirectory('omp'), source, { recursive: true })
  await registerPlugin(source, home)
  const manager = new PluginManager(join(home, 'plugins'), { authorize() {}, emit() {}, log() {}, api: async () => null })
  cleanups.push(() => manager.close())
  await reconcileBuiltinPlugins(manager, who)
  const settings = { executable: '', defaultModel: 'custom/test', models: { providers: {} }, config: {} }
  await manager.runtime(who, 'omp').invoke('rpc', 'save-settings', settings, who)
  const development = new PluginDevelopment(manager, () => {}); cleanups.push(() => development.close())
  await development.start(who, 'omp', manager.snapshot().revision)
  expect((await development.list()).projects[0]).toMatchObject({ id: 'omp', status: 'watching' })
  expect(manager.registeredAgents().map(agent => agent.id)).toEqual(['plugin:omp/omp'])
  await writeFile(join(source, 'client.mjs'), (await readFile(join(source, 'client.mjs'), 'utf8')) + '\n// development reload\n')
  const revision = manager.snapshot().revision
  await development.tick(); await development.tick()
  expect(manager.snapshot().revision).toBeGreaterThan(revision)
  expect(await manager.runtime(who, 'omp').invoke('rpc', 'get-settings', null, who)).toMatchObject(settings)
  await reconcileBuiltinPlugins(manager, who)
  expect(manager.snapshot().plugins[0].developmentDirectory).toBe(await realpath(source))
})

it('creates standalone projects through the shipped CLI, registers canonical directories and never overwrites another project', async () => {
  const home = await mkdtemp(join(tmpdir(), 'plugin-cli-')); cleanups.push(() => rm(home, { recursive: true, force: true }))
  const cli = (args: string[]) => promisify(execFile)(process.execPath, [resolve('bin/hermes-web-ui.mjs'), 'plugins', ...args], { env: { ...process.env, HERMES_WEB_UI_HOME: home } })
  await cli(['create', 'example'])
  const directory = join(home, 'plugin-projects', 'example')
  const listing = JSON.parse((await cli(['list'])).stdout)
  expect(listing.projects).toEqual([expect.objectContaining({ id: 'example', directory: await realpath(directory) })])
  expect(JSON.parse(await readFile(join(directory, 'sdk/package.json'), 'utf8')).name).toBe('@ekko-studio/plugin-sdk')
  await expect(cli(['create', 'example'])).rejects.toThrow(/already registered/)
  await cli(['dev', 'example']); await cli(['link', directory])
  const other = join(home, 'other'); await scaffoldPlugin(other, 'example')
  await expect(registerPlugin(other, home)).rejects.toThrow(/already registered/)
  await cli(['unlink', 'example'])
  expect(JSON.parse((await cli(['list'])).stdout).projects).toEqual([])
  await access(join(directory, 'server.mjs'))
  const results = await Promise.allSettled([registerPlugin(directory, home), registerPlugin(other, home)])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
})

it('lists without executing, loads in the real host, reloads nested modules and retains storage while pruning obsolete builds', async () => {
  const { source, manager, development, value, changed } = await fixture()
  await writeFile(join(source, 'nested.mjs'), 'export const value = "one"')
  await writeFile(join(source, 'server.mjs'), 'import { value } from "./nested.mjs"; export function apply(ctx) { ctx.extensions.rpc.register("read", async () => value) }')
  expect((await development.list()).projects[0]).toMatchObject({ id: 'notes', status: 'registered' })
  await development.tick(); expect(manager.snapshot().plugins).toHaveLength(0)
  await development.start(who, 'notes', 0)
  expect(await value()).toBe('one')
  await manager.runtime(who, 'notes').context().state.plugin.set('saved', 'keep')
  for (const version of ['two', 'three']) {
    await writeFile(join(source, 'nested.mjs'), `export const value = "${version}"`)
    await development.tick(); await development.tick()
    expect(await value()).toBe(version)
  }
  expect(await manager.runtime(who, 'notes').context().state.plugin.get('saved')).toBe('keep')
  expect(await readdir(join(manager.store.directory(), 'versions'))).toHaveLength(2)
  expect(changed).toHaveBeenCalledTimes(3)
  expect(manager.poll(who, 0).events.filter(event => event.type === 'plugin.changed')).toHaveLength(3)
  await manager.update(who, 'notes', manager.snapshot().revision, { action: 'stop-development' })
  await writeFile(join(source, 'nested.mjs'), 'export const value = "stopped"')
  await development.tick(); await development.tick()
  expect(await value()).toBe('three')
  expect((await development.list()).projects[0].status).toBe('registered')
})

it('keeps the working runtime after activation errors and retries only after another edit', async () => {
  const { source, manager, development, put, value } = await fixture()
  await put(code('stable')); await development.start(who, 'notes', 0)
  await put('export function apply() { throw new Error("bad plugin") }')
  await development.tick(); await development.tick()
  expect(await value()).toBe('stable')
  expect((await development.list()).projects[0]).toMatchObject({ status: 'error', error: expect.stringContaining('bad plugin') })
  const revision = manager.snapshot().revision
  await development.tick(); await development.tick(); expect(manager.snapshot().revision).toBe(revision)
  await put(code('fixed')); await development.tick(); await development.tick()
  expect(await value()).toBe('fixed')
  await rm(join(source, 'plugin.json'))
  expect((await development.list()).projects[0].status).toBe('missing')
  await development.tick(); expect(await value()).toBe('fixed')
})

it('runs optional builds, preserves the runtime on build failure and ignores output changes', async () => {
  const { source, manager, development, put, value } = await fixture()
  await put(code('initial')); await development.start(who, 'notes', 0)
  const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')); pkg.scripts.build = 'node compile.mjs'
  await writeFile(join(source, 'package.json'), JSON.stringify(pkg))
  await writeFile(join(source, 'compile.mjs'), 'console.error("compile error"); process.exit(1)')
  await development.tick(); await development.tick()
  expect(await value()).toBe('initial')
  expect((await development.list()).projects[0]).toMatchObject({ status: 'error', error: expect.stringContaining('compile error') })
  await mkdir(join(source, 'dist'))
  const manifest = JSON.parse(await readFile(join(source, 'plugin.json'), 'utf8')); manifest.server = 'dist/server.mjs'
  await writeFile(join(source, 'plugin.json'), JSON.stringify(manifest))
  await writeFile(join(source, 'compile.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync('dist/server.mjs', ${JSON.stringify(code('built'))})`)
  await development.tick(); await development.tick()
  expect(await value()).toBe('built')
  const revision = manager.snapshot().revision
  await writeFile(join(source, 'dist/ignored.txt'), 'output')
  await development.tick(); await development.tick(); expect(manager.snapshot().revision).toBe(revision)
})

it('lists unbuilt project metadata without executing its source', async () => {
  const { source, manager, development } = await fixture()
  const definition = JSON.parse(await readFile(join(source, 'plugin.json'), 'utf8'))
  await writeFile(join(source, 'plugin.json'), JSON.stringify({ ...definition, name: 'Unbuilt Notes', server: 'dist/server.mjs' }))
  const projects = (await development.list()).projects
  expect(projects[0]).toMatchObject({ id: 'notes', status: 'registered', manifest: { name: 'Unbuilt Notes', version: definition.version } })
  expect(manager.snapshot().plugins).toEqual([])
})

it('unlinks an active project without deleting source, installed files, storage or restarting the runtime', async () => {
  const { source, manager, development, put, value } = await fixture()
  await put(code('installed')); await development.start(who, 'notes', 0)
  const runtime = manager.runtime(who, 'notes'), installed = manager.store.read().records.notes.directory
  await runtime.context().state.plugin.set('saved', 'keep')
  await expect(development.unlink(who, 'notes', 0)).rejects.toMatchObject({ code: 'PLUGIN_REVISION' })
  expect((await development.list()).projects).toHaveLength(1)
  await development.unlink(who, 'notes', manager.snapshot().revision)
  expect((await development.list()).projects).toEqual([])
  expect(manager.snapshot().plugins[0]).toMatchObject({ status: 'active' })
  expect(manager.snapshot().plugins[0].developmentDirectory).toBeUndefined()
  expect(manager.runtime(who, 'notes')).toBe(runtime)
  expect(await runtime.context().state.plugin.get('saved')).toBe('keep')
  await access(join(source, 'server.mjs')); await access(join(installed, 'server.mjs'))
  await put(code('unlinked change')); await development.tick(); await development.tick()
  expect(await value()).toBe('installed')
})

it('unlinks a project with missing files and rejects unauthorized requests before changing registration', async () => {
  const { home, source, manager, development, authorize } = await fixture()
  authorize.mockImplementationOnce(() => { throw new Error('administrator required') })
  await expect(development.unlink(who, 'notes', 0)).rejects.toThrow('administrator required')
  await access(join(home, 'plugins/development/notes.json'))
  await development.start(who, 'notes', 0)
  await rm(manager.store.read().records.notes.directory, { recursive: true })
  await rm(source, { recursive: true })
  expect((await development.list()).projects[0].status).toBe('missing')
  await development.unlink(who, 'notes', manager.snapshot().revision)
  expect((await development.list()).projects).toEqual([])
  expect(manager.store.read().records.notes.developmentDirectory).toBeUndefined()
})

it('does not reactivate after a concurrent disable, unregister, stale revision or loss of administrator access', async () => {
  const { home, source, manager, development, put, authorize, value } = await fixture()
  await put(code('stable')); await development.start(who, 'notes', 0)
  await expect(development.start(who, 'notes', 0)).rejects.toMatchObject({ code: 'PLUGIN_REVISION' })
  const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')); pkg.scripts.build = 'node compile.mjs'
  await writeFile(join(source, 'package.json'), JSON.stringify(pkg))
  await writeFile(join(source, 'compile.mjs'), 'import { writeFileSync } from "node:fs"; writeFileSync("building", "1"); await new Promise(resolve => setTimeout(resolve, 300))')
  const pending = development.start(who, 'notes', manager.snapshot().revision)
  const rejection = expect(pending).rejects.toMatchObject({ code: 'PLUGIN_REVISION' })
  await vi.waitFor(async () => access(join(source, 'building')))
  await manager.update(who, 'notes', manager.snapshot().revision, { enabled: false })
  await rejection
  expect(manager.snapshot().plugins[0].enabled).toBe(false)
  delete pkg.scripts.build; await writeFile(join(source, 'package.json'), JSON.stringify(pkg))
  await development.start(who, 'notes', manager.snapshot().revision)
  await rm(join(home, 'plugins/development/notes.json'))
  await put(code('unregistered')); await development.tick(); await development.tick()
  expect(await value()).toBe('stable')
  await registerPlugin(source, home)
  authorize.mockImplementation(() => { throw new Error('administrator disabled') })
  await development.tick(); await development.tick()
  expect(await value()).toBe('stable')
  await expect(development.start(who, 'notes', manager.snapshot().revision)).rejects.toThrow('administrator disabled')
})

it('stops an in-flight build and its child compiler when the development host closes', async () => {
  const { source, manager, development } = await fixture()
  const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')); pkg.scripts.build = 'node compile.mjs'
  await writeFile(join(source, 'package.json'), JSON.stringify(pkg))
  await writeFile(join(source, 'compile.mjs'), 'import { writeFileSync } from "node:fs"; writeFileSync("compiler-pid", String(process.pid)); setInterval(() => {}, 1000)')
  const pending = development.start(who, 'notes', 0)
  const rejected = expect(pending).rejects.toThrow('cancelled')
  await vi.waitFor(async () => access(join(source, 'compiler-pid')))
  const pid = Number(await readFile(join(source, 'compiler-pid'), 'utf8'))
  await development.close(); await rejected
  await vi.waitFor(() => { expect(() => process.kill(pid, 0)).toThrow() })
  expect(manager.snapshot().plugins).toHaveLength(0)
})

it('creates a project from an installed npm layout without the Studio source checkout', async () => {
  const home = await mkdtemp(join(tmpdir(), 'plugin-installed-cli-')); cleanups.push(() => rm(home, { recursive: true, force: true }))
  const installation = join(home, 'node_modules/ekko-studio')
  await mkdir(join(installation, 'bin'), { recursive: true })
  await mkdir(join(installation, 'dist'), { recursive: true })
  for (const file of ['package.json', 'bin/hermes-web-ui.mjs', 'bin/plugin-development.mjs']) await cp(resolve(file), join(installation, file))
  await cp(resolve('packages/plugin-sdk'), join(installation, 'dist/plugin-sdk'), { recursive: true })
  await promisify(execFile)(process.execPath, [join(installation, 'bin/hermes-web-ui.mjs'), 'plugins', 'create', 'installed-demo'], { env: { ...process.env, HERMES_WEB_UI_HOME: home } })
  await access(join(home, 'plugin-projects/installed-demo/sdk/src/index.ts'))
  const pkg = JSON.parse(await readFile(join(home, 'plugin-projects/installed-demo/package.json'), 'utf8'))
  expect(pkg.devDependencies).toEqual({ '@ekko-studio/plugin-sdk': 'file:./sdk' })
})
