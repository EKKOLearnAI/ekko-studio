import { randomUUID } from 'node:crypto'
import { StreamableHTTPClientTransport, parseJSONRPCMessage } from '@modelcontextprotocol/client'
import { createMcpToolProvider, McpCapabilityUnavailableError, type McpReadRequest, type AgentTool, type AgentToolContext } from '../../../../../../ekko-agent/src/mcp'
import { ManagedJsonRpcTransport } from '../../../../../../studio-agent-drivers/src'
import { StudioError, type McpConnectInput, type McpConnectionHandle, type McpToolDefinition, type McpToolResult, type JsonObject, type RuntimeMcp, type McpPage, type McpResource, type McpResourceTemplate, type McpPrompt } from '../../contracts/plugins'
import { ManagedProcessScope, parseProcessSpawn } from '../processes/managed'
import { jsonCopy } from '../plugins/validation'
import { mcpReadString, mcpReadArguments, parseMcpPage, parseMcpResource, parseMcpPrompt } from './read-contract'

let liveConnections = 0
const MAX_RESULT = 524_288, MAX_WIRE = 1_048_576
export function parseMcpConnect(value: unknown): McpConnectInput {
  const input = jsonCopy(value, 262_144) as McpConnectInput
  const invalid = () => new StudioError('INVALID_ARGUMENT', 'Invalid MCP connection configuration')
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid()
  const common = ['type', 'timeoutMs', 'supportsParallelToolCalls']
  if ((input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 100 || input.timeoutMs > 300_000))
    || (input.supportsParallelToolCalls !== undefined && typeof input.supportsParallelToolCalls !== 'boolean')) throw invalid()
  if (input.type === 'stdio') {
    if (Object.keys(input).some(key => ![...common, 'command', 'args', 'cwd', 'env'].includes(key))) throw invalid()
    parseProcessSpawn({ command: input.command, args: input.args, cwd: input.cwd, ...(input.env !== undefined ? { env: input.env } : {}) })
  } else if (input.type === 'streamable_http') {
    if (Object.keys(input).some(key => ![...common, 'url', 'headers'].includes(key)) || typeof input.url !== 'string' || input.url.length > 8192) throw invalid()
    let url: URL
    try { url = new URL(input.url) } catch { throw invalid() }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw invalid()
    if (input.headers !== undefined && (!input.headers || typeof input.headers !== 'object' || Array.isArray(input.headers)
      || Object.keys(input.headers).length > 64 || Object.entries(input.headers).some(([key, value]) => !/^[a-zA-Z0-9!#$%&'*+.^_`|~-]{1,128}$/.test(key)
        || typeof value !== 'string' || value.length > 16384 || /[\r\n\0]/.test(value)))) throw invalid()
  } else throw invalid()
  return input
}

