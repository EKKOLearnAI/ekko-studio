import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { PluginHost } from '../../packages/server/src/modules/studio/services/plugins/host'
import { PluginStore } from '../../packages/server/src/modules/studio/repositories/plugin-store'
import { AgentExecutionStore } from '../../packages/server/src/modules/studio/repositories/agent-execution-store'
import { AgentRegistry } from '../../packages/server/src/modules/studio/services/agents/registry'
import { AgentCoordinator } from '../../packages/server/src/modules/studio/services/agents/coordinator'
import { PluginEventBus } from '../../packages/server/src/modules/studio/services/events/plugin-events'
import { createExecutionContext } from '../../packages/server/src/modules/studio/services/context/execution'
import { PluginHookRegistry } from '../../packages/server/src/modules/studio/services/events/plugin-hooks'
import type { ExecutionScope } from '../../packages/studio-plugin-sdk/src'

let root: string, runner: string
const cleanups: Array<() => Promise<void>> = []
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'studio-process-rpc-'))
  runner = join(root, 'runner.cjs')
  await build({ entryPoints: ['packages/studio-plugin-runner/src/main.ts'], bundle: true, platform: 'node', target: 'node24.22.1', format: 'cjs', outfile: runner, logLevel: 'silent' })
})
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
afterAll(async () => { await rm(root, { recursive: true, force: true }) })
const scope: ExecutionScope = { scopeId: 'scope', principal: { kind: 'user', id: 'caller' }, profileId: 'one', surface: 'api', traceId: 'trace' }
function alive(pid: number) { try { process.kill(pid, 0); return true } catch { return false } }

