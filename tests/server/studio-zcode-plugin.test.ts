import { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { build } from 'esbuild'
import sharp from 'sharp'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { AgentExecutionStore } from '../../packages/server/src/modules/studio/repositories/agent-execution-store'
import { PluginStore } from '../../packages/server/src/modules/studio/repositories/plugin-store'
import { AgentCoordinator } from '../../packages/server/src/modules/studio/services/agents/coordinator'
import { AgentRegistry } from '../../packages/server/src/modules/studio/services/agents/registry'
import { PluginHost } from '../../packages/server/src/modules/studio/services/plugins/host'
import { PluginEventBus } from '../../packages/server/src/modules/studio/services/events/plugin-events'
import { createExecutionContext } from '../../packages/server/src/modules/studio/services/context/execution'
import { StudioError, type ExecutionScope } from '../../packages/studio-plugin-sdk/src'
// @ts-expect-error Local plugin build is ESM JavaScript.
import { buildZcode } from '../../plugins/zcode/scripts/build.mjs'

const caller: ExecutionScope = { scopeId: 'scope', principal: { kind: 'user', id: 'owner' }, profileId: 'one', surface: 'api', traceId: 'trace' }
let root: string, runner: string
const cleanups: Array<() => Promise<void>> = []
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'studio-zcode-')); runner = join(root, 'runner.cjs')
  await build({ entryPoints: ['packages/studio-plugin-runner/src/main.ts'], bundle: true, platform: 'node', target: 'node24.22.1', format: 'cjs', outfile: runner, logLevel: 'silent' })
  await buildZcode(join(root, 'plugin'))
})
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
afterAll(async () => { await rm(root, { recursive: true, force: true }) })

const fixture = `const fs=require('node:fs'),path=require('node:path');
if(process.argv.includes('--version')){console.log('0.16.9');process.exit(0)}
fs.appendFileSync(process.env.TRACE+'.launch',JSON.stringify({args:process.argv.slice(2),home:process.env.HOME,storage:process.env.ZCODE_STORAGE_DIR,provider:process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE,personal:JSON.parse(fs.readFileSync(process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE,'utf8'))})+'\\n');
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');let seq=0,sid='sess_fixture',inputId;
const event=(type,payload)=>send({method:'session/event',params:{sessionId:sid,seq:++seq,type,payload}});
const workspace=foreign=>{if(foreign){const target=path.join(process.cwd(),'foreign-workspace');fs.mkdirSync(target,{recursive:true});return target;}if(process.env.WORKSPACE_ALIAS){const target=path.join(process.cwd(),'workspace-alias');if(!fs.existsSync(target))fs.symlinkSync(process.cwd(),target,process.platform==='win32'?'junction':'dir');return target;}return process.cwd();};
const snapshot=(foreign=false)=>({protocol:{name:'ZCode Protocol',version:1},session:{sessionId:process.env.WRONG_SESSION?'sess_foreign':sid,workspace:{workspacePath:workspace(foreign||process.env.FOREIGN_WORKSPACE==='1')},status:'idle'},runtime:{eventSeq:0},slashCommands:[]});
fs.appendFileSync(process.env.TRACE+'.workspace',JSON.stringify({cwd:process.cwd(),realpath:fs.realpathSync.native(process.cwd()),reported:workspace(false)})+'\\n');
const finish=()=>{event('model.streaming',{kind:'text_delta',assistantMessageId:'native',delta:'Partial'});send({method:'v4/telemetry/event',params:{sessionId:sid,kind:'usage.delta',requestId:'call',modelId:'native-model',inputTokens:15,outputTokens:5,cacheReadTokens:2,cacheWriteTokens:1,reasoningTokens:1}});event('turn.completed',{inputId,response:'Native ZCode answer',resultType:'success',usage:{source:'provider',inputTokens:15,outputTokens:5}});if(process.env.GATE){const timer=setInterval(()=>{if(fs.existsSync(process.env.CONTROL_FILE)){clearInterval(timer);send({method:'state.updated',params:{sessionId:sid,reason:'prompt_completed'}})}},10)}else send({method:'state.updated',params:{sessionId:sid,reason:'prompt_completed'}})};
let buffer='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{buffer+=chunk;while(buffer.includes('\\n')){const end=buffer.indexOf('\\n'),r=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);fs.appendFileSync(process.env.TRACE,JSON.stringify(r)+'\\n');const reply=result=>send({id:r.id,result});
if(r.method==='session/create'||r.method==='session/resume'){if(r.params.sessionId)sid=r.params.sessionId;send({id:'preferences',method:'session/requestRuntimePreferences',params:{sessionId:sid,scope:'runtime-materialization'}});reply(snapshot())}
else if(r.method==='session/read')reply(snapshot(process.env.FOREIGN_READ_WORKSPACE==='1'));
else if(r.method==='session/subscribe'||r.method==='session/setMode'||r.method==='session/setModel')reply({});
else if(r.method==='session/send'){inputId=r.params.inputId;reply({accepted:true,sessionId:sid});if(r.params.content==='crash')process.exit(7);if(r.params.content==='wait')continue;if(r.params.content==='invalid'){process.stdout.write('not-json\\n');continue;}if(r.params.content==='failure'){event('turn.failed',{inputId,error:{message:'native failure'}});continue;}
if(['approve','question','withdraw'].includes(r.params.content)){send({id:'dialog',method:r.params.content==='question'?'interaction/requestUserInput':'interaction/requestPermission',params:{sessionId:sid,requestId:'native-dialog',toolName:'Bash',reason:'Run tool?',options:[{optionId:'once',name:'Allow once',response:{decision:'allow'}},{optionId:'deny',name:'Deny',response:{decision:'deny'}}],questions:[{question:'Which?',options:[{value:'one',label:'One'},{value:'two',label:'Two'}]}]}});if(r.params.content==='withdraw'){setTimeout(()=>{event('permission.resolved',{requestId:'native-dialog'});finish()},40)}continue;}
finish();}
else if(r.id==='dialog'&&!r.method){finish();}
}});process.stdin.on('end',()=>process.exit(process.env.LATE_FAILURE?7:0));`

