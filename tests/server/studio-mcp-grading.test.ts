import { createServer } from 'node:http'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { expect, it } from 'vitest'

it('returns grading images over stdio and keeps grading tools inside the API toolset', async () => {
  const requests: string[] = []
  const clients: Client[] = []
  const http = createServer(async (req, res) => {
    requests.push(req.url!)
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk)
    expect(JSON.parse(Buffer.concat(chunks).toString())).toMatchObject({ scanId: 'paper' })
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ image: 'data:image/jpeg;base64,YWJj', width: 10, height: 20 }))
  })
  http.listen(0, '127.0.0.1')
  await once(http, 'listening')
  const connect = async (toolset: string) => {
    const client = new Client({ name: 'grading-test', version: '1' })
    clients.push(client)
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [resolve('bin/ekko-studio-mcp.mjs'), toolset], env: {
        PATH: process.env.PATH || '', HERMES_WEB_UI_URL: `http://127.0.0.1:${(http.address() as any).port}`,
        HERMES_WEB_UI_TOKEN: 'test-only',
      } }))
    return client
  }
  try {
    const api = await connect('api')
    for (const action of ['view_image', 'preview']) {
      const result = await api.callTool({ name: `grading_${action}`, arguments: { scanId: 'paper' } })
      expect(result.isError).not.toBe(true)
      expect(result.content).toContainEqual({ type: 'image', data: 'YWJj', mimeType: 'image/jpeg' })
    }
    expect(requests).toEqual(['/api/studio/scanner/grading/view_image', '/api/studio/scanner/grading/preview'])
    for (const toolset of ['browser', 'plan', 'devices']) {
      const scoped = await connect(toolset)
      expect((await scoped.callTool({ name: 'grading_preview', arguments: { scanId: 'paper' } })).isError).toBe(true)
    }
    expect(requests).toHaveLength(2)
  } finally {
    await Promise.allSettled(clients.map(client => client.close()))
    http.closeAllConnections()
    await new Promise<void>(done => http.close(() => done()))
  }
})