async function setup(options: { granted?: boolean; crash?: boolean; shared?: boolean; hook?: boolean; acp?: boolean; mcp?: boolean; mcpSdk?: boolean } = {}) {
  const directory = await mkdtemp(join(root, 'artifact-')), pidPath = join(directory, 'pid')
  const db = new DatabaseSync(':memory:'), store = new PluginStore(db), registry = new AgentRegistry(), events = new PluginEventBus(), hooks = new PluginHookRegistry()
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const context = (scope: ExecutionScope, signal: AbortSignal) => createExecutionContext(scope, signal, logger, { authorize: async () => {}, agents: { list: async () => [] }, sessions: { get: async () => null } })
  const coordinator = new AgentCoordinator({ store: new AgentExecutionStore(db), registry, events, logger, authorize: () => {}, context })
  const host = new PluginHost({ store, registry, events, hooks, context, logger, runnerPath: runner, artifactsRoot: join(root, 'installed'),
    eventContext: async (state, _event, signal) => context({ ...scope, principal: { kind: 'user', id: state.ownerId } }, signal), acceptEvents: async batch => { for (const event of batch) events.publish(event) } })
  cleanups.push(async () => { await coordinator.close(); await host.close(); events.close(); db.close() })
  const capabilities = ['agents.register', ...(options.granted === false ? [] : [options.mcpSdk ? 'mcp.connect' : 'processes.spawn']), ...(options.hook ? ['hooks.before:sessions.remove'] : [])]
  const manifest = { schemaVersion: 1, id: 'test.process', version: '1.0.0', engines: { studioSdk: '^0.1.0', rpc: 1 }, backend: 'index.cjs', activation: 'profile',
    contributes: { agents: ['test.process/agent'] }, requires: { capabilities }, configSchema: {} }
  await writeFile(join(directory, 'studio-plugin.json'), JSON.stringify(manifest))
  const childCode = `require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
    process.on('SIGTERM', () => {}); require('node:readline').createInterface({ input: process.stdin }).on('line', line => process.stdout.write(JSON.stringify({ pid: process.pid, text: line }) + '\\n'));`
  await writeFile(join(directory, 'index.cjs'), `let shared; module.exports = { apply(plugin) {
    ${options.hook ? `plugin.hooks.before('sessions.remove', async () => { try { await shared.write(Buffer.from('forbidden\\n')); return { action: 'continue' } } catch(error) { plugin.logger.info('hook-process', { code: error.code }); return { action: 'reject' } } }, { key: 'readonly' });` : ''}
    plugin.agents.register({ id: 'test.process/agent', name: 'Managed process', configSchema: {}, capabilities: { text: true, persistentSession: true, modes: ['scoped'] }, create: async (_input, ctx) => {
      const child = ${options.shared ? 'shared ||' : ''} await ctx.processes.spawn({ command: ${JSON.stringify(process.execPath)}, args: ['-e', ${JSON.stringify(childCode)}], cwd: ${JSON.stringify(directory)} });
      shared = child;
      return { run: async input => {
        let resolve, reject; const result = new Promise((yes, no) => { resolve = yes; reject = no });
        return { result, cancel: async () => { await child.stop(); resolve({ status: 'cancelled' }) }, events: (async function* () {
          try {
            await child.write(Buffer.from(input.content[0].text + '\\n'));
            let text = '';
            while (!text.includes('\\n')) { const batch = await child.read(); for (const chunk of batch.chunks) if (chunk.stream === 'stdout') text += Buffer.from(chunk.data).toString('utf8'); if (batch.exit) break; }
            ${options.crash ? 'process.exit(17);' : ''}
            yield { type: 'message.delta', producerSequence: 1, messageId: 'answer', text };
            resolve({ status: 'completed' });
          } catch (error) { reject(error); throw error }
        })() };
      }, dispose: async () => { try { await child.dispose() } catch (error) { ${options.shared ? "if (error.code !== 'FORBIDDEN') throw error" : 'throw error'} } } };
    } });
  } }`)
  if (options.acp) {
    await build({ entryPoints: ['packages/studio-agent-drivers/src/index.ts'], bundle: true, platform: 'node', target: 'node24.22.1', format: 'cjs', outfile: join(directory, 'driver.cjs'), logLevel: 'silent' })
    await writeFile(join(directory, 'cli.cjs'), `const reply = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
      require('node:readline').createInterface({ input: process.stdin }).on('line', line => { const request = JSON.parse(line);
        if (request.method === 'initialize') reply({ id: request.id, result: { protocolVersion: 1, agentCapabilities: {} } });
        else if (request.method === 'session/new') reply({ id: request.id, result: { sessionId: 'native' } });
        else if (request.method === 'session/prompt') { reply({ method: 'session/update', params: { sessionId: 'native', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: request.params.prompt[0].text } } } }); reply({ id: request.id, result: { stopReason: 'end_turn' } }); }
      });`)
    await writeFile(join(directory, 'index.cjs'), `const { AcpConnection, ManagedProcessTransport } = require('./driver.cjs');
      module.exports = { apply(plugin) { plugin.agents.register({ id: 'test.process/agent', name: 'ACP over SDK', configSchema: {}, capabilities: { text: true, modes: ['scoped'] },
        create: async (_input, runtime) => { let transport; return {
          run: async input => { let resolve, reject; const result = new Promise((yes, no) => { resolve = yes; reject = no });
            return { result, cancel: async () => { await transport?.dispose(); resolve({ status: 'cancelled' }) }, events: (async function* () {
              try { const child = await runtime.processes.spawn({ command: ${JSON.stringify(process.execPath)}, args: [require('node:path').join(__dirname, 'cli.cjs')], cwd: __dirname });
                transport = new ManagedProcessTransport(child); const updates = [];
                const connection = new AcpConnection(transport, { session() {}, update: value => updates.push(value) });
                await connection.prompt({ cwd: __dirname, text: input.content[0].text, mcpServers: [] }); await transport.exited;
                let sequence = 0; for (const update of updates) yield { type: 'message.delta', producerSequence: ++sequence, messageId: 'answer', text: update.content.text };
                resolve({ status: 'completed' });
              } catch (error) { reject(error); throw error }
            })() };
          }, dispose: async () => { await transport?.dispose() }
        } } }); } }`)
  }
  if (options.mcp) {
    await build({ stdin: { contents: `export { ManagedJsonRpcTransport } from './packages/studio-agent-drivers/src'; export { Client, parseJSONRPCMessage } from '@modelcontextprotocol/client';`, resolveDir: process.cwd() },
      bundle: true, platform: 'node', target: 'node24.22.1', format: 'cjs', outfile: join(directory, 'driver.cjs'), logLevel: 'silent' })
    await writeFile(join(directory, 'cli.cjs'), await readFile('tests/fixtures/fake-mcp-server.cjs'))
    await writeFile(join(directory, 'index.cjs'), `const { Client, parseJSONRPCMessage, ManagedJsonRpcTransport } = require('./driver.cjs');
      module.exports = { apply(plugin) { plugin.agents.register({ id: 'test.process/agent', name: 'MCP over SDK', configSchema: {}, capabilities: { text: true, modes: ['scoped'] },
        create: async (_input, runtime) => { let transport; return {
          run: async input => { let resolve, reject; const result = new Promise((yes, no) => { resolve = yes; reject = no });
            return { result, cancel: async () => { await transport?.close(); resolve({ status: 'cancelled' }) }, events: (async function* () {
              try { const child = await runtime.processes.spawn({ command: ${JSON.stringify(process.execPath)}, args: [require('node:path').join(__dirname, 'cli.cjs')], cwd: __dirname });
                transport = new ManagedJsonRpcTransport(child, parseJSONRPCMessage);
                const client = new Client({ name: 'plugin-fixture', version: '1' }); await client.connect(transport); await client.listTools();
                const reply = await client.callTool({ name: 'fake_echo', arguments: { text: input.content[0].text } });
                const pid = await client.callTool({ name: 'fake_pid' }); await client.close();
                yield { type: 'message.delta', producerSequence: 1, messageId: 'answer', text: JSON.stringify({ text: reply.content[0].text, pid: Number(pid.content[0].text) }) };
                resolve({ status: 'completed' });
              } catch (error) { reject(error); throw error }
            })() };
          }, dispose: async () => { await transport?.close() }
        } } }); } }`)
  }
  if (options.mcpSdk) {
    await writeFile(join(directory, 'cli.cjs'), await readFile('tests/fixtures/fake-mcp-server.cjs'))
    await writeFile(join(directory, 'index.cjs'), `let shared;
      module.exports = { apply(plugin) {
        ${options.hook ? `plugin.hooks.before('sessions.remove', async () => { await shared.callTool('fake_echo', { text: 'forbidden' }); return { action: 'continue' } }, { key: 'readonly' });` : ''}
        plugin.agents.register({ id: 'test.process/agent', name: 'Hosted MCP SDK', configSchema: {}, capabilities: { text: true, persistentSession: true, modes: ['scoped'] },
        create: async (_input, runtime) => { const connection = ${options.shared ? 'shared ||' : ''} await runtime.mcp.connect({ type: 'stdio', command: ${JSON.stringify(process.execPath)}, args: [require('node:path').join(__dirname, 'cli.cjs')], cwd: __dirname }); shared = connection; return {
          run: async input => { let resolve, reject; const result = new Promise((yes, no) => { resolve = yes; reject = no });
            return { result, cancel: async () => { await connection.dispose(); resolve({ status: 'cancelled' }) }, events: (async function* () {
              try { await connection.listTools(); const pid = Number((await connection.callTool('fake_pid', {})).content);
                require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(pid));
                ${options.crash ? 'process.exit(17);' : ''}
                const reply = await connection.callTool('fake_echo', { text: input.content[0].text });
                const image = await connection.callTool('fake_image', {});
                yield { type: 'message.delta', producerSequence: 1, messageId: 'answer', text: JSON.stringify({ text: reply.content, pid, image: image.contentParts.find(part => part.type === 'image') }) };
                resolve({ status: 'completed' });
              } catch (error) { reject(error); throw error }
            })() };
          }, dispose: async () => { try { await connection.dispose() } catch (error) { ${options.shared ? "if (error.code !== 'FORBIDDEN') throw error" : 'throw error'} } }
        } } }); } }`)
  }
  await host.install(directory)
  const state = { pluginId: manifest.id, profileId: 'one', ownerId: 'installer', enabled: true, config: {}, grants: capabilities }
  await host.configure(state, 0)
  const instance = (caller = scope) => coordinator.createInstance(caller, { agentTypeId: 'test.process/agent', config: {}, mode: 'scoped' })
  const run = async (id: string, key: string, caller = scope, text = key) => {
    const run = coordinator.start(caller, id, { content: [{ type: 'text', text }] }, key)
    await coordinator.wait(run.id)
    return coordinator.get(caller, run.id)
  }
  return { host, coordinator, store, hooks, context, logger, instance, run, state, pidPath }
}

