import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import type { AgentTool, AgentToolContentPart, AgentToolContext, AgentToolProvider, AgentToolResult } from './types'

export interface StdioMcpServerConfig {
  type: 'stdio'
  command: string
  args: string[]
  env: Record<string, string>
  supportsParallelToolCalls: boolean
  requestTimeoutMs?: number
}

export interface StreamableHttpMcpServerConfig {
  type: 'streamable_http'
  url: string
  headers: Record<string, string>
  supportsParallelToolCalls: boolean
  requestTimeoutMs?: number
}

export type McpServerConfig = StdioMcpServerConfig | StreamableHttpMcpServerConfig
export type McpClientTransport = Parameters<Client['connect']>[0]

export interface McpToolProviderOptions {
  /** Fail discovery when a configured server cannot initialize instead of omitting its tools. */
  failOnConnectionError?: boolean
  /** The provider owns the returned transport. Custom transports receive only explicitly configured env. */
  createTransport?: (server: McpServerConfig, context: { serverName: string; signal: AbortSignal }) => McpClientTransport | Promise<McpClientTransport>
}
export interface McpToolProvider extends AgentToolProvider {
  /** Permanently end one connection scope and wait for confirmed transport cleanup. */
  closeScope(signal?: AbortSignal): Promise<void>
  /** End all scopes; a failed cleanup stays failed on subsequent calls. */
  dispose(): Promise<void>
}

const DEFAULT_MCP_TIMEOUT_MS = 30_000
const MODEL_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/
const MCP_PROXY_PREFIX = 'mcp__'

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizeServerType(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (
    normalized === 'http'
    || normalized === 'streamable-http'
    || normalized === 'streamablehttp'
  ) {
    return 'streamable_http'
  }
  return normalized
}

function normalizeServerConfig(value: unknown, inheritEnv: boolean): McpServerConfig | null {
  if (!isRecord(value) || value.enabled === false || value.disabled === true) return null
  const supportsParallelToolCalls = value.supports_parallel_tool_calls === true
  const requestTimeoutMs = typeof value.requestTimeoutMs === 'number'
    && Number.isInteger(value.requestTimeoutMs) && value.requestTimeoutMs > 0 ? value.requestTimeoutMs : undefined
  const configuredType = normalizeServerType(value.type)
  const command = typeof value.command === 'string' ? value.command.trim() : ''
  const rawUrl = typeof value.url === 'string' ? value.url.trim() : ''
  const isHttp = configuredType === 'streamable_http' || (!configuredType && !command && !!rawUrl)

  if (isHttp) {
    try {
      const url = new URL(rawUrl)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
      return {
        type: 'streamable_http',
        url: url.toString(),
        headers: normalizeStringRecord(value.headers),
        supportsParallelToolCalls,
        requestTimeoutMs,
      }
    } catch {
      return null
    }
  }

  if (configuredType && configuredType !== 'stdio') return null
  if (!command) return null
  return {
    type: 'stdio',
    command,
    args: Array.isArray(value.args) ? value.args.map(arg => String(arg)) : [],
    env: inheritEnv ? normalizeProcessEnv(value.env) : normalizeStringRecord(value.env),
    supportsParallelToolCalls,
    requestTimeoutMs,
  }
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(Object.entries(value)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

function normalizeProcessEnv(value: unknown): Record<string, string> {
  const normalized = Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  for (const [key, item] of Object.entries(normalizeStringRecord(value))) normalized[key] = item
  return normalized
}

function responseContentToText(result: any): string {
  const content = Array.isArray(result?.content) ? result.content : []
  const text = content
    .map((item: any) => {
      if (item?.type === 'text') return String(item.text ?? '')
      if (item?.type === 'image') return `[Image: ${String(item.mimeType || 'image/png')}]`
      return JSON.stringify(item)
    })
    .filter(Boolean)
    .join('\n')
  return text || JSON.stringify(result ?? {})
}

function responseContentParts(result: any): AgentToolContentPart[] | undefined {
  if (!Array.isArray(result?.content)) return undefined
  const parts: AgentToolContentPart[] = []
  for (const item of result.content) {
    if (item?.type === 'text') parts.push({ type: 'text', text: String(item.text ?? '') })
    if (item?.type === 'image' && typeof item.data === 'string' && /^image\/(?:png|jpeg|webp|gif)$/i.test(String(item.mimeType || ''))) {
      parts.push({ type: 'image', data: item.data, mimeType: String(item.mimeType).toLowerCase() })
    }
  }
  return parts.some(part => part.type === 'image') ? parts : undefined
}

function responseDataWithoutImagePayloads(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(responseDataWithoutImagePayloads)
  if (!isRecord(value)) return value
  if (value.type === 'image' && typeof value.data === 'string') {
    return {
      ...value,
      data: `[image payload forwarded separately: ${String(value.mimeType || 'image/png')}]`,
    }
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, responseDataWithoutImagePayloads(child)]))
}

