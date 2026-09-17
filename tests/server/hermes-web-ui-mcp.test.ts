import { createServer } from 'http'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import pkg from '../../package.json'

function writeRpc(child: ChildProcessWithoutNullStreams, id: number, method: string, params?: unknown) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
}

function waitForRpc(responses: Map<number, any>, id: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (responses.has(id)) {
        clearInterval(timer)
        resolve(responses.get(id))
        return
      }
      if (Date.now() - started > 5000) {
        clearInterval(timer)
        reject(new Error(`Timed out waiting for MCP response ${id}`))
      }
    }, 10)
  })
}

function expectProviderSafeToolNames(serverName: string, tools: Array<{ name: string }>) {
  const safeServerName = serverName.replace(/[^A-Za-z0-9_]/g, '_')
  const overlongNames = tools
    .map(tool => `mcp__${safeServerName}__${tool.name}`)
    .filter(name => name.length > 64)
  expect(overlongNames).toEqual([])
}

describe('hermes-web-ui MCP server', () => {
  let child: ChildProcessWithoutNullStreams | null = null
  const homes: string[] = []

  afterEach(() => {
    child?.kill()
    child = null
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  it('exposes a public Web UI API requester tool', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hermes-web-ui-mcp-'))
    homes.push(home)
    mkdirSync(join(home, 'profiles', 'research'), { recursive: true })
    writeFileSync(join(home, 'profiles', 'research', '.model-run-token'), 'profile-token\n')
    let chatRunHits = 0

    const server = createServer((req, res) => {
      if (req.url === '/api/openapi.json') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({
          openapi: '3.0.3',
          tags: [
            { name: 'Chat Run', description: 'Chat run operations' },
            { name: 'Testing', description: 'Test helper operations' },
          ],
          paths: {
            '/api/test-public-requester': {
              post: {
                tags: ['Testing'],
                requestBody: {
                  required: false,
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                      },
                    },
                  },
                },
              },
            },
            '/api/studio/chat-run/runs': {
              post: {
                tags: ['Chat Run'],
                requestBody: {
                  required: true,
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        required: ['input'],
                        properties: {
                          input: { type: 'string' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          authorization: req.headers.authorization || '',
          profile: req.headers['x-hermes-profile'] || '',
        }))
        return
      }
      if (req.url?.startsWith('/api/test-public-requester')) {
        let raw = ''
        req.on('data', chunk => { raw += chunk })
        req.on('end', () => {
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({
            method: req.method,
            url: req.url,
            body: raw ? JSON.parse(raw) : null,
            profile: req.headers['x-hermes-profile'],
            authorization: req.headers.authorization,
          }))
        })
        return
      }
      if (req.url === '/api/studio/chat-run/runs') {
        chatRunHits += 1
        let raw = ''
        req.on('data', chunk => { raw += chunk })
        req.on('end', () => {
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({
            ok: true,
            body: raw ? JSON.parse(raw) : null,
          }))
        })
        return
      }
      res.statusCode = 404
      res.end('{}')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('expected TCP server address')

    const responses = new Map<number, any>()
    child = spawn(process.execPath, ['bin/ekko-studio-mcp.mjs'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HERMES_WEB_UI_URL: `http://127.0.0.1:${address.port}`,
        HERMES_WEB_UI_HOME: home,
        HERMES_WEB_UI_PROFILE: 'research',
        AUTH_TOKEN: '',
      },
    })
    child.stdout.on('data', (chunk) => {
      for (const line of String(chunk).trim().split('\n')) {
        if (!line) continue
        const message = JSON.parse(line)
        responses.set(message.id, message)
      }
    })

    writeRpc(child, 1, 'initialize', {})
    writeRpc(child, 2, 'tools/list')
    writeRpc(child, 3, 'tools/call', {
      name: 'ekko_studio_api_request',
      arguments: {
        method: 'POST',
        path: '/api/test-public-requester',
        query: { q: 'hello' },
        body: { ok: true },
      },
    })
    writeRpc(child, 4, 'resources/list')
    writeRpc(child, 5, 'tools/call', {
      name: 'ekko_studio_api_request',
      arguments: {
        method: 'POST',
        path: '/api/studio/chat-run/runs',
        body: {},
      },
    })
    writeRpc(child, 7, 'tools/call', {
      name: 'ekko_studio_api_openapi_get',
      arguments: {
        path: '/api/studio/chat-run/runs',
        method: 'POST',
      },
    })
    writeRpc(child, 9, 'tools/call', {
      name: 'ekko_studio_api_openapi_get',
      arguments: {},
    })
    writeRpc(child, 10, 'tools/call', {
      name: 'hermes_api_request',
      arguments: {
        method: 'POST',
        path: '/api/test-public-requester',
        body: { legacy: true },
      },
    })

    const initialized = await waitForRpc(responses, 1)
    expect(initialized.result.serverInfo).toMatchObject({
      name: 'ekko-studio-mcp',
      version: pkg.version,
    })
    expect(initialized.result.capabilities).toEqual({ tools: {} })
    expect(initialized.result.instructions).toContain('ekko_studio_api_openapi_get')

    const list = await waitForRpc(responses, 2)
    expectProviderSafeToolNames('ekko-studio-api', list.result.tools)
    expect(list.result.tools).toHaveLength(2)
    expect(list.result.tools.some((tool: any) => tool.name === 'ekko_studio_api_request')).toBe(true)
    expect(list.result.tools.some((tool: any) => tool.name === 'ekko_studio_lan_devices_list')).toBe(false)

    const response = await waitForRpc(responses, 3)
    const payload = JSON.parse(response.result.content[0].text)
    expect(payload.status).toBe(200)
    expect(payload.body).toMatchObject({
      method: 'POST',
      url: '/api/test-public-requester?q=hello',
      body: { ok: true },
      profile: 'research',
      authorization: 'Bearer profile-token',
    })
    writeRpc(child, 11, 'tools/call', {
      name: 'hermes_studio_api_request',
      arguments: { method: 'POST', path: '/api/test-public-requester', body: { oldPrefix: true } },
    })
    const oldPrefix = JSON.parse((await waitForRpc(responses, 11)).result.content[0].text)
    expect(oldPrefix.status).toBe(200)
    expect(oldPrefix.body.body).toEqual({ oldPrefix: true })
    const legacyResponse = await waitForRpc(responses, 10)
    const legacyPayload = JSON.parse(legacyResponse.result.content[0].text)
    expect(legacyPayload.status).toBe(200)
    expect(legacyPayload.body.body).toEqual({ legacy: true })
    writeRpc(child, 8, 'tools/call', {
      name: 'ekko_studio_api_openapi_get',
      arguments: {
        path: '/api/test-public-requester',
        method: 'POST',
      },
    })

    const resource = await waitForRpc(responses, 4)
    expect(resource.error).toMatchObject({
      code: -32601,
      message: 'Method not found: resources/list',
    })

    const invalid = await waitForRpc(responses, 5)
    expect(invalid.result.isError).toBe(true)
    expect(invalid.result.content[0].text).toContain('missing required field body.input')
    expect(chatRunHits).toBe(0)

    const compactManual = await waitForRpc(responses, 7)
    const compactPayload = JSON.parse(compactManual.result.content[0].text)
    expect(compactPayload).toMatchObject({
      moduleCount: 2,
      operationCount: 1,
      operations: [{
        method: 'POST',
        path: '/api/studio/chat-run/runs',
        requestBody: {
          fields: [
            { name: 'input', required: true, type: 'string' },
          ],
        },
      }],
    })
    expect(compactPayload.paths).toBeUndefined()

    const moduleManual = await waitForRpc(responses, 9)
    const modulePayload = JSON.parse(moduleManual.result.content[0].text)
    expect(modulePayload).toMatchObject({
      moduleCount: 2,
      operationCount: 2,
      operationsOmitted: true,
      modules: expect.arrayContaining([
        {
          tag: 'Chat Run',
          operationCount: 1,
          purpose: 'Start a chat or coding-agent run through the HTTP bridge and wait for the result.',
          keywords: expect.arrayContaining(['chat', 'run']),
          description: 'Chat run operations',
        },
        { tag: 'Testing', operationCount: 1, description: 'Test helper operations' },
      ]),
    })
    expect(modulePayload.operations).toBeUndefined()

    const optionalManual = await waitForRpc(responses, 8)
    const optionalPayload = JSON.parse(optionalManual.result.content[0].text)
    expect(optionalPayload.operations[0]).toMatchObject({
      method: 'POST',
      path: '/api/test-public-requester',
      requestBody: { required: false, fields: [] },
    })

    writeRpc(child, 6, 'tools/call', {
      name: 'ekko_studio_api_request',
      arguments: {
        method: 'POST',
        path: '/api/studio/chat-run/runs',
        body: { input: 'hello' },
      },
    })
    const valid = await waitForRpc(responses, 6)
    const validPayload = JSON.parse(valid.result.content[0].text)
    expect(validPayload.status).toBe(200)
    expect(validPayload.body.body).toEqual({ input: 'hello' })
    expect(chatRunHits).toBe(1)

    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  it.each([
    'bin/ekko-studio-mcp.mjs',
    'bin/hermes-studio-mcp.mjs',
    'bin/hermes-web-ui-mcp.mjs',
  ])('reports the package version from the CLI entry %s', async (entry) => {
    const child = spawn(process.execPath, [entry, '--version'], {
      cwd: process.cwd(),
      env: process.env,
    })
    let stdout = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    const code = await new Promise<number | null>(resolve => child.on('close', resolve))

    expect(code).toBe(0)
    expect(stdout.trim()).toBe(`ekko-studio-mcp v${pkg.version}`)
  })

  it('accepts previous tool names through the legacy entry without listing duplicate tools', async () => {
    const responses = new Map<number, any>()
    child = spawn(process.execPath, ['bin/hermes-studio-mcp.mjs', 'use'], {
      cwd: process.cwd(), env: process.env,
    })
    let buffer = ''
    child.stdout.on('data', chunk => {
      buffer += String(chunk)
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.trim()) { const response = JSON.parse(line); responses.set(response.id, response) }
      }
    })
    writeRpc(child, 1, 'tools/list')
    expect((await waitForRpc(responses, 1)).result.tools.map((tool: any) => tool.name))
      .toEqual(['ekko_studio_use_toolset'])
    writeRpc(child, 2, 'tools/call', { name: 'hermes_studio_use_toolset', arguments: { action: 'list' } })
    const catalog = JSON.parse((await waitForRpc(responses, 2)).result.content[0].text)
    expect(catalog.operations.length).toBeGreaterThan(0)
    expect(catalog.operations.every((tool: any) => tool.name.startsWith('ekko_studio_'))).toBe(true)
    writeRpc(child, 3, 'tools/call', {
      name: 'hermes_studio_use_toolset',
      arguments: { action: 'describe', tool: 'hermes_studio_use_workflow_run_rerun_from_node' },
    })
    expect(JSON.parse((await waitForRpc(responses, 3)).result.content[0].text).name)
      .toBe('ekko_studio_use_workflow_rerun_node')
    writeRpc(child, 4, 'tools/call', { name: 'hermes_studio_api_request', arguments: { path: '/health' } })
    expect((await waitForRpc(responses, 4)).result.isError).toBe(true)
  })

  it('excludes shared planning from Ekko discovery and rejects direct, aliased and catalog calls', async () => {
    const responses = new Map<number, any>()
    child = spawn(process.execPath, ['bin/ekko-studio-mcp.mjs', 'use'], {
      cwd: process.cwd(), env: { ...process.env, HERMES_MCP_NATIVE_TASK_PLAN: '1' },
    })
    let buffer = ''
    child.stdout.on('data', chunk => {
      buffer += String(chunk)
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.trim()) { const response = JSON.parse(line); responses.set(response.id, response) }
      }
    })
    writeRpc(child, 1, 'initialize', {})
    writeRpc(child, 2, 'tools/list')
    writeRpc(child, 3, 'tools/call', { name: 'ekko_studio_use_toolset', arguments: { action: 'list' } })
    expect((await waitForRpc(responses, 1)).result.instructions).not.toMatch(/task plan/i)
    expect(JSON.stringify((await waitForRpc(responses, 2)).result.tools)).not.toMatch(/task plan/i)
    const catalog = JSON.parse((await waitForRpc(responses, 3)).result.content[0].text)
    expect(catalog.operations.some((tool: any) => tool.name === 'ekko_studio_update_plan')).toBe(false)
    expect(catalog.operations.some((tool: any) => tool.name === 'ekko_studio_use_sessions_count')).toBe(true)
    for (const [index, name] of ['ekko_studio_update_plan', 'hermes_studio_update_plan'].entries()) {
      writeRpc(child, 10 + index, 'tools/call', { name, arguments: {} })
      const response = (await waitForRpc(responses, 10 + index)).result
      expect(response.isError).toBe(true)
      expect(response.content[0].text).toContain('not available')
    }
    for (const [index, action] of ['describe', 'call'].entries()) {
      writeRpc(child, 20 + index, 'tools/call', {
        name: 'ekko_studio_use_toolset', arguments: { action, tool: 'ekko_studio_update_plan', arguments: {} },
      })
      const response = (await waitForRpc(responses, 20 + index)).result
      expect(response.isError).toBe(true)
      expect(response.content[0].text).toContain("Unknown 'use' tool")
    }
  })

  it.each(['response', 'cancel'])('round-trips the direct clarification tool: %s', async outcome => {
    const requests: any[] = []
    let answer: (() => void) | undefined
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', chunk => { raw += chunk })
      req.on('end', () => {
        requests.push({ path: req.url, method: req.method, body: JSON.parse(raw), profile: req.headers['x-hermes-profile'] })
        if (req.url === '/api/studio/task-plans/update') {
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: true, revision: 1 }))
          return
        }
        answer = () => {
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: true, response: 'custom-folder', reason: 'response' }))
        }
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const responses = new Map<number, any>()
    child = spawn(process.execPath, ['bin/ekko-studio-mcp.mjs', 'plan'], {
      cwd: process.cwd(), env: { ...process.env, HERMES_WEB_UI_URL: `http://127.0.0.1:${(server.address() as any).port}`, HERMES_WEB_UI_PROFILE: 'research', HERMES_MCP_USER_CLARIFICATION: '1' },
    })
    let buffer = ''
    child.stdout.on('data', chunk => {
      buffer += String(chunk)
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
        if (line.trim()) { const response = JSON.parse(line); responses.set(response.id, response) }
      }
    })
    try {
      writeRpc(child, 1, 'tools/list')
      const tools = (await waitForRpc(responses, 1)).result.tools
      expect(tools.map((tool: any) => tool.name)).toEqual(['ekko_studio_clarify', 'ekko_studio_update_plan'])
      expectProviderSafeToolNames('ekko-studio-interaction', tools)
      expect(tools[0].inputSchema.required).toEqual(['context_id', 'question'])
      const input = { context_id: 'current-turn', question: 'Which folder?', choices: ['client', 'server'] }
      writeRpc(child, 2, 'tools/call', { name: 'ekko_studio_clarify', arguments: { ...input, session_id: 'ignored' } })
      for (let attempt = 0; !answer && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 10))
      expect(answer).toBeTypeOf('function')
      expect(responses.has(2)).toBe(false)
      expect(requests).toEqual([{ path: '/api/studio/clarifications/request', method: 'POST', body: input, profile: 'research' }])
      const plan = { context_id: 'current-turn', plan: [{ id: 'implement', step: 'Implement', status: 'in_progress' }] }
      writeRpc(child, 3, 'tools/call', { name: 'ekko_studio_update_plan', arguments: plan })
      expect(JSON.parse((await waitForRpc(responses, 3)).result.content[0].text)).toEqual({ ok: true, revision: 1 })
      expect(requests[1]).toEqual({ path: '/api/studio/task-plans/update', method: 'POST', body: plan, profile: 'research' })
      expect(responses.has(2)).toBe(false)
      if (outcome === 'cancel') {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } })}\n`)
        expect((await waitForRpc(responses, 2)).result.isError).toBe(true)
      } else {
        answer!()
        expect(JSON.parse((await waitForRpc(responses, 2)).result.content[0].text)).toMatchObject({ response: 'custom-folder', reason: 'response' })
      }
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  })

  it.each(['coding', 'hermes', 'ekko'])('limits the shared interaction MCP tools for %s', async agent => {
    const native = agent === 'ekko'
    const clarify = agent === 'coding'
    const requests: any[] = []
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', chunk => { raw += chunk })
      req.on('end', () => {
        requests.push({ path: req.url, method: req.method, body: JSON.parse(raw) })
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true, revision: 1 }))
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as any).port
    const responses = new Map<number, any>()
    child = spawn(process.execPath, ['bin/ekko-studio-mcp.mjs', 'plan'], {
      cwd: process.cwd(), env: { ...process.env, HERMES_WEB_UI_URL: `http://127.0.0.1:${port}`, HERMES_MCP_NATIVE_TASK_PLAN: native ? '1' : '0', HERMES_MCP_USER_CLARIFICATION: agent === 'hermes' ? '0' : '1' },
    })
    let buffer = ''
    child.stdout.on('data', chunk => {
      buffer += String(chunk)
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
        if (line.trim()) { const response = JSON.parse(line); responses.set(response.id, response) }
      }
    })
    try {
      writeRpc(child, 1, 'tools/list')
      const tools = (await waitForRpc(responses, 1)).result.tools
      expect(tools.map((tool: any) => tool.name)).toEqual(native ? [] : clarify ? ['ekko_studio_clarify', 'ekko_studio_update_plan'] : ['ekko_studio_update_plan'])
      if (!native) expect(tools.find((tool: any) => tool.name === 'ekko_studio_update_plan').inputSchema.required).toEqual(['context_id', 'plan'])
      const input = { context_id: 'current-turn', plan: [{ id: 'check', step: 'Check', status: 'in_progress' }] }
      writeRpc(child, 2, 'tools/call', { name: 'ekko_studio_update_plan', arguments: input })
      const response = (await waitForRpc(responses, 2)).result
      if (!clarify) {
        writeRpc(child, 3, 'tools/call', { name: 'ekko_studio_clarify', arguments: { context_id: 'current-turn', question: 'Q' } })
        expect((await waitForRpc(responses, 3)).result.isError).toBe(true)
        writeRpc(child, 4, 'initialize', {})
        expect((await waitForRpc(responses, 4)).result.instructions).not.toContain('ekko_studio_clarify')
      }
      if (native) {
        expect(response.isError).toBe(true)
        expect(response.content[0].text).toContain('not available')
        expect(requests).toEqual([])
      } else {
        expect(response.isError).not.toBe(true)
        expect(requests).toEqual([{ path: '/api/studio/task-plans/update', method: 'POST', body: input }])
      }
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  })

  it('exposes the curated Ekko Studio use catalog through one compact category tool', async () => {
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      if (req.url === '/api/studio/chat-run/runs') {
        let raw = ''
        req.on('data', chunk => { raw += chunk })
        req.on('end', () => {
          res.end(JSON.stringify({
            ok: true,
            session_id: 'session-1',
            body: raw ? JSON.parse(raw) : null,
          }))
        })
        return
      }
      if (req.url === '/api/studio/sessions?limit=2&source=coding_agent') {
        res.end(JSON.stringify({ sessions: [{ id: 'session-1' }] }))
        return
      }
      if (req.url === '/api/studio/sessions/count?source=coding_agent') {
        res.end(JSON.stringify({ count: 7 }))
        return
      }
      if (req.url === '/api/studio/usage/stats?days=7') {
        res.end(JSON.stringify({
          total_input_tokens: 100,
          total_output_tokens: 40,
          total_cache_read_tokens: 10,
          total_cache_write_tokens: 2,
          total_reasoning_tokens: 5,
          total_sessions: 3,
          total_cost: 0.0123,
          total_api_calls: 4,
          period_days: 7,
          model_usage: [{ model: 'gpt-5.1', input_tokens: 100, output_tokens: 40, cache_read_tokens: 10, cache_write_tokens: 2, reasoning_tokens: 5, sessions: 3 }],
          daily_usage: [],
        }))
        return
      }
      if (req.url === '/api/studio/sessions/session-1' && req.method === 'GET') {
        res.end(JSON.stringify({ id: 'session-1', title: 'Session 1' }))
        return
      }
      if (req.url === '/api/studio/sessions/session-1/context') {
        res.end(JSON.stringify({
          session_id: 'session-1',
          title: 'Session 1',
          messages: [
            { id: 1, role: 'user', content: 'older', timestamp: 1 },
            { id: 2, role: 'assistant', content: 'tool call shell', timestamp: 2, tool_calls: [{ id: 'call-1' }] },
            { id: 3, role: 'tool', content: 'secret tool result', timestamp: 3, tool_call_id: 'call-1', tool_name: 'read_file' },
            { id: 4, role: 'user', content: 'hello', timestamp: 4 },
            { id: 5, role: 'assistant', content: 'hi', timestamp: 5 },
            { id: 6, role: 'user', content: 'next', timestamp: 6 },
            { id: 7, role: 'assistant', content: 'done', timestamp: 7 },
          ],
          message_count: 7,
        }))
        return
      }
      if (req.url === '/api/studio/sessions/session-1' && req.method === 'DELETE') {
        res.end(JSON.stringify({ ok: true, deleted: true }))
        return
      }
      if (req.url === '/api/studio/sessions/conversations/session-1/messages?humanOnly=0') {
        res.end(JSON.stringify({ messages: [{ role: 'system', content: 'internal' }] }))
        return
      }
      if (req.url === '/api/studio/sessions/session-1/rename' && req.method === 'POST') {
        let raw = ''
        req.on('data', chunk => { raw += chunk })
        req.on('end', () => {
          res.end(JSON.stringify({ ok: true, body: raw ? JSON.parse(raw) : null }))
        })
        return
      }
      if (req.url === '/api/hermes/profiles') {
        res.end(JSON.stringify({ profiles: ['default'] }))
        return
      }
      if (req.url === '/api/hermes/available-models') {
        res.end(JSON.stringify({
          default: 'gpt-5.1',
          default_provider: 'openai',
          providers: [
            { id: 'openai', label: 'OpenAI', models: ['gpt-5.1'] },
            { id: 'openrouter', label: 'OpenRouter', models: ['gpt-5.1', 'claude-sonnet'], model_meta: { 'claude-sonnet': { alias: 'Claude Sonnet' } } },
          ],
        }))
        return
      }
      if (req.url === '/api/hermes/config/providers' && req.method === 'POST') {
        let raw = ''
        req.on('data', chunk => { raw += chunk })
        req.on('end', () => {
          res.end(JSON.stringify({
            success: true,
            body: raw ? JSON.parse(raw) : null,
          }))
        })
        return
      }
      if (req.url === '/api/hermes/config/providers/custom%3Aedge-router?source=providers&providerKey=edge-router' && req.method === 'DELETE') {
        res.end(JSON.stringify({ success: true, deleted: 'custom:edge-router' }))
        return
      }
      if (req.url === '/api/studio/performance/runtime') {
        res.end(JSON.stringify({
          timestamp: 123456,
          bridge: {
            reachable: true,
            workers: [
              { profile: 'default', pid: 101, running: true, sessionCount: 3, runningSessionCount: 1, lastUsedAt: 123400, endpoint: 'ipc://default' },
              { profile: 'research', pid: 102, running: true, sessionCount: 2, runningSessionCount: 0, lastUsedAt: 123300, endpoint: 'ipc://research' },
            ],
          },
          sessions: { active: 5, running: 1, byProfile: { default: 3, research: 2 } },
        }))
        return
      }
      if (req.url === '/api/studio/mobile-location/request' && req.method === 'POST') {
        let raw = ''
        req.on('data', chunk => { raw += chunk })
        req.on('end', () => {
          res.end(JSON.stringify({
            ok: true,
            status: 'success',
            location: {
              latitude: 31.2304,
              longitude: 121.4737,
              accuracyMeters: 65,
              coordinateSystem: 'wgs84',
              timestamp: 123456789,
            },
            body: raw ? JSON.parse(raw) : null,
          }))
        })
        return
      }
      if (req.url === '/api/studio/task-plans/update' && req.method === 'POST') {
        let raw = ''
        req.on('data', chunk => { raw += chunk })
        req.on('end', () => res.end(JSON.stringify({ ok: true, body: JSON.parse(raw) })))
        return
      }
      if (req.url === '/api/studio/mobile-calendar/request' && req.method === 'POST') {
        let raw = ''
        req.on('data', chunk => { raw += chunk })
        req.on('end', () => {
          res.end(JSON.stringify({
            ok: true,
            status: 'success',
            body: raw ? JSON.parse(raw) : null,
          }))
        })
        return
      }
      if (req.url === '/api/studio/workflows?profile=default') {
        res.end(JSON.stringify({ workflows: [{ id: 'workflow-1', name: 'Demo workflow', profile: 'default' }] }))
        return
      }
      if (req.url === '/api/studio/workflows/workflow-1' && req.method === 'GET') {
        res.end(JSON.stringify({ workflow: { id: 'workflow-1', name: 'Demo workflow', profile: 'default' } }))
        return
      }
      if (req.url === '/api/studio/workflows' && req.method === 'POST') {
        let raw = ''
        req.on('data', chunk => { raw += chunk })
        req.on('end', () => {
          res.end(JSON.stringify({ workflow: { id: 'workflow-created', body: raw ? JSON.parse(raw) : null } }))
        })
        return
      }
      if (req.url === '/api/studio/workflows/workflow-1' && req.method === 'PATCH') {
        let raw = ''
        req.on('data', chunk => { raw += chunk })
        req.on('end', () => {
          res.end(JSON.stringify({ workflow: { id: 'workflow-1', body: raw ? JSON.parse(raw) : null } }))
        })
        return
      }
      if (req.url === '/api/studio/workflows/workflow-1/runs?limit=5') {
        res.end(JSON.stringify({ runs: [{ id: 'run-1', workflow_id: 'workflow-1', status: 'completed', node_sessions: [] }] }))
        return
      }
      if (req.url === '/api/studio/workflows/workflow-1/run' && req.method === 'POST') {
        let raw = ''
        req.on('data', chunk => { raw += chunk })
        req.on('end', () => {
          res.end(JSON.stringify({ ok: true, status: 'accepted', body: raw ? JSON.parse(raw) : null }))
        })
        return
      }
      if (req.url === '/api/studio/workflows/workflow-1/runs/run-1/stop' && req.method === 'POST') {
        res.end(JSON.stringify({ ok: true, run: { id: 'run-1', status: 'canceled' } }))
        return
      }
      if (req.url === '/api/studio/workflows/workflow-1/runs/run-1/rerun-from-node' && req.method === 'POST') {
        let raw = ''
        req.on('data', chunk => { raw += chunk })
        req.on('end', () => {
          res.end(JSON.stringify({ ok: true, status: 'accepted', body: raw ? JSON.parse(raw) : null }))
        })
        return
      }
      if (req.url === '/api/studio/workflows/workflow-1/runs/run-1' && req.method === 'DELETE') {
        res.end(JSON.stringify({ ok: true, deleted_run: 'run-1' }))
        return
      }
      if (req.url === '/api/studio/workflows/workflow-1' && req.method === 'DELETE') {
        res.end(JSON.stringify({ ok: true, deleted_workflow: 'workflow-1' }))
        return
      }
      res.statusCode = 404
      res.end('{}')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('expected TCP server address')

    const responses = new Map<number, any>()
    child = spawn(process.execPath, ['bin/ekko-studio-mcp.mjs', 'use'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HERMES_WEB_UI_URL: `http://127.0.0.1:${address.port}`,
        HERMES_STUDIO_SESSION_ID: 'studio-codex-session',
      },
    })
    child.stdout.on('data', (chunk) => {
      for (const line of String(chunk).trim().split('\n')) {
        if (!line) continue
        const message = JSON.parse(line)
        responses.set(message.id, message)
      }
    })

    writeRpc(child, 1, 'initialize', {})
    writeRpc(child, 2, 'tools/list')
    writeRpc(child, 32, 'tools/call', {
      name: 'ekko_studio_use_toolset',
      arguments: { action: 'list' },
    })
    writeRpc(child, 33, 'tools/call', {
      name: 'ekko_studio_use_toolset',
      arguments: { action: 'describe', tool: 'ekko_studio_use_workflow_run_start' },
    })
    writeRpc(child, 34, 'tools/call', {
      name: 'ekko_studio_use_toolset',
      arguments: { action: 'describe', tool: 'ekko_studio_use_workflow_rerun_node' },
    })
    writeRpc(child, 37, 'tools/call', {
      name: 'ekko_studio_use_toolset',
      arguments: { action: 'describe', tool: 'ekko_studio_use_chat_run' },
    })
    writeRpc(child, 35, 'tools/call', {
      name: 'ekko_studio_use_toolset',
      arguments: {
        action: 'call',
        tool: 'ekko_studio_use_sessions_count',
        arguments: { source: 'coding_agent' },
      },
    })
    writeRpc(child, 136, 'tools/call', {
      name: 'ekko_studio_use_toolset',
      arguments: {
        action: 'call',
        tool: 'ekko_studio_use_mobile_location',
        arguments: {
          session_id: 'session-1',
          purpose: 'Find nearby restaurants',
          accuracy: 'coarse',
          timeout_ms: 10000,
        },
      },
    })
    writeRpc(child, 36, 'tools/call', {
      name: 'ekko_studio_use_toolset',
      arguments: {
        action: 'call',
        tool: 'ekko_studio_use_mobile_calendar',
        arguments: {
          session_id: 'codex-runtime-thread-id',
          action: 'list',
          purpose: 'Verify calendar access',
          limit: 20,
        },
      },
    })
    writeRpc(child, 3, 'tools/call', {
      name: 'ekko_studio_use_chat_run',
      arguments: { input: 'hello', session_id: 'session-1', include_events: true },
    })
    writeRpc(child, 4, 'tools/call', {
      name: 'ekko_studio_use_sessions_list',
      arguments: { limit: 2, source: 'coding_agent' },
    })
    writeRpc(child, 5, 'tools/call', {
      name: 'ekko_studio_use_session_get',
      arguments: { session_id: 'session-1' },
    })
    writeRpc(child, 10, 'tools/call', {
      name: 'ekko_studio_use_sessions_count',
      arguments: { source: 'coding_agent' },
    })
    writeRpc(child, 6, 'tools/call', {
      name: 'ekko_studio_use_session_messages',
      arguments: { session_id: 'session-1', include_internal: true },
    })
    writeRpc(child, 11, 'tools/call', {
      name: 'ekko_studio_use_session_rename',
      arguments: { session_id: 'session-1', title: 'Renamed session' },
    })
    writeRpc(child, 12, 'tools/call', {
      name: 'ekko_studio_use_session_delete',
      arguments: { session_id: 'session-1' },
    })
    writeRpc(child, 7, 'tools/call', {
      name: 'ekko_studio_use_profiles_list',
      arguments: {},
    })
    writeRpc(child, 8, 'tools/call', {
      name: 'ekko_studio_use_available_models',
      arguments: {},
    })
    writeRpc(child, 30, 'tools/call', {
      name: 'ekko_studio_use_available_models',
      arguments: { query: 'claude', limit_per_provider: 1 },
    })
    writeRpc(child, 31, 'tools/call', {
      name: 'ekko_studio_use_available_models',
      arguments: { include_details: true },
    })
    writeRpc(child, 13, 'tools/call', {
      name: 'ekko_studio_use_model_provider_get',
      arguments: { model: 'gpt-5.1' },
    })
    writeRpc(child, 14, 'tools/call', {
      name: 'ekko_studio_use_model_provider_get',
      arguments: { model: 'Claude Sonnet' },
    })
    writeRpc(child, 15, 'tools/call', {
      name: 'ekko_studio_use_provider_add',
      arguments: {
        name: 'Edge Router',
        base_url: 'https://edge.example/v1',
        api_key: 'secret-key',
        model: 'edge-model',
        context_length: 128000,
        api_mode: 'chat_completions',
      },
    })
    writeRpc(child, 16, 'tools/call', {
      name: 'ekko_studio_use_provider_delete',
      arguments: {
        pool_key: 'custom:edge-router',
        source: 'providers',
        providerKey: 'edge-router',
      },
    })
    writeRpc(child, 17, 'tools/call', {
      name: 'ekko_studio_use_usage_stats',
      arguments: { days: 7 },
    })
    writeRpc(child, 18, 'tools/call', {
      name: 'ekko_studio_use_session_context',
      arguments: { session_id: 'session-1', turns: 1 },
    })
    writeRpc(child, 19, 'tools/call', {
      name: 'ekko_studio_use_worker_status',
      arguments: {},
    })
    writeRpc(child, 20, 'tools/call', {
      name: 'ekko_studio_use_workflows_list',
      arguments: { profile: 'default' },
    })
    writeRpc(child, 21, 'tools/call', {
      name: 'ekko_studio_use_workflow_get',
      arguments: { workflow_id: 'workflow-1' },
    })
    writeRpc(child, 22, 'tools/call', {
      name: 'ekko_studio_use_workflow_create',
      arguments: {
        name: 'Created workflow',
        profile: 'default',
        workspace: '/tmp/workflow',
        nodes: [{ id: 'node-1', type: 'agent' }],
        edges: [],
        viewport: { x: 1, y: 2, zoom: 0.8 },
      },
    })
    writeRpc(child, 23, 'tools/call', {
      name: 'ekko_studio_use_workflow_update',
      arguments: { workflow_id: 'workflow-1', name: 'Updated workflow', nodes: [{ id: 'node-2' }] },
    })
    writeRpc(child, 24, 'tools/call', {
      name: 'ekko_studio_use_workflow_runs_list',
      arguments: { workflow_id: 'workflow-1', limit: 5 },
    })
    writeRpc(child, 25, 'tools/call', {
      name: 'ekko_studio_use_workflow_run_start',
      arguments: { workflow_id: 'workflow-1', start_node_ids: ['node-1'], input: 'go', timeout_ms: 1000 },
    })
    writeRpc(child, 26, 'tools/call', {
      name: 'ekko_studio_use_workflow_run_stop',
      arguments: { workflow_id: 'workflow-1', run_id: 'run-1' },
    })
    writeRpc(child, 27, 'tools/call', {
      name: 'ekko_studio_use_workflow_run_rerun_from_node',
      arguments: { workflow_id: 'workflow-1', run_id: 'run-1', node_id: 'node-2', preserve_start_node: true, timeout_ms: 2000 },
    })
    writeRpc(child, 28, 'tools/call', {
      name: 'ekko_studio_use_workflow_run_delete',
      arguments: { workflow_id: 'workflow-1', run_id: 'run-1' },
    })
    writeRpc(child, 29, 'tools/call', {
      name: 'ekko_studio_use_workflow_delete',
      arguments: { workflow_id: 'workflow-1' },
    })

    const initialized = await waitForRpc(responses, 1)
    expect(initialized.result.serverInfo).toMatchObject({ toolset: 'use' })
    expect(initialized.result.instructions).toContain('session management')

    const list = await waitForRpc(responses, 2)
    expectProviderSafeToolNames('ekko-studio-use', list.result.tools)
    expect(list.result.tools).toHaveLength(1)
    expect(list.result.tools[0].name).toBe('ekko_studio_use_toolset')
    expect(list.result.tools[0].description).toContain('workflow run lifecycle')
    expect(list.result.tools[0].description).toContain('internal delegation')

    const catalog = JSON.parse((await waitForRpc(responses, 32)).result.content[0].text)
    expect(catalog).toMatchObject({ toolset: 'use', operation_count: 29 })
    expect(catalog.operations.map((tool: any) => tool.name)).toEqual(expect.arrayContaining([
      'ekko_studio_use_chat_run',
      'ekko_studio_use_sessions_count',
      'ekko_studio_use_usage_stats',
      'ekko_studio_use_session_context',
      'ekko_studio_use_provider_add',
      'ekko_studio_use_worker_status',
      'ekko_studio_use_mobile_location',
      'ekko_studio_use_mobile_calendar',
      'ekko_studio_use_mobile_reminders',
      'ekko_studio_use_mobile_health',
      'ekko_studio_use_workflows_list',
      'ekko_studio_use_workflow_rerun_node',
    ]))
    expect(catalog.operations.some((tool: any) => tool.name === 'ekko_studio_use_workflow_run_rerun_from_node')).toBe(false)
    const workflowRunStartTool = JSON.parse((await waitForRpc(responses, 33)).result.content[0].text)
    const workflowRerunTool = JSON.parse((await waitForRpc(responses, 34)).result.content[0].text)
    const chatRunTool = JSON.parse((await waitForRpc(responses, 37)).result.content[0].text)
    expect(chatRunTool?.inputSchema?.properties?.coding_agent_id?.enum).toEqual([
      'claude-code',
      'codex',
      'pi',
      'grok',
      'opencode',
      'ekko-agent',
    ])
    expect(chatRunTool?.inputSchema?.properties?.agent_id?.enum)
      .toEqual(chatRunTool?.inputSchema?.properties?.coding_agent_id?.enum)
    for (const tool of [workflowRunStartTool, workflowRerunTool]) {
      expect(tool?.inputSchema?.properties?.timeout_ms).toMatchObject({
        type: 'integer', minimum: 1000, maximum: 86400000,
      })
      expect(tool?.inputSchema?.properties?.timeout_ms?.description).toContain('total Workflow Run budget')
    }
    const gatewaySessionCount = JSON.parse((await waitForRpc(responses, 35)).result.content[0].text)
    expect(gatewaySessionCount.count).toBe(7)
    const mobileLocation = JSON.parse((await waitForRpc(responses, 136)).result.content[0].text)
    expect(mobileLocation).toMatchObject({
      ok: true,
      status: 'success',
      location: {
        latitude: 31.2304,
        longitude: 121.4737,
        coordinateSystem: 'wgs84',
      },
      body: {
        session_id: 'session-1',
        purpose: 'Find nearby restaurants',
        accuracy: 'coarse',
        timeout_ms: 10000,
      },
    })

    const mobileCalendar = JSON.parse((await waitForRpc(responses, 36)).result.content[0].text)
    expect(mobileCalendar).toMatchObject({
      ok: true,
      status: 'success',
      body: {
        capability: 'calendar',
        session_id: 'studio-codex-session',
        action: 'list',
        purpose: 'Verify calendar access',
        limit: 20,
      },
    })
    const chatRun = JSON.parse((await waitForRpc(responses, 3)).result.content[0].text)
    expect(chatRun.body).toMatchObject({ input: 'hello', session_id: 'session-1', include_events: true })
    const sessions = JSON.parse((await waitForRpc(responses, 4)).result.content[0].text)
    expect(sessions.sessions[0].id).toBe('session-1')
    const sessionCount = JSON.parse((await waitForRpc(responses, 10)).result.content[0].text)
    expect(sessionCount.count).toBe(7)
    const session = JSON.parse((await waitForRpc(responses, 5)).result.content[0].text)
    expect(session.title).toBe('Session 1')
    const messages = JSON.parse((await waitForRpc(responses, 6)).result.content[0].text)
    expect(messages.messages[0].role).toBe('system')
    const renamed = JSON.parse((await waitForRpc(responses, 11)).result.content[0].text)
    expect(renamed).toEqual({ ok: true, body: { title: 'Renamed session' } })
    const deleted = JSON.parse((await waitForRpc(responses, 12)).result.content[0].text)
    expect(deleted).toEqual({ ok: true, deleted: true })
    const profiles = JSON.parse((await waitForRpc(responses, 7)).result.content[0].text)
    expect(profiles.profiles).toEqual(['default'])
    const models = JSON.parse((await waitForRpc(responses, 8)).result.content[0].text)
    expect(models).toMatchObject({
      default: 'gpt-5.1',
      default_provider: 'openai',
      provider_count: 2,
      model_count: 3,
      returned_model_count: 3,
    })
    expect(models.providers[0].models).toEqual(['gpt-5.1'])
    expect(JSON.stringify(models)).not.toContain('model_meta')
    const filteredModels = JSON.parse((await waitForRpc(responses, 30)).result.content[0].text)
    expect(filteredModels).toMatchObject({
      query: 'claude',
      returned_provider_count: 1,
      returned_model_count: 1,
      providers: [
        {
          provider: 'openrouter',
          models: ['claude-sonnet'],
          aliases: { 'claude-sonnet': 'Claude Sonnet' },
        },
      ],
    })
    const detailedModels = JSON.parse((await waitForRpc(responses, 31)).result.content[0].text)
    expect(detailedModels.providers[1].model_meta).toEqual({ 'claude-sonnet': { alias: 'Claude Sonnet' } })
    const modelProvider = JSON.parse((await waitForRpc(responses, 13)).result.content[0].text)
    expect(modelProvider).toMatchObject({
      model: 'gpt-5.1',
      found: true,
      provider: 'openai',
      ambiguous: true,
    })
    expect(modelProvider.providers.map((entry: any) => entry.provider)).toEqual(['openai', 'openrouter'])
    const aliasProvider = JSON.parse((await waitForRpc(responses, 14)).result.content[0].text)
    expect(aliasProvider).toMatchObject({
      model: 'Claude Sonnet',
      found: true,
      provider: 'openrouter',
      ambiguous: false,
    })
    const addedProvider = JSON.parse((await waitForRpc(responses, 15)).result.content[0].text)
    expect(addedProvider).toEqual({
      success: true,
      body: {
        name: 'Edge Router',
        base_url: 'https://edge.example/v1',
        api_key: 'secret-key',
        model: 'edge-model',
        context_length: 128000,
        api_mode: 'chat_completions',
      },
    })
    const deletedProvider = JSON.parse((await waitForRpc(responses, 16)).result.content[0].text)
    expect(deletedProvider).toEqual({ success: true, deleted: 'custom:edge-router' })
    const usage = JSON.parse((await waitForRpc(responses, 17)).result.content[0].text)
    expect(usage).toMatchObject({ total_input_tokens: 100, total_output_tokens: 40, period_days: 7 })
    const context = JSON.parse((await waitForRpc(responses, 18)).result.content[0].text)
    expect(context).toMatchObject({
      session_id: 'session-1',
      message_count: 2,
      clean_message_count: 5,
      requested_turns: 1,
      messages: [
        { id: 6, role: 'user', content: 'next', timestamp: 6 },
        { id: 7, role: 'assistant', content: 'done', timestamp: 7 },
      ],
    })
    expect(JSON.stringify(context)).not.toContain('tool_calls')
    expect(JSON.stringify(context)).not.toContain('secret tool result')
    const workerStatus = JSON.parse((await waitForRpc(responses, 19)).result.content[0].text)
    expect(workerStatus).toMatchObject({
      bridge_reachable: true,
      worker_count: 2,
      running_worker_count: 2,
      session_count: 5,
      interacting_session_count: 1,
      completed_interaction_count: 4,
    })
    expect(workerStatus.interacting_workers.map((worker: any) => worker.profile)).toEqual(['default'])
    expect(workerStatus.completed_workers.map((worker: any) => worker.profile)).toEqual(['research'])
    const workflows = JSON.parse((await waitForRpc(responses, 20)).result.content[0].text)
    expect(workflows.workflows[0]).toMatchObject({ id: 'workflow-1', profile: 'default' })
    const workflow = JSON.parse((await waitForRpc(responses, 21)).result.content[0].text)
    expect(workflow.workflow).toMatchObject({ id: 'workflow-1', name: 'Demo workflow' })
    const createdWorkflow = JSON.parse((await waitForRpc(responses, 22)).result.content[0].text)
    expect(createdWorkflow.workflow.body).toMatchObject({
      name: 'Created workflow',
      profile: 'default',
      workspace: '/tmp/workflow',
      nodes: [{ id: 'node-1', type: 'agent' }],
      edges: [],
      viewport: { x: 1, y: 2, zoom: 0.8 },
    })
    const updatedWorkflow = JSON.parse((await waitForRpc(responses, 23)).result.content[0].text)
    expect(updatedWorkflow.workflow.body).toEqual({ name: 'Updated workflow', nodes: [{ id: 'node-2' }] })
    const workflowRuns = JSON.parse((await waitForRpc(responses, 24)).result.content[0].text)
    expect(workflowRuns.runs[0]).toMatchObject({ id: 'run-1', workflow_id: 'workflow-1' })
    const startedWorkflowRun = JSON.parse((await waitForRpc(responses, 25)).result.content[0].text)
    expect(startedWorkflowRun).toMatchObject({ ok: true, status: 'accepted' })
    expect(startedWorkflowRun.body).toEqual({ start_node_ids: ['node-1'], input: 'go', timeout_ms: 1000 })
    const stoppedWorkflowRun = JSON.parse((await waitForRpc(responses, 26)).result.content[0].text)
    expect(stoppedWorkflowRun.run).toMatchObject({ id: 'run-1', status: 'canceled' })
    const rerunWorkflowRun = JSON.parse((await waitForRpc(responses, 27)).result.content[0].text)
    expect(rerunWorkflowRun.body).toEqual({ node_id: 'node-2', preserve_start_node: true, timeout_ms: 2000 })
    const deletedWorkflowRun = JSON.parse((await waitForRpc(responses, 28)).result.content[0].text)
    expect(deletedWorkflowRun).toEqual({ ok: true, deleted_run: 'run-1' })
    const deletedWorkflow = JSON.parse((await waitForRpc(responses, 29)).result.content[0].text)
    expect(deletedWorkflow).toEqual({ ok: true, deleted_workflow: 'workflow-1' })

    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  it('filters exposed tools by MCP toolset argument', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/api/devices') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ devices: [{ id: 'device-1' }] }))
        return
      }
      res.statusCode = 404
      res.end('{}')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('expected TCP server address')

    const responses = new Map<number, any>()
    child = spawn(process.execPath, ['bin/ekko-studio-mcp.mjs', 'devices'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HERMES_WEB_UI_URL: `http://127.0.0.1:${address.port}`,
      },
    })
    child.stdout.on('data', (chunk) => {
      for (const line of String(chunk).trim().split('\n')) {
        if (!line) continue
        const message = JSON.parse(line)
        responses.set(message.id, message)
      }
    })

    writeRpc(child, 1, 'initialize', {})
    writeRpc(child, 2, 'tools/list')
    writeRpc(child, 3, 'tools/call', {
      name: 'ekko_studio_api_request',
      arguments: { path: '/health' },
    })
    writeRpc(child, 4, 'tools/call', {
      name: 'hermes_lan_devices_list',
      arguments: {},
    })
    writeRpc(child, 5, 'tools/call', {
      name: 'ekko_studio_devices_toolset',
      arguments: { action: 'list' },
    })
    writeRpc(child, 6, 'tools/call', {
      name: 'ekko_studio_devices_toolset',
      arguments: {
        action: 'call',
        tool: 'ekko_studio_lan_devices_list',
        arguments: {},
      },
    })

    const initialized = await waitForRpc(responses, 1)
    expect(initialized.result.serverInfo).toMatchObject({ toolset: 'devices' })
    expect(initialized.result.instructions).toContain('interactive terminal lifecycle')

    const list = await waitForRpc(responses, 2)
    expectProviderSafeToolNames('ekko-studio-devices', list.result.tools)
    expect(list.result.tools).toHaveLength(1)
    expect(list.result.tools[0].name).toBe('ekko_studio_devices_toolset')
    expect(list.result.tools[0].description).toContain('remote file upload/download')

    const catalog = JSON.parse((await waitForRpc(responses, 5)).result.content[0].text)
    expect(catalog).toMatchObject({ toolset: 'devices', operation_count: 14 })
    expect(catalog.operations.map((tool: any) => tool.name)).toEqual(expect.arrayContaining([
      'ekko_studio_lan_devices_list',
      'ekko_studio_lan_command_exec',
      'ekko_studio_lan_terminal_create',
      'ekko_studio_lan_terminal_read',
      'ekko_studio_lan_file_download',
      'ekko_studio_lan_file_upload',
    ]))

    const hiddenCall = await waitForRpc(responses, 3)
    expect(hiddenCall.result.isError).toBe(true)
    expect(hiddenCall.result.content[0].text).toContain("active 'devices' MCP toolset")

    const legacyDevicesCall = await waitForRpc(responses, 4)
    const legacyDevicesPayload = JSON.parse(legacyDevicesCall.result.content[0].text)
    expect(legacyDevicesPayload.devices[0].id).toBe('device-1')

    const gatewayDevicesCall = await waitForRpc(responses, 6)
    const gatewayDevicesPayload = JSON.parse(gatewayDevicesCall.result.content[0].text)
    expect(gatewayDevicesPayload.devices[0].id).toBe('device-1')

    await new Promise<void>(resolve => server.close(() => resolve()))
  })
})
