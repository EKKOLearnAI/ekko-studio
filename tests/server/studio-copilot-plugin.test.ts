import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
import { copilotProtocol, scopedCopilot } from '../../plugins/copilot/src/scoped'
import { prepareCopilotMcp } from '../../plugins/copilot/src/mcp'
import { StudioError, type AgentRuntimeContext, type ExecutionScope, type JsonObject, type ModelGatewayHandle } from '../../packages/studio-plugin-sdk/src'
// @ts-expect-error Build script is ESM JavaScript.
import { buildAgentPlugins } from '../../scripts/build-agent-plugins.mjs'

const caller: ExecutionScope = { scopeId: 'scope', principal: { kind: 'user', id: 'owner' }, profileId: 'one', surface: 'api', traceId: 'trace' }
let root: string, runner: string
const cleanups: Array<() => Promise<void>> = []
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'studio-copilot-')); runner = join(root, 'runner.cjs')
  await build({ entryPoints: ['packages/studio-plugin-runner/src/main.ts'], bundle: true, platform: 'node', target: 'node24.22.1', format: 'cjs', outfile: runner, logLevel: 'silent' })
  await buildAgentPlugins(join(root, 'plugins'))
})
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
afterAll(async () => { await rm(root, { recursive: true, force: true }) })

const fixture = `const fs=require('node:fs');
if(process.argv.includes('--version')){console.log('copilot 1.0.91');process.exit(0);}
const mcpArg=process.argv[process.argv.indexOf('--additional-mcp-config')+1];
fs.writeFileSync(process.env.TRACE+'.env',JSON.stringify({root:process.env.COPILOT_HOME,home:process.env.HOME,token:process.env.COPILOT_PROVIDER_API_KEY,model:process.env.COPILOT_MODEL,...(mcpArg?.startsWith('@')?{mcpPath:mcpArg.slice(1),mcp:JSON.parse(fs.readFileSync(mcpArg.slice(1),'utf8'))}:{})}));
if(process.argv.includes('--headless')) {
 let buffer=Buffer.alloc(0);process.stdin.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(true){const head=buffer.indexOf('\\r\\n\\r\\n');if(head<0)return;const length=Number(/Content-Length: (\\d+)/i.exec(buffer.subarray(0,head).toString())[1]);if(buffer.length<head+4+length)return;const r=JSON.parse(buffer.subarray(head+4,head+4+length).toString());buffer=buffer.subarray(head+4+length);fs.appendFileSync(process.env.TRACE,JSON.stringify(r)+'\\n');
 const result=r.method==='auth.getStatus'?{isAuthenticated:process.env.AUTHENTICATED==='1',login:'private-account',token:'private-token'}:{models:[{id:'native-fixture',name:'Native fixture',secret:'private-model-field'}]};const text=JSON.stringify({jsonrpc:'2.0',id:r.id,result});process.stdout.write('Content-Length: '+Buffer.byteLength(text)+'\\r\\n\\r\\n'+text)}});return;
}
const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\\n');
const update=x=>send({method:'session/update',params:{sessionId:'copilot-session',update:x}});let prompt;
const finish=()=>{update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Copilot answer'}});send({id:prompt.id,result:{stopReason:'end_turn'}})};
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);fs.appendFileSync(process.env.TRACE,line+'\\n');
if(r.method==='initialize')send({id:r.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true,promptCapabilities:{image:true}},agentInfo:{name:'Copilot Code',version:'1.0.91'},authMethods:[{id:'oauth',name:'Copilot OAuth',secret:'private'}]}});
else if(['session/new','session/load'].includes(r.method)){if(r.method==='session/load')update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'old replay'}});
 update({sessionUpdate:'available_commands_update',availableCommands:[{name:'skill:检查',description:'Native Skill'}]});send({id:r.id,result:{sessionId:'copilot-session'}});}
else if(r.method==='session/set_model')send({id:r.id,result:{}});
else if(r.method==='session/prompt'){prompt=r;const text=r.params.prompt.find(x=>x.type==='text')?.text;
 if(text==='crash')process.exit(7);else if(text==='wait')setInterval(()=>{},1000);
 else if(text==='approval')send({id:'approve',method:'session/request_permission',params:{sessionId:'copilot-session',toolCall:{title:'Read file?'},options:[{optionId:'yes',name:'Allow',kind:'allow_once'},{optionId:'no',name:'Reject',kind:'reject_once'}]}});else finish();}
else if(r.id==='approve'&&r.result?.outcome?.optionId==='yes')finish();else if(r.method==='session/cancel')process.exit(0);
});`

