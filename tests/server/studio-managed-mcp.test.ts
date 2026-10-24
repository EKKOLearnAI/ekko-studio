import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Client, parseJSONRPCMessage, type JSONRPCMessage } from '@modelcontextprotocol/client'
import { ManagedJsonRpcTransport, type ManagedProcessPort } from '../../packages/studio-agent-drivers/src'
import { ManagedProcessScope } from '../../packages/server/src/modules/studio/services/processes/managed'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

it('connects the official MCP client through a managed process with large Unicode input and images', async () => {
  const scope = new ManagedProcessScope(new AbortController().signal, () => {})
  cleanups.push(() => scope.close())
  const process = await scope.api.spawn({ command: globalThis.process.execPath, args: [join(globalThis.process.cwd(), 'tests/fixtures/fake-mcp-server.cjs')], cwd: globalThis.process.cwd() })
  const transport = new ManagedJsonRpcTransport(process, parseJSONRPCMessage)
  cleanups.push(() => transport.close())
  const client = new Client({ name: 'managed-test', version: '1' })
  await client.connect(transport)
  const tools = await client.listTools()
  expect(tools.tools.map(tool => tool.name)).toContain('fake_echo')
  const text = '中文😀\n"$HOME" %PATH% '.repeat(8000)
  const response = await client.callTool({ name: 'fake_echo', arguments: { text } })
  expect(response.content).toEqual([{ type: 'text', text: `mcp:${text}` }])
  expect((await client.callTool({ name: 'fake_image' })).content).toContainEqual({ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' })
  const result = await client.callTool({ name: 'fake_pid' })
  const pid = Number((result.content as Array<{ text: string }>)[0].text)
  expect(() => globalThis.process.kill(pid, 0)).not.toThrow()
  await client.close()
  expect(() => globalThis.process.kill(pid, 0)).toThrow()
})

function fake(options: { maxMessageBytes?: number } = {}) {
  let release!: (value: Awaited<ReturnType<ManagedProcessPort['read']>>) => void
  const port: ManagedProcessPort = { read: vi.fn(() => new Promise(resolve => { release = resolve })), write: vi.fn(async () => {}), end: vi.fn(async () => {}), dispose: vi.fn(async () => {}) }
  const transport = new ManagedJsonRpcTransport(port, parseJSONRPCMessage, options)
  cleanups.push(() => transport.close())
  return { port, transport, release: (value: Awaited<ReturnType<ManagedProcessPort['read']>>) => release(value) }
}
const stdout = (data: Uint8Array) => ({ chunks: [{ stream: 'stdout' as const, data }], truncated: false, exit: null })

it('reassembles split UTF-8 frames and keeps stderr outside JSON parsing', async () => {
  const f = fake(), message = vi.fn(), stderr = vi.fn()
  f.transport.onmessage = message; f.transport.onstderr = stderr
  await f.transport.start()
  const bytes = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { text: '😀中文' } }) + '\n')
  const split = bytes.indexOf(Buffer.from('😀')) + 1
  f.release(stdout(bytes.subarray(0, split)))
  await vi.waitFor(() => expect(f.port.read).toHaveBeenCalledTimes(2))
  f.release({ chunks: [{ stream: 'stderr', data: Buffer.from('not JSON') }, ...stdout(bytes.subarray(split)).chunks], truncated: false, exit: null })
  await vi.waitFor(() => expect(message).toHaveBeenCalledOnce())
  expect(message.mock.calls[0][0]).toEqual({ jsonrpc: '2.0', id: 1, result: { text: '😀中文' } })
  expect(stderr.mock.calls[0][0].toString()).toBe('not JSON')
})

it('resolves send only after serialized 64 KiB writes have drained', async () => {
  const f = fake(), writes: Buffer[] = []
  let release!: () => void, settled = false
  f.port.write = vi.fn(async bytes => { writes.push(Buffer.from(bytes)); if (writes.length === 1) await new Promise<void>(resolve => { release = resolve }) })
  await f.transport.start()
  const first: JSONRPCMessage = { jsonrpc: '2.0', id: 1, result: { text: '中文'.repeat(60000) } }
  const sent = f.transport.send(first).then(() => { settled = true })
  const second = f.transport.send({ jsonrpc: '2.0', id: 2, result: {} })
  await vi.waitFor(() => expect(writes).toHaveLength(1))
  expect(settled).toBe(false)
  release(); await Promise.all([sent, second])
  expect(writes.every(bytes => bytes.length <= 65_536)).toBe(true)
  expect(Buffer.concat(writes).toString().trim().split('\n').map(line => JSON.parse(line))).toEqual([first, { jsonrpc: '2.0', id: 2, result: {} }])
})