interface Connection { dispose(): Promise<void> }
/** A runtime owns connections across successful turns. Owner and provider checks stay in the host. */
export class ManagedMcpScope {
  readonly api: RuntimeMcp = Object.freeze({ connect: (input: McpConnectInput) => this.connect(input) })
  private readonly connections = new Set<Connection>()
  private ended = false
  private closing?: Promise<void>
  private watch: ReturnType<typeof setInterval>
  private readonly aborted = () => { void this.close().catch(() => {}) }
  constructor(private readonly signal: AbortSignal, private readonly authorize: () => void) {
    this.watch = setInterval(() => { try { this.check() } catch { this.aborted() } }, 250)
    this.watch.unref?.()
    signal.addEventListener('abort', this.aborted, { once: true })
    if (signal.aborted) this.aborted()
  }
  private check(): void {
    if (this.ended || this.signal.aborted) throw new StudioError('CANCELLED', 'MCP runtime scope ended')
    try { this.authorize() } catch (error) { this.aborted(); throw error }
  }
  private async connect(value: McpConnectInput): Promise<McpConnectionHandle> {
    this.check()
    const input = parseMcpConnect(value), timeoutMs = input.timeoutMs ?? 30_000
    if (liveConnections >= 64 || this.connections.size >= 16) throw new StudioError('RESOURCE_EXHAUSTED', 'MCP connection limit reached')
    const controller = new AbortController(), processes = new ManagedProcessScope(controller.signal, () => this.check())
    let disposed = false, closing: Promise<void> | undefined, tools = new Map<string, AgentTool>()
    const pending = new Set<Promise<unknown>>()
    const check = () => { this.check(); if (disposed) throw new StudioError('CANCELLED', 'MCP connection ended') }
    const provider = createMcpToolProvider({ failOnConnectionError: true, createTransport: async server => {
      check()
      if (server.type === 'stdio') {
        if (input.type !== 'stdio') throw new StudioError('INVALID_ARGUMENT', 'MCP transport mismatch')
        const process = await processes.api.spawn({ command: server.command, args: server.args, env: server.env, cwd: input.cwd })
        return new ManagedJsonRpcTransport(process, parseJSONRPCMessage, { maxMessageBytes: MAX_WIRE })
      }
      return new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers },
        fetch: async (url, init) => {
          // Revocation stops new work, but teardown may still delete this owned HTTP session.
          const teardown = disposed && String(init?.method).toUpperCase() === 'DELETE' && String(url) === server.url
          if (!teardown) check()
          const response = await fetch(url, { ...init, redirect: 'error' })
          try { if (!teardown) check() } catch (error) { await response.body?.cancel(); throw error }
          if (!response.body) return response
          let bytes = 0
          const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, out) {
            bytes += chunk.byteLength
            if (bytes > MAX_WIRE) throw new Error('MCP response limit exceeded')
            out.enqueue(chunk)
          } }))
          return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
        },
      })
    } })
    const context: AgentToolContext = { mcpSessionSignal: controller.signal, timeoutMs,
      mcpServers: { remote: { ...input, supports_parallel_tool_calls: input.supportsParallelToolCalls === true, requestTimeoutMs: timeoutMs } } }
    const connection: Connection = { dispose: () => {
      disposed = true
      return closing ??= (async () => {
        controller.abort()
        const results = await Promise.allSettled([provider.dispose(), processes.close()])
        await Promise.allSettled([...pending])
        const failed = results.find(result => result.status === 'rejected')
        if (failed?.status === 'rejected') throw new StudioError('RUNTIME_UNAVAILABLE', 'MCP connection cleanup is unconfirmed')
        this.connections.delete(connection); liveConnections--; tools.clear()
      })()
    } }
    this.connections.add(connection); liveConnections++
    const operation = async <T>(action: () => Promise<T>): Promise<T> => {
      check()
      if (pending.size >= (input.supportsParallelToolCalls ? 4 : 1)) throw new StudioError('RESOURCE_EXHAUSTED', 'MCP connection is busy')
      const task = (async () => { const result = await action(); check(); return result })()
      pending.add(task)
      try { return await task } finally { pending.delete(task) }
    }
    const listTools = () => operation(async () => {
      let listed: AgentTool[]
      try { listed = await provider.listTools(context) }
      catch { check(); throw new StudioError('RUNTIME_UNAVAILABLE', 'MCP tool discovery failed') }
      if (listed.length > 256) throw new StudioError('RESOURCE_EXHAUSTED', 'MCP tool count limit exceeded')
      const definitions = jsonCopy(listed.map(tool => ({ ...tool.definition, concurrency: tool.concurrency || 'serial' })), MAX_RESULT) as McpToolDefinition[]
      tools = new Map(listed.map(tool => [tool.definition.name, tool])); return definitions
    })
    const read = <T>(request: McpReadRequest, parse: (value: unknown) => T) => operation(async () => {
      let result: unknown
      try { result = await provider.read('remote', request, context) }
      catch (error) {
        check()
        if (error instanceof McpCapabilityUnavailableError) throw new StudioError('CAPABILITY_UNSUPPORTED', 'MCP server does not advertise this capability')
        throw new StudioError('RUNTIME_UNAVAILABLE', 'MCP resource or prompt request failed')
      }
      return parse(result)
    })
    const pageParams = (cursor?: string) => cursor === undefined ? {} : { cursor: mcpReadString(cursor, 4096) }
    const handle: McpConnectionHandle = Object.freeze({ id: randomUUID(), listTools,
      listResources: (cursor?: string) => read({ method: 'resources/list', params: pageParams(cursor) }, value => parseMcpPage(value, 'resources') as McpPage<McpResource>),
      listResourceTemplates: (cursor?: string) => read({ method: 'resources/templates/list', params: pageParams(cursor) }, value => parseMcpPage(value, 'resourceTemplates') as McpPage<McpResourceTemplate>),
      readResource: (uri: string) => read({ method: 'resources/read', params: { uri: mcpReadString(uri) } }, parseMcpResource),
      listPrompts: (cursor?: string) => read({ method: 'prompts/list', params: pageParams(cursor) }, value => parseMcpPage(value, 'prompts') as McpPage<McpPrompt>),
      getPrompt: (name: string, args?: Record<string, string>) => read({ method: 'prompts/get', params: { name: mcpReadString(name, 256), ...(args === undefined ? {} : { arguments: mcpReadArguments(args) }) } }, parseMcpPrompt),
      callTool: (name: string, args: JsonObject) => {
        const snapshot = jsonCopy(args, 131_072)
        if (typeof name !== 'string' || !name || name.length > 64 || !snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new StudioError('INVALID_ARGUMENT', 'Invalid MCP tool call')
        return operation(async () => {
          const tool = tools.get(name)
          if (!tool) throw new StudioError('NOT_FOUND', 'MCP tool was not discovered')
          const result = await tool.execute(snapshot, context)
          if (!result.ok && result.data === undefined) throw new StudioError('RUNTIME_UNAVAILABLE', 'MCP tool call failed; its remote effect may be unknown')
          return jsonCopy({ ok: result.ok, content: result.content,
            ...(result.contentParts ? { contentParts: result.contentParts } : {}),
            ...(result.data !== undefined ? { data: result.data } : {}),
            ...(result.error !== undefined ? { error: result.error } : {}),
          }, MAX_RESULT) as McpToolResult
        })
      }, dispose: connection.dispose,
    })
    try { await listTools(); check(); return handle }
    catch (error) { await connection.dispose(); throw error }
  }
  close(): Promise<void> {
    this.ended = true; clearInterval(this.watch); this.signal.removeEventListener('abort', this.aborted)
    return this.closing ??= (async () => {
      const results = await Promise.allSettled([...this.connections].map(connection => connection.dispose()))
      const failed = results.find(result => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    })()
  }
}
