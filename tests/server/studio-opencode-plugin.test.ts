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
import { StudioError, type AgentRuntimeContext, type ExecutionScope, type ModelGatewayHandle } from '../../packages/studio-plugin-sdk/src'
import { nativeEnvironment, scopedOpenCode } from '../../plugins/opencode/src/configuration'
// @ts-expect-error Build script is ESM JavaScript.
import { buildAgentPlugins } from '../../scripts/build-agent-plugins.mjs'

const caller: ExecutionScope = { scopeId: 'scope', principal: { kind: 'user', id: 'owner' }, profileId: 'one', surface: 'api', traceId: 'trace' }
let root: string, runner: string
const cleanups: Array<() => Promise<void>> = []
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'studio-opencode-')); runner = join(root, 'runner.cjs')
  await build({ entryPoints: ['packages/studio-plugin-runner/src/main.ts'], bundle: true, platform: 'node', target: 'node24.22.1', format: 'cjs', outfile: runner, logLevel: 'silent' })
  await buildAgentPlugins(join(root, 'plugins'))
})
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
afterAll(async () => { await rm(root, { recursive: true, force: true }) })

const fixture = `const fs=require('node:fs');
fs.writeFileSync(process.env.TRACE+'.env',JSON.stringify({root:process.env.OPENCODE_CONFIG_DIR,home:process.env.HOME,token:process.env.STUDIO_OPENCODE_API_KEY,inline:process.env.OPENCODE_CONFIG_CONTENT}));
if(process.argv.includes('--version')){console.log('1.19.4');process.exit(0)}
const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\\n');
const update=x=>send({method:'session/update',params:{sessionId:'opencode-session',update:x}});let prompt;
const finish=()=>{update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'OpenCode answer'}});send({id:prompt.id,result:{stopReason:'end_turn'}})};
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);fs.appendFileSync(process.env.TRACE,line+'\\n');
if(r.method==='initialize')send({id:r.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true,sessionCapabilities:{resume:{}},promptCapabilities:{image:true}},agentInfo:{name:'opencode-cli',version:'1.19.4'},authMethods:[{id:'opencodecli-login',name:'Use opencodecli login',secret:'private'}]}});
else if(['session/new','session/resume'].includes(r.method)){update({sessionUpdate:'available_commands_update',availableCommands:[{name:'help',description:'Available native ACP commands'}]});send({id:r.id,result:r.method==='session/new'?{sessionId:'opencode-session'}:{}})}
else if(r.method==='session/set_model')send({id:r.id,result:{}});
else if(r.method==='session/prompt'){prompt=r;const text=r.params.prompt.find(x=>x.type==='text')?.text;
 if(text==='crash')process.exit(7);else if(text==='wait')setInterval(()=>{},1000);
 else if(text==='approval')send({id:'approve',method:'session/request_permission',params:{sessionId:'opencode-session',toolCall:{title:'Read file?'},options:[{optionId:'yes',name:'Allow',kind:'allow_once'}]}});else finish()}
else if(r.id==='approve'&&r.result?.outcome?.optionId==='yes')finish();else if(r.method==='session/cancel')process.exit(0)
});`

