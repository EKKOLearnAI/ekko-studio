import { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { AgentExecutionStore } from '../../packages/server/src/modules/studio/repositories/agent-execution-store'
import { PluginStore } from '../../packages/server/src/modules/studio/repositories/plugin-store'
import { AgentCoordinator } from '../../packages/server/src/modules/studio/services/agents/coordinator'
import { AgentRegistry } from '../../packages/server/src/modules/studio/services/agents/registry'
import { PluginHost } from '../../packages/server/src/modules/studio/services/plugins/host'
import { PluginEventBus } from '../../packages/server/src/modules/studio/services/events/plugin-events'
import { createExecutionContext } from '../../packages/server/src/modules/studio/services/context/execution'
import { StudioError, type AgentRuntimeContext, type ExecutionScope } from '../../packages/studio-plugin-sdk/src'
import { createCursorRuntime } from '../../plugins/cursor/src/runtime'
import { prepareCursor } from '../../plugins/cursor/src/configuration'


const caller: ExecutionScope = { scopeId: 'scope', principal: { kind: 'user', id: 'owner' }, profileId: 'one', surface: 'api', traceId: 'trace' }
let root: string, runner: string
const cleanups: Array<() => Promise<void>> = []
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'studio-cursor-')); runner = join(root, 'runner.cjs')
  await build({ entryPoints: ['packages/studio-plugin-runner/src/main.ts'], bundle: true, platform: 'node', target: 'node24.22.1', format: 'cjs', outfile: runner, logLevel: 'silent' })
  const directory = join(root, 'plugins/cursor')
  await mkdir(join(directory, 'dist'), { recursive: true })
  await build({ entryPoints: ['plugins/cursor/src/index.ts'], bundle: true, platform: 'node', target: 'node24.22.1', format: 'cjs', outfile: join(directory, 'dist/index.cjs'), logLevel: 'silent',
    alias: { '@ekko-studio/plugin-sdk': join(process.cwd(), 'packages/studio-plugin-sdk/src/index.ts'), '@ekko-studio/agent-drivers': join(process.cwd(), 'packages/studio-agent-drivers/src/index.ts') } })
  for (const file of ['studio-plugin.json', 'package.json', 'README.md']) await writeFile(join(directory, file), await readFile(join('plugins/cursor', file)))
})
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
afterAll(async () => { await rm(root, { recursive: true, force: true }) })

