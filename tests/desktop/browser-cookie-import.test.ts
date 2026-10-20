import { request } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserCookieImport, normalizeImportCookies } from '../../packages/desktop/src/main/browser/browser-cookie-import'

const receivers: BrowserCookieImport[] = []
afterEach(async () => { vi.useRealTimers(); await Promise.all(receivers.splice(0).map(receiver => receiver.cancel())) })
const sample = { name: 'session', value: 'test-only', domain: '.example.com', path: '/', secure: true, httpOnly: true, sameSite: 'None', hostOnly: false }
const origin = `chrome-extension://${'a'.repeat(32)}`
async function setup() {
  const receiver = new BrowserCookieImport()
  receivers.push(receiver)
  return { receiver, status: await receiver.start('profile-a') }
}
function submit(url: string, data: unknown, headers: Record<string, string> = {}) {
  return new Promise<{ code: number; body: any }>((resolve, reject) => {
    const req = request(url + '/api/cookie-import-helper/submit', {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
    }, res => {
      let text = ''
      res.on('data', chunk => { text += chunk })
      res.on('end', () => resolve({ code: res.statusCode!, body: JSON.parse(text) }))
    })
    req.on('error', reject)
    req.end(JSON.stringify(data))
  })
}

describe('cookie import normalization', () => {
  it('preserves host-only and domain cookies with the same hostname, name and path', () => {
    const domain = { ...sample, domain: '.example.com', hostOnly: false }
    const host = { ...sample, domain: 'example.com', hostOnly: true }
    const cookies = normalizeImportCookies([domain, host])
    expect(cookies).toHaveLength(2)
    expect(cookies[0].domain).toBe('.example.com')
    expect(cookies[1].domain).toBeUndefined()
    expect(() => normalizeImportCookies([domain, domain])).toThrow('Duplicate cookie')
  })
  it('maps expiration, host-only and SameSite without leaking transport fields', () => {
    const expires = Math.floor(Date.now() / 1000) + 1000
    expect(normalizeImportCookies([{ ...sample, expires }])).toEqual([{
      url: 'https://example.com/', name: sample.name, value: sample.value,
      domain: '.example.com', path: '/', secure: true, httpOnly: true,
      sameSite: 'no_restriction', expirationDate: expires,
    }])
    const host = normalizeImportCookies([{ ...sample, domain: 'example.com', hostOnly: true, sameSite: 'Lax' }])[0]
    expect(host.domain).toBeUndefined()
    expect(host.sameSite).toBe('lax')
    expect(host.expirationDate).toBeUndefined()
  })

  it.each([
    [], Array(1001).fill(sample), [{ ...sample, partitionKey: { topLevelSite: 'https://example.com' } }],
    [{ ...sample, domain: 'evil.test@localhost' }], [{ ...sample, path: '/\r\n' }],
    [{ ...sample, value: 'bad\nvalue' }], [{ ...sample, expires: 1 }],
    [{ ...sample, sameSite: 'unknown' }], [{ ...sample, secure: false }], [sample, sample],
  ])('rejects malformed, expired, duplicate, oversized or partitioned input %#', input => {
    expect(() => normalizeImportCookies(input)).toThrow()
  })
})

