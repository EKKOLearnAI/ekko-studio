import { expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

it('resumes live plugin workflow, group and global chats without handing their run IDs to Hermes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-plugin-workflow-'))
  const script = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs/promises');
    const path = require('node:path');
    const base = process.cwd() + '/packages/server/src/modules/studio/';
    require(base + 'infrastructure/database/schemas').initAllHermesTables();
    require(process.cwd() + '/packages/server/src/bootstrap/agent-profile-adapter');
    const sessions = require(base + 'repositories/session-store');
    const { createUser } = require(base + 'repositories/users-store');
    const { authorizePluginIdentity } = require(base + 'services/plugins/host');
    const { PluginRuntime } = require(base + 'services/plugins/runtime');
    const { PluginStore } = require(base + 'services/plugins/store');
    const { configurePluginAgents } = require(base + 'services/agents/registry');
    const { ChatRunSocket } = require(base + 'sockets/chat-run');
    require(base + 'public/chat-agent-runtime').configureChatAgentRuntime({ codingAgentRunManager:{waitForSessionExit:async()=>{}} });
    (async () => {
      const workspace = path.join(process.env.HERMES_WEB_UI_HOME, 'workspace');
      await fs.mkdir(workspace, { recursive: true });
      const user = createUser({ username:'workflow-owner', password:'fixture', role:'super_admin', profiles:['default'] });
      const agentId = 'plugin:example/assistant';
      const live = new Map(), releases = new Map(), waiting = new Map(), events = [], resumed = [];
      const owner = new PluginRuntime({ directory:workspace, source:workspace, enabled:true, config:{}, installedAt:0,
        manifest:{ id:'example',name:'Example',version:'1.0.0',apiVersion: 1,server:'server.mjs',permissions:['agents'] } },
        { userId:user.id,profile:'default' },new PluginStore(path.join(workspace,'plugins')),
        { authorize:authorizePluginIdentity,api:async()=>null,emit(){},log(){} });
      await owner.load({ apply(ctx) { ctx.extensions.agents.register({ id:'assistant',name:'Example',vendor:'Fixture',agentApiVersion: 1,
        getStatus:async()=>({installed:true,version:'1.0.0'}),management:{},
        modes:{global:{listModels:async()=>({status:'empty',source:'fixture',scope:'builtin',models:[]})}},
        features: {surfaces:['chat','workflow','group-chat'],streaming:true,resume:false},
        runtime:{createSession:()=>({async run(input,run){
          const id=run.identity.sessionId;
          live.set(id,run);
          await run.output.emit({type:'text.delta',text:'Before reconnect'});
          const pending=new Promise(resolve=>releases.set(id,resolve));
          waiting.get(id)();
          await pending;
          await run.output.emit({type:'text.delta',text:' after reconnect'});
          return {content:[{type:'text',text:'Before reconnect after reconnect'}],finishReason:'stop'};
        },dispose(){}})},
      });}}); owner.activate();configurePluginAgents(()=>[...owner.agents.values()]);
      let statusCalls=0,resultCalls=0;
      const bridge={statusIfLoaded:async()=>{statusCalls++;return {running:false}},getResult:async id=>{resultCalls++;throw new Error('unknown run: '+id)}};
      const server=Object.assign(Object.create(ChatRunSocket.prototype),{
        sessionMap:new Map(),runWaiters:new Map(),runHandlers:new Map(),ekkoExecutions:new Map(),bridgeResumePolls:new Set(),bridge,
        nsp:{to:()=>({emit:(event,payload)=>events.push({event,...payload})}),adapter:{rooms:new Map()}},
        beginTaskPlanRun(){},finishTaskPlanRun(){},emitPendingInteraction(){},dequeueNextQueuedRun(){},
      });
      const socket={id:'viewer',connected:true,data:{user},emit:(event,payload)=>resumed.push({event,...payload})};
      try {
        for(const source of ['workflow','group_chat','global_agent']){
          const sid='plugin-'+source;
          sessions.createSession({id:sid,source,agent:agentId,agent_mode:'global',profile:'default',workspace,user_id:user.id});
          const ready=new Promise(resolve=>waiting.set(sid,resolve));
          const pending=server.runAndWait({session_id:sid,input:'Run the node',source,session_source:source,coding_agent_id:agentId,mode:'global',workspace},
            {profile:'default',user,timeoutMs:5000});
          await ready;
          const state=server.sessionMap.get(sid),runId=state.runId,marker=state.activeRunMarker;
          await server.resumeSession(socket,sid);
          // A live runtime identity remains authoritative while stored metadata is incomplete.
          sessions.updateSession(sid,{agent:''});
          await server.resumeSession(socket,sid,{event:'app.resumed',cachedId:'stale'});
          sessions.updateSession(sid,{agent:agentId});
          assert.equal(statusCalls,0,'Plugin reconnect must not probe Hermes');
          assert.equal(resultCalls,0,'Plugin run ID must not reach Hermes getResult');
          assert.equal(state.runId,runId);
          assert.equal(state.activeRunMarker,marker);
          assert.equal(state.isWorking,true);
          assert.ok(resumed.filter(event=>event.session_id===sid).every(event=>event.isWorking===true));
          assert.ok(resumed.find(event=>event.session_id===sid).events.some(event=>event.event==='message.delta'));
          releases.get(sid)();
          const result=await pending;
          assert.equal(result.ok,true,result.error);
          assert.equal(result.output,'Before reconnect after reconnect');
          await server.waitForRunTermination(sid);
          assert.equal(state.isWorking,false);
        }
        const control='hermes-workflow';
        sessions.createSession({id:'plugin-unavailable',source:'workflow',agent:'plugin:missing/agent',profile:'default'});
        sessions.createSession({id:control,source:'workflow',agent:'hermes',profile:'default'});
        await server.reattachBridgeRun(socket,control,{messages:[],events:[],queue:[],isWorking:false});
        assert.equal(statusCalls,1,'Hermes workflows still use their bridge');
        const recovered=server.backgroundRecoveryRoutes().flatMap(route=>route.session_ids);
        assert.ok(recovered.includes(control));
        assert.ok(!recovered.some(id=>id.startsWith('plugin-')));
        assert.equal(events.filter(event=>event.event==='run.failed').length,0);
        assert.equal(events.filter(event=>event.event==='run.completed').length,3);
        console.log('Plugin reconnect and Hermes recovery routing verified');
      } finally { for(const release of releases.values())release();await owner.close(); }
    })().then(()=>process.exit(0)).catch(error=>{console.error(error);process.exit(1)});
  `
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ['-r', 'ts-node/register', '-e', script], {
      cwd: resolve('.'), timeout: 20_000,
      env: { ...process.env, NODE_ENV: 'test', HERMES_WEB_UI_TEST_DB_DIR: join(directory, 'db'), HERMES_WEB_UI_HOME: join(directory, 'web'), HERMES_HOME: join(directory, 'hermes'),
        HERMES_WEB_UI_DISABLE_MCP_AUTOINJECT: '1', TS_NODE_PROJECT: 'packages/server/tsconfig.json', TS_NODE_FILES: 'true', TS_NODE_TRANSPILE_ONLY: 'true', TS_NODE_COMPILER_OPTIONS: '{"rootDir":"."}' },
    })
    expect(stdout).toContain('Plugin reconnect and Hermes recovery routing verified')
  } finally { await rm(directory, { recursive: true, force: true }) }
}, 25_000)
