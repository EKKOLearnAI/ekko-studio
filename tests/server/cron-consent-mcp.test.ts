import { createServer } from 'http'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'

// The generic MCP API discovery is the model's path to the consent request endpoint: the generated
// catalog must describe its request body exactly. A local HTTP server serves the real generated
// docs/openapi.json; nothing reaches a Studio instance.
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

describe('cron consent MCP discovery', () => {
  let child: ChildProcessWithoutNullStreams | null = null

  afterEach(() => {
    child?.kill()
    child = null
  })

  it('compact discovery of the generated catalog lists the cron consent request fields, including target_session_id', async () => {
    const openapi = readFileSync(join(process.cwd(), 'docs', 'openapi.json'), 'utf8')
    const server = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(openapi) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('expected TCP server address')
    const responses = new Map<number, any>()
    child = spawn(process.execPath, ['bin/ekko-studio-mcp.mjs', 'api'], {
      cwd: process.cwd(), env: { ...process.env, HERMES_WEB_UI_URL: `http://127.0.0.1:${address.port}`, AUTH_TOKEN: 'test-token', HERMES_MCP_TOOLSET: '' },
    })
    child.stdout.on('data', chunk => {
      for (const line of String(chunk).trim().split('\n')) if (line) { const message = JSON.parse(line); responses.set(message.id, message) }
    })
    writeRpc(child, 1, 'initialize', {})
    writeRpc(child, 2, 'tools/call', { name: 'ekko_studio_api_openapi_get', arguments: { tag: 'Cron Consent' } })
    const catalog = JSON.parse((await waitForRpc(responses, 2)).result.content[0].text)
    server.close()
    const operation = catalog.operations.find((item: any) => item.method === 'POST' && item.path === '/api/hermes/cron/consent-requests')
    const fields = Object.fromEntries(operation.requestBody.fields.map((field: any) => [field.name, field]))
    expect(fields.target_session_id).toMatchObject({ type: 'string', required: false })
    expect(['profile', 'context_id', 'kind'].every(name => fields[name]?.required)).toBe(true)
    expect(fields).not.toHaveProperty('session_id')
  })
})
