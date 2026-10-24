import { request } from '../client'

export interface McpServerInfo {
  name: string
  transport: 'stdio' | 'http' | 'sse'
  connected: boolean
  tools: number
  tools_registered: number
  tool_names: string[]
  tool_names_registered: string[]
  tool_details: Array<{ name: string; description?: string }>
  error?: string | null
  raw_config: McpServerConfig
}

export interface McpServersResponse {
  ok: boolean
  servers: McpServerInfo[]
  total_tools: number
  error?: string
}

export interface McpToolsResponse {
  ok: boolean
  results: Array<{
    server: string
    tools: Array<{
      name: string
      description: string
      input_schema: Record<string, unknown>
    }>
  }>
  error?: string
}

export interface McpServerConfig {
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  headers?: Record<string, string>
  timeout?: number
  connect_timeout?: number
  enabled?: boolean
  transport?: 'stdio' | 'http' | 'sse'
  tools?: { include?: string[]; exclude?: string[] }
  prompts?: boolean
  resources?: boolean
}

export async function fetchMcpServers(profile?: string): Promise<McpServersResponse> {
  const query = profile ? `?profile=${encodeURIComponent(profile)}` : ''
  return request<McpServersResponse>(`/api/hermes/mcp/servers${query}`)
}

export async function fetchMcpTools(server?: string, raw?: boolean, profile?: string): Promise<McpToolsResponse> {
  const params = new URLSearchParams()
  if (server) params.set('server', server)
  if (raw) params.set('raw', '1')
  if (profile) params.set('profile', profile)
  const query = params.toString() ? `?${params.toString()}` : ''
  return request<McpToolsResponse>(`/api/hermes/mcp/tools${query}`)
}

export async function mcpServerAdd(name: string, config: McpServerConfig, profile?: string): Promise<{ ok: boolean; name?: string; error?: string }> {
  const query = profile ? `?profile=${encodeURIComponent(profile)}` : ''
  return request(`/api/hermes/mcp/servers${query}`, {
    method: 'POST',
    body: JSON.stringify({ name, config }),
  })
}

export async function mcpServerRemove(name: string, profile?: string): Promise<{ ok: boolean; error?: string }> {
  const query = profile ? `?profile=${encodeURIComponent(profile)}` : ''
  return request(`/api/hermes/mcp/servers/${encodeURIComponent(name)}${query}`, {
    method: 'DELETE',
  })
}

export async function mcpServerUpdate(name: string, config: McpServerConfig, profile?: string): Promise<{ ok: boolean; error?: string }> {
  const query = profile ? `?profile=${encodeURIComponent(profile)}` : ''
  return request(`/api/hermes/mcp/servers/${encodeURIComponent(name)}${query}`, {
    method: 'PATCH',
    body: JSON.stringify({ config }),
  })
}

export async function mcpReload(name?: string, profile?: string): Promise<{ ok: boolean; message?: string; error?: string }> {
  const params = new URLSearchParams()
  if (name) params.set('server', name)
  if (profile) params.set('profile', profile)
  const query = params.toString() ? `?${params.toString()}` : ''
  return request(`/api/hermes/mcp/reload${query}`, { method: 'POST' })
}

export async function mcpServerTest(name: string, profile?: string): Promise<{ ok: boolean; tools?: string[]; error?: string }> {
  const query = profile ? `?profile=${encodeURIComponent(profile)}` : ''
  return request(`/api/hermes/mcp/servers/${encodeURIComponent(name)}/test${query}`, { method: 'POST' })
}
