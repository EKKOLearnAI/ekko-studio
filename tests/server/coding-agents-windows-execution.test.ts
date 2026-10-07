import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execState = vi.hoisted(() => {
  const customPromisify = Symbol.for('nodejs.util.promisify.custom')
  const calls: Array<{ command: string; args: string[]; options: any }> = []
  const execFile = vi.fn()
  ;(execFile as any)[customPromisify] = async (command: string, args: string[], options: any) => {
    calls.push({ command, args, options })
    if (command === 'where' && args[0] === 'npm.cmd') {
      throw Object.assign(new Error('npm not found'), { code: 'ENOENT' })
    }
    if (command === 'where' && args[0] === 'codex') {
      return { stdout: '"C:\\nvm4w\\nodejs\\codex.cmd"\r\n', stderr: '' }
    }
    if (command === 'where' && ['qwen', 'kimi', 'codebuddy', 'qoder', 'copilot', 'zcode'].includes(args[0])) {
      return { stdout: `C:\\工具 目录\\${args[0]}\r\n"C:\\工具 目录\\${args[0]}.cmd"\r\n`, stderr: '' }
    }
    if (command === (process.env.comspec || 'cmd.exe')) {
      return { stdout: 'codex-cli 1.2.3\n', stderr: '' }
    }
    throw new Error(`unexpected command: ${command}`)
  }
  return { calls, execFile }
})

vi.mock('child_process', () => ({
  execFile: execState.execFile,
}))

import { getCodingAgentStatus, getCodingAgentDefinition, prepareCodingAgentLaunch, installCodingAgent } from '../../packages/server/src/bootstrap/coding-agents'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
const originalArch = Object.getOwnPropertyDescriptor(process, 'arch')!

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform })
}

beforeEach(() => {
  execState.calls.length = 0
  setPlatform('win32')
})

afterEach(() => {
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
  Object.defineProperty(process, 'arch', originalArch)
  vi.unstubAllEnvs()
})

describe('coding agent Windows command execution', () => {
  it.each(['qwen', 'kimi', 'codebuddy', 'qoder', 'copilot', 'zcode'])('detects installed %s via its Windows shim', async id => {
    const status = await getCodingAgentStatus(getCodingAgentDefinition(id)!)
    expect(status).toMatchObject({ installed: true, path: `C:\\工具 目录\\${id}.cmd` })
    const execution = execState.calls.find(call => call.command === (process.env.comspec || 'cmd.exe'))
    expect(execution?.options).toMatchObject({ windowsHide: true, windowsVerbatimArguments: true })
    if (id === 'copilot') expect(status.error).toContain('PowerShell 6 or later')
  })

  it.each(['scoped', 'global'] as const)('checks Copilot prerequisites before preparing a %s launch', async mode => {
    await expect(prepareCodingAgentLaunch('copilot', { mode, profile: 'default' })).rejects.toMatchObject({
      status: 422, code: 'coding_agent_environment_unavailable', message: expect.stringContaining('PowerShell 6 or later'),
    })
  })

  it('blocks Qoder on Windows ARM64 before installing a package or preparing a launch', async () => {
    Object.defineProperty(process, 'arch', { value: 'arm64' })
    await expect(prepareCodingAgentLaunch('qoder', { mode: 'global' })).rejects.toThrow('Windows ARM64')
    const result = await installCodingAgent('qoder')
    expect(result).toMatchObject({ success: false, code: 'coding_agent_environment_unavailable', message: expect.stringContaining('Windows ARM64') })
    expect(execState.calls.some(call => call.args.includes('install'))).toBe(false)
  })

  it('normalizes quoted where.exe results and runs .cmd shims through verbatim cmd.exe', async () => {
    const status = await getCodingAgentStatus({
      id: 'codex',
      name: 'Codex',
      provider: 'OpenAI',
      command: 'codex',
      packageName: '@openai/codex',
    })

    expect(status.installed).toBe(true)
    expect(status.version).toBe('1.2.3')

    const versionCall = execState.calls.find(call => call.command === (process.env.comspec || 'cmd.exe'))
    expect(versionCall).toBeTruthy()
    expect(versionCall?.args).toEqual([
      '/d',
      '/s',
      '/c',
      '"C:\\nvm4w\\nodejs\\codex.cmd ^"--version^""',
    ])
    expect(versionCall?.options).toMatchObject({
      windowsHide: true,
      windowsVerbatimArguments: true,
    })
  })
})
