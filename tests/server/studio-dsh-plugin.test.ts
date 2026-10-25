import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { build } from 'esbuild'
import { parse, parseDocument, stringify } from 'yaml'
import { dshReleaseFixture } from '../fixtures/dsh-release'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { AgentExecutionStore } from '../../packages/server/src/modules/studio/repositories/agent-execution-store'
import { PluginStore } from '../../packages/server/src/modules/studio/repositories/plugin-store'
import { AgentCoordinator } from '../../packages/server/src/modules/studio/services/agents/coordinator'
import { AgentRegistry } from '../../packages/server/src/modules/studio/services/agents/registry'
import { PluginHost } from '../../packages/server/src/modules/studio/services/plugins/host'
import { PluginEventBus } from '../../packages/server/src/modules/studio/services/events/plugin-events'
import { createExecutionContext } from '../../packages/server/src/modules/studio/services/context/execution'
import { StudioError, type AgentRuntimeContext, type ExecutionScope } from '../../packages/studio-plugin-sdk/src'
import { createDshRuntime } from '../../plugins/dsh/src/runtime'
import { prepareDshWebProfile } from '../../plugins/dsh/src/web-profile'
import { prepareDshRuntime } from '../../plugins/dsh/src/runtime-config'
import { readDshMcpServers } from '../../plugins/dsh/src/config'

const caller: ExecutionScope = { scopeId: 'scope', principal: { kind: 'user', id: 'owner' }, profileId: 'one', surface: 'api', traceId: 'trace' }
let root: string, runner: string, artifact: string
const cleanups: Array<() => Promise<void>> = []
const image = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAANklEQVRIie3WuQkAQAwDwem/aV0VhgsWnAuMnjVOTwJ6kVy0gqaqWG2qwVmTKaoQeAkdfU3XDzLD/C7nwdQVAAAAAElFTkSuQmCC'
const imageId = '11111111-1111-4111-8111-111111111111'
it('blocks the same runtime when gateway cleanup cannot be confirmed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-dsh-cleanup-')), signal = new AbortController().signal
  try {
    const runtime = createDshRuntime({ instanceId: 'fixture', configRevision: 1, mode: 'scoped',
      config: { cwd: directory, command: join(directory, 'missing-cli'), model: 'fixture/model' } },
    { stateDirectory: join(directory, 'state'), signal } as AgentRuntimeContext)
    const gateway = { baseUrl: 'http://127.0.0.1:1/v1', token: 'temporary', model: 'fixture-model', protocol: 'responses',
      dispose: async () => { throw new Error('Gateway cleanup was not confirmed') } }
    const run = await runtime.run({ content: [{ type: 'text', text: 'start' }] }, { signal, models: { gateway: async () => gateway } } as any)
    await expect(run.result).rejects.toThrow('Gateway cleanup was not confirmed')
    await expect(runtime.run({ content: [{ type: 'text', text: 'next' }] }, { signal } as any)).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
  } finally { await rm(directory, { recursive: true, force: true }) }
})
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'studio-dsh-plugin-')); runner = join(root, 'runner.cjs'); artifact = join(root, 'artifact')
  await build({ entryPoints: ['packages/studio-plugin-runner/src/main.ts'], bundle: true, platform: 'node', target: 'node24.22.1', format: 'cjs', outfile: runner, logLevel: 'silent' })
  await build({ entryPoints: ['plugins/dsh/src/index.ts'], bundle: true, platform: 'node', target: 'node24.22.1', format: 'cjs', outfile: join(artifact, 'dist/index.cjs'), logLevel: 'silent', alias: {
    '@ekko-studio/plugin-sdk': resolve('packages/studio-plugin-sdk/src/index.ts'), '@ekko-studio/agent-drivers': resolve('packages/studio-agent-drivers/src/index.ts'),
  } })
  await writeFile(join(artifact, 'studio-plugin.json'), await readFile('plugins/dsh/studio-plugin.json'))
})
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
afterAll(async () => { await rm(root, { recursive: true, force: true }) })

