import { expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

it('routes internal plugin approvals once, preserves denial, and leaves interactive runs awaiting a response', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plugin-agent-approval-'))
  const script = `
    const assert = require('node:assert/strict');
    const base = process.cwd() + '/packages/server/src/modules/studio/';
    require(base + 'infrastructure/database/schemas').initAllHermesTables();
    const {createSession} = require(base + 'repositories/session-store');
    const {configureChatAgentRuntime} = require(base + 'public/chat-agent-runtime');
    const {ChatRunSocket} = require(base + 'sockets/chat-run');
    const {agentRunInteractions, respondAgentInteraction} = require(base + 'services/agents/interactions');
    const unexpected = () => { throw new Error('Plugin approval reached a different runtime'); };
    configureChatAgentRuntime({respondToEkkoToolApproval:unexpected,codingAgentRunManager:{resolveApproval:unexpected}});
    (async () => {
      for (const choice of ['once','deny',undefined]) {
        const sessionId = 'plugin-approval-' + (choice || 'interactive');
        createSession({id:sessionId,profile:'default',source:'workflow',agent:'plugin:example/assistant'});
        const controller = new AbortController(), events = [];
        const server = Object.assign(Object.create(ChatRunSocket.prototype), {
          sessionMap:new Map(),runWaiters:new Map(),runHandlers:new Map(),
          nsp:{to:()=>({emit(){}})},bridge:{approvalRespond:unexpected},
          abortSession:async () => controller.abort(),
        });
        server.executeRun = async (_socket,data) => {
          const interactions = agentRunInteractions({sessionId,runId:'run',signal:controller.signal,
            deadlineAt:Date.now()+5000,emit:data.onEvent});
          const outcomes = await Promise.all(['first','second'].map(operationId => interactions.approve({operationId,title:'Read fixture',details:'Read local evidence'})));
          data.onEvent('run.completed',{output:outcomes.map(value=>value.outcome).join(',')});
        };
        try {
          const pending = server.runAndWait({session_id:sessionId,input:'Read',source:'workflow',agent_id:'plugin:example/assistant',mode:'global'},
            {profile:'default',approvalChoice:choice,timeoutMs:5000,onEvent:(event,payload)=>events.push({event,...payload})});
          if (!choice) {
            await new Promise(resolve=>setImmediate(resolve));
            assert.equal(events.filter(value=>value.event==='approval.resolved').length,0);
            for (const value of events.filter(value=>value.event==='approval.requested')) {
              assert.equal(respondAgentInteraction('another-session',value.approval_id,'approval','once').resolved,false);
              assert.equal(respondAgentInteraction(sessionId,value.approval_id,'approval','once').resolved,true);
            }
          }
          const result = await pending;
          assert.equal(result.ok,true,JSON.stringify(result));
          assert.equal(result.output,choice==='deny'?'denied,denied':'approved,approved');
          assert.equal(events.filter(value=>value.event==='approval.resolved').length,2);
          for (const value of events.filter(value=>value.event==='approval.requested')) {
            assert.equal(respondAgentInteraction(sessionId,value.approval_id,'approval','once').resolved,false);
          }
        } finally {controller.abort();}
      }
      for (const kind of ['approval','clarify']) {
        const sessionId = 'person-task-plugin-' + kind, events = [], controller = new AbortController();
        const state = {events:[]};
        const server = Object.assign(Object.create(ChatRunSocket.prototype), { sessionMap:new Map([[sessionId,state]]) });
        const interactions = agentRunInteractions({sessionId,runId:'run',signal:controller.signal,deadlineAt:Date.now()+5000,
          emit:(event,data)=>{state.events.push({event,data});events.push({event,...data});}});
        try {
          const pending = kind === 'approval' ? interactions.approve({operationId:'read',title:'Read',details:''})
            : interactions.clarify({question:'Which file?'});
          const request = events.find(event=>event.event===kind+'.requested');
          const id = request[kind+'_id'];
          assert.equal(await server.respondPersonInteraction('another-session',id,'once',kind==='approval'),false);
          assert.equal(await server.respondPersonInteraction(sessionId,id,kind==='approval'?'once':'proof.txt',kind==='approval'),true);
          assert.deepEqual(await pending,kind==='approval'?{outcome:'approved'}:{outcome:'answered',text:'proof.txt'});
          assert.equal(events.filter(event=>event.event===kind+'.resolved').length,1);
          assert.equal(await server.respondPersonInteraction(sessionId,id,'once',kind==='approval'),false);
        } finally {controller.abort();}
      }
      console.log('plugin approval routing verified');
    })().then(()=>process.exit(0)).catch(error=>{console.error(error);process.exit(1)});
  `
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ['-r', 'ts-node/register', '-e', script], {
      cwd: resolve('.'), timeout: 30_000,
      env: { ...process.env, NODE_ENV: 'test', HERMES_WEB_UI_TEST_DB_DIR: join(directory, 'db'), HERMES_WEB_UI_HOME: join(directory, 'web'), HERMES_HOME: join(directory, 'hermes'),
        HERMES_WEB_UI_DISABLE_MCP_AUTOINJECT: '1', TS_NODE_PROJECT: 'packages/server/tsconfig.json', TS_NODE_FILES: 'true', TS_NODE_TRANSPILE_ONLY: 'true', TS_NODE_COMPILER_OPTIONS: '{"rootDir":"."}' },
    })
    expect(stdout).toContain('plugin approval routing verified')
  } finally { await rm(directory, { recursive: true, force: true }) }
}, 35_000)