async function setup(mode: 'global' | 'scoped' = 'global') {
  const directory = await mkdtemp(join(root, 'fixture-')), trace = join(directory, 'trace'), cli = join(directory, 'cli.cjs')
  await writeFile(cli, fixture)
  const db = new DatabaseSync(':memory:'), executions = new AgentExecutionStore(db), store = new PluginStore(db), registry = new AgentRegistry(), events = new PluginEventBus()
  const logger = { info() {}, warn() {}, error() {} }, authorize = vi.fn()
  const gateway = vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:1/v1', token: 'temporary-only', model: 'fixture/model', protocol: 'chat-completions', images: true, dispose: async () => {} }))
  const context = (scope: ExecutionScope, signal: AbortSignal) => createExecutionContext(scope, signal, logger, { authorize: async () => {},
    agents: { list: async () => [] }, sessions: { get: async () => null }, models: { gateway } })
  const coordinator = new AgentCoordinator({ store: executions, registry, events, logger, authorize, context, stateRoot: join(directory, 'state') })
  const host = new PluginHost({ store, registry, events, context, logger, runnerPath: runner, artifactsRoot: join(directory, 'installed'),
    eventContext: async (_state, _event, signal) => context(caller, signal), acceptEvents: async batch => { for (const event of batch) events.publish(event) } })
  cleanups.push(async () => { await coordinator.close(); await host.close(); events.close(); db.close() })
  const manifest = JSON.parse(await readFile(join(root, 'plugins/opencode/studio-plugin.json'), 'utf8'))
  await host.registerSystemArtifact(join(root, 'plugins/opencode'), manifest.id)
  await host.configure({ pluginId: manifest.id, profileId: caller.profileId, ownerId: caller.principal.id, enabled: true, config: {}, grants: manifest.requires.capabilities }, 0)
  const config = { approvalRequired: true, cwd: directory, command: process.execPath, args: [cli], model: 'native-model',
    env: { TRACE: trace, HOME: directory, USERPROFILE: directory, OPENCODE_CONFIG_DIR: join(directory, 'native') } }
  const instance = coordinator.createInstance(caller, { agentTypeId: 'opencode', mode, config })
  let sequence = 0
  const start = (text: string) => coordinator.start(caller, instance.id, { content: [{ type: 'text', text }] }, `run-${++sequence}`)
  const frames = async () => (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  return { db, coordinator, registry, host, executions, instance, config, directory, trace, gateway, authorize, start, frames }
}

it.each(['global', 'scoped'] as const)('runs and restores OpenCode through its independent worker and native resume method (%s)', async mode => {
  const f = await setup(mode)
  for (const text of ['hello', '/help']) {
    const run = f.start(text); await f.coordinator.wait(run.id)
    expect(f.coordinator.get(caller, run.id).status).toBe('completed')
    expect(f.coordinator.output(caller, run.id, -1)).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'message.delta', text: 'OpenCode answer' })]))
  }
  const frames = await f.frames()
  expect(frames.filter(frame => frame.method === 'session/new')).toHaveLength(1)
  expect(frames.filter(frame => frame.method === 'session/resume')).toEqual([expect.objectContaining({ params: expect.objectContaining({ sessionId: 'opencode-session' }) })])
  expect(frames.filter(frame => frame.method === 'session/prompt').at(-1).params.prompt).toEqual([{ type: 'text', text: '/help' }])
  expect(() => f.host.uninstall('studio.agent-opencode')).toThrow('System plugins cannot be uninstalled')
  const environment = JSON.parse(await readFile(f.trace + '.env', 'utf8'))
  if (mode === 'scoped') {
    expect(environment.root).toContain(join(f.directory, 'state'))
    expect(environment.token).toBe('temporary-only')
    expect(environment.inline).not.toContain('temporary-only')
    expect(f.gateway).toHaveBeenCalledTimes(2)
    expect(frames.filter(frame => frame.method === 'session/set_model').map(frame => frame.params.modelId)).toEqual(['ekko-studio/studio-model', 'ekko-studio/studio-model'])
  } else { expect(environment.root).toBe(join(f.directory, 'native')); expect(f.gateway).not.toHaveBeenCalled() }
})

it('inspects metadata and resources without creating native history or revealing native auth fields', async () => {
  const f = await setup()
  expect(await f.coordinator.inspectInstance(caller, f.instance.id)).toEqual({ instanceId: f.instance.id, configRevision: 1,
    provider: { kind: 'plugin', pluginId: 'studio.agent-opencode', version: '0.1.0', generation: expect.any(String) }, native: { name: 'opencode-cli', version: '1.19.4' },
    authentication: { state: 'unknown', methods: [{ id: 'opencodecli-login', name: 'Use opencodecli login' }] }, models: { status: 'unsupported', items: [] } })
  expect((await f.frames()).map(frame => frame.method)).toEqual(['initialize'])
  const resources = await f.coordinator.resourceLocations(caller, f.instance.id, 1)
  expect(resources.skills.map(source => source.id)).toContain('native-skills')
  expect(resources.skills.some(source => source.id === 'shared-skills' && source.readOnly)).toBe(true)
  expect(resources.configs.find(source => source.id === 'native-instructions')?.path).toBe(join(f.directory, 'native', 'AGENTS.md'))
  expect(f.db.prepare('SELECT count(*) AS count FROM studio_agent_runs').get()?.count).toBe(0)
})

