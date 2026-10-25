import { afterEach, expect, it, vi } from 'vitest'
import type { JSONRPCMessage } from '@modelcontextprotocol/client'
import { createMcpToolProvider, type McpClientTransport, type McpToolProvider, type McpToolProviderOptions } from '../../packages/ekko-agent/src/tools/mcp'

const providers: McpToolProvider[] = []
afterEach(async () => { await Promise.all(providers.splice(0).map(provider => provider.dispose())) })
function gate() { let resolve!: () => void; return { promise: new Promise<void>(done => { resolve = done }), release: () => resolve() } }
function transport() {
  const io: McpClientTransport = {
    start: vi.fn(async () => {}),
    send: vi.fn(async (message: JSONRPCMessage) => {
      if (!('method' in message) || !('id' in message)) return
      const result = message.method === 'initialize'
        ? { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } }
        : message.method === 'tools/list'
          ? { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }
          : { content: [{ type: 'text', text: 'ok' }] }
      queueMicrotask(() => io.onmessage?.({ jsonrpc: '2.0', id: message.id, result }))
    }),
    close: vi.fn(async () => { io.onclose?.() }),
  }
  return io
}
function provider(factory: NonNullable<Parameters<typeof createMcpToolProvider>[0]>['createTransport']) {
  const instance = createMcpToolProvider({ createTransport: factory }); providers.push(instance); return instance
}
const config = { command: 'owned-by-host', env: { ONLY_EXPLICIT: 'value' } }

it('isolates scope calls and passes only configured environment to custom transports', async () => {
  const factory = vi.fn<NonNullable<McpToolProviderOptions['createTransport']>>(async () => transport()), p = provider(factory)
  const a = new AbortController(), b = new AbortController()
  const contextA = { mcpSessionSignal: a.signal, mcpServers: { fixture: config } }
  const contextB = { ...contextA, mcpSessionSignal: b.signal }
  const [first, second] = await Promise.all([p.listTools(contextA), p.listTools(contextB)])
  expect(factory).toHaveBeenCalledTimes(2)
  expect((factory.mock.calls[0][0] as { env: Record<string, string> }).env).toEqual({ ONLY_EXPLICIT: 'value' })
  expect((await first[0].execute({}, contextB)).ok).toBe(false)
  expect((await first[0].execute({})).ok).toBe(false)
  expect((await first[0].execute({}, contextA)).ok).toBe(true)
  await p.closeScope(a.signal)
  expect((await first[0].execute({}, contextA)).ok).toBe(false)
  expect((await second[0].execute({}, contextB)).ok).toBe(true)
})

it('serializes discovery and waits for the old transport before replacing a configuration', async () => {
  const hold = gate(), old = transport(), next = transport()
  old.close = vi.fn(async () => { await hold.promise; old.onclose?.() })
  const factory = vi.fn().mockResolvedValueOnce(old).mockResolvedValue(next), p = provider(factory)
  const context = { mcpServers: { fixture: config } }
  await Promise.all([p.listTools(context), p.listTools(context)])
  expect(factory).toHaveBeenCalledOnce()
  const changed = p.listTools({ mcpServers: { fixture: { ...config, args: ['new'] } } })
  await vi.waitFor(() => expect(old.close).toHaveBeenCalledOnce())
  expect(factory).toHaveBeenCalledOnce()
  hold.release(); await changed
  expect(factory).toHaveBeenCalledTimes(2)
})

it('waits for a late transport after abort without starting its protocol', async () => {
  const acquiring = gate(), closing = gate(), io = transport(), scope = new AbortController()
  io.close = vi.fn(async () => { await closing.promise; io.onclose?.() })
  const factory = vi.fn(async () => { await acquiring.promise; return io }), p = provider(factory)
  const discovery = p.listTools({ mcpSessionSignal: scope.signal, mcpServers: { fixture: config } })
  const rejected = expect(discovery).rejects.toThrow()
  await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce())
  scope.abort(); let ended = false
  const done = p.closeScope(scope.signal).then(() => { ended = true })
  expect(ended).toBe(false); acquiring.release()
  await vi.waitFor(() => expect(io.close).toHaveBeenCalledOnce())
  expect(io.start).not.toHaveBeenCalled(); expect(ended).toBe(false)
  closing.release(); await Promise.all([done, rejected])
  await expect(p.listTools({ mcpSessionSignal: scope.signal })).rejects.toThrow()
})

