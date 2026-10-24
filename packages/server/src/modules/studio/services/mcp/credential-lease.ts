import { randomUUID } from 'node:crypto'
import { runMcpCredentials } from '../auth/run-mcp-credentials'
import { config, getWebUiHome } from '../../public/config'
import { studioManagedMcpConfig, STUDIO_MANAGED_MCP_ENV } from './managed-config'

/** One authenticated execution owns its credential files, independent of other turns in the Profile. */
export async function leaseStudioMcpServers(servers: Record<string, unknown> | undefined, run: {
  sessionId: string; profile: string; agentId: string; userId?: number; signal: AbortSignal; nativeTaskPlan?: boolean
}) {
  const lifecycle = new AbortController(), contextId = randomUUID()
  const managed = Object.entries(servers || {}).filter(([name, value]) => {
    const server = value as { env?: Record<string, string>; enabled?: boolean; disabled?: boolean } | null
    return /^ekko-studio-(api|browser|devices|use|interaction|plan)$/.test(name)
      && server?.enabled !== false && server?.disabled !== true && server?.env?.[STUDIO_MANAGED_MCP_ENV] === '1'
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
    const tokenFile = await runMcpCredentials.issue({ sessionId: run.sessionId, profile: run.profile, userId: run.userId,
      contextId, agentId: run.agentId, isActive: () => !lifecycle.signal.aborted && !run.signal.aborted }, { preserveOtherContexts: true })
    run.signal.throwIfAborted()
    const configured = { ...servers }
    for (const [name, value] of managed) {
      const original = value as Record<string, unknown>
      const toolset = name === 'ekko-studio-interaction' ? 'plan' : name.replace('ekko-studio-', '')
      // A managed flag is not permission to send this Run's credential to a custom
      // command, URL, environment or headers. Rebuild the complete local transport.
      configured[name] = {
        ...studioManagedMcpConfig(run.profile, name, toolset, {
          appHome: getWebUiHome(), port: config.port, nativeTaskPlan: run.nativeTaskPlan, runTokenFile: tokenFile,
        }),
        ...(original.enabled === undefined ? {} : { enabled: original.enabled }),
        ...(original.supports_parallel_tool_calls === true ? { supports_parallel_tool_calls: true } : {}),
        ...(name === 'ekko-studio-browser' ? { requestTimeoutMs: 300_000 }
          : typeof original.requestTimeoutMs === 'number' && Number.isInteger(original.requestTimeoutMs) && original.requestTimeoutMs > 0 ? { requestTimeoutMs: original.requestTimeoutMs } : {}),
      }
    }
    return { servers: configured, signal: lifecycle.signal, dispose }
  } catch (error) { dispose(); throw error }
}
