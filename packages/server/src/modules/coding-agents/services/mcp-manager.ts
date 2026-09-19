import { readDshMcpServers, updateDshMcpServer, validateDshMcpServer, assertDshMcpProbeIsLiteral } from './dsh/config'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import {
  getCodingAgentManagedMcpServerConfigs,
  invalidateCodingAgentConfigRuntime,
  readCodingAgentConfigFile,
  writeCodingAgentConfigFile,
  type CodingAgentId,
  type CodingAgentConfigScope,
} from './index'
import { setManagedMcpServerEnabled, setManagedMcpServerOverride } from './mcp-overrides'
import { getWebUiHome } from '../../studio/public/config'
import { probeCodingAgentMcpConfig } from './mcp-runtime-isolation'

const CODING_AGENT_IDS = new Set(['claude-code', 'codex', 'pi', 'grok', 'opencode', 'dsh', 'cursor'])
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

export interface CodingAgentMcpServer {
  name: string
  transport: 'stdio' | 'http' | 'sse'
  connected: boolean
  tools: number
  tools_registered: number
  tool_names: string[]
  tool_names_registered: string[]
  tool_details: Array<{ name: string; description?: string }>
  error?: string | null
  raw_config: Record<string, any>
  managed: boolean
}

export interface CodingAgentMcpList {
  ok: true
  servers: CodingAgentMcpServer[]
  total_tools: number
}

function assertAgentId(id: string): void {
  if (!CODING_AGENT_IDS.has(id)) {
    const error = new Error('Unsupported coding agent')
    ;(error as any).status = 404
    throw error
  }
}

function configKey(id: string): string {
  return id === 'codex' ? 'config' : 'mcp'
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isManaged(name: string, config: Record<string, any>): boolean {
  return STUDIO_MANAGED_NAMES.has(name)
    || (isRecord(config.env) && String(config.env[MANAGED_ENV_KEY] || '') === '1')
}

function normalizeTransport(config: Record<string, any>): 'stdio' | 'http' | 'sse' {
  const value = String(config.transport || config.type || '').toLowerCase()
  if (value === 'sse') return 'sse'
  if (value === 'http' || value === 'streamable_http' || value === 'streamablehttp' || config.url) return 'http'
  return 'stdio'
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
  delete config.environment
  if (config.type === 'streamableHttp') config.type = 'http'
  if (config.type === 'local') config.type = 'stdio'
  if (config.type === 'remote') config.type = 'http'
  if (isRecord(config.http_headers) && !isRecord(config.headers)) config.headers = config.http_headers
  delete config.http_headers
  return config
}

function serializeOpenCodeConfig(value: Record<string, any>): Record<string, any> {
  const config = normalizeConfig(value)
  const native = { ...config }
  delete native.transport
  if (String(config.command || '').trim()) {
    native.type = 'local'
    native.command = [
      String(config.command),
      ...(Array.isArray(config.args) ? config.args.map(String) : []),
    ]
    delete native.args
    if (isRecord(config.env) && Object.keys(config.env).length) native.environment = config.env
    delete native.env
    delete native.url
    delete native.headers
    return native
  }
  native.type = 'remote'
  native.url = String(config.url || '')
  delete native.command
  delete native.args
  delete native.env
  delete native.environment
  return native
}

function parseJsonDocument(content: string): { root: Record<string, any>; servers: Map<string, Record<string, any>> } {
  let root: Record<string, any> = {}
  try {
    const parsed = JSON.parse(content || '{}')
    if (isRecord(parsed)) root = parsed
  } catch {
    const error = new Error('Cannot manage MCP servers while the configuration contains invalid JSON')
    ;(error as any).status = 400
    throw error
  }
  const source = isRecord(root.mcpServers) ? root.mcpServers : {}
  return {
    root,
    servers: new Map(Object.entries(source).map(([name, value]) => [name, normalizeConfig(value)])),
  }
}

function parseOpenCodeDocument(content: string): { root: Record<string, any>; servers: Map<string, Record<string, any>> } {
  let root: Record<string, any> = {}
  try {
    const parsed = JSON.parse(content || '{}')
    if (isRecord(parsed)) root = parsed
  } catch {
    const error = new Error('Cannot manage MCP servers while the configuration contains invalid JSON')
    ;(error as any).status = 400
    throw error
  }
  const source = isRecord(root.mcp) ? root.mcp : {}
  return {
    root,
    servers: new Map(Object.entries(source).map(([name, value]) => [name, normalizeConfig(value)])),
  }
}

function tomlServerHeader(line: string): { name: string; subtable: string } | null {
  const match = line.match(/^\s*\[mcp_servers\.(?:"((?:[^"\\]|\\.)+)"|([^\].]+))(?:\.([^\]]+))?\]\s*$/)
  if (!match) return null
  let name = match[1] || match[2] || ''
  if (match[1]) {
    try { name = JSON.parse(`"${match[1]}"`) } catch {}
  }
  return { name, subtable: String(match[3] || '') }
}

function splitTomlDocument(content: string): { other: string; blocks: Map<string, string> } {
  const other: string[] = []
  const blocks = new Map<string, string[]>()
  let currentServer = ''
  for (const line of content.split(/\r?\n/)) {
    const header = tomlServerHeader(line)
    if (header) {
      currentServer = header.name
      const lines = blocks.get(currentServer) || []
      lines.push(line)
      blocks.set(currentServer, lines)
      continue
    }
    if (/^\s*\[/.test(line)) currentServer = ''
    if (currentServer) {
      blocks.get(currentServer)!.push(line)
    } else {
      other.push(line)
    }
  }
  return {
    other: other.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    blocks: new Map([...blocks].map(([name, lines]) => [name, lines.join('\n').trim()])),
  }
}

function parseTomlServers(content: string): Map<string, Record<string, any>> {
  let root: Record<string, any>
  try {
    const parsed: unknown = parseToml(content || '')
    root = isRecord(parsed) ? parsed : {}
  } catch {
    const error = new Error('Cannot manage MCP servers while the configuration contains invalid TOML')
    ;(error as any).status = 400
    throw error
  }
  const source = isRecord(root.mcp_servers) ? root.mcp_servers : {}
  return new Map(Object.entries(source).map(([name, value]) => [name, normalizeConfig(value)]))
}

function configValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => configValuesEqual(value, right[index]))
  }
  if (!isRecord(left) || !isRecord(right)) return false
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  return leftKeys.length === rightKeys.length
    && leftKeys.every(key => Object.prototype.hasOwnProperty.call(right, key)
      && configValuesEqual(left[key], right[key]))
}

