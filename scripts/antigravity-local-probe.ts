// Opt-in actual CLI + loopback mock only; no real provider credentials or account state.
import Koa from 'koa'
import bodyParser from '@koa/bodyparser'
import { registerCodexProxyTarget, antigravityProxyGenerate } from '../packages/server/src/modules/coding-agents/services/codex/proxy.ts'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
const requests:any[]=[];let mainCalls=0
const upstream=createServer(async(req,res)=>{let b='';for await(const c of req)b+=c;const body=JSON.parse(b);requests.push(body);const title=JSON.stringify(body.messages).includes('title generator');const returned=body.messages.some((m:any)=>m.role==='tool');
 const declarations=body.tools?.map((t:any)=>t.function.name)||[];
 const readTool=declarations.find((n:string)=>/list.*dir|view_file/.test(n))||declarations[0];
 const tool=body.tools?.find((t:any)=>t.function.name===readTool);const schema=tool?.function.parameters;const params:any={};for(const key of schema?.required||[]){params[key]=/path|dir/i.test(key)?join(workspace,'probe.txt'):'test'}
 if(!title)mainCalls++;
 const message=title?{content:'Local Probe'}:!returned&&mainCalls<3?{content:null,tool_calls:[{id:'call1',type:'function',function:{name:readTool,arguments:JSON.stringify(params)}}]}:{content:'STUDIO_SCOPED_OK'};
 res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'r'+requests.length,choices:[{message,finish_reason:message.tool_calls?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:3,total_tokens:13}}));});await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));
const target=registerCodexProxyTarget({profile:'probe',provider:'local',model:'SELECTED_STUDIO_MODEL',baseUrl:`http://127.0.0.1:${(upstream.address() as any).port}/v1`,apiKey:'mock',apiMode:'chat_completions',agentId:'antigravity'})
const app=new Koa();app.use(bodyParser());app.use(async ctx=>{const match=/\/api\/codex-proxy\/([^/]+)\/gemini\/v1beta\/models\/(.+)/.exec(ctx.path);if(!match){ctx.status=404;return};(ctx as any).params={key:match[1],operation:match[2]};await antigravityProxyGenerate(ctx as any)});const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
const home=await mkdtemp('/tmp/agy-scoped-integration-home-');const workspace=await mkdtemp('/tmp/agy-scoped-integration-work-');await writeFile(join(workspace,'probe.txt'),'local test');await mkdir(join(home,'.gemini/antigravity-cli'),{recursive:true});await writeFile(join(home,'.gemini/antigravity-cli/settings.json'),' {"modelProvider":"gemini"}');
const child=spawn(process.env.ANTIGRAVITY_TEST_CLI || 'agy',['--input-format','stream-json','--output-format','stream-json'],{cwd:workspace,env:{PATH:process.env.PATH,HOME:home,USERPROFILE:home,GEMINI_API_KEY:target.token,GOOGLE_GEMINI_BASE_URL:`http://127.0.0.1:${(server.address() as any).port}/api/codex-proxy/${target.routeKey}/gemini`}});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);const timer=setTimeout(()=>child.kill('SIGKILL'),25000);child.stdin.end(JSON.stringify({event:'user',message:{content:'List this workspace then reply STUDIO_SCOPED_OK'}})+'\n');const code=await new Promise(r=>child.once('close',r));clearTimeout(timer);server.close();upstream.close();const result={code,models:requests.map(r=>r.model),hasToolResult:requests.some(r=>r.messages.some((m:any)=>m.role==='tool')),output:out,stderr:err};console.log(JSON.stringify(result,null,2));await rm(home,{recursive:true,force:true});await rm(workspace,{recursive:true,force:true});if(code!==0||!out.includes('STUDIO_SCOPED_OK')||requests.some(r=>r.model!=='SELECTED_STUDIO_MODEL')||!out.includes('1 lines, 10 bytes'))process.exitCode=1
