import { AgentBridgeClient } from '../bridge/client'
import { getAgentBridgeManager } from '../bridge/manager'

/** The broker broadcasts only to existing workers, including isolated group/task workers. */
export async function synchronizeHermesPluginMcpServers(servers: string[], removed: string[]): Promise<void> {
  const manager = getAgentBridgeManager()
  if (!manager.running) return
  const client = new AgentBridgeClient({ endpoint: manager.endpoint, connectRetryMs: 0 })
  await client.mcpPluginsChanged(servers, removed)
}
