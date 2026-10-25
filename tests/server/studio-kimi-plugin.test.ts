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
import { StudioError, type ExecutionScope } from '../../packages/studio-plugin-sdk/src'
// @ts-expect-error Build script is ESM JavaScript.
import { buildAgentPlugins } from '../../scripts/build-agent-plugins.mjs'

const caller: ExecutionScope = { scopeId: 'scope', principal: { kind: 'user', id: 'owner' }, profileId: 'one', surface: 'api', traceId: 'trace' }
let root: string, runner: string
const cleanups: Array<() => Promise<void>> = []
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'studio-kimi-')); runner = join(root, 'runner.cjs')
  await build({ entryPoints: ['packages/studio-plugin-runner/src/main.ts'], bundle: true, platform: 'node', target: 'node24.22.1', format: 'cjs', outfile: runner, logLevel: 'silent' })
  await buildAgentPlugins(join(root, 'plugins'))
})
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
afterAll(async () => { await rm(root, { recursive: true, force: true }) })

const fixture = `const fs=require('node:fs');
if(process.argv.includes('--version')){console.log('kimi 2.1.1');process.exit(0);}
fs.writeFileSync(process.env.TRACE+'.env',JSON.stringify({root:process.env.KIMI_CODE_HOME,home:process.env.HOME,token:process.env.KIMI_MODEL_API_KEY,model:process.env.KIMI_MODEL_NAME}));
const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\\n');
const update=x=>send({method:'session/update',params:{sessionId:'kimi-session',update:x}});let prompt;
const finish=()=>{update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Kimi answer'}});send({id:prompt.id,result:{stopReason:'end_turn'}})};
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);fs.appendFileSync(process.env.TRACE,line+'\\n');
if(r.method==='initialize')send({id:r.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true,promptCapabilities:{image:true}},agentInfo:{name:'Kimi Code',version:'2.1.1'},authMethods:[{id:'oauth',name:'Kimi OAuth',secret:'private'}]}});
else if(['session/new','session/load'].includes(r.method)){if(r.method==='session/load')update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'old replay'}});
 update({sessionUpdate:'available_commands_update',availableCommands:[{name:'skill:检查',description:'Native Skill'}]});send({id:r.id,result:{sessionId:'kimi-session'}});}
else if(r.method==='session/set_model')send({id:r.id,result:{}});
else if(r.method==='session/prompt'){prompt=r;const text=r.params.prompt.find(x=>x.type==='text')?.text;
 if(text==='crash')process.exit(7);else if(text==='wait')setInterval(()=>{},1000);
 else if(text==='approval')send({id:'approve',method:'session/request_permission',params:{sessionId:'kimi-session',toolCall:{title:'Read file?'},options:[{optionId:'yes',name:'Allow',kind:'allow_once'},{optionId:'no',name:'Reject',kind:'reject_once'}]}});else finish();}
else if(r.id==='approve'&&r.result?.outcome?.optionId==='yes')finish();else if(r.method==='session/cancel')process.exit(0);
});`

