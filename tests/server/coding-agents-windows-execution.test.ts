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

import { getCodingAgentStatus } from '../../packages/server/src/bootstrap/coding-agents'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform })
}

beforeEach(() => {
  execState.calls.length = 0
  setPlatform('win32')
})

afterEach(() => {
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
  vi.unstubAllEnvs()
})

describe('coding agent Windows command execution', () => {
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
