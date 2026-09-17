import { Client, SSEClientTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { readFile, writeFile } from 'node:fs/promises'
import { parse as parseToml } from 'smol-toml'
import { logger } from '../../studio/public/logging'
import { killOwnedProcessTree } from '../../studio/public/process-tree'
import { isolatedCodingAgentChildEnv } from './runtime/child-env'
import { assertDshMcpProbeIsLiteral, readDshMcpServers, updateDshMcpServer } from './dsh/config'

const STUDIO_MANAGED_NAMES = new Set([
  'hermes-studio-api',
  'hermes-studio-browser',
  'hermes-studio-devices',
  'hermes-studio-use',
  'ekko-studio-api',
  'ekko-studio-browser',
  'ekko-studio-devices',
  'ekko-studio-use',
  'ekko-studio-plan',
  'ekko-studio-interaction',
])
const MANAGED_ENV_KEY = 'HERMES_WEB_UI_MANAGED_MCP'
const PROBE_TIMEOUT_MS = 5_000

export type CodingAgentMcpProbeResult = {
  ok: boolean
  tools?: string[]
  tool_details?: Array<{ name: string; description?: string; input_schema?: Record<string, unknown> }>
  error?: string
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}

function normalizeConfig(value: unknown): Record<string, any> {
  if (!isRecord(value)) return {}
  const config = { ...value }
  if (Array.isArray(config.command)) {
    const [command, ...args] = config.command.map(String)
    config.command = command || ''
    if (!Array.isArray(config.args)) config.args = args
  }
  if (isRecord(config.environment) && !isRecord(config.env)) config.env = config.environment
  if (config.type === 'streamableHttp') config.type = 'http'
  if (config.type === 'remote') config.type = 'http'
  if (isRecord(config.http_headers) && !isRecord(config.headers)) config.headers = config.http_headers
  delete config.http_headers
  return config
}

function normalizeTransport(config: Record<string, any>): 'stdio' | 'http' | 'sse' {
  const value = String(config.transport || config.type || '').toLowerCase()
  if (value === 'sse') return 'sse'
  if (value === 'http' || value === 'streamable_http' || value === 'streamablehttp' || config.url) return 'http'
  return 'stdio'
}

function isManagedServer(name: string, config: Record<string, any>): boolean {
  return STUDIO_MANAGED_NAMES.has(name)
    || (isRecord(config.env) && String(config.env[MANAGED_ENV_KEY] || '') === '1')
}

export async function probeCodingAgentMcpConfig(
  configInput: Record<string, any>,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<CodingAgentMcpProbeResult> {
  const config = normalizeConfig(configInput)
  const transportType = normalizeTransport(config)
  const client = new Client({ name: 'hermes-studio-coding-agent-mcp-test', version: '1.0.0' })
  let stdioTransport: StdioClientTransport | null = null
  try {
    const transport = transportType === 'sse'
      ? new SSEClientTransport(new URL(String(config.url || '')), {
          requestInit: { headers: stringRecord(config.headers) },
        })
      : transportType === 'http'
        ? new StreamableHTTPClientTransport(new URL(String(config.url || '')), {
            requestInit: { headers: stringRecord(config.headers) },
          })
        : (stdioTransport = new StdioClientTransport({
          command: String(config.command || ''),
          args: Array.isArray(config.args) ? config.args.map(String) : [],
          env: isolatedCodingAgentChildEnv(stringRecord(config.env)),
          stderr: 'ignore',
        }))
    await client.connect(transport, { timeout: timeoutMs })
    const result = await client.listTools(undefined, { timeout: timeoutMs, cacheMode: 'refresh' })
    const toolDetails = result.tools.map(tool => ({
      name: String(tool.name),
      description: typeof tool.description === 'string' ? tool.description : '',
      input_schema: isRecord(tool.inputSchema)
        ? tool.inputSchema
        : { type: 'object', properties: {} },
    }))
    return {
      ok: true,
      tools: toolDetails.map(tool => tool.name),
      tool_details: toolDetails,
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    if (process.platform === 'win32' && stdioTransport?.pid) {
      killOwnedProcessTree(stdioTransport.pid, () => undefined)
    }
    await client.close().catch(() => undefined)
  }
}

function jsonMcpServers(content: string): Record<string, Record<string, any>> {
  const parsed: unknown = JSON.parse(content || '{}')
  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) return {}
  return Object.fromEntries(
    Object.entries(parsed.mcpServers)
      .filter((entry): entry is [string, Record<string, any>] => isRecord(entry[1]))
      .map(([name, config]) => [name, normalizeConfig(config)]),
  )
}

function openCodeMcpServers(content: string): Record<string, Record<string, any>> {
  const parsed: unknown = JSON.parse(content || '{}')
  if (!isRecord(parsed) || !isRecord(parsed.mcp)) return {}
  return Object.fromEntries(
    Object.entries(parsed.mcp)
      .filter((entry): entry is [string, Record<string, any>] => isRecord(entry[1]))
      .map(([name, config]) => [name, normalizeConfig(config)]),
  )
}

function tomlMcpServers(content: string): Record<string, Record<string, any>> {
  const parsed: unknown = parseToml(content || '')
  if (!isRecord(parsed) || !isRecord(parsed.mcp_servers)) return {}
  return Object.fromEntries(
    Object.entries(parsed.mcp_servers)
      .filter((entry): entry is [string, Record<string, any>] => isRecord(entry[1]))
      .map(([name, config]) => [name, normalizeConfig(config)]),
  )
}

function tomlServerHeader(line: string): { name: string; subtable: boolean } | null {
  const match = line.match(/^\s*\[mcp_servers\.(?:"((?:[^"\\]|\\.)+)"|([^\].]+))(?:\.([^\]]+))?\]\s*$/)
  if (!match) return null
  let name = match[1] || match[2] || ''
  if (match[1]) {
    try { name = JSON.parse(`"${match[1]}"`) } catch {}
  }
  return { name, subtable: Boolean(match[3]) }
}

export function disableTomlMcpServers(content: string, names: ReadonlySet<string>): string {
  if (!names.size) return content
  const lines = content.split(/\r?\n/)
  const output: string[] = []
  let currentServer = ''
  let inPrimaryServerBlock = false
  let enabledWritten = false

  const finishPrimaryBlock = () => {
    if (inPrimaryServerBlock && currentServer && names.has(currentServer) && !enabledWritten) {
      const trailingBlankLines: string[] = []
      while (output.length && !output[output.length - 1].trim()) {
        trailingBlankLines.unshift(output.pop()!)
      }
      output.push('enabled = false')
      output.push(...trailingBlankLines)
    }
  }

  for (const line of lines) {
    const header = tomlServerHeader(line)
    if (header) {
      finishPrimaryBlock()
      currentServer = header.name
      inPrimaryServerBlock = !header.subtable
      enabledWritten = false
      output.push(line)
      continue
    }
    if (/^\s*\[/.test(line)) {
      finishPrimaryBlock()
      currentServer = ''
      inPrimaryServerBlock = false
      enabledWritten = false
      output.push(line)
      continue
    }
    if (
      inPrimaryServerBlock
      && currentServer
      && names.has(currentServer)
      && /^\s*enabled\s*=/.test(line)
    ) {
      output.push('enabled = false')
      enabledWritten = true
      continue
    }
    output.push(line)
  }
  finishPrimaryBlock()
  return output.join('\n')
}

async function unhealthyCustomServers(
  servers: Record<string, Record<string, any>>,
  probe: typeof probeCodingAgentMcpConfig,
): Promise<Map<string, string>> {
  const candidates = Object.entries(servers)
    .filter(([name, config]) => config.enabled !== false && !isManagedServer(name, config))
  const results = await Promise.all(candidates.map(async ([name, config]) => {
    let result: CodingAgentMcpProbeResult
    try {
      result = await probe(config)
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    return [name, result] as const
  }))
  return new Map(
    results
      .filter((entry): entry is readonly [string, CodingAgentMcpProbeResult & { ok: false }] => !entry[1].ok)
      .map(([name, result]) => [name, String(result.error || 'MCP probe failed')]),
  )
}

export async function isolateUnhealthyRuntimeMcpServers(
  agentId: string,
  configPath: string,
  options: { probe?: typeof probeCodingAgentMcpConfig } = {},
): Promise<string[]> {
  if (!['claude-code', 'codex', 'pi', 'grok', 'opencode', 'dsh'].includes(agentId)) return []
  let content: string
  try {
    content = await readFile(configPath, 'utf-8')
  } catch {
    return []
  }

  let servers: Record<string, Record<string, any>>
  try {
    servers = agentId === 'dsh'
      ? Object.fromEntries([...readDshMcpServers(content)].filter(([name]) => {
          try { assertDshMcpProbeIsLiteral(content, name); return true }
          catch { return false }
        }))
      : agentId === 'claude-code' || agentId === 'pi'
      ? jsonMcpServers(content)
      : agentId === 'opencode'
        ? openCodeMcpServers(content)
        : tomlMcpServers(content)
  } catch (err) {
    logger.warn({ err, agentId, configPath }, '[coding-agent-mcp] skipped runtime isolation for invalid config')
    return []
  }

  const unhealthy = await unhealthyCustomServers(servers, options.probe || probeCodingAgentMcpConfig)
  if (!unhealthy.size) return []

  let updated = content
  if (agentId === 'dsh') {
    for (const name of unhealthy.keys()) updated = updateDshMcpServer(updated, name, { ...servers[name], enabled: false })
  } else if (agentId === 'claude-code' || agentId === 'pi') {
    const parsed = JSON.parse(content || '{}') as Record<string, any>
    const mcpServers = isRecord(parsed.mcpServers) ? { ...parsed.mcpServers } : {}
    for (const name of unhealthy.keys()) delete mcpServers[name]
    parsed.mcpServers = mcpServers
    updated = `${JSON.stringify(parsed, null, 2)}\n`
  } else if (agentId === 'opencode') {
    const parsed = JSON.parse(content || '{}') as Record<string, any>
    const mcp = isRecord(parsed.mcp) ? { ...parsed.mcp } : {}
    for (const name of unhealthy.keys()) delete mcp[name]
    parsed.mcp = mcp
    updated = `${JSON.stringify(parsed, null, 2)}\n`
  } else {
    updated = disableTomlMcpServers(content, new Set(unhealthy.keys()))
  }
  await writeFile(configPath, updated, 'utf-8')
  for (const [name, error] of unhealthy) {
    logger.warn({ agentId, name, error }, '[coding-agent-mcp] excluded unhealthy MCP server from current runtime')
  }
  return [...unhealthy.keys()]
}
