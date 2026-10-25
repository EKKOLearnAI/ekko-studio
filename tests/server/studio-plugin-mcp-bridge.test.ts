import { expect, it, vi } from 'vitest'
import { PluginMcpBridge } from '../../packages/server/src/modules/studio/services/plugins/mcp'
import { StudioError, type AgentRuntimeContext, type McpConnectionHandle, type McpToolResult } from '../../packages/studio-plugin-sdk/src'

function connection(id: string): McpConnectionHandle {
  return { id, listTools: vi.fn(async () => []), callTool: vi.fn(async () => ({ ok: true, content: 'private' })), dispose: vi.fn(async () => {}),
    listResources: vi.fn(async () => ({ items: [] })), listResourceTemplates: vi.fn(async () => ({ items: [] })), readResource: vi.fn(async () => []),
    listPrompts: vi.fn(async () => ({ items: [] })), getPrompt: vi.fn(async () => ({ messages: [] })) }
}
function context(connect: AgentRuntimeContext['mcp']['connect']): AgentRuntimeContext {
  return { ownerId: 'owner', profileId: 'profile', runtimeSessionId: 'runtime', provider: { kind: 'builtin', module: 'ekko', implementationVersion: '1' },
    signal: new AbortController().signal, logger: { info() {}, warn() {}, error() {} }, mcp: { connect }, processes: { spawn: async () => { throw new Error('unused') } } }
}
const open = (bridge: PluginMcpBridge, runtimeHandle = 'first') => bridge.call({ runtimeHandle, originHandle: runtimeHandle, method: 'connect', input: {} })

it('scopes connection IDs and rejects authority overrides before dispatch', async () => {
  const bridge = new PluginMcpBridge(() => {}, () => {}), first = connection('a'), second = connection('b')
  const a = bridge.mount(context(async () => first), 'first'), b = bridge.mount(context(async () => second), 'second')
  await open(bridge); await open(bridge, 'second')
  await expect(bridge.call({ runtimeHandle: 'first', method: 'callTool', id: 'b', name: 'echo', input: {} })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  await expect(bridge.call({ runtimeHandle: 'first', method: 'connect', input: {}, ownerId: 'forged' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  expect(second.callTool).not.toHaveBeenCalled()
  await a.close(); expect(first.dispose).toHaveBeenCalledOnce(); expect(second.dispose).not.toHaveBeenCalled()
  await b.close(); await bridge.close()
})

it('validates content operations and rejects foreign connections before dispatch', async () => {
  const bridge = new PluginMcpBridge(() => {}, () => {}), child = connection('content')
  bridge.mount(context(async () => child), 'first'); await open(bridge)
  await bridge.call({ runtimeHandle: 'first', method: 'listResources', id: child.id, input: { cursor: 'next' } })
  await bridge.call({ runtimeHandle: 'first', method: 'readResource', id: child.id, input: { uri: 'fixture://one' } })
  await bridge.call({ runtimeHandle: 'first', method: 'getPrompt', id: child.id, name: 'greeting', input: { whom: 'test' } })
  expect(child.listResources).toHaveBeenCalledWith('next')
  expect(child.readResource).toHaveBeenCalledWith('fixture://one')
  expect(child.getPrompt).toHaveBeenCalledWith('greeting', { whom: 'test' })
  await expect(bridge.call({ runtimeHandle: 'first', method: 'readResource', id: child.id, input: { uri: 'fixture://one', ownerId: 'forged' } })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  await expect(bridge.call({ runtimeHandle: 'first', method: 'listResources', id: 'foreign' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  await bridge.close()
})

it('waits for a late connection and retains its cleanup failure after the binding is removed', async () => {
  let resolve!: (value: McpConnectionHandle) => void
  const bridge = new PluginMcpBridge(() => {}, () => {}), child = connection('late')
  child.dispose = vi.fn(async () => { throw new StudioError('RUNTIME_UNAVAILABLE', 'Unconfirmed') })
  const binding = bridge.mount(context(() => new Promise(done => { resolve = done })), 'first')
  const opening = open(bridge); const rejected = expect(opening).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
  let ended = false
  const closing = binding.close().finally(() => { ended = true })
  const rejectedClose = expect(closing).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
  await Promise.resolve(); expect(ended).toBe(false)
  resolve(child); await Promise.all([rejected, rejectedClose])
  await expect(bridge.close()).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
  await expect(bridge.close()).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
  expect(child.dispose).toHaveBeenCalledOnce()
})

it('withholds late results and waits for the in-flight operation when closing', async () => {
  let resolve!: (value: McpToolResult) => void
  const bridge = new PluginMcpBridge(() => {}, () => {})
  const child = connection('private'); child.callTool = () => new Promise(done => { resolve = done })
  bridge.mount(context(async () => child), 'first'); await open(bridge)
  const pending = bridge.call({ runtimeHandle: 'first', method: 'callTool', id: child.id, name: 'echo', input: {} })
  const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
  let ended = false
  const closing = bridge.close().then(() => { ended = true })
  await Promise.resolve(); expect(ended).toBe(false)
  resolve({ ok: true, content: 'secret' }); await Promise.all([closing, rejected])
  expect(child.dispose).toHaveBeenCalledOnce()
})

it('rechecks authority after a pending open and reclaims the connection', async () => {
  let allowed = true, resolve!: (value: McpConnectionHandle) => void
  const bridge = new PluginMcpBridge(() => { if (!allowed) throw new StudioError('FORBIDDEN', 'revoked') }, () => {})
  const child = connection('late'), binding = bridge.mount(context(() => new Promise(done => { resolve = done })), 'first')
  const pending = open(bridge); allowed = false; resolve(child)
  await expect(pending).rejects.toMatchObject({ code: 'FORBIDDEN' })
  await binding.close(); await bridge.close(); expect(child.dispose).toHaveBeenCalledOnce()
})

it('rejects foreign callback origin without closing the legitimate owner connection', async () => {
  const bridge = new PluginMcpBridge(() => {}, origin => { if (origin !== 'first') throw new StudioError('FORBIDDEN', 'foreign callback') })
  const child = connection('owned'); bridge.mount(context(async () => child), 'first'); await open(bridge)
  await expect(bridge.call({ runtimeHandle: 'first', originHandle: 'foreign', method: 'dispose', id: child.id })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(child.dispose).not.toHaveBeenCalled()
  expect(await bridge.call({ runtimeHandle: 'first', originHandle: 'first', method: 'callTool', id: child.id, name: 'echo', input: {} })).toEqual({ ok: true, content: 'private' })
  await bridge.close()
})
