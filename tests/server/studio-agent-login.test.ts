import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { AgentExecutionStore } from '../../packages/server/src/modules/studio/repositories/agent-execution-store'
import { AgentManagementStore } from '../../packages/server/src/modules/studio/repositories/agent-management-store'
import { PluginStore } from '../../packages/server/src/modules/studio/repositories/plugin-store'
import { AgentCoordinator } from '../../packages/server/src/modules/studio/services/agents/coordinator'
import { AgentRegistry } from '../../packages/server/src/modules/studio/services/agents/registry'
import { PluginHost } from '../../packages/server/src/modules/studio/services/plugins/host'
import { PluginEventBus } from '../../packages/server/src/modules/studio/services/events/plugin-events'
import { createExecutionContext } from '../../packages/server/src/modules/studio/services/context/execution'
import { parseAgentLogin } from '../../packages/server/src/modules/studio/services/agents/login-contract'
import { AgentCliInstallations } from '../../packages/server/src/modules/studio/services/agents/cli-installations'
import { AgentManagementOperations } from '../../packages/server/src/modules/studio/services/agents/management-operations'
import { nativeAgentLogin, StudioError, type ExecutionScope } from '../../packages/studio-plugin-sdk/src'

const scope: ExecutionScope = { scopeId: 'scope', principal: { kind: 'user', id: 'owner' }, profileId: 'one', surface: 'api', traceId: 'trace' }
let root: string, runner: string
const cleanups: Array<() => Promise<void>> = []
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'studio-login-'))
  runner = join(root, 'runner.cjs')
  await build({ entryPoints: ['packages/studio-plugin-runner/src/main.ts'], bundle: true, platform: 'node', target: 'node24.22.1', format: 'cjs', outfile: runner, logLevel: 'silent' })
})
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.useRealTimers(); vi.unstubAllEnvs() })
afterAll(async () => { await rm(root, { recursive: true, force: true }) })
function alive(pid: number) { try { process.kill(pid, 0); return true } catch { return false } }