it('cancels a handshake already in progress and waits for its close acknowledgement', async () => {
  const io = transport(), hold = gate(), p = provider(async () => io)
  io.send = vi.fn(async () => {})
  io.close = vi.fn(async () => { await hold.promise; io.onclose?.() })
  const pending = p.listTools({ mcpServers: { fixture: config } })
  const rejected = expect(pending).rejects.toThrow()
  await vi.waitFor(() => expect(io.send).toHaveBeenCalled())
  const closing = p.dispose()
  await vi.waitFor(() => expect(io.close).toHaveBeenCalledOnce())
  hold.release(); await Promise.all([closing, rejected])
  expect(io.close).toHaveBeenCalledOnce()
})

it('retains cleanup failure and refuses to replace a possibly live connection', async () => {
  const io = transport(), factory = vi.fn(async () => io), p = provider(factory)
  io.close = vi.fn(async () => { io.onclose?.(); throw new Error('exit unconfirmed') })
  await p.listTools({ mcpServers: { fixture: config } })
  await expect(p.listTools({ mcpServers: { fixture: { ...config, args: ['new'] } } })).rejects.toThrow('exit unconfirmed')
  expect(factory).toHaveBeenCalledOnce()
  await expect(p.dispose()).rejects.toThrow('MCP provider cleanup failed')
  await expect(p.dispose()).rejects.toThrow('MCP provider cleanup failed')
  expect(io.close).toHaveBeenCalledOnce()
  providers.pop() // This intentional failure must remain observable.
})

it('cleans a failed initialization before allowing a later discovery retry', async () => {
  const io = transport(), factory = vi.fn().mockResolvedValueOnce(io).mockResolvedValue(transport()), p = provider(factory)
  io.start = vi.fn(async () => { throw new Error('start failed') })
  expect(await p.listTools({ mcpServers: { fixture: config } })).toEqual([])
  expect(io.close).toHaveBeenCalledOnce()
  expect(await p.listTools({ mcpServers: { fixture: config } })).toHaveLength(1)
  expect(factory).toHaveBeenCalledTimes(2)
})

it('waits for every scope even when another transport fails to close', async () => {
  const first = transport(), second = transport(), hold = gate()
  first.close = vi.fn(async () => { first.onclose?.(); throw new Error('failed') })
  second.close = vi.fn(async () => { await hold.promise; second.onclose?.() })
  const p = provider(vi.fn().mockResolvedValueOnce(first).mockResolvedValue(second))
  await p.listTools({ mcpSessionSignal: new AbortController().signal, mcpServers: { fixture: config } })
  await p.listTools({ mcpSessionSignal: new AbortController().signal, mcpServers: { fixture: config } })
  let finished = false
  const closing = p.dispose().finally(() => { finished = true })
  const rejected = expect(closing).rejects.toThrow('MCP provider cleanup failed')
  await vi.waitFor(() => expect(second.close).toHaveBeenCalledOnce())
  expect(finished).toBe(false); hold.release(); await rejected
  providers.pop()
})

it('supports strict discovery without reporting a failed handshake as an empty server', async () => {
  const io = transport()
  io.start = vi.fn(async () => { throw new Error('start failed') })
  const p = createMcpToolProvider({ failOnConnectionError: true, createTransport: async () => io })
  providers.push(p)
  await expect(p.listTools({ mcpServers: { fixture: config } })).rejects.toThrow('start failed')
  expect(io.close).toHaveBeenCalledOnce()
})
