import { createServer, type Server } from 'node:http'
import { request, type APIRequestContext } from '@playwright/test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { authenticateScreenshot, parseScreenshotOptions, storedScreenshotToken } from '../../scripts/studio-screenshot'

describe('Studio screenshot authentication', () => {
  let server: Server
  let api: APIRequestContext
  let baseUrl: string
  let received: { path: string; authorization?: string; body: unknown }[]

  beforeEach(async () => {
    received = []
    server = createServer(async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null
      received.push({ path: req.url!, authorization: req.headers.authorization, body })
      res.setHeader('Content-Type', 'application/json')
      if (req.url === '/studio/api/auth/login' && body?.username === 'capture' && body?.password === 'test-password') {
        res.end(JSON.stringify({ token: 'valid-test-token' }))
      } else if (req.url === '/studio/api/auth/me' && req.headers.authorization === 'Bearer valid-test-token') {
        res.end(JSON.stringify({ user: { id: 1 } }))
      } else if (req.headers.authorization === 'Bearer html-response') {
        res.setHeader('Content-Type', 'text/html')
        res.end('<html>Login</html>')
      } else {
        res.statusCode = 401
        res.end(JSON.stringify({ error: 'Unauthorized' }))
      }
    })
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No test server')
    baseUrl = `http://127.0.0.1:${address.port}/studio/`
    api = await request.newContext({ timeout: 2000 })
  })

  afterEach(async () => {
    await api?.dispose()
    if (server) await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()))
  })

  it('logs in once and validates the returned token, retaining a deployment prefix', async () => {
    await expect(authenticateScreenshot(api, baseUrl, { username: 'capture', password: 'test-password' })).resolves.toBe('valid-test-token')
    expect(received).toEqual([
      { path: '/studio/api/auth/login', authorization: undefined, body: { username: 'capture', password: 'test-password' } },
      { path: '/studio/api/auth/me', authorization: 'Bearer valid-test-token', body: null },
    ])
  })

  it('validates a saved token without another password login', async () => {
    await expect(authenticateScreenshot(api, baseUrl, { token: 'valid-test-token' })).resolves.toBe('valid-test-token')
    expect(received.map(item => item.path)).toEqual(['/studio/api/auth/me'])
  })

  it('rejects missing credentials before making requests', async () => {
    await expect(authenticateScreenshot(api, baseUrl, {})).rejects.toThrow('No Studio login')
    expect(received).toEqual([])
  })

  it('rejects failed logins and HTML login responses instead of accepting HTTP 200', async () => {
    await expect(authenticateScreenshot(api, baseUrl, { username: 'capture', password: 'wrong-password' }))
      .rejects.toThrow('Studio login failed (HTTP 401)')
    expect(received).toHaveLength(1)
    await expect(authenticateScreenshot(api, baseUrl, { token: 'html-response' })).rejects.toThrow('invalid or expired')
  })

  it('never reuses a token saved for another origin', () => {
    const state = { cookies: [], origins: [{ origin: 'http://localhost:8649', localStorage: [{ name: 'hermes_api_key', value: 'local-token' }] }] }
    expect(storedScreenshotToken(state, 'http://localhost:8649/studio/')).toBe('local-token')
    expect(storedScreenshotToken(state, 'http://localhost:8650/')).toBeUndefined()
    expect(storedScreenshotToken(state, 'https://studio.example/')).toBeUndefined()
  })
})

describe('Studio screenshot targets', () => {
  it('uses custom routes without also capturing default pages', () => {
    const options = parseScreenshotOptions(['--mock', '--route', '/hermes/models?tab=api', '--viewport', '390x844'])
    if (options.help) throw new Error('Unexpected help')
    expect(options.targets.map(item => item.route)).toEqual(['/hermes/models?tab=api'])
    expect(options.viewport).toEqual({ width: 390, height: 844 })
  })

  it('rejects ambiguous mock/live capture and invalid destinations', () => {
    expect(() => parseScreenshotOptions(['--mock', '--base-url', 'http://localhost:8649'])).toThrow('isolated frontend')
    expect(() => parseScreenshotOptions(['--route', 'https://example.com'])).toThrow('router path')
    expect(() => parseScreenshotOptions(['--pages', 'unknown'])).toThrow('Unknown page')
    expect(() => parseScreenshotOptions(['--base-url', 'https://user:password@example.com'])).toThrow('without credentials')
    expect(() => parseScreenshotOptions(['--viewport', '0x844'])).toThrow('--viewport')
  })
})