it('keeps a managed subprocess across turns and closes it with the runtime lease', async () => {
  const f = await setup(), instance = f.instance()
  const first = await f.run(instance.id, '中文 first'), second = await f.run(instance.id, 'second')
  expect(first.status).toBe('completed'); expect(second.status).toBe('completed')
  const output = (id: string) => JSON.parse((f.coordinator.output(scope, id, -1)[0] as { text: string }).text)
  expect(output(first.id)).toEqual({ pid: output(second.id).pid, text: '中文 first' })
  const pid = output(first.id).pid
  expect(alive(pid)).toBe(true)
  await f.coordinator.close(); expect(alive(pid)).toBe(false)
})

it('rejects process creation without a declared capability', async () => {
  const f = await setup({ granted: false })
  expect(await f.run(f.instance().id, 'denied')).toMatchObject({ status: 'failed', errorCode: 'FORBIDDEN' })
  await expect(readFile(f.pidPath)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('closes host-owned children when their plugin worker crashes', async () => {
  const f = await setup({ crash: true })
  expect(await f.run(f.instance().id, 'crash')).toMatchObject({ status: 'interrupted' })
  const pid = Number(await readFile(f.pidPath, 'utf8'))
  await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 2000 })
})

it('revokes existing process handles and reaps the child on a later operation', async () => {
  const f = await setup(), instance = f.instance()
  expect((await f.run(instance.id, 'first')).status).toBe('completed')
  const pid = Number(await readFile(f.pidPath, 'utf8'))
  f.store.saveProfile({ ...f.state, grants: ['agents.register'] }, 1)
  expect(await f.run(instance.id, 'revoked')).toMatchObject({ status: 'failed', errorCode: 'FORBIDDEN' })
  await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 2000 })
})

