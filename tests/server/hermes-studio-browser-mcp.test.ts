import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
      env: { ...process.env, HERMES_WEB_UI_HOME: root, HERMES_WEB_UI_URL: 'http://127.0.0.1:1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const rpc = rpcClient(child)

    const initialized = await rpc(1, 'initialize', { protocolVersion: '2024-11-05' })
    expect(initialized.result.serverInfo.toolset).toBe('browser')
    expect((await rpc(2, 'tools/list')).result.tools.map((tool: any) => tool.name)).toEqual(['ekko_studio_browser_toolset'])

    const unavailable = await rpc(3, 'tools/call', {
      name: 'ekko_studio_browser_toolset',
      arguments: {
        action: 'call',
        tool: 'ekko_studio_browser_tabs',
        arguments: { action: 'list' },
      },
    })
    expect(unavailable.result.isError).toBe(true)
    expect(unavailable.result.content[0].text).toBeTruthy()
    expect(child.exitCode).toBeNull()
  })

  it('exposes one compact category tool and preserves browser MCP image results', async () => {
    root = await mkdtemp(join(tmpdir(), 'hermes-browser-mcp-'))
    const clients: string[] = []
    const registeredPids: number[] = []
    let failScreenshot = false
    let failBatch = false
    const batches: unknown[] = []
    const snapshots: unknown[] = []
    const assessments: Array<{ path: string; body: any; profile: string }> = []
    let settingsRequests = 0
    let assessmentEnabled = true
    let holdAssessment = false
    let assessmentCancelled = false
    const browserSnapshot = { tabId: 'tab-1', snapshotId: 'snapshot-1', title: 'Example', text: '@e1 button name="Example"', nodes: [{ ref: '@e1', role: 'button', name: 'Example' }] }
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      response.setHeader('Content-Type', 'application/json')
      if (request.url?.startsWith('/api/studio/jev/') && (request.headers.authorization !== 'Bearer studio_run_fixture'
        || request.headers['x-studio-run-context'] !== 'browser-run')) {
        response.statusCode = 401
        response.end(JSON.stringify({ error: 'Run credential required' }))
        return
      }
      if (request.url === '/api/studio/jev/settings') {
        settingsRequests++
        response.end(JSON.stringify({ browserMatchEnabled: assessmentEnabled, browserVerifyEnabled: assessmentEnabled,
          hasApiKey: true, browserMatchTimeoutMs: 100, browserVerifyTimeoutMs: 100 }))
        return
      }
      if (request.url?.startsWith('/api/studio/jev/browser/')) {
        assessments.push({ path: request.url, body, profile: String(request.headers['x-hermes-profile']) })
        if (holdAssessment) { response.on('close', () => { assessmentCancelled = true }); return }
        response.end(JSON.stringify({ tabId: body.snapshot.tabId, snapshotId: body.snapshot.snapshotId,
          ...(request.url.endsWith('/match') ? { status: 'matched', ref: '@e1', confidence: 0.95 } : { status: 'met', confidence: 0.95 }) }))
        return
      }
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
          snapshot: { ...browserSnapshot, snapshotId: 'after-batch' },
        } }))
        return
      }
      if (body.method === 'screenshot' && failScreenshot) {
        response.statusCode = 400
        response.end(JSON.stringify({ error: 'capture failed' }))
        return
      }
      if (body.method === 'snapshot') snapshots.push(body.params)
      const result = body.method === 'screenshot'
        ? { tabId: 'tab-1', url: 'https://example.com/', title: 'Example', mediaType: 'image/png', data: 'AA==', width: 1, height: 1 }
        : body.method === 'snapshot'
          ? browserSnapshot
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

    const credentialFile = join(root, 'auth.json')
    await writeFile(credentialFile, JSON.stringify({ token: 'studio_run_fixture', context_id: 'browser-run', profile: 'research' }))
    child = spawn(process.execPath, [join(process.cwd(), 'bin/ekko-studio-mcp.mjs'), 'browser'], {
      env: { ...process.env, HERMES_WEB_UI_HOME: root, HERMES_WEB_UI_URL: `http://127.0.0.1:${address.port}`, HERMES_WEB_UI_PROFILE: 'research',
        AUTH_TOKEN: 'old-static-token', HERMES_WEB_UI_TOKEN: 'old-profile-token', HERMES_WEB_UI_RUN_TOKEN_FILE: credentialFile },
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
      operation_count: 13,
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
    const beforeInvalid = clients.length
    for (const [id, tool, args, field] of [
      [40, 'ekko_studio_browser_batch', { actions: [{ action: 'press', key: 'Tab' }] }, 'arguments.tab_id'],
      [41, 'ekko_studio_browser_batch', { ...batchArguments, actions: [{ type: 'click', ref: '@e1' }] }, 'arguments.actions[0].action'],
      [42, 'ekko_studio_browser_interact', { tab_id: 'tab-1' }, 'arguments.action'],
      [43, 'ekko_studio_browser_interact', { tab_id: 'tab-1', action: 'click', ref: '@e1' }, 'arguments.snapshot_id'],
    ] as const) {
      const invalid = await rpc(id, 'tools/call', { name: 'ekko_studio_browser_toolset', arguments: { action: 'call', tool, arguments: args } })
      expect(invalid.result.isError).toBe(true)
      expect(invalid.result.content[0].text).toContain(field)
    }
    expect(clients).toHaveLength(beforeInvalid)
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

    const invoke = async (id: number, tool: string, args: Record<string, unknown>) => {
      const output = await rpc(id, 'tools/call', { name: 'ekko_studio_browser_toolset', arguments: { action: 'call', tool, arguments: args } })
      expect(output.result.isError).not.toBe(true)
      return JSON.parse(output.result.content[0].text).result
    }
    expect((await invoke(20, 'ekko_studio_browser_snapshot', { tab_id: 'tab-1', target: 'Example' })).elementMatch).toMatchObject({ status: 'matched', ref: '@e1' })
    const compact = await invoke(44, 'ekko_studio_browser_snapshot', { tab_id: 'tab-1' })
    expect(compact.nodes).toEqual(browserSnapshot.nodes)
    expect(compact).not.toHaveProperty('text')
    expect((await invoke(45, 'ekko_studio_browser_snapshot', { tab_id: 'tab-1', include_text: true })).text).toBe(browserSnapshot.text)
    expect((await invoke(21, 'ekko_studio_browser_interact', { tab_id: 'tab-1', action: 'press', key: 'Tab', expectation: 'Example is visible' })).verification.status).toBe('met')
    failBatch = false
    expect((await invoke(22, 'ekko_studio_browser_batch', { ...batchArguments, expectation: 'Example is visible' })).verification.status).toBe('met')
    expect(assessments.map(item => item.path)).toEqual(['/api/studio/jev/browser/match', '/api/studio/jev/browser/verify', '/api/studio/jev/browser/verify'])
    expect(assessments.every(item => item.profile === 'research')).toBe(true)
    expect(assessments[2].body.snapshot.snapshotId).toBe('after-batch')
    // Optional JEV arguments never enter the deterministic Broker batch parser.
    expect(batches.at(-1)).toEqual(batchArguments)
    assessmentEnabled = false
    expect((await invoke(23, 'ekko_studio_browser_snapshot', { tab_id: 'tab-1', target: 'Example' })).elementMatch.reason).toBe('disabled')
    expect(assessments).toHaveLength(3)

    const settingsBeforeLocalSearch = settingsRequests
    const localSearch = { tab_id: 'tab-1', selector: '#form-demo-layout', query: 'Field', interactive_only: true, limit: 30 }
    await invoke(46, 'ekko_studio_browser_snapshot', localSearch)
    expect(snapshots.at(-1)).toEqual(localSearch)
    await invoke(47, 'ekko_studio_browser_snapshot', { tab_id: 'tab-1', snapshot_id: 'snapshot-1', offset: 30, limit: 30 })
    expect(settingsRequests).toBe(settingsBeforeLocalSearch)
    expect(snapshots.at(-1)).toEqual({ tab_id: 'tab-1', snapshot_id: 'snapshot-1', offset: 30, limit: 30 })
    expect(assessments).toHaveLength(3)
    for (const [id, args] of [[48, { limit: 1.5 }], [49, { snapshot_id: 'snapshot-1', query: 'Field' }]] as const) {
      const invalid = await rpc(id, 'tools/call', { name: 'ekko_studio_browser_toolset', arguments: {
        action: 'call', tool: 'ekko_studio_browser_snapshot', arguments: { tab_id: 'tab-1', ...args },
      } })
      expect(invalid.result.isError).toBe(true)
    }

    assessmentEnabled = true
    holdAssessment = true
    const cancelled = rpc(24, 'tools/call', { name: 'ekko_studio_browser_toolset', arguments: {
      action: 'call', tool: 'ekko_studio_browser_snapshot', arguments: { tab_id: 'tab-1', target: 'Example' },
    } })
    await vi.waitFor(() => expect(assessments).toHaveLength(4))
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 24 } })}\n`)
    expect((await cancelled).result.isError).toBe(true)
    await vi.waitFor(() => expect(assessmentCancelled).toBe(true))

    await rm(join(brokerRoot, 'broker.json'))
    const unavailable = await rpc(9, 'tools/list')
    expect(unavailable.result.tools.map((tool: any) => tool.name)).toEqual(['ekko_studio_browser_toolset'])
  })
})

describe('remote Desktop browser transport', () => {
  it('uses authenticated Studio relay without a local descriptor or PID', async () => {
    root = await mkdtemp(join(tmpdir(), 'studio-remote-browser-'))
    const received: Array<{ path?: string; auth?: string; profile?: string; body: any }> = []
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      received.push({ path: req.url, auth: req.headers.authorization, profile: req.headers['x-hermes-profile'] as string, body: JSON.parse(Buffer.concat(chunks).toString()) })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ operation_id: 'remote-op', result: { tabs: [{ id: 'desktop-tab', title: 'Local desktop' }] } }))
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    child = spawn(process.execPath, [join(process.cwd(), 'bin/ekko-studio-mcp.mjs'), 'browser'], {
      env: { ...process.env, HERMES_WEB_UI_HOME: root, HERMES_WEB_UI_URL: `http://127.0.0.1:${address.port}`, HERMES_WEB_UI_TOKEN: 'account-fixture', HERMES_WEB_UI_PROFILE: 'research' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const rpc = rpcClient(child)
    expect((await rpc(1, 'tools/list')).result.tools).toHaveLength(1)
    const result = await rpc(2, 'tools/call', { name: 'ekko_studio_browser_toolset', arguments: { action: 'call', tool: 'ekko_studio_browser_tabs', arguments: { action: 'list' } } })
    expect(result.result.isError).not.toBe(true)
    expect(JSON.parse(result.result.content[0].text).result.tabs[0].id).toBe('desktop-tab')
    expect(received).toEqual([{ path: '/api/studio/desktop-browser/request', auth: 'Bearer account-fixture', profile: 'research', body: { method: 'tabs.list', params: {}, client_id: expect.any(String) } }])
  })
})

