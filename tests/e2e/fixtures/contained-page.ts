import { appendFileSync } from 'node:fs'
import type { Page } from '@playwright/test'

// Node-side helper for fixture-mounted specs. Installed before navigation: the page may load only Vite's
// own module/asset URLs; every proxied backend path, WebSocket and other host is blocked and recorded.
const PROXIED = ['/api', '/v1', '/health', '/upload', '/socket.io']

// `api` answers locally: return a JSON value, or `{ raw, contentType }` for a binary body.
export async function containPage(page: Page, api: (path: string, method: string) => unknown = () => ({})) {
  const attempted: string[] = []
  const blocked: string[] = []
  const apiPaths: string[] = []
  // Records scheme, host and path only: never query strings, fragments or tokens.
  const bare = (raw: string) => { const u = new URL(raw); return `${u.protocol}//${u.host}${u.pathname}` }
  const log = (entry: Record<string, unknown>) => {
    if (process.env.E2E_GUARD_LOG) appendFileSync(process.env.E2E_GUARD_LOG, JSON.stringify({ t: Date.now(), ...entry }) + '\n')
  }
  // Same origin as playwright.config.ts baseURL.
  const origin = `http://127.0.0.1:${Number(process.env.PLAYWRIGHT_PORT || 4173)}`
  page.on('request', request => attempted.push(request.url()))
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.origin === origin && !PROXIED.some(prefix => url.pathname === prefix || url.pathname.startsWith(prefix + '/'))) return route.continue()
    blocked.push(bare(url.href)); log({ blocked: bare(url.href), method: route.request().method() })
    return route.abort('blockedbyclient')
  })
  // Answered locally, never proxied: registered after the catch-all so it takes precedence for /api.
  await page.route(url => url.origin === origin && url.pathname.startsWith('/api/'), route => {
    const path = new URL(route.request().url()).pathname
    const method = route.request().method()
    log({ api: path, method })
    apiPaths.push(`${method} ${path}`)
    const answer = api(path, method) as any
    return answer && answer.raw ? route.fulfill({ body: answer.raw, contentType: answer.contentType }) : route.fulfill({ json: answer })
  })
  await page.routeWebSocket(/.*/, ws => { blocked.push(bare(ws.url())); log({ blocked_ws: bare(ws.url()) }); ws.close() })
  return { attempted, blocked, apiPaths }
}