async function setup(mode: 'global' | 'scoped' = 'global', extra: Record<string, string> = {}, actual = false) {
  const imageData = (await sharp({ create: { width: 32, height: 32, channels: 3, background: 'red' } }).png().toBuffer()).toString('base64')
  const directory = await mkdtemp(join(root, 'fixture-')), trace = join(directory, 'trace'), cli = join(directory, 'cli.cjs')
  await writeFile(cli, fixture)
  const db = new DatabaseSync(':memory:'), executions = new AgentExecutionStore(db), store = new PluginStore(db), registry = new AgentRegistry(), events = new PluginEventBus()
  const logger = { info() {}, warn() {}, error() {} }, authorize = vi.fn(), requests: any[] = []
  const server = createServer(async (request, response) => {
    let data = ''; for await (const chunk of request) data += chunk.toString()
    const body = JSON.parse(data || '{}'); requests.push({ url: request.url, key: request.headers['x-api-key'], body })
    let nativeTool: { name: string; input: any } | undefined
    const messages = body.messages || [], latest = messages.at(-1), latestText = JSON.stringify(latest)
    const turn = [...messages].reverse().find(message => message.role === 'user' && !JSON.stringify(message).includes('tool_result'))
    const text = JSON.stringify(turn).includes('Second request') ? 'ZCODE_SECOND' : 'ZCODE_OK'
    if (JSON.stringify(turn).includes('RESOURCE_REQUEST')) {
      if (!latestText.includes('tool_result')) { const tool = body.tools?.find(tool => tool.name === 'Skill'); if (tool) nativeTool = { name: tool.name, input: { skill: 'studio-zcode-check' } } }
      else if (!latestText.includes('ZCODE_MCP_ACTUAL_SENTINEL')) { const tool = body.tools?.find(tool => tool.name.includes('marker')); if (tool) nativeTool = { name: tool.name, input: {} } }
    }
    const message = { id: 'msg-fixture', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 } }
    if (request.url?.endsWith('/count_tokens')) { response.setHeader('content-type', 'application/json'); response.end('{"input_tokens":10}'); return }
    if (!body.stream) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(message)); return }
    response.setHeader('content-type', 'text/event-stream')
    const frames: any[] = [{ type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }, { type: 'message_stop' }]
    if (nativeTool) frames.splice(1, 3, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool-' + requests.length, name: nativeTool.name, input: {} } }, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(nativeTool.input) } }, { type: 'content_block_stop', index: 0 })
    if (nativeTool) frames.find(event => event.type === 'message_delta').delta.stop_reason = 'tool_use'
    response.end(frames.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  const mcpTrace = join(directory, 'mcp-trace'), mcpScript = join(directory, 'mcp.cjs')
  await writeFile(mcpScript, `const fs=require('node:fs');let b='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>{b+=c;while(b.includes('\\n')){let i=b.indexOf('\\n'),r=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(r.id===undefined)continue;let result=r.method==='initialize'?{protocolVersion:r.params.protocolVersion,serverInfo:{name:'fixture',version:'1.0.0'},capabilities:{tools:{}}}:r.method==='tools/list'?{tools:[{name:'marker',description:'Return the local fixture marker',inputSchema:{type:'object',properties:{},additionalProperties:false}}]}:r.method==='tools/call'?{content:[{type:'text',text:'ZCODE_MCP_ACTUAL_SENTINEL'}]}:{};if(r.method==='tools/call')fs.appendFileSync(process.env.MCP_TRACE,JSON.stringify(r)+'\\n');process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n')}});`)
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) })
  const gateway = vi.fn(async () => ({ baseUrl, token: 'temporary-host-secret', model: 'fixture-model', protocol: 'anthropic', images: true, dispose: async () => { if (extra.CLEANUP_FAILURE === '1') throw new StudioError('RUNTIME_UNAVAILABLE', 'Fixture cleanup failure') } }))
  const context = (scope: ExecutionScope, signal: AbortSignal) => createExecutionContext(scope, signal, logger, { authorize: async () => {}, agents: { list: async () => [] }, sessions: { get: async () => null }, models: { gateway }, artifacts: { read: async (_scope, id, offset = 0) => {
    const data = imageData;
    if (id !== '00000000-0000-0000-0000-000000000001' || offset !== 0) throw new Error('Invalid fixture image');
    return { id, mediaType: 'image/png', byteLength: Buffer.from(data, 'base64').length, offset: 0, nextOffset: Buffer.from(data, 'base64').length, done: true, data };
  } } })
  const coordinatorOptions = { validateInput(_scope: ExecutionScope, input: any) { for (const block of input.content) if (block.type === 'image' && block.artifactId !== '00000000-0000-0000-0000-000000000001') throw new Error('Foreign fixture image') }, store: executions, registry, events, logger, authorize, context, stateRoot: join(directory, 'state') }
  let coordinator = new AgentCoordinator(coordinatorOptions)
  const host = new PluginHost({ store, registry, events, context, logger, runnerPath: runner, artifactsRoot: join(directory, 'installed'), eventContext: async (_state, _event, signal) => context(caller, signal), acceptEvents: async batch => { for (const event of batch) events.publish(event) } })
  cleanups.push(async () => { await coordinator.close(); await host.close(); events.close(); db.close() })
  const manifest = JSON.parse(await readFile(join(root, 'plugin/studio-plugin.json'), 'utf8'))
  await host.registerSystemArtifact(join(root, 'plugin'), manifest.id)
  await host.configure({ pluginId: manifest.id, profileId: caller.profileId, ownerId: caller.principal.id, enabled: true, config: {}, grants: manifest.requires.capabilities }, 0)
  const personal = join(directory, 'personal.json'), builtin = join(directory, 'builtin.json')
  await writeFile(builtin, JSON.stringify({ config: { modelConfigRules: { builtinProviderModelRules: [{ providerId: 'fixture', modelId: 'native-model' }] } } }))
  const nativePersonal = { schemaVersion: 1, config: { providerConfigRules: { providerRules: [{ providerId: 'fixture', providerName: 'Fixture', config: { group: 'standard-personal', access: { type: 'api-key', apiKey: 'native-local-key' }, api: { type: 'anthropic-messages', baseUrl }, personalModelIds: ['fixture-model'] } }] }, modelConfigRules: { providerModelRules: [{ modelId: 'fixture-model', config: { properties: { inputFormat: { supportsText: true, supportsImage: true, supportsVideo: false, supportsAudio: false, supportsPdf: false } } }, providerId: 'fixture' }], manualProviderModelRules: [] }, defaultModelSelection: { providerId: 'fixture', modelId: 'fixture-model' } } }
  await writeFile(personal, JSON.stringify(nativePersonal, null, 2))
  const config = { ...(actual ? { systemPrompt: 'ZCODE_SYSTEM_SENTINEL', mcpServers: { fixture: { command: process.execPath, args: [mcpScript], env: { MCP_TRACE: mcpTrace, ELECTRON_RUN_AS_NODE: '1' } } } } : {}), approvalRequired: true, cwd: directory, command: process.execPath, args: [actual ? process.env.STUDIO_ZCODE_COMMAND! : cli], ...(actual && mode === 'global' ? {} : { model: mode === 'scoped' ? 'studio/model' : 'native-model' }),
    env: { TRACE: trace, HOME: directory, USERPROFILE: directory, ZCODE_DATA_BASE_DIR: directory, ZCODE_STORAGE_DIR: join(directory, 'native'), ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal, ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: actual ? process.env.STUDIO_ZCODE_BUILTIN_CONFIG || join(dirname(dirname(process.env.STUDIO_ZCODE_COMMAND!)), 'config', 'provider', 'zcode-builtin.json') : builtin, ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE: '', CONTROL_FILE: join(directory, 'control'), ...extra } }
  const instance = coordinator.createInstance(caller, { agentTypeId: 'zcode', mode, config })
  let sequence = 0
  const start = (text: string, content?: any[]) => coordinator.start(caller, instance.id, { content: content || [{ type: 'text', text }] }, `run-${++sequence}`)
  const frames = async () => (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const restart = async () => { await coordinator.close(); coordinator = new AgentCoordinator(coordinatorOptions) }
  return { db, get coordinator() { return coordinator }, restart, registry, host, executions, instance, config, directory, trace, personal, nativePersonal, control: join(directory, 'control'), gateway, requests, mcpTrace, authorize, start, frames }
}