describe('browser file transfer tools', () => {
  async function startRelay(handle: (method: string, params: any) => unknown) {
    root = await mkdtemp(join(tmpdir(), 'studio-browser-files-'))
    const calls: Array<{ method: string; params: any }> = []
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString())
      calls.push({ method: body.method, params: body.params })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ operation_id: 'op', result: handle(body.method, body.params) }))
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    child = spawn(process.execPath, [join(process.cwd(), 'bin/ekko-studio-mcp.mjs'), 'browser'], {
      env: { ...process.env, HERMES_WEB_UI_HOME: root, HERMES_WEB_UI_URL: `http://127.0.0.1:${address.port}`, HERMES_WEB_UI_TOKEN: 'account-fixture' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const rpc = rpcClient(child)
    let id = 0
    const call = async (tool: string, args: Record<string, unknown>) => (await rpc(++id, 'tools/call', {
      name: 'ekko_studio_browser_toolset', arguments: { action: 'call', tool, arguments: args },
    })).result
    return { calls, call }
  }

  it('reads local files into the upload request and validates arguments first', async () => {
    const { calls, call } = await startRelay(() => ({ tabId: 'tab-1', upload: { method: 'input', files: [{ name: 'a.png', type: 'image/png', size: 3 }] } }))
    const file = join(root, 'a.png')
    await writeFile(file, Buffer.from([1, 2, 3]))
    const result = await call('ekko_studio_browser_upload', { tab_id: 'tab-1', snapshot_id: 's1', ref: '@e2', files: [{ path: file }] })
    expect(result.isError).not.toBe(true)
    expect(JSON.parse(result.content[0].text).result.upload.method).toBe('input')
    expect(calls).toEqual([{ method: 'upload', params: { tab_id: 'tab-1', snapshot_id: 's1', ref: '@e2',
      files: [{ name: 'a.png', type: 'image/png', data: Buffer.from([1, 2, 3]).toString('base64') }] } }])

    expect((await call('ekko_studio_browser_upload', { tab_id: 'tab-1', snapshot_id: 's1', ref: '@e2', files: [{ name: 'x.txt' }] })).isError).toBe(true)
    expect((await call('ekko_studio_browser_upload', { tab_id: 'tab-1', snapshot_id: 's1', ref: '@e2', files: [] })).isError).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('assembles chunked downloads into a saved file or inline image', async () => {
    const bytes = Buffer.from('hello world')
    let mimeType = 'application/zip'
    const { calls, call } = await startRelay((method, params) => method === 'download.start'
      ? { downloadId: 'd1', fileName: 'a.zip', mimeType, size: bytes.length, sourceUrl: 'https://example.com/a.zip', chunkSize: 6 }
      : params.offset === 0
        ? { downloadId: 'd1', offset: 0, data: bytes.subarray(0, 6).toString('base64'), returnedBytes: 6, size: bytes.length, done: false, nextOffset: 6 }
        : { downloadId: 'd1', offset: 6, data: bytes.subarray(6).toString('base64'), returnedBytes: 5, size: bytes.length, done: true })

    const metadataOnly = await call('ekko_studio_browser_download', { tab_id: 'tab-1', url: 'https://example.com/a.zip' })
    expect(JSON.parse(metadataOnly.content[0].text)).toMatchObject({ downloadId: 'd1', hint: expect.stringContaining('save_path') })

    const target = join(root, 'out.zip')
    const saved = await call('ekko_studio_browser_download', { tab_id: 'tab-1', url: 'https://example.com/a.zip', save_path: target })
    expect(JSON.parse(saved.content[0].text)).toMatchObject({ savedTo: target, size: bytes.length })
    expect(await readFile(target, 'utf8')).toBe('hello world')
    expect((await call('ekko_studio_browser_download', { tab_id: 'tab-1', url: 'https://example.com/a.zip', save_path: target })).isError).toBe(true)

    mimeType = 'image/png'
    const image = await call('ekko_studio_browser_download', { tab_id: 'tab-1', snapshot_id: 's1', ref: '@e3' })
    expect(image.content[1]).toEqual({ type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' })
    expect(calls.filter(item => item.method === 'download.read').map(item => item.params.offset)).toEqual([0, 6, 0, 6, 0, 6])
    expect((await call('ekko_studio_browser_download', { tab_id: 'tab-1', ref: '@e3' })).isError).toBe(true)
  })

  it('forwards wait conditions', async () => {
    const { calls, call } = await startRelay(() => ({ tabId: 'tab-1', matched: true, elapsedMs: 10, url: 'https://example.com/' }))
    expect(JSON.parse((await call('ekko_studio_browser_wait', { tab_id: 'tab-1', text: 'Done', timeout_ms: 5000 })).content[0].text).result.matched).toBe(true)
    expect((await call('ekko_studio_browser_wait', { tab_id: 'tab-1' })).isError).toBe(true)
    expect(calls).toEqual([{ method: 'wait', params: { tab_id: 'tab-1', text: 'Done', timeout_ms: 5000 } }])
  })
})

describe('browser dialog, network and pointer arguments', () => {
  it('forwards dialog, network and new interact actions after validating them', async () => {
    root = await mkdtemp(join(tmpdir(), 'studio-browser-pointer-'))
    const calls: Array<{ method: string; params: any }> = []
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString())
      calls.push({ method: body.method, params: body.params })
      res.setHeader('content-type', 'application/json')
      const result = body.method === 'dialog' && body.params.action === 'status' ? { dialog: null }
        : body.method === 'network.read' ? { total: 1, entries: [{ url: 'https://example.com/api', status: 500 }] }
          : { id: 'tab-1', observation: { status: 'observed' } }
      res.end(JSON.stringify({ operation_id: 'op', result }))
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    child = spawn(process.execPath, [join(process.cwd(), 'bin/ekko-studio-mcp.mjs'), 'browser'], {
      env: { ...process.env, HERMES_WEB_UI_HOME: root, HERMES_WEB_UI_URL: `http://127.0.0.1:${address.port}`, HERMES_WEB_UI_TOKEN: 'account-fixture' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const rpc = rpcClient(child)
    let id = 0
    const call = async (tool: string, args: Record<string, unknown>) => (await rpc(++id, 'tools/call', {
      name: 'ekko_studio_browser_toolset', arguments: { action: 'call', tool, arguments: args },
    })).result

    expect(JSON.parse((await call('ekko_studio_browser_dialog', { tab_id: 'tab-1', action: 'status' })).content[0].text).result.dialog).toBeNull()
    expect((await call('ekko_studio_browser_dialog', { tab_id: 'tab-1', action: 'accept', prompt_text: 'ok' })).isError).not.toBe(true)
    expect((await call('ekko_studio_browser_dialog', { tab_id: 'tab-1', action: 'close' })).isError).toBe(true)
    expect(JSON.parse((await call('ekko_studio_browser_network', { tab_id: 'tab-1', action: 'read', only_failed: true })).content[0].text).result.total).toBe(1)
    await call('ekko_studio_browser_network', { tab_id: 'tab-1', action: 'clear', filter: 'ignored' })

    await call('ekko_studio_browser_interact', { tab_id: 'tab-1', action: 'drag', snapshot_id: 's1', ref: '@e1', target_ref: '@e2' })
    await call('ekko_studio_browser_interact', { tab_id: 'tab-1', action: 'click_at', x: 10, y: 20, click_count: 2 })
    await call('ekko_studio_browser_batch', { tab_id: 'tab-1', snapshot_id: 's1', actions: [{ action: 'right_click', ref: '@e1' }, { action: 'drag_at', x: 1, y: 2, to_x: 3, to_y: 4 }] })
    await call('ekko_studio_browser_upload', { tab_id: 'tab-1', files: [{ name: 'a.txt', data_base64: 'YQ==' }] })

    for (const [tool, args] of [
      ['ekko_studio_browser_interact', { tab_id: 'tab-1', action: 'drag', snapshot_id: 's1', ref: '@e1' }],
      ['ekko_studio_browser_interact', { tab_id: 'tab-1', action: 'double_click', ref: '@e1' }],
      ['ekko_studio_browser_interact', { tab_id: 'tab-1', action: 'click_at', x: 10 }],
      ['ekko_studio_browser_interact', { tab_id: 'tab-1', action: 'drag_at', x: 1, y: 1, to_x: 2 }],
      ['ekko_studio_browser_batch', { tab_id: 'tab-1', actions: [{ action: 'click_at', x: 1, y: 1, button: 'back' }] }],
      ['ekko_studio_browser_upload', { tab_id: 'tab-1', ref: '@e1', files: [{ name: 'a.txt', data_base64: 'YQ==' }] }],
    ] as const) expect((await call(tool, args)).isError).toBe(true)

    expect(calls).toEqual([
      { method: 'dialog', params: { tab_id: 'tab-1', action: 'status' } },
      { method: 'dialog', params: { tab_id: 'tab-1', action: 'accept', prompt_text: 'ok' } },
      { method: 'network.read', params: { tab_id: 'tab-1', only_failed: true } },
      { method: 'network.clear', params: { tab_id: 'tab-1' } },
      { method: 'interact', params: { tab_id: 'tab-1', action: { action: 'drag', ref: '@e1', snapshot_id: 's1', target_ref: '@e2' } } },
      { method: 'interact', params: { tab_id: 'tab-1', action: { action: 'click_at', x: 10, y: 20, click_count: 2 } } },
      { method: 'interact.batch', params: { tab_id: 'tab-1', snapshot_id: 's1', actions: [{ action: 'right_click', ref: '@e1' }, { action: 'drag_at', x: 1, y: 2, to_x: 3, to_y: 4 }] } },
      { method: 'upload', params: { tab_id: 'tab-1', files: [{ name: 'a.txt', type: 'text/plain', data: 'YQ==' }] } },
    ])
  })
})
