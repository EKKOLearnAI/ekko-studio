import { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
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
import { StudioError, type AgentRuntimeContext, type ExecutionScope, type ModelGatewayHandle } from '../../packages/studio-plugin-sdk/src'
import { preparePi } from '../../plugins/pi/src/configuration'
// @ts-expect-error Build script is ESM JavaScript.
import { buildAgentPlugins } from '../../scripts/build-agent-plugins.mjs'

const caller: ExecutionScope = { scopeId: 'scope', principal: { kind: 'user', id: 'owner' }, profileId: 'one', surface: 'api', traceId: 'trace' }
let root: string, runner: string
const cleanups: Array<() => Promise<void>> = []
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'studio-pi-')); runner = join(root, 'runner.cjs')
  await build({ entryPoints: ['packages/studio-plugin-runner/src/main.ts'], bundle: true, platform: 'node', target: 'node24.22.1', format: 'cjs', outfile: runner, logLevel: 'silent' })
  await buildAgentPlugins(join(root, 'plugins'))
})
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
afterAll(async () => { await rm(root, { recursive: true, force: true }) })

const fixture = `const fs=require('node:fs'),path=require('node:path');
if(process.argv.includes('--version')){console.log('1.4.0');process.exit(0)}
if(process.argv.includes('--list-models')){console.log(process.env.CATALOG_OUTPUT||'fixture native-model 128k 32k yes yes');process.exit(0)}
const sessionArg=process.argv.indexOf('--session'),sessionDir=process.argv[process.argv.indexOf('--session-dir')+1];
const sessionFile=sessionArg<0?path.join(sessionDir,'history.jsonl'):process.argv[sessionArg+1];
const sessionId=sessionArg<0?'pi-session':JSON.parse(fs.readFileSync(sessionFile,'utf8').split('\\n')[0]).id;
fs.writeFileSync(process.env.TRACE+'.env',JSON.stringify({home:process.env.HOME,root:process.env.PI_CODING_AGENT_DIR,token:process.env.STUDIO_PI_MODEL_TOKEN,descriptor:process.env.STUDIO_PI_CONTEXT_FILE,context:JSON.parse(fs.readFileSync(process.env.STUDIO_PI_CONTEXT_FILE,'utf8'))}));
if(!process.env.EXTENSION_FAILURE)fs.writeFileSync(process.env.STUDIO_PI_CONTEXT_FILE+'.ready',JSON.parse(fs.readFileSync(process.env.STUDIO_PI_CONTEXT_FILE,'utf8')).nonce);
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
const snapshot=(stopReason='stop')=>send({type:'message_end',message:{role:'assistant',provider:'fixture',model:'native-model',stopReason,content:[{type:'text',text:stopReason==='stop'?'Native Pi answer':'temporary failure'}],usage:{input:12,output:5,cacheRead:2,cacheWrite:1}}});
const finish=()=>{send({type:'message_start',message:{role:'assistant'}});send({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'Pi partial'}});snapshot();send({type:'agent_end',willRetry:false});send({type:'agent_settled',aborted:false});};
const gate=()=>{const timer=setInterval(()=>{if(!fs.existsSync(process.env.CONTROL_FILE))return;clearInterval(timer);finish()},10)};
let buffer='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{buffer+=chunk;while(buffer.includes('\\n')){const end=buffer.indexOf('\\n'),r=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);fs.appendFileSync(process.env.TRACE,JSON.stringify(r)+'\\n');
const respond=data=>send({type:'response',id:r.id,command:r.type,success:true,data});
if(r.type==='get_commands')respond({commands:[{name:'skill:check',description:'Native Skill'}]});
else if(r.type==='get_state')respond({sessionId,sessionFile,model:{provider:'fixture',id:'native-model'}});
else if(r.type==='compact'){
 if(process.env.COMPACT_FAILURE)send({type:'response',id:r.id,command:r.type,success:false,error:process.env.COMPACT_FAILURE});
 else {const result={summary:'Native summary',tokensBefore:12000,usage:{input:30,output:8,cacheRead:3,cacheWrite:2}};send({type:'compaction_end',result});respond(result);}
}
else if(r.type==='prompt'){
 if(!fs.existsSync(sessionFile))fs.writeFileSync(sessionFile,JSON.stringify({type:'session',id:sessionId})+'\\n');
 if(r.message==='crash')process.exit(7);
 respond({disposition:'started'});
 if(r.message==='wait')continue;
 if(r.message==='late'){send({type:'agent_end',willRetry:true});gate();}
 else if(r.message==='retry'){send({type:'message_start',message:{role:'assistant'}});snapshot('error');send({type:'agent_end',willRetry:true});gate();}
 else if(['confirm','select','input','editor'].includes(r.message))send({type:'extension_ui_request',id:'dialog',method:r.message,title:'Native question',options:['One','Two'],...(process.env.DIALOG_TIMEOUT?{timeout:Number(process.env.DIALOG_TIMEOUT)}:{})});
 else {if(r.message==='auto-compact')send({type:'compaction_end',result:{usage:{input:30,output:8,cacheRead:3,cacheWrite:2}}});finish();}
}else if(r.type==='extension_ui_response'){finish();}
}});if(process.env.LATE_FAILURE)process.stdin.on('end',()=>process.exit(7));`

