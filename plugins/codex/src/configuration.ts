import { StudioError, type AgentContextConfiguration, type JsonObject } from '@ekko-studio/plugin-sdk'

/** Native thread overrides apply to this runtime; they never edit the user's config.toml. */
export function codexContextConfiguration(context: AgentContextConfiguration): JsonObject {
  const servers: JsonObject = {}
  for (const [name, server] of Object.entries(context.mcpServers || {})) {
    const enabled = server.enabled !== false && server.disabled !== true
    if ('url' in server) {
      if (enabled && server.type === 'sse') throw new StudioError('CAPABILITY_UNSUPPORTED', 'Codex requires streamable HTTP for remote MCP servers')
      let url: URL
      try { url = new URL(server.url) } catch { throw new StudioError('INVALID_ARGUMENT', 'Invalid MCP HTTP endpoint') }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new StudioError('INVALID_ARGUMENT', 'Invalid MCP HTTP endpoint')
      servers[name] = { url: server.url, enabled, ...(server.headers ? { http_headers: server.headers } : {}) }
    } else {
      servers[name] = { command: server.command, args: server.args || [], enabled, ...(server.env ? { env: server.env } : {}) }
    }
  }
  return { ...(Object.keys(servers).length ? { mcp_servers: servers } : {}) }
}