class McpClientSession {
  private disposed = false
  private client: Client | null = null
  private transport: McpClientTransport | null = null
  private initialized: Promise<void> | null = null
  private closing?: Promise<void>
  private transportClosing?: Promise<void>
  private resourcesClosing?: Promise<void>

  constructor(readonly fingerprint: string, private readonly server: McpServerConfig, private readonly scope: AbortSignal | undefined,
    private readonly createTransport: () => McpClientTransport | Promise<McpClientTransport>) {}

  async listTools(timeoutMs: number): Promise<any[]> {
    const client = await this.ensureConnected(timeoutMs)
    const result = await client.listTools(undefined, { timeout: timeoutMs, cacheMode: 'refresh' })
    return result.tools
  }

  async callTool(name: string, input: Record<string, unknown>, timeoutMs: number, scope?: AbortSignal): Promise<AgentToolResult> {
    try {
      if (scope !== this.scope) throw new Error('MCP tool belongs to a different connection scope')
      scope?.throwIfAborted()
      const client = await this.ensureConnected(timeoutMs)
      const result = await client.callTool({ name, arguments: input }, { timeout: this.server.requestTimeoutMs ?? timeoutMs })
      const content = responseContentToText(result)
      return {
        ok: result.isError !== true,
        content,
        contentParts: responseContentParts(result),
        data: responseDataWithoutImagePayloads(result),
        error: result.isError === true ? content : undefined,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, content: message, error: message }
    }
  }

  dispose(): Promise<void> {
    this.disposed = true
    return this.closing ??= (async () => {
      // Stop an already acquired transport immediately, including during handshake.
      const early = this.closeResources()
      await Promise.allSettled([early, this.initialized])
      await this.closeResources() // The factory may have returned after disposal began.
    })()
  }

  private closeTransport(): Promise<void> {
    return this.transportClosing ??= Promise.resolve().then(() => this.transport!.close())
  }
  private closeResources(): Promise<void> {
    if (!this.transport) return Promise.resolve()
    return this.resourcesClosing ??= (async () => {
      if (this.transport instanceof StreamableHTTPClientTransport) {
        // DELETE is optional. Bound it, then close() aborts any remaining HTTP work.
        let timer: ReturnType<typeof setTimeout> | undefined
        try { await Promise.race([this.transport.terminateSession(), new Promise<void>(resolve => { timer = setTimeout(resolve, 1000) })]) }
        catch { /* Servers may not support session termination. */ }
        finally { clearTimeout(timer) }
      }
      try { await this.client?.close() }
      finally { await this.closeTransport() }
    })()
  }

  private async initialize(timeoutMs: number): Promise<void> {
    const transport = await this.createTransport()
    this.transport = transport
    if (this.disposed) { await this.closeResources(); throw new Error('MCP connection scope has ended') }
    const client = new Client({ name: 'ekko-agent', version: '0.1.0' })
    this.client = client
    // The MCP client may initiate close without awaiting it after handshake failure.
    // Keep the real failure in our owned barrier, while protocol-driven close is handled.
    const wrapped = new Proxy(transport, {
      get: (target, key) => {
        if (key === 'close') return () => this.closeTransport().catch(() => undefined)
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
      set: (target, key, value) => Reflect.set(target, key, value, target),
    })
    try { await client.connect(wrapped, { timeout: timeoutMs }) }
    catch (error) { await this.closeResources(); throw error }
  }
  private async ensureConnected(timeoutMs: number): Promise<Client> {
    if (this.disposed) throw new Error('MCP connection scope has ended')
    this.initialized ??= this.initialize(timeoutMs)
    await this.initialized
    if (this.disposed) throw new Error('MCP connection scope has ended')
    return this.client!
  }
}

class McpTool implements AgentTool {
  readonly definition: AgentTool['definition']
  readonly concurrency: AgentTool['concurrency']

