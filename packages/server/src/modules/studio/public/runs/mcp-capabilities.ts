/** Studio guidance follows configured toolsets, including lazily loaded MCPs. */
export interface StudioMcpCapabilities {
  api: boolean
  plugins: boolean
  browser: boolean
  devices: boolean
  use: boolean
  interaction: boolean
}

export function studioMcpCapabilities(servers: unknown): StudioMcpCapabilities {
  const capabilities: StudioMcpCapabilities = {
    api: false, plugins: false, browser: false, devices: false, use: false, interaction: false,
  }
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return capabilities
  for (const [name, value] of Object.entries(servers)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const server = value as Record<string, any>
    if (server.enabled === false || server.disabled === true) continue
    const match = /^(?:ekko|hermes)-studio-(api|plugins|browser|devices|use|interaction|plan)$/.exec(name)
    const env = server.env || server.environment
    const toolset = match?.[1] || (env?.HERMES_WEB_UI_MANAGED_MCP === '1' && env?.HERMES_MCP_TOOLSET === 'plugins' ? 'plugins' : undefined)
    if (toolset) capabilities[toolset === 'plan' ? 'interaction' : toolset as keyof StudioMcpCapabilities] = true
  }
  return capabilities
}