it('cannot reuse another owner runtime process through a shared plugin closure', async () => {
  const f = await setup({ shared: true }), first = f.instance()
  expect((await f.run(first.id, 'first')).status).toBe('completed')
  const other: ExecutionScope = { ...scope, principal: { kind: 'user', id: 'other' } }, second = f.instance(other)
  expect(await f.run(second.id, 'second', other)).toMatchObject({ status: 'failed', errorCode: 'FORBIDDEN' })
  expect((await f.run(first.id, 'still-owned')).status).toBe('completed')
})

it('does not let a read-only hook mutate an existing runtime process', async () => {
  const f = await setup({ hook: true })
  expect((await f.run(f.instance().id, 'start')).status).toBe('completed')
  await expect(f.hooks.run('sessions.remove', { sessionId: 'session' }, f.context(scope, new AbortController().signal))).rejects.toMatchObject({ code: 'FORBIDDEN' })
  await vi.waitFor(() => expect(f.logger.info.mock.calls.some(call => JSON.stringify(call).includes('hook-process') && JSON.stringify(call).includes('FORBIDDEN'))).toBe(true))
})

it('runs the independent ACP driver in a real plugin worker through bounded SDK process RPC', async () => {
  const f = await setup({ acp: true }), text = '中文😀 & "$HOME" '.repeat(12_000), instance = f.instance()
  const run = f.coordinator.start(scope, instance.id, { content: [{ type: 'text', text }] }, 'acp')
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(scope, run.id).status).toBe('completed')
  expect(f.coordinator.output(scope, run.id, -1)).toEqual([expect.objectContaining({ type: 'message.delta', text })])
})