async function setup(mode: 'global' | 'scoped' = 'global', extra: Record<string, string> = {}) {
  const directory = await mkdtemp(join(root, 'fixture-')), trace = join(directory, 'trace'), cli = join(directory, 'cli.cjs')
  await writeFile(cli, fixture)
  const db = new DatabaseSync(':memory:'), executions = new AgentExecutionStore(db), store = new PluginStore(db), registry = new AgentRegistry(), events = new PluginEventBus()
  const logger = { info() {}, warn() {}, error() {} }, authorize = vi.fn()
  const gateway = vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:1/v1', token: 'temporary-only', model: 'fixture/model', protocol: 'responses', images: true, dispose: async () => {} }))
  const context = (scope: ExecutionScope, signal: AbortSignal) => createExecutionContext(scope, signal, logger, { authorize: async () => {},
    agents: { list: async () => [] }, sessions: { get: async () => null }, models: { gateway } })
  const coordinatorOptions = { store: executions, registry, events, logger, authorize, context, stateRoot: join(directory, 'state') }
  let coordinator = new AgentCoordinator(coordinatorOptions)
  const host = new PluginHost({ store, registry, events, context, logger, runnerPath: runner, artifactsRoot: join(directory, 'installed'),
    eventContext: async (_state, _event, signal) => context(caller, signal), acceptEvents: async batch => { for (const event of batch) events.publish(event) } })
  cleanups.push(async () => { await coordinator.close(); await host.close(); events.close(); db.close() })
  const manifest = JSON.parse(await readFile(join(root, 'plugins/pi/studio-plugin.json'), 'utf8'))
  await host.registerSystemArtifact(join(root, 'plugins/pi'), manifest.id)
  await host.configure({ pluginId: manifest.id, profileId: caller.profileId, ownerId: caller.principal.id, enabled: true, config: {}, grants: manifest.requires.capabilities }, 0)
  const config = { approvalRequired: true, cwd: directory, command: process.execPath, args: [cli], model: 'fixture/native-model',
    env: { TRACE: trace, HOME: directory, USERPROFILE: directory, PI_CODING_AGENT_DIR: join(directory, 'native'), CONTROL_FILE: join(directory, 'control'), ...extra } }
  const instance = coordinator.createInstance(caller, { agentTypeId: 'pi', mode, config })
  let sequence = 0
  const start = (text: string) => coordinator.start(caller, instance.id, { content: [{ type: 'text', text }] }, `run-${++sequence}`)
  const frames = async () => (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const restart = async () => { await coordinator.close(); coordinator = new AgentCoordinator(coordinatorOptions) }
  return { db, get coordinator() { return coordinator }, restart, registry, host, executions, instance, config, directory, trace, control: join(directory, 'control'), gateway, authorize, start, frames }
}

it.each(['global', 'scoped'] as const)('runs and resumes a real Pi plugin worker with %s account isolation', async mode => {
  const f = await setup(mode)
  for (const text of ['hello', 'continue', '/compact Focus on changes']) {
    const run = f.start(text); await f.coordinator.wait(run.id)
    expect(f.coordinator.get(caller, run.id).status).toBe('completed')
    const output = f.coordinator.output(caller, run.id, -1)
    expect(output).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'message.snapshot', text: text.startsWith('/compact') ? 'Native summary' : 'Native Pi answer' })]))
    expect(f.coordinator.usage(caller, run.id)).toHaveLength(mode === 'global' ? 1 : 0)
    if (mode === 'global') expect(f.coordinator.usage(caller, run.id)[0]).toMatchObject(text.startsWith('/compact')
      ? { inputTokens: 35, cacheReadTokens: 3, cacheWriteTokens: 2 } : { inputTokens: 15, cacheReadTokens: 2, cacheWriteTokens: 1 })
  }
  const environment = JSON.parse(await readFile(f.trace + '.env', 'utf8'))
  expect(environment.root).toEqual(mode === 'global' ? join(f.directory, 'native') : expect.stringContaining(join(f.directory, 'state')))
  expect(JSON.stringify(environment.context)).not.toContain('temporary-only')
  await expect(readFile(environment.descriptor)).rejects.toMatchObject({ code: 'ENOENT' })
  if (mode === 'scoped') { expect(environment.token).toBe('temporary-only'); expect(f.gateway).toHaveBeenCalledTimes(3) }
  else expect(f.gateway).not.toHaveBeenCalled()
  expect((await f.frames()).find(frame => frame.type === 'compact')).toMatchObject({ customInstructions: 'Focus on changes' })
  expect(() => f.host.uninstall('studio.agent-pi')).toThrow('System plugins cannot be uninstalled')
})