it.each(['malformed', 'utf8', 'truncated', 'incomplete', 'oversized'] as const)('fails closed for %s protocol output without including private output in errors', async kind => {
  const f = fake({ maxMessageBytes: 128 }), error = vi.fn(), closed = vi.fn()
  f.transport.onerror = error; f.transport.onclose = closed
  await f.transport.start()
  if (kind === 'truncated') f.release({ chunks: [], truncated: true, exit: null })
  else if (kind === 'utf8') f.release(stdout(Buffer.from([0xff, 10])))
  else if (kind === 'oversized') f.release(stdout(Buffer.alloc(129, 65)))
  else if (kind === 'malformed') f.release(stdout(Buffer.from('private-output\n')))
  else {
    f.release(stdout(Buffer.from('{"private":')))
    await vi.waitFor(() => expect(f.port.read).toHaveBeenCalledTimes(2))
    f.release({ chunks: [], truncated: false, exit: { code: 0, signal: null } })
  }
  await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce())
  expect(error).toHaveBeenCalledOnce()
  expect(String(error.mock.calls[0][0])).not.toContain('private')
  expect(f.port.dispose).toHaveBeenCalledOnce()
})

it('keeps the close barrier even when client notification callbacks throw', async () => {
  const f = fake()
  let release!: () => void, ended = false
  f.port.dispose = vi.fn(() => new Promise<void>(resolve => { release = resolve }))
  f.transport.onerror = () => { throw new Error('bad observer') }
  f.transport.onclose = () => { throw new Error('bad observer') }
  await f.transport.start(); f.release(stdout(Buffer.from('bad\n')))
  await vi.waitFor(() => expect(f.port.dispose).toHaveBeenCalledOnce())
  const closing = f.transport.close().then(() => { ended = true })
  expect(ended).toBe(false)
  release(); await closing
  expect(ended).toBe(true)
  await expect(f.transport.start()).rejects.toThrow('restarted')
})

it('rejects writes after a provider write failure', async () => {
  const f = fake(), failed = vi.fn()
  f.transport.onerror = failed
  f.port.write = vi.fn(async () => { throw new Error('pipe failed') })
  await f.transport.start()
  await expect(f.transport.send({ jsonrpc: '2.0', id: 1, result: {} })).rejects.toThrow('pipe failed')
  expect(failed).toHaveBeenCalledOnce(); expect(f.port.dispose).toHaveBeenCalledOnce()
  await expect(f.transport.send({ jsonrpc: '2.0', id: 2, result: {} })).rejects.toThrow('not open')
})

it('retains an unconfirmed disposal error across repeated close requests', async () => {
  const f = fake()
  cleanups.pop() // This fake's permanent cleanup failure is asserted explicitly below.
  f.port.dispose = vi.fn(async () => { throw new Error('exit unconfirmed') })
  await f.transport.start()
  await expect(f.transport.close()).rejects.toThrow('exit unconfirmed')
  await expect(f.transport.close()).rejects.toThrow('exit unconfirmed')
  expect(f.port.dispose).toHaveBeenCalledOnce()
})

it('rejects oversized outbound frames before writing and bounds concurrent sends', async () => {
  const f = fake({ maxMessageBytes: 128 })
  await f.transport.start()
  await expect(f.transport.send({ jsonrpc: '2.0', id: 1, result: { text: 'x'.repeat(129) } })).rejects.toThrow('message limit')
  expect(f.port.write).not.toHaveBeenCalled()
  let release!: () => void
  f.port.write = vi.fn(() => new Promise<void>(resolve => { release = resolve }))
  const pending = Array.from({ length: 128 }, (_, id) => f.transport.send({ jsonrpc: '2.0', id, result: {} }))
  const settled = Promise.allSettled(pending)
  await expect(f.transport.send({ jsonrpc: '2.0', id: 129, result: {} })).rejects.toThrow('queue is full')
  await f.transport.close(); release()
  expect((await settled).filter(value => value.status === 'rejected').length).toBeGreaterThan(0)
})

it('uses the public Ekko MCP provider with managed transports and an awaited scope barrier', async () => {
  const { createMcpToolProvider } = await import('../../packages/ekko-agent/src/tools/mcp')
  const lifecycle = new AbortController(), scope = new ManagedProcessScope(lifecycle.signal, () => {})
  cleanups.push(() => scope.close())
  const provider = createMcpToolProvider({ createTransport: async server => {
    if (server.type !== 'stdio') throw new Error('Expected stdio')
    return new ManagedJsonRpcTransport(await scope.api.spawn({ command: server.command, args: server.args, env: server.env, cwd: process.cwd() }), parseJSONRPCMessage)
  } })
  cleanups.push(() => provider.dispose())
  const context = { mcpSessionSignal: lifecycle.signal, mcpServers: { fixture: { command: process.execPath,
    args: [join(process.cwd(), 'tests/fixtures/fake-mcp-server.cjs')] } } }
  const tools = await provider.listTools(context)
  const pid = Number((await tools.find(tool => tool.definition.name === 'fake_pid')!.execute({}, context)).content)
  expect(() => process.kill(pid, 0)).not.toThrow()
  lifecycle.abort(); await provider.closeScope(lifecycle.signal)
  expect(() => process.kill(pid, 0)).toThrow()
})