async function setup(mode: 'global' | 'scoped' = 'global', extraEnv: Record<string, string> = {}, config: JsonObject = {}) {
  const directory = await mkdtemp(join(root, 'fixture-')), trace = join(directory, 'trace'), cli = join(directory, 'cli.cjs')
  await writeFile(cli, fixture)
  const db = new DatabaseSync(':memory:'), executions = new AgentExecutionStore(db), store = new PluginStore(db), registry = new AgentRegistry(), events = new PluginEventBus()
  const logger = { info() {}, warn() {}, error() {} }, authorize = vi.fn()
  const gateway = vi.fn(async (_scope, input) => ({ baseUrl: 'http://127.0.0.1:1/v1', token: 'temporary-only', model: 'fixture', protocol: input.protocol, images: true, dispose: async () => {} }))
  const context = (scope: ExecutionScope, signal: AbortSignal) => createExecutionContext(scope, signal, logger, { authorize: async () => {},
    agents: { list: async () => [] }, sessions: { get: async () => null }, models: { gateway } })
  const coordinator = new AgentCoordinator({ store: executions, registry, events, logger, authorize, context, stateRoot: join(directory, 'state') })
  const host = new PluginHost({ store, registry, events, context, logger, runnerPath: runner, artifactsRoot: join(directory, 'installed'),
    eventContext: async (_state, _event, signal) => context(caller, signal), acceptEvents: async batch => { for (const event of batch) events.publish(event) } })
  cleanups.push(async () => { await coordinator.close(); await host.close(); events.close(); db.close() })
  const manifest = JSON.parse(await readFile(join(root, 'plugins/copilot/studio-plugin.json'), 'utf8'))
  await host.registerSystemArtifact(join(root, 'plugins/copilot'), manifest.id)
  await host.configure({ pluginId: manifest.id, profileId: caller.profileId, ownerId: caller.principal.id, enabled: true, config: {}, grants: manifest.requires.capabilities }, 0)
  const instance = coordinator.createInstance(caller, { agentTypeId: 'copilot', mode, config: { approvalRequired: true, cwd: directory, command: process.execPath, args: [cli],
    model: 'fixture', env: { TRACE: trace, HOME: directory, USERPROFILE: directory, COPILOT_HOME: join(directory, 'native'), ...extraEnv }, ...config } })
  let sequence = 0
  const start = (text: string) => coordinator.start(caller, instance.id, { content: [{ type: 'text', text }] }, `run-${++sequence}`)
  const frames = async () => (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const output = (id: string) => coordinator.output(caller, id, -1)
  return { db, coordinator, registry, host, executions, instance, directory, trace, gateway, authorize, start, frames, output }
}

it.each(['global', 'scoped'] as const)('runs and resumes Copilot through its independent worker in %s mode', async mode => {
  const f = await setup(mode), first = f.start('hello')
  await f.coordinator.wait(first.id)
  expect(f.coordinator.get(caller, first.id).status).toBe('completed')
  expect(f.output(first.id)).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'message.delta', text: 'Copilot answer' })]))
  const second = f.start('continue'); await f.coordinator.wait(second.id)
  expect(f.coordinator.get(caller, second.id).status).toBe('completed')
  expect(await f.frames()).toEqual(expect.arrayContaining([expect.objectContaining({ method: 'session/load', params: expect.objectContaining({ sessionId: 'copilot-session' }) })]))
  expect(JSON.stringify(f.output(second.id))).not.toContain('old replay')
  const environment = JSON.parse(await readFile(f.trace + '.env', 'utf8'))
  if (mode === 'scoped') {
    expect(f.gateway).toHaveBeenCalledTimes(2)
    expect((await f.frames()).some(frame => ['session/set_model', 'session/set_config_option'].includes(frame.method))).toBe(false)
    expect(environment.root).toContain(join(f.directory, 'state'))
    expect(environment.token).toBe('temporary-only')
    expect(await readFile(join(environment.root, 'settings.json'), 'utf8')).not.toContain('temporary-only')
  } else { expect(f.gateway).not.toHaveBeenCalled(); expect(environment.root).toBe(join(f.directory, 'native')) }
  expect(() => f.host.uninstall('studio.agent-copilot')).toThrow('System plugins cannot be uninstalled')
})