it.each(['global', 'scoped'] as const)('runs and restores the exact native conversation through a real %s plugin worker', async mode => {
  const f = await setup(mode)
  for (const text of ['hello', 'continue']) {
    const run = f.start(text); await f.coordinator.wait(run.id)
    const result = f.coordinator.get(caller, run.id)
    expect(result.status, JSON.stringify({ result, output: f.coordinator.output(caller, run.id, -1), workspace: await readFile(f.trace + '.workspace', 'utf8').catch(() => 'Native process did not record its workspace') })).toBe('completed')
    expect(f.coordinator.output(caller, run.id, -1)).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'message.snapshot', text: 'Native ZCode answer' })]))
    expect(f.coordinator.usage(caller, run.id)).toHaveLength(mode === 'global' ? 1 : 0)
    if (mode === 'global') expect(f.coordinator.usage(caller, run.id)[0]).toMatchObject({ inputTokens: 15, cacheReadTokens: 2, cacheWriteTokens: 1, reasoningTokens: 1 })
    await f.restart()
  }
  const frames = await f.frames()
  expect(frames.find(frame => frame.method === 'session/resume')?.params.sessionId).toBe('sess_fixture')
  expect(frames.some(frame => frame.id === 'preferences' && frame.result?.askUserQuestionAutoResolutionEnabled === false)).toBe(true)
  const launches = (await readFile(f.trace + '.launch', 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(launches.every(launch => !JSON.stringify(launch).includes('temporary-host-secret'))).toBe(true)
  if (mode === 'scoped') for (const launch of launches) { expect(launch.home).toContain(join(f.directory, 'state')); await expect(readFile(launch.provider)).rejects.toMatchObject({ code: 'ENOENT' }) }
  expect(await readFile(f.personal, 'utf8')).toBe(JSON.stringify(f.nativePersonal, null, 2))
  expect(() => f.host.uninstall('studio.agent-zcode')).toThrow('System plugins cannot be uninstalled')
})

