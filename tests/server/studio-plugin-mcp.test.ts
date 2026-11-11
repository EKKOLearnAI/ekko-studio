import { it, expect, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { PluginManager } from '../../packages/server/src/modules/studio/services/plugins/manager'
// @ts-expect-error Node MCP executable shares this JavaScript adapter.
import { createPluginTools, pluginToolName } from '../../bin/plugins.mjs'
it('uses readable, stable names while disambiguating separators, escaped characters and long identifiers', () => {
  expect(pluginToolName('tool-demo', 'hello')).toBe('tool-demo__hello')
  expect(pluginToolName('notebook', 'append')).toBe('notebook__append')
  const names = [
    ['a__b', 'c'], ['a', 'b__c'], ['a.b', 'c'], ['a_db', 'c'],
    ['p'.repeat(79) + 'a', 't'.repeat(80)], ['p'.repeat(79) + 'b', 't'.repeat(80)],
  ].map(([plugin, tool]) => pluginToolName(plugin, tool))
  expect(new Set(names).size).toBe(names.length)
  for (const name of names) { expect(name.length).toBeLessThanOrEqual(64); expect(name).toMatch(/^[a-zA-Z0-9_-]+$/) }
  expect(names[4]).toBe(pluginToolName('p'.repeat(79) + 'a', 't'.repeat(80)))
  expect(names[4]).toMatch(/^p+__t+__/)
})
it('discovers global plugin tools and refuses stale tools after a plugin is disabled', async () => {
  let enabled = true
  const request = vi.fn(async (path, options) => path.endsWith('/invoke') ? { result: { ok: true, content: 'saved' } } : { plugins: [{ status: enabled ? 'active' : 'disabled', manifest: { id: 'notes', name: 'Notes' }, tools: [{ name: 'save', description: 'Save a note', inputSchema: { type: 'object' } }] }] })
  const adapter = createPluginTools(request), [tool] = await adapter.list()
  expect(tool.name).toBe('notes__save')
  expect(tool.name.length).toBeLessThan(64)
  expect(tool.annotations).toEqual({ readOnlyHint: false, destructiveHint: true })
  expect(await adapter.call(tool.name, { text: 'hi' })).toEqual({ isError: false, content: [{ type: 'text', text: 'saved' }] })
  expect(request).toHaveBeenLastCalledWith('/api/studio/plugins/notes/invoke', { method: 'POST', signal: undefined, body: { kind: 'tool', name: 'save', input: { text: 'hi' } } })
  enabled = false; expect(await adapter.list()).toEqual([])
  await expect(adapter.call(tool.name, {})).rejects.toThrow(/no longer/)
})
it('publishes the shipped greeting tool schema and executes it with the actual caller identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-tool-demo-'))
  const manager = new PluginManager(dir, { authorize() {}, log() {}, emit() {}, api: async () => null })
  const owner = { userId: 1, profile: 'default' }, caller = { userId: 2, profile: 'demo-profile', sessionId: 'demo-session' }
  try {
    await manager.install(owner, resolve('examples/plugins/tool-demo'), 0)
    await manager.update(owner, 'tool-demo', 1, { enabled: true })
    const adapter = createPluginTools(async (path: string, options: any) => {
      if (path === '/api/studio/plugins') return manager.snapshot()
      expect(path).toBe('/api/studio/plugins/tool-demo/invoke')
      return { result: await manager.runtime(caller, 'tool-demo').invoke(options.body.kind, options.body.name, options.body.input, caller) }
    })
    const [tool] = await adapter.list()
    expect(tool.name).toBe('tool-demo__hello')
    expect(tool.description).toContain('[工具注入演示/hello]')
    expect(tool.inputSchema).toMatchObject({ required: ['name'], properties: { name: { type: 'string' } } })
    expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false })
    const result = await adapter.call(tool.name, { name: 'Ekko' })
    expect(result.isError).toBe(false)
    expect(result.content[0].text).toContain('你好，Ekko！')
    expect(result.content[0].text).toContain('demo-profile')
    await expect(adapter.call(tool.name, {})).rejects.toThrow(/name/)
    expect((await adapter.call(tool.name, { name: '  ' })).isError).toBe(true)
  } finally { await manager.close(); await rm(dir, { recursive: true, force: true }) }
})
it('serves plugins exclusively from the dedicated MCP toolset over the real stdio transport', async () => {
  const clients: Client[] = [], requests: string[] = []
  let enabled = true
  const http = createServer(async (req, res) => {
    requests.push(req.url!)
    expect(req.headers['x-hermes-profile']).toBe('caller-profile')
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/api/studio/plugins') res.end(JSON.stringify({ plugins: enabled ? [{ status: 'active', manifest: { id: 'demo', name: 'Demo' }, tools: [{ name: 'hello', description: 'Greet the caller', readOnly: true, inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } }] }] : [] }))
    else {
      expect(req.url).toBe('/api/studio/plugins/demo/invoke')
      expect(body).toEqual({ kind: 'tool', name: 'hello', input: { name: 'Ekko' } })
      res.end(JSON.stringify({ result: { ok: true, content: 'Hello Ekko' } }))
    }
  })
  http.listen(0, '127.0.0.1'); await once(http, 'listening')
  async function connect(toolset: string) {
    const client = new Client({ name: 'plugin-toolset-test', version: '1.0.0' })
    clients.push(client)
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('bin/ekko-studio-mcp.mjs'), toolset], env: {
      PATH: process.env.PATH || '', HERMES_WEB_UI_URL: `http://127.0.0.1:${(http.address() as any).port}`,
      HERMES_WEB_UI_PROFILE: 'caller-profile', HERMES_WEB_UI_TOKEN: 'test-only',
    } }))
    return client
  }
  try {
    const api = await connect('api'), plugins = await connect('plugins')
    expect((await api.listTools()).tools.map(tool => tool.name)).toEqual(['ekko_studio_api_openapi_get', 'ekko_studio_api_request'])
    expect(requests).toEqual([])
    expect((await api.callTool({ name: 'demo__hello', arguments: {} })).isError).toBe(true)
    expect((await api.callTool({ name: 'studio_plugin_old_hash', arguments: {} })).isError).toBe(true)
    expect(requests).toEqual([])
    const listed = (await plugins.listTools()).tools
    expect(listed.map(tool => tool.name)).toEqual(['demo__hello'])
    expect(listed[0].inputSchema).toMatchObject({ required: ['name'] })
    expect(await plugins.callTool({ name: 'demo__hello', arguments: { name: 'Ekko' } })).toMatchObject({ isError: false, content: [{ type: 'text', text: 'Hello Ekko' }] })
    expect((await plugins.callTool({ name: 'ekko_studio_api_request', arguments: {} })).isError).toBe(true)
    enabled = false
    expect((await plugins.listTools(undefined, { cacheMode: 'refresh' })).tools).toEqual([])
    expect((await plugins.callTool({ name: 'demo__hello', arguments: { name: 'Ekko' } })).isError).toBe(true)
  } finally {
    await Promise.allSettled(clients.map(client => client.close()))
    http.closeAllConnections(); await new Promise<void>(done => http.close(() => done()))
  }
})
