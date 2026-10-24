import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { ManagedMcpScope, parseMcpConnect } from '../../packages/server/src/modules/studio/services/mcp/managed'
import type { McpConnectInput } from '../../packages/studio-plugin-sdk/src'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
const command: McpConnectInput = { type: 'stdio', command: process.execPath, args: [join(process.cwd(), 'tests/fixtures/fake-mcp-server.cjs')], cwd: process.cwd() }
function scope(authorize = () => {}) {
  const controller = new AbortController(), service = new ManagedMcpScope(controller.signal, authorize)
  cleanups.push(() => service.close())
  return { controller, service }
}

it('discovers managed CLI tools, preserves Unicode and images, and confirms exit before disposal resolves', async () => {
  const { service } = scope(), connection = await service.api.connect(command)
  expect((await connection.listTools()).map(tool => tool.name)).toContain('fake_echo')
  expect(await connection.callTool('fake_echo', { text: '中文😀' })).toMatchObject({ ok: true, content: 'mcp:中文😀' })
  expect((await connection.callTool('fake_image', {})).contentParts).toContainEqual({ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' })
  const pid = Number((await connection.callTool('fake_pid', {})).content)
  expect(() => process.kill(pid, 0)).not.toThrow()
  await connection.dispose(); await connection.dispose()
  expect(() => process.kill(pid, 0)).toThrow()
  await expect(connection.listTools()).rejects.toMatchObject({ code: 'CANCELLED' })
})

it('closes live connections after permission revocation even without another plugin call', async () => {
  let allowed = true
  const { service } = scope(() => { if (!allowed) throw new Error('revoked') })
  const connection = await service.api.connect(command), pid = Number((await connection.callTool('fake_pid', {})).content)
  allowed = false
  await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow())
  await expect(connection.listTools()).rejects.toMatchObject({ code: 'CANCELLED' })
})

it('cancels an MCP handshake and does not leave its managed child running', async () => {
  const { controller, service } = scope()
  const opening = service.api.connect({ ...command, args: ['-e', 'setInterval(() => {}, 1000)'] })
  const rejected = expect(opening).rejects.toThrow()
  controller.abort(); await Promise.all([rejected, service.close()])
})

it('bounds tool input and rejects unsupported calls and connection fields', async () => {
  const { service } = scope(), connection = await service.api.connect(command)
  await expect(connection.callTool('not_discovered', {})).rejects.toMatchObject({ code: 'NOT_FOUND' })
  expect(() => connection.callTool('fake_echo', { text: 'a'.repeat(131_072) })).toThrow('JSON size limit')
  for (const input of [{ ...command, ownerId: 'other' }, { ...command, env: null }, { ...command, timeoutMs: 1 },
    { type: 'streamable_http', url: 'file:///tmp/private' }, { type: 'streamable_http', url: 'https://user:secret@example.test/' },
    { type: 'streamable_http', url: 'https://example.test/', headers: { x: 'invalid\r\nheader' } }]) {
    expect(() => parseMcpConnect(input)).toThrow()
  }
})

async function httpFixture() {
  const calls: string[] = [], methods: string[] = [], keys: Array<string | undefined> = []
  let mode: 'normal' | 'large' | 'largeResult' | 'redirect' | 'hold' = 'normal'
  let release!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  const server = createServer(async (request, response) => {
    keys.push(request.headers['x-secret'] as string | undefined)
    methods.push(String(request.method))
    if (request.method === 'DELETE') { response.end(); return }
    if (request.method !== 'POST') { response.statusCode = 405; response.end(); return }
    let text = ''; for await (const chunk of request) text += chunk
    const message = JSON.parse(text); calls.push(message.method)
    if (!('id' in message)) { response.statusCode = 202; response.end(); return }
    if (message.method === 'tools/call' && mode === 'hold') await hold
    if (message.method === 'tools/call' && mode === 'redirect') { response.statusCode = 307; response.setHeader('location', '/stolen'); response.end(); return }
    const result = message.method === 'initialize' ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'http', version: '1' } }
      : message.method === 'tools/list' ? { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }
        : { content: [{ type: 'text', text: mode === 'large' ? 'x'.repeat(1_100_000) : mode === 'largeResult' ? 'x'.repeat(300_000) : 'http:ok' }] }
    if (message.method === 'initialize') response.setHeader('mcp-session-id', 'owned-http-session')
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()) }))
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`, calls, keys, methods, release, setMode: (value: typeof mode) => { mode = value } }
}

it('uses explicit HTTP credentials and rejects large responses and redirects without tool replay', async () => {
  const fixture = await httpFixture(), { service } = scope()
  const connection = await service.api.connect({ type: 'streamable_http', url: fixture.url, headers: { 'x-secret': 'owned' } })
  expect(await connection.callTool('echo', {})).toMatchObject({ ok: true, content: 'http:ok' })
  expect(fixture.keys.every(key => key === 'owned')).toBe(true)
  fixture.setMode('largeResult')
  await expect(connection.callTool('echo', {})).rejects.toMatchObject({ code: 'RESOURCE_EXHAUSTED' })
  fixture.setMode('large')
  await expect(connection.callTool('echo', {})).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
  fixture.setMode('redirect')
  await expect(connection.callTool('echo', {})).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
  expect(fixture.calls.filter(call => call === 'tools/call')).toHaveLength(4)
  await connection.dispose()
  expect(fixture.methods.filter(method => method === 'DELETE')).toHaveLength(1)
})


it('enforces connection capacity and releases a slot only after disposal', async () => {
  const fixture = await httpFixture(), { service } = scope(), handles = []
  for (let index = 0; index < 16; index++) handles.push(await service.api.connect({ type: 'streamable_http', url: fixture.url }))
  await expect(service.api.connect({ type: 'streamable_http', url: fixture.url })).rejects.toMatchObject({ code: 'RESOURCE_EXHAUSTED' })
  await handles[0].dispose()
  const replacement = await service.api.connect({ type: 'streamable_http', url: fixture.url })
  expect((await replacement.callTool('echo', {})).ok).toBe(true)
})

it('bounds concurrent calls and settles an in-flight request before reporting closure', async () => {
  const fixture = await httpFixture(), { service } = scope()
  const connection = await service.api.connect({ type: 'streamable_http', url: fixture.url })
  fixture.setMode('hold')
  const pending = connection.callTool('echo', {}), rejected = expect(pending).rejects.toThrow()
  await vi.waitFor(() => expect(fixture.calls).toContain('tools/call'))
  await expect(connection.callTool('echo', {})).rejects.toMatchObject({ code: 'RESOURCE_EXHAUSTED' })
  await connection.dispose(); await rejected; fixture.release()
})