it('waits for the native idle barrier after a terminal event', async () => {
  const f = await setup('global', { GATE: '1' }), run = f.start('hello')
  await vi.waitFor(async () => expect((await f.frames()).some(frame => frame.method === 'session/send')).toBe(true))
  expect(f.coordinator.get(caller, run.id).status).toBe('running')
  await writeFile(f.control, 'finish'); await f.coordinator.wait(run.id)
  expect(f.coordinator.get(caller, run.id).status).toBe('completed')
})

it.each(['approve', 'question'])('maps a native %s response without granting extra permissions', async kind => {
  const f = await setup(), run = f.start(kind)
  await vi.waitFor(() => expect(f.coordinator.interactions(caller, run.id)).toHaveLength(1))
  const interaction = f.coordinator.interactions(caller, run.id)[0]
  await f.coordinator.respond(caller, run.id, { interactionId: interaction.id, idempotencyKey: 'response', choiceId: kind === 'approve' ? 'once' : '1' })
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(caller, run.id).status).toBe('completed')
  expect((await f.frames()).find(frame => frame.id === 'dialog' && frame.result)?.result).toEqual(kind === 'approve' ? { decision: 'allow' } : { action: 'accept', content: { answers: { 'Which?': 'two' } } })
})

it('withdraws a native-resolved permission without sending a late answer', async () => {
  const f = await setup(), run = f.start('withdraw'); await f.coordinator.wait(run.id)
  expect(f.coordinator.get(caller, run.id).status).toBe('completed')
  expect(f.coordinator.interactions(caller, run.id)).toEqual([expect.objectContaining({ status: 'withdrawn' })])
  expect((await f.frames()).some(frame => frame.id === 'dialog' && frame.result)).toBe(false)
})

