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

function profileQuery(profile?: string): string {
  return profile ? `?profile=${encodeURIComponent(profile)}` : ''
}

export async function fetchEkkoMcpServers(profile?: string): Promise<EkkoMcpServerInfo[]> {
  const response = await request<{ ok: boolean; servers: EkkoMcpServerInfo[] }>(`/api/ekko/mcp/servers${profileQuery(profile)}`)
  return response.servers
}

export async function createEkkoMcpServer(name: string, config: EkkoMcpServerConfig, profile?: string): Promise<EkkoMcpServerInfo> {
  const response = await request<{ ok: boolean; server: EkkoMcpServerInfo }>(`/api/ekko/mcp/servers${profileQuery(profile)}`, {
    method: 'POST',
    body: JSON.stringify({ name, config }),
  })
  return response.server
}

export async function updateEkkoMcpServer(name: string, config: EkkoMcpServerConfig, profile?: string): Promise<EkkoMcpServerInfo> {
  const response = await request<{ ok: boolean; server: EkkoMcpServerInfo }>(`/api/ekko/mcp/servers/${encodeURIComponent(name)}${profileQuery(profile)}`, {
    method: 'PATCH',
    body: JSON.stringify({ config }),
  })
  return response.server
}

export async function setEkkoMcpServerEnabled(name: string, enabled: boolean, profile?: string): Promise<EkkoMcpServerInfo> {
  const response = await request<{ ok: boolean; server: EkkoMcpServerInfo }>(`/api/ekko/mcp/servers/${encodeURIComponent(name)}${profileQuery(profile)}`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled }),
  })
  return response.server
}

export async function deleteEkkoMcpServer(name: string, profile?: string): Promise<void> {
  await request(`/api/ekko/mcp/servers/${encodeURIComponent(name)}${profileQuery(profile)}`, { method: 'DELETE' })
}

export async function testEkkoMcpServer(name: string, profile?: string): Promise<EkkoMcpToolInfo[]> {
  const response = await request<{ ok: boolean; tools: EkkoMcpToolInfo[] }>(`/api/ekko/mcp/servers/${encodeURIComponent(name)}/test${profileQuery(profile)}`, { method: 'POST' })
  return response.tools
}
