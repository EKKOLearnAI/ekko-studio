import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'

const mocks = vi.hoisted(() => ({
  names: ['notes-tools'], hermes: vi.fn(), ekko: vi.fn(), notify: vi.fn(), invalidate: vi.fn(),
  running: true, send: vi.fn(), constructor: vi.fn(), warn: vi.fn(),
}))
vi.mock('../../packages/server/src/modules/studio/public/plugin-mcp', async importActual => ({
  ...await importActual<object>(), pluginMcpServers: () => mocks.names.map(name => ({ name, toolset: 'plugins' })),
}))
vi.mock('../../packages/server/src/modules/hermes/services/mcp/studio-autoinject', () => ({ injectBundledMcpServer: mocks.hermes }))
vi.mock('../../packages/server/src/modules/ekko/services/mcp', () => ({ injectManagedEkkoMcpServers: mocks.ekko }))
vi.mock('../../packages/server/src/modules/hermes/services/mcp/plugin-sync', () => ({ synchronizeHermesPluginMcpServers: mocks.notify }))
vi.mock('../../packages/server/src/modules/coding-agents/services/runtime/run-manager', () => ({ codingAgentRunManager: { invalidateMatching: mocks.invalidate } }))
vi.mock('../../packages/server/src/modules/hermes/services/bridge/manager', () => ({ getAgentBridgeManager: () => ({ running: mocks.running, endpoint: 'tcp://127.0.0.1:1' }) }))
vi.mock('../../packages/server/src/modules/hermes/services/bridge/client', () => ({ AgentBridgeClient: class {
  constructor(options: unknown) { mocks.constructor(options) }
  mcpPluginsChanged = mocks.send
} }))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({ logger: { warn: mocks.warn } }))
import { registerPluginMcpSync } from '../../packages/server/src/bootstrap/plugin-mcp'
import { synchronizePluginMcpServers } from '../../packages/server/src/modules/studio/public/plugin-mcp'

let release: (() => void) | undefined
beforeEach(() => {
  vi.resetAllMocks(); mocks.names = ['notes-tools']; mocks.running = true
  mocks.hermes.mockResolvedValue({ targets: [] }); mocks.notify.mockResolvedValue(undefined); mocks.send.mockResolvedValue({ ok: true })
})
afterEach(() => { release?.(); release = undefined })

it('synchronizes config before notifying Hermes of removed and renamed plugin services', async () => {
  release = registerPluginMcpSync()
  mocks.names = ['new-notes-tools']
  await synchronizePluginMcpServers()
  expect(mocks.notify).toHaveBeenCalledWith(['ekko-studio-plugins', 'notes-tools', 'new-notes-tools'], ['notes-tools'])
  expect(mocks.hermes.mock.invocationCallOrder[0]).toBeLessThan(mocks.notify.mock.invocationCallOrder[0])
  expect(mocks.ekko.mock.invocationCallOrder[0]).toBeLessThan(mocks.notify.mock.invocationCallOrder[0])
  expect(mocks.invalidate).toHaveBeenCalledOnce()
  mocks.names = []
  await synchronizePluginMcpServers()
  expect(mocks.notify).toHaveBeenLastCalledWith(['ekko-studio-plugins', 'new-notes-tools'], ['new-notes-tools'])
})

it('refreshes the shared service after a tool change while preserving it', async () => {
  mocks.names = []; release = registerPluginMcpSync()
  await synchronizePluginMcpServers()
  expect(mocks.notify).toHaveBeenCalledWith(['ekko-studio-plugins'], [])
  expect(mocks.invalidate).not.toHaveBeenCalled()
})

it('still requests runtime cleanup on config failure and retries old names after notification failure', async () => {
  release = registerPluginMcpSync(); mocks.names = []
  mocks.hermes.mockRejectedValueOnce(new Error('Write failed'))
  await synchronizePluginMcpServers()
  expect(mocks.notify).toHaveBeenCalledWith(['ekko-studio-plugins', 'notes-tools'], ['notes-tools'])
  mocks.notify.mockRejectedValueOnce(new Error('Worker unavailable'))
  await synchronizePluginMcpServers()
  await synchronizePluginMcpServers()
  expect(mocks.notify).toHaveBeenLastCalledWith(['ekko-studio-plugins', 'notes-tools'], ['notes-tools'])
  expect(mocks.warn).toHaveBeenCalledTimes(2)
})

it('serializes overlapping plugin updates so delayed sync cannot overwrite newer definitions', async () => {
  release = registerPluginMcpSync(); mocks.names = []
  let unlock!: () => void
  mocks.notify.mockImplementationOnce(() => new Promise<void>(done => { unlock = done }))
  const first = synchronizePluginMcpServers()
  await vi.waitFor(() => expect(mocks.notify).toHaveBeenCalledTimes(1))
  mocks.names = ['new-tools']
  const second = synchronizePluginMcpServers()
  await Promise.resolve()
  expect(mocks.notify).toHaveBeenCalledTimes(1)
  unlock(); await Promise.all([first, second])
  expect(mocks.notify).toHaveBeenLastCalledWith(['ekko-studio-plugins', 'new-tools'], [])
})

it('notifies only a running broker and uses its endpoint without starting Hermes', async () => {
  const { synchronizeHermesPluginMcpServers: sync } = await vi.importActual<typeof import('../../packages/server/src/modules/hermes/services/mcp/plugin-sync')>('../../packages/server/src/modules/hermes/services/mcp/plugin-sync')
  mocks.running = false; await sync(['notes-tools'], ['notes-tools'])
  expect(mocks.constructor).not.toHaveBeenCalled()
  mocks.running = true; await sync(['notes-tools'], ['notes-tools'])
  expect(mocks.constructor).toHaveBeenCalledWith({ endpoint: 'tcp://127.0.0.1:1', connectRetryMs: 0 })
  expect(mocks.send).toHaveBeenCalledWith(['notes-tools'], ['notes-tools'])
})

it('cleans Hermes transports and refreshes cached agents at idle boundaries through the real Python bridge classes', async () => {
  const { stdout } = await promisify(execFile)(process.platform === 'win32' ? 'python' : 'python3', ['-B', resolve('tests/server/fixtures/hermes-plugin-mcp.py')], {
    cwd: resolve('.'), timeout: 25_000, maxBuffer: 1024 * 1024, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })
  expect(stdout).toContain('Hermes plugin MCP lifecycle verified')
}, 30_000)
