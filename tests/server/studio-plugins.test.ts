import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { PluginManager } from '../../packages/server/src/modules/studio/services/plugins/manager'
import { PluginRuntime, type PluginPorts } from '../../packages/server/src/modules/studio/services/plugins/runtime'
import { PluginStore } from '../../packages/server/src/modules/studio/services/plugins/store'
import { PluginEffects } from '../../packages/server/src/modules/studio/services/plugins/effects'
import { configuration, manifest } from '../../packages/server/src/modules/studio/services/plugins/schema'
import type { PluginContext, PluginIdentity, PluginManifest } from '../../packages/plugin-sdk/src'
import type { PluginRecord } from '../../packages/server/src/modules/studio/contracts/plugins'

const who: PluginIdentity = { userId: 1, profile: 'one' }
const definition: PluginManifest = { id: 'notes', name: 'Notes', version: '1.0.0', apiVersion: 1, server: 'server.mjs', client: 'client.mjs', capabilities: ['tools', 'commands', 'api.read', 'api.write', 'events', 'hooks', 'automation', 'ui'], views: [{ id: 'home', title: 'Notes', slot: 'page' }] }
const directories: string[] = [], managers: PluginManager[] = []
const ports = (): PluginPorts => ({ api: vi.fn(async (_identity, path) => ({ path })), authorize: vi.fn(), emit: vi.fn(), log: vi.fn() })
async function home() { const dir = await mkdtemp(join(tmpdir(), 'studio-plugins-')); directories.push(dir); return dir }
const server = `export function apply(ctx) {
  ctx.tools.register({ name: 'read', description: 'Read a note', readOnly: true, inputSchema: { type:'object', properties:{key:{type:'string'}}, required:['key'], additionalProperties:false }, async execute(input, run) { const count = (await ctx.storage.get('count') || 0) + 1; await ctx.storage.set('count', count); return { ok:true, content: String(await run.storage.get(input.key) || ''), data:{count} } } });
  ctx.commands.register({name:'echo',description:'Echo',async execute(args,run){ return {args,profile:run.identity.profile} }});
  ctx.automation.register({name:'digest',description:'Digest',inputSchema:{type:'object',properties:{input:{type:'string'}}},async execute(input,run){return {input,session:run.identity.sessionId || null}}});
  ctx.rpc.register('write',async (input,run)=>{await run.storage.set(input.key,input.value);return input.value});
  ctx.onDispose(async ()=>{globalThis.__pluginDisposed = (globalThis.__pluginDisposed || 0) + 1});
}`
async function source(dir: string, version = '1.0.0', code = server) {
  const directory = join(dir, `source-${version}`); await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'studio-notes-test', type: 'module', version }))
  await writeFile(join(directory, 'plugin.json'), JSON.stringify({ ...definition, version }))
  await writeFile(join(directory, 'server.mjs'), code); await writeFile(join(directory, 'client.mjs'), 'export function mount(element) { element.textContent = "Notes" }')
  return directory
}
afterEach(async () => { for (const manager of managers.splice(0)) await manager.close(); for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); vi.useRealTimers() })