async function setup(options: { crash?: boolean; grant?: boolean; install?: boolean } = {}) {
  const directory = await mkdtemp(join(root, 'artifact-')), pidPath = join(directory, 'pid'), crashPath = join(directory, 'crash')
  const db = new DatabaseSync(':memory:'), store = new AgentExecutionStore(db), managementStore = new AgentManagementStore(db)
  const pluginStore = new PluginStore(db), registry = new AgentRegistry(), events = new PluginEventBus()
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, authorize = vi.fn()
  const context = (scope: ExecutionScope, signal: AbortSignal) => createExecutionContext(scope, signal, logger, { authorize: async () => {}, agents: { list: async () => [] }, sessions: { get: async () => null } })
  const host = new PluginHost({ store: pluginStore, registry, events, context, logger, runnerPath: runner, artifactsRoot: join(root, 'installed'),
    eventContext: async (_state, _event, signal) => context(scope, signal), acceptEvents: async batch => { for (const event of batch) events.publish(event) } })
  const coordinator = new AgentCoordinator({ store, registry, events, logger, authorize, authorizeManagement: authorize, managementStore, context,
    leaseManagement: (...args) => host.leaseManagement(...args), stateRoot: join(directory, 'private-state') })
  cleanups.push(async () => { await coordinator.close(); await host.close(); events.close(); db.close() })
  await writeFile(join(directory, 'cli.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
    process.stdin.setRawMode(true); process.stdin.setEncoding('utf8');
    process.stdout.write('READY ' + process.stdout.columns + 'x' + process.stdout.rows + '\\r\\n');
    let count = 0, pending = ''; process.stdin.on('data', data => { pending += data;
      let end; while ((end = pending.search(/[\\r\\n]/)) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1); if (!line) continue;
        require('node:fs').writeFileSync(${JSON.stringify(pidPath + '.count')}, String(++count));
        process.stdout.write('ACK:' + count + ':' + line + '\\r\\n');
        if(line === 'exit') setTimeout(() => process.exit(0), 10);
      } });`)
  const capabilities = ['agents.register', ...(options.grant === false ? [] : ['processes.spawn'])]
  await writeFile(join(directory, 'studio-plugin.json'), JSON.stringify({ schemaVersion: 1, id: 'test.login', version: '1.0.0', engines: { studioSdk: '^0.1.0', rpc: 1 },
    backend: 'index.cjs', activation: 'profile', contributes: { agents: ['test.login/agent'] }, requires: { capabilities }, configSchema: {} }))
  await writeFile(join(directory, 'index.cjs'), `module.exports = { apply(plugin) {
    plugin.agents.register({ id: 'test.login/agent', name: 'Login fixture', configSchema: {}, capabilities: { text: true, modes: ['global'] },
      management: { ${options.install ? `prepareInstall: async () => ({kind:'npm',packageName:'fixture-cli',version:'1.0.0',bin:'fixture',runner:'node'}),` : ''} prepareLogin: async (_input, context) => {
        ${options.crash ? `setInterval(() => { if(require('node:fs').existsSync(${JSON.stringify(crashPath)})) process.exit(17); }, 20);` : ''}
        if (context.nativeCli?.state === 'ready') return {command:context.nativeCli.command,args:[...context.nativeCli.args],cwd:${JSON.stringify(directory)}};
        return { command: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(join(directory, 'cli.cjs'))}], cwd: ${JSON.stringify(directory)} };
      } }, create: async () => { throw new Error('Login must not create a runtime'); } });
  } }`)
  await host.install(directory)
  const profile = await host.configure({ pluginId: 'test.login', profileId: 'one', ownerId: 'owner', enabled: true, config: {}, grants: capabilities }, 0)
  const instance = coordinator.createInstance(scope, { agentTypeId: 'test.login/agent', config: {}, mode: 'global' })
  const operations = coordinator.managementOperations!
  const start = (key = 'login') => coordinator.startLogin(scope, instance.id, 1, key)
  const ready = async (id: string, text = 'READY') => {
    await vi.waitFor(() => expect(operations.output(scope, id, 0).chunks.map(chunk => Buffer.from(chunk.data, 'base64').toString()).join('')).toContain(text))
    return Number(await readFile(pidPath, 'utf8'))
  }
  const ended = async (id: string, status: string) => { await operations.wait(scope, id); expect(operations.get(scope, id).status).toBe(status) }
  return { directory, db, store, managementStore, coordinator, host, registry, logger, authorize, instance, operations, profile, start, ready, ended, crashPath, pidPath }
}

it('runs native login through a real worker and PTY with retry-safe receipts and input', async () => {
  const f = await setup(), receipt = f.start()
  expect(receipt).toMatchObject({ action: 'login', status: 'starting', configRevision: 1 })
  expect(receipt).not.toHaveProperty('idempotencyKey')
  expect(f.start()).toEqual(receipt)
  const pid = await f.ready(receipt.id)
  expect(alive(pid)).toBe(true)
  expect(f.registry.list('one')[0].management).toEqual({ prepareLogin: true })
  expect(f.host.diagnostic('test.login', 'one').hasActiveLeases).toBe(true)
  for (const [sequence, text] of [[0, 'input'], [1, ''], [1, 'x'.repeat(65_537)]] as const) await expect(f.operations.input(scope, receipt.id, sequence, text)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  expect(() => f.operations.output(scope, receipt.id, -1)).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
  await f.operations.resize(scope, receipt.id, { cols: 100, rows: 40 })
  await Promise.all([f.operations.input(scope, receipt.id, 1, 'private-input\r'), f.operations.input(scope, receipt.id, 1, 'private-input\r')])
  await f.ready(receipt.id, 'ACK:1:private-input')
  await expect(f.operations.input(scope, receipt.id, 1, 'different')).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  await expect(f.operations.input(scope, receipt.id, 3, 'skip')).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  expect(f.operations.output(scope, receipt.id, 0).nextInputSequence).toBe(2)
  await f.operations.input(scope, receipt.id, 2, 'exit\r')
  await f.ended(receipt.id, 'completed')
  await expect(f.operations.input(scope, receipt.id, 2, 'exit\r')).resolves.toBeUndefined()
  expect(alive(pid)).toBe(false)
  expect(Number(await readFile(`${f.pidPath}.count`, 'utf8'))).toBe(2)
  const ended = f.operations.get(scope, receipt.id)
  expect(ended).toMatchObject({ status: 'completed', exit: { code: 0 }, errorCode: null })
  expect(ended).not.toHaveProperty('authentication')
  expect(f.store.instance(f.instance.id)).toEqual(f.instance)
  expect(f.db.prepare('SELECT count(*) AS count FROM studio_agent_runs').get()?.count).toBe(0)
  expect(JSON.stringify(f.db.prepare('SELECT * FROM studio_agent_management_operations').all())).not.toContain('private-input')
  expect(f.logger.info).not.toHaveBeenCalled()
  expect(f.logger.warn).not.toHaveBeenCalled()
  expect(f.host.diagnostic('test.login', 'one').hasActiveLeases).toBe(false)
})

async function installFixture(options: { grant?: boolean; crash?: boolean } = {}) {
  const f = await setup({ ...options, install: true }), path = join(f.directory, 'npm-cli.js'), gate = join(f.directory, 'install-mode')
  await writeFile(path, `const fs=require('node:fs'),path=require('node:path');
    const prefix=process.argv[process.argv.indexOf('--prefix')+1],mode=fs.existsSync(${JSON.stringify(gate)})?fs.readFileSync(${JSON.stringify(gate)},'utf8'):'';
    fs.writeFileSync(${JSON.stringify(f.pidPath)},String(process.pid));process.stdout.write('INSTALLING\\n');
    const finish=()=>{if(mode==='fail')process.exit(3);
      const root=path.join(prefix,'node_modules','fixture-cli');fs.mkdirSync(root,{recursive:true});
      fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'fixture-cli',version:mode==='wrong'?'2.0.0':'1.0.0',bin:{fixture:'cli.cjs'}}));
      fs.writeFileSync(path.join(root,'cli.cjs'),mode==='probe'?"process.stdout.write('9.9.9\\n')":${JSON.stringify("process.stdout.write(process.argv.includes('--version')?'1.0.0\\n':'MANAGED CLI\\n');setTimeout(()=>process.exit(0),25)")});
      process.stdout.write('INSTALLED\\n');};
    if(mode==='wait')setInterval(()=>{},1000);else finish();`)
  vi.stubEnv('npm_execpath', path)
  return { ...f, gate, cache: new AgentCliInstallations(join(f.directory, 'private-state')),
    install: (key = 'install') => f.coordinator.startInstall(scope, f.instance.id, 1, key) }
}

it('installs through a real worker and managed process, then uses the selected CLI in login', async () => {
  const f = await installFixture(), receipt = f.install()
  expect(receipt).toMatchObject({ action: 'install', status: 'starting' })
  expect(f.install().id).toBe(receipt.id)
  expect(() => f.start('install')).toThrow(expect.objectContaining({ code: 'REVISION_CONFLICT' }))
  await f.ended(receipt.id, 'completed')
  const installed = f.cache.load(f.instance, receipt.provider)
  expect(installed).toMatchObject({ state: 'ready', command: process.execPath })
  expect(f.registry.list('one')[0].management).toEqual({ prepareLogin: true, prepareInstall: true })
  await expect(f.operations.input(scope, receipt.id, 1, 'input')).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
  await expect(f.operations.resize(scope, receipt.id, { cols: 80, rows: 24 })).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
  const login = f.start('after-install')
  await f.ended(login.id, 'completed')
  expect(f.operations.output(scope, login.id, 0).chunks.map(chunk => Buffer.from(chunk.data, 'base64').toString()).join('')).toContain('MANAGED CLI')
  expect(f.store.instance(f.instance.id)).toEqual(f.instance)
  expect(f.db.prepare('SELECT count(*) AS count FROM studio_agent_runs').get()?.count).toBe(0)
})

it.each(['fail', 'wrong', 'probe', 'wait'])('preserves the working CLI after %s installation and releases management only after cleanup', async mode => {
  const f = await installFixture(), first = f.install()
  await f.ended(first.id, 'completed')
  const previous = f.cache.load(f.instance, first.provider)
  await writeFile(f.gate, mode)
  const next = f.install(`next-${mode}`)
  if (mode === 'wait') {
    const pid = await f.ready(next.id, 'INSTALLING')
    expect(() => f.coordinator.start(scope, f.instance.id, { content: [{ type: 'text', text: 'busy' }] }, 'busy')).toThrow(expect.objectContaining({ code: 'REVISION_CONFLICT' }))
    await f.operations.cancel(scope, next.id)
    expect(alive(pid)).toBe(false)
  }
  await f.ended(next.id, mode === 'wait' ? 'cancelled' : 'failed')
  expect(f.cache.load(f.instance, first.provider)).toEqual(previous)
  expect(f.host.diagnostic('test.login', 'one').hasActiveLeases).toBe(false)
  expect(await f.coordinator.updateInstance(scope, f.instance.id, { revision: 1, config: {}, mode: 'global' })).toMatchObject({ revision: 2 })
})

it('locks the instance and plugin configuration until terminal cleanup is confirmed', async () => {
  const f = await setup(), receipt = f.start(), pid = await f.ready(receipt.id)
  expect(() => f.start('another')).toThrow(expect.objectContaining({ code: 'REVISION_CONFLICT' }))
  expect(() => f.coordinator.start(scope, f.instance.id, { content: [{ type: 'text', text: 'run' }] }, 'run')).toThrow(expect.objectContaining({ code: 'REVISION_CONFLICT' }))
  await expect(f.coordinator.updateInstance(scope, f.instance.id, { revision: 1, config: {}, mode: 'global' })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  await expect(f.host.configure({ ...f.profile, enabled: false }, 1)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  await expect(f.host.uninstall('test.login')).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  expect(alive(pid)).toBe(true)
  expect(await f.operations.cancel(scope, receipt.id)).toMatchObject({ status: 'cancelled' })
  expect(alive(pid)).toBe(false)
  await f.host.configure({ ...f.profile, enabled: false }, 1)
  expect(f.start().id).toBe(receipt.id) // a retry does not start another process after provider removal
  expect(f.operations.output(scope, receipt.id, 0).finished).toBe(true)
})

it.each(['owner', 'profile', 'bound', 'revision', 'request-key'])('rejects %s mismatches before launching native code', async change => {
  const f = await setup(), receipt = f.start(), caller = structuredClone(scope)
  if (change === 'owner') caller.principal.id = 'foreign'
  if (change === 'profile') caller.profileId = 'other'
  if (change === 'bound') caller.runId = 'bound'
  const revision = change === 'revision' ? 2 : 1
  if (change === 'request-key') {
    expect(() => f.operations.previous(scope, 'other-instance', 1, 'login')).toThrow(expect.objectContaining({ code: 'REVISION_CONFLICT' }))
  } else {
    expect(() => f.coordinator.startLogin(caller, f.instance.id, revision, 'different')).toThrow(expect.objectContaining({ code: change === 'bound' ? 'FORBIDDEN' : change === 'revision' ? 'REVISION_CONFLICT' : 'NOT_FOUND' }))
    if (change !== 'revision') {
      expect(() => f.operations.get(caller, receipt.id)).toThrow()
      await expect(f.operations.cancel(caller, receipt.id)).rejects.toThrow()
    }
  }
  await f.operations.cancel(scope, receipt.id)
})

it('cancels the host-owned PTY when its worker crashes', async () => {
  const f = await setup({ crash: true }), receipt = f.start(), pid = await f.ready(receipt.id)
  await writeFile(f.crashPath, 'crash')
  await f.ended(receipt.id, 'interrupted')
  expect(f.operations.get(scope, receipt.id).errorCode).toBe('PLUGIN_UNAVAILABLE')
  expect(alive(pid)).toBe(false)
  await expect(f.coordinator.updateInstance(scope, f.instance.id, { revision: 1, config: {}, mode: 'global' })).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
})

it('requires both agent registration and process permission for host-owned login launches', async () => {
  const f = await setup({ grant: false }), receipt = f.start()
  await f.ended(receipt.id, 'failed')
  expect(f.operations.get(scope, receipt.id).errorCode).toBe('FORBIDDEN')
  expect(f.operations.output(scope, receipt.id, 0).chunks).toEqual([])
})

it('revokes a live terminal when owner authorization is removed', async () => {
  const f = await setup(), receipt = f.start(), pid = await f.ready(receipt.id)
  f.authorize.mockImplementation(() => { throw new StudioError('FORBIDDEN', 'Owner disabled') })
  await vi.waitFor(() => expect(alive(pid)).toBe(false))
  expect(() => f.operations.output(scope, receipt.id, 0)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  f.authorize.mockReset()
  await f.ended(receipt.id, 'failed')
})

it('bounds disconnected terminal output and reports cursor truncation', async () => {
  const db = new DatabaseSync(':memory:'), store = new AgentManagementStore(db)
  const operations = new AgentManagementOperations(store, () => {})
  try {
    let batch = 0
    const receipt = operations.start({ ownerId: scope.principal.id, profileId: scope.profileId, instanceId: 'buffered-instance', revision: 1,
      provider: { kind: 'builtin', module: 'ekko', implementationVersion: 'fixture' }, idempotencyKey: 'buffered-login' }, () => {}, control => control.consume({
      id: 'controlled-byte-stream', read: async () => ++batch <= 8 ? {
        chunks: Array.from({ length: 4 }, (_, index) => ({ stream: 'stdout' as const, data: Buffer.from(batch === 8 && index === 3 ? 'FLOOD_END'.padStart(16_384, 'x') : 'x'.repeat(16_384)) })),
        exit: null, truncated: false,
      } : { chunks: [], exit: { code: 0, signal: null }, truncated: false },
      write: async () => {}, stop: async () => {}, end: async () => {}, dispose: async () => {},
    }), () => {})
    await operations.wait(scope, receipt.id)
    let cursor = 0, text = '', bytes = 0, truncated = false
    while (true) {
      const output = operations.output(scope, receipt.id, cursor)
      expect(output.chunks.length).toBeLessThanOrEqual(4)
      text += output.chunks.map(chunk => Buffer.from(chunk.data, 'base64').toString()).join('')
      bytes += output.chunks.reduce((sum, chunk) => sum + Buffer.from(chunk.data, 'base64').length, 0)
      truncated ||= output.truncated
      cursor = output.lastSequence
      if (output.finished) break
    }
    expect(text).toContain('FLOOD_END'); expect(bytes).toBe(262_144); expect(truncated).toBe(true)
    vi.setSystemTime(Date.now() + 300_001)
    expect(operations.output(scope, receipt.id, 0)).toMatchObject({ chunks: [], truncated: true, finished: true })
  } finally { await operations.close(); db.close() }
})

it('marks interrupted metadata after a host restart without replaying the command', () => {
  const db = new DatabaseSync(':memory:')
  try {
    const first = new AgentManagementStore(db), input = { ownerId: 'owner', profileId: 'one', instanceId: 'instance', revision: 1,
      provider: { kind: 'builtin' as const, module: 'ekko' as const, implementationVersion: 'test' }, idempotencyKey: 'request' }
    const receipt = first.create(input, 600_000)
    first.running(receipt.id)
    const second = new AgentManagementStore(db)
    expect(second.get(receipt.id)?.status).toBe('running') // opening a repository is not a recovery event
    second.recoverInterrupted()
    expect(second.find('owner', 'one', 'request', 'instance', 1)).toMatchObject({ id: receipt.id, status: 'interrupted', errorCode: 'RUNTIME_UNAVAILABLE' })
  } finally { db.close() }
})

it('drains native login before coordinator shutdown and does not replay input', async () => {
  const f = await setup(), receipt = f.start(), pid = await f.ready(receipt.id)
  await f.coordinator.close()
  expect(alive(pid)).toBe(false)
  expect(f.operations.get(scope, receipt.id).status).toBe('interrupted')
  await expect(f.operations.input(scope, receipt.id, 1, 'late')).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
})

it.each(['cancel', 'revoke'])('releases admission when %s occurs before native dispatch', async action => {
  const f = await setup(), receipt = f.start()
  if (action === 'cancel') await f.operations.cancel(scope, receipt.id)
  else {
    f.authorize.mockImplementation(() => { throw new StudioError('FORBIDDEN', 'Revoked before dispatch') })
    await vi.waitFor(() => expect(f.managementStore.get(receipt.id)?.status).toBe('failed'))
    f.authorize.mockReset()
  }
  expect(f.operations.get(scope, receipt.id).status).toBe(action === 'cancel' ? 'cancelled' : 'failed')
  expect(f.operations.output(scope, receipt.id, 0).chunks).toEqual([])
  expect(await f.coordinator.updateInstance(scope, f.instance.id, { revision: 1, config: {}, mode: 'global' })).toMatchObject({ revision: 2 })
})

it('limits concurrent owner terminals and releases a rejected admission without creating an operation', async () => {
  const f = await setup(), instances = [f.instance, ...Array.from({ length: 4 }, () => f.coordinator.createInstance(scope, { agentTypeId: 'test.login/agent', config: {}, mode: 'global' }))]
  const receipts = instances.slice(0, 4).map((instance, index) => f.coordinator.startLogin(scope, instance.id, 1, `quota-${index}`))
  expect(() => f.coordinator.startLogin(scope, instances[4].id, 1, 'overflow')).toThrow(expect.objectContaining({ code: 'RESOURCE_EXHAUSTED' }))
  expect(f.operations.list(scope, instances[4].id)).toEqual([])
  await Promise.all(receipts.map(receipt => f.operations.cancel(scope, receipt.id)))
  expect(await f.coordinator.updateInstance(scope, instances[4].id, { revision: 1, config: {}, mode: 'global' })).toMatchObject({ revision: 2 })
})

it('validates the private launch DTO and keeps scoped Studio authentication separate', async () => {
  expect(() => parseAgentLogin({ command: 'native', args: [], cwd: process.cwd(), terminal: { cols: 80, rows: 24 } })).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
  const login = nativeAgentLogin('native', ['login', '--device-auth'])
  await expect(login({ instanceId: 'instance', mode: 'scoped', configRevision: 1, config: {} }, {} as never)).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
  expect(await login({ instanceId: 'instance', mode: 'global', configRevision: 1, config: { command: 'custom', args: ['literal argument'], cwd: process.cwd() } }, {} as never))
    .toEqual({ command: 'custom', args: ['literal argument', 'login', '--device-auth'], cwd: process.cwd() })
})

it('requires the process grant before invoking native installation', async () => {
  const f = await installFixture({ grant: false }), receipt = f.install()
  await f.ended(receipt.id, 'failed')
  expect(f.operations.get(scope, receipt.id).errorCode).toBe('FORBIDDEN')
  await expect(readFile(f.pidPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  expect(f.cache.load(f.instance, receipt.provider)).toBeUndefined()
})
