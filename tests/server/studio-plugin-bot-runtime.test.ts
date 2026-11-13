import { expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

it('executes an account-owned Bot plugin task through the scheduler and chat runtime past its permission heartbeat', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-plugin-bot-'))
  const script = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs/promises');
    const path = require('node:path');
    const base = process.cwd() + '/packages/server/src/modules/studio/';
    require(base + 'infrastructure/database/schemas').initAllHermesTables();
    require(process.cwd() + '/packages/server/src/bootstrap/agent-profile-adapter');
    const sessions = require(base + 'repositories/session-store');
    const users = require(base + 'repositories/users-store');
    const store = require(base + 'repositories/person-store');
    const { applyPersonTask } = require(base + 'services/person/tasks');
    const { tickPersonWork, stopPersonWork } = require(base + 'services/person/runner');
    const { validatePersonSelection } = require(base + 'services/person/catalog');
    const { authorizePluginIdentity } = require(base + 'services/plugins/host');
    const { PluginRuntime } = require(base + 'services/plugins/runtime');
    const { PluginStore } = require(base + 'services/plugins/store');
    const { configurePluginAgents } = require(base + 'services/agents/registry');
    const { configurePersonRuntime } = require(base + 'public/person-runtime');
    const { setChatRunServer } = require(base + 'public/chat-run');
    const { ChatRunSocket } = require(base + 'sockets/chat-run');
    const { executePersonTask, stopPersonTask } = require(process.cwd() + '/packages/server/src/bootstrap/person-task-runtime');
    (async () => {
      let workspace = path.join(process.env.HERMES_WEB_UI_HOME, 'workspace');
      await fs.mkdir(workspace, { recursive: true });
      workspace = await fs.realpath(workspace);
      const user = users.createUser({ username: 'worker', password: 'fixture', role: 'admin', profiles: ['default'] });
      const installer = users.createUser({ username: 'installer', password: 'fixture', role: 'super_admin', profiles: ['default'] });
      const agentId = 'plugin:example/assistant';
      const selection = { runtime: agentId, mode: 'global', profile: 'default', provider: '', model: 'native' };
      const events = [], received = [];
      const owner = new PluginRuntime({ directory: workspace, source: workspace, enabled: true, config: {}, installedAt: 0,
        manifest: { id: 'example', name: 'Example', version: '1.0.0', apiVersion: 1, server: 'server.mjs', permissions: ['agents', 'api.read'] } },
        { userId: installer.id, profile: 'default' }, new PluginStore(path.join(workspace, 'plugins')),
        { authorize: authorizePluginIdentity, api: async (identity, url, options) => {
          authorizePluginIdentity(identity);
          assert.equal(identity.workspace, workspace);
          assert.equal(url, '/api/studio/sessions/' + identity.sessionId + '/workspace-file/read');
          return { content: 'workspace evidence' };
        }, emit() {}, log() {} });
      await owner.load({ apply(ctx) { ctx.extensions.agents.register({ id: 'assistant', name: 'Example', vendor: 'Fixture', agentApiVersion: 1,
        getStatus: async () => ({ installed: true, version: '1.0.0' }), management: {},
        modes: { global: { listModels: async () => ({ status: 'ready', source: 'fixture', scope: 'configured', models: [{ id: 'native', name: 'Native' }] }) } },
        features: { surfaces: ['chat'], streaming: true, resume: false }, runtime: { createSession: () => ({ async run(input, run) {
          received.push({ input, identity: run.identity, paths: run.paths });
          assert.equal(run.identity.userId, user.id);
          assert.equal((await run.workspace.read('proof.txt')).content, 'workspace evidence');
          await run.output.emit({ type: 'text.delta', text: 'Working' });
          if (received.length === 1) await new Promise(resolve => setTimeout(resolve, 16000));
          run.signal.throwIfAborted();
          return { content: [{ type: 'text', text: 'Plugin task completed' }], finishReason: 'stop' };
        }, dispose() {} }) },
      }); } });
      owner.activate(); configurePluginAgents(() => [...owner.agents.values()]);
      const server = Object.assign(Object.create(ChatRunSocket.prototype), {
        sessionMap: new Map(), runWaiters: new Map(), runHandlers: new Map(), ekkoExecutions: new Map(),
        nsp: { to: () => ({ emit: (event, payload) => events.push({ event, ...payload }) }) },
        beginTaskPlanRun() {}, finishTaskPlanRun() {}, emitPendingInteraction() {}, dequeueNextQueuedRun() {},
      });
      setChatRunServer(server);
      configurePersonRuntime({ execute: executePersonTask, stop: stopPersonTask, deliver: async () => {}, answer: async () => false,
        nativeModels: (_id, identity) => owner.agents.get('assistant').models(identity) });
      try {
        const main = 'person-main-fixture';
        sessions.createSession({ id: main, studio_user_id: user.id, user_id: user.id, workspace, source: 'builtin_agent', agent: 'ekko-agent', profile: 'default' });
        const settings = store.personSettings(user.id);
        store.savePersonSettings(user.id, { ...settings.settings, workspace, agents: [{ id: 'developer', name: 'Plugin developer', description: 'Write files', selection }] }, settings.revision);
        const created = await applyPersonTask(user.id, { action: 'create', session_id: main, idempotency_key: 'create', title: 'Plugin task', goal: 'Write a result', agent_id: 'developer' });
        for (let i = 0; i < 202; i++) sessions.addMessage({ session_id: created.execution.session_id, role: i % 2 ? 'assistant' : 'user', content: 'History ' + i, timestamp: i + 1 });
        await tickPersonWork();
        const deadline = Date.now() + 22000;
        let actual;
        do {
          await new Promise(resolve => setTimeout(resolve, 25));
          actual = store.getPersonExecution(user.id, created.execution.id);
        } while (!['finished', 'failed', 'interrupted'].includes(actual.state) && Date.now() < deadline);
        assert.equal(actual.state, 'finished', actual.error);
        assert.equal(actual.output, 'Plugin task completed');
        assert.equal(received[0].input.history.length, 202);
        assert.equal(received[0].input.history[0].content[0].text, 'History 0');
        assert.equal(received[0].input.history.at(-1).content[0].text, 'History 201');
        assert.equal(received[0].identity.sessionId, created.execution.session_id);
        assert.equal(events.filter(event => event.event === 'run.completed').length, 1);
        const identity = { userId: user.id, profile: 'default', sessionId: created.execution.session_id };
        authorizePluginIdentity(identity);
        assert.throws(() => authorizePluginIdentity({ ...identity, userId: installer.id }), /Session is unavailable/);
        assert.throws(() => authorizePluginIdentity({ ...identity, profile: 'other' }), /access to this profile/);
        const orphan = 'person-task-orphan';
        sessions.createSession({ id: orphan, studio_user_id: user.id, profile: 'default', agent: agentId });
        assert.throws(() => authorizePluginIdentity({ ...identity, sessionId: orphan }), /Session is unavailable/);
        require(base + 'public/agent-status-registry').updateAgentStatus('codex', { installed: true, source: 'user-cli' });
        await assert.rejects(validatePersonSelection(user.id, { ...selection, runtime: 'codex' }), /Native machine credentials/);
        users.updateUser({ userId: user.id, profiles: [] });
        assert.throws(() => authorizePluginIdentity(identity), /access to this profile/);
        console.log('Bot plugin dispatch, heartbeat, complete history, workspace and ownership verified');
      } finally { await stopPersonWork(); await owner.close(); setChatRunServer(null); }
    })().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
  `
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ['-r', 'ts-node/register', '-e', script], {
      cwd: resolve('.'), timeout: 35_000,
      env: { ...process.env, NODE_ENV: 'test', HERMES_WEB_UI_TEST_DB_DIR: join(directory, 'db'), HERMES_WEB_UI_HOME: join(directory, 'web'), HERMES_HOME: join(directory, 'hermes'),
        HERMES_WEB_UI_DISABLE_MCP_AUTOINJECT: '1', TS_NODE_PROJECT: 'packages/server/tsconfig.json', TS_NODE_FILES: 'true', TS_NODE_TRANSPILE_ONLY: 'true', TS_NODE_COMPILER_OPTIONS: '{"rootDir":"."}' },
    })
    expect(stdout).toContain('Bot plugin dispatch, heartbeat, complete history, workspace and ownership verified')
  } finally { await rm(directory, { recursive: true, force: true }) }
}, 40_000)