it('binds native approval options to the owning Run', async () => {
  const f = await setup(), run = f.start('approval')
  await vi.waitFor(() => expect(f.coordinator.interactions(caller, run.id)).toHaveLength(1))
  const interaction = f.coordinator.interactions(caller, run.id)[0]
  await expect(f.coordinator.respond(caller, run.id, { interactionId: interaction.id, idempotencyKey: 'bad', choiceId: 'forged' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  await f.coordinator.respond(caller, run.id, { interactionId: interaction.id, idempotencyKey: 'yes', choiceId: 'yes' })
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(caller, run.id).status).toBe('completed')
})

it.each(['crash', 'wait'])('cleans up OpenCode after %s before another turn', async text => {
  const f = await setup(), run = f.start(text)
  if (text === 'wait') { await vi.waitFor(async () => expect((await f.frames()).some(frame => frame.method === 'session/prompt')).toBe(true)); await f.coordinator.cancel(caller, run.id) }
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(caller, run.id).status).toBe(text === 'wait' ? 'cancelled' : 'failed')
  const next = f.start('hello'); await f.coordinator.wait(next.id)
  expect(f.coordinator.get(caller, next.id).status).toBe('completed')
})

it('rejects foreign and revoked scopes before spawning OpenCode', async () => {
  const f = await setup()
  expect(() => f.coordinator.start({ ...caller, profileId: 'foreign' }, f.instance.id, { content: [{ type: 'text', text: 'hello' }] }, 'foreign')).toThrow()
  f.authorize.mockImplementation(() => { throw new StudioError('FORBIDDEN', 'Revoked') })
  expect(() => f.start('hello')).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  await expect(readFile(f.trace)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('preserves native inline preferences and edited files while isolating scoped credentials and model selection', async () => {
  const directory = await mkdtemp(join(root, 'configuration-')), runtime = { stateDirectory: directory } as AgentRuntimeContext
  const config = { env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ autoupdate: true, instructions: ['custom.md'], permission: { bash: 'ask' },
    provider: { native: { options: { apiKey: 'native-only' } } } }) } }
  const original = structuredClone(config)
  expect(JSON.parse(nativeEnvironment(config).OPENCODE_CONFIG_CONTENT)).toMatchObject({ autoupdate: false, instructions: ['custom.md'], permission: { bash: 'ask' } })
  const gateway = { baseUrl: 'http://127.0.0.1:1/lease/v1', token: 'temporary-only', model: 'provider/custom', protocol: 'chat-completions', images: true } as ModelGatewayHandle
  const first = await scopedOpenCode(runtime, gateway, config)
  const path = join(first.env.OPENCODE_CONFIG_DIR, 'opencode.json')
  await writeFile(path, '{"theme":"native-choice","plugin":["./custom.ts"]}')
  const second = await scopedOpenCode(runtime, { ...gateway, token: 'next-temporary' }, config)
  expect(second.env.OPENCODE_DB).toBe(first.env.OPENCODE_DB)
  expect(await readFile(path, 'utf8')).toBe('{"theme":"native-choice","plugin":["./custom.ts"]}')
  const inline = JSON.parse(second.env.OPENCODE_CONFIG_CONTENT)
  expect(inline).toMatchObject({ instructions: ['custom.md'], permission: { bash: 'ask' }, enabled_providers: ['ekko-studio'], model: 'ekko-studio/studio-model', small_model: 'ekko-studio/studio-model' })
  expect(Object.keys(inline.provider)).toEqual(['ekko-studio'])
  expect(inline.provider['ekko-studio'].models['studio-model'].modalities.input).toContain('image')
  expect(second.env.OPENCODE_CONFIG_CONTENT).not.toContain('temporary')
  expect(second.env.STUDIO_OPENCODE_API_KEY).toBe('next-temporary')
  expect(config).toEqual(original)
  expect(() => nativeEnvironment({ env: { OPENCODE_CONFIG_CONTENT: 'broken' } })).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
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
