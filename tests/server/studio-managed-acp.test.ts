import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { AcpConnection, ManagedProcessTransport, type ManagedProcessPort } from '../../packages/studio-agent-drivers/src'
import { ManagedProcessScope } from '../../packages/server/src/modules/studio/services/processes/managed'

let root: string
const cleanups: Array<() => Promise<void>> = []
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'studio-acp-中文 ')) })
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
afterAll(async () => { await rm(root, { recursive: true, force: true }) })
const server = `const readline = require('node:readline').createInterface({ input: process.stdin });
const reply = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
readline.on('line', line => { const request = JSON.parse(line); if (!request.method) return;
  if (request.method === 'initialize') reply({ id: request.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } } } });
  else if (request.method === 'session/new' || request.method === 'session/load') {
    if (request.method === 'session/load') reply({ method: 'session/update', params: { sessionId: 'native', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old history' } } } });
    reply({ method: 'session/update', params: { sessionId: 'foreign', update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'foreign', description: 'Other session' }] } } });
    reply({ method: 'session/update', params: { sessionId: 'native', update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'inspect', description: 'Native inspect' }] } } });
    reply({ id: request.id, result: { sessionId: 'native', configOptions: [{ id: 'model', category: 'model' }, { id: 'effort', category: 'thought_level' }] } });
  } else if (request.method === 'session/set_config_option') reply({ id: request.id, result: {} });
  else if (request.method === 'session/prompt') {
    process.stderr.write('diagnostic');
    const text = JSON.stringify(request.params.prompt);
    const bytes = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'native', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } }) + '\\n');
    for (let offset = 0; offset < bytes.length; offset += 173) process.stdout.write(bytes.subarray(offset, offset + 173));
    reply({ id: request.id, result: { stopReason: 'end_turn' } });
  }
});`

it('runs ACP negotiation, restoration, model selection and large image/text input through a real SDK process handle', async () => {
  const controller = new AbortController(), scope = new ManagedProcessScope(controller.signal, () => {})
  cleanups.push(() => scope.close())
  const handle = await scope.api.spawn({ command: process.execPath, args: ['-e', server], cwd: root })
  const transport = new ManagedProcessTransport(handle)
  cleanups.push(() => transport.dispose())
  const update = vi.fn(), session = vi.fn(), stderr: Buffer[] = []
  transport.stderr.on('data', chunk => stderr.push(chunk))
  const connection = new AcpConnection(transport, { update, session })
  const text = '中文😀\n"$HOME" & %PATH% '.repeat(6000), path = join(root, '图片 space.png'), image = Buffer.alloc(131_079, 129)
  await writeFile(path, image)
  await expect(connection.prompt({ cwd: root, text, images: [{ path, mediaType: 'image/png' }], nativeSessionId: 'native', mcpServers: [], model: 'native/model', reasoningEffort: 'high' })).resolves.toBe('end_turn')
  expect(session).toHaveBeenCalledExactlyOnceWith('native')
  expect(update).toHaveBeenCalledTimes(2)
  expect(update.mock.calls[0][0]).toEqual({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'inspect', description: 'Native inspect' }] })
  const prompt = JSON.parse(update.mock.calls[1][0].content.text)
  expect(prompt[0]).toEqual({ type: 'text', text })
  expect(Buffer.from(prompt[1].data, 'base64').equals(image)).toBe(true)
  expect(await transport.exited).toEqual({ code: 0, signal: null })
  expect(Buffer.concat(stderr).toString()).toBe('diagnostic')
})

function fakePort() {
  let release!: (result: Awaited<ReturnType<ManagedProcessPort['read']>>) => void
  const port: ManagedProcessPort = { read: vi.fn(() => new Promise(resolve => { release = resolve })), write: vi.fn(async () => {}), end: vi.fn(async () => {}), dispose: vi.fn(async () => {}) }
  const transport = new ManagedProcessTransport(port)
  cleanups.push(() => transport.dispose())
  return { port, transport, release: (result: Awaited<ReturnType<ManagedProcessPort['read']>>) => release(result) }
}

it('serializes 64 KiB write chunks and closes stdin only after all queued bytes drain', async () => {
  const { port, transport } = fakePort(), writes: Buffer[] = []
  let release!: () => void
  port.write = vi.fn(async data => { writes.push(Buffer.from(data)); if (writes.length === 1) await new Promise<void>(resolve => { release = resolve }) })
  const text = '中文😀'.repeat(30000)
  transport.stdin.write(text); transport.stdin.write('tail'); transport.stdin.end()
  await vi.waitFor(() => expect(writes.length).toBe(1))
  expect(port.end).not.toHaveBeenCalled()
  release(); await vi.waitFor(() => expect(port.end).toHaveBeenCalledTimes(1))
  expect(writes.every(bytes => bytes.length <= 65_536)).toBe(true)
  expect(Buffer.concat(writes).toString()).toBe(text + 'tail')
  expect(() => transport.stdin.write('late')).toThrow('closed')
})

it('bounds queued write bytes instead of retaining unlimited pending RPC payloads', async () => {
  const { port, transport } = fakePort()
  port.write = vi.fn(() => new Promise(() => {}))
  transport.stdin.write('x'.repeat(16 * 1024 * 1024))
  expect(() => transport.stdin.write('overflow')).toThrow('queue is full')
  await transport.dispose()
  await expect(transport.exited).rejects.toThrow('disposed')
})

it.each(['truncated', 'exit', 'write-error'] as const)('rejects a pending ACP request on transport %s', async kind => {
  const { port, transport, release } = fakePort()
  if (kind === 'write-error') port.write = async () => { throw new Error('write failed') }
  const connection = new AcpConnection(transport, { update() {}, session() {} })
  const pending = connection.prompt({ cwd: root, text: 'hello', mcpServers: [] })
  const rejected = expect(pending).rejects.toThrow(kind === 'truncated' ? 'truncated' : kind === 'exit' ? 'closed' : 'write failed')
  await Promise.resolve()
  if (kind !== 'write-error') release({ chunks: [], truncated: kind === 'truncated', exit: kind === 'exit' ? { code: 7, signal: null } : null })
  await rejected
  await transport.dispose()
  expect(port.dispose).toHaveBeenCalledTimes(1)
})

it('still disposes a naturally exited process when a close observer throws', async () => {
  const { port, transport, release } = fakePort()
  transport.on('close', () => { throw new Error('observer failed') })
  await vi.waitFor(() => expect(port.read).toHaveBeenCalledOnce())
  release({ chunks: [], truncated: false, exit: { code: 0, signal: null } })
  await expect(transport.exited).resolves.toEqual({ code: 0, signal: null })
  await vi.waitFor(() => expect(port.dispose).toHaveBeenCalledOnce())
})

it('does not leave an unhandled write rejection when an error observer throws', async () => {
  const { port, transport } = fakePort(), notified = vi.fn()
  transport.on('error', () => { throw new Error('observer failed') })
  transport.stdin.on('error', notified)
  port.write = async () => { throw new Error('pipe failed') }
  transport.stdin.write('request')
  await expect(transport.exited).rejects.toThrow('pipe failed')
  await vi.waitFor(() => expect(port.dispose).toHaveBeenCalledOnce())
  expect(notified).toHaveBeenCalledOnce()
})
