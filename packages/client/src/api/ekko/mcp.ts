import { request } from '@/api/client'

export interface EkkoMcpServerConfig {
  type?: 'stdio' | 'streamable_http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  enabled?: boolean
}

export interface EkkoMcpServerInfo {
  name: string
  managed: boolean
  config: EkkoMcpServerConfig
}

export interface EkkoMcpToolInfo {
  name: string
  description: string
}

export async function fetchEkkoMcpServers(): Promise<EkkoMcpServerInfo[]> {
  const response = await request<{ ok: boolean; servers: EkkoMcpServerInfo[] }>('/api/ekko/mcp/servers')
  return response.servers
}

export async function createEkkoMcpServer(name: string, config: EkkoMcpServerConfig): Promise<EkkoMcpServerInfo> {
  const response = await request<{ ok: boolean; server: EkkoMcpServerInfo }>('/api/ekko/mcp/servers', {
    method: 'POST',
    body: JSON.stringify({ name, config }),
  })
  return response.server
}

export async function updateEkkoMcpServer(name: string, config: EkkoMcpServerConfig): Promise<EkkoMcpServerInfo> {
  const response = await request<{ ok: boolean; server: EkkoMcpServerInfo }>(`/api/ekko/mcp/servers/${encodeURIComponent(name)}`, {
    method: 'PATCH',
    body: JSON.stringify({ config }),
  })
  return response.server
}

export async function setEkkoMcpServerEnabled(name: string, enabled: boolean): Promise<EkkoMcpServerInfo> {
  const response = await request<{ ok: boolean; server: EkkoMcpServerInfo }>(`/api/ekko/mcp/servers/${encodeURIComponent(name)}`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled }),
  })
  return response.server
}

export async function deleteEkkoMcpServer(name: string): Promise<void> {
  await request(`/api/ekko/mcp/servers/${encodeURIComponent(name)}`, { method: 'DELETE' })
}

export async function testEkkoMcpServer(name: string): Promise<EkkoMcpToolInfo[]> {
  const response = await request<{ ok: boolean; tools: EkkoMcpToolInfo[] }>(`/api/ekko/mcp/servers/${encodeURIComponent(name)}/test`, { method: 'POST' })
  return response.tools
}
