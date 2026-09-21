// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// vi.mock is hoisted, so mockReplace must be inside the factory
vi.mock('@/router', () => ({
  default: {
    currentRoute: { value: { name: 'hermes.chat' } },
    replace: vi.fn(),
  },
}))

import { getApiKey, setApiKey, clearApiKey, hasApiKey, getStoredUserRole, isStoredSuperAdmin, request } from '../../packages/client/src/api/client'
import { downloadFile, getDownloadUrl } from '../../packages/client/src/api/studio/download'
import { uploadFiles } from '../../packages/client/src/api/studio/files'
import { importSkill } from '../../packages/client/src/api/hermes/skills'
import { archiveSession, batchDeleteSessions, exportSession, fetchHermesSessionGroups, fetchHermesSessionPage, importHermesSession, unarchiveSession } from '../../packages/client/src/api/studio/sessions'
import router from '@/router'

function fakeJwt(payload: Record<string, unknown>) {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const body = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${header}.${body}.signature`
}

describe('API Client', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
  })

  describe('token management', () => {
    it('hasApiKey returns false when no token', () => {
      expect(hasApiKey()).toBe(false)
    })

    it('hasApiKey returns true after setApiKey', () => {
      setApiKey('test-token')
      expect(hasApiKey()).toBe(true)
    })

    it('getApiKey returns the stored token', () => {
      setApiKey('my-token')
      expect(getApiKey()).toBe('my-token')
    })

    it('clearApiKey removes the token', () => {
      setApiKey('my-token')
      clearApiKey()
      expect(hasApiKey()).toBe(false)
      expect(getApiKey()).toBe('')
    })

    it('reads the role from the stored JWT payload', () => {
      setApiKey(fakeJwt({ sub: '1', role: 'super_admin' }))

      expect(getStoredUserRole()).toBe('super_admin')
      expect(isStoredSuperAdmin()).toBe(true)

      setApiKey(fakeJwt({ sub: '2', role: 'admin' }))
      expect(getStoredUserRole()).toBe('admin')
      expect(isStoredSuperAdmin()).toBe(false)
    })
  })

  describe('request', () => {
    it('adds Authorization header when token exists', async () => {
      setApiKey('secret-key')
      mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => ({ data: 1 }) })

      await request('/api/studio/sessions')

      expect(mockFetch).toHaveBeenCalledOnce()
      const [, options] = mockFetch.mock.calls[0]
      expect(options.headers.Authorization).toBe('Bearer secret-key')
    })

    it('adds the active profile header, including default', async () => {
      localStorage.setItem('hermes_active_profile_name', 'default')
      mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => ({ data: 1 }) })

      await request('/api/studio/sessions/session-1')

      const [, options] = mockFetch.mock.calls[0]
      expect(options.headers['X-Hermes-Profile']).toBe('default')
    })

    it('does not add the active profile header to profile-wide session collection requests', async () => {
      localStorage.setItem('hermes_active_profile_name', 'research')
      mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => ({ data: 1 }) })

      await request('/api/studio/sessions')

      const [, options] = mockFetch.mock.calls[0]
      expect(options.headers['X-Hermes-Profile']).toBeUndefined()
    })

    it('does not add Authorization header when no token', async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => ({ data: 1 }) })

      await request('/api/studio/sessions')

      const [, options] = mockFetch.mock.calls[0]
      expect(options.headers.Authorization).toBeUndefined()
    })

    it('clears token and redirects on 401 for local BFF endpoints', async () => {
      setApiKey('secret-key')
      localStorage.setItem('hermes_active_profile_name', 'research')
      mockFetch.mockResolvedValue({ ok: false, status: 401 })

      await expect(request('/api/studio/sessions')).rejects.toThrow('Unauthorized')
      expect(hasApiKey()).toBe(false)
      expect(localStorage.getItem('hermes_active_profile_name')).toBeNull()
      expect(router.replace).toHaveBeenCalledWith({ name: 'login' })
    })

    it('emits a global auth notice on local 403 responses', async () => {
      const listener = vi.fn()
      window.addEventListener('hermes-auth-notice', listener)
      localStorage.setItem('hermes_active_profile_name', 'research')
      mockFetch.mockResolvedValue({ ok: false, status: 403, text: () => Promise.resolve('Forbidden') })

      await expect(request('/api/hermes/profiles')).rejects.toThrow('API Error 403')

      expect(listener).toHaveBeenCalledOnce()
      expect(listener.mock.calls[0][0].detail).toEqual({ kind: 'forbidden' })
      expect(localStorage.getItem('hermes_active_profile_name')).toBe('research')
      window.removeEventListener('hermes-auth-notice', listener)
    })

    it('clears token and redirects when the JWT user no longer exists', async () => {
      setApiKey('stale-jwt')
      localStorage.setItem('hermes_active_profile_name', 'research')
      mockFetch.mockResolvedValue({
        ok: false,
        status: 403,
        text: () => Promise.resolve('{"error":"User is disabled or does not exist"}'),
      })

      await expect(request('/api/hermes/profiles')).rejects.toThrow('API Error 403')

      expect(hasApiKey()).toBe(false)
      expect(localStorage.getItem('hermes_active_profile_name')).toBeNull()
      expect(router.replace).toHaveBeenCalledWith({ name: 'login' })
    })

    it('does NOT clear token on 401 for proxied v1 endpoints', async () => {
      setApiKey('secret-key')
      localStorage.setItem('hermes_active_profile_name', 'research')
      mockFetch.mockResolvedValue({ ok: false, status: 401, text: () => Promise.resolve('') })

      await expect(request('/api/hermes/v1/runs')).rejects.toThrow('API Error 401')
      expect(hasApiKey()).toBe(true)
      expect(localStorage.getItem('hermes_active_profile_name')).toBe('research')
    })

    it('throws error on non-401 failure', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      })

      await expect(request('/api/studio/sessions')).rejects.toThrow('API Error 500: Internal Server Error')
    })

    it('extracts nested JSON error messages instead of stringifying objects', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve(JSON.stringify({
          error: {
            message: 'spawn claude ENOENT',
            code: 'ENOENT',
          },
        })),
      })

      await expect(request('/api/coding-agents/runs/session-1/input')).rejects.toThrow('API Error 500: spawn claude ENOENT')
    })

    it('preserves application error status and code for localized handling', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 409,
        statusText: 'Conflict',
        text: () => Promise.resolve(JSON.stringify({
          code: 'GROUP_AGENT_PRESET_NAME_CONFLICT',
          error: 'Agent preset already exists',
        })),
      })

      await expect(request('/api/studio/group-chat/agent-presets')).rejects.toMatchObject({
        status: 409,
        code: 'GROUP_AGENT_PRESET_NAME_CONFLICT',
        message: 'API Error 409: Agent preset already exists',
      })
    })

    it('returns parsed JSON on success', async () => {
      const data = { sessions: [{ id: '1' }] }
      mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(data) })

      const result = await request('/api/studio/sessions')
      expect(result).toEqual(data)
    })
  })

  describe('download URLs', () => {
    it('adds the active profile selector to direct download URLs', () => {
      setApiKey('secret-key')
      localStorage.setItem('hermes_active_profile_name', 'research')

      const url = new URL(getDownloadUrl('/tmp/report.txt', 'report.txt'), 'http://localhost')

      expect(url.pathname).toBe('/api/studio/files/download')
      expect(url.searchParams.get('path')).toBe('/tmp/report.txt')
      expect(url.searchParams.get('name')).toBe('report.txt')
      expect(url.searchParams.get('profile')).toBe('research')
      expect(url.searchParams.get('token')).toBe('secret-key')
    })

    it('uses an explicit profile selector for direct download URLs', () => {
      setApiKey('secret-key')
      localStorage.setItem('hermes_active_profile_name', 'research')

      const url = new URL(getDownloadUrl('/tmp/reviewer.txt', 'reviewer.txt', 'reviewer'), 'http://localhost')

      expect(url.searchParams.get('path')).toBe('/tmp/reviewer.txt')
      expect(url.searchParams.get('name')).toBe('reviewer.txt')
      expect(url.searchParams.get('profile')).toBe('reviewer')
      expect(url.searchParams.get('token')).toBe('secret-key')
    })

    it('handles raw percent signs in download paths and filenames', () => {
      const url = new URL(getDownloadUrl('/tmp/100% ready.txt', '100% ready.txt'), 'http://localhost')

      expect(url.pathname).toBe('/api/studio/files/download')
      expect(url.searchParams.get('path')).toBe('/tmp/100% ready.txt')
      expect(url.searchParams.get('name')).toBe('100% ready.txt')
    })

    it('uses the target basename when a supplied download label has no extension', () => {
      const url = new URL(getDownloadUrl('/tmp/report.md', '下载报告'), 'http://localhost')

      expect(url.pathname).toBe('/api/studio/files/download')
      expect(url.searchParams.get('path')).toBe('/tmp/report.md')
      expect(url.searchParams.get('name')).toBe('report.md')
    })

    it('preserves explicit custom download names that already include an extension', () => {
      const url = new URL(getDownloadUrl('/tmp/report.md', 'custom-name.md'), 'http://localhost')

      expect(url.searchParams.get('path')).toBe('/tmp/report.md')
      expect(url.searchParams.get('name')).toBe('custom-name.md')
    })

    it('sets the browser download name from the path when the label has no extension', async () => {
      const blob = new Blob(['report'])
      mockFetch.mockResolvedValue({
        ok: true,
        blob: () => Promise.resolve(blob),
      })
      const createObjectUrl = vi.fn(() => 'blob:download')
      const revokeObjectUrl = vi.fn()
      const OriginalUrl = URL
      class DownloadUrl extends OriginalUrl {}
      Object.defineProperties(DownloadUrl, {
        createObjectURL: { value: createObjectUrl },
        revokeObjectURL: { value: revokeObjectUrl },
      })
      vi.stubGlobal('URL', DownloadUrl)
      const originalCreateElement = document.createElement.bind(document)
      const downloadAnchor = originalCreateElement('a') as HTMLAnchorElement
      vi.spyOn(downloadAnchor, 'click').mockImplementation(() => undefined)
      const createElementSpy = vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
        return tagName.toLowerCase() === 'a' ? downloadAnchor : originalCreateElement(tagName)
      })

      try {
        await expect(downloadFile('/tmp/report.md', '下载报告')).resolves.toBeUndefined()
        expect(downloadAnchor.download).toBe('report.md')
        expect(revokeObjectUrl).toHaveBeenCalledWith('blob:download')
      } finally {
        createElementSpy.mockRestore()
        vi.unstubAllGlobals()
        vi.stubGlobal('fetch', mockFetch)
      }
    })

    it('exports sessions when the response filename contains a raw percent sign', async () => {
      const blob = new Blob(['session'])
      mockFetch.mockResolvedValue({
        ok: true,
        blob: () => Promise.resolve(blob),
        headers: new Headers({
          'Content-Disposition': 'attachment; filename="100% ready.json"',
        }),
      })
      const createObjectUrl = vi.fn(() => 'blob:session-export')
      const revokeObjectUrl = vi.fn()
      const OriginalUrl = URL
      class ExportUrl extends OriginalUrl {}
      Object.defineProperties(ExportUrl, {
        createObjectURL: { value: createObjectUrl },
        revokeObjectURL: { value: revokeObjectUrl },
      })
      vi.stubGlobal('URL', ExportUrl)
      const originalCreateElement = document.createElement.bind(document)
      const downloadAnchor = originalCreateElement('a') as HTMLAnchorElement
      vi.spyOn(downloadAnchor, 'click').mockImplementation(() => undefined)
      const createElementSpy = vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
        return tagName.toLowerCase() === 'a' ? downloadAnchor : originalCreateElement(tagName)
      })

      try {
        await expect(exportSession('session-1')).resolves.toBeUndefined()
        expect(downloadAnchor.download).toBe('100% ready.json')
        expect(revokeObjectUrl).toHaveBeenCalledWith('blob:session-export')
      } finally {
        createElementSpy.mockRestore()
        vi.unstubAllGlobals()
        vi.stubGlobal('fetch', mockFetch)
      }
    })
  })

  describe('file upload', () => {
    it('adds auth and active profile headers to multipart uploads', async () => {
      setApiKey('secret-key')
      localStorage.setItem('hermes_active_profile_name', 'research')
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ files: [] }),
      })

      await uploadFiles('notes', [new File(['hello'], 'hello.txt', { type: 'text/plain' })])

      expect(mockFetch).toHaveBeenCalledOnce()
      const [url, options] = mockFetch.mock.calls[0]
      expect(url).toBe('/api/studio/files/upload?path=notes')
      expect(options.method).toBe('POST')
      expect(options.headers.Authorization).toBe('Bearer secret-key')
      expect(options.headers['X-Hermes-Profile']).toBe('research')
      expect(options.body).toBeInstanceOf(FormData)
    })

    it('uses an explicit profile selector instead of the active profile header', async () => {
      setApiKey('secret-key')
      localStorage.setItem('hermes_active_profile_name', 'research')
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ files: [] }),
      })

      await uploadFiles('notes', [new File(['hello'], 'hello.txt', { type: 'text/plain' })], 'reviewer')

      const [url, options] = mockFetch.mock.calls[0]
      expect(url).toBe('/api/studio/files/upload?path=notes&profile=reviewer')
      expect(options.headers.Authorization).toBe('Bearer secret-key')
      expect(options.headers['X-Hermes-Profile']).toBeUndefined()
    })

    it('adds auth and active profile headers when importing skills', async () => {
      setApiKey('secret-key')
      localStorage.setItem('hermes_active_profile_name', 'research')
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve('{"name":"demo-skill"}'),
      })

      await importSkill([new File(['# Demo\n'], 'demo.zip', { type: 'application/zip' })])

      expect(mockFetch).toHaveBeenCalledOnce()
      const [url, options] = mockFetch.mock.calls[0]
      expect(url).toBe('/api/hermes/skills/import')
      expect(options.method).toBe('POST')
      expect(options.headers.Authorization).toBe('Bearer secret-key')
      expect(options.headers['X-Hermes-Profile']).toBe('research')
      expect(options.body).toBeInstanceOf(FormData)
    })
  })

  describe('sessions API', () => {
    it('requests source-group pages with pinned and routed sessions included', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ groups: [], included: [] }),
      })

      await fetchHermesSessionGroups(20, 'travel', ['pinned-1', 'route-1'])

      const [url] = mockFetch.mock.calls[0]
      expect(url).toBe('/api/studio/sessions/hermes/groups?limit=20&profile=travel&include=pinned-1&include=route-1')
    })

    it('requests the next page for one Hermes history source', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ sessions: [], hasMore: false, offset: 20, limit: 20 }),
      })

      await fetchHermesSessionPage('cli', 20, 20, 'travel')

      const [url] = mockFetch.mock.calls[0]
      expect(url).toBe('/api/studio/sessions/hermes?source=cli&offset=20&limit=20&profile=travel')
    })

    it('sends profile-qualified targets for batch deletes', async () => {
      localStorage.setItem('hermes_active_profile_name', 'research')
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ deleted: 2, failed: 0, errors: [] }),
      })

      await batchDeleteSessions([
        { id: 'session-default', profile: 'default' },
        { id: 'session-travel', profile: 'travel' },
      ])

      const [url, options] = mockFetch.mock.calls[0]
      expect(url).toBe('/api/studio/sessions/batch-delete')
      expect(options.method).toBe('POST')
      expect(options.headers['X-Hermes-Profile']).toBeUndefined()
      expect(JSON.parse(options.body)).toEqual({
        ids: ['session-default', 'session-travel'],
        sessions: [
          { id: 'session-default', profile: 'default' },
          { id: 'session-travel', profile: 'travel' },
        ],
      })
    })

    it('sends the profile selector when importing a Hermes session', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ok: true, imported: true }),
      })

      await importHermesSession('cli-1', 'travel')

      const [url, options] = mockFetch.mock.calls[0]
      expect(url).toBe('/api/studio/sessions/hermes/cli-1/import?profile=travel')
      expect(options.method).toBe('POST')
    })

    it('archives a session through the local session endpoint', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ok: true }),
      })

      const ok = await archiveSession('session-1')

      const [url, options] = mockFetch.mock.calls[0]
      expect(ok).toBe(true)
      expect(url).toBe('/api/studio/sessions/session-1/archive')
      expect(options.method).toBe('POST')
    })

    it('unarchives a session through the local session endpoint', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ok: true }),
      })

      const ok = await unarchiveSession('session-1')

      const [url, options] = mockFetch.mock.calls[0]
      expect(ok).toBe(true)
      expect(url).toBe('/api/studio/sessions/session-1/unarchive')
      expect(options.method).toBe('POST')
    })
  })
})