describe('Studio plugin host', () => {
  it('stores global plugin data and explicit cumulative namespaces without mixing plugins or paths', async () => {
    const store = new PluginStore(await home()), signal = new AbortController()
    const storage = store.storage('first', () => signal.signal.throwIfAborted())
    await storage.set('value', 'global')
    const privateStore = storage.namespace('users', '1').namespace('profiles', 'work')
    await privateStore.set('value', 'private')
    expect(await storage.get('value')).toBe('global')
    expect(await storage.namespace('users', '1', 'profiles', 'work').get('value')).toBe('private')
    expect(await storage.namespace('users', '2', 'profiles', 'work').get('value')).toBeUndefined()
    expect(await store.storage('second', () => {}).get('value')).toBeUndefined()
    await storage.namespace('../shared').set('value', 'literal namespace')
    expect(await storage.namespace('..', 'shared').get('value')).toBeUndefined()
    expect(await privateStore.keys()).toEqual(['value'])
    await privateStore.delete('value'); expect(await privateStore.keys()).toEqual([])
    for (const segments of [[''], [42], Array(17).fill('a'), ['a'.repeat(257)]]) expect(() => storage.namespace(...segments as string[])).toThrow('Invalid storage namespace')
    await expect(storage.set('__proto__', {})).rejects.toThrow('Invalid storage key')
    expect(await storage.get('toString')).toBeUndefined()
    signal.abort(); await expect(privateStore.set('late', true)).rejects.toThrow()
    expect(() => storage.namespace('late')).toThrow()
  })
  it('loads the SDK and reloads an ESM plugin through the development CommonJS loader', async () => {
    const dir = await home()
    const script = `
      const { PluginManager } = require('./packages/server/src/modules/studio/services/plugins/manager');
      const assert = require('node:assert/strict');
      const identity = { userId: 1, profile: 'development-test' };
      const manager = new PluginManager(process.argv[1], {
        api: async () => null, authorize() {}, emit() {}, log() {},
      });
      (async () => {
        try {
          await manager.install(identity, require('node:path').resolve('examples/plugins/notebook'), 0);
          await manager.update(identity, 'notebook', 1, { enabled: true });
          await manager.callTool(identity, 'notebook/append', { text: 'development loader' });
          await manager.update(identity, 'notebook', 2, { action: 'reload' });
          const result = await manager.callTool(identity, 'notebook/list', {});
          assert.equal(result.data[0].text, 'development loader');
          console.log('development plugin load and reload passed');
        } finally { await manager.close(); }
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `
    const { stdout } = await promisify(execFile)(process.execPath, ['-r', 'ts-node/register', '-e', script, dir], {
      cwd: resolve('.'), timeout: 30000,
      env: { ...process.env, TS_NODE_PROJECT: 'packages/server/tsconfig.json', TS_NODE_FILES: 'true' },
    })
    expect(stdout).toContain('development plugin load and reload passed')
  }, 35000)
  it('runs the shipped frontend, full-stack and automation examples through the actual installer', async () => {
    const dir = await home(), manager = new PluginManager(dir, ports()); managers.push(manager)
    for (const id of ['session-dashboard', 'notebook', 'activity-digest']) {
      await manager.install(who, resolve('examples/plugins', id), manager.snapshot(who).revision)
      await manager.update(who, id, manager.snapshot(who).revision, { enabled: true })
    }
    expect(manager.snapshot(who).plugins.every(plugin => plugin.status === 'active')).toBe(true)
    const notebook = manager.runtime(who, 'notebook')
    await notebook.invoke('rpc', 'set-preferences', { filter: 'done' }, who)
    expect(await notebook.invoke('rpc', 'get-preferences', null, who)).toBe('done')
    expect(await notebook.invoke('rpc', 'get-preferences', null, { userId: 2, profile: 'one' })).toBe('all')
    await expect(notebook.invoke('rpc', 'set-preferences', { filter: 'invalid' }, who)).rejects.toThrow()
    await notebook.invoke('rpc', 'append', { text: 'from UI' }, who)
    await manager.callTool({ ...who, sessionId: 'agent-session' }, 'notebook/append', { text: 'from Agent' })
    const notes = await notebook.invoke('rpc', 'list', null, who) as any[]
    expect(notes.map(note => note.text)).toEqual(['from UI', 'from Agent'])
    expect(manager.poll(who, 0, 'notebook').events.filter(event => event.type === 'notebook.updated')).toHaveLength(2)
    await manager.dispatch({ id: 'event', identity: who, type: 'chat.completed', timestamp: Date.now(), data: {} })
    expect(await manager.runtime(who, 'activity-digest').invoke('action', 'digest', {}, who)).toMatchObject({ eventCount: 1 })
    expect(await manager.runtime(who, 'activity-digest').invoke('action', 'digest', {}, { userId: 2, profile: 'other' })).toMatchObject({ eventCount: 0 })
    expect(await manager.client(who, 'session-dashboard')).toBeTruthy()
    await Promise.all([
      notebook.invoke('rpc', 'update', { id: notes[0].id, done: true }, who),
      notebook.invoke('command', 'note', 'from command', who),
      notebook.invoke('action', 'capture', { input: 'from workflow' }, who),
    ])
    const updated = await notebook.invoke('rpc', 'list', null, who) as any[]
    expect(updated).toHaveLength(4)
    expect(updated.find(note => note.id === notes[0].id)).toMatchObject({ done: true, origin: 'ui' })
    expect(updated.map(note => note.origin)).toEqual(['ui', 'tool', 'command', 'workflow'])
    await expect(notebook.invoke('rpc', 'append', { text: '  ' }, who)).rejects.toThrow()
    await expect(notebook.invoke('rpc', 'update', { id: notes[0].id, done: 'yes' }, who)).rejects.toThrow()
    await notebook.invoke('rpc', 'remove', { id: notes[1].id }, who)
    await manager.update(who, 'notebook', manager.snapshot(who).revision, { action: 'reload' })
    const persisted = await manager.runtime(who, 'notebook').invoke('rpc', 'list', null, who) as any[]
    expect(persisted.map(note => note.text)).toEqual(['from UI', 'from command', 'from workflow'])
    expect(persisted[0].done).toBe(true)
    expect(await manager.runtime(who, 'notebook').invoke('rpc', 'get-preferences', null, who)).toBe('done')
  })
  it('installs disabled, registers all capabilities on enable, preserves global data and removes registrations on disable', async () => {
    const dir = await home(), manager = new PluginManager(join(dir, 'host'), ports()); managers.push(manager)
    await manager.install(who, await source(dir), 0)
    expect(manager.snapshot(who).plugins[0].status).toBe('disabled')
    await manager.update(who, 'notes', 1, { enabled: true })
    const plugin = manager.snapshot(who).plugins[0]
    expect([plugin.tools[0].name, plugin.commands[0].name, plugin.actions[0].name]).toEqual(['read', 'echo', 'digest'])
    const runtime = manager.runtime(who, 'notes'), scope = { ...who, sessionId: 's1' }
    await runtime.invoke('rpc', 'write', { key: 'note', value: 'hello' }, scope)
    expect(await manager.callTool(scope, 'notes/read', { key: 'note' })).toMatchObject({ ok: true, content: 'hello', data: { count: 1 } })
    expect(await manager.callTool({ ...who, sessionId: 's2' }, 'notes/read', { key: 'note' })).toMatchObject({ content: 'hello', data: { count: 2 } })
    expect(manager.runtime({ userId: 2, profile: 'other' }, 'notes')).toBe(runtime)
    await runtime.invoke('rpc', 'write', { key: 'note', value: 'another account' }, { ...who, userId: 2 })
    expect(await manager.callTool({ ...who, userId: 2 }, 'notes/read', { key: 'note' })).toMatchObject({ content: 'another account', data: { count: 3 } })
    expect(await manager.callTool(scope, 'notes/read', { key: 'note' })).toMatchObject({ content: 'another account' })
    await expect(manager.callTool(scope, 'notes/read', { key: 42 })).rejects.toThrow(/string/)
    await manager.update(who, 'notes', 2, { enabled: false })
    expect(runtime.tools.size).toBe(0); expect(runtime.effects.controller.signal.aborted).toBe(true)
    await expect(runtime.invoke('command', 'echo', '', who)).rejects.toThrow(/expired/)
    await manager.update(who, 'notes', 3, { enabled: true })
    expect(await manager.callTool(scope, 'notes/read', { key: 'note' })).toMatchObject({ content: 'another account' })
  })
  it('restores enabled plugins, upgrades and rolls back; a failed activation preserves the previous version', async () => {
    const dir = await home(), root = join(dir, 'host'), manager = new PluginManager(root, ports()); managers.push(manager)
    await manager.install(who, await source(dir), 0); await manager.update(who, 'notes', 1, { enabled: true })
    await manager.install(who, await source(dir, '2.0.0'), 2, 'notes')
    expect(manager.snapshot(who).plugins[0].previousVersion).toBe('1.0.0')
    await manager.update(who, 'notes', 3, { action: 'rollback' })
    expect(manager.snapshot(who).plugins[0].manifest.version).toBe('1.0.0')
    await expect(manager.install(who, await source(dir, '3.0.0', 'export function apply(){throw new Error("broken upgrade")}'), 4, 'notes')).rejects.toThrow('broken upgrade')
    expect(manager.snapshot(who).plugins[0]).toMatchObject({ status: 'active', manifest: { version: '1.0.0' } })
    await manager.close()
    const restored = new PluginManager(root, ports()); managers.push(restored); await restored.restore()
    expect(await restored.runtime(who, 'notes').invoke('command', 'echo', 'hi', who)).toEqual({ args: 'hi', profile: 'one' })
    await restored.update(who, 'notes', 4, { action: 'uninstall' })
    expect(restored.snapshot(who).plugins).toEqual([])
  })
  it('rejects stale concurrent mutations without duplicating registrations', async () => {
    const dir = await home(), manager = new PluginManager(join(dir, 'host'), ports()); managers.push(manager)
    await manager.install(who, await source(dir), 0)
    const result = await Promise.allSettled([manager.update(who, 'notes', 1, { enabled: true }), manager.update({ userId: 2, profile: 'another' }, 'notes', 1, { enabled: true })])
    expect(result.map(x => x.status)).toEqual(['fulfilled', 'rejected'])
    expect(manager.snapshot(who).plugins[0].tools).toHaveLength(1)
  })
  it('allows a disabled plugin to be installed before required configuration is supplied', () => {
    const schema = { type: 'object' as const, properties: { token: { type: 'string' as const, secret: true } }, required: ['token'] }
    expect(configuration(schema, {}, false)).toEqual({})
    expect(() => configuration(schema, {})).toThrow(/missing token/)
    expect(() => manifest({ ...definition, apiVersion: 2 })).toThrow(/Unsupported/)
  })
  it('binds concurrent identities and API calls while plugins explicitly partition storage by account and Profile', async () => {
    const dir = await home(), access = ports(), revoked = new Set<number>()
    access.authorize = identity => { if (revoked.has(identity.userId)) throw new Error('access revoked') }
    access.api = vi.fn(async identity => ({ userId: identity.userId, profile: identity.profile }))
    const manager = new PluginManager(join(dir, 'host'), access); managers.push(manager)
    await manager.install(who, await source(dir, '1.0.0', `export function apply(ctx) {
      ctx.log.info('activated');
      const api = ctx.api;
      const storage = () => ctx.storage.namespace('users', String(ctx.identity.userId), 'profiles', ctx.identity.profile);
      ctx.rpc.register('probe', async (input, run) => {
        await storage().set('value', input.value);
        await new Promise(resolve => setTimeout(resolve, input.delay));
        run.ui.emit('probe', input.value);
        return { value: await storage().get('value'), root: ctx.identity, caller: run.identity, api: await api.studio.sessions.list() };
      });
      ctx.rpc.register('read', () => storage().get('value'));
      ctx.hooks.register('input.transform', async (_value, run) => ({ value: { userId: run.identity.userId, rootUser: ctx.identity.userId } }));
      ctx.on('activity', async () => { await Promise.resolve(); await storage().set('value', ctx.identity.profile) });
    }`), 0)
    await manager.update(who, 'notes', 1, { enabled: true })
    const second = { userId: 2, profile: 'work', sessionId: 'task', runId: 'run' }, third = { userId: 3, profile: 'personal' }
    expect(manager.snapshot(second)).toEqual(manager.snapshot(who))
    expect(await manager.client(third, 'notes')).toContain('Notes')
    const runtime = manager.runtime(who, 'notes')
    expect(manager.runtime(second, 'notes')).toBe(runtime)
    const [a, b] = await Promise.all([
      runtime.invoke('rpc', 'probe', { value: 'second', delay: 20 }, second),
      runtime.invoke('rpc', 'probe', { value: 'third', delay: 5 }, third),
    ])
    expect(a).toMatchObject({ value: 'second', root: second, caller: second, api: { userId: 2, profile: 'work' } })
    expect(b).toMatchObject({ value: 'third', root: third, api: { userId: 3, profile: 'personal' } })
    expect(manager.poll(second, 0).events.filter(event => event.type === 'probe').map(event => event.data)).toEqual(['second'])
    expect(manager.poll(third, 0).events.filter(event => event.type === 'probe').map(event => event.data)).toEqual(['third'])
    expect(manager.hasHooks(third, 'input.transform')).toBe(true)
    expect(await manager.transform(third, 'input.transform', null)).toEqual({ value: { userId: 3, rootUser: 3 } })
    await manager.dispatch({ id: 'event', type: 'activity', timestamp: Date.now(), identity: third, data: null })
    expect(await runtime.invoke('rpc', 'read', null, third)).toBe('personal')
    expect(await runtime.invoke('rpc', 'read', null, second)).toBe('second')
    expect(access.log).toHaveBeenCalledTimes(1)
    revoked.add(1)
    expect(await runtime.invoke('rpc', 'read', null, third)).toBe('personal')
    revoked.add(2)
    await expect(runtime.invoke('rpc', 'read', null, second)).rejects.toThrow('access revoked')
    await manager.update(third, 'notes', 2, { enabled: false })
    expect(manager.snapshot(who).plugins[0].status).toBe('disabled')
    expect(manager.poll(second, 0).events.some(event => event.type === 'plugin.changed')).toBe(true)
  })
  it('shares notebook data and update events across accounts, Profiles and sessions as the plugin chooses', async () => {
    const dir = await home(), manager = new PluginManager(dir, ports()); managers.push(manager)
    await manager.install(who, resolve('examples/plugins/notebook'), 0)
    await manager.update(who, 'notebook', 1, { enabled: true })
    const otherAccount = { userId: 2, profile: who.profile }, otherProfile = { ...who, profile: 'other' }
    await Promise.all([manager.callTool(who, 'notebook/append', { text: 'shared note' }), manager.callTool(otherAccount, 'notebook/append', { text: 'other account note' })])
    for (const caller of [who, otherAccount, otherProfile, { ...otherAccount, sessionId: 'different-session' }]) {
      expect((await manager.callTool(caller, 'notebook/list', {})).data).toMatchObject([{ text: 'shared note' }, { text: 'other account note' }])
      expect(manager.poll(caller, 0, 'notebook').events.filter(event => event.type === 'notebook.updated')).toHaveLength(2)
    }
  })
  it('starts one recurring scheduler for a globally enabled plugin and stops it for all callers', async () => {
    const dir = await home(), access = ports(), manager = new PluginManager(dir, access); managers.push(manager)
    await manager.install(who, await source(dir, '1.0.0', `export function apply(ctx) {
      ctx.automation.register({ name:'tick', description:'Tick', inputSchema:{type:'object'}, async execute(){ctx.log.info('tick');return null} });
      ctx.automation.every('timer',1000,'tick');
    }`), 0)
    vi.useFakeTimers()
    await manager.update(who, 'notes', 1, { enabled: true })
    for (const identity of [who, { userId: 2, profile: 'two' }, { userId: 3, profile: 'three' }]) expect(manager.runtime(identity, 'notes')).toBe(manager.runtime(who, 'notes'))
    await vi.advanceTimersByTimeAsync(2200)
    expect(access.log).toHaveBeenCalledTimes(2)
    await manager.update({ userId: 2, profile: 'two' }, 'notes', 2, { enabled: false })
    await vi.advanceTimersByTimeAsync(2200)
    expect(access.log).toHaveBeenCalledTimes(2)
  })
})