  constructor(
    serverName: string,
    private readonly remoteName: string,
    tool: any,
    private readonly session: McpClientSession,
    supportsParallelToolCalls: boolean,
  ) {
    this.concurrency = supportsParallelToolCalls ? 'parallel' : 'serial'
    this.definition = {
      name: String(tool.name || remoteName),
      description: String(tool.description || `MCP tool ${remoteName} from ${serverName}`),
      parameters: isRecord(tool.inputSchema) ? tool.inputSchema : { type: 'object', properties: {} },
    }
  }

  async execute(input: Record<string, unknown>, context: AgentToolContext = {}): Promise<AgentToolResult> {
    return await this.session.callTool(this.remoteName, input, context.timeoutMs || DEFAULT_MCP_TIMEOUT_MS, context.mcpSessionSignal)
  }
}

class McpProxyTool implements AgentTool {
  readonly definition: AgentTool['definition']
  readonly concurrency: AgentTool['concurrency']
  private readonly remoteTools: Map<string, any>

  constructor(
    proxyName: string,
    serverName: string,
    tools: any[],
    private readonly session: McpClientSession,
    supportsParallelToolCalls: boolean,
  ) {
    this.concurrency = supportsParallelToolCalls ? 'parallel' : 'serial'
    this.remoteTools = new Map(tools.map(tool => [String(tool.name), tool]))
    this.definition = {
      name: proxyName,
      description: [
        `Call a tool from the ${serverName} MCP server.`,
        'Pass the exact remote MCP tool name in "tool"; it will be preserved unchanged.',
        ...tools.map(tool => `${String(tool.name)}: ${String(tool.description || 'No description provided.')}`),
      ].join(' '),
      parameters: {
        type: 'object',
        anyOf: tools.map(tool => ({
          type: 'object',
          title: String(tool.name),
          description: String(tool.description || `Call ${String(tool.name)}.`),
          properties: {
            tool: {
              type: 'string',
              enum: [String(tool.name)],
              description: 'Exact remote MCP tool name.',
            },
            arguments: isRecord(tool.inputSchema)
              ? tool.inputSchema
              : { type: 'object', properties: {} },
          },
          required: ['tool', 'arguments'],
          additionalProperties: false,
        })),
      },
    }
  }