function configWithoutEnabled(config: Record<string, any>): Record<string, any> {
  const normalized = { ...config }
  delete normalized.enabled
  return normalized
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

function tomlKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : tomlString(value)
}

function serializeTomlValue(value: unknown): string | null {
  if (typeof value === 'string') return tomlString(value)
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) {
    const items = value.map(serializeTomlValue)
    return items.every(item => item != null) ? `[${items.join(', ')}]` : null
  }
  if (isRecord(value)) {
    const entries = Object.entries(value)
      .map(([key, item]) => {
        const serialized = serializeTomlValue(item)
        return serialized == null ? null : `${tomlKey(key)} = ${serialized}`
      })
      .filter((entry): entry is string => Boolean(entry))
    return `{ ${entries.join(', ')} }`
  }
  return null
}

function serializeTomlServer(name: string, input: Record<string, any>): string {
  const config = normalizeConfig(input)
  const lines = [`[mcp_servers.${tomlKey(name)}]`]
  const nestedKeys = new Set(['env', 'headers', 'http_headers', 'tools'])
  for (const [key, value] of Object.entries(config)) {
    if (nestedKeys.has(key) || value == null) continue
    const serialized = serializeTomlValue(value)
    if (serialized != null) lines.push(`${key} = ${serialized}`)
  }
  if (isRecord(config.env) && Object.keys(config.env).length) {
    const value = serializeTomlValue(config.env)
    if (value) lines.push(`env = ${value}`)
  }
  const headers = isRecord(config.headers) ? config.headers : isRecord(config.http_headers) ? config.http_headers : null
  if (headers && Object.keys(headers).length) {
    lines.push('', `[mcp_servers.${tomlKey(name)}.http_headers]`)
    for (const [key, value] of Object.entries(headers)) {
      const serialized = serializeTomlValue(value)
      if (serialized != null) lines.push(`${tomlKey(key)} = ${serialized}`)
    }
  }
  return lines.join('\n')
}

async function readServers(id: string, scope: CodingAgentConfigScope): Promise<{
  content: string
  servers: Map<string, Record<string, any>>
}> {
  assertAgentId(id)
  const file = await readCodingAgentConfigFile(id, configKey(id), scope)
  let servers: Map<string, Record<string, any>>
  if (id === 'claude-code' || id === 'pi' || id === 'cursor') {
    servers = parseJsonDocument(file.content).servers
  } else if (id === 'dsh') {
    servers = readDshMcpServers(file.content)
  } else if (id === 'opencode') {
    servers = parseOpenCodeDocument(file.content).servers
  } else {
    servers = parseTomlServers(file.content)
  }

  servers.delete('ekko-studio-plan')
  const managed = getCodingAgentManagedMcpServerConfigs(id as CodingAgentId, scope.profile)
  for (const [name, config] of Object.entries(managed)) {
    servers.set(name, normalizeConfig(config))
  }
  return {
    content: file.content,
    servers,
  }
}

