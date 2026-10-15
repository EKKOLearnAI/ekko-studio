import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  desktopPreloadArguments,
  loadRemoteServerConfig,
  normalizeRemoteServerUrl,
  remoteReadyTimeoutMs,
  remoteServerUrlFromEnv,
  remoteServerUrlFromSettings,
  resolveRemoteServerUrl,
  remoteServerRequestHeaders,
  waitForRemoteServerReady,
  writeActiveRemoteServer,
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
    ['http://admin:secret@10.0.0.1:6060'],
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

describe('remote server list', () => {
  const settings = (home: string, data: unknown) =>
    writeFileSync(join(home, 'desktop-remote-server.json'), typeof data === 'string' ? data : JSON.stringify(data))

  it('selects the active entry and keeps every valid server', () => {
    const home = tempDirectory()
    settings(home, { active: 'office', servers: [
      { name: 'home', url: 'http://192.168.1.20:6060/' },
      { name: 'office', url: 'https://ekko.example.com/studio?x=1' },
    ] })
    const config = loadRemoteServerConfig({}, home)
    expect(config.active).toEqual({ name: 'office', url: 'https://ekko.example.com/studio' })
    expect(config.servers.map(server => server.name)).toEqual(['home', 'office'])
    expect(config.error).toBeNull()
    expect(config.file).toBe(join(home, 'desktop-remote-server.json'))
    expect(resolveRemoteServerUrl({}, home)).toBe('https://ekko.example.com/studio')
  })

  it('lets the environment variable override the list', () => {
    const home = tempDirectory()
    settings(home, { active: 'home', servers: [{ name: 'home', url: 'http://192.168.1.20:6060' }] })
    const config = loadRemoteServerConfig({ EKKO_STUDIO_DESKTOP_SERVER_URL: 'http://env:6060' }, home)
    expect(config.active).toEqual({ name: 'http://env:6060', url: 'http://env:6060' })
    expect(config.file).toBeNull()
  })

  it('skips invalid entries without logging their URL or headers', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const home = tempDirectory()
    settings(home, { active: 'ok', servers: [
      { name: 'ok', url: 'https://ekko.example.com' },
      { name: 'creds', url: 'https://user:top-secret@ekko.example.com' },
      { name: 'ftp', url: 'ftp://ekko.example.com' },
      { name: '', url: 'https://ekko.example.com' },
      { name: 'ok', url: 'https://duplicate.example.com' },
      null,
    ] })
    const config = loadRemoteServerConfig({}, home)
    expect(config.servers.map(server => server.name)).toEqual(['ok'])
    expect(warn).toHaveBeenCalledTimes(5)
    expect(warn.mock.calls.every(call => !/top-secret|duplicate|ftp:/.test(String(call[0])))).toBe(true)
  })

  it('stays local and reports an error when the active entry is unusable', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    for (const data of [
      { active: 'creds', servers: [{ name: 'creds', url: 'http://admin:secret@10.0.0.1' }] },
      { active: 'missing', servers: [{ name: 'home', url: 'http://10.0.0.1' }] },
      { servers: [{ name: 'home', url: 'http://10.0.0.1' }] },
      { active: 'home', servers: 'http://10.0.0.1' },
      '{not json',
    ]) {
      const home = tempDirectory()
      settings(home, data)
      const config = loadRemoteServerConfig({}, home)
      expect(config.active, JSON.stringify(data)).toBeNull()
      expect(config.error, JSON.stringify(data)).toEqual(expect.any(String))
      expect(config.error).not.toContain('secret')
    }
  })

  it('switching rewrites only the active name, privately', () => {
    const home = tempDirectory()
    const original = { active: 'home', servers: [
      { name: 'home', url: 'http://192.168.1.20:6060' },
      { name: 'office', url: 'https://ekko.example.com', headers: { 'X-Token': 't' } },
    ], extra: 1 }
    settings(home, original)
    const file = loadRemoteServerConfig({}, home).file!
    writeActiveRemoteServer(file, 'office')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ ...original, active: 'office' })
    expect(loadRemoteServerConfig({}, home).active?.name).toBe('office')
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
  })
})

