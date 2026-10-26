import { EventEmitter } from 'node:events'
import { expect, it, vi, afterEach } from 'vitest'
const mock = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('electron', () => ({ net: mock }))
import { downloadBrowserFile } from '../../packages/desktop/src/main/browser/browser-download'
import type { Session } from 'electron'
function fixture() {
  const request = Object.assign(new EventEmitter(), { abort: vi.fn(), followRedirect: vi.fn(), setHeader: vi.fn(), end: vi.fn() })
  mock.request.mockReturnValue(request)
  const session = {} as Session
  return { request, session }
}
afterEach(() => vi.clearAllMocks())
it('checks redirect hops before following and keeps the original Session cookies', async () => {
  const { request, session } = fixture()
  const pending = downloadBrowserFile(session, 'https://files.test/start', 'https://files.test/')
  expect(mock.request).toHaveBeenCalledWith({ url: 'https://files.test/start', session, redirect: 'manual', useSessionCookies: true })
  request.emit('redirect', 302, 'GET', 'https://files.test/final')
  expect(request.followRedirect).toHaveBeenCalledOnce()
  const response = Object.assign(new EventEmitter(), { statusCode: 200, headers: { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="a.txt"' } })
  request.emit('response', response); response.emit('data', Buffer.from('proof')); response.emit('end')
  await expect(pending).resolves.toMatchObject({ url: 'https://files.test/final', data: Buffer.from('proof'), mimeType: 'text/plain' })
})
it('blocks unsafe redirect before following it', async () => {
  const { request, session } = fixture()
  const pending = downloadBrowserFile(session, 'https://files.test/start')
  request.emit('redirect', 302, 'GET', 'http://169.254.169.254/metadata')
  await expect(pending).rejects.toThrow('blocked')
  expect(request.followRedirect).not.toHaveBeenCalled(); expect(request.abort).toHaveBeenCalledOnce()
})
it('limits redirects and streamed bytes', async () => {
  let f = fixture(); let pending = downloadBrowserFile(f.session, 'https://files.test/start')
  for (let i=0;i<6;i++) f.request.emit('redirect',302,'GET','https://files.test/'+i)
  await expect(pending).rejects.toThrow('too many')
  f=fixture();pending=downloadBrowserFile(f.session,'https://files.test/start')
  const response=Object.assign(new EventEmitter(),{statusCode:200,headers:{}})
  f.request.emit('response',response);response.emit('data',Buffer.alloc(20*1024*1024+1))
  await expect(pending).rejects.toThrow('20 MB')
})