const fixture = String.raw`const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2);
if(args.includes('--version')){fs.mkdirSync(process.env.CURSOR_CONFIG_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.CURSOR_CONFIG_DIR,'cli-config.json'),'{}');console.log('2026.10.22-27dcf5f');process.exit(0)}
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{
const resume=args.indexOf('--resume'),id=resume>=0&&fs.existsSync(process.env.CONTROL_FILE)?'different-session':resume<0?'cursor-native-session':args[resume+1],plugin=args.indexOf('--plugin-dir'),images=args.flatMap((arg,index)=>arg==='--image'?[{path:args[index+1],data:fs.readFileSync(args[index+1],'base64')}]:[]);
fs.writeFileSync(process.env.TRACE,JSON.stringify({args,input,home:process.env.HOME,images,plugin:plugin<0?null:{path:args[plugin+1],manifest:JSON.parse(fs.readFileSync(path.join(args[plugin+1],'.cursor-plugin/plugin.json'))),mcp:JSON.parse(fs.readFileSync(path.join(args[plugin+1],'mcp.json')))}}));
const send=x=>process.stdout.write(JSON.stringify(x)+'\n');
if(input==='crash')process.exit(7);
if(input==='wait'){setInterval(()=>{},1000);return}
send({type:'system',subtype:'init',session_id:id,model:'native-model'});
if(input==='malformed'){process.stdout.write('{bad\n');return}
if(input==='oversized'){process.stdout.write('x'.repeat(4*1024*1024+1));return}
send({type:'assistant',timestamp_ms:1,message:{content:[{type:'text',text:'Hello'}]},session_id:id});
send({type:'assistant',timestamp_ms:2,model_call_id:'buffered',message:{content:[{type:'text',text:'Hello'}]},session_id:id});
send({type:'assistant',message:{content:[{type:'text',text:'Hello'}]},session_id:id});
const tool={type:'tool_call',subtype:'started',call_id:'call',tool_call:{function:{name:'native_tool',arguments:'{"path":"README.md"}'}},session_id:id};send(tool);send(tool);
const done={...tool,subtype:'completed',tool_call:{function:{name:'native_tool',result:{success:{content:'done'}}}}};send(done);send(done);
if(input==='missing-result')return;
const result={type:'result',subtype:input==='failure'?'error':'success',is_error:input==='failure',result:'Hello',session_id:id,...(input==='unknown-usage'?{}:{usage:input==='bad-usage'?{inputTokens:-1,outputTokens:2}:{inputTokens:12,outputTokens:5,cacheReadTokens:3,cacheWriteTokens:2,reasoningTokens:1}})};
send(result);send(result);
if(input==='late-crash')process.exitCode=7;
if(input==='incomplete')process.stdout.write('{');
if(input==='conflict')send({...result,result:'different'});
if(input==='late'){setInterval(()=>{if(fs.existsSync(process.env.CONTROL_FILE))process.exit(0)},10)}
});`
async function setup(mode: 'global' | 'scoped' = 'global', extra: Record<string, string> = {}, overrides: Record<string, any> = {}) {
  const directory = await mkdtemp(join(root, 'fixture-')), trace = join(directory, 'trace'), cli = join(directory, 'cli.cjs')
  await writeFile(cli, fixture)
  const db = new DatabaseSync(':memory:'), executions = new AgentExecutionStore(db), store = new PluginStore(db), registry = new AgentRegistry(), events = new PluginEventBus()
  const logger = { info() {}, warn() {}, error() {} }, authorize = vi.fn()
  const gateway = vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:1/v1', token: 'temporary-only', model: 'fixture/model', protocol: 'responses', images: true, dispose: async () => {} }))
  const context = (scope: ExecutionScope, signal: AbortSignal) => createExecutionContext(scope, signal, logger, { authorize: async () => {},
    artifacts: { read: async (_scope: ExecutionScope, id: string, offset = 0) => ({ id, mediaType: 'image/png', byteLength: 4, offset, data: 'iVBORw==', nextOffset: 4, done: true }) },
    agents: { list: async () => [] }, sessions: { get: async () => null }, models: { gateway } })
  const coordinatorOptions = { store: executions, registry, events, logger, authorize, context, stateRoot: join(directory, 'state'), validateInput: () => {} }
  let coordinator = new AgentCoordinator(coordinatorOptions)
  const host = new PluginHost({ store, registry, events, context, logger, runnerPath: runner, artifactsRoot: join(directory, 'installed'),
    eventContext: async (_state, _event, signal) => context(caller, signal), acceptEvents: async batch => { for (const event of batch) events.publish(event) } })
  cleanups.push(async () => { await coordinator.close(); await host.close(); events.close(); db.close() })
  const manifest = JSON.parse(await readFile(join(root, 'plugins/cursor/studio-plugin.json'), 'utf8'))
  await host.registerSystemArtifact(join(root, 'plugins/cursor'), manifest.id)
  await host.configure({ pluginId: manifest.id, profileId: caller.profileId, ownerId: caller.principal.id, enabled: true, config: {}, grants: manifest.requires.capabilities }, 0)
  const config = { cwd: directory, command: process.execPath, args: [cli], model: 'native-model',
    env: { TRACE: trace, HOME: directory, USERPROFILE: directory, CURSOR_CONFIG_DIR: join(directory, 'native'), CONTROL_FILE: join(directory, 'control'), ...extra }, ...overrides }
  const native = join(directory, 'native'); await mkdir(native); await writeFile(join(native, 'cli-config.json'), '{"keep":true}'); await writeFile(join(native, 'mcp.json'), '{"mcpServers":{"user":{"command":"user-server"}}}')
  const instance = coordinator.createInstance(caller, { agentTypeId: 'cursor', mode, config })
  let sequence = 0
  const start = (text: string) => coordinator.start(caller, instance.id, { content: [{ type: 'text', text }] }, `run-${++sequence}`)
  const frames = async () => (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const restart = async () => { await coordinator.close(); coordinator = new AgentCoordinator(coordinatorOptions) }
  return { db, store, manifest, get coordinator() { return coordinator }, restart, registry, host, executions, instance, config, directory, trace, control: join(directory, 'control'), gateway, authorize, start, frames }
}


it('runs native print protocol, deduplicates partial flushes/tools/terminal usage and resumes after restart', async () => {
  const f = await setup()
  for (let i = 0; i < 2; i++) {
    const run = f.start('hello'); await f.coordinator.wait(run.id)
    expect(f.coordinator.get(caller, run.id).status).toBe('completed')
    const output = f.coordinator.output(caller, run.id, -1)
    expect(output.filter(event => event.type === 'message.delta')).toHaveLength(1)
    expect(output.filter(event => event.type === 'message.snapshot')).toEqual([expect.objectContaining({ text: 'Hello' })])
    expect(output.filter(event => event.type === 'tool.started')).toHaveLength(1)
    expect(output.filter(event => event.type === 'tool.completed')).toHaveLength(1)
    expect(f.coordinator.usage(caller, run.id)).toEqual([expect.objectContaining({ model: 'native-model', inputTokens: 17, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2, reasoningTokens: 1, final: true })])
    const trace = JSON.parse(await readFile(f.trace, 'utf8'))
    expect(trace.args).toEqual(expect.arrayContaining(['-p', '--force', '--output-format', 'stream-json', '--stream-partial-output', '--disable-auto-update']))
    if (i === 0) expect(trace.args).not.toContain('--resume')
    else expect(trace.args.slice(trace.args.indexOf('--resume'), trace.args.indexOf('--resume') + 2)).toEqual(['--resume', 'cursor-native-session'])
    await f.restart()
  }
  expect(f.gateway).not.toHaveBeenCalled()
})

it.each(['failure', 'late-crash', 'missing-result', 'malformed', 'incomplete', 'conflict', 'bad-usage', 'oversized'])('never saves a successful checkpoint for %s', async text => {
  const f = await setup(), run = f.start(text); await f.coordinator.wait(run.id)
  const result = f.coordinator.get(caller, run.id)
  expect(result.status).toBe('failed')
  expect(f.executions.state.checkpoint(f.instance.id, result.provider, f.instance.revision)).toBeUndefined()
})

it('waits for native exit after the result instead of accepting the terminal event alone', async () => {
  const f = await setup(), run = f.start('late')
  await vi.waitFor(() => expect(f.coordinator.output(caller, run.id, -1).some(event => event.type === 'message.snapshot')).toBe(true))
  expect(f.coordinator.get(caller, run.id).status).toBe('running')
  await writeFile(f.control, 'exit'); await f.coordinator.wait(run.id)
  expect(f.coordinator.get(caller, run.id).status).toBe('completed')
})

it.each(['wait', 'crash'])('cleans native resources after %s and allows another turn', async text => {
  const f = await setup(), run = f.start(text)
  if (text === 'wait') { await vi.waitFor(async () => expect(JSON.parse(await readFile(f.trace, 'utf8')).input).toBe('wait')); await f.coordinator.cancel(caller, run.id) }
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(caller, run.id).status).toBe(text === 'wait' ? 'cancelled' : 'failed')
  const next = f.start('hello'); await f.coordinator.wait(next.id)
  expect(f.coordinator.get(caller, next.id).status).toBe('completed')
})

