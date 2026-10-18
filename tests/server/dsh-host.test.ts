import { afterEach, expect, it, vi } from 'vitest'
import { createDshHost } from '../../packages/server/src/modules/coding-agents/services/dsh/host'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
afterEach(() => { Object.defineProperty(process, 'platform', originalPlatform) })

it('uses the discovered toolchain PATH for ACP and rejects missing DSH before launch', async () => {
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  const find = vi.fn().mockResolvedValue(['/tools/dsh'])
  const host = createDshHost({ commandEnv: async () => ({ PATH: '/tools:/pnpm' }), findCommandPaths: find,
    resolveCommandForExecution: async command => command, commandExecution: (command, args) => ({ command, args }), getSourceHome: () => '/native/.dsh' })
  expect(await host.runtimeInput()).toMatchObject({ installationCommand: '/tools/dsh', launchPath: '/tools:/pnpm' })
  find.mockResolvedValue([])
  await expect(host.runtimeInput()).rejects.toMatchObject({ code: 'DSH_DEPENDENCY_UNAVAILABLE' })
})

it('uses the Windows execution resolver when lookup returns the npm Unix shim first', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  const directory = 'C:\\Users\\测试 User\\AppData\\Roaming\\npm'
  const env = { PATH: directory }
  const resolve = vi.fn().mockResolvedValue(`${directory}\\dsh.cmd`)
  const host = createDshHost({ commandEnv: async () => env,
    findCommandPaths: async () => [`${directory}\\dsh`, `${directory}\\dsh.cmd`],
    resolveCommandForExecution: resolve, commandExecution: (command, args) => ({ command, args }),
    getSourceHome: () => 'C:\\Users\\测试 User\\.dsh' })
  expect(await host.runtimeInput()).toMatchObject({ installationCommand: `${directory}\\dsh.cmd`, launchPath: directory })
  expect(resolve).toHaveBeenCalledWith('dsh', env)
})