async function setup(mode: 'global' | 'scoped' = 'global', extraEnv: Record<string, string> = {}) {
  const directory = await mkdtemp(join(root, 'fixture-')), trace = join(directory, 'trace'), cli = join(directory, 'cli.cjs')
  await writeFile(cli, fixture)
  const db = new DatabaseSync(':memory:'), executions = new AgentExecutionStore(db), store = new PluginStore(db), registry = new AgentRegistry(), events = new PluginEventBus()
  const logger = { info() {}, warn() {}, error() {} }, authorize = vi.fn()
  const gateway = vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:1/v1', token: 'temporary-only', model: 'fixture', protocol: 'anthropic' as const, images: true, dispose: async () => {} }))
  const context = (scope: ExecutionScope, signal: AbortSignal) => createExecutionContext(scope, signal, logger, { authorize: async () => {},
    agents: { list: async () => [] }, sessions: { get: async () => null }, models: { gateway } })
  const coordinator = new AgentCoordinator({ store: executions, registry, events, logger, authorize, context, stateRoot: join(directory, 'state') })
  const host = new PluginHost({ store, registry, events, context, logger, runnerPath: runner, artifactsRoot: join(directory, 'installed'),
    eventContext: async (_state, _event, signal) => context(caller, signal), acceptEvents: async batch => { for (const event of batch) events.publish(event) } })
  cleanups.push(async () => { await coordinator.close(); await host.close(); events.close(); db.close() })
  const manifest = JSON.parse(await readFile(join(root, 'plugins/kimi/studio-plugin.json'), 'utf8'))
  await host.registerSystemArtifact(join(root, 'plugins/kimi'), manifest.id)
  await host.configure({ pluginId: manifest.id, profileId: caller.profileId, ownerId: caller.principal.id, enabled: true, config: {}, grants: manifest.requires.capabilities }, 0)
  const instance = coordinator.createInstance(caller, { agentTypeId: 'kimi', mode, config: { approvalRequired: true, cwd: directory, command: process.execPath, args: [cli],
    model: 'fixture', env: { TRACE: trace, HOME: directory, USERPROFILE: directory, KIMI_CODE_HOME: join(directory, 'native'), ...extraEnv } } })
  let sequence = 0
  const start = (text: string) => coordinator.start(caller, instance.id, { content: [{ type: 'text', text }] }, `run-${++sequence}`)
  const frames = async () => (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const output = (id: string) => coordinator.output(caller, id, -1)
  return { db, coordinator, registry, host, executions, instance, directory, trace, gateway, authorize, start, frames, output }
}

it.each(['global', 'scoped'] as const)('runs and resumes Kimi through its independent worker in %s mode', async mode => {
  const f = await setup(mode), first = f.start('hello')
  await f.coordinator.wait(first.id)
  expect(f.coordinator.get(caller, first.id).status).toBe('completed')
  expect(f.output(first.id)).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'message.delta', text: 'Kimi answer' })]))
  const second = f.start('continue'); await f.coordinator.wait(second.id)
  expect(f.coordinator.get(caller, second.id).status).toBe('completed')
  expect(await f.frames()).toEqual(expect.arrayContaining([expect.objectContaining({ method: 'session/load', params: expect.objectContaining({ sessionId: 'kimi-session' }) })]))
  expect(JSON.stringify(f.output(second.id))).not.toContain('old replay')
  const environment = JSON.parse(await readFile(f.trace + '.env', 'utf8'))
  if (mode === 'scoped') {
    expect(f.gateway).toHaveBeenCalledTimes(2)
    expect((await f.frames()).some(frame => ['session/set_model', 'session/set_config_option'].includes(frame.method))).toBe(false)
    expect(environment.root).toContain(join(f.directory, 'state'))
    expect(environment.token).toBe('temporary-only')
    expect(await readFile(join(environment.root, 'config.toml'), 'utf8')).not.toContain('temporary-only')
  } else { expect(f.gateway).not.toHaveBeenCalled(); expect(environment.root).toBe(join(f.directory, 'native')) }
  expect(() => f.host.uninstall('studio.agent-kimi')).toThrow('System plugins cannot be uninstalled')
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
  expect(await f.coordinator.inspectInstance(caller, f.instance.id)).toMatchObject({ native: { name: 'Kimi Code', version: '2.1.1' }, authentication: { state: 'unknown', methods: [{ id: 'oauth', name: 'Kimi OAuth' }] } })
  const resources = await f.coordinator.resourceLocations(caller, f.instance.id, 1)
  expect(resources.skills.map(source => source.id)).toEqual(['native-skills', 'shared-skills', 'workspace-skills', 'workspace-kimi-skills'])
  expect(resources.configs.find(source => source.id === 'native-instructions')?.path).toBe(join(f.directory, 'native', 'AGENTS.md'))
  expect(f.db.prepare('SELECT count(*) AS count FROM studio_agent_runs').get()?.count).toBe(0)
})

it.each(['crash', 'wait'])('cleans up Kimi on %s and permits a subsequent turn', async text => {
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

it('keeps temporary environment models out of the native persisted model selector on restore', async () => {
  const f = await setup('global', { KIMI_MODEL_NAME: 'fixture' })
  for (const text of ['first', 'second']) {
    const run = f.start(text); await f.coordinator.wait(run.id)
    expect(f.coordinator.get(caller, run.id).status).toBe('completed')
  }
  const frames = await f.frames()
  expect(frames.some(frame => frame.method === 'session/load')).toBe(true)
  expect(frames.some(frame => ['session/set_model', 'session/set_config_option'].includes(frame.method))).toBe(false)
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
