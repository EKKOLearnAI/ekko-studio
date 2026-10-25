import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { StudioError, type AgentContextConfiguration, type AgentRuntimeContext } from '@ekko-studio/plugin-sdk'

/** Copilot 1.0.91 loads extra servers at process startup; keep native account files untouched. */
export async function prepareCopilotMcp(configuration: AgentContextConfiguration, context: AgentRuntimeContext) {
  const servers = Object.entries(configuration.mcpServers || {}).filter(([, server]) => server.enabled !== false && server.disabled !== true)
  if (!servers.length) return { args: [] }
  if (!context.stateDirectory) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Copilot MCP requires host-managed storage')
  await mkdir(context.stateDirectory, { recursive: true, mode: 0o700 })
  const path = join(context.stateDirectory, `copilot-mcp-${context.runtimeSessionId}.json`)
  const mcpServers = Object.fromEntries(servers.map(([name, server]) => {
    const { enabled: _enabled, disabled: _disabled, ...native } = server
    return [name, { ...native, ...('command' in native ? { type: 'stdio' } : { type: native.type === 'sse' ? 'sse' : 'http' }), tools: ['*'] }]
  }))
  const dispose = async () => { await rm(`${path}.tmp`, { force: true }); await rm(path, { force: true }) }
  try { await writeFile(`${path}.tmp`, JSON.stringify({ mcpServers }), { mode: 0o600 }); await rename(`${path}.tmp`, path) }
  catch (error) { await dispose(); throw error }
  return { args: ['--additional-mcp-config', `@${path}`], dispose }
}
