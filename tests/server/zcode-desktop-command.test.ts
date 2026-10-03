import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { findZcodeDesktopCli, resolveZcodeCommand } from '../../packages/server/src/modules/coding-agents/services/native/zcode-command'

const installed = vi.hoisted(() => new Set<string>())
vi.mock('node:fs', () => ({ existsSync: (path: string) => installed.has(path) }))
vi.mock('node:os', () => ({ homedir: () => '/Users/example' }))
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const macResources = '/Applications/ZCode.app/Contents/Resources'
const macCli = `${macResources}/glm/zcode.cjs`

beforeEach(() => {
  installed.clear()
  Object.defineProperty(process, 'platform', { value: 'darwin' })
})
afterEach(() => Object.defineProperty(process, 'platform', originalPlatform))

describe('ZCode desktop command resolution', () => {
  it('prefers a standalone CLI over the desktop installation', async () => {
    installed.add(macCli)
    const lookup = vi.fn(async () => ['/usr/local/bin/zcode'])
    expect(await resolveZcodeCommand(['--version'], {}, lookup)).toEqual({
      command: '/usr/local/bin/zcode', args: ['--version'], env: {}, path: '/usr/local/bin/zcode',
    })
  })

  it('supplies both desktop provider paths when running the bundled CLI globally', async () => {
    installed.add(macCli)
    const execution = await resolveZcodeCommand([], {}, async () => [])
    expect(execution).toEqual({ command: process.execPath, args: [macCli], path: macCli,
      env: { ELECTRON_RUN_AS_NODE: '1',
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: `${macResources}/config/provider/zcode-builtin.json`,
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: '/Users/example/.zcode/v2/provider_config.json',
        ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE: '',
      },
    })
  })

  it('preserves scoped provider files and disabled builtin refresh', async () => {
    installed.add(macCli)
    const env = { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: '/scoped/builtin.json',
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: '/scoped/personal.json',
      ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE: '', ZCODE_DATA_BASE_DIR: '/scoped' }
    const execution = await resolveZcodeCommand(['--mode', 'plan'], env, async () => [])
    expect(execution.args).toEqual([macCli, '--mode', 'plan'])
    expect(execution.env).toMatchObject({
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE,
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE,
      ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE: '',
    })
  })

  it('honors a custom data base directory for the native personal configuration', async () => {
    installed.add(macCli)
    const execution = await resolveZcodeCommand([], { ZCODE_DATA_BASE_DIR: '/native-data' }, async () => [])
    expect(execution.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE).toBe('/native-data/.zcode/v2/provider_config.json')
  })

  it('detects a per-user macOS application', () => {
    const cli = '/Users/example/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs'
    installed.add(cli)
    expect(findZcodeDesktopCli({})).toBe(cli)
  })

  it.each(['LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)'] as const)('detects Windows %s installations', async key => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const base = 'C:\\Program Files'
    const resources = `${base}\\${key === 'LOCALAPPDATA' ? 'Programs\\' : ''}ZCode\\resources`
    const cli = `${resources}\\glm\\zcode.cjs`
    installed.add(cli)
    const execution = await resolveZcodeCommand([], { [key]: base, ZCODE_DATA_BASE_DIR: 'C:\\Users\\example' }, async () => [])
    expect(execution.args).toEqual([cli])
    expect(execution.env).toMatchObject({
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: `${resources}\\config\\provider\\zcode-builtin.json`,
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: 'C:\\Users\\example\\.zcode\\v2\\provider_config.json',
    })
  })

  it.each(['/opt/ZCode', '/opt/zcode'])('detects Linux installations under %s', root => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    installed.add(`${root}/resources/glm/zcode.cjs`)
    expect(findZcodeDesktopCli({})).toBe(`${root}/resources/glm/zcode.cjs`)
  })

  it('leaves a missing installation unavailable', async () => {
    expect(await resolveZcodeCommand([], {}, async () => [])).toEqual({ command: 'zcode', args: [], env: {}, path: 'zcode' })
  })
})
