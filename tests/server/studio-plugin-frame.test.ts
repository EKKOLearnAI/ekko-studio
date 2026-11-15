import { expect, it } from 'vitest'
import { securityHeaders } from '../../packages/server/src/modules/studio/middleware/security'
import { getStaticCacheControl } from '../../packages/server/src/modules/studio/middleware/static-cache'

async function headersFor(path: string, method = 'GET') {
  const headers = new Map<string, string>()
  await securityHeaders()({ method, path, query: {}, secure: false, get: () => '',
    set: (name: string, value: string) => headers.set(name, value),
  } as any, async () => {})
  return headers
}

it('allows plugin documents to load resources while limiting embedding to the host origin', async () => {
  for (const method of ['GET', 'HEAD']) {
    const headers = await headersFor('/plugin-frame.html', method)
    expect(headers.get('X-Frame-Options')).toBe('SAMEORIGIN')
    expect(headers.get('Content-Security-Policy')).toBe("frame-ancestors 'self'")
  }
  expect(getStaticCacheControl('plugin-frame.html')).toBe('no-cache')
})

it('keeps regular Studio documents and non-document requests under the standard policy', async () => {
  for (const [path, method] of [['/', 'GET'], ['/studio/plugins/example/home', 'GET'], ['/plugin-frame.html', 'POST']]) {
    const headers = await headersFor(path, method)
    expect(headers.get('X-Frame-Options')).toBe('DENY')
    expect(headers.get('Content-Security-Policy')).toContain("default-src 'self'")
    expect(headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'")
  }
})
