import { expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

it.each([
  'inherited-worker',
  'dead-inherited-worker',
  'environment-broker',
  'option-broker',
  'explicit-worker',
  'child-environment',
  'cold-broker',
  'probe-worker-fails-fast',
])(
  'isolates broker startup from worker context: %s', async (scenario) => {
    const directory = await mkdtemp(join(tmpdir(), 'studio-worker-env-'))
    const script = `
      const assert = require('node:assert/strict');
      const net = require('node:net');
      const fs = require('node:fs');
      const path = require('node:path');
      const { once } = require('node:events');
      const { AgentBridgeClient, DEFAULT_AGENT_BRIDGE_ENDPOINT } = require(process.cwd() + '/packages/server/src/modules/hermes/services/bridge/client');
      const { AgentBridgeManager, buildAgentBridgeProcessEnv } = require(process.cwd() + '/packages/server/src/modules/hermes/services/bridge/manager');
      const scenario = ${JSON.stringify(scenario)};
      const fixturePath = path.join(process.cwd(), 'tests/server/fixtures/agent-bridge-node-runtime.cjs').replace(/\\\\/g, '/');
      (async () => {
        const peers = new Set();
        const actions = [];
        const serve = role => net.createServer(peer => {
          peers.add(peer); peer.on('error', () => {}); peer.once('close', () => peers.delete(peer));
          let buffer = '';
          peer.on('data', data => {
            buffer += data;
            if (!buffer.includes('\\n')) return;
            const request = JSON.parse(buffer.split('\\n')[0]);
            actions.push({ role, action: request.action });
            const response = request.action === 'ping'
              ? { ok: true, pong: true, ...(role === 'broker' ? { mode: 'broker' } : { profile: 'test-worker', pid: 12345, agent_root: '/synthetic' }) }
              : role === 'broker'
                ? { ok: true, exists: false }
                : { ok: false, error: 'unknown action: ' + request.action };
            peer.end(JSON.stringify(response) + '\\n');
          });
        });
        const worker = serve('worker'), broker = serve('broker');
        worker.listen(0, '127.0.0.1'); await once(worker, 'listening');
        const workerEndpoint = 'tcp://127.0.0.1:' + worker.address().port;
        const deadWorkerEndpoint = DEFAULT_AGENT_BRIDGE_ENDPOINT.startsWith('ipc://')
          ? 'ipc://' + path.join(process.env.HERMES_HOME, 'hermes-agent-bridge-workers', 'deadworker000001.sock')
          : 'tcp://127.0.0.1:18999';
        const brokerListen = DEFAULT_AGENT_BRIDGE_ENDPOINT.startsWith('ipc://')
          ? DEFAULT_AGENT_BRIDGE_ENDPOINT.slice(6)
          : Number(new URL(DEFAULT_AGENT_BRIDGE_ENDPOINT).port);
        let brokerEndpoint = DEFAULT_AGENT_BRIDGE_ENDPOINT;
        if (scenario !== 'cold-broker' && scenario !== 'probe-worker-fails-fast') {
          if (scenario === 'environment-broker' || scenario === 'option-broker') broker.listen(0, '127.0.0.1');
          else broker.listen(brokerListen, ...(typeof brokerListen === 'number' ? ['127.0.0.1'] : []));
          await once(broker, 'listening');
          if (scenario === 'environment-broker' || scenario === 'option-broker') brokerEndpoint = 'tcp://127.0.0.1:' + broker.address().port;
        }
        process.env.HERMES_AGENT_BRIDGE_ENDPOINT = scenario === 'environment-broker'
          ? brokerEndpoint
          : scenario === 'dead-inherited-worker'
            ? deadWorkerEndpoint
            : workerEndpoint;
        process.env.HERMES_AGENT_BRIDGE_WORKER_PROFILE = 'test-worker';
        process.env.HERMES_AGENT_BRIDGE_BROKER_PID = '12345';
        try {
          if (scenario === 'child-environment') {
            const env = buildAgentBridgeProcessEnv(DEFAULT_AGENT_BRIDGE_ENDPOINT, process.env.HERMES_HOME, undefined);
            assert.equal(env.HERMES_AGENT_BRIDGE_WORKER_PROFILE, undefined);
            assert.equal(env.HERMES_AGENT_BRIDGE_BROKER_PID, undefined);
            assert.equal(env.HERMES_AGENT_BRIDGE_ENDPOINT, DEFAULT_AGENT_BRIDGE_ENDPOINT);
            assert.equal(process.env.HERMES_AGENT_BRIDGE_WORKER_PROFILE, 'test-worker');
            assert.equal(process.env.HERMES_AGENT_BRIDGE_BROKER_PID, '12345');
          } else if (scenario === 'cold-broker' || scenario === 'probe-worker-fails-fast') {
            const root = path.join(process.env.HERMES_HOME, 'synthetic-agent');
            fs.mkdirSync(root, { recursive: true });
            fs.writeFileSync(path.join(root, 'run_agent.py'), '');
            process.env.STUDIO_TEST_BRIDGE_ENV_FILE = path.join(root, 'child-env.json');
            process.env.NODE_OPTIONS = '--require=' + JSON.stringify(fixturePath);
            process.env.HERMES_AGENT_BRIDGE_AUTO_RESTART = '0';
            if (scenario === 'probe-worker-fails-fast') {
              process.env.STUDIO_TEST_FORCE_WORKER_PING = '1';
              const manager = new AgentBridgeManager({ endpoint: DEFAULT_AGENT_BRIDGE_ENDPOINT, python: process.execPath, agentRoot: root, hermesHome: process.env.HERMES_HOME, startupTimeoutMs: 5000 });
              const startedAt = Date.now();
              try {
                await assert.rejects(manager.start(), /worker.*broker/i);
                assert.equal(manager.running, false);
                assert.ok(Date.now() - startedAt < 3000, 'probe should fail fast instead of waiting for startupTimeoutMs');
              } finally {
                await manager.stop();
                if (DEFAULT_AGENT_BRIDGE_ENDPOINT.startsWith('ipc://')) fs.rmSync(DEFAULT_AGENT_BRIDGE_ENDPOINT.slice(6), { force: true });
              }
            } else {
              const manager = new AgentBridgeManager({ endpoint: DEFAULT_AGENT_BRIDGE_ENDPOINT, python: process.execPath, agentRoot: root, hermesHome: process.env.HERMES_HOME, startupTimeoutMs: 2000 });
              try {
                await manager.start();
                const childEnv = JSON.parse(fs.readFileSync(process.env.STUDIO_TEST_BRIDGE_ENV_FILE, 'utf8'));
                assert.equal(childEnv.profile, undefined);
                assert.equal(childEnv.brokerPid, undefined);
                assert.equal(childEnv.endpoint, DEFAULT_AGENT_BRIDGE_ENDPOINT);
                assert.equal((await new AgentBridgeClient({ connectRetryMs: 0 }).statusIfLoaded('synthetic-session')).exists, false);
              } finally { await manager.stop(); }
            }
          } else {
            const options = scenario === 'option-broker' ? { endpoint: brokerEndpoint }
              : scenario === 'explicit-worker' ? { endpoint: workerEndpoint } : {};
            const defaultClient = new AgentBridgeClient({ connectRetryMs: 0, timeoutMs: 1000 });
            const pinnedWorkerClient = new AgentBridgeClient({ endpoint: workerEndpoint, connectRetryMs: 0, timeoutMs: 1000 });
            const manager = new AgentBridgeManager(options);
            if (scenario === 'explicit-worker') {
              await assert.rejects(manager.start(), /worker.*broker/i);
              assert.equal(manager.running, false);
              assert.equal(manager.endpoint, workerEndpoint);
              assert.equal((await manager.checkReadiness()).reachable, false);
            } else {
              await manager.start();
              const response = await defaultClient.statusIfLoaded('synthetic-session');
              assert.equal(response.ok, true);
              assert.equal(response.exists, false);
              assert.equal(manager.endpoint, brokerEndpoint);
              assert.equal((await manager.checkReadiness()).reachable, true);
              assert.equal(actions.some(item => item.role === 'worker' && item.action === 'status_if_loaded'), false);
              assert.equal(pinnedWorkerClient.endpoint, workerEndpoint);
              await assert.rejects(pinnedWorkerClient.statusIfLoaded('synthetic-session'), /unknown action: status_if_loaded/);
            }
          }
          console.log('Worker environment scenario passed: ' + scenario);
        } finally {
          for (const peer of peers) peer.destroy();
          await Promise.all([worker, broker].filter(server => server.listening).map(server => new Promise(resolve => server.close(resolve))));
        }
      })().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
    `
    try {
      const { stdout } = await promisify(execFile)(process.execPath, ['-r', 'ts-node/register', '-e', script], {
        cwd: resolve('.'), timeout: 15_000,
        env: {
          PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TMPDIR: process.env.TMPDIR,
          VITEST: '1', NODE_ENV: 'test', BRIDGE_LOG_LEVEL: 'warn',
          HERMES_WEB_UI_HOME: join(directory, 'web'), HERMES_HOME: join(directory, 'hermes'),
          HERMES_WEB_UI_TEST_DB_DIR: join(directory, 'db'),
          HERMES_AGENT_BRIDGE_ATTACH_RETRY_MS: '1', HERMES_AGENT_BRIDGE_ATTACH_TIMEOUT_MS: '1000',
          TS_NODE_PROJECT: 'packages/server/tsconfig.json', TS_NODE_FILES: 'true',
          TS_NODE_TRANSPILE_ONLY: 'true', TS_NODE_COMPILER_OPTIONS: '{"rootDir":"."}',
        },
      })
      expect(stdout).toContain('Worker environment scenario passed: ' + scenario)
    } finally { await rm(directory, { recursive: true, force: true }) }
  }, 20_000,
)