describe('remote server request headers', () => {
  it('validates headers per entry', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const home = tempDirectory()
    const url = 'https://ekko.example.com'
    const sixteen = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`X-H${index}`, 'v']))
    writeFileSync(join(home, 'desktop-remote-server.json'), JSON.stringify({ active: 'ok', servers: [
      { name: 'ok', url, headers: { 'CF-Access-Client-Id': 'id', 'CF-Access-Client-Secret': 'top-secret' } },
      { name: 'plain', url },
      { name: 'sixteen', url, headers: sixteen },
      { name: 'seventeen', url, headers: { ...sixteen, 'X-H16': 'v' } },
      { name: 'host', url, headers: { Host: 'evil' } },
      { name: 'cookie', url, headers: { cookie: 'a=b' } },
      { name: 'crlf', url, headers: { 'X-A': 'a\r\nX-B: b' } },
      { name: 'bad-name', url, headers: { 'X A': 'v' } },
      { name: 'dup', url, headers: { 'X-A': '1', 'x-a': '2' } },
      { name: 'number', url, headers: { 'X-A': 1 } },
      { name: 'array', url, headers: ['X-A'] },
    ] }))
    const config = loadRemoteServerConfig({}, home)
    expect(config.servers.map(server => server.name)).toEqual(['ok', 'plain', 'sixteen'])
    expect(config.servers[1]).toEqual({ name: 'plain', url })
  })

  it('adds headers only for the exact origin of a listed server', () => {
    const servers = [
      { name: 'a', url: 'https://ekko.example.com/studio', headers: { 'CF-Access-Client-Id': 'id' } },
      { name: 'b', url: 'http://10.0.0.1:8648' },
    ]
    const requestHeaders = { Accept: '*/*', 'cf-access-client-id': 'from-page' }
    const expected = { Accept: '*/*', 'CF-Access-Client-Id': 'id' }
    expect(remoteServerRequestHeaders(servers, 'https://ekko.example.com/api/x?y=1', requestHeaders)).toEqual(expected)
    expect(remoteServerRequestHeaders(servers, 'wss://ekko.example.com/socket.io/?EIO=4', requestHeaders)).toEqual(expected)
    for (const url of [
      'https://ekko.example.com:8443/',
      'http://ekko.example.com/',
      'ws://ekko.example.com/socket.io/',
      'https://ekko.example.com.evil.example/',
      'http://10.0.0.1:8648/',
      'not a url',
    ]) expect(remoteServerRequestHeaders(servers, url, requestHeaders), url).toBeUndefined()
  })

  it('sends the headers on the readiness probe without following redirects', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true } as Response))
    vi.stubGlobal('fetch', fetchMock)
    await waitForRemoteServerReady('https://ekko.example.com', 5_000, { 'X-Token': 't' })
    expect(fetchMock).toHaveBeenCalledWith('https://ekko.example.com/health/ready', expect.objectContaining({
      redirect: 'manual',
      headers: { 'X-Token': 't' },
    }))
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
    expect(desktopSource).toContain("from './remote-server'")
    expect(desktopSource).toContain('let remoteConfig: RemoteServerConfig = loadRemoteServerConfig()')
    expect(desktopSource).toContain('let activeRemoteServerUrl: string | null = remoteConfig.active?.url ?? null')
    expect(desktopSource).toContain('const remote = remoteConfig.active')
    expect(desktopSource).toContain('await waitForRemoteServerReady(remoteUrl, remoteReadyTimeoutMs(), remote.headers)')
    expect(desktopSource).toContain("await loadServiceFailurePage(err, t('desktop.failedConnectRemote'))")
  })

  it('adds per-server headers only through the main-process request hook', () => {
    expect(desktopSource).toContain('session.defaultSession.webRequest.onBeforeSendHeaders(')
    expect(desktopSource).toContain('remoteServerRequestHeaders(remoteConfig.servers, details.url, details.requestHeaders)')
    expect(preloadSource).not.toMatch(/remote-server|RemoteServer|CF-Access/)
  })

  it('switches between configured servers from the tray', () => {
    expect(desktopSource).toContain("label: t('tray.servers')")
    expect(desktopSource).toContain('writeActiveRemoteServer(remoteConfig.file, server.name)')
    expect(desktopSource).toContain('if (attempt !== remoteOpenAttempt) return')
  })

  it('keeps APIs that act on this computer away from a remote page', () => {
    for (const message of [
      'Desktop restart is disabled in remote server mode',
      'Desktop updates are disabled in remote server mode',
      'Screenshots are disabled in remote server mode',
      'Opening external URLs is disabled in remote server mode',
      'Desktop browser is disabled in remote server mode',
    ]) expect(desktopSource).toContain(message)
    expect(preloadSource).toContain('...(REMOTE_SERVER_MODE ? {} : {')
    expect(preloadSource).toContain("desktopWindowKind() === 'main' && !REMOTE_SERVER_MODE ? { browser: {")
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