it('runs the official MCP client in a real plugin worker and confirms child exit through process RPC', async () => {
  const f = await setup({ mcp: true }), text = '中文😀 & "$HOME" '.repeat(8_000), instance = f.instance()
  const run = f.coordinator.start(scope, instance.id, { content: [{ type: 'text', text }] }, 'mcp')
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(scope, run.id).status).toBe('completed')
  const output = f.coordinator.output(scope, run.id, -1)[0] as { text: string }
  const result = JSON.parse(output.text)
  expect(result.text).toBe(`mcp:${text}`)
  expect(alive(result.pid)).toBe(false)
})


it('runs hosted MCP tools in a real worker across turns and waits for child exit on lease disposal', async () => {
  const f = await setup({ mcpSdk: true }), instance = f.instance(), text = '中文😀'.repeat(1000)
  const first = await f.run(instance.id, 'hosted-first', scope, text), second = await f.run(instance.id, 'second')
  expect(first.status).toBe('completed'); expect(second.status).toBe('completed')
  const output = (id: string) => JSON.parse((f.coordinator.output(scope, id, -1)[0] as { text: string }).text)
  expect(output(first.id)).toMatchObject({ text: `mcp:${text}`, pid: output(second.id).pid, image: { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' } })
  const pid = output(first.id).pid; expect(alive(pid)).toBe(true)
  await f.coordinator.close(); expect(alive(pid)).toBe(false)
})

it('denies MCP connections without a declared grant', async () => {
  const f = await setup({ mcpSdk: true, granted: false })
  expect(await f.run(f.instance().id, 'denied')).toMatchObject({ status: 'failed', errorCode: 'FORBIDDEN' })
})

it('reaps hosted MCP children when a plugin worker crashes', async () => {
  const f = await setup({ mcpSdk: true, crash: true })
  expect(await f.run(f.instance().id, 'crash')).toMatchObject({ status: 'interrupted' })
  const pid = Number(await readFile(f.pidPath, 'utf8'))
  await vi.waitFor(() => expect(alive(pid)).toBe(false))
})

it('prevents another owner or a read-only hook from using a cached MCP connection', async () => {
  const f = await setup({ mcpSdk: true, shared: true, hook: true }), first = f.instance()
  expect((await f.run(first.id, 'first')).status).toBe('completed')
  const other: ExecutionScope = { ...scope, principal: { kind: 'user', id: 'other' } }
  expect(await f.run(f.instance(other).id, 'foreign', other)).toMatchObject({ status: 'failed', errorCode: 'FORBIDDEN' })
  await expect(f.hooks.run('sessions.remove', { sessionId: 'session' }, f.context(scope, new AbortController().signal))).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect((await f.run(first.id, 'still-owned')).status).toBe('completed')
})

it('reclaims hosted MCP connections when the plugin grant is revoked while idle', async () => {
  const f = await setup({ mcpSdk: true }), instance = f.instance()
  expect((await f.run(instance.id, 'first')).status).toBe('completed')
  const pid = Number(await readFile(f.pidPath, 'utf8'))
  f.store.saveProfile({ ...f.state, grants: ['agents.register'] }, 1)
  await vi.waitFor(() => expect(alive(pid)).toBe(false))
  expect(await f.run(instance.id, 'revoked')).toMatchObject({ status: 'failed', errorCode: 'FORBIDDEN' })
})
