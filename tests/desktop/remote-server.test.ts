import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  desktopPreloadArguments,
  normalizeRemoteServerUrl,
  remoteReadyTimeoutMs,
  remoteServerUrlFromEnv,
  remoteServerUrlFromSettings,
  resolveRemoteServerUrl,
  waitForRemoteServerReady,
} from '../../packages/desktop/src/main/remote-server'

const tempDirectories: string[] = []

function tempDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'studio-remote-server-'))
  tempDirectories.push(root)
  return root
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  for (const root of tempDirectories.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('remote server URL normalization', () => {
  it.each([
    ['http://192.168.1.20:6060', 'http://192.168.1.20:6060'],
    ['  https://studio.example.com  ', 'https://studio.example.com'],
    ['https://studio.example.com/', 'https://studio.example.com'],
    ['http://192.168.1.20:6060/studio/', 'http://192.168.1.20:6060/studio'],
    ['http://127.0.0.1:16060/#/login?next=1', 'http://127.0.0.1:16060'],
  ])('accepts %s', (input, expected) => {
    expect(normalizeRemoteServerUrl(input)).toBe(expected)
  })

  it.each([
    ['ftp://example.com'],
    ['file:///etc/passwd'],
    ['example.com:6060'],
    ['not a url'],
    [''],
    ['   '],
  ])('rejects %s', input => {
    expect(normalizeRemoteServerUrl(input)).toBeNull()
  })

  it('rejects non-string values', () => {
    expect(normalizeRemoteServerUrl(undefined)).toBeNull()
    expect(normalizeRemoteServerUrl(123)).toBeNull()
    expect(normalizeRemoteServerUrl({ url: 'http://example.com' })).toBeNull()
  })
})

describe('remote server URL sources', () => {
  it('reads the URL from the environment variable', () => {
    expect(remoteServerUrlFromEnv({ EKKO_STUDIO_DESKTOP_SERVER_URL: 'http://10.0.0.5:6060' })).toBe('http://10.0.0.5:6060')
    expect(remoteServerUrlFromEnv({})).toBeNull()
    expect(remoteServerUrlFromEnv({ EKKO_STUDIO_DESKTOP_SERVER_URL: '' })).toBeNull()
  })

  it('reads the URL from the settings file in the Web UI home', () => {
    const home = tempDirectory()
    vi.stubEnv('HERMES_WEB_UI_HOME', home)
    writeFileSync(join(home, 'desktop-remote-server.json'), JSON.stringify({ serverUrl: 'https://docker.example.com:6060/' }))

    expect(remoteServerUrlFromSettings()).toBe('https://docker.example.com:6060')
  })

  it('returns null for a missing, invalid, or empty settings file', () => {
    const home = tempDirectory()
    vi.stubEnv('HERMES_WEB_UI_HOME', home)

    expect(remoteServerUrlFromSettings(home)).toBeNull()

    writeFileSync(join(home, 'desktop-remote-server.json'), '{not json')
    expect(remoteServerUrlFromSettings(home)).toBeNull()

    writeFileSync(join(home, 'desktop-remote-server.json'), JSON.stringify({ serverUrl: '' }))
    expect(remoteServerUrlFromSettings(home)).toBeNull()

    writeFileSync(join(home, 'desktop-remote-server.json'), JSON.stringify({ serverUrl: 'ftp://nope' }))
    expect(remoteServerUrlFromSettings(home)).toBeNull()
  })

  it('prefers the environment variable over the settings file', () => {
    const home = tempDirectory()
    writeFileSync(join(home, 'desktop-remote-server.json'), JSON.stringify({ serverUrl: 'http://from-file:6060' }))

    expect(resolveRemoteServerUrl({ EKKO_STUDIO_DESKTOP_SERVER_URL: 'http://from-env:6060' }, home)).toBe('http://from-env:6060')
    expect(resolveRemoteServerUrl({}, home)).toBe('http://from-file:6060')
    expect(resolveRemoteServerUrl({}, join(home, 'missing'))).toBeNull()
  })
})

describe('remote readiness timeout', () => {
  it('defaults to 30 seconds and accepts positive overrides', () => {
    expect(remoteReadyTimeoutMs({})).toBe(30_000)
    expect(remoteReadyTimeoutMs({ EKKO_STUDIO_DESKTOP_REMOTE_READY_TIMEOUT_MS: '5000' })).toBe(5000)
    expect(remoteReadyTimeoutMs({ EKKO_STUDIO_DESKTOP_REMOTE_READY_TIMEOUT_MS: '-1' })).toBe(30_000)
    expect(remoteReadyTimeoutMs({ EKKO_STUDIO_DESKTOP_REMOTE_READY_TIMEOUT_MS: 'abc' })).toBe(30_000)
  })
})

describe('remote server readiness probe', () => {
  it('resolves once /health/ready responds ok', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true } as Response))
    vi.stubGlobal('fetch', fetchMock)

    await waitForRemoteServerReady('http://remote.example:6060', 5_000)

    expect(fetchMock).toHaveBeenCalledWith('http://remote.example:6060/health/ready', expect.anything())
  })

  it('retries while the server answers non-2xx', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 } as Response)
      .mockResolvedValueOnce({ ok: true } as Response)
    vi.stubGlobal('fetch', fetchMock)

    await waitForRemoteServerReady('http://remote.example:6060', 10_000)

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('rejects with the last failure when the deadline passes', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 404 } as Response))
    vi.stubGlobal('fetch', fetchMock)

    // A zero timeout expires before the first attempt, so no request is made.
    await expect(waitForRemoteServerReady('http://remote.example:6060', 0)).rejects.toThrow('(no response)')
    expect(fetchMock).not.toHaveBeenCalled()

    await expect(waitForRemoteServerReady('http://remote.example:6060', 600)).rejects.toThrow('HTTP 404')
    expect(fetchMock).toHaveBeenCalled()

    const throwingFetch = vi.fn(async () => { throw new Error('ECONNREFUSED') })
    vi.stubGlobal('fetch', throwingFetch)
    await expect(waitForRemoteServerReady('http://remote.example:6060', 600)).rejects.toThrow('ECONNREFUSED')
  })
})

