import { afterEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
const mocks = vi.hoisted(() => ({ exec: vi.fn(), spawn: vi.fn(), name: 'ekko-studio' }))
vi.mock('node:child_process', () => ({ execFileSync: mocks.exec, spawn: mocks.spawn }))
vi.mock('node:fs', () => ({ existsSync: () => true, mkdirSync: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/services/package-info', () => ({ readStudioPackageInfo: () => ({ name: mocks.name }) }))
afterEach(() => { vi.useRealTimers(); vi.resetModules(); vi.clearAllMocks() })
it('retains the normal Studio upgrade endpoint and removes built-in preview operations', async () => {
  const { updateRoutes } = await import('../../packages/server/src/modules/studio/routes/update')
  expect(updateRoutes.stack.map(route => [route.path, route.methods])).toEqual([['/api/studio/update', ['POST']]])
  const runtime = await import('../../packages/server/src/modules/studio/services/update/update-runtime')
  runtime.configureUpdateRuntime({ getWebUiHome: () => '/fixture', isDockerContainer: () => true })
  const ctx = {} as any
  await runtime.handleUpdate(ctx)
  expect(ctx).toMatchObject({ status: 400, body: { code: 'docker_environment' } })
  expect(mocks.exec).not.toHaveBeenCalled()
})
it.each(['ekko-studio', 'hermes-web-ui'])('still upgrades and restarts the installed %s package', async name => {
  vi.useFakeTimers(); mocks.name = name
  mocks.exec.mockImplementation((_command, args) => args.includes('root') ? '/global' : 'updated')
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
  mocks.spawn.mockReturnValue(child)
  const runtime = await import('../../packages/server/src/modules/studio/services/update/update-runtime')
  runtime.configureUpdateRuntime({ getWebUiHome: () => '/fixture', isDockerContainer: () => false })
  const ctx = {} as any
  await runtime.handleUpdate(ctx)
  expect(ctx.body.success).toBe(true)
  expect(mocks.exec.mock.calls.some(([, args]) => args.includes('install') && args.includes(`${name}@latest`))).toBe(true)
  await vi.advanceTimersByTimeAsync(3000)
  expect(mocks.spawn.mock.calls[0][1]).toEqual([`/global/${name}/bin/hermes-web-ui.mjs`, 'restart', '--port', process.env.PORT || '8648'])
})