const fixture = `const fs=require('node:fs');
if(process.argv.includes('--version')){fs.appendFileSync(process.env.TRACE,'version\\n');console.log('0.1.7-rc.2');process.exit(0)}
fs.writeFileSync(process.env.TRACE+'.env',JSON.stringify({root:process.env.DSH_HOME,home:process.env.HOME,token:process.env.STUDIO_DSH_MODEL_TOKEN}));
const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\\n');let prompt;
const update=x=>send({method:'session/update',params:{sessionId:'dsh-session',update:x}});
const finish=()=>{
for(const frame of [{type:'start',attemptId:'a'},{type:'text-delta',attemptId:'a',text:'DSH answer'},{type:'commit',attemptId:'a',messageId:'message'},{type:'end',attemptId:'a'}])send({method:'_ekko/assistant_stream',params:{sessionId:'dsh-session',frame}});
update({sessionUpdate:'agent_message_chunk',messageId:'message',content:{type:'text',text:'DSH answer'}});
const usage={requestId:'model-call',model:'native-model',usage:{inputTokens:7,outputTokens:5,cacheReadTokens:3,cacheWriteTokens:2,reasoningTokens:1}};send({method:'_ekko/model_usage',params:usage});send({method:'_ekko/model_usage',params:usage});
send({id:prompt.id,result:{stopReason:'end_turn'}})};
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);fs.appendFileSync(process.env.TRACE,line+'\\n');
if(r.method==='initialize')send({id:r.id,result:{protocolVersion:1,agentCapabilities:{sessionCapabilities:{resume:{}},promptCapabilities:{image:true}},agentInfo:{name:'dsh',version:'0.1.7-rc.2'}}});
else if(['session/new','session/resume'].includes(r.method)){if(process.env.FAIL_RESUME==='1'&&r.method==='session/resume')send({id:r.id,error:{code:-32602,message:'missing native session'}});else send({id:r.id,result:{sessionId:'dsh-session'}})}
else if(r.method==='session/set_config_option')send({id:r.id,result:{}});
else if(r.method==='session/prompt'){prompt=r;const text=r.params.prompt.find(x=>x.type==='text')?.text;
if(text==='crash')process.exit(7);else if(text==='wait')setInterval(()=>{},1000);else if(text==='approval')send({id:'approve',method:'session/request_permission',params:{sessionId:'dsh-session',toolCall:{title:'Read file?'},options:[{optionId:'yes',name:'Allow',kind:'allow_once'}]}});else finish()}
else if(r.method==='session/close'){if(process.env.FAIL_CLOSE==='1')send({id:r.id,error:{code:-32603,message:'flush failed'}});else send({id:r.id,result:{}})}
else if(r.id==='approve'&&r.result?.outcome?.optionId==='yes')finish();else if(r.method==='session/cancel')process.exit(0)
});`