it.each(['wait', 'crash', 'invalid', 'failure'])('cleans the native process after %s and permits another turn', async text => {
  const f = await setup('scoped'), run = f.start(text)
  if (text === 'wait') { await vi.waitFor(async () => expect((await f.frames()).some(frame => frame.method === 'session/send')).toBe(true)); await f.coordinator.cancel(caller, run.id) }
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(caller, run.id).status).toBe(text === 'wait' ? 'cancelled' : 'failed')
  const launches = (await readFile(f.trace + '.launch', 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  await expect(readFile(launches[0].provider)).rejects.toMatchObject({ code: 'ENOENT' })
  const next = f.start('hello'); await f.coordinator.wait(next.id)
  expect(f.coordinator.get(caller, next.id).status).toBe('completed')
})

it.each(['LATE_FAILURE', 'WRONG_SESSION'])('rejects %s without committing a checkpoint', async flag => {
  const f = await setup('global', { [flag]: '1' }), run = f.start('hello'); await f.coordinator.wait(run.id)
  const result = f.coordinator.get(caller, run.id)
  expect(result.status).toBe('failed')
  expect(f.executions.state.checkpoint(f.instance.id, result.provider, f.instance.revision)).toBeUndefined()
})

it('reports manual installation and finite metadata without a conversation or Run', async () => {
  const f = await setup()
  expect(await f.coordinator.setupInstance(caller, f.instance.id, f.instance.revision)).toMatchObject({ cli: { state: 'available', version: '0.16.9' }, installation: { kind: 'manual', url: 'https://github.com/zai-org/ZCode' } })
  expect(await f.coordinator.inspectInstance(caller, f.instance.id)).toMatchObject({ authentication: { state: 'unknown' }, models: { items: [{ id: 'native-model' }] } })
  await expect(readFile(f.trace)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(f.db.prepare('SELECT count(*) AS count FROM studio_agent_runs').get()?.count).toBe(0)
})

it('rejects revoked admissions before native work', async () => {
  const f = await setup(); f.authorize.mockImplementation(() => { throw new StudioError('FORBIDDEN', 'Revoked') })
  expect(() => f.start('hello')).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  await expect(readFile(f.trace)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('keeps long Unicode prompts on NDJSON rather than the Windows command line', async () => {
  const f = await setup(), text = '完整 instructions\r\n"%PATH%" & 中文😀 '.repeat(8000) + '\nFINAL_SENTINEL', run = f.start(text)
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(caller, run.id).status).toBe('completed')
  expect((await f.frames()).find(frame => frame.method === 'session/send')?.params.content).toBe(text)
  expect((await readFile(f.trace + '.launch', 'utf8'))).not.toContain('FINAL_SENTINEL')
})

it.skipIf(!process.env.STUDIO_ZCODE_COMMAND).each(['global', 'scoped'] as const)('uses the actual installed ZCode CLI in %s mode with local models and isolated native state', async mode => {
  const f = await setup(mode, {}, true)
  for (const [locationId, kind, path, content] of [['native-instructions', 'configs', '', 'ZCODE_INSTRUCTION_SENTINEL'], ['native-skills', 'skills', 'studio-zcode-check/SKILL.md', '---\nname: studio-zcode-check\ndescription: ZCODE_SKILL_METADATA_SENTINEL\n---\nZCODE_SKILL_BODY_SENTINEL']] as const) {
    const catalog = await f.coordinator.resourceFiles(caller, f.instance.id, f.instance.revision, { action: 'list' });
    await f.coordinator.resourceFiles(caller, f.instance.id, f.instance.revision, { action: 'write', kind, locationId, path, content, etag: 'missing' }, catalog.snapshot);
  }
  for (const text of ['Reply ZCODE_OK only', 'Second request: reply ZCODE_SECOND only', 'RESOURCE_REQUEST: load the studio-zcode-check Skill and call the marker tool']) {
    if (text.startsWith('Second') || text.startsWith('RESOURCE')) {
      const catalog: any = await f.coordinator.resourceFiles(caller, f.instance.id, f.instance.revision, { action: 'list' })
      const exists = catalog.files.some((file: any) => file.kind === 'configs' && file.locationId === 'native-config' && file.exists)
      const current: any = exists ? await f.coordinator.resourceFiles(caller, f.instance.id, f.instance.revision, { action: 'read', kind: 'configs', locationId: 'native-config', path: '' }, catalog.snapshot) : undefined
      const value = current ? JSON.parse(current.file.content) : {}, enabled = text.startsWith('RESOURCE')
      value.features = { ...value.features, skill: enabled }; value.skills = { ...value.skills, enabled }
      await f.coordinator.resourceFiles(caller, f.instance.id, f.instance.revision, { action: 'write', kind: 'configs', locationId: 'native-config', path: '', content: JSON.stringify(value), etag: current?.file.etag || 'missing' }, catalog.snapshot)
    }
    const requestOffset = f.requests.length
    const run = f.start(text, [{ type: 'text', text }, ...(text.startsWith('Second') ? [{ type: 'image', artifactId: '00000000-0000-0000-0000-000000000001', mediaType: 'image/png' }] : [])]); await f.coordinator.wait(run.id)
    const result = f.coordinator.get(caller, run.id)
    expect(result.status, JSON.stringify({result, output:f.coordinator.output(caller,run.id,-1)})).toBe('completed')
    expect(f.coordinator.output(caller, run.id, -1)).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'message.snapshot', text: text.startsWith('Second') ? 'ZCODE_SECOND' : 'ZCODE_OK' })]))
    const usage = f.coordinator.usage(caller, run.id)
    expect(usage).toHaveLength(mode === 'global' ? text.startsWith('RESOURCE') ? 3 : 1 : 0)
    for (const call of usage) expect(call).toMatchObject({ inputTokens: 13, outputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 1 })
    if (text.startsWith('Second') || text.startsWith('RESOURCE')) expect(f.requests.slice(requestOffset).some(request => JSON.stringify(request.body).includes('base64'))).toBe(true)
    if (text.startsWith('Second')) expect(f.requests.slice(requestOffset).every(request => !request.body.tools?.some((tool: any) => tool.name === 'Skill'))).toBe(true)
    await f.restart()
  }
  expect(f.requests.length).toBeGreaterThanOrEqual(5)
  const actualBodies = f.requests.map(request => JSON.stringify(request.body)).join('\n')
  expect(actualBodies).toContain('ZCODE_SYSTEM_SENTINEL')
  expect(actualBodies).toContain('ZCODE_INSTRUCTION_SENTINEL')
  expect(actualBodies).toContain('ZCODE_SKILL_BODY_SENTINEL')
  expect(actualBodies).toContain('ZCODE_MCP_ACTUAL_SENTINEL')
  expect(actualBodies).toContain('base64')
  expect((await readFile(f.mcpTrace, 'utf8'))).toContain('tools/call')
  expect(f.requests.every(request => request.body.model === 'fixture-model' && request.key === (mode === 'scoped' ? 'temporary-host-secret' : 'native-local-key'))).toBe(true)
  expect(await readFile(f.personal, 'utf8')).toBe(JSON.stringify(f.nativePersonal, null, 2))
  const files = async (directory: string): Promise<string[]> => (await Promise.all((await readdir(directory, { withFileTypes: true })).map(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]))).flat()
  for (const path of await files(join(f.directory, 'state'))) expect((await readFile(path)).includes(Buffer.from('temporary-host-secret'))).toBe(false)
}, 40_000)

