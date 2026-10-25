import { StudioError, type JsonValue, type ProcessHandle, type ProcessReadResult, type RuntimeProcesses, type ProcessSpawnInput } from '../../studio-plugin-sdk/src'
import type { RpcPeer } from '../../studio-plugin-sdk/src/rpc'

export function remoteProcesses(peer: RpcPeer, runtimeHandle: string, signal: AbortSignal, origin: () => string | undefined, assertMutation: () => void): RuntimeProcesses {
  const call = async (method: string, input: Record<string, JsonValue> = {}): Promise<JsonValue> => {
    assertMutation()
    if (signal.aborted && method !== 'stop' && method !== 'dispose') throw new StudioError('CANCELLED', 'Runtime ended')
    return peer.request('process.call', { runtimeHandle, originHandle: origin() || runtimeHandle, method, ...input })
  }
  return Object.freeze({ spawn: async (input: ProcessSpawnInput) => {
    const result = await call('spawn', { input: JSON.parse(JSON.stringify(input)) }) as { id: string }
    let disposed: Promise<void> | undefined
    const handle: ProcessHandle = {
      id: result.id,
      read: async () => {
        const result = await call('read', { id: handle.id }) as unknown as Omit<ProcessReadResult, 'chunks'> & { chunks: Array<{ stream: 'stdout' | 'stderr'; data: string }> }
        return { ...result, chunks: result.chunks.map(chunk => ({ stream: chunk.stream, data: Uint8Array.from(Buffer.from(chunk.data, 'base64')) })) }
      },
      write: async data => {
        if (!(data instanceof Uint8Array) || data.length > 65_536) throw new StudioError('INVALID_ARGUMENT', 'Process writes accept at most 64 KiB')
        await call('write', { id: handle.id, data: Buffer.from(data).toString('base64') })
      },
      end: async () => { await call('end', { id: handle.id }) },
      resize: async (cols, rows) => { await call('resize', { id: handle.id, input: { cols, rows } }) },
      stop: async () => { await call('stop', { id: handle.id }) },
      dispose: () => {
        assertMutation()
        if (disposed) return disposed
        const pending = call('dispose', { id: handle.id }).then(() => {})
        disposed = pending
        void pending.catch(() => { if (disposed === pending) disposed = undefined })
        return pending
      },
    }
    return Object.freeze(handle)
  } })
}
