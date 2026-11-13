import { createServer } from 'node:net'

const DEFAULT_WEB_UI_SHUTDOWN_FORCE_EXIT_MS = 10_000
const PORT_RELEASE_GRACE_MS = 1_000
const PORT_POLL_INTERVAL_MS = 100

export function getWebUiPortReleaseTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const configured = Number(env.HERMES_WEB_UI_SHUTDOWN_FORCE_EXIT_MS)
  const forceExitMs = Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_WEB_UI_SHUTDOWN_FORCE_EXIT_MS
  return forceExitMs + PORT_RELEASE_GRACE_MS
}

function webUiBindHost(env: Record<string, string | undefined> = process.env): string {
  return env.BIND_HOST?.trim() || '0.0.0.0'
}

export async function canBindTcpPort(port: number, host = '127.0.0.1'): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = createServer()
    server.unref()
    server.once('error', () => resolve(false))
    server.listen(port, host, () => {
      server.close(() => resolve(true))
    })
  })
}

async function waitForTcpPort(port: number, host: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await canBindTcpPort(port, host)) return true
    await new Promise(resolve => setTimeout(resolve, PORT_POLL_INTERVAL_MS))
  }
  return canBindTcpPort(port, host)
}

/**
 * Recover a Desktop Web UI orphaned after its Electron parent exited.
 * Only the authenticated Desktop shutdown endpoint can authorize this action.
 */
export async function releaseOccupiedWebUiPort(
  port: number,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const timeoutMs = getWebUiPortReleaseTimeoutMs()
  const bindHost = webUiBindHost()
  let response: Response
  try {
    response = await fetchImpl(`http://127.0.0.1:${port}/api/desktop/shutdown`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    return false
  }

  if (response.status !== 202) return false
  // Probe the same address family and bind host as the Web UI. In particular,
  // do not let an IPv4 wildcard probe report success beside a loopback-bound
  // listener configured with BIND_HOST=127.0.0.1.
  if (!await waitForTcpPort(port, bindHost, timeoutMs)) {
    throw new Error(`Existing Web UI server did not release port ${port} after shutdown`)
  }
  return true
}
