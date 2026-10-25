import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { StudioError, type AgentRunContext, type AgentRuntimeContext, type ExecutionScope, type ModelGatewayHandle } from '../../packages/studio-plugin-sdk/src'
import { AgentCliInstallations } from '../../packages/server/src/modules/studio/services/agents/cli-installations'
import { ManagedProcessScope } from '../../packages/server/src/modules/studio/services/processes/managed'
import { management } from '../../plugins/grok/src/management'
import { createGrokRuntime } from '../../plugins/grok/src/runtime'
import { directories } from '../../plugins/grok/src/configuration'
import { prepareGrok } from '../../plugins/grok/src/configuration'

const caller: ExecutionScope = { scopeId: 'scope', principal: { kind: 'user', id: 'owner' }, profileId: 'one', surface: 'api', traceId: 'trace' }
let root: string, runner: string, image: Buffer
const cleanups: Array<() => Promise<void>> = []
beforeAll(async () => {
  image = await sharp({ create: { width: 32, height: 32, channels: 3, background: 'red' } }).png().toBuffer()
  root = await mkdtemp(join(tmpdir(), 'studio-grok-')); runner = join(root, 'runner.cjs')
  await build({ entryPoints: ['packages/studio-plugin-runner/src/main.ts'], bundle: true, platform: 'node', target: 'node24.22.1', format: 'cjs', outfile: runner, logLevel: 'silent' })
  const plugin = join(root, 'plugins/grok'); await mkdir(join(plugin, 'dist'), { recursive: true }); await build({ entryPoints: ['plugins/grok/src/index.ts'], outfile: join(plugin, 'dist/index.cjs'), platform: 'node', format: 'cjs', bundle: true, logLevel: 'silent', alias: { '@ekko-studio/plugin-sdk': join(process.cwd(), 'packages/studio-plugin-sdk/src/index.ts'), '@ekko-studio/agent-drivers': join(process.cwd(), 'packages/studio-agent-drivers/src/index.ts') } }); await writeFile(join(plugin, 'studio-plugin.json'), await readFile('plugins/grok/studio-plugin.json'))
})
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
afterAll(async () => { await rm(root, { recursive: true, force: true }) })

