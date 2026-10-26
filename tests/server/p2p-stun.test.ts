import { lookup } from 'node:dns/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveP2PSTUN } from '../../packages/server/src/modules/studio/services/app-relay/p2p-stun'

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }))
const fetchMock = vi.fn()
const urls = ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302']

beforeEach(() => { vi.resetAllMocks(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('STUN endpoint resolution for source-bound ICE sockets', () => {
  it('prefers real IPv4 endpoints and preserves the configured hostnames and order', async () => {
    vi.mocked(lookup).mockResolvedValueOnce([{ address: '162.159.207.0', family: 4 }])
      .mockResolvedValueOnce([{ address: '74.125.250.129', family: 4 }])
    const result = await resolveP2PSTUN(urls)
    expect(result.urls).toEqual(['stun:162.159.207.0:3478', 'stun:74.125.250.129:19302', ...urls])
    expect(result.diagnostics).toEqual({ configured: 2, resolved: 2, fakeIPHosts: 0, encryptedDNSHosts: 0 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('replaces synthetic DNS addresses using bounded encrypted DNS for built-in public STUN hosts', async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: '198.18.0.2', family: 4 }])
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ Status: 0, Answer: [
      { type: 5, data: 'alias' }, { type: 1, data: '198.19.0.3' }, { type: 1, data: '162.159.207.0' },
    ] }) })
    const result = await resolveP2PSTUN([urls[0]])
    expect(result.urls).toEqual(['stun:162.159.207.0:3478', urls[0]])
    expect(result.diagnostics).toEqual({ configured: 1, resolved: 1, fakeIPHosts: 1, encryptedDNSHosts: 1 })
    const [query, options] = fetchMock.mock.calls[0]
    expect(query.origin).toBe('https://cloudflare-dns.com')
    expect(query.searchParams.get('name')).toBe('stun.cloudflare.com')
    expect(query.searchParams.get('type')).toBe('A')
    expect(options.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.stringify(result.diagnostics)).not.toMatch(/198\.18|162\.159|stun:/)
  })

  it('preserves explicit endpoints and an intentionally empty STUN configuration without any DNS calls', async () => {
    const explicit = ['stun:192.168.1.5:3478', 'stun:[2001:db8::1]:3478']
    expect((await resolveP2PSTUN(explicit)).urls).toEqual(explicit)
    expect((await resolveP2PSTUN([])).urls).toEqual([])
    expect(lookup).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps configured URLs after DNS failure or unusable encrypted DNS answers', async () => {
    vi.mocked(lookup).mockRejectedValueOnce(new Error('offline'))
    expect((await resolveP2PSTUN([urls[0]])).urls).toEqual([urls[0]])
    vi.mocked(lookup).mockResolvedValue([{ address: '198.18.0.2', family: 4 }])
    for (const reply of [
      { ok: false },
      { ok: true, json: async () => ({ Status: 3 }) },
      { ok: true, json: async () => ({ Status: 0, Answer: [{ type: 1, data: '127.0.0.1' }] }) },
    ]) {
      fetchMock.mockResolvedValueOnce(reply)
      expect(await resolveP2PSTUN([urls[0]])).toMatchObject({ urls: [urls[0]], diagnostics: { fakeIPHosts: 1, resolved: 0 } })
    }
  })

  it('does not disclose custom STUN hostnames to a public DNS resolver', async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: '198.18.0.2', family: 4 }])
    expect((await resolveP2PSTUN(['stun:private.office:3478'])).urls).toEqual(['stun:private.office:3478'])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shares one deadline across all lookups and does not start encrypted DNS after cancellation', async () => {
    vi.useFakeTimers()
    let finish!: (value: { address: string; family: number }[]) => void
    vi.mocked(lookup).mockReturnValue(new Promise(resolve => { finish = resolve }) as any)
    const pending = resolveP2PSTUN(urls, 50)
    await vi.advanceTimersByTimeAsync(50)
    expect((await pending).urls).toEqual(urls)
    finish([{ address: '198.18.0.2', family: 4 }])
    await Promise.resolve()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