it.each(['late', 'retry'])('waits past %s agent_end records until agent_settled', async text => {
  const f = await setup(), run = f.start(text)
  await vi.waitFor(async () => expect((await f.frames()).some(frame => frame.type === 'prompt')).toBe(true))
  expect(f.coordinator.get(caller, run.id).status).toBe('running')
  await writeFile(f.control, 'finish')
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(caller, run.id).status).toBe('completed')
  expect(f.coordinator.output(caller, run.id, -1)).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'message.snapshot', text: 'Native Pi answer' })]))
})

it.each(['confirm', 'select', 'input', 'editor'])('binds a native %s dialog to its real response shape', async method => {
  const f = await setup(), run = f.start(method)
  await vi.waitFor(() => expect(f.coordinator.interactions(caller, run.id)).toHaveLength(1))
  const interaction = f.coordinator.interactions(caller, run.id)[0]
  const response = method === 'confirm' ? { choiceId: 'yes' } : method === 'select' ? { choiceId: '1' } : { text: 'Native input' }
  await f.coordinator.respond(caller, run.id, { interactionId: interaction.id, idempotencyKey: 'answer', ...response })
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(caller, run.id).status).toBe('completed')
  expect((await f.frames()).find(frame => frame.type === 'extension_ui_response')).toMatchObject(method === 'confirm' ? { confirmed: true } : { value: method === 'select' ? 'Two' : 'Native input' })
})

it('withdraws expired native dialogs before completing the Run', async () => {
  const f = await setup('global', { DIALOG_TIMEOUT: '80' }), run = f.start('confirm')
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(caller, run.id).status).toBe('completed')
  expect(f.coordinator.interactions(caller, run.id)).toEqual([expect.objectContaining({ status: 'withdrawn' })])
  expect((await f.frames()).find(frame => frame.type === 'extension_ui_response')).toMatchObject({ cancelled: true })
})

it.each(['wait', 'crash'])('confirms process and descriptor cleanup after %s and permits a new turn', async text => {
  const f = await setup(), run = f.start(text)
  if (text === 'wait') { await vi.waitFor(async () => expect((await f.frames()).some(frame => frame.type === 'prompt')).toBe(true)); await f.coordinator.cancel(caller, run.id) }
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(caller, run.id).status).toBe(text === 'wait' ? 'cancelled' : 'failed')
  const environment = JSON.parse(await readFile(f.trace + '.env', 'utf8'))
  await expect(readFile(environment.descriptor)).rejects.toMatchObject({ code: 'ENOENT' })
  const next = f.start('hello'); await f.coordinator.wait(next.id)
  expect(f.coordinator.get(caller, next.id).status).toBe('completed')
})

