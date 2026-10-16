import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { webUiHome } from './paths'

export const REMOTE_SERVER_URL_ENV = 'EKKO_STUDIO_DESKTOP_SERVER_URL'
export const REMOTE_SERVER_SETTINGS_NAME = 'desktop-remote-server.json'

const DEFAULT_REMOTE_READY_TIMEOUT_MS = 30_000
const REMOTE_READY_POLL_INTERVAL_MS = 500
const REMOTE_READY_REQUEST_TIMEOUT_MS = 2_000

// `headers` are secrets (e.g. a Cloudflare Access service token): main process only, never logged.
export type RemoteServer = { name: string; url: string; headers?: Record<string, string> }

// `active` null means local mode. `error` explains why a configured remote server was
// refused; the app then stays in local mode. `file` is where a tray switch is saved
// (null when the server comes from the environment).
export type RemoteServerConfig = {
  active: RemoteServer | null
  servers: RemoteServer[]
  error: string | null
  file: string | null
}

const MAX_HEADERS = 16
// RFC 7230 token.
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const RESERVED_HEADERS: Record<string, true> = {
  host: true, cookie: true, origin: true, 'content-length': true, 'transfer-encoding': true, connection: true, upgrade: true,
}

export function desktopPreloadArguments(kind: 'main' | 'pet' | 'chat', remoteMode: boolean): string[] {
  return [
    ...(kind === 'main' ? [] : [`--hermes-window-kind=${kind}`]),
    ...(remoteMode ? ['--hermes-remote-mode'] : []),
  ]
}

// Remote mode points every desktop window at an already-running Web UI
// deployment (for example a Docker container) instead of spawning the bundled
// local server. Accept scheme + host + optional base path; drop query/hash and
// trailing slashes so window route builders can append `/#/...` safely.
// URLs with a username or password are refused so credentials never end up in
// window URLs or logs; use per-server `headers` instead.
export function normalizeRemoteServerUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (!parsed.hostname) return null
  if (parsed.username || parsed.password) return null
  const basePath = parsed.pathname.replace(/\/+$/, '')
  return `${parsed.origin}${basePath}`
}

function localMode(error: string | null = null): RemoteServerConfig {
  return { active: null, servers: [], error, file: null }
}

// undefined: no headers; null: invalid.
function parseHeaders(value: unknown): Record<string, string> | undefined | null {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const entries = Object.entries(value)
  if (entries.length > MAX_HEADERS) return null
  const seen = new Set<string>()
  for (const [name, headerValue] of entries) {
    const lower = name.toLowerCase()
    if (!HEADER_NAME.test(name) || Object.hasOwn(RESERVED_HEADERS, lower) || seen.has(lower)) return null
    if (typeof headerValue !== 'string' || /[\r\n\0]/.test(headerValue)) return null
    seen.add(lower)
  }
  return entries.length ? Object.fromEntries(entries) as Record<string, string> : undefined
}

function envServer(env: NodeJS.ProcessEnv): RemoteServerConfig | null {
  // An empty or invalid value silently falls back to the settings file.
  const url = normalizeRemoteServerUrl(env[REMOTE_SERVER_URL_ENV])
  if (!url) return null
  const server = { name: url, url }
  return { active: server, servers: [server], error: null, file: null }
}

function readSettingsFile(file: string): { data: unknown } | { missing: true } | { error: string } {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { missing: true }
    return { error: `Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}` }
  }
  try {
    return { data: JSON.parse(raw) }
  } catch {
    return { error: `${file} is not valid JSON` }
  }
}

// Two shapes share the settings file:
//   { "serverUrl": "https://studio.example.com" }                 one server
//   { "active": "a", "servers": [{ "name", "url", "headers"? }] } several servers
function parseSettings(data: unknown, file: string): RemoteServerConfig {
  const source = (data && typeof data === 'object' ? data : {}) as { serverUrl?: unknown; active?: unknown; servers?: unknown }
  if (source.servers === undefined) {
    const url = normalizeRemoteServerUrl(source.serverUrl)
    if (!url) return localMode()
    const server = { name: url, url }
    return { active: server, servers: [server], error: null, file }
  }

  const entries = (Array.isArray(source.servers) ? source.servers : []) as Array<{ name?: unknown; url?: unknown; headers?: unknown } | null>
  const valid: RemoteServer[] = []
  entries.forEach((entry, index) => {
    const name = typeof entry?.name === 'string' ? entry.name.trim() : ''
    const url = normalizeRemoteServerUrl(entry?.url)
    const headers = parseHeaders(entry?.headers)
    // Never log the URL or headers: rejected entries may contain credentials.
    if (!name || !url || headers === null || valid.some(server => server.name === name)) {
      console.warn(`[remote-server] ignoring invalid entry #${index} in ${file}`)
      return
    }
    valid.push(headers ? { name, url, headers } : { name, url })
  })

  const selected = valid.find(server => server.name === source.active)
  if (!selected) return localMode(`${file}: active server "${String(source.active)}" is not a valid entry`)
  return { active: selected, servers: valid, error: null, file }
}

