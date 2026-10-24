import { StudioError, type AgentRuntimeContext, type JsonObject, type JsonValue, type McpConnectInput, type McpConnectionHandle } from '../../contracts/plugins'
import { toJson } from './validation'

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
      || !['connect', 'listTools', 'callTool', 'dispose'].includes(method)
      || Object.keys(value).some(key => !['runtimeHandle', 'originHandle', 'method', 'id', 'input', 'name'].includes(key))
      || (method === 'connect' ? id !== undefined || name !== undefined : typeof id !== 'string')
      || (method !== 'callTool' && name !== undefined)
      || (!['connect', 'callTool'].includes(method) && input !== undefined)) throw new StudioError('INVALID_ARGUMENT', 'Invalid MCP request')
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
      const result = method === 'listTools' ? await connection.listTools() : await connection.callTool(name as string, input as JsonObject)
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