it('inspects version/models through finite native commands without creating a conversation or Run', async () => {
  const f = await setup()
  expect(await f.coordinator.inspectInstance(caller, f.instance.id)).toMatchObject({ native: { name: 'Pi', version: '1.4.0' }, authentication: { state: 'unknown' },
    models: { status: 'available', items: [{ id: 'fixture/native-model', name: 'native-model' }] } })
  await expect(readFile(f.trace)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(f.db.prepare('SELECT count(*) AS count FROM studio_agent_runs').get()?.count).toBe(0)
})

it('rejects malformed metadata without publishing native output or starting a conversation', async () => {
  const f = await setup('global', { CATALOG_OUTPUT: 'unexpected native output token=do-not-echo' })
  await expect(f.coordinator.inspectInstance(caller, f.instance.id)).rejects.toMatchObject({ message: 'Unrecognized Pi model catalog' })
  await expect(readFile(f.trace)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(f.db.prepare('SELECT count(*) AS count FROM studio_agent_runs').get()?.count).toBe(0)
})

it('interrupts pending native input when its owning Run is cancelled', async () => {
  const f = await setup(), run = f.start('confirm')
  await vi.waitFor(() => expect(f.coordinator.interactions(caller, run.id)).toHaveLength(1))
  await f.coordinator.cancel(caller, run.id)
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(caller, run.id).status).toBe('cancelled')
  expect(f.coordinator.interactions(caller, run.id)).toEqual([expect.objectContaining({ status: 'interrupted' })])
  expect((await f.frames()).some(frame => frame.type === 'extension_ui_response')).toBe(false)
})


it('accounts for automatic summary calls separately from assistant calls without scoped duplicates', async () => {
  const f = await setup(), run = f.start('auto-compact')
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(caller, run.id).status).toBe('completed')
  const usage = f.coordinator.usage(caller, run.id)
  expect(usage).toHaveLength(2)
  expect(new Set(usage.map(call => call.modelCallId)).size).toBe(2)
  expect(usage).toEqual(expect.arrayContaining([expect.objectContaining({ model: 'fixture/native-model', inputTokens: 35, outputTokens: 8, final: true })]))
})

it.each(['Nothing to compact (session too small)', 'Already compacted', 'token=do-not-echo'])('keeps rejected native compaction failed and preserves its prior checkpoint (%s)', async error => {
  const f = await setup('global', { COMPACT_FAILURE: error }), first = f.start('hello')
  await f.coordinator.wait(first.id)
  const provider = f.coordinator.get(caller, first.id).provider
  const before = f.executions.state.checkpoint(f.instance.id, provider, f.instance.revision)
  const compact = f.start('/compact'); await f.coordinator.wait(compact.id)
  expect(f.coordinator.get(caller, compact.id).status).toBe('failed')
  expect(f.executions.state.checkpoint(f.instance.id, provider, f.instance.revision)).toEqual(before)
  expect(JSON.stringify(f.coordinator.output(caller, compact.id, -1))).not.toContain('do-not-echo')
})

