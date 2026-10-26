import { describe, expect, it, vi } from 'vitest'
import type { CodingAgentEnvironment } from '../../packages/server/src/modules/coding-agents/contracts/environment'
import { checkKimiEnvironment } from '../../packages/server/src/modules/coding-agents/services/kimi/environment'
import { checkCopilotEnvironment } from '../../packages/server/src/modules/coding-agents/services/copilot/environment'
import { checkQoderPlatform } from '../../packages/server/src/modules/coding-agents/services/qoder/environment'

function context(overrides: Partial<CodingAgentEnvironment> = {}): CodingAgentEnvironment {
  return { platform: 'win32', arch: 'x64', env: {}, exists: () => false,
    findCommandPaths: vi.fn(async () => []), output: vi.fn(async () => ''), ...overrides }
}

describe('agent-owned environment checks', () => {
  it.each(['darwin', 'linux'] as const)('does not impose Windows shell requirements on %s', async platform => {
    const host = context({ platform })
    expect(await checkKimiEnvironment(host)).toEqual({})
    expect(await checkCopilotEnvironment(host)).toEqual({})
    expect(host.findCommandPaths).not.toHaveBeenCalled()
    expect(host.output).not.toHaveBeenCalled()
  })

  it('finds Git Bash outside PATH and passes its absolute path to Kimi', async () => {
    const bash = 'D:\\Program Files\\Git\\bin\\bash.exe'
    const host = context({ env: { ProgramFiles: 'D:\\Program Files' }, exists: path => path === bash,
      output: vi.fn(async () => 'GNU bash, version 5.2.0') })
    expect(await checkKimiEnvironment(host)).toEqual({ KIMI_SHELL_PATH: bash })
    expect(host.output).toHaveBeenCalledWith(bash, ['--version'])
  })

  it('honors a quoted custom Git Bash path with spaces and non-ASCII characters', async () => {
    const bash = 'D:\\工具 目录\\bash.exe'
    const host = context({ env: { KIMI_SHELL_PATH: `"${bash}"` }, exists: () => true,
      output: vi.fn(async () => 'GNU bash, version 5.2.0') })
    expect(await checkKimiEnvironment(host)).toEqual({ KIMI_SHELL_PATH: bash })
    expect(host.findCommandPaths).not.toHaveBeenCalled()
  })

  it('does not silently ignore a broken custom Kimi shell', async () => {
    const host = context({ env: { KIMI_SHELL_PATH: 'D:\\missing\\bash.exe', ProgramFiles: 'C:\\Program Files' },
      exists: path => path.startsWith('C:'), output: vi.fn(async () => 'GNU bash') })
    await expect(checkKimiEnvironment(host)).rejects.toMatchObject({ status: 422, message: expect.stringContaining('KIMI_SHELL_PATH') })
    expect(host.output).not.toHaveBeenCalled()
  })

  it('does not accept the Windows WSL bash launcher as Git Bash', async () => {
    const host = context({ exists: () => true,
      findCommandPaths: vi.fn(async () => ['C:\\Windows\\System32\\bash.exe']), output: vi.fn(async () => 'GNU bash') })
    await expect(checkKimiEnvironment(host)).rejects.toThrow('Git for Windows')
    expect(host.output).not.toHaveBeenCalled()
  })

  it('rejects a shell that exists but cannot execute', async () => {
    const host = context({ env: { KIMI_SHELL_PATH: 'C:\\Git\\bash.exe' }, exists: () => true,
      output: vi.fn(async () => { throw new Error('EACCES') }) })
    await expect(checkKimiEnvironment(host)).rejects.toThrow('working Git for Windows')
  })

  it.each(['6.2.7', '7.5.2'])('accepts PowerShell %s and puts it on the child PATH', async version => {
    const pwsh = 'D:\\工具 目录\\pwsh.exe'
    const host = context({ env: { PATH: 'C:\\nodejs' }, findCommandPaths: vi.fn(async () => [pwsh]), output: vi.fn(async () => version) })
    expect(await checkCopilotEnvironment(host)).toEqual({ PATH: 'D:\\工具 目录;C:\\nodejs' })
    expect(host.output).toHaveBeenCalledWith(pwsh, expect.arrayContaining(['-NoProfile', '-NonInteractive']))
  })

  it('detects a PowerShell MSI installation absent from PATH', async () => {
    const host = context({ env: { ProgramFiles: 'C:\\Program Files', Path: 'C:\\nodejs' }, output: vi.fn(async () => '7.4.0') })
    expect(await checkCopilotEnvironment(host)).toEqual({ Path: 'C:\\Program Files\\PowerShell\\7;C:\\nodejs' })
  })

  it('updates the PATH key Node actually uses when Windows has duplicate casing', async () => {
    const host = context({ env: { Path: 'C:\\stale', PATH: 'C:\\nodejs' },
      findCommandPaths: vi.fn(async () => ['D:\\PowerShell\\pwsh.exe']), output: vi.fn(async () => '7.4.0') })
    expect(await checkCopilotEnvironment(host)).toEqual({ PATH: 'D:\\PowerShell;C:\\nodejs' })
  })

  it.each(['5.1.19041', '', 'not a version'])('rejects missing or insufficient PowerShell (%s)', async version => {
    const host = context({ findCommandPaths: vi.fn(async () => ['C:\\pwsh.exe']), output: vi.fn(async () => version) })
    await expect(checkCopilotEnvironment(host)).rejects.toMatchObject({ status: 422, code: 'coding_agent_environment_unavailable',
      message: expect.stringContaining('PowerShell 6 or later') })
  })

  it('tries another working PowerShell after a broken PATH entry', async () => {
    const host = context({ env: { ProgramFiles: 'C:\\Program Files' },
      findCommandPaths: vi.fn(async () => ['D:\\broken\\pwsh.exe']),
      output: vi.fn(async path => { if (path.startsWith('D:')) throw new Error('ENOENT'); return '7.4.0' }) })
    expect(await checkCopilotEnvironment(host)).toHaveProperty('PATH', 'C:\\Program Files\\PowerShell\\7')
  })

  it('rejects Qoder only on native Windows ARM64', () => {
    expect(() => checkQoderPlatform('win32', 'arm64')).toThrow('does not support native Windows ARM64')
    expect(() => checkQoderPlatform('win32', 'x64')).not.toThrow()
    expect(() => checkQoderPlatform('linux', 'arm64')).not.toThrow()
    expect(() => checkQoderPlatform('darwin', 'arm64')).not.toThrow()
  })
})
