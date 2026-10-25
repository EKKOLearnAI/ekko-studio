import { randomUUID } from 'node:crypto'
import { runMcpCredentials } from '../auth/run-mcp-credentials'
import { config, getWebUiHome } from '../../public/config'
import { studioManagedMcpConfig, isStudioManagedMcpServer } from './managed-config'

/** One authenticated execution owns its credential files, independent of other turns in the Profile. */
export async function leaseStudioMcpServers(servers: Record<string, unknown> | undefined, run: {
  sessionId: string; runId?: string; profile: string; agentId: string; userId?: number; signal: AbortSignal; nativeTaskPlan?: boolean; contextId?: string; sessionTasks?: boolean; userClarification?: boolean; authorize?(): void
}) {
  if (run.contextId !== undefined && (typeof run.contextId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(run.contextId))) throw new Error('Invalid host MCP context')
  const lifecycle = new AbortController(), contextId = run.contextId ?? randomUUID()
  const managed = Object.entries(servers || {}).filter(([name, value]) => isStudioManagedMcpServer(name, value))
  const dispose = () => {
    lifecycle.abort()
    runMcpCredentials.revoke(run.sessionId, contextId)
    run.signal.removeEventListener('abort', dispose)
  }
  run.signal.throwIfAborted()
  run.authorize?.()
  run.signal.addEventListener('abort', dispose, { once: true })
  if (!managed.length) return { servers, signal: lifecycle.signal, dispose, contextId: undefined }
  try {
    const tokenFile = await runMcpCredentials.issue({ sessionId: run.sessionId, runId: run.runId, profile: run.profile, userId: run.userId,
      contextId, agentId: run.agentId, isActive: () => {
        if (lifecycle.signal.aborted || run.signal.aborted) return false
        try { run.authorize?.(); return true } catch { return false }
      } }, { preserveOtherContexts: true })
    run.signal.throwIfAborted()
    run.authorize?.()
    const configured = { ...servers }
    for (const [name, value] of managed) {
      const original = value as Record<string, unknown>
      const toolset = name === 'ekko-studio-interaction' ? 'plan' : name.replace('ekko-studio-', '')
      // A managed flag is not permission to send this Run's credential to a custom
      // command, URL, environment or headers. Rebuild the complete local transport.
      configured[name] = {
        ...studioManagedMcpConfig(run.profile, name, toolset, {
          appHome: getWebUiHome(), port: config.port, nativeTaskPlan: run.nativeTaskPlan, runTokenFile: tokenFile,
          sessionTasks: run.sessionTasks, userClarification: run.userClarification,
        }),
        ...(original.enabled === undefined ? {} : { enabled: original.enabled }),
        ...(original.supports_parallel_tool_calls === true ? { supports_parallel_tool_calls: true } : {}),
        ...(name === 'ekko-studio-browser' ? { requestTimeoutMs: 300_000 }
          : typeof original.requestTimeoutMs === 'number' && Number.isInteger(original.requestTimeoutMs) && original.requestTimeoutMs > 0 ? { requestTimeoutMs: original.requestTimeoutMs } : {}),
      }
    }
    return { servers: configured, signal: lifecycle.signal, dispose, contextId }
  } catch (error) { dispose(); throw error }
}