it.each(['outside', 'symlink', 'identity', 'missing', 'extra'] as const)('rejects a %s checkpoint before spawning a replacement native process', async change => {
  const f = await setup(), first = f.start('hello')
  await f.coordinator.wait(first.id)
  const provider = f.coordinator.get(caller, first.id).provider
  const checkpoint = f.executions.state.checkpoint(f.instance.id, provider, f.instance.revision) as { nativeSessionFile: string; nativeSessionId: string }
  await f.restart()
  if (change === 'identity') await writeFile(checkpoint.nativeSessionFile, '{"type":"session","id":"different"}\n')
  else if (change === 'missing') await rm(checkpoint.nativeSessionFile)
  else if (change === 'extra') Object.assign(checkpoint, { untrusted: 'unsupported checkpoint field' })
  else {
    const external = join(f.directory, 'foreign-history.jsonl')
    await writeFile(external, JSON.stringify({ type: 'session', id: checkpoint.nativeSessionId }) + '\n')
    if (change === 'symlink') { await rm(checkpoint.nativeSessionFile); await symlink(external, checkpoint.nativeSessionFile) }
    else checkpoint.nativeSessionFile = external
  }
  f.executions.state.saveCheckpoint(f.instance.id, provider, f.instance.revision, first.id, checkpoint)
  const frames = await f.frames(), next = f.start('continue'); await f.coordinator.wait(next.id)
  expect(f.coordinator.get(caller, next.id).status).toBe('failed')
  expect(await f.frames()).toEqual(frames)
})

it('does not commit a checkpoint after native failure following its settled result', async () => {
  const f = await setup('global', { LATE_FAILURE: '1' }), run = f.start('hello')
  await f.coordinator.wait(run.id)
  const result = f.coordinator.get(caller, run.id)
  expect(result.status).toBe('failed')
  expect(f.executions.state.checkpoint(f.instance.id, result.provider, f.instance.revision)).toBeUndefined()
})