it('keeps native approvals bound to the real options and continues after accepting one', async () => {
  const f = await setup(), run = f.start('approval')
  await vi.waitFor(() => expect(f.coordinator.interactions(caller, run.id)).toHaveLength(1))
  const interaction = f.coordinator.interactions(caller, run.id)[0]
  await expect(f.coordinator.respond(caller, run.id, { interactionId: interaction.id, idempotencyKey: 'invalid', choiceId: 'forged' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  await f.coordinator.respond(caller, run.id, { interactionId: interaction.id, idempotencyKey: 'accept', choiceId: 'yes' })
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(caller, run.id).status).toBe('completed')
})

it('returns only native metadata and declares resource paths without creating a Run', async () => {
  const f = await setup()
  expect(f.registry.list('one')[0].management).toEqual({ inspect: true, locations: true, setup: true, prepareLogin: true, prepareInstall: true })
  expect(await f.coordinator.inspectInstance(caller, f.instance.id)).toMatchObject({ native: { name: 'Copilot Code', version: '1.0.91' }, authentication: { state: 'required', methods: [{ id: 'oauth', name: 'Copilot OAuth' }] }, models: { status: 'authentication_required', items: [] } })
  const resources = await f.coordinator.resourceLocations(caller, f.instance.id, 1)
  expect(resources.skills.map(source => source.id)).toEqual(['native-skills', 'shared-skills', 'workspace-skills', 'workspace-shared-skills'])
  expect(resources.configs.find(source => source.id === 'native-instructions')?.path).toBe(join(f.directory, 'native', 'copilot-instructions.md'))
  expect(f.db.prepare('SELECT count(*) AS count FROM studio_agent_runs').get()?.count).toBe(0)
  expect((await f.frames()).map(frame => frame.method)).toEqual(['initialize', 'auth.getStatus'])
})

it.each(['crash', 'wait'])('cleans up Copilot on %s and permits a subsequent turn', async text => {
  const f = await setup(), run = f.start(text)
  if (text === 'wait') { await vi.waitFor(async () => expect((await f.frames()).some(frame => frame.method === 'session/prompt')).toBe(true)); await f.coordinator.cancel(caller, run.id) }
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(caller, run.id).status).toBe(text === 'wait' ? 'cancelled' : 'failed')
  const next = f.start('hello'); await f.coordinator.wait(next.id)
  expect(f.coordinator.get(caller, next.id).status).toBe('completed')
})

it('rejects revoked and foreign scopes before native work', async () => {
  const f = await setup()
  expect(() => f.coordinator.start({ ...caller, profileId: 'foreign' }, f.instance.id, { content: [{ type: 'text', text: 'hello' }] }, 'foreign')).toThrow()
  f.authorize.mockImplementation(() => { throw new StudioError('FORBIDDEN', 'Revoked') })
  expect(() => f.start('hello')).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  await expect(readFile(f.trace)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('filters native account/model metadata through versioned SDK RPC without starting a Run', async () => {
  const f = await setup('global', { AUTHENTICATED: '1' })
  const result = await f.coordinator.inspectInstance(caller, f.instance.id)
  expect(result.authentication).toEqual({ state: 'authenticated', methods: [{ id: 'oauth', name: 'Copilot OAuth' }] })
  expect(result.models).toEqual({ status: 'available', items: [{ id: 'native-fixture', name: 'Native fixture' }] })
  expect(JSON.stringify(result)).not.toContain('private-')
  expect((await f.frames()).map(frame => frame.method)).toEqual(['initialize', 'auth.getStatus', 'models.list'])
  expect(f.db.prepare('SELECT count(*) AS count FROM studio_agent_runs').get()?.count).toBe(0)
})

it('selects a portable protocol for Studio-qualified Claude and generic models', () => {
  expect(copilotProtocol('provider/claude-sonnet-4')).toBe('anthropic')
  expect(copilotProtocol('claude-opus-4')).toBe('anthropic')
  expect(copilotProtocol('provider/custom-model')).toBe('chat-completions')
})

it.each(['anthropic', 'chat-completions'] as const)('keeps the %s gateway credential ephemeral and preserves private native settings', async protocol => {
  const directory = await mkdtemp(join(root, 'scoped-')), runtime = { stateDirectory: directory } as AgentRuntimeContext
  const gateway = { baseUrl: 'http://127.0.0.1:1/lease/v1', token: 'temporary-only', model: 'provider/claude-sonnet-4', protocol } as ModelGatewayHandle
  await scopedCopilot(runtime, gateway, {})
  const path = join(directory, 'copilot', 'settings.json')
  await writeFile(path, JSON.stringify({ theme: 'native-choice', custom: { preserved: true } }))
  const launch = await scopedCopilot(runtime, gateway, {})
  expect(launch.env.COPILOT_PROVIDER_BASE_URL).toBe(protocol === 'anthropic' ? 'http://127.0.0.1:1/lease' : gateway.baseUrl)
  expect(launch.env.COPILOT_PROVIDER_MODEL_ID).toBe(protocol === 'anthropic' ? 'claude-sonnet-4' : gateway.model)
  expect(launch.env.COPILOT_PROVIDER_API_KEY).toBe('temporary-only')
  expect(launch.env.COPILOT_GITHUB_TOKEN).toBe('')
  const settings = await readFile(path, 'utf8')
  expect(JSON.parse(settings)).toMatchObject({ theme: 'native-choice', custom: { preserved: true } })
  expect(settings).not.toContain('temporary-only')
})

it('isolates concurrent MCP launch files and filters disabled servers without changing the source configuration', async () => {
  const directory = await mkdtemp(join(root, 'mcp-'))
  const configuration = { mcpServers: { local: { command: 'node', args: ['server.js'], env: { ELECTRON_RUN_AS_NODE: '1', TOKEN: 'lease-only' } },
    remote: { type: 'sse' as const, url: 'http://127.0.0.1:1/events' }, disabled: { command: 'unused', disabled: true } } }
  const original = structuredClone(configuration)
  const first = await prepareCopilotMcp(configuration, { stateDirectory: directory, runtimeSessionId: 'one' } as AgentRuntimeContext)
  const second = await prepareCopilotMcp(configuration, { stateDirectory: directory, runtimeSessionId: 'two' } as AgentRuntimeContext)
  const path = (launch: typeof first) => launch.args[1].slice(1)
  expect(path(first)).not.toBe(path(second))
  expect(JSON.parse(await readFile(path(first), 'utf8')).mcpServers).toEqual({ local: { ...configuration.mcpServers.local, type: 'stdio', tools: ['*'] },
    remote: { ...configuration.mcpServers.remote, tools: ['*'] } })
  expect(configuration).toEqual(original)
  await first.dispose!()
  await expect(readFile(path(first))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(path(second), 'utf8')).toContain('lease-only')
  await second.dispose!()
})

it.each(['hello', 'crash', 'wait'])('removes temporary MCP credentials after %s without rewriting the native Home', async text => {
  const f = await setup('global', {}, { mcpServers: { local: { command: 'node', args: ['fixture'], env: { TOKEN: 'lease-only' } } } })
  const run = f.start(text)
  if (text === 'wait') { await vi.waitFor(async () => expect((await f.frames()).some(frame => frame.method === 'session/prompt')).toBe(true)); await f.coordinator.cancel(caller, run.id) }
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(caller, run.id).status).toBe(text === 'hello' ? 'completed' : text === 'wait' ? 'cancelled' : 'failed')
  const environment = JSON.parse(await readFile(f.trace + '.env', 'utf8'))
  expect(environment.root).toBe(join(f.directory, 'native'))
  expect(environment.mcp.mcpServers.local.env.TOKEN).toBe('lease-only')
  await expect(readFile(environment.mcpPath)).rejects.toMatchObject({ code: 'ENOENT' })
})


it('keeps tool execution automatic when no manual approval policy is configured', async () => {
  const f = await setup()
  const { approvalRequired: _manual, ...config } = f.instance.config
  await f.coordinator.updateInstance(caller, f.instance.id, { revision: f.instance.revision, mode: f.instance.mode, config })
  const run = f.start('approval')
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(caller, run.id).status).toBe('completed')
  expect(f.coordinator.interactions(caller, run.id)).toEqual([])
  expect((await f.frames()).find((frame: any) => frame.id === 'approve')?.result).toMatchObject({ outcome: { outcome: 'selected', optionId: 'yes' } })
})
