import { Readable } from 'node:stream'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createCodexProxyRequestBodyParser } from '../../packages/server/src/modules/studio/middleware/request-body-parser'

describe('bootstrap body parser limits', () => {
  it('keeps the global parser at 20 MiB and isolates the Codex proxy allowance', () => {
    const source = readFileSync('packages/server/src/modules/studio/middleware/request-body-parser.ts', 'utf8')
    const bootstrap = readFileSync('packages/server/src/bootstrap/http.ts', 'utf8')

    expect(source).toContain("jsonLimit: '20mb'")
    expect(source).toContain("formLimit: '20mb'")
    expect(source).toContain('v1\\/responses|gemini\\/v1beta\\/models')
    expect(source.indexOf('if (!isAuthorized(ctx))')).toBeLessThan(source.indexOf('return parse(ctx, next)'))
    expect(source).toContain("jsonLimit: '64mb'")
    expect(bootstrap.indexOf('createCodexProxyRequestBodyParser(isAuthorizedCodexProxyRequest)')).toBeLessThan(bootstrap.indexOf('createRequestBodyParser()'))
  })

  it('parses DELETE request bodies for file operations', () => {
    const source = readFileSync('packages/server/src/modules/studio/middleware/request-body-parser.ts', 'utf8')

    expect(source).toMatch(/parsedMethods:\s*\[\s*'POST',\s*'PUT',\s*'PATCH',\s*'DELETE'\s*\]/)
  })

  it('rejects unauthorized Codex proxy bodies before reading the request stream', async () => {
    let reads = 0
    const request = new Readable({
      read() {
        reads += 1
        this.push('{"input":[]}')
        this.push(null)
      },
    }) as any
    request.headers = { 'content-type': 'application/json' }
    request.method = 'POST'
    const ctx: any = {
      method: 'POST',
      path: '/api/codex-proxy/unknown/v1/responses',
      req: request,
      request: { req: request },
    }
    const middleware = createCodexProxyRequestBodyParser(() => false)

    await middleware(ctx, async () => {})

    expect(ctx.status).toBe(401)
    expect(reads).toBe(0)
  })

  it('parses an authorized Codex proxy JSON body above the global 20 MiB limit', async () => {
    const payload = JSON.stringify({ input: 'x'.repeat(20 * 1024 * 1024 + 1) })
    const request = Readable.from([payload]) as any
    request.headers = {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(payload)),
    }
    request.method = 'POST'
    const ctx: any = {
      method: 'POST',
      path: '/api/codex-proxy/authorized/v1/responses',
      req: request,
      request: {
        req: request,
        get(name: string) {
          return request.headers[name.toLowerCase()] || ''
        },
      },
    }
    const middleware = createCodexProxyRequestBodyParser(() => true)

    await middleware(ctx, async () => {})

    expect(ctx.request.body.input).toHaveLength(20 * 1024 * 1024 + 1)
  })
})
