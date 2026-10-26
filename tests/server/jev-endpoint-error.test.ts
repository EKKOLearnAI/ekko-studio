import { createServer } from 'node:http'
import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import { evaluateJevWithCredentials } from '../../packages/server/src/modules/studio/services/jev/client'
import type { JevCredentialSettings } from '../../packages/server/src/modules/studio/services/jev/settings'

describe('JEV endpoint diagnostics over HTTP', () => {
  it('distinguishes a missing gateway prefix from authentication failure without leaking upstream details', async () => {
    const paths: string[] = []
    const server = createServer((req, res) => {
      paths.push(req.url || '')
      res.writeHead(req.url === '/typesafe/v1/systemone' ? 401 : 404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'private upstream details and credentials' } }))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
      const request = { state: 'private input', questions: { valid: { type: 'noul' as const, instructions: 'valid?' } } }
      for (const [suffix, code, status] of [['', 'jev_endpoint_not_found', 404], ['/typesafe', 'jev_auth_failed', 401]] as const) {
        const settings = { baseUrl: origin + suffix, apiKey: 'private-key', model: 'fixture', timeoutMs: 3000 } as JevCredentialSettings
        await expect(evaluateJevWithCredentials(settings, request)).rejects.toMatchObject({
          status: 502, code, message: `JEV provider returned HTTP ${status}`,
        })
      }
      expect(paths).toEqual(['/v1/systemone', '/typesafe/v1/systemone'])
    } finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