async function nativeTree(directory: string, lineEnding?: '\n' | '\r\n') {
  const cli = join(directory, 'node_modules/@deepseek-ai/dsh/lib/bin.cjs'), sourceHome = join(directory, 'source')
  await mkdir(dirname(cli), { recursive: true }); await mkdir(sourceHome, { recursive: true })
  await writeFile(cli, fixture); await writeFile(join(dirname(cli), '../package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.7-rc.2' }))
  for (const name of ['dsh-base', 'dsh-web-app', 'dsh-acp-app']) {
    const path = join(directory, 'node_modules/@deepseek-ai', name); await mkdir(path, { recursive: true })
    await writeFile(join(path, 'package.json'), JSON.stringify({ name: '@deepseek-ai/' + name, dsh: { bundle: { patch: './patch.yml' } } }))
    await writeFile(join(path, 'patch.yml'), name === 'dsh-web-app' ? '- insert:\n  - id: webserver\n    name: webserver\n  - id: agent-presets\n    name: presets\n    config:\n      default: standard\n' : '[]\n')
  }
  const acp = join(directory, 'node_modules/@deepseek-ai/dsh-acp'); await mkdir(join(acp, 'lib'), { recursive: true })
  await writeFile(join(acp, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-acp', version: '0.1.7-rc.2' }))
  const originalSource = await readFile('tests/fixtures/dsh-acp-compatible.mjs', 'utf8')
  const adapterSource = lineEnding ? originalSource.replace(/\r\n/g, '\n').replace(/\n/g, lineEnding) : originalSource
  await writeFile(join(acp, 'lib/index.js'), adapterSource + '\nexport const protocol = { async initialize(_params) { return {}; } };\n'); await writeFile(join(acp, 'LICENSE'), 'MIT fixture')
  for (const name of ['dsh-sandbox-policy', 'dsh-user-approval']) {
    const path = join(directory, 'node_modules/@deepseek-ai', name); await mkdir(path, { recursive: true })
    await writeFile(join(path, 'package.json'), JSON.stringify({ name: '@deepseek-ai/' + name, main: 'index.js' })); await writeFile(join(path, 'index.js'), '')
  }
  await writeFile(join(sourceHome, 'settings.yaml'), 'theme: dark\n')
  await writeFile(join(sourceHome, 'cordis.patch.yml'), '- id: native-plugin\n  config:\n    preserved: !!js process.env.NATIVE_VALUE\n')
  await writeFile(join(sourceHome, 'AGENTS.md'), 'Native instructions')
  return { cli, sourceHome, acp }
}

async function setup(mode: 'global' | 'scoped' = 'global', env: Record<string, string> = {}, real?: { command: string; baseUrl: string }, lineEnding?: '\n' | '\r\n') {
  const directory = await mkdtemp(join(root, 'fixture-')), trace = join(directory, 'trace'), native = await nativeTree(directory, lineEnding)
  const db = new DatabaseSync(':memory:'), executions = new AgentExecutionStore(db), store = new PluginStore(db), registry = new AgentRegistry(), events = new PluginEventBus()
  const logger = { info() {}, warn() {}, error() {} }, authorize = vi.fn(), disposeGateway = vi.fn(async () => {})
  const gateway = vi.fn(async () => ({ baseUrl: real?.baseUrl || 'http://127.0.0.1:1/v1', token: 'temporary-only', model: 'fixture-model', protocol: 'responses', images: true, dispose: disposeGateway }))
  const context = (scope: ExecutionScope, signal: AbortSignal) => createExecutionContext(scope, signal, logger, { authorize: async () => {},
    agents: { list: async () => [] }, sessions: { get: async () => null }, models: { gateway },
    artifacts: { read: async (_scope, id, offset) => ({ id, offset, mediaType: 'image/png', data: image, byteLength: Buffer.from(image, 'base64').length, nextOffset: Buffer.from(image, 'base64').length, done: true }) } })
  const coordinator = new AgentCoordinator({ store: executions, registry, events, logger, authorize, context, stateRoot: join(directory, 'state'), validateInput(_scope, input) {
    for (const block of input.content) if (block.type === 'image') expect(block).toEqual({ type: 'image', artifactId: imageId, mediaType: 'image/png' })
  } })
  const host = new PluginHost({ store, registry, events, context, logger, runnerPath: runner, artifactsRoot: join(directory, 'installed'),
    eventContext: async (_state, _event, signal) => context(caller, signal), acceptEvents: async batch => { for (const event of batch) events.publish(event) } })
  cleanups.push(async () => { await coordinator.close(); await host.close(); events.close(); db.close() })
  const manifest = JSON.parse(await readFile(join(artifact, 'studio-plugin.json'), 'utf8'))
  await host.registerSystemArtifact(artifact, manifest.id)
  await host.configure({ pluginId: manifest.id, profileId: caller.profileId, ownerId: caller.principal.id, enabled: true, config: {}, grants: manifest.requires.capabilities }, 0)
  const config: any = { approvalRequired: true, cwd: directory, command: process.execPath, args: [real?.command || native.cli], model: real ? JSON.stringify(['native-web', 'fixture-model']) : 'native-model', agentPreset: 'custom-preset',
    env: { TRACE: trace, HOME: directory, USERPROFILE: directory, DSH_HOME: native.sourceHome, ...env } }
  if (real) {
    const mcp = join(directory, 'mcp.cjs')
    await writeFile(mcp, `const fs=require('node:fs');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;let result;if(r.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'dsh-probe',version:'1.0.0'}};else if(r.method==='tools/list')result={tools:[{name:'studio_mcp_echo',description:'DSH managed MCP test',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]};else if(r.method==='tools/call'){fs.appendFileSync(${JSON.stringify(join(directory, 'mcp-trace'))},JSON.stringify(r.params)+'\\n');result={content:[{type:'text',text:'DSH_MCP_NATIVE_RESULT'}]}}else result={};console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result}))})`)
    config.mcpServers = { 'studio-probe': { command: process.execPath, args: [mcp], env: { ELECTRON_RUN_AS_NODE: '1' } } }
    const profile = join(native.sourceHome, 'profiles/web'); await mkdir(profile, { recursive: true })
    const release = await dshReleaseFixture(real.command), nativeRequire = createRequire(real.command)
    const tool = join(native.sourceHome, 'custom-tool.mjs')
    await writeFile(tool, `import { defineTool } from ${JSON.stringify(pathToFileURL(nativeRequire.resolve('@deepseek-ai/dsh-tools')).href)}; export const inject=['tools','skills']; export function apply(ctx){ctx.skills.register({name:'studio-native-skill',description:'DSH_PLUGIN_NATIVE_SKILL',content:'DSH skill body',source:'bundled'});ctx.tools.register(defineTool({name:'studio_probe',description:'Test native preset',parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute(){return 'DSH_NATIVE_PRESET_RESULT'}}))}`)
    const plugins = parseDocument(release.standard); plugins.add({ id: 'studio-native-probe', name: pathToFileURL(tool).href })
    const declaration = parseDocument('- insert:\n  - id: preset-custom\n    name: "@deepseek-ai/dsh-agent-preset"\n    config:\n      id: custom-preset\n      name: Studio test preset\n      plugins: []\n')
    declaration.setIn([0, 'insert', 0, 'config', 'plugins'], plugins.contents)
    const nativeModel = { provider: 'native-web', model: 'fixture-model' }, nativeProviders = { providers: { 'native-web': { apiKeyEnv: 'STUDIO_DSH_NATIVE_FIXTURE_TOKEN', api: 'openai-responses', baseURL: real.baseUrl, models: [{ id: 'fixture-model', input: ['text','image'], contextWindow: 128000, maxTokens: 8192 }] } } }
    // Registry releases store these volatile selections in the Web composition,
    // while legacy releases also read settings.yaml. Model both native layouts.
    declaration.add({ id: 'agent-default-model', config: nativeModel })
    declaration.add({ id: 'llm-pi-ai', config: nativeProviders })
    await writeFile(join(profile, 'cordis.patch.yml'), String(declaration))
    await writeFile(join(native.sourceHome, 'cordis.patch.yml'), '[]\n')
    await writeFile(join(native.sourceHome, 'settings.yaml'), stringify({ 'agent-default-model': nativeModel, 'llm-pi-ai': nativeProviders }))
  }
  const instance = coordinator.createInstance(caller, { agentTypeId: 'dsh', mode, config })
  let sequence = 0
  const start = (text: string, withImage = false) => coordinator.start(caller, instance.id, { content: [{ type: 'text', text }, ...(withImage ? [{ type: 'image' as const, artifactId: imageId, mediaType: 'image/png' }] : [])] }, `run-${++sequence}`)
  const frames = async () => (await readFile(trace, 'utf8')).trim().split('\n').filter(line => line !== 'version').map(line => JSON.parse(line))
  return { db, coordinator, registry, host, executions, instance, config, directory, trace, gateway, disposeGateway, authorize, start, frames, ...native }
}

it.each([['LF', '\n'], ['CRLF', '\r\n']] as const)('adapts %s native source in its independent worker without changing installed bytes or diagnostic identity', async (_name, lineEnding) => {
  const f = await setup('global', {}, undefined, lineEnding), sourcePath = join(f.acp, 'lib/index.js')
  const original = await readFile(sourcePath), hash = createHash('sha256').update(original).digest('hex')
  expect(original.includes(Buffer.from(lineEnding))).toBe(true)
  for (const text of ['hello', 'continue']) {
    const run = f.start(text); await f.coordinator.wait(run.id)
    expect(f.coordinator.get(caller, run.id)).toMatchObject({ status: 'completed' })
  }
  const frames = await f.frames()
  expect(frames.filter(frame => frame.method === 'session/new')).toHaveLength(1)
  expect(frames.filter(frame => frame.method === 'session/resume')).toHaveLength(1)
  expect(frames.filter(frame => frame.method === 'session/close')).toHaveLength(2)
  expect(await readFile(sourcePath)).toEqual(original)
  const environment = JSON.parse(await readFile(f.trace + '.env', 'utf8'))
  const profiles = (await readdir(join(environment.root, 'profiles'))).filter(name => name.startsWith('studio-web-'))
  expect(profiles).toHaveLength(1)
  const adapted = await readFile(join(environment.root, 'profiles', profiles[0], 'studio-acp.mjs'), 'utf8')
  expect(adapted).toContain(`source sha256 ${hash}.`)
  expect(adapted).toContain('agentPreset: params._meta?.agentPreset')
  expect(adapted).toContain('await this.ctx.sessions.flush(this.agent.session)')
  expect(adapted).toContain('await ctx.get("loader")?.await()')
})

it.each(['global', 'scoped'] as const)('runs DSH Web profile, preserves presets, deduplicates native live output and closes before restoring (%s)', async mode => {
  const f = await setup(mode), original = await readFile(join(f.sourceHome, 'cordis.patch.yml'), 'utf8')
  for (const text of ['hello', 'continue']) {
    const run = f.start(text); await f.coordinator.wait(run.id)
    expect(f.coordinator.get(caller, run.id)).toMatchObject({ status: 'completed' })
    const output = f.coordinator.output(caller, run.id, -1)
    expect(output.filter(event => event.type === 'message.delta').map(event => event.text).join('')).toBe('DSH answer')
    const usage = output.filter(event => event.type === 'usage.reported')
    expect(usage).toHaveLength(mode === 'global' ? 1 : 0)
    if (mode === 'global') expect(usage[0]).toMatchObject({ inputTokens: 12, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2, reasoningTokens: 1 })
  }
  const frames = await f.frames()
  expect(frames.filter(frame => frame.method === 'session/new')).toEqual([expect.objectContaining({ params: expect.objectContaining({ _meta: { agentPreset: 'custom-preset' } }) })])
  expect(frames.filter(frame => frame.method === 'session/resume')).toHaveLength(1)
  expect(frames.filter(frame => frame.method === 'session/close')).toHaveLength(2)
  const environment = JSON.parse(await readFile(f.trace + '.env', 'utf8'))
  expect(environment.root).toContain(join(f.directory, 'state'))
  expect(await readFile(join(f.sourceHome, 'cordis.patch.yml'), 'utf8')).toBe(original)
  expect(await readFile(join(environment.root, 'AGENTS.md'), 'utf8')).toContain('Native instructions')
  const overlayText = await readFile(join(environment.root, 'studio.patch.yml'), 'utf8'), overlay = parse(overlayText)
  expect(overlay.find((row: any) => row.id === 'sandbox-policy').config.mode).toBe('danger-full-access')
  expect(overlay.find((row: any) => row.id === 'approval').config.policy).toBe('never')
  if (mode === 'scoped') {
    expect(environment.token).toBe('temporary-only'); expect(overlayText).not.toContain('temporary-only')
    expect(overlay.find((row: any) => row.id === 'llm-pi-ai').config.providers['ekko-studio']).toMatchObject({ apiKeyEnv: 'STUDIO_DSH_MODEL_TOKEN', api: 'openai-responses' })
    expect(f.gateway).toHaveBeenCalledTimes(2); expect(f.disposeGateway).toHaveBeenCalledTimes(2)
  } else { expect(environment.token).toBeUndefined(); expect(f.gateway).not.toHaveBeenCalled() }
})

it('keeps the native scoped model identity stable while the selected host model changes', async () => {
  const f = await setup('scoped')
  const first = f.start('hello'); await f.coordinator.wait(first.id)
  await f.coordinator.updateInstance(caller, f.instance.id, { revision: 1, mode: 'scoped', config: { ...f.config, model: 'another-host-model' } })
  const second = f.start('continue'); await f.coordinator.wait(second.id)
  expect(f.coordinator.get(caller, second.id).status).toBe('completed')
  expect(f.gateway).toHaveBeenLastCalledWith(expect.anything(), { model: 'another-host-model', protocol: 'responses' }, expect.any(AbortSignal))
  expect((await f.frames()).filter(frame => frame.method === 'session/set_config_option').map(frame => frame.params.value))
    .toEqual([JSON.stringify(['ekko-studio', 'studio-model']), JSON.stringify(['ekko-studio', 'studio-model'])])
})

it('inspects only bounded CLI metadata without creating native history or Runs', async () => {
  const f = await setup(), result = await f.coordinator.inspectInstance(caller, f.instance.id)
  expect(result.native).toEqual({ name: 'DeepSeek Harness', version: '0.1.7-rc.2' }); expect(result.authentication.state).toBe('unknown'); expect(result.models.status).toBe('unsupported')
  expect(await f.frames()).toEqual([])
  const resources = await f.coordinator.resourceLocations(caller, f.instance.id, 1)
  expect(resources.skills.find(item => item.id === 'shared-skills')?.readOnly).toBe(true)
  expect(resources.configs.find(item => item.id === 'native-mcp')?.path).toBe(join(f.sourceHome, 'cordis.patch.yml'))
  expect(f.db.prepare('SELECT count(*) AS count FROM studio_agent_runs').get()?.count).toBe(0)
  const guidance = await f.coordinator.setupInstance(caller, f.instance.id, 1)
  expect(guidance.installation.args).toEqual(['install', '--global', '@deepseek-ai/dsh@0.1.7-rc.2', '--prefer-dedupe'])
})

it('preserves source config and native credentials while overriding managed MCP and all scoped model selectors privately', async () => {
  const directory = await mkdtemp(join(root, 'config-')), native = await nativeTree(directory), rootDir = join(directory, 'runtime')
  const original = '- insert:\n  - id: native-mcp\n    name: "@deepseek-ai/dsh-mcp-client"\n    config:\n      serverName: native\n      command: original\n      env:\n        KEPT: !!js process.env.PRIVATE_SETTING\n'
  const settings = 'agent-default-model:\n  provider: old\n  model: old\nsubagent-model-selection: { provider: old }\nllm-pi-ai:\n  providers:\n    ekko-studio: { baseURL: "https://old.example/v1" }\n    native: { apiKeyEnv: NATIVE_TOKEN }\n'
  await writeFile(join(native.sourceHome, 'cordis.patch.yml'), original); await writeFile(join(native.sourceHome, 'settings.yaml'), settings)
  await writeFile(join(native.sourceHome, '.credentials.yaml'), 'native: account-reference\n')
  const prepared = await prepareDshRuntime({ sourceHome: native.sourceHome, rootDir, sharedSkills: join(directory, 'shared'), installationCommand: native.cli,
    systemPrompt: 'Managed instructions', managedMcp: { native: { command: 'replacement', args: ['mcp'], enabled: false, env: { ELECTRON_RUN_AS_NODE: '1' } } },
    model: 'fixture-model', baseUrl: 'http://127.0.0.1:1/v1', imageInput: true, contextPolicy: { threshold: 0.8 } })
  const copiedSettings = parse(await readFile(join(rootDir, 'settings.yaml'), 'utf8'))
  expect(copiedSettings['agent-default-model']).toBeUndefined(); expect(copiedSettings['subagent-model-selection']).toBeUndefined()
  expect(copiedSettings['llm-pi-ai'].providers).toEqual({ native: { apiKeyEnv: 'NATIVE_TOKEN' } })
  expect(readDshMcpServers(await readFile(join(rootDir, 'cordis.patch.yml'), 'utf8')).get('native')).toEqual({ command: 'replacement', args: ['mcp'], env: { ELECTRON_RUN_AS_NODE: '1' }, transport: 'stdio', enabled: false })
  expect(await readFile(join(native.sourceHome, 'cordis.patch.yml'), 'utf8')).toBe(original)
  expect(await readFile(join(native.sourceHome, 'settings.yaml'), 'utf8')).toBe(settings)
  expect(await readFile(join(rootDir, '.credentials.yaml'), 'utf8')).toBe('native: account-reference\n')
  expect(await readFile(prepared.promptFile, 'utf8')).toContain('Managed instructions')
  expect(await readFile(join(rootDir, 'studio.patch.yml'), 'utf8')).not.toContain('account-reference')
})

it('binds unexpected native ACP approval to the owning Run', async () => {
  const f = await setup(), run = f.start('approval')
  await vi.waitFor(() => expect(f.coordinator.interactions(caller, run.id)).toHaveLength(1))
  const interaction = f.coordinator.interactions(caller, run.id)[0]
  await expect(f.coordinator.respond(caller, run.id, { interactionId: interaction.id, idempotencyKey: 'bad', choiceId: 'forged' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  await f.coordinator.respond(caller, run.id, { interactionId: interaction.id, idempotencyKey: 'yes', choiceId: 'yes' })
  await f.coordinator.wait(run.id); expect(f.coordinator.get(caller, run.id)).toMatchObject({ status: 'completed' })
})

it.each(['crash', 'wait'])('cleans owned DSH resources after %s and admits a later turn', async text => {
  const f = await setup(), run = f.start(text)
  if (text === 'wait') { await vi.waitFor(async () => expect((await f.frames()).some(frame => frame.method === 'session/prompt')).toBe(true)); await f.coordinator.cancel(caller, run.id) }
  await f.coordinator.wait(run.id); expect(f.coordinator.get(caller, run.id).status).toBe(text === 'wait' ? 'cancelled' : 'failed')
  const next = f.start('hello'); await f.coordinator.wait(next.id); expect(f.coordinator.get(caller, next.id)).toMatchObject({ status: 'completed' })
})

it('refuses native flush failure instead of publishing a completed checkpoint', async () => {
  const f = await setup('global', { FAIL_CLOSE: '1' }), run = f.start('hello')
  await f.coordinator.wait(run.id); expect(f.coordinator.get(caller, run.id).status).toBe('failed')
})

it('reports resume failure without creating a replacement conversation', async () => {
  const f = await setup('global', { FAIL_RESUME: '1' }), first = f.start('hello'); await f.coordinator.wait(first.id)
  const next = f.start('continue'); await f.coordinator.wait(next.id); expect(f.coordinator.get(caller, next.id).status).toBe('failed')
  expect((await f.frames()).filter(frame => frame.method === 'session/new')).toHaveLength(1)
})

it('rejects compact explicitly and rejects revoked/foreign scope before spawn', async () => {
  const f = await setup(), run = f.start('/compact'); await f.coordinator.wait(run.id); expect(f.coordinator.get(caller, run.id).status).toBe('failed')
  expect(() => f.coordinator.start({ ...caller, profileId: 'foreign' }, f.instance.id, { content: [{ type: 'text', text: 'hello' }] }, 'foreign')).toThrow()
  f.authorize.mockImplementation(() => { throw new StudioError('FORBIDDEN', 'Revoked') }); expect(() => f.start('hello')).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  await expect(readFile(f.trace)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('fails incompatible native preset integration before writing an adapter or spawning DSH', async () => {
  const f = await setup(); await writeFile(join(f.acp, 'lib/index.js'), 'export const apply = () => {}')
  await expect(prepareDshWebProfile({ command: f.cli, sourceHome: f.sourceHome, rootDir: join(f.directory, 'probe') })).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
  const run = f.start('hello'); await f.coordinator.wait(run.id); expect(f.coordinator.get(caller, run.id).status).toBe('failed')
  await expect(readFile(f.trace)).rejects.toMatchObject({ code: 'ENOENT' })
})

it.skipIf(!process.env.STUDIO_DSH_REAL_COMMAND).each(['global', 'scoped'] as const)('runs actual pinned DSH in its plugin worker with preset tools, skills and cross-process native history (%s)', async mode => {
  const requests: any[] = []
  let releaseStream = () => {}, streamFinished = false
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    requests.push(JSON.parse(body)); const id = `response-${requests.length}`, tool = requests.length <= 2
    const toolName = requests.length === 1 ? 'studio_probe' : requests.at(-1).tools.find((entry: any) => entry.name.includes('studio_mcp_echo'))?.name
    const args = requests.length === 1 ? '{}' : JSON.stringify({ text: 'DSH_MCP_ARGUMENT' })
    const item = tool ? { id: `tool-${id}`, type: 'function_call', call_id: `call-${id}`, name: toolName, arguments: args, status: 'completed' }
      : { id: `message-${id}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Native DSH answer', annotations: [] }] }
    const response = { id, object: 'response', status: 'completed', model: 'fixture-model', output: [item], usage: { input_tokens: 30, output_tokens: 5, total_tokens: 35, input_tokens_details: { cached_tokens: 20 } } }
    const events: any[] = [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }, { type: 'response.output_item.added', output_index: 0, item: tool ? { ...item, arguments: '' } : { ...item, content: [] } }]
    if (tool) events.push({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: args }, { type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: args })
    else events.push({ type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }, { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'Native DSH answer' }, { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: 'Native DSH answer' })
    events.push({ type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const event of events) {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      if (requests.length === 3 && event.type === 'response.output_text.delta') await new Promise<void>(resolve => { releaseStream = resolve })
    }
    if (requests.length === 3) streamFinished = true
    res.end()
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  cleanups.push(async () => { releaseStream(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const f = await setup(mode, { STUDIO_DSH_NATIVE_FIXTURE_TOKEN: 'local-fixture-only' }, { command: process.env.STUDIO_DSH_REAL_COMMAND!, baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1` })
  const first = f.start('NATIVE_PLUGIN_FIRST_TURN', true)
  try {
    await vi.waitFor(() => expect(f.coordinator.output(caller, first.id, -1).some(event => event.type === 'message.delta' && event.text === 'Native DSH answer'), JSON.stringify({ run: f.coordinator.get(caller, first.id), requests: requests.map(request => ({ model: request.model, tools: request.tools.map((tool: any) => tool.name) })), output: f.coordinator.output(caller, first.id, -1) })).toBe(true), { timeout: 15000 })
    expect(streamFinished).toBe(false)
  } finally { releaseStream() }
  await f.coordinator.wait(first.id)
  expect(f.coordinator.get(caller, first.id).status, JSON.stringify(f.coordinator.output(caller, first.id, -1))).toBe('completed')
  const next = f.start('NATIVE_PLUGIN_SECOND_TURN'); await f.coordinator.wait(next.id)
  expect(f.coordinator.get(caller, next.id).status, JSON.stringify(f.coordinator.output(caller, next.id, -1))).toBe('completed')
  expect(requests).toHaveLength(4)
  expect(requests[0].tools.map((tool: any) => tool.name)).toContain('studio_probe')
  expect(JSON.stringify(requests[0])).toContain('DSH_PLUGIN_NATIVE_SKILL')
  expect(JSON.stringify(requests[1].input)).toContain('DSH_NATIVE_PRESET_RESULT')
  expect(JSON.stringify(requests[2].input)).toContain('DSH_MCP_NATIVE_RESULT')
  expect(JSON.stringify(requests[3].input)).toContain('NATIVE_PLUGIN_FIRST_TURN')
  expect(JSON.stringify(requests[3].input)).toContain('Native DSH answer')
  expect(requests[3].tools.map((tool: any) => tool.name)).toContain('studio_probe')
  expect(JSON.stringify(requests[3])).toContain('DSH_PLUGIN_NATIVE_SKILL')
  expect(JSON.stringify(requests[0].input)).toContain('data:image/png;base64,')
  expect(await readFile(join(f.directory, 'mcp-trace'), 'utf8')).toContain('DSH_MCP_ARGUMENT')
  expect(requests.every(request => request.model === (mode === 'scoped' ? 'studio-model' : 'fixture-model'))).toBe(true)
  expect(requests[0].tools.some((tool: any) => tool.name.includes('studio_mcp_echo'))).toBe(true)
  const output = f.coordinator.output(caller, first.id, -1)
  expect(output.filter(event => event.type === 'message.delta').map(event => event.text).join('')).toBe('Native DSH answer')
  expect(output.filter(event => event.type === 'usage.reported')).toHaveLength(mode === 'global' ? 3 : 0)
}, 90000)


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