async function writeServer(
  id: string,
  originalContent: string,
  name: string,
  config: Record<string, any> | null,
  scope: CodingAgentConfigScope,
): Promise<void> {
  if (id === 'dsh') {
    await writeCodingAgentConfigFile(id, configKey(id), updateDshMcpServer(originalContent, name, config), scope)
    return
  }
  if (id === 'claude-code' || id === 'pi' || id === 'cursor') {
    const { root } = parseJsonDocument(originalContent)
    const persistedServers = isRecord(root.mcpServers) ? { ...root.mcpServers } : {}
    for (const managedName of STUDIO_MANAGED_NAMES) delete persistedServers[managedName]
    if (config) persistedServers[name] = config
    else delete persistedServers[name]
    root.mcpServers = persistedServers
    await writeCodingAgentConfigFile(id, configKey(id), `${JSON.stringify(root, null, 2)}\n`, scope)
    return
  }
  if (id === 'opencode') {
    const { root } = parseOpenCodeDocument(originalContent)
    const persistedServers = isRecord(root.mcp) ? { ...root.mcp } : {}
    for (const managedName of STUDIO_MANAGED_NAMES) delete persistedServers[managedName]
    if (config) persistedServers[name] = serializeOpenCodeConfig(config)
    else delete persistedServers[name]
    root.mcp = persistedServers
    await writeCodingAgentConfigFile(id, configKey(id), `${JSON.stringify(root, null, 2)}\n`, scope)
    return
  }
  const { other, blocks } = splitTomlDocument(originalContent)
  for (const managedName of STUDIO_MANAGED_NAMES) blocks.delete(managedName)
  if (config) blocks.set(name, serializeTomlServer(name, config))
  else blocks.delete(name)
  const mcp = [...blocks.values()].join('\n\n')
  const content = [other, mcp].filter(Boolean).join('\n\n').concat('\n')
  await writeCodingAgentConfigFile(id, configKey(id), content, scope)
}

function removeServerFromContent(id: string, content: string, name: string): string | null {
  if (id === 'dsh') return readDshMcpServers(content).has(name) ? updateDshMcpServer(content, name, null) : null
  if (id === 'claude-code' || id === 'pi' || id === 'cursor') {
    const { root } = parseJsonDocument(content)
    const persistedServers = isRecord(root.mcpServers) ? { ...root.mcpServers } : {}
    if (!Object.prototype.hasOwnProperty.call(persistedServers, name)) return null
    delete persistedServers[name]
    root.mcpServers = persistedServers
    return `${JSON.stringify(root, null, 2)}\n`
  }
  if (id === 'opencode') {
    const { root } = parseOpenCodeDocument(content)
    const persistedServers = isRecord(root.mcp) ? { ...root.mcp } : {}
    if (!Object.prototype.hasOwnProperty.call(persistedServers, name)) return null
    delete persistedServers[name]
    root.mcp = persistedServers
    return `${JSON.stringify(root, null, 2)}\n`
  }

  const { other, blocks } = splitTomlDocument(content)
  if (!blocks.delete(name)) return null
  const mcp = [...blocks.values()].join('\n\n')
  return [other, mcp].filter(Boolean).join('\n\n').concat('\n')
}

async function pruneScopedServerCopies(id: string, name: string): Promise<number> {
  const modelRoot = join(getWebUiHome(), 'coding-agent', 'model')
  const fileName = id === 'dsh' ? 'cordis.patch.yml' : id === 'claude-code' || id === 'pi' || id === 'cursor'
    ? 'mcp.json'
    : id === 'opencode'
      ? 'opencode.json'
      : 'config.toml'
  const candidates: string[] = []

  const directories = async (path: string) => {
    try {
      return (await readdir(path, { withFileTypes: true })).filter(entry => entry.isDirectory())
    } catch {
      return []
    }
  }
  const visit = async (path: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(path, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) await visit(child)
      else if (entry.isFile() && entry.name === fileName) candidates.push(child)
    }
  }

  for (const profile of await directories(modelRoot)) {
    for (const provider of await directories(join(modelRoot, profile.name))) {
      await visit(join(modelRoot, profile.name, provider.name, id))
    }
  }

  let pruned = 0
  for (const path of candidates) {
    let content
    try {
      content = await readFile(path, 'utf-8')
    } catch {
      continue
    }
    let updated
    try {
      updated = removeServerFromContent(id, content, name)
    } catch {
      continue
    }
    if (updated == null || updated === content) continue
    await writeFile(path, updated, 'utf-8')
    pruned += 1
  }
  return pruned
}