it('does not publish a successful checkpoint when model gateway cleanup fails', async () => {
  const f = await setup('scoped', { CLEANUP_FAILURE: '1' }), run = f.start('hello')
  await f.coordinator.wait(run.id)
  const result = f.coordinator.get(caller, run.id)
  expect(result.status).toBe('failed')
  expect(f.executions.state.checkpoint(f.instance.id, result.provider, f.instance.revision)).toBeUndefined()
})

it.each(['global', 'scoped'] as const)('accepts the same %s workspace through its filesystem alias when creating and restoring a native conversation', async mode => {
  const f = await setup(mode, { WORKSPACE_ALIAS: '1' })
  for (const text of ['hello', 'continue']) {
    const run = f.start(text); await f.coordinator.wait(run.id)
    const result = f.coordinator.get(caller, run.id)
    expect(result.status, JSON.stringify({ result, output: f.coordinator.output(caller, run.id, -1), workspace: await readFile(f.trace + '.workspace', 'utf8') })).toBe('completed')
    await f.restart()
  }
  const frames = await f.frames()
  expect(frames.find(frame => frame.method === 'session/resume')?.params.sessionId).toBe('sess_fixture')
  expect(frames.find(frame => frame.method === 'session/create')?.params.workspace.workspacePath).toBe(await realpath(f.directory))
})

