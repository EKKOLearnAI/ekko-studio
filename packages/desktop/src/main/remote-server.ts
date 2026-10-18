import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { webUiHome } from './paths'

export const REMOTE_SERVER_URL_ENV = 'EKKO_STUDIO_DESKTOP_SERVER_URL'
export const REMOTE_SERVER_SETTINGS_NAME = 'desktop-remote-server.json'

const DEFAULT_REMOTE_READY_TIMEOUT_MS = 30_000
const REMOTE_READY_POLL_INTERVAL_MS = 500
const REMOTE_READY_REQUEST_TIMEOUT_MS = 2_000

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
  const basePath = parsed.pathname.replace(/\/+$/, '')
  return `${parsed.origin}${basePath}`
}

export function remoteServerUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  return normalizeRemoteServerUrl(env[REMOTE_SERVER_URL_ENV])
}

export function remoteServerUrlFromSettings(home: string = webUiHome()): string | null {
  let raw: string
  try {
    raw = readFileSync(join(home, REMOTE_SERVER_SETTINGS_NAME), 'utf8')
  } catch {
    return null
  }
  try {
    const data = JSON.parse(raw) as { serverUrl?: unknown }
    return normalizeRemoteServerUrl(data?.serverUrl)
  } catch {
    return null
  }
}

// The environment variable wins over the settings file so automated launches
// can override a stored preference. An empty or invalid value in either source
// silently falls back to the other, and to local mode when both are unusable.
export function resolveRemoteServerUrl(
  env: NodeJS.ProcessEnv = process.env,
  home: string = webUiHome(),
): string | null {
  return remoteServerUrlFromEnv(env) ?? remoteServerUrlFromSettings(home)
}

export function remoteReadyTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.EKKO_STUDIO_DESKTOP_REMOTE_READY_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_REMOTE_READY_TIMEOUT_MS
}

export async function waitForRemoteServerReady(serverUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  const healthUrl = `${serverUrl}/health/ready`
  let lastFailure = 'no response'
  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(REMOTE_READY_REQUEST_TIMEOUT_MS) })
      if (res.ok) return
      lastFailure = `HTTP ${res.status}`
    } catch (err) {
      lastFailure = err instanceof Error ? err.message : String(err)
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, REMOTE_READY_POLL_INTERVAL_MS))
  }
  throw new Error(`Remote server ${serverUrl} did not become ready within ${timeoutMs}ms (${lastFailure})`)
}