export async function listCodingAgentMcpServers(
  id: string,
  scope: CodingAgentConfigScope = {},
): Promise<CodingAgentMcpList> {
  const { servers } = await readServers(id, scope)
  const normalized = [...servers].map(([name, config]) => {
    return {
      name,
      transport: normalizeTransport(config),
      connected: false,
      tools: 0,
      tools_registered: 0,
      tool_names: [],
      tool_names_registered: [],
      tool_details: [],
      error: null,
      raw_config: config,
      managed: isManaged(name, config),
    } satisfies CodingAgentMcpServer
  })
  return {
    ok: true,
    servers: normalized.sort((left, right) => left.name.localeCompare(right.name)),
    total_tools: normalized.reduce((total, server) => total + server.tools_registered, 0),
  }
}

export async function upsertCodingAgentMcpServer(
  id: string,
  name: string,
  config: Record<string, any>,
  scope: CodingAgentConfigScope = {},
): Promise<{ ok: true; name: string }> {
  assertAgentId(id)
  const normalizedName = name.trim().replace(/^hermes-studio-(api|browser|devices|use)$/, 'ekko-studio-$1')
  if (!normalizedName || normalizedName.length > 128 || /[/\\\x00-\x1f]/.test(normalizedName)) {
    const error = new Error('Valid server name is required')
    ;(error as any).status = 400
    throw error
  }
  if (STUDIO_MANAGED_NAMES.has(normalizedName)) {
    const profile = scope.profile || 'default'
    const managedConfig = normalizeConfig(getCodingAgentManagedMcpServerConfigs(
      id as CodingAgentId,
      profile,
    )[normalizedName] || {})
    const suppliedConfig = normalizeConfig(config)
    const suppliedConfiguration = configWithoutEnabled(suppliedConfig)
    const changesConfiguration = Object.keys(suppliedConfiguration).length > 0
      && !configValuesEqual(suppliedConfiguration, configWithoutEnabled(managedConfig))
    if (!changesConfiguration) {
      if (typeof suppliedConfig.enabled === 'boolean') {
        setManagedMcpServerEnabled(id, profile, normalizedName, suppliedConfig.enabled)
        invalidateCodingAgentConfigRuntime(id, scope, { profileScoped: true })
      }
      return { ok: true, name: normalizedName }
    }

    if (!String(suppliedConfiguration.command || '').trim()
      && !String(suppliedConfiguration.url || '').trim()) {
      const error = new Error('MCP server requires command or url')
      ;(error as any).status = 400
      throw error
    }
    if (id === 'dsh') validateDshMcpServer(normalizedName, config)
    setManagedMcpServerOverride(
      id,
      profile,
      normalizedName,
      suppliedConfiguration,
    )
    setManagedMcpServerEnabled(
      id,
      profile,
      normalizedName,
      suppliedConfig.enabled !== false,
    )
    invalidateCodingAgentConfigRuntime(id, scope, { profileScoped: true })
    return { ok: true, name: normalizedName }
  }
  if (!isRecord(config) || (!String(config.command || '').trim() && !String(config.url || '').trim())) {
    const error = new Error('MCP server requires command or url')
    ;(error as any).status = 400
    throw error
  }
  if (id === 'dsh') validateDshMcpServer(normalizedName, config)
  const current = await readServers(id, scope)
  await writeServer(id, current.content, normalizedName, normalizeConfig(config), scope)
  return { ok: true, name: normalizedName }
}

export async function removeCodingAgentMcpServer(
  id: string,
  name: string,
  scope: CodingAgentConfigScope = {},
): Promise<{ ok: true }> {
  if (STUDIO_MANAGED_NAMES.has(name)) {
    setManagedMcpServerEnabled(id, scope.profile || 'default', name, false)
    invalidateCodingAgentConfigRuntime(id, scope, { profileScoped: true })
    return { ok: true }
  }
  const current = await readServers(id, scope)
  await writeServer(id, current.content, name, null, scope)
  await pruneScopedServerCopies(id, name)
  return { ok: true }
}

export async function testCodingAgentMcpServer(
  id: string,
  name: string,
  scope: CodingAgentConfigScope = {},
): Promise<{
  ok: boolean
  tools?: string[]
  tool_details?: Array<{ name: string; description?: string; input_schema?: Record<string, unknown> }>
  error?: string
}> {
  assertAgentId(id)
  const current = await readServers(id, scope)
  const config = current.servers.get(name)
  if (!config) return { ok: false, error: `MCP server not found: ${name}` }
  if (config.enabled === false) return { ok: false, error: 'Enable the MCP server before testing it' }

  if (id === 'dsh') {
    try { assertDshMcpProbeIsLiteral(current.content, name) } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  return probeCodingAgentMcpConfig(config)
}
