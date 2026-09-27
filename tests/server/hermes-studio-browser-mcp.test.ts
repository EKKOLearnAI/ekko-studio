import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

let child: ChildProcessWithoutNullStreams | null = null
let server: Server | null = null
let root = ''

afterEach(async () => {
  child?.kill()
  child = null
  await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve())
  server = null
  if (root) await rm(root, { recursive: true, force: true })
  root = ''
})

function rpcClient(process: ChildProcessWithoutNullStreams) {
  let buffer = ''
  const responses = new Map<number, any>()
  const waiters = new Map<number, (value: any) => void>()
  process.stdout.on('data', chunk => {
    buffer += String(chunk)
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) {
        const response = JSON.parse(line)
        const waiter = waiters.get(response.id)
        if (waiter) { waiters.delete(response.id); waiter(response) } else responses.set(response.id, response)
      }
      newline = buffer.indexOf('\n')
    }
  })
  return async (id: number, method: string, params: Record<string, unknown> = {}) => {
    process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    const existing = responses.get(id)
    if (existing) { responses.delete(id); return existing }
    return await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`RPC ${id} timed out`)), 5000)
      waiters.set(id, value => { clearTimeout(timer); resolve(value) })
    })
  }
}

describe('hermes-studio browser MCP toolset', () => {
  it('stays healthy and returns bounded unavailable results without a Desktop Browser Broker', async () => {
    root = await mkdtemp(join(tmpdir(), 'hermes-browser-mcp-no-broker-'))
    child = spawn(process.execPath, [join(process.cwd(), 'bin/ekko-studio-mcp.mjs'), 'browser'], {
      env: { ...process.env, HERMES_WEB_UI_HOME: root },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const rpc = rpcClient(child)

    const initialized = await rpc(1, 'initialize', { protocolVersion: '2024-11-05' })
    expect(initialized.result.serverInfo.toolset).toBe('browser')
    expect((await rpc(2, 'tools/list')).result.tools).toEqual([])

    const unavailable = await rpc(3, 'tools/call', {
      name: 'ekko_studio_browser_toolset',
      arguments: {
        action: 'call',
        tool: 'ekko_studio_browser_tabs',
        arguments: { action: 'list' },
      },
    })
    expect(unavailable.result.isError).toBe(true)
    expect(unavailable.result.content[0].text).toContain('Desktop Browser is not running')
    expect(child.exitCode).toBeNull()
  })

  it('exposes one compact category tool and preserves browser MCP image results', async () => {
    root = await mkdtemp(join(tmpdir(), 'hermes-browser-mcp-'))
    const clients: string[] = []
    const registeredPids: number[] = []
    let failScreenshot = false
    let failBatch = false
    const batches: unknown[] = []
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      response.setHeader('Content-Type', 'application/json')
      if (request.url === '/v1/session') {
        registeredPids.push(body.client_pid)
        response.end(JSON.stringify({ client_id: 'broker-client-1', session_token: 'session-token' }))
        return
      }
      clients.push(String(request.headers['x-hermes-browser-client'] || ''))
      if (body.method === 'interact.batch') {
        batches.push(body.params)
        response.end(JSON.stringify({ operation_id: body.operation_id, result: {
          tabId: body.params.tab_id, completed: failBatch ? 1 : body.params.actions.length, total: body.params.actions.length,
          results: body.params.actions.map((action: { action: string }, index: number) => ({
            index, action: action.action, status: failBatch && index === 1 ? 'failed' : 'completed',
          })),
          snapshot: { snapshotId: 'after-batch' },
        } }))
        return
      }
      if (body.method === 'screenshot' && failScreenshot) {
        response.statusCode = 400
        response.end(JSON.stringify({ error: 'capture failed' }))
        return
      }
      const result = body.method === 'screenshot'
        ? { tabId: 'tab-1', url: 'https://example.com/', title: 'Example', mediaType: 'image/png', data: 'AA==', width: 1, height: 1 }
        : body.method === 'snapshot'
          ? { tabId: 'tab-1', snapshotId: 'snapshot-1', text: '@e1 button name="Example"' }
          : body.method === 'text.read'
            ? { tabId: 'tab-1', snapshotId: 'snapshot-1', ref: '@e1', text: 'Complete text', totalLength: 13, returnedLength: 13, hasMore: false }
        : { tabs: [{ id: 'tab-1' }] }
      response.end(JSON.stringify({ operation_id: body.operation_id, result }))
    })
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject)
      server!.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test broker did not bind')
    const brokerRoot = join(root, 'desktop-browser')
    await mkdir(brokerRoot, { recursive: true, mode: 0o700 })
    await writeFile(join(brokerRoot, 'broker.json'), JSON.stringify({
      schema: 1, desktopPid: process.pid, endpoint: `http://127.0.0.1:${address.port}/v1`, token: 'test-token', instanceId: 'test', createdAt: new Date().toISOString(),
    }), { mode: 0o600 })

    child = spawn(process.execPath, [join(process.cwd(), 'bin/ekko-studio-mcp.mjs'), 'browser'], {
      env: { ...process.env, HERMES_WEB_UI_HOME: root },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const rpc = rpcClient(child)
    const initialized = await rpc(1, 'initialize', { protocolVersion: '2024-11-05' })
    const listed = await rpc(2, 'tools/list')
    expect(initialized.result.instructions).toContain('tab list/create/activate/close/release')
    expect(listed.result.tools).toHaveLength(1)
    expect(listed.result.tools[0].name).toBe('ekko_studio_browser_toolset')
    expect(listed.result.tools[0].description).toContain('screenshots')

    const catalog = await rpc(3, 'tools/call', {
      name: 'ekko_studio_browser_toolset',
      arguments: { action: 'list' },
    })
    expect(JSON.parse(catalog.result.content[0].text)).toMatchObject({
      toolset: 'browser',
      operation_count: 8,
    })
    const described = await rpc(4, 'tools/call', {
      name: 'ekko_studio_browser_toolset',
      arguments: { action: 'describe', tool: 'ekko_studio_browser_screenshot' },
    })
    expect(JSON.parse(described.result.content[0].text).inputSchema.required).toContain('tab_id')

    await rpc(5, 'tools/call', {
      name: 'ekko_studio_browser_toolset',
      arguments: { action: 'call', tool: 'ekko_studio_browser_tabs', arguments: { action: 'list' } },
    })
    const screenshot = await rpc(6, 'tools/call', {
      name: 'ekko_studio_browser_toolset',
      arguments: { action: 'call', tool: 'ekko_studio_browser_screenshot', arguments: { tab_id: 'tab-1' } },
    })
    expect(screenshot.result.content[1]).toEqual({ type: 'image', data: 'AA==', mimeType: 'image/png' })
    const readText = await rpc(7, 'tools/call', {
      name: 'ekko_studio_browser_toolset',
      arguments: {
        action: 'call',
        tool: 'ekko_studio_browser_read_text',
        arguments: { tab_id: 'tab-1', snapshot_id: 'snapshot-1', ref: '@e1', offset: 0, limit: 4000 },
      },
    })
    expect(JSON.parse(readText.result.content[0].text)).toMatchObject({
      result: {
        snapshotId: 'snapshot-1',
        ref: '@e1',
        text: 'Complete text',
        hasMore: false,
      },
    })
    expect(clients).toHaveLength(3)
    expect(clients[0]).toBeTruthy()
    expect(clients[0]).toBe(clients[1])
    expect(clients[1]).toBe(clients[2])
    expect(registeredPids).toEqual([child.pid])

    failScreenshot = true
    const fallback = await rpc(8, 'tools/call', {
      name: 'ekko_studio_browser_toolset',
      arguments: { action: 'call', tool: 'ekko_studio_browser_screenshot', arguments: { tab_id: 'tab-1' } },
    })
    expect(fallback.result.content[0].text).toContain('Accessibility snapshot')
    expect(fallback.result.content[0].text).toContain('snapshot-1')

    const batchSchema = await rpc(10, 'tools/call', {
      name: 'ekko_studio_browser_toolset',
      arguments: { action: 'describe', tool: 'ekko_studio_browser_batch' },
    })
    expect(JSON.parse(batchSchema.result.content[0].text).inputSchema).toMatchObject({
      required: ['tab_id', 'actions'], properties: { actions: { minItems: 1, maxItems: 50 } },
    })
    const batchArguments = { tab_id: 'tab-1', snapshot_id: 'snapshot-1', actions: [{ action: 'click', ref: '@e1' }, { action: 'press', key: 'Tab' }] }
    const invokeBatch = (id: number) => rpc(id, 'tools/call', {
      name: 'ekko_studio_browser_toolset', arguments: { action: 'call', tool: 'ekko_studio_browser_batch', arguments: batchArguments },
    })
    const completedBatch = await invokeBatch(11)
    expect(completedBatch.result.isError).not.toBe(true)
    expect(JSON.parse(completedBatch.result.content[0].text).result).toMatchObject({ completed: 2, total: 2, snapshot: { snapshotId: 'after-batch' } })
    expect(batches).toEqual([batchArguments])
    failBatch = true
    const stoppedBatch = await invokeBatch(12)
    expect(stoppedBatch.result.isError).toBe(true)
    expect(JSON.parse(stoppedBatch.result.content[0].text).result).toMatchObject({ completed: 1, total: 2 })

    await rm(join(brokerRoot, 'broker.json'))
    const unavailable = await rpc(9, 'tools/list')
    expect(unavailable.result.tools).toEqual([])
  })
})
