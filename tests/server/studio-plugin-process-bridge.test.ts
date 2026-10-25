import { expect, it, vi } from 'vitest'
import { PluginProcessBridge } from '../../packages/server/src/modules/studio/services/plugins/processes'
import { StudioError, type AgentRuntimeContext, type ProcessHandle, type ProcessReadResult } from '../../packages/studio-plugin-sdk/src'

function process(id: string): ProcessHandle {
  return { id, read: vi.fn(async () => ({ chunks: [], exit: { code: 0, signal: null }, truncated: false })),
    write: vi.fn(async () => {}), end: vi.fn(async () => {}), stop: vi.fn(async () => {}), dispose: vi.fn(async () => {}) }
}
function context(spawn: AgentRuntimeContext['processes']['spawn']): AgentRuntimeContext {
  return { ownerId: 'owner', profileId: 'profile', runtimeSessionId: 'runtime', provider: { kind: 'builtin', module: 'ekko', implementationVersion: '1' },
    signal: new AbortController().signal, logger: { info() {}, warn() {}, error() {} }, processes: { spawn }, mcp: { connect: async () => { throw new Error('unused') } } }
}

it('scopes process IDs to the issuing runtime and rejects foreign handles and identity overrides', async () => {
  const bridge = new PluginProcessBridge(() => {}, () => {}), first = process('first'), second = process('second')
  const a = bridge.mount(context(async () => first)), b = bridge.mount(context(async () => second))
  const spawn = (runtimeHandle: string) => bridge.call({ runtimeHandle, method: 'spawn', input: {} })
  expect(await spawn(a.handle)).toEqual({ id: 'first' }); expect(await spawn(b.handle)).toEqual({ id: 'second' })
  await expect(bridge.call({ runtimeHandle: a.handle, method: 'read', id: 'second' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  await expect(bridge.call({ runtimeHandle: a.handle, method: 'spawn', input: {}, ownerId: 'forged' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  await a.close()
  await expect(bridge.call({ runtimeHandle: a.handle, method: 'read', id: 'first' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(first.dispose).toHaveBeenCalledTimes(1); expect(second.dispose).not.toHaveBeenCalled()
  await bridge.close(); expect(second.dispose).toHaveBeenCalledTimes(1)
})

it('waits for a late spawn and disposes it when the runtime closes before the reply', async () => {
  const child = process('late')
  let resolve!: (handle: ProcessHandle) => void
  const bridge = new PluginProcessBridge(() => {}, () => {}), binding = bridge.mount(context(() => new Promise(done => { resolve = done })))
  const pending = bridge.call({ runtimeHandle: binding.handle, method: 'spawn', input: {} }); void pending.catch(() => {})
  let closed = false
  const close = binding.close().then(() => { closed = true })
  await Promise.resolve(); expect(closed).toBe(false)
  resolve(child); await close
  await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
  expect(child.dispose).toHaveBeenCalledTimes(1)
  await bridge.close()
})

it('rechecks grants after a blocked read and withholds private output when access was revoked', async () => {
  const child = process('private')
  let resolve!: (value: ProcessReadResult) => void, allowed = true
  child.read = () => new Promise(done => { resolve = done })
  const bridge = new PluginProcessBridge(() => { if (!allowed) throw new StudioError('FORBIDDEN', 'Revoked') }, () => {})
  const binding = bridge.mount(context(async () => child))
  await bridge.call({ runtimeHandle: binding.handle, method: 'spawn', input: {} })
  const pending = bridge.call({ runtimeHandle: binding.handle, method: 'read', id: child.id })
  allowed = false; resolve({ chunks: [{ stream: 'stdout', data: new TextEncoder().encode('private') }], truncated: false, exit: null })
  await expect(pending).rejects.toMatchObject({ code: 'FORBIDDEN' })
  await bridge.close(); expect(child.dispose).toHaveBeenCalledTimes(1)
})

it('does not hand out a process started while its grant was being revoked', async () => {
  let allowed = true, resolve!: (handle: ProcessHandle) => void
  const child = process('late-revoked'), bridge = new PluginProcessBridge(() => { if (!allowed) throw new StudioError('FORBIDDEN', 'Revoked') }, () => {})
  const binding = bridge.mount(context(() => new Promise(done => { resolve = done })))
  const pending = bridge.call({ runtimeHandle: binding.handle, method: 'spawn', input: {} })
  allowed = false; resolve(child)
  await expect(pending).rejects.toMatchObject({ code: 'FORBIDDEN' })
  await bridge.close(); expect(child.dispose).toHaveBeenCalledTimes(1)
})

it('validates binary RPC frames without silently accepting malformed base64', async () => {
  const child = process('bytes'), bridge = new PluginProcessBridge(() => {}, () => {})
  const binding = bridge.mount(context(async () => child))
  await bridge.call({ runtimeHandle: binding.handle, method: 'spawn', input: {} })
  for (const data of ['a', '!!!!', 'YQ', 'YQ===', 'YR==', 'A'.repeat(87_385)]) {
    await expect(bridge.call({ runtimeHandle: binding.handle, method: 'write', id: child.id, data })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  }
  expect(child.write).not.toHaveBeenCalled()
  await bridge.call({ runtimeHandle: binding.handle, method: 'write', id: child.id, data: 'AP+A' })
  expect(child.write).toHaveBeenCalledExactlyOnceWith(Buffer.from([0, 255, 128]))
  await bridge.close()
})

it('does not certify cleanup when a process exit cannot be confirmed', async () => {
  const child = process('unconfirmed'), bridge = new PluginProcessBridge(() => {}, () => {})
  child.dispose = async () => { throw new StudioError('RUNTIME_UNAVAILABLE', 'Unconfirmed') }
  const binding = bridge.mount(context(async () => child))
  await bridge.call({ runtimeHandle: binding.handle, method: 'spawn', input: {} })
  await expect(bridge.close()).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
  await expect(bridge.close()).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
})

it('resizes only an owned terminal with validated dimensions', async () => {
  const child = process('terminal'), bridge = new PluginProcessBridge(() => {}, () => {})
  child.resize = vi.fn(async () => {})
  const binding = bridge.mount(context(async () => child))
  await bridge.call({ runtimeHandle: binding.handle, method: 'spawn', input: {} })
  await bridge.call({ runtimeHandle: binding.handle, method: 'resize', id: child.id, input: { cols: 100, rows: 40 } })
  expect(child.resize).toHaveBeenCalledWith(100, 40)
  await expect(bridge.call({ runtimeHandle: binding.handle, method: 'resize', id: 'foreign', input: { cols: 100, rows: 40 } })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  await expect(bridge.call({ runtimeHandle: binding.handle, method: 'resize', id: child.id, input: { cols: 100, rows: 0 } })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  await expect(bridge.call({ runtimeHandle: binding.handle, method: 'resize', id: child.id, input: { cols: 100, rows: 40, ownerId: 'forged' } })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  expect(child.resize).toHaveBeenCalledOnce()
  await bridge.close()
})
