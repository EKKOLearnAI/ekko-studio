import { net, type Session } from 'electron'
import { isAllowedBrowserRequest } from './browser-url'
import { MAX_BROWSER_DOWNLOAD_BYTES } from './browser-files'

/** session.fetch rejects redirect:'manual' in Electron rather than returning 3xx.
 * ClientRequest exposes each redirect before following it, preserving both the
 * tab Session's cookies/proxy and the per-hop address policy. */
export function downloadBrowserFile(browserSession: Session, url: string, referer?: string): Promise<{
  data: Buffer; url: string; contentDisposition: string; mimeType: string
}> {
  if (!isAllowedBrowserRequest(url)) return Promise.reject(new Error('This address is blocked by the browser security policy'))
  return new Promise((resolve, reject) => {
    const request = net.request({ url, session: browserSession, redirect: 'manual', useSessionCookies: true })
    let settled = false
    let currentUrl = url
    let redirects = 0
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
      request.abort()
    }
    const timer = setTimeout(() => fail(new Error('Download timed out')), 120_000)
    if (referer) request.setHeader('Referer', referer)
    request.on('error', fail)
    request.on('redirect', (_status, _method, nextUrl) => {
      if (settled) return
      if (++redirects > 5) return fail(new Error('Download redirected too many times'))
      if (!isAllowedBrowserRequest(nextUrl)) return fail(new Error('This address is blocked by the browser security policy'))
      currentUrl = nextUrl
      request.followRedirect()
    })
    request.on('response', response => {
      if (settled) return
      if (response.statusCode < 200 || response.statusCode >= 300) return fail(new Error(`Download failed with HTTP ${response.statusCode}`))
      const header = (name: string) => {
        const value = response.headers[name]
        return Array.isArray(value) ? value[0] || '' : value || ''
      }
      if (Number(header('content-length')) > MAX_BROWSER_DOWNLOAD_BYTES) return fail(new Error('Download exceeds the 20 MB limit'))
      const chunks: Buffer[] = []
      let size = 0
      response.on('error', fail)
      response.on('aborted', () => fail(new Error('Download was aborted')))
      response.on('data', (chunk: Buffer) => {
        if (settled) return
        size += chunk.length
        if (size > MAX_BROWSER_DOWNLOAD_BYTES) return fail(new Error('Download exceeds the 20 MB limit'))
        chunks.push(Buffer.from(chunk))
      })
      response.on('end', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ data: Buffer.concat(chunks, size), url: currentUrl,
          contentDisposition: header('content-disposition'), mimeType: header('content-type').split(';')[0] })
      })
    })
    request.end()
  })
}
