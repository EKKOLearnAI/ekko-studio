import { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp, copyFile, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { vi } from 'vitest'
import { AgentExecutionStore } from '../../packages/server/src/modules/studio/repositories/agent-execution-store'
import { PluginStore } from '../../packages/server/src/modules/studio/repositories/plugin-store'
import { AgentRegistry } from '../../packages/server/src/modules/studio/services/agents/registry'
import { AgentCoordinator } from '../../packages/server/src/modules/studio/services/agents/coordinator'
import { PluginHost } from '../../packages/server/src/modules/studio/services/plugins/host'
import { PluginEventBus } from '../../packages/server/src/modules/studio/services/events/plugin-events'
import { createExecutionContext } from '../../packages/server/src/modules/studio/services/context/execution'
import type { ExecutionScope, JsonObject } from '../../packages/studio-plugin-sdk/src'

export const claudeCaller: ExecutionScope = { scopeId: 'scope', principal: { kind: 'user', id: '7' }, profileId: 'one', surface: 'api', traceId: 'trace' }

export async function buildClaudeFixture(root: string) {
  const runner = join(root, 'runner.cjs'), source = resolve('plugins/claude-code'), destination = join(root, 'plugins/claude-code')
  await mkdir(destination, { recursive: true })
  await build({ entryPoints: ['packages/studio-plugin-runner/src/main.ts'], bundle: true, platform: 'node', target: 'node24.22.1', format: 'cjs', outfile: runner, logLevel: 'silent' })
  const manifest = JSON.parse(await readFile(join(source, 'studio-plugin.json'), 'utf8'))
  await build({ entryPoints: [join(source, 'src/index.ts')], bundle: true, platform: 'node', target: 'node24.22.1', format: 'cjs', outfile: join(destination, manifest.backend), logLevel: 'silent', alias: {
    '@ekko-studio/plugin-sdk': resolve('packages/studio-plugin-sdk/src/index.ts'), '@ekko-studio/agent-drivers': resolve('packages/studio-agent-drivers/src/index.ts'),
  } })
  for (const file of ['package.json', 'studio-plugin.json', 'README.md']) await copyFile(join(source, file), join(destination, file))
  return runner
}

export const claudeProtocolFixture = String.raw`const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),root=process.env.CLAUDE_CONFIG_DIR||path.join(process.env.HOME,'.claude');
fs.appendFileSync(process.env.TRACE+'.launches',JSON.stringify({args,home:process.env.HOME,root,base:process.env.ANTHROPIC_BASE_URL,token:process.env.ANTHROPIC_API_KEY,mcp:args.includes('--mcp-config')?JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config')+1])):undefined})+'\n');
if(args.includes('--version')){console.log('2.1.310 (Claude Code)');process.exit(0)}
if(args.includes('auth')){fs.mkdirSync(root,{recursive:true});fs.writeFileSync(path.join(root,'.claude.json'),'UNSAFE AUTH PROBE');console.log(JSON.stringify({loggedIn:true,email:'private@example.test',token:'native-secret'}));process.exit(0)}
fs.mkdirSync(root,{recursive:true});let session=args[args.indexOf(args.includes('--resume')?'--resume':'--session-id')+1],usage=0,prompt='',pending;
const history=()=>path.join(root,session+'.json');
if(args.includes('--resume')){if(!fs.existsSync(history())){process.exit(8)}usage=JSON.parse(fs.readFileSync(history())).usage}
const send=x=>process.stdout.write(JSON.stringify(x)+'\n');const frame=x=>send({uuid:require('node:crypto').randomUUID(),session_id:session,...x});
const finish=()=>{usage++;fs.writeFileSync(history(),JSON.stringify({usage}));
 frame({type:'stream_event',event:{type:'message_start',message:{id:'answer'}}});
 frame({type:'stream_event',event:{type:'content_block_delta',delta:{type:'thinking_delta',thinking:'reason'}}});
 frame({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'Claude answer'}}});
 if(prompt==='multiblock'){
  const partial={type:'assistant',uuid:'delivery-one',message:{id:'answer',role:'assistant',stop_reason:null,content:[{type:'text',text:'Claude '}]}};frame(partial);frame(partial);
  frame({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'answer'}}});
  frame({type:'assistant',uuid:'delivery-two',message:{id:'answer',role:'assistant',stop_reason:null,content:[{type:'text',text:'answer'}]}})
 }else frame({type:'assistant',message:{id:'answer',role:'assistant',content:[{type:'text',text:'Claude answer'}]}});
 const result={type:'result',subtype:'success',is_error:false,result:'Claude answer',modelUsage:{'fixture-model':{inputTokens:usage*7,cacheReadInputTokens:usage*2,cacheCreationInputTokens:usage,outputTokens:usage*3}}};
 if(prompt==='late-exit'){frame(result);setTimeout(()=>process.exit(9),50)}
 else if(prompt==='gated-exit'){frame(result);const t=setInterval(()=>{if(fs.existsSync(process.env.TRACE+'.gate')){clearInterval(t);process.exit(0)}},10)}
 else if(prompt==='late-error'){frame(result);setTimeout(()=>{frame({type:'assistant',isApiErrorMessage:true,message:{id:'bad',content:[{type:'text',text:'private API failure'}]}});process.exit(0)},50)}
 else frame(result)
};
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);fs.appendFileSync(process.env.TRACE,line+'\n');
 if(r.type==='control_request')send({type:'control_response',response:{subtype:'success',request_id:r.request_id,response:r.request.subtype==='initialize'?{commands:[{name:'help',description:'Native help',argumentHint:'[topic]',aliases:['assist']},{name:'compact',description:'Compact native conversation',argumentHint:'[instructions]'}],models:[{value:'default',displayName:'Native default'}],account:{token:'native-secret'}}:r.request.subtype==='get_usage'?{session:{model_usage:{'fixture-model':{inputTokens:usage*7,cacheReadInputTokens:usage*2,cacheCreationInputTokens:usage,outputTokens:usage*3}}}}:r.request.subtype==='get_settings'?{effective:args.includes('--settings')?JSON.parse(args[args.indexOf('--settings')+1]):{}}:{}}});
 else if(r.type==='user'){prompt=r.message.content.filter(x=>x.type==='text').map(x=>x.text).join('\n');
  if(prompt==='crash')process.exit(7);else if(prompt==='broken')process.stdout.write('{bad\n');else if(prompt==='wait')setInterval(()=>{},1000);
  else if(['approval','question','withdraw'].includes(prompt)){
    pending='permission';frame({type:'control_request',request_id:pending,request:{subtype:'can_use_tool',tool_name:prompt==='question'?'AskUserQuestion':'Write',input:prompt==='question'?{questions:[{header:'Choice',question:'Which?',options:[{label:'First',description:'First option'},{label:'Second',description:'Second option'}],multiSelect:false}]}:{file_path:'fixture.txt',content:'allowed only after confirmation'},tool_use_id:'tool'}});
    if(prompt==='withdraw')setTimeout(()=>{send({type:'control_cancel_request',request_id:pending});finish()},60)
  }else finish()
 }else if(r.type==='control_response'&&r.response.request_id===pending){const response=r.response.response;
  if(response.behavior==='allow'){frame({type:'assistant',message:{id:'tools',content:[{type:'tool_use',id:'tool',name:prompt==='question'?'AskUserQuestion':'Write',input:response.updatedInput}]}});frame({type:'user',message:{content:[{type:'tool_result',tool_use_id:'tool',content:'done'}]}});finish()}else frame({type:'result',subtype:'success',is_error:true})
 }
});`

export async function setupClaude(root: string, runner: string, cleanup: Array<() => Promise<void>>, mode: 'global' | 'scoped' = 'global', overrides: JsonObject = {}, nativeContext?: any, artifacts?: any) {
  const directory = await mkdtemp(join(root, 'fixture-')), trace = join(directory, 'trace'), cli = join(directory, 'cli.cjs')
  await writeFile(cli, claudeProtocolFixture)
  const db = new DatabaseSync(':memory:'), executions = new AgentExecutionStore(db), store = new PluginStore(db), registry = new AgentRegistry(), events = new PluginEventBus()
  const logger = { info() {}, warn() {}, error() {} }, authorize = vi.fn()
  const commandRuns: string[] = []
  const gateway = vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:1/lease/v1', token: 'temporary-only', model: 'fixture-model', protocol: 'anthropic', images: true, dispose: vi.fn(async () => {}) }))
  const context = (scope: ExecutionScope, signal: AbortSignal) => createExecutionContext(scope, signal, logger, { authorize: async () => {},
    agents: { list: async () => [] }, sessions: { get: async () => null }, models: { gateway }, ...(artifacts ? { artifacts } : {}),
    runs: { start: async (scope: ExecutionScope, input: any) => {
      const accepted = coordinator.start(scope, input.instanceId, input.input, input.idempotencyKey, undefined, { kind: 'chat', sessionId: scope.sessionId! })
      commandRuns.push(accepted.id); return accepted
    } } })
  const coordinator = new AgentCoordinator({ store: executions, registry, events, logger, authorize, context, stateRoot: join(directory, 'state'), ...(nativeContext ? { nativeContext } : {}), ...(artifacts ? { validateInput: () => {} } : {}),
    authorizeChat: (scope, instance, sessionId) => { if (scope.principal.id !== claudeCaller.principal.id || instance.ownerId !== scope.principal.id || !sessionId.startsWith('fixture:')) throw new Error('Foreign fixture chat') } })
  const host = new PluginHost({ store, registry, events, context, logger, runnerPath: runner, artifactsRoot: join(directory, 'installed'),
    eventContext: async (_state, _event, signal) => context(claudeCaller, signal), acceptEvents: async batch => { for (const event of batch) events.publish(event) } })
  cleanup.push(async () => { await coordinator.close(); await host.close(); events.close(); db.close() })
  const manifest = JSON.parse(await readFile(join(root, 'plugins/claude-code/studio-plugin.json'), 'utf8'))
  await host.registerSystemArtifact(join(root, 'plugins/claude-code'), manifest.id)
  await host.configure({ pluginId: manifest.id, profileId: claudeCaller.profileId, ownerId: claudeCaller.principal.id, enabled: true, config: {}, grants: manifest.requires.capabilities }, 0)
  const config: JsonObject = { permissionMode: 'default', cwd: directory, command: process.execPath, args: [cli], model: 'fixture/model',
    env: { TRACE: trace, HOME: directory, USERPROFILE: directory, CLAUDE_CONFIG_DIR: join(directory, 'native') }, ...overrides }
  const instance = coordinator.createInstance(claudeCaller, { agentTypeId: 'claude-code', mode, config })
  let sequence = 0
  const start = (text: string) => coordinator.start(claudeCaller, instance.id, { content: [{ type: 'text', text }] }, `run-${++sequence}`)
  const frames = async () => (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const launches = async () => (await readFile(trace + '.launches', 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  return { db, coordinator, registry, host, executions, instance, config, directory, trace, gateway, authorize, start, frames, launches, context, commandRuns }
}