describe('desktop remote mode wiring', () => {
  const desktopSource = readFileSync(resolve('packages/desktop/src/main/index.ts'), 'utf-8')
  const preloadSource = readFileSync(resolve('packages/desktop/src/preload/index.ts'), 'utf-8')

  it('bootstraps against the remote URL instead of the local server', () => {
    expect(desktopSource).toContain("import { desktopPreloadArguments, remoteReadyTimeoutMs, resolveRemoteServerUrl, waitForRemoteServerReady } from './remote-server'")
    expect(desktopSource).toContain('let activeRemoteServerUrl: string | null = resolveRemoteServerUrl()')
    expect(desktopSource).toContain('const remoteUrl = resolveRemoteServerUrl()')
    expect(desktopSource).toContain('await waitForRemoteServerReady(remoteUrl, remoteReadyTimeoutMs())')
    expect(desktopSource).toContain("await loadServiceFailurePage(err, t('desktop.failedConnectRemote'))")
  })

  it('never shares the local server token with a remote page', () => {
    expect(desktopSource).toContain("return activeRemoteServerUrl ? '' : getToken()")
  })

  it('disables local-only login reset in remote mode', () => {
    expect(desktopSource).toContain('if (isResettingLogin || activeRemoteServerUrl || (isBootstrapping && !serverUrl)) return')
    expect(desktopSource).toContain('!isResettingLogin && !activeRemoteServerUrl && (!isBootstrapping || !!serverUrl)')
  })

  it.each(['main', 'pet', 'chat'] as const)('passes remote mode to the %s window preload', kind => {
    expect(desktopSource).toContain(`additionalArguments: desktopPreloadArguments('${kind}', !!activeRemoteServerUrl)`)
    expect(desktopPreloadArguments(kind, true)).toEqual([
      ...(kind === 'main' ? [] : [`--hermes-window-kind=${kind}`]),
      '--hermes-remote-mode',
    ])
    expect(desktopPreloadArguments(kind, false)).toEqual(kind === 'main' ? [] : [`--hermes-window-kind=${kind}`])
    expect(preloadSource).toContain("const REMOTE_SERVER_MODE = process.argv.includes('--hermes-remote-mode')")
  })

  it('keeps server-side password policy and skips token injection in remote mode', () => {
    expect(preloadSource).toContain('if (!REMOTE_SERVER_MODE) installFetchPatch()')
    expect(preloadSource).toContain('if (REMOTE_SERVER_MODE) return')
  })
})
