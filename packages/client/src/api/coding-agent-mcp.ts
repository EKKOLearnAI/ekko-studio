import { request } from './client'
import type { CodingAgentId } from './coding-agents'
import type { McpServerConfig, McpServerInfo } from './hermes/mcp'

export interface CodingAgentMcpServerInfo extends McpServerInfo {
  managed: boolean
}

export interface CodingAgentMcpServersResponse {
  ok: boolean
  servers: CodingAgentMcpServerInfo[]
  total_tools: number
  error?: string
}

function basePath(agentId: CodingAgentId): string {
  return `/api/coding-agents/${agentId}/mcp/servers`
}

export async function fetchCodingAgentMcpServers(agentId: CodingAgentId): Promise<CodingAgentMcpServersResponse> {
  return request<CodingAgentMcpServersResponse>(basePath(agentId))
}

export async function addCodingAgentMcpServer(
  agentId: CodingAgentId,
  name: string,
  config: McpServerConfig,
): Promise<{ ok: boolean; name?: string; error?: string }> {
  return request(basePath(agentId), {
    method: 'POST',
    body: JSON.stringify({ name, config }),
  })
}

export async function updateCodingAgentMcpServer(
  agentId: CodingAgentId,
  name: string,
  config: McpServerConfig,
): Promise<{ ok: boolean; name?: string; error?: string }> {
  return request(`${basePath(agentId)}/${encodeURIComponent(name)}`, {
    method: 'PATCH',
    body: JSON.stringify({ config }),
  })
}

export async function removeCodingAgentMcpServer(
  agentId: CodingAgentId,
  name: string,
): Promise<{ ok: boolean; error?: string }> {
  return request(`${basePath(agentId)}/${encodeURIComponent(name)}`, { method: 'DELETE' })
}

export async function testCodingAgentMcpServer(
  agentId: CodingAgentId,
  name: string,
): Promise<{
  ok: boolean
  tools?: string[]
  tool_details?: Array<{ name: string; description?: string; input_schema?: Record<string, unknown> }>
  error?: string
}> {
  return request(`${basePath(agentId)}/${encodeURIComponent(name)}/test`, { method: 'POST' })
}
