import { expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

it('rejects cross-profile command history writes and does not dequeue while a run is active', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plugin-socket-access-'))
  const script = `
    const assert = require('node:assert/strict');
    const base = process.cwd() + '/packages/server/src/modules/studio/';
    require(base + 'infrastructure/database/schemas').initAllHermesTables();
    const { createUser } = require(base + 'repositories/users-store');
    const { createSession, getMessageCount } = require(base + 'repositories/session-store');
    const { toAuthenticatedUser } = require(base + 'middleware/auth');
    const { ChatRunSocket } = require(base + 'sockets/chat-run');
    const limited = createUser({username:'limited',password:'test-only-password',role:'admin',profiles:['default']});
    createSession({id:'private-session',profile:'private',source:'cli'});
    createSession({id:'busy-session',profile:'default',source:'cli'});
    const callbacks = new Map();
    const socket = {id:'fixture',data:{user:toAuthenticatedUser(limited)},handshake:{query:{profile:'default'},auth:{}},rooms:new Set(),
      on(event,fn){callbacks.set(event,fn);return this},join(room){this.rooms.add(room)},emit(){},to(){return{emit(){}}}};
    const instance = Object.assign(Object.create(ChatRunSocket.prototype),{sessionMap:new Map(),runAdmissions:new Map(),sessionStateSync:{attach(){}},
      nsp:{to(){return{emit(){}}},adapter:{rooms:new Map()}},emitToSession(){}});
    let starts=0;instance.runQueuedItem=()=>{starts++};
    ChatRunSocket.prototype.onConnection.call(instance,socket);
    (async()=>{
      const before=getMessageCount('private-session');
      await callbacks.get('run')({session_id:'private-session',profile:'default',input:'/missing:command unauthorized text'});
      assert.equal(getMessageCount('private-session'),before);
      const live={messages:[],isWorking:true,runId:'active-run',events:[],queue:[{queue_id:'queued',input:'next',profile:'default'}]};
      instance.sessionMap.set('busy-session',live);
      await callbacks.get('run')({session_id:'busy-session',profile:'default',input:'/missing:command'});
      assert.equal(starts,0);assert.equal(live.runId,'active-run');assert.equal(live.queue.length,1);
      console.log('plugin socket authorization and queue verified');
    })().then(()=>process.exit(0)).catch(error=>{console.error(error);process.exit(1)});
  `
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ['-r', 'ts-node/register', '-e', script], {
      cwd: resolve('.'), timeout: 30_000,
      env: { ...process.env, NODE_ENV: 'test', HERMES_WEB_UI_TEST_DB_DIR: join(dir, 'db'), HERMES_WEB_UI_HOME: join(dir, 'web'), HERMES_HOME: join(dir, 'hermes'),
        HERMES_WEB_UI_DISABLE_MCP_AUTOINJECT: '1', TS_NODE_PROJECT: 'packages/server/tsconfig.json', TS_NODE_FILES: 'true', TS_NODE_TRANSPILE_ONLY: 'true', TS_NODE_COMPILER_OPTIONS: '{"rootDir":"."}' },
    })
    expect(stdout).toContain('plugin socket authorization and queue verified')
  } finally { await rm(dir, { recursive: true, force: true }) }
}, 35_000)