it('keeps absent native usage unknown rather than inventing zero counters', async () => {
  const f = await setup(), run = f.start('unknown-usage'); await f.coordinator.wait(run.id)
  expect(f.coordinator.get(caller, run.id).status).toBe('completed')
  expect(f.coordinator.usage(caller, run.id)).toEqual([])
})

it('rejects foreign scopes and revoked admission before native work', async () => {
  const f = await setup()
  expect(() => f.coordinator.start({ ...caller, profileId: 'foreign' }, f.instance.id, { content: [{ type: 'text', text: 'hello' }] }, 'foreign')).toThrow()
  f.authorize.mockImplementation(() => { throw new StudioError('FORBIDDEN', 'Revoked') })
  expect(() => f.start('hello')).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  await expect(readFile(f.trace)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('exposes global-only and rejects scoped and compact without creating native state', async () => {
  const f = await setup()
  expect(f.registry.list(caller.profileId).find(agent => agent.id === 'cursor')?.capabilities.modes).toEqual(['global'])
  expect(() => f.coordinator.createInstance(caller, { agentTypeId: 'cursor', mode: 'scoped', config: f.config })).toThrow()
  const run = f.start('/compact focus'); await f.coordinator.wait(run.id)
  expect(f.coordinator.get(caller, run.id)).toMatchObject({ status: 'failed', errorCode: 'CAPABILITY_UNSUPPORTED' })
  await expect(readFile(f.trace)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('inspects using disposable Home, keeps account config unchanged and creates no Run', async () => {
  const f = await setup()
  expect(await f.coordinator.inspectInstance(caller, f.instance.id)).toMatchObject({ native: { name: 'Cursor', version: '2026.10.22-27dcf5f' }, authentication: { state: 'unknown' }, models: { status: 'unsupported', items: [] } })
  expect(await readFile(join(f.directory, 'native/cli-config.json'), 'utf8')).toBe('{"keep":true}')
  expect(f.db.prepare('SELECT count(*) AS count FROM studio_agent_runs').get()?.count).toBe(0)
  await expect(readFile(f.trace)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rejects unexpected resumed identity and retains the last successful checkpoint', async () => {
  const f = await setup(), first = f.start('hello'); await f.coordinator.wait(first.id)
  const provider = f.coordinator.get(caller, first.id).provider
  const checkpoint = f.executions.state.checkpoint(f.instance.id, provider, f.instance.revision)
  await writeFile(f.control, 'change native session')
  const second = f.start('continue'); await f.coordinator.wait(second.id)
  expect(f.coordinator.get(caller, second.id).status).toBe('failed')
  expect(f.executions.state.checkpoint(f.instance.id, provider, f.instance.revision)).toEqual(checkpoint)
  const trace = JSON.parse(await readFile(f.trace, 'utf8'))
  expect(trace.args.slice(trace.args.indexOf('--resume'), trace.args.indexOf('--resume') + 2)).toEqual(['--resume', 'cursor-native-session'])
  expect(() => createCursorRuntime({ instanceId: 'x', config: f.config, configRevision: 1, mode: 'global', resume: { nativeSessionId: '../foreign' } }, {} as AgentRuntimeContext)).toThrow('Invalid Cursor session identity')
})

it('passes images and a long prompt through native stdin while cleaning managed MCP and image files', async () => {
  const f = await setup('global', {}, { systemPrompt: 'Managed instruction', mcpServers: { local: { command: 'node', env: { ELECTRON_RUN_AS_NODE: '1' } } } })
  const prompt = 'long prompt '.repeat(16000)
  const run = f.coordinator.start(caller, f.instance.id, { content: [{ type: 'text', text: prompt }, { type: 'image', artifactId: '11111111-1111-4111-a111-111111111111', mediaType: 'image/png' }] }, 'image')
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(caller, run.id).status).toBe('completed')
  const trace = JSON.parse(await readFile(f.trace, 'utf8'))
  expect(trace.input).toBe('Managed instruction\n\n' + prompt)
  expect(trace.args).not.toContain(prompt)
  expect(trace.images).toEqual([expect.objectContaining({ data: 'iVBORw==' })])
  expect(trace.plugin.mcp).toEqual({ mcpServers: { local: { command: 'node', env: { ELECTRON_RUN_AS_NODE: '1' } } } })
  await expect(readFile(trace.images[0].path)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(join(trace.plugin.path, 'mcp.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(f.directory, 'native/mcp.json'), 'utf8')).toBe('{"mcpServers":{"user":{"command":"user-server"}}}')
})

it('offers only official manual installation, native login and native resource locations', async () => {
  const f = await setup()
  expect(await f.coordinator.setupInstance(caller, f.instance.id, 1)).toMatchObject({ cli: { state: 'available', version: '2026.10.22-27dcf5f' }, installation: { kind: 'manual', url: 'https://cursor.com/docs/cli/installation' }, authentication: { kind: 'native', args: expect.arrayContaining(['login']) } })
  const locations = await f.coordinator.resourceLocations(caller, f.instance.id, 1)
  expect(locations.skills).toEqual(expect.arrayContaining([expect.objectContaining({ path: join(f.directory, 'native/skills') }), expect.objectContaining({ path: join(f.directory, '.cursor/skills') })]))
  expect(locations.configs).toEqual(expect.arrayContaining([expect.objectContaining({ path: join(f.directory, 'native/cli-config.json') }), expect.objectContaining({ path: join(f.directory, '.cursor/mcp.json') })]))
})

it('writes managed MCP only into an ephemeral native plugin and keeps user/project files unchanged', async () => {
  const directory = await mkdtemp(join(root, 'configuration-')), native = join(directory, 'native'); await mkdir(native)
  const original = '{"mcpServers":{"user":{"command":"user-server"}}}', path = join(native, 'mcp.json'); await writeFile(path, original)
  const prepared = await prepareCursor({ cwd: directory, env: { HOME: directory, CURSOR_CONFIG_DIR: native } }, { stateDirectory: join(directory, 'state') } as AgentRuntimeContext,
    { mcpServers: { managed: { command: 'node', env: { ELECTRON_RUN_AS_NODE: '1' } }, disabled: { command: 'disabled', enabled: false } } })
  expect(prepared.args).toEqual(expect.arrayContaining(['--approve-mcps', '--plugin-dir', prepared.path]))
  expect(JSON.parse(await readFile(join(prepared.path, '.cursor-plugin/plugin.json'), 'utf8'))).toMatchObject({ mcpServers: 'mcp.json' })
  expect(JSON.parse(await readFile(join(prepared.path, 'mcp.json'), 'utf8'))).toEqual({ mcpServers: { managed: { command: 'node', env: { ELECTRON_RUN_AS_NODE: '1' } } } })
  expect(await readFile(path, 'utf8')).toBe(original)
  expect(prepared.env.HOME).toBe(directory)
  await prepared.dispose(); await expect(readFile(join(prepared.path, 'mcp.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('enforces revoked process permission on a resumed worker before further native work', async () => {
  const f = await setup(), first = f.start('hello'); await f.coordinator.wait(first.id)
  f.store.saveProfile({ pluginId: f.manifest.id, profileId: caller.profileId, ownerId: caller.principal.id, enabled: true, config: {}, grants: ['agents.register'] }, 1)
  const second = f.start('continue'); await f.coordinator.wait(second.id)
  expect(f.coordinator.get(caller, second.id)).toMatchObject({ status: 'failed', errorCode: 'FORBIDDEN' })
  expect(JSON.parse(await readFile(f.trace, 'utf8')).input).toBe('hello')
})

it('blocks the next turn when cancellation cannot confirm native cleanup', async () => {
  const directory = await mkdtemp(join(root, 'cleanup-')), signal = new AbortController().signal
  let spawned = false
  const runtime = createCursorRuntime({ instanceId: 'fixture', config: { cwd: directory }, configRevision: 1, mode: 'global' }, {
    stateDirectory: join(directory, 'state'), signal, processes: { spawn: async () => {
      spawned = true
      return { id: 'fixture', read: () => new Promise(() => {}), write: async () => {}, end: async () => {}, stop: async () => {}, dispose: async () => { throw new Error('Cleanup was not confirmed') } }
    } },
  } as unknown as AgentRuntimeContext)
  const run = await runtime.run({ content: [{ type: 'text', text: 'wait' }] }, { signal, scope: { ...caller, runId: 'run' } } as any)
  await vi.waitFor(() => expect(spawned).toBe(true))
  await expect(run.cancel('cancel')).rejects.toThrow('Cleanup was not confirmed')
  await expect(run.result).rejects.toThrow('Cleanup was not confirmed')
  await expect(runtime.run({ content: [{ type: 'text', text: 'next' }] }, { signal } as any)).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
})