describe('loopback cookie import receiver', () => {
  it('releases a rejected automatic import session so the extension can reconnect', async () => {
    const receiver = new BrowserCookieImport()
    receivers.push(receiver)
    const status = await receiver.start('profile-a', origin)
    const response = await submit(status.managerUrl, { token: status.token, cookies: [sample, sample] })
    expect(response.code).toBe(400)
    await vi.waitFor(() => expect(receiver.getStatus()).toBeNull(), { timeout: 500 })
    const next = await receiver.start('profile-a', origin)
    expect(next.token).not.toBe(status.token)
  })
  it('reports the validation category without returning cookie values', async () => {
    const { receiver, status } = await setup()
    const response = await submit(status.managerUrl, {
      token: status.token, cookies: [sample, sample],
    })
    expect(response).toEqual({ code: 400, body: { detail: 'Duplicate cookie' } })
    expect(JSON.stringify(response)).not.toContain(sample.value)
    expect(receiver.getStatus()?.phase).toBe('waiting')
  })

  it('separates apply failures and never returns raw callback errors', async () => {
    const receiver = new BrowserCookieImport(async () => { throw new Error('private-cookie-value') })
    receivers.push(receiver)
    const status = await receiver.start('profile-a')
    const response = await submit(status.managerUrl, { token: status.token, cookies: [sample] })
    expect(response).toEqual({ code: 500, body: { detail: 'Cookie import failed while applying or saving cookies' } })
    expect(JSON.stringify(response)).not.toContain('private-cookie-value')
  })

  it('stages once, exposes only metadata and requires a separate take to write', async () => {
    const { receiver, status } = await setup()
    expect(new URL(status.managerUrl).hostname).toBe('127.0.0.1')
    expect(status.token).toHaveLength(64)
    const response = await submit(status.managerUrl, { token: status.token, cookies: [sample] })
    expect(response).toEqual({ code: 202, body: { cookie_count: 1, status: 'pending_confirmation' } })
    expect(receiver.getStatus()).toMatchObject({ profileId: 'profile-a', phase: 'review', token: '', domains: ['example.com'], cookieCount: 1 })
    expect(JSON.stringify(receiver.getStatus())).not.toContain('test-only')
    expect((await submit(status.managerUrl, { token: status.token, cookies: [sample] })).code).toBe(403)
    const pending = await receiver.take()
    expect(pending.profileId).toBe('profile-a')
    expect(pending.cookies).toHaveLength(1)
    expect(receiver.getStatus()).toBeNull()
    await expect(receiver.take()).rejects.toThrow('No pending')
  })

  it('rejects missing/wrong tokens, web origins and rebinding hosts', async () => {
    const { receiver, status } = await setup()
    for (const token of ['', 'wrong', undefined]) {
      expect((await submit(status.managerUrl, { token, cookies: [sample] })).code).toBe(403)
    }
    expect((await submit(status.managerUrl, { token: status.token, cookies: [sample] }, { Origin: 'https://evil.test' })).code).toBe(403)
    expect((await submit(status.managerUrl, { token: status.token, cookies: [sample] }, { Host: 'evil.test' })).code).toBe(403)
    expect((await submit(status.managerUrl, { token: status.token, cookies: [sample] }, { 'Content-Type': 'text/plain' })).code).toBe(415)
    expect(receiver.getStatus()?.phase).toBe('waiting')
  })

  it('does not consume the code for invalid data and enforces payload limits', async () => {
    const { receiver, status } = await setup()
    expect((await submit(status.managerUrl, { token: status.token, cookies: [] })).code).toBe(400)
    expect((await submit(status.managerUrl, { token: status.token, cookies: [], padding: 'x'.repeat(1024 * 1024) })).code).toBe(413)
    expect(receiver.getStatus()?.phase).toBe('waiting')
  })

  it('drops pending data on cancel and invalidates expired codes', async () => {
    const { receiver, status } = await setup()
    await submit(status.managerUrl, { token: status.token, cookies: [sample] })
    await receiver.cancel()
    await expect(receiver.take()).rejects.toThrow()
    const next = await receiver.start('profile-b')
    vi.spyOn(Date, 'now').mockReturnValue(next.expiresAt + 1)
    expect(receiver.getStatus()).toBeNull()
    await expect(receiver.take()).rejects.toThrow()
    vi.restoreAllMocks()
  })
})

it('requires trusted main-window IPC for approval and does not expose import through agent broker', async () => {
  const { readFile } = await import('node:fs/promises')
  const main = await readFile('packages/desktop/src/main/index.ts', 'utf8')
  for (const action of ['start', 'status', 'cancel', 'confirm']) {
    expect(main).toMatch(new RegExp(`ipcMain\\.handle\\('hermes-desktop:browser-cookie-import-${action}'.*browserForEvent\\(event\\)`))
  }
  expect(main).toContain('event.sender !== mainWindow.webContents')
  const broker = await readFile('packages/desktop/src/main/browser/browser-broker.ts', 'utf8')
  expect(broker).not.toContain('confirmCookieImport')
  expect(broker).not.toContain('startCookieImport')
})
