import { AgentBridgeClient } from '../bridge/client'
import type { McpActionResponse } from '../../contracts/mcp'

export type { McpServerEntry, McpActionResponse } from '../../contracts/mcp'

let bridgeClient: AgentBridgeClient | null = null

export function getBridgeClient(): AgentBridgeClient {
  if (!bridgeClient) {
    bridgeClient = new AgentBridgeClient()
  }
  return bridgeClient
}

/**
 * Send an MCP action to the AgentBridge using typed client methods.
 */
export async function bridgeMcpAction(
  action: string,
  payload: Record<string, unknown> = {},
  profile?: string
): Promise<McpActionResponse> {
  const client = getBridgeClient()
  let raw: McpActionResponse

  switch (action) {
    case 'mcp_list':
      raw = await client.mcpList(profile)
      break
    case 'mcp_server_add': {
      const addName = String(payload.name || '')
      const addConfig = payload.config as Record<string, unknown> | undefined
      if (!addName || !addConfig) throw new Error('name and config are required')
      raw = await client.mcpAdd(addName, addConfig, profile)
      break
    }
    case 'mcp_server_update': {
      const updName = String(payload.name || '')
      const updConfig = payload.config as Record<string, unknown> | undefined
      if (!updName || !updConfig) throw new Error('name and config are required')
      raw = await client.mcpUpdate(updName, updConfig, profile)
      break
    }
    case 'mcp_server_remove': {
      const rmName = String(payload.name || '')
      if (!rmName) throw new Error('name is required')
      raw = await client.mcpRemove(rmName, profile)
      break
    }
    case 'mcp_server_test': {
      const testName = String(payload.name || '')
      if (!testName) throw new Error('name is required')
      raw = await client.mcpTest(testName, profile)
      break
    }
    case 'mcp_tools_list':
      raw = await client.mcpTools(payload.server as string | undefined, profile, payload.raw as boolean | undefined)
      break
    case 'mcp_reload':
      raw = await client.mcpReload(payload.server as string | undefined, profile)
      break
    default:
      throw new Error(`Unknown MCP action: ${action}`)
  }

  return raw
}
