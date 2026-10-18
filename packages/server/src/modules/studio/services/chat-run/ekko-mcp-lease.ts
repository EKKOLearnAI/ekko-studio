import { randomUUID } from 'node:crypto'
import { runMcpCredentials } from '../auth/run-mcp-credentials'

/** Credentials and connections belong to one authenticated turn, never the shared Profile. */
export async function leaseEkkoMcpServers(servers: Record<string, unknown> | undefined, run: {
  sessionId: string; profile: string; userId?: number; signal: AbortSignal
}) {
  const lifecycle = new AbortController()
  const contextId = randomUUID()
  const managed = Object.entries(servers || {}).filter(([name, value]) => {
    const server = value as { env?: Record<string, string> } | null
    return /^ekko-studio-(api|browser|devices|use)$/.test(name) && server?.env?.HERMES_WEB_UI_MANAGED_MCP === '1'
  })
  const dispose = () => {
    lifecycle.abort()
    runMcpCredentials.revoke(run.sessionId, contextId)
    run.signal.removeEventListener('abort', dispose)
  }
  run.signal.throwIfAborted()
  run.signal.addEventListener('abort', dispose, { once: true })
  if (!managed.length) return { servers, signal: lifecycle.signal, dispose }
  try {
    const tokenFile = await runMcpCredentials.issue({ sessionId: run.sessionId, profile: run.profile,
      userId: run.userId, contextId, agentId: 'ekko-agent',
      isActive: () => !lifecycle.signal.aborted && !run.signal.aborted }, { preserveOtherContexts: true })
    run.signal.throwIfAborted()
    const configured = { ...servers }
    for (const [name, value] of managed) {
      const server = value as { env: Record<string, string> }
      configured[name] = { ...server, env: { ...server.env, HERMES_WEB_UI_PROFILE: run.profile,
        HERMES_WEB_UI_RUN_TOKEN_FILE: tokenFile, HERMES_WEB_UI_TOKEN: '', AUTH_TOKEN: '' } }
    }
    return { servers: configured, signal: lifecycle.signal, dispose }
  } catch (error) { dispose(); throw error }
}