describe('Plugin context lifetime', () => {
  async function runtime() {
    const dir = await home(), record = { manifest: definition, directory: dir, source: dir, installedAt: Date.now(), enabled: true, config: {} } as PluginRecord
    return new PluginRuntime(record, who, new PluginStore(dir), ports())
  }
  it('expires invocation contexts on completion and aborts active calls on unload', async () => {
    const host = await runtime(); let captured: any
    await host.load({ apply(ctx) { ctx.rpc.register('capture', (_input, run) => { captured = run; return null }); ctx.rpc.register('wait', async (_input, run) => new Promise((_resolve, reject) => run.signal.addEventListener('abort', () => reject(new Error('stopped'))))) } })
    await host.invoke('rpc', 'capture', null, who)
    await expect(captured.storage.set('late', true)).rejects.toThrow()
    expect(() => captured.storage.namespace('late')).toThrow()
    const call = host.invoke('rpc', 'wait', null, who); const failure = expect(call).rejects.toThrow()
    await Promise.resolve(); await host.close(); await failure
    expect(host.rpc.size).toBe(0)
  })
  it('cleans failed startup, orders hooks and isolates subscriber errors', async () => {
    const host = await runtime(); let cleanup = 0
    await expect(host.load({ apply(ctx) { ctx.onDispose(() => { cleanup++ }); throw new Error('setup') } })).rejects.toThrow('setup')
    expect(cleanup).toBe(1)
    const active = await runtime()
    await active.load({ apply(ctx) {
      ctx.hooks.register('input.transform', () => ({ value: 'second' }), 10)
      ctx.hooks.register('input.transform', () => ({ value: 'first' }), 0)
      ctx.on('test', () => { throw new Error('observer failed') })
    } })
    expect(await active.transform('input.transform', null, who)).toEqual({ value: 'second' })
    await active.observe({ id: 'e', type: 'test', identity: who, timestamp: Date.now(), data: null })
    expect(active.ports.log).toHaveBeenCalledWith('notes', who, 'error', expect.stringContaining('observer failed'), undefined)
    await active.close()
  })
  it('disposes asynchronous resources acquired during teardown exactly once', async () => {
    const effects = new PluginEffects(); let release!: (value: () => Promise<void>) => void; let closed = false
    const acquired = effects.acquire(() => new Promise(resolve => { release = resolve }))
    await Promise.resolve()
    const rejected = expect(acquired).rejects.toThrow(/expired/)
    const closing = effects.close()
    release(async () => { await new Promise(resolve => setTimeout(resolve, 5)); closed = true })
    await closing; expect(closed).toBe(true); await rejected
  })
  it('matches namespace events, deduplicates listeners and disposes subscriptions', async () => {
    const host = await runtime(), seen: any[] = []; let unsubscribe!: () => void
    const handler = (event: any, run: any) => { seen.push({ type: event.type, user: run.identity.userId }) }
    await host.load({ apply(ctx) {
      ctx.on('*', handler); unsubscribe = ctx.on('chat.*', handler); ctx.on('chat.run.*', handler)
      ctx.on('group.*', () => { throw new Error('unrelated namespace must not run') })
    } })
    await host.observe({ id: 'e', type: 'chat.run.started', identity: { ...who, userId: 2 }, timestamp: Date.now(), data: null })
    expect(seen).toEqual([{ type: 'chat.run.started', user: 2 }])
    unsubscribe(); await host.close()
    await host.observe({ id: 'e2', type: 'chat.run.started', identity: who, timestamp: Date.now(), data: null })
    expect(seen).toHaveLength(1)
  })
  it('enforces API capabilities and serializes recurring work', async () => {
    const host = await runtime(); let ctx!: PluginContext, running = 0, max = 0
    await host.load({ apply(context) {
      ctx = context
      ctx.automation.register({ name: 'tick', description: '', inputSchema: { type: 'object' }, async execute() { max = Math.max(max, ++running); await new Promise(resolve => setTimeout(resolve, 1500)); running--; return null } })
      ctx.automation.every('clock', 1000, 'tick')
    } })
    vi.useFakeTimers(); host.activate(); await vi.advanceTimersByTimeAsync(4200); expect(max).toBe(1)
    await host.close(); const calls = running; await vi.advanceTimersByTimeAsync(5000); expect(running).toBeLessThanOrEqual(calls)
    await expect(ctx.api.request('/api/studio/sessions')).rejects.toThrow()
  })
})