// The environment variable wins over `desktop-remote-server.json` in the Web UI
// home. Missing or unusable sources fall back to local mode; a settings file that
// is unreadable or whose `active` entry is invalid also reports an error for the user.
export function loadRemoteServerConfig(
  env: NodeJS.ProcessEnv = process.env,
  home: string = webUiHome(),
): RemoteServerConfig {
  const fromEnv = envServer(env)
  if (fromEnv) return fromEnv

  const file = join(home, REMOTE_SERVER_SETTINGS_NAME)
  const result = readSettingsFile(file)
  if ('missing' in result) return localMode()
  if ('error' in result) return localMode(result.error)
  return parseSettings(result.data, file)
}

export function remoteServerUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  return envServer(env)?.active?.url ?? null
}

export function remoteServerUrlFromSettings(home: string = webUiHome()): string | null {
  return loadRemoteServerConfig({}, home).active?.url ?? null
}

// The environment variable wins over the settings file so automated launches
// can override a stored preference. An empty or invalid value in either source
// silently falls back to the other, and to local mode when both are unusable.
export function resolveRemoteServerUrl(
  env: NodeJS.ProcessEnv = process.env,
  home: string = webUiHome(),
): string | null {
  return loadRemoteServerConfig(env, home).active?.url ?? null
}

export function writeActiveRemoteServer(file: string, name: string): void {
  const data = JSON.parse(readFileSync(file, 'utf8'))
  data.active = name
  const temp = `${file}.tmp`
  // The file may hold secrets (headers); keep it private to the user.
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, file)
}

function requestOrigin(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'ws:') parsed.protocol = 'http:'
    else if (parsed.protocol === 'wss:') parsed.protocol = 'https:'
    return parsed.origin
  } catch {
    return null
  }
}

// Request headers with the matching server's static headers applied, or undefined when
// the URL's origin (ws:/wss: counted as http:/https:) is not exactly a configured server.
export function remoteServerRequestHeaders(
  servers: RemoteServer[],
  url: string,
  requestHeaders: Record<string, string>,
): Record<string, string> | undefined {
  const origin = requestOrigin(url)
  if (!origin) return undefined
  const headers = servers.find(server => requestOrigin(server.url) === origin)?.headers
  if (!headers) return undefined
  const replaced = new Set(Object.keys(headers).map(name => name.toLowerCase()))
  const kept = Object.entries(requestHeaders).filter(([name]) => !replaced.has(name.toLowerCase()))
  return { ...Object.fromEntries(kept), ...headers }
}

export function remoteReadyTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.EKKO_STUDIO_DESKTOP_REMOTE_READY_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_REMOTE_READY_TIMEOUT_MS
}

// `headers` lets the probe pass an access proxy (e.g. Cloudflare Access) the same way
// the windows do. Redirects are not followed: a proxy login page is not readiness.
export async function waitForRemoteServerReady(
  serverUrl: string,
  timeoutMs: number,
  headers?: Record<string, string>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  const healthUrl = `${serverUrl}/health/ready`
  let lastFailure = 'no response'
  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthUrl, {
        signal: AbortSignal.timeout(REMOTE_READY_REQUEST_TIMEOUT_MS),
        redirect: 'manual',
        ...(headers ? { headers } : {}),
      })
      if (res.ok) return
      lastFailure = `HTTP ${res.status}`
    } catch (err) {
      lastFailure = err instanceof Error ? err.message : String(err)
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, REMOTE_READY_POLL_INTERVAL_MS))
  }
  throw new Error(`Remote server ${serverUrl} did not become ready within ${timeoutMs}ms (${lastFailure})`)
}