const fixture = `const fs=require('node:fs'),path=require('node:path');
if(process.argv.includes('--version')){console.log('grok 1.0.70');process.exit(0)}
if(process.argv.includes('models')){if(process.env.INSPECTION_TRACE)fs.writeFileSync(process.env.INSPECTION_TRACE,JSON.stringify({root:process.env.GROK_HOME,home:process.env.HOME,cwd:process.cwd(),config:fs.readFileSync(path.join(process.env.GROK_HOME,'config.toml'),'utf8'),authExists:fs.existsSync(path.join(process.env.GROK_HOME,'auth.json')),apiKey:process.env.XAI_API_KEY}));console.log(process.env.CATALOG_OUTPUT||'You are not authenticated.\\nAvailable models:\\n * native-model (default)\\n - native-other');process.exit(0)}
const args=process.argv,root=process.env.GROK_HOME,prompt=args[args.indexOf('--prompt-file')+1],text=fs.readFileSync(prompt,'utf8'),id=args[args.indexOf('--resume')>=0?args.indexOf('--resume')+1:args.indexOf('--session-id')+1];
fs.appendFileSync(process.env.TRACE,JSON.stringify({args,prompt,text,root,home:process.env.HOME,token:process.env.STUDIO_GROK_MODEL_TOKEN,config:fs.readFileSync(path.join(root,'config.toml'),'utf8'),instructions:fs.readFileSync(path.join(root,'AGENTS.md'),'utf8'),skills:fs.existsSync(path.join(root,'skills'))?fs.readdirSync(path.join(root,'skills')):[]})+'\\n');
fs.mkdirSync(path.join(root,'sessions',encodeURIComponent(process.cwd()),id),{recursive:true});
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
if(text.trim()==='crash')process.exit(7);
if(text.trim()==='wait')setInterval(()=>{},1000);
else {
 send({type:'text',data:'Native Grok answer'});send({type:'thought',data:'Native reasoning'});send({type:'tool_call',toolCallId:'read',toolName:'read_file',rawInput:{path:'README.md'}});send({type:'tool_call_update',toolCallId:'read',status:'completed',rawOutput:'contents'});
 send({type:'usage',messageId:'response-1',usage:{input_tokens:15,output_tokens:5,input_tokens_details:{cached_tokens:2},output_tokens_details:{reasoning_tokens:1}}});
 if(text.trim()==='error')send({type:'error',message:'token=do-not-echo'});
 if(text.trim()!=='missing')send({type:'end',sessionId:id,stopReason:'end_turn',usage:{input_tokens:15,output_tokens:5,input_tokens_details:{cached_tokens:2},output_tokens_details:{reasoning_tokens:1}}});
 if(text.trim()==='late'){const timer=setInterval(()=>{if(fs.existsSync(process.env.CONTROL_FILE)){clearInterval(timer);process.exit(0)}},10)}
 else {if(process.env.SABOTAGE_PROMPT==='1'){fs.unlinkSync(prompt);fs.mkdirSync(prompt);fs.writeFileSync(path.join(prompt,'blocker'),'owned fixture')}process.exit(text.trim()==='late-failure'?7:0)}
}`
async function setup(mode: 'global' | 'scoped' = 'global', extra: Record<string, string> = {}) {
  const directory = await mkdtemp(join(root, 'fixture-')), trace = join(directory, 'trace'), cli = join(directory, 'cli.cjs')
  await writeFile(cli, fixture)
  const mcp = join(directory, 'mcp.cjs'), mcpTrace = join(directory, 'mcp-trace')
  await writeFile(mcp, `const fs=require('node:fs');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);fs.appendFileSync(process.env.MCP_TRACE,JSON.stringify(r)+'\\n');if(r.id===undefined)return;const result=r.method==='initialize'?{protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:r.method==='tools/list'?{tools:[{name:'ping',description:'Local ping fixture',inputSchema:{type:'object',properties:{}}}]}:r.method==='tools/call'?{content:[{type:'text',text:'local-pong'}]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n')})`)
  const db = new DatabaseSync(':memory:'), executions = new AgentExecutionStore(db), store = new PluginStore(db), registry = new AgentRegistry(), events = new PluginEventBus()
  const logger = { info() {}, warn() {}, error() {} }, authorize = vi.fn()
  const gateway = vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:1/v1', token: 'temporary-only', model: 'fixture/model', protocol: 'responses', images: true, dispose: async () => {} }))
  const context = (scope: ExecutionScope, signal: AbortSignal) => createExecutionContext(scope, signal, logger, { authorize: async () => {},
    artifacts: { read: async (_scope: ExecutionScope, id: string, offset: number) => ({ id, mediaType: 'image/png', offset, byteLength: image.length, data: image.toString('base64'), nextOffset: image.length, done: true }) }, agents: { list: async () => [] }, sessions: { get: async () => null }, models: { gateway } })
  const coordinatorOptions = { store: executions, registry, events, logger, authorize, context, stateRoot: join(directory, 'state'), validateInput: () => {} }
  let coordinator = new AgentCoordinator(coordinatorOptions)
  const host = new PluginHost({ store, registry, events, context, logger, runnerPath: runner, artifactsRoot: join(directory, 'installed'),
    eventContext: async (_state, _event, signal) => context(caller, signal), acceptEvents: async batch => { for (const event of batch) events.publish(event) } })
  cleanups.push(async () => { await coordinator.close(); await host.close(); events.close(); db.close() })
  const manifest = JSON.parse(await readFile(join(root, 'plugins/grok/studio-plugin.json'), 'utf8'))
  await host.registerSystemArtifact(join(root, 'plugins/grok'), manifest.id)
  await host.configure({ pluginId: manifest.id, profileId: caller.profileId, ownerId: caller.principal.id, enabled: true, config: {}, grants: manifest.requires.capabilities }, 0)
  const config = { mcpServers: { fixture: { command: process.execPath, args: [mcp], env: { ELECTRON_RUN_AS_NODE: '1', MCP_TRACE: mcpTrace } } }, cwd: directory, command: extra.GROK_FIXTURE_BINARY || process.execPath, args: extra.GROK_FIXTURE_BINARY ? [] : [cli], model: 'fixture/native-model',
    env: { TRACE: trace, HOME: directory, USERPROFILE: directory, GROK_HOME: join(directory, 'native'), CONTROL_FILE: join(directory, 'control'), ...extra } }
  const instance = coordinator.createInstance(caller, { agentTypeId: 'grok', mode, config })
  let sequence = 0
  const start = (text: string) => coordinator.start(caller, instance.id, { content: [{ type: 'text', text }] }, `run-${++sequence}`)
  const frames = async () => (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const restart = async () => { await coordinator.close(); coordinator = new AgentCoordinator(coordinatorOptions) }
  return { db, get coordinator() { return coordinator }, restart, registry, host, executions, instance, config, directory, trace, control: join(directory, 'control'), gateway, authorize, start, frames }
}

it.each(['global', 'scoped'] as const)('runs, resumes and compacts through a real %s plugin worker', async mode => {
  const f = await setup(mode)
  for (const text of ['hello', 'continue', '/compact Focus on changes']) {
    const run = f.start(text); await f.coordinator.wait(run.id)
    expect(f.coordinator.get(caller, run.id).status).toBe('completed')
    expect(f.coordinator.output(caller, run.id, -1)).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'message.delta', text: 'Native Grok answer' }), expect.objectContaining({ type: 'tool.completed', callId: 'read' })]))
    expect(f.coordinator.usage(caller, run.id)).toHaveLength(mode === 'global' ? 1 : 0)
    if (mode === 'global') expect(f.coordinator.usage(caller, run.id)[0]).toMatchObject({ inputTokens: 15, outputTokens: 5, cacheReadTokens: 2, reasoningTokens: 1 })
  }
  const frames = await f.frames()
  expect(frames[0].args).toContain('--session-id'); expect(frames[1].args).toContain('--resume'); expect(frames[2].text.trim()).toBe('/compact Focus on changes')
  for (const frame of frames) { await expect(readFile(frame.prompt)).rejects.toMatchObject({ code: 'ENOENT' }); expect(frame.config).not.toContain('temporary-only') }
  if (mode === 'scoped') { expect(frames[0].token).toBe('temporary-only'); expect(frames[0].home).toContain(join(f.directory, 'state')); expect(f.gateway).toHaveBeenCalledTimes(3) }
  else { expect(frames[0].home).toBe(f.directory); expect(f.gateway).not.toHaveBeenCalled() }
  expect(() => f.host.uninstall('studio.agent-grok')).toThrow('System plugins cannot be uninstalled')
})
it('waits for successful process exit after the native terminal result', async () => {
  const f = await setup(), run = f.start('late')
  await vi.waitFor(async () => expect(await f.frames()).toHaveLength(1))
  expect(f.coordinator.get(caller, run.id).status).toBe('running')
  await writeFile(f.control, 'exit'); await f.coordinator.wait(run.id)
  expect(f.coordinator.get(caller, run.id).status).toBe('completed')
})
it.each(['crash', 'error', 'missing', 'late-failure'])('does not save a successful checkpoint after %s', async text => {
  const f = await setup(), run = f.start(text); await f.coordinator.wait(run.id)
  const result = f.coordinator.get(caller, run.id)
  expect(result.status).toBe('failed'); expect(f.executions.state.checkpoint(f.instance.id, result.provider, f.instance.revision)).toBeUndefined()
  expect(JSON.stringify(f.coordinator.output(caller, run.id, -1))).not.toContain('do-not-echo')
  const frames = await f.frames(); await expect(readFile(frames[0].prompt)).rejects.toMatchObject({ code: 'ENOENT' })
})
it('cancels native work and cleans the prompt before another turn', async () => {
  const f = await setup(), run = f.start('wait')
  await vi.waitFor(async () => expect(await f.frames()).toHaveLength(1)); await f.coordinator.cancel(caller, run.id); await f.coordinator.wait(run.id)
  expect(f.coordinator.get(caller, run.id).status).toBe('cancelled')
  const next = f.start('hello'); await f.coordinator.wait(next.id); expect(f.coordinator.get(caller, next.id).status).toBe('completed')
  for (const frame of await f.frames()) await expect(readFile(frame.prompt)).rejects.toMatchObject({ code: 'ENOENT' })
})
it('inspects native metadata without a Run or a conversation and projects unknown account state honestly', async () => {
  const f = await setup()
  expect(await f.coordinator.inspectInstance(caller, f.instance.id)).toMatchObject({ native: { name: 'Grok', version: '1.0.70' }, authentication: { state: 'unknown' }, models: { status: 'available', items: [{ id: 'native-model' }, { id: 'native-other' }] } })
  await expect(readFile(f.trace)).rejects.toMatchObject({ code: 'ENOENT' }); expect(f.db.prepare('SELECT count(*) AS count FROM studio_agent_runs').get()?.count).toBe(0)
})
it('rejects revoked and foreign admissions before creating native work', async () => {
  const f = await setup()
  expect(() => f.coordinator.start({ ...caller, profileId: 'foreign' }, f.instance.id, { content: [{ type: 'text', text: 'hello' }] }, 'foreign')).toThrow()
  f.authorize.mockImplementation(() => { throw new StudioError('FORBIDDEN', 'Revoked') }); expect(() => f.start('hello')).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  await expect(readFile(f.trace)).rejects.toMatchObject({ code: 'ENOENT' })
})
it('restores after a coordinator restart and rejects missing native history', async () => {
  const f = await setup(), first = f.start('hello'); await f.coordinator.wait(first.id); await f.restart()
  const second = f.start('continue'); await f.coordinator.wait(second.id); expect(f.coordinator.get(caller, second.id).status).toBe('completed')
  const frames = await f.frames(); await f.restart(); await rm(join(frames[0].root, 'sessions'), { recursive: true })
  const failed = f.start('continue'); await f.coordinator.wait(failed.id); expect(f.coordinator.get(caller, failed.id).status).toBe('failed'); expect(await f.frames()).toHaveLength(2)
})
it('preserves native account files and user settings while injecting MCP and scoped routing', async () => {
  const directory = await mkdtemp(join(root, 'config-')), native = join(directory, 'native'), state = join(directory, 'state'); await mkdir(native)
  const original = '[models]\ndefault="original"\n[model.original]\napi_key="native-account-secret"\nbase_url="https://native.invalid"\n[tools]\npreamble="Keep my tools"\n'
  await writeFile(join(native, 'config.toml'), original); await writeFile(join(native, 'auth.json'), '{"token":"native-account-secret"}'); await writeFile(join(native, 'AGENTS.md'), 'Native instructions')
  const config = { cwd: directory, env: { HOME: directory, GROK_HOME: native } }, runtime = { stateDirectory: state } as AgentRuntimeContext
  const prepared = await prepareGrok({ systemPrompt: 'Studio instructions', mcpServers: { fixture: { command: 'node', args: ['fixture'], env: { ELECTRON_RUN_AS_NODE: '1' } } } }, config, 'scoped', runtime, { model: 'model', baseUrl: 'http://127.0.0.1:1/v1', token: 'temporary-only' } as ModelGatewayHandle)
  const content = await readFile(join(prepared.root, 'config.toml'), 'utf8')
  expect(content).not.toContain('native-account-secret'); expect(content).not.toContain('temporary-only'); expect(content).toContain('Keep my tools'); expect(content).toContain('STUDIO_GROK_MODEL_TOKEN'); expect(content).toContain('ELECTRON_RUN_AS_NODE')
  expect(await readFile(join(native, 'config.toml'), 'utf8')).toBe(original); await expect(readFile(join(prepared.root, 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(prepared.root, 'AGENTS.md'), 'utf8')).toContain('Native instructions')
  const global = await prepareGrok({}, config, 'global', { stateDirectory: join(directory, 'global-state') } as AgentRuntimeContext)
  expect(global.env.HOME).toBe(directory); expect(await readFile(join(global.root, 'auth.json'), 'utf8')).toBe('{\"token\":\"native-account-secret\"}'); expect(await readFile(join(native, 'config.toml'), 'utf8')).toBe(original)
  await mkdir(join(directory, '.grok')); await writeFile(join(directory, '.grok/config.toml'), '[model.studio-runtime]\nbase_url="https://foreign.invalid"')
  await expect(prepareGrok({}, config, 'scoped', runtime, { model: 'model', baseUrl: 'http://127.0.0.1:1/v1', token: 'temporary-only' } as ModelGatewayHandle)).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
})
it.runIf(Boolean(process.env.STUDIO_GROK_BINARY)).each(['global', 'scoped'] as const)('runs the pinned native CLI through an isolated %s plugin worker with images, MCP, compact and restart', async mode => {
  let calls = 0
  const requests: any[] = []
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    if (!req.url?.includes('responses')) { res.writeHead(404); res.end('{}'); return }
    const body = JSON.parse(raw), call = ++calls, text = `Actual native answer ${call}. ` + 'The user is validating an independent Studio Grok plugin through temporary native storage and a local Responses server. Preserve the existing session, native model selection, image content and managed MCP tools. The local tool was discovered with search_tool and called with use_tool, returning local-pong. The integration checks model usage including cached input and reasoning output, then restarts the coordinator and resumes the same native session. No account login or remote inference is required. '.repeat(5), id = `response-${call}`, messageId = `message-${call}`
    requests.push({ body, authorization: req.headers.authorization })
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); let sequence = 0
    const send = (type: string, data: any) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`)
    const response = { id, object: 'response', created_at: 1700000000, model: 'fixture-model', status: 'in_progress', output: [] as any[] }
    const toolResults = (Array.isArray(body.input) ? body.input : []).filter((item: any) => item.type === 'function_call_output')
    const searched = toolResults.find((item: any) => String(item.output).includes('ping'))
    if ((body.tools || []).some((tool: any) => tool.name === 'search_tool') && !toolResults.some((item: any) => String(item.output).includes('local-pong'))) {
      const toolName = searched ? 'use_tool' : 'search_tool'
      const match = searched && String(searched.output).match(/\"tool_name\"\s*:\s*\"([^\"]*ping)\"/)
      if (searched && !match) { console.log('MCP search result', searched.output); res.end(); return }
      const argumentsValue = JSON.stringify(searched ? { tool_name: match[1], tool_input: {} } : { query: 'fixture ping' })
      const item = { type: 'function_call', id: `tool-${call}`, call_id: `tool-${call}`, name: toolName, arguments: argumentsValue }
      send('response.created', { response }); send('response.output_item.added', { output_index: 0, item: { ...item, arguments: '' } }); send('response.function_call_arguments.delta', { item_id: item.id, output_index: 0, delta: argumentsValue }); send('response.function_call_arguments.done', { item_id: item.id, output_index: 0, arguments: argumentsValue }); send('response.output_item.done', { output_index: 0, item }); send('response.completed', { response: { ...response, status: 'completed', output: [item], usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17, input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 1 } } } }); res.end(); return
    }
    const item = { id: messageId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
    send('response.created', { response }); send('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } })
    send('response.content_part.added', { item_id: messageId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
    send('response.output_text.delta', { item_id: messageId, output_index: 0, content_index: 0, delta: text }); send('response.output_text.done', { item_id: messageId, output_index: 0, content_index: 0, text }); send('response.output_item.done', { output_index: 0, item })
    send('response.completed', { response: { ...response, status: 'completed', output: [item], usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17, input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 1 } } } }); res.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); cleanups.push(async () => { await new Promise<void>(resolve => server.close(() => resolve())) })
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}/v1`
  {
    const f = await setup(mode, { GROK_FIXTURE_BINARY: process.env.STUDIO_GROK_BINARY!, GROK_DISABLE_AUTOUPDATER: '1', FIXTURE_TOKEN: 'fixture-only' })
    await mkdir(join(f.directory, 'native/skills/removed-native'), { recursive: true })
    await writeFile(join(f.directory, 'native/skills/removed-native/SKILL.md'), '---\nname: removed-native\ndescription: Native resource deletion fixture\n---\nNative fixture Skill')
    await writeFile(join(f.directory, 'native/config.toml'), `[models]\ndefault="fixture/native-model"\n[model."fixture/native-model"]\nmodel="fixture-model"\nbase_url="${baseUrl}"\nenv_key="FIXTURE_TOKEN"\napi_backend="responses"\ncontext_window=128000\nmax_completion_tokens=8192\n`)
    f.gateway.mockImplementation(async () => ({ baseUrl, token: 'temporary-only', model: 'fixture-model', protocol: 'responses', images: true, dispose: async () => {} }))
    const start = requests.length, first = f.start('First native turn'); await f.coordinator.wait(first.id)
    expect(f.coordinator.get(caller, first.id).status).toBe('completed')
    if (mode === 'global') expect(f.coordinator.usage(caller, first.id)).toEqual([expect.objectContaining({ model: 'fixture-model', inputTokens: 36, outputTokens: 15, cacheReadTokens: 6, reasoningTokens: 3 })])
    else expect(f.coordinator.usage(caller, first.id)).toHaveLength(0)
    const nativeSkill = JSON.stringify(requests.slice(start)).match(/Absolute path: ([^\\]*\/grok\/skills\/removed-native\/SKILL\.md)/)?.[1]
    expect(nativeSkill).toBeTypeOf('string'); expect(await readFile(nativeSkill!, 'utf8')).toContain('Native fixture Skill')
    const catalog = await f.coordinator.resourceFiles(caller, f.instance.id, f.instance.revision, { action: 'list' }) as any
    for (const name of ['config.toml', 'AGENTS.md']) {
      const location = catalog.configs.find((entry: any) => entry.scope === mode && entry.name === name), ref = { kind: 'configs' as const, locationId: location.id, path: '' }
      const current = await f.coordinator.resourceFiles(caller, f.instance.id, f.instance.revision, { action: 'read', ...ref }, catalog.snapshot) as any
      await f.coordinator.resourceFiles(caller, f.instance.id, f.instance.revision, { action: 'write', ...ref, etag: current.file.etag,
        content: name === 'config.toml' ? current.file.content + '\n[session]\nload_envrc=false\n' : `Persisted native resource marker ${mode}` }, catalog.snapshot)
    }
    const skillLocation = catalog.skills.find((entry: any) => entry.scope === mode), skillRef = { kind: 'skills' as const, locationId: skillLocation.id, path: 'removed-native' }
    const reviewed = await f.coordinator.resourceFiles(caller, f.instance.id, f.instance.revision, { action: 'review-skill', ...skillRef }, catalog.snapshot) as any
    await f.coordinator.resourceFiles(caller, f.instance.id, f.instance.revision, { action: 'remove-skill', ...skillRef, etag: reviewed.skill.etag }, catalog.snapshot)
    await f.restart()
    const second = f.coordinator.start(caller, f.instance.id, { content: [{ type: 'text', text: 'Continue with this image' }, { type: 'image', artifactId: '11111111-1111-4111-8111-111111111111', mediaType: 'image/png' }] }, 'native-image')
    await f.coordinator.wait(second.id); expect(f.coordinator.get(caller, second.id).status).toBe('completed')
    const actual = requests.slice(start)
    expect(await readFile(join(f.directory, 'mcp-trace'), 'utf8')).toContain('tools/call')
    expect(JSON.stringify(actual)).toContain('input_image')
    expect(JSON.stringify(actual)).toContain(`Persisted native resource marker ${mode}`)
    await expect(readFile(join(skillLocation.path, 'removed-native/SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(nativeSkill!)).rejects.toMatchObject({ code: 'ENOENT' })
    const compact = f.start('/compact Focus on changes'); await f.coordinator.wait(compact.id); expect(f.coordinator.get(caller, compact.id).status).toBe('completed')
    expect(actual.every(request => request.authorization === `Bearer ${mode === 'global' ? 'fixture-only' : 'temporary-only'}`)).toBe(true)
  }
  console.log(`Grok pinned native validation (${mode}): 3 turns, ${calls} local Responses requests; global/scoped images, checkpoint restart, cache/reasoning usage`)
})
it.runIf(process.env.STUDIO_GROK_INSTALL === '1')('installs and probes the exact native npm binary through a host-managed private staging plan', async () => {
  const directory = await mkdtemp(join(root, 'install-')), cache = new AgentCliInstallations(directory)
  const instance = { id: 'grok-install', profileId: 'profile', ownerId: 'owner' }, provider = { kind: 'plugin' as const, pluginId: 'studio.agent-grok', version: '0.1.0', generation: 'test' }
  const plan = await management.prepareInstall!({ instanceId: instance.id, mode: 'global', config: { cwd: directory } }, {} as AgentRuntimeContext)
  expect(plan).toMatchObject({ version: '1.0.70', nativeHomeEnv: ['GROK_HOME'], runner: process.platform === 'win32' ? 'node' : 'binary' })
  const stage = await cache.stage(instance, provider, plan, () => {}), controller = new AbortController(), processes = new ManagedProcessScope(controller.signal, () => {})
  const collect = async (launch: any) => {
    const handle = await processes.api.spawn(launch); let stdout = '', bytes = 0
    try { while (true) { const batch = await handle.read(); for (const chunk of batch.chunks) { bytes += chunk.data.length; if (chunk.stream === 'stdout') stdout += Buffer.from(chunk.data).toString() } if (bytes > 1000000 || batch.truncated) throw new Error('Native installation output exceeded bounds'); if (batch.exit && !batch.chunks.length) { expect(batch.exit.code).toBe(0); return stdout } } } finally { await handle.dispose() }
  }
  try {
    expect(stage.launch.env!.GROK_HOME).toContain(directory)
    await collect(stage.launch); stage.publish()
    const native = cache.load(instance, provider); expect(native?.state).toBe('ready')
    if (native?.state !== 'ready') throw new Error('Missing managed Grok installation')
    expect(native.command).toContain(directory)
    expect(await collect({ command: native.command, args: [...native.args, '--version'], cwd: directory, env: { HOME: join(directory, 'home'), USERPROFILE: join(directory, 'home'), GROK_HOME: join(directory, 'native') } })).toMatch(/1\.0\.70/)
  } finally { await stage.discard(); await processes.close() }
}, 60000)
it.each(['project', 'managed'] as const)('rejects %s model routing before exposing scoped credentials to native work', async policy => {
  const f = await setup('scoped')
  const directory = policy === 'project' ? join(f.directory, '.grok') : join(f.directory, 'native'); await mkdir(directory)
  await writeFile(join(directory, policy === 'project' ? 'config.toml' : 'managed_config.toml'), '[model.studio-runtime]\nbase_url="https://foreign.invalid"\nenv_key="STUDIO_GROK_MODEL_TOKEN"')
  const run = f.start('hello'); await f.coordinator.wait(run.id)
  expect(f.coordinator.get(caller, run.id).status).toBe('failed'); await expect(readFile(f.trace)).rejects.toMatchObject({ code: 'ENOENT' })
})
it('rejects unsupported native SSE MCP explicitly', async () => {
  const directory = await mkdtemp(join(root, 'sse-'))
  await expect(prepareGrok({ mcpServers: { legacy: { type: 'sse', url: 'http://127.0.0.1:1/sse' } } }, { cwd: directory, env: { HOME: directory } }, 'global', { stateDirectory: join(directory, 'state') } as AgentRuntimeContext)).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
})
it.each(['global', 'scoped'] as const)('preserves %s management edits and reviewed Skill deletion in the next worker turn and after restart', async mode => {
  const f = await setup(mode), native = join(f.directory, 'native'), original = '[tools]\npreamble="Original preference"\n[model.original]\napi_key="native-account-secret"\n'
  await mkdir(join(native, 'skills/remove-me'), { recursive: true }); await mkdir(join(f.directory, '.agents/skills/shared-readonly'), { recursive: true })
  await writeFile(join(native, 'config.toml'), original); await writeFile(join(native, 'AGENTS.md'), 'Original native instruction')
  await writeFile(join(native, 'skills/remove-me/SKILL.md'), '---\nname: remove-me\ndescription: A native test Skill\n---\nOriginal native Skill')
  await writeFile(join(f.directory, '.agents/skills/shared-readonly/SKILL.md'), '---\nname: shared-readonly\ndescription: A shared test Skill\n---\nShared Skill')
  const catalog = await f.coordinator.resourceFiles(caller, f.instance.id, f.instance.revision, { action: 'list' }) as any
  const settings = catalog.configs.find((entry: any) => entry.scope === mode && entry.name === 'config.toml'), instructions = catalog.configs.find((entry: any) => entry.scope === mode && entry.name === 'AGENTS.md')
  expect(settings.path).toContain(mode === 'scoped' ? 'grok-resources' : 'native')
  for (const [location, content] of [[settings, '[tools]\npreamble="Saved preference"\n'], [instructions, 'Saved native instruction']] as const) {
    const ref = { kind: 'configs' as const, locationId: location.id, path: '' }, current = await f.coordinator.resourceFiles(caller, f.instance.id, f.instance.revision, { action: 'read', ...ref }, catalog.snapshot) as any
    await f.coordinator.resourceFiles(caller, f.instance.id, f.instance.revision, { action: 'write', ...ref, content, etag: current.file.etag }, catalog.snapshot)
  }
  const skill = catalog.skills.find((entry: any) => entry.scope === mode), ref = { kind: 'skills' as const, locationId: skill.id, path: 'remove-me' }
  const reviewed = await f.coordinator.resourceFiles(caller, f.instance.id, f.instance.revision, { action: 'review-skill', ...ref }, catalog.snapshot) as any
  await f.coordinator.resourceFiles(caller, f.instance.id, f.instance.revision, { action: 'remove-skill', ...ref, etag: reviewed.skill.etag }, catalog.snapshot)
  for (let turn = 0; turn < 2; turn++) {
    const run = f.start(`Saved resource turn ${turn}`); await f.coordinator.wait(run.id); expect(f.coordinator.get(caller, run.id).status).toBe('completed')
    const frame = (await f.frames())[turn]
    expect(frame.config).toContain('Saved preference'); expect(frame.instructions).toContain('Saved native instruction')
    expect(frame.skills).not.toContain('remove-me'); expect(frame.skills).toContain('shared-readonly')
    expect(await readFile(instructions.path, 'utf8')).toBe('Saved native instruction')
    expect(await readFile(settings.path, 'utf8')).toBe('[tools]\npreamble="Saved preference"\n')
    if (mode === 'scoped') { expect(await readFile(join(native, 'config.toml'), 'utf8')).toBe(original); expect(await readFile(join(native, 'skills/remove-me/SKILL.md'), 'utf8')).toContain('Original native Skill') }
    if (!turn) await f.restart()
  }
})
it('initializes scoped resources without overwriting files saved before the first native turn', async () => {
  const directory = await mkdtemp(join(root, 'preseed-')), native = join(directory, 'native'), stateDirectory = join(directory, 'state'), editable = join(stateDirectory, 'grok-resources')
  await mkdir(native); await mkdir(editable, { recursive: true }); await writeFile(join(native, 'AGENTS.md'), 'Inherited instruction')
  await writeFile(join(native, 'config.toml'), '[tools]\npreamble="Inherited preference"\napi_key="native-only"\n')
  await writeFile(join(editable, 'config.toml'), '[tools]\npreamble="Already saved"\n'); await writeFile(join(editable, 'AGENTS.md'), 'Already saved instruction')
  const locations = await management.locations!({ instanceId: 'instance', config: { cwd: directory, env: { HOME: directory, GROK_HOME: native } }, mode: 'scoped' }, { stateDirectory } as AgentRuntimeContext)
  expect(locations.configs!.find(entry => entry.name === 'config.toml' && entry.scope === 'scoped')!.path).toBe(join(editable, 'config.toml'))
  expect(await readFile(join(editable, 'AGENTS.md'), 'utf8')).toBe('Already saved instruction')
  expect(await readFile(join(editable, 'config.toml'), 'utf8')).toBe('[tools]\npreamble="Already saved"\n')
})

it.each(['process', 'gateway', 'prompt'] as const)('keeps the runtime unavailable after %s cleanup fails even if cleanup can subsequently finish', async stage => {
  const f = await setup('scoped', stage === 'prompt' ? { SABOTAGE_PROMPT: '1' } : {}), stateDirectory = join(f.directory, 'direct-state'), controller = new AbortController(), processes = new ManagedProcessScope(controller.signal, () => {})
  const failure = new Error(`Injected ${stage} cleanup failure`)
  let disposals = 0, gatewayDisposals = 0
  const runtime = createGrokRuntime({ instanceId: f.instance.id, config: f.config, configRevision: 1, mode: 'scoped' }, {
    stateDirectory, runtimeSessionId: 'direct-runtime', profileId: caller.profileId, ownerId: caller.principal.id, provider: { kind: 'plugin', pluginId: 'studio.agent-grok', version: '0.1.0', generation: 'direct' }, signal: controller.signal,
    logger: { info() {}, warn() {}, error() {} }, mcp: {} as AgentRuntimeContext['mcp'], processes: { async spawn(input) {
      const handle = await processes.api.spawn(input)
      return { ...handle, async dispose() { if (stage === 'process' && ++disposals === 1) throw failure; await handle.dispose() } }
    } },
  })
  const context = { scope: { ...caller, runId: 'direct-run', runtimeSessionId: 'direct-runtime' }, signal: controller.signal,
    models: { gateway: async () => ({ baseUrl: 'http://127.0.0.1:1/v1', token: 'temporary-only', model: 'fixture/model', protocol: 'responses', images: true,
      async dispose() { if (stage === 'gateway' && ++gatewayDisposals === 1) throw failure } }) } } as unknown as AgentRunContext
  try {
    const input = { content: [{ type: 'text' as const, text: 'hello' }] }, handle = await runtime.run(input, context), events: any[] = []
    const drain = (async () => { try { for await (const event of handle.events) events.push(event) } catch {} })()
    await expect(handle.result).rejects.toBeInstanceOf(Error); await drain
    expect(events.some(event => event.type === 'checkpoint.updated')).toBe(false)
    if (stage === 'process') expect(disposals).toBeGreaterThanOrEqual(2)
    if (stage === 'gateway') expect(gatewayDisposals).toBe(2)
    const frames = await f.frames()
    // Repair the prompt artifact to prove the refusal survives a later successful cleanup.
    if (stage === 'prompt') await rm(frames[0].prompt, { recursive: true, force: true })
    const count = frames.length
    await expect(runtime.run(input, context)).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
    expect(await f.frames()).toHaveLength(count)
  } finally { await runtime.dispose(); await processes.close() }
})
it('isolates metadata subprocesses from native accounts and project state and discards their one-time Home', async () => {
  const f = await setup('global', { INSPECTION_TRACE: 'will-be-replaced', XAI_API_KEY: 'native-only-key' }), native = join(f.directory, 'native')
  // Preserve the saved instance config; the native fixture writes only its explicit trace path.
  const trace = join(f.directory, 'inspect-trace')
  await f.coordinator.updateInstance(caller, f.instance.id, { revision: f.instance.revision, config: { ...f.config, env: { ...f.config.env, INSPECTION_TRACE: trace } }, mode: 'global' })
  await mkdir(native); await writeFile(join(native, 'auth.json'), '{"token":"native-account-secret"}')
  const config = '[model.private]\nmodel="private-model"\nbase_url="http://127.0.0.1:1/v1"\napi_key="native-account-secret"\nenv_key="XAI_API_KEY"\n'; await writeFile(join(native, 'config.toml'), config)
  expect(await f.coordinator.inspectInstance(caller, f.instance.id)).toMatchObject({ authentication: { state: 'unknown' } })
  const observed = JSON.parse(await readFile(trace, 'utf8'))
  expect(observed.root).not.toBe(native); expect(observed.home).not.toBe(f.directory); expect(observed.cwd).not.toBe(f.directory)
  expect(observed.config).toContain('private-model'); expect(observed.config).not.toContain('native-account-secret'); expect(observed.config).not.toContain('XAI_API_KEY'); expect(observed.authExists).toBe(false); expect(observed.apiKey).toBeUndefined()
  await expect(readFile(join(observed.root, 'config.toml'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(native, 'config.toml'), 'utf8')).toBe(config); expect(await readFile(join(native, 'auth.json'), 'utf8')).toBe('{"token":"native-account-secret"}')
  expect((await readdir(native)).sort()).toEqual(['auth.json', 'config.toml']); expect(f.db.prepare('SELECT count(*) AS count FROM studio_agent_runs').get()?.count).toBe(0)
})
it.runIf(Boolean(process.env.STUDIO_GROK_BINARY))('keeps a real native metadata probe from adding, deleting or changing native account/project files', async () => {
  const f = await setup('global', { GROK_FIXTURE_BINARY: process.env.STUDIO_GROK_BINARY!, GROK_DISABLE_AUTOUPDATER: '1' }), native = join(f.directory, 'native')
  await mkdir(native); await writeFile(join(native, 'config.toml'), '[cli]\nauto_update=false\n'); await writeFile(join(native, 'auth.json'), '{}'); await writeFile(join(native, 'AGENTS.md'), 'Original native instruction')
  const snapshot = async (directory: string, prefix = ''): Promise<Record<string, string>> => {
    const result: Record<string, string> = {}
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name, path = join(directory, entry.name)
      if (entry.isDirectory()) Object.assign(result, await snapshot(path, relative + '/'))
      else result[relative] = (await readFile(path)).toString('base64')
    }
    return result
  }
  const before = await snapshot(f.directory)
  const result = await f.coordinator.inspectInstance(caller, f.instance.id)
  expect(result).toMatchObject({ native: { name: 'Grok', version: '1.0.70' }, authentication: { state: 'unknown' }, models: { status: 'available' } })
  expect(result.models.items.length).toBeGreaterThan(0)
  expect(await snapshot(f.directory)).toEqual(before)
  expect(f.db.prepare('SELECT count(*) AS count FROM studio_agent_runs').get()?.count).toBe(0)
})