it('rejects foreign and revoked admissions before native work', async () => {
  const f = await setup()
  expect(() => f.coordinator.start({ ...caller, profileId: 'foreign' }, f.instance.id, { content: [{ type: 'text', text: 'hello' }] }, 'foreign')).toThrow()
  f.authorize.mockImplementation(() => { throw new StudioError('FORBIDDEN', 'Revoked') })
  expect(() => f.start('hello')).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  await expect(readFile(f.trace)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('keeps native files unchanged, isolates scoped secrets and explicitly rejects unsupported SSE or absent gateways', async () => {
  const directory = await mkdtemp(join(root, 'configuration-')), native = join(directory, 'native'), state = join(directory, 'state')
  await mkdir(native)
  const nativeConfig = join(native, 'mcp.json'), original = '{"mcpServers":{"native":{"command":"native-server"}}}'
  await writeFile(nativeConfig, original)
  const config = { cwd: directory, env: { HOME: directory, PI_CODING_AGENT_DIR: native }, approveProjectConfig: false }
  const runtime = { stateDirectory: state, runtimeSessionId: 'fixture' } as AgentRuntimeContext
  const gateway = { baseUrl: 'http://127.0.0.1:1/lease/v1', token: 'temporary-only', model: 'fixture/model', protocol: 'responses', images: true } as ModelGatewayHandle
  await expect(preparePi({}, config, 'scoped', runtime)).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
  await expect(preparePi({ mcpServers: { legacy: { type: 'sse', url: 'http://127.0.0.1:1/sse' } } }, config, 'global', runtime)).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
  const prepared = await preparePi({ systemPrompt: 'Managed instruction', mcpServers: { managed: { command: 'node', env: { ELECTRON_RUN_AS_NODE: '1' } } } }, config, 'scoped', runtime, gateway)
  try {
    expect(prepared.args).toContain('--no-approve')
    expect(prepared.env.HOME).toBe(join(state, 'home'))
    expect(prepared.env.PI_CODING_AGENT_DIR).toBe(join(state, 'pi'))
    expect(prepared.env.STUDIO_PI_MODEL_TOKEN).toBe('temporary-only')
    const descriptor = await readFile(prepared.env.STUDIO_PI_CONTEXT_FILE, 'utf8')
    expect(descriptor).not.toContain('temporary-only')
    expect(JSON.parse(descriptor)).toMatchObject({ systemPrompt: 'Managed instruction', mcpServers: { managed: { enabled: true, exposure: 'direct', env: { ELECTRON_RUN_AS_NODE: '1' } } } })
    expect(await readFile(nativeConfig, 'utf8')).toBe(original)
  } finally { await prepared.dispose() }
  await expect(readFile(prepared.env.STUDIO_PI_CONTEXT_FILE)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('merges managed MCP over native and trusted project entries without reading untrusted project configuration', async () => {
  const directory = await mkdtemp(join(root, 'native-extension-')), native = join(directory, 'native'), project = join(directory, '.pi')
  await Promise.all([mkdir(native), mkdir(project)])
  const original = JSON.stringify({ mcpServers: { merge: { command: 'native-server', args: ['--keep'], enabled: true }, collision: { command: 'old-server' } } })
  await writeFile(join(native, 'mcp.json'), original)
  await writeFile(join(project, 'mcp.json'), JSON.stringify({ mcpServers: { merge: { enabled: false }, project: { command: 'project-server' } } }))
  const descriptor = join(directory, 'context.json')
  await writeFile(descriptor, JSON.stringify({ nonce: 'test-nonce', mcpServers: { collision: { command: 'managed-server', env: { ELECTRON_RUN_AS_NODE: '1' } } } }))
  const sdk = join(directory, 'sdk.cjs'), output = join(directory, 'native.cjs')
  await writeFile(sdk, `exports.fixture={};exports.getAgentDir=()=>${JSON.stringify(native)};exports.createMcpExtension=options=>{exports.fixture.load=options.loadConfig;return()=>{}}`)
  await build({ stdin: { contents: "export { default } from './plugins/pi/native/studio.mjs'; export { fixture } from '@earendil-works/pi-coding-agent'", resolveDir: process.cwd(), loader: 'js' },
    outfile: output, platform: 'node', format: 'cjs', bundle: true, logLevel: 'silent', alias: { '@earendil-works/pi-coding-agent': sdk } })
  const extension = createRequire(import.meta.url)(output), previous = process.env.STUDIO_PI_CONTEXT_FILE
  process.env.STUDIO_PI_CONTEXT_FILE = descriptor
  try {
    await extension.default({ on: vi.fn(), registerProvider: vi.fn() })
    const untrusted = extension.fixture.load({ cwd: directory, isProjectTrusted: () => false })
    expect(untrusted.servers.map((server: any) => server.name)).toEqual(['merge', 'collision'])
    expect(untrusted.servers.find((server: any) => server.name === 'merge').config).toMatchObject({ enabled: true })
    expect(untrusted.servers.find((server: any) => server.name === 'collision')).toMatchObject({ scope: 'extension', config: { command: 'managed-server' } })
    const trusted = extension.fixture.load({ cwd: directory, isProjectTrusted: () => true })
    expect(trusted.servers.find((server: any) => server.name === 'merge').config).toEqual({ command: 'native-server', args: ['--keep'], enabled: false })
    expect(trusted.servers.some((server: any) => server.name === 'project')).toBe(true)
    expect(await readFile(join(native, 'mcp.json'), 'utf8')).toBe(original)
    await rm(descriptor)
    await expect(extension.default({})).rejects.toThrow('Pi runtime context is unavailable')
  } finally { if (previous === undefined) delete process.env.STUDIO_PI_CONTEXT_FILE; else process.env.STUDIO_PI_CONTEXT_FILE = previous }
})

it('fails before sending user input when native Pi silently skips the managed extension', async () => {
  const f = await setup('global', { EXTENSION_FAILURE: '1' }), run = f.start('hello')
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(caller, run.id).status).toBe('failed')
  expect((await f.frames()).some(frame => frame.type === 'prompt')).toBe(false)
  const environment = JSON.parse(await readFile(f.trace + '.env', 'utf8'))
  await expect(readFile(environment.descriptor)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(environment.descriptor + '.ready')).rejects.toMatchObject({ code: 'ENOENT' })
})

it('automatically confirms tool dialogs when manual approvals were not configured', async () => {
  const f = await setup()
  const { approvalRequired: _manual, ...config } = f.instance.config
  await f.coordinator.updateInstance(caller, f.instance.id, { revision: 1, mode: f.instance.mode, config })
  const run = f.start('confirm')
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(caller, run.id).status).toBe('completed')
  expect(f.coordinator.interactions(caller, run.id)).toEqual([])
  expect((await f.frames()).find(frame => frame.type === 'extension_ui_response')).toMatchObject({ id: 'dialog', confirmed: true })
})
