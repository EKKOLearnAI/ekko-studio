import { expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// A separate process makes an unhandled socket error fail the test exactly as it
// would fail the server, without installing an uncaughtException escape hatch.
it.each(['after-response', 'during-response', 'timeout', 'connect-error'])(
  'contains Bridge socket errors %s', async (scenario) => {
    const directory = await mkdtemp(join(tmpdir(), 'studio-bridge-errors-'))
    const script = `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const path = require('node:path');
      const net = require('node:net');
      const { once } = require('node:events');
      const { AgentBridgeClient } = require(process.cwd() + '/packages/server/src/modules/hermes/services/bridge/client');
      const scenario = ${JSON.stringify(scenario)};
      (async () => {
        const peers = new Set();
        const server = net.createServer({ allowHalfOpen: true }, peer => {
          peers.add(peer);
          peer.on('error', () => {});
          peer.once('close', () => peers.delete(peer));
          peer.once('data', () => {
            if (scenario === 'during-response') { peer.resetAndDestroy(); return; }
            if (scenario === 'timeout') return;
            peer.write('{"ok":true}\\n');
          });
        });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const endpoint = 'tcp://127.0.0.1:' + server.address().port;
        const client = new AgentBridgeClient({ endpoint, timeoutMs: scenario === 'timeout' ? 100 : 1000, connectRetryMs: 0 });
        try {
          if (scenario === 'connect-error') {
            await new Promise(resolve => server.close(resolve));
            await assert.rejects(client.ping(), { code: 'ECONNREFUSED' });
          } else if (scenario === 'after-response') {
            let socket;
            const connect = client.connectSocketOnce.bind(client);
            client.connectSocketOnce = async () => { socket = await connect(); return socket; };
            // Reset only after the production client has consumed the response
            // and called end(). The peer keeps its half of the TCP stream open.
            assert.equal((await client.ping()).ok, true);
            const peer = [...peers][0];
            // events.once(socket, 'close') would add an error handler and hide
            // the regression. Observe close without consuming socket errors.
            const closed = new Promise(resolve => socket.once('close', resolve));
            peer.resetAndDestroy();
            await closed;
            assert.equal(socket.listenerCount('error'), 0, 'Release socket error ownership on close');
            const logs = fs.readFileSync(path.join(process.env.HERMES_WEB_UI_HOME, 'logs/bridge.log'), 'utf8').trim().split('\\n').map(JSON.parse);
            assert.ok(logs.some(event => event.endpoint === endpoint && event.err?.code === 'ECONNRESET'));
            assert.equal((await client.ping()).ok, true);
          } else if (scenario === 'during-response') {
            await assert.rejects(client.ping(), { code: 'ECONNRESET' });
          } else {
            await assert.rejects(client.ping(), /timed out/);
          }
          console.log('Bridge socket scenario passed: ' + scenario);
        } finally {
          for (const peer of peers) peer.destroy();
          if (server.listening) await new Promise(resolve => server.close(resolve));
        }
      })().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
    `
    try {
      const { stdout } = await promisify(execFile)(process.execPath, ['-r', 'ts-node/register', '-e', script], {
        cwd: resolve('.'), timeout: 10_000,
        env: { ...process.env, VITEST: '', NODE_ENV: 'test', BRIDGE_LOG_LEVEL: 'warn', HERMES_WEB_UI_HOME: join(directory, 'web'), HERMES_HOME: join(directory, 'hermes'),
          HERMES_WEB_UI_TEST_DB_DIR: join(directory, 'db'), TS_NODE_PROJECT: 'packages/server/tsconfig.json',
          TS_NODE_FILES: 'true', TS_NODE_TRANSPILE_ONLY: 'true', TS_NODE_COMPILER_OPTIONS: '{"rootDir":"."}' },
      })
      expect(stdout).toContain('Bridge socket scenario passed: ' + scenario)
    } finally { await rm(directory, { recursive: true, force: true }) }
  }, 15_000,
)