  async execute(input: Record<string, unknown>, context: AgentToolContext = {}): Promise<AgentToolResult> {
    const remoteName = typeof input.tool === 'string' ? input.tool : ''
    if (!this.remoteTools.has(remoteName)) {
      const error = `Unknown remote MCP tool: ${remoteName || '(missing)'}`
      return { ok: false, content: error, error }
    }
    const remoteInput = isRecord(input.arguments) ? input.arguments : {}
    return await this.session.callTool(remoteName, remoteInput, context.timeoutMs || DEFAULT_MCP_TIMEOUT_MS, context.mcpSessionSignal)
  }
}

function modelSafeToolName(name: string): boolean {
  return MODEL_TOOL_NAME_PATTERN.test(name)
}

function proxyToolName(serverName: string, usedNames: Set<string>): string {
  const readable = serverName.replace(/[^a-zA-Z0-9_-]/g, '_') || 'server'
  const base = `${MCP_PROXY_PREFIX}${readable}`.slice(0, 64)
  if (!usedNames.has(base)) return base
  const hash = stableNameHash(serverName)
  for (let attempt = 1; ; attempt += 1) {
    const suffix = `_${hash}${attempt === 1 ? '' : `_${attempt}`}`
    const candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`
    if (!usedNames.has(candidate)) return candidate
  }
}

function stableNameHash(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

export function createMcpToolProvider(options: McpToolProviderOptions = {}): McpToolProvider {
  interface Scope {
    sessions: Map<string, McpClientSession>
    lifecycle: AbortController
    pending: Promise<void>
    closing?: Promise<void>
    detach?: () => void
  }
  const makeScope = (): Scope => ({ sessions: new Map(), lifecycle: new AbortController(), pending: Promise.resolve() })
  const shared = makeScope(), scoped = new WeakMap<AbortSignal, Scope>(), live = new Set([shared])
  let disposed = false, closing: Promise<void> | undefined
  const close = (state: Scope): Promise<void> => {
    state.lifecycle.abort()
    state.detach?.()
    return state.closing ??= (async () => {
      const results = await Promise.allSettled([...state.sessions.values()].map(session => session.dispose()))
      await state.pending.catch(() => undefined)
      const failed = results.filter(result => result.status === 'rejected')
      if (failed.length) throw new AggregateError(failed.map(result => result.reason), 'MCP connection cleanup failed')
      state.sessions.clear(); live.delete(state)
    })()
  }
  const getScope = (signal?: AbortSignal): Scope => {
    if (!signal) return shared
    let state = scoped.get(signal)
    if (!state) {
      state = makeScope(); scoped.set(signal, state); live.add(state)
      const owned = state
      const abort = () => { void close(owned).catch(() => undefined) }
      state.detach = () => signal.removeEventListener('abort', abort)
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    }
    return state
  }
  const provider: McpToolProvider = {
    id: 'mcp',
    closeScope: signal => close(getScope(signal)),
    dispose() {
      disposed = true
      return closing ??= (async () => {
        const results = await Promise.allSettled([...live].map(close))
        const failed = results.filter(result => result.status === 'rejected')
        if (failed.length) throw new AggregateError(failed.map(result => result.reason), 'MCP provider cleanup failed')
      })()
    },
    async listTools(context?: AgentToolContext): Promise<AgentTool[]> {
      if (disposed) throw new Error('MCP provider has ended')
      const state = getScope(context?.mcpSessionSignal)
      const snapshot: AgentToolContext = { mcpSessionSignal: context?.mcpSessionSignal,
        timeoutMs: context?.timeoutMs, mcpServers: structuredClone(context?.mcpServers || {}) }
      const operation = state.pending.then(() => discover(state, snapshot))
      state.pending = operation.then(() => undefined, () => undefined)
      return operation
    },
  }
  async function discover(state: Scope, context?: AgentToolContext): Promise<AgentTool[]> {
    const scope = state.lifecycle.signal, sessions = state.sessions
    scope.throwIfAborted()
    const timeoutMs = context?.timeoutMs || DEFAULT_MCP_TIMEOUT_MS
    const tools: AgentTool[] = []
    const usedNames = new Set<string>()
    const configuredServerNames = new Set<string>()

    for (const [serverName, rawConfig] of Object.entries(context?.mcpServers || {})) {
      scope?.throwIfAborted()
      const server = normalizeServerConfig(rawConfig, !options.createTransport)
      if (!server) continue
      configuredServerNames.add(serverName)
      const fingerprint = JSON.stringify(server)
      let session = sessions.get(serverName)
      if (!session || session.fingerprint !== fingerprint) {
        await session?.dispose()
        scope.throwIfAborted()
        session = new McpClientSession(fingerprint, server, context?.mcpSessionSignal, () => options.createTransport
          ? options.createTransport(server, { serverName, signal: scope })
          : server.type === 'streamable_http'
            ? new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } })
            : new StdioClientTransport({ command: server.command, args: server.args, env: server.env, stderr: 'ignore' }))
        sessions.set(serverName, session)
      }

      try {
        const remoteTools = (await session.listTools(timeoutMs))
          .filter(tool => !!tool?.name)
        scope?.throwIfAborted()
        const requiresProxy = remoteTools.some(tool => {
          const name = String(tool.name)
          return !modelSafeToolName(name) || usedNames.has(name)
        })

        if (requiresProxy && remoteTools.length) {
          const proxyName = proxyToolName(serverName, usedNames)
          usedNames.add(proxyName)
          tools.push(new McpProxyTool(
            proxyName,
            serverName,
            remoteTools,
            session,
            server.supportsParallelToolCalls,
          ))
          continue
        }

        for (const tool of remoteTools) {
          usedNames.add(String(tool.name))
          tools.push(new McpTool(
            serverName,
            String(tool.name),
            tool,
            session,
            server.supportsParallelToolCalls,
          ))
        }
      } catch (error) {
        await session.dispose()
        if (sessions.get(serverName) === session) sessions.delete(serverName)
        scope.throwIfAborted()
        if (options.failOnConnectionError) throw error
        // A broken server may be retried on the next discovery after confirmed cleanup.
      }
    }

    for (const [serverName, session] of sessions) {
      if (configuredServerNames.has(serverName)) continue
      await session.dispose()
      scope.throwIfAborted()
      sessions.delete(serverName)
    }

    scope.throwIfAborted()
    return tools
  }
  return provider
}
