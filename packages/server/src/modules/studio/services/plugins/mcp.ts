import { StudioError, type AgentRuntimeContext, type JsonObject, type JsonValue, type McpConnectInput, type McpConnectionHandle } from '../../contracts/plugins'
import { toJson } from './validation'
import { mcpReadArguments, mcpReadString } from '../mcp/read-contract'

interface Binding {
  context: AgentRuntimeContext
  handles: Map<string, McpConnectionHandle>
  pending: Set<Promise<unknown>>
  failure?: unknown
  close(): Promise<void>
}
/** Connections are capabilities owned by one runtime, worker and plugin generation. */
export class PluginMcpBridge {
  private readonly bindings = new Map<string, Binding>()
  private readonly cleanups = new Set<Promise<void>>()
  private ended = false
  private closing?: Promise<void>
  constructor(private readonly authorize: () => void,
    private readonly origin: (value: JsonValue | undefined, runtimeHandle: string, context: AgentRuntimeContext) => void) {}

  mount(context: AgentRuntimeContext, handle: string): { close(): Promise<void> } {
    if (this.ended || context.signal.aborted) throw new StudioError('CANCELLED', 'Runtime ended')
    let closing: Promise<void> | undefined
    const aborted = () => { void binding.close().catch(() => {}) }
    const watch = setInterval(() => { try { this.authorize() } catch { aborted() } }, 250)
    watch.unref?.()
    const binding: Binding = { context, handles: new Map(), pending: new Set(), close: () => {
      if (closing) return closing
      this.bindings.delete(handle); clearInterval(watch); context.signal.removeEventListener('abort', aborted)
      closing = (async () => {
        const results = await Promise.allSettled([...binding.handles.values()].map(connection => connection.dispose()))
        await Promise.allSettled([...binding.pending])
        const failure = results.find(result => result.status === 'rejected')
        if (failure?.status === 'rejected') throw failure.reason
        if (binding.failure) throw binding.failure
        binding.handles.clear()
      })()
      this.cleanups.add(closing)
      void closing.then(() => this.cleanups.delete(closing!), () => {})
      return closing
    } }
    this.bindings.set(handle, binding)
    context.signal.addEventListener('abort', aborted, { once: true })
    return { close: binding.close }
  }
  async call(value: JsonValue): Promise<JsonValue> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StudioError('INVALID_ARGUMENT', 'Invalid MCP request')
    const { runtimeHandle, originHandle, method, id, input, name } = value
    if (typeof runtimeHandle !== 'string' || typeof method !== 'string'
      || !['connect', 'listTools', 'callTool', 'listResources', 'listResourceTemplates', 'readResource', 'listPrompts', 'getPrompt', 'dispose'].includes(method)
      || Object.keys(value).some(key => !['runtimeHandle', 'originHandle', 'method', 'id', 'input', 'name'].includes(key))
      || (method === 'connect' ? id !== undefined || name !== undefined : typeof id !== 'string')
      || (!['callTool', 'getPrompt'].includes(method) && name !== undefined)
      || (['listTools', 'dispose'].includes(method) && input !== undefined)) throw new StudioError('INVALID_ARGUMENT', 'Invalid MCP request')
    const page = ['listResources', 'listResourceTemplates', 'listPrompts'].includes(method)
    let cursor: string | undefined, uri: string | undefined, args: Record<string, string> | undefined
    if (page && input !== undefined) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'cursor')) throw new StudioError('INVALID_ARGUMENT', 'Invalid MCP page request')
      if (input.cursor !== undefined) cursor = mcpReadString(input.cursor, 4096)
    }
    if (method === 'readResource') {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'uri')) throw new StudioError('INVALID_ARGUMENT', 'Invalid MCP resource request')
      uri = mcpReadString(input.uri)
    }
    if (method === 'getPrompt') { mcpReadString(name, 256); if (input !== undefined) args = mcpReadArguments(input) }
    const binding = this.bindings.get(runtimeHandle)
    if (!binding) {
      if (method === 'dispose') return null
      throw new StudioError('FORBIDDEN', 'Runtime MCP scope is unavailable')
    }
    const check = () => {
      if (!this.bindings.has(runtimeHandle) || binding.context.signal.aborted) throw new StudioError('CANCELLED', 'MCP runtime scope ended')
      this.origin(originHandle, runtimeHandle, binding.context)
      try { this.authorize() } catch (error) { void binding.close().catch(() => {}); throw error }
    }
    this.origin(originHandle, runtimeHandle, binding.context)
    if (method !== 'dispose') check()
    const operation = (async (): Promise<JsonValue> => {
      if (method === 'connect') {
        if ([...this.bindings.values()].reduce((n, entry) => n + entry.handles.size + entry.pending.size, 0) >= 64) throw new StudioError('RESOURCE_EXHAUSTED', 'Worker MCP limit reached')
        const connection = await binding.context.mcp.connect(input as unknown as McpConnectInput)
        try {
          if (!this.bindings.has(runtimeHandle)) throw new StudioError('CANCELLED', 'MCP runtime scope ended')
          check()
        } catch (error) {
          try { await connection.dispose() } catch (cleanupError) { binding.failure = cleanupError; throw cleanupError }
          throw error
        }
        binding.handles.set(connection.id, connection)
        return { id: connection.id }
      }
      const connection = binding.handles.get(String(id))
      if (!connection) {
        if (method === 'dispose') return null
        throw new StudioError('FORBIDDEN', 'MCP connection is outside the runtime scope')
      }
      if (method === 'dispose') { await connection.dispose(); binding.handles.delete(String(id)); return null }
      let result: unknown
      if (method === 'listTools') result = await connection.listTools()
      else if (method === 'listResources') result = await connection.listResources(cursor)
      else if (method === 'listResourceTemplates') result = await connection.listResourceTemplates(cursor)
      else if (method === 'readResource') result = await connection.readResource(uri!)
      else if (method === 'listPrompts') result = await connection.listPrompts(cursor)
      else if (method === 'getPrompt') result = await connection.getPrompt(name as string, args)
      else result = await connection.callTool(name as string, input as JsonObject)
      check()
      return toJson(result)
    })()
    binding.pending.add(operation)
    try { return await operation } finally { binding.pending.delete(operation) }
  }
  close(): Promise<void> {
    this.ended = true
    return this.closing ??= (async () => {
      const results = await Promise.allSettled([...this.bindings.values()].map(binding => binding.close()).concat([...this.cleanups]))
      const failure = results.find(result => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    })()
  }
}
