import { randomUUID } from 'node:crypto'
import { StudioError, type AgentRuntimeContext, type JsonValue, type ProcessHandle, type ProcessSpawnInput } from '../../contracts/plugins'
import { toJson } from './validation'
import { parseTerminalSize } from '../processes/pty'

interface Binding {
  context: AgentRuntimeContext
  handles: Map<string, ProcessHandle>
  pending: Set<Promise<unknown>>
  close(): Promise<void>
}

/** Runtime handles are host-issued and scoped to this worker/generation. */
export class PluginProcessBridge {
  private readonly bindings = new Map<string, Binding>()
  private readonly cleanups = new Set<Promise<void>>()
  private ended = false
  private closing?: Promise<void>

  constructor(private readonly authorize: () => void, private readonly origin: (value: JsonValue | undefined, runtimeHandle: string, context: AgentRuntimeContext) => void) {}

  mount(context: AgentRuntimeContext): { handle: string; close(): Promise<void> } {
    if (this.ended || context.signal.aborted) throw new StudioError('CANCELLED', 'Runtime ended')
    const handle = randomUUID()
    let closing: Promise<void> | undefined
    const aborted = () => { void binding.close().catch(() => {}) }
    const binding: Binding = { context, handles: new Map(), pending: new Set(), close: () => {
      if (closing) return closing
      this.bindings.delete(handle); context.signal.removeEventListener('abort', aborted)
      const pending = [...binding.pending]
      closing = (async () => {
        const results = await Promise.allSettled([...binding.handles.values()].map(process => process.dispose()))
        await Promise.allSettled(pending)
        binding.handles.clear()
        const failure = results.find(result => result.status === 'rejected')
        if (failure?.status === 'rejected') throw failure.reason
      })()
      this.cleanups.add(closing)
      void closing.finally(() => this.cleanups.delete(closing!)).catch(() => {})
      return closing
    } }
    this.bindings.set(handle, binding)
    context.signal.addEventListener('abort', aborted, { once: true })
    return { handle, close: binding.close }
  }

  async call(value: JsonValue): Promise<JsonValue> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StudioError('INVALID_ARGUMENT', 'Invalid process request')
    const { runtimeHandle, originHandle, method, id, input, data } = value
    if (typeof runtimeHandle !== 'string' || typeof method !== 'string'
      || Object.keys(value).some(key => !['runtimeHandle', 'originHandle', 'method', 'id', 'input', 'data'].includes(key))
      || !['spawn', 'read', 'write', 'end', 'resize', 'stop', 'dispose'].includes(method)
      || (method === 'spawn' ? id !== undefined || data !== undefined : typeof id !== 'string' || (method !== 'resize' && input !== undefined))
      || (method !== 'write' && data !== undefined)) throw new StudioError('INVALID_ARGUMENT', 'Invalid process request')
    const binding = this.bindings.get(runtimeHandle)
    if (!binding) {
      if (method === 'dispose' || method === 'stop') return null
      throw new StudioError('FORBIDDEN', 'Runtime process scope is unavailable')
    }
    this.origin(originHandle, runtimeHandle, binding.context)
    const authorize = () => {
      try { this.authorize() }
      catch (error) { void binding.close().catch(() => {}); throw error }
    }
    if (method !== 'stop' && method !== 'dispose') {
      authorize()
    }
    if (method === 'spawn') {
      const pending = (async () => {
        const handle = await binding.context.processes.spawn(input as unknown as ProcessSpawnInput)
        try {
          if (!this.bindings.has(runtimeHandle)) throw new StudioError('CANCELLED', 'Runtime process scope ended')
          authorize(); this.origin(originHandle, runtimeHandle, binding.context)
        } catch (error) { await handle.dispose(); throw error }
        binding.handles.set(handle.id, handle)
        return { id: handle.id }
      })()
      binding.pending.add(pending)
      try { return await pending } finally { binding.pending.delete(pending) }
    }
    const handle = binding.handles.get(String(id))
    if (!handle) {
      if (method === 'dispose') return null
      throw new StudioError('NOT_FOUND', 'Process is outside the runtime scope')
    }
    if (method === 'read') {
      const result = await handle.read()
      authorize(); this.origin(originHandle, runtimeHandle, binding.context)
      return toJson({ ...result, chunks: result.chunks.map(chunk => ({ stream: chunk.stream, data: Buffer.from(chunk.data).toString('base64') })) })
    }
    if (method === 'resize') {
      const size = parseTerminalSize(input)
      if (!handle.resize) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Process is not a terminal')
      await handle.resize(size.cols, size.rows)
    } else if (method === 'write') {
      if (typeof data !== 'string' || data.length > 87_384 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new StudioError('INVALID_ARGUMENT', 'Invalid process byte frame')
      const bytes = Buffer.from(data, 'base64')
      if (bytes.length > 65_536 || bytes.toString('base64') !== data) throw new StudioError('INVALID_ARGUMENT', 'Invalid process byte frame')
      await handle.write(bytes)
    } else if (method === 'end') await handle.end()
    else if (method === 'stop') await handle.stop()
    else { await handle.dispose(); binding.handles.delete(String(id)) }
    return null
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.ended = true
    return this.closing = Promise.all([...this.bindings.values()].map(binding => binding.close()).concat([...this.cleanups])).then(() => {})
  }
}