it.each(['FOREIGN_WORKSPACE', 'FOREIGN_READ_WORKSPACE'])('rejects a different workspace reported at %s without committing a checkpoint', async flag => {
  const f = await setup('global', { [flag]: '1' }), run = f.start('hello')
  await f.coordinator.wait(run.id)
  const result = f.coordinator.get(caller, run.id)
  expect(result.status).toBe('failed')
  expect(f.executions.state.checkpoint(f.instance.id, result.provider, f.instance.revision)).toBeUndefined()
  expect(result.errorCode).toBe(flag === 'FOREIGN_WORKSPACE' ? 'INVALID_ARGUMENT' : 'RUNTIME_UNAVAILABLE')
  if (flag === 'FOREIGN_WORKSPACE') expect((await f.frames()).some(frame => frame.method === 'session/send')).toBe(false)
})

it('uses yolo mode for new and resumed sessions and does not ask for tool authorization by default', async () => {
  const f = await setup()
  const { approvalRequired: _manual, ...config } = f.instance.config
  await f.coordinator.updateInstance(caller, f.instance.id, { revision: 1, mode: f.instance.mode, config })
  for (const text of ['approve', 'approve']) {
    const run = f.start(text)
    await f.coordinator.wait(run.id)
    expect(f.coordinator.get(caller, run.id).status).toBe('completed')
    expect(f.coordinator.interactions(caller, run.id)).toEqual([])
  }
  const frames = await f.frames()
  expect(frames.find(frame => frame.method === 'session/create').params.mode).toBe('yolo')
  expect(frames.filter(frame => frame.method === 'session/setMode').every(frame => frame.params.mode === 'yolo')).toBe(true)
})
