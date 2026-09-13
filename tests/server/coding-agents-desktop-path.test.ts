import { delimiter } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execState = vi.hoisted(() => {
  const calls: Array<{ command: string; args: string[]; options: any }> = []
  const execFile = vi.fn()
  ;(execFile as any)[Symbol.for('nodejs.util.promisify.custom')] = async (command: string, args: string[], options: any) => {
    calls.push({ command, args, options })

    if (command === '/bin/zsh') {
      return {
        stdout: ['/Users/example/.npm-global/bin', '/opt/homebrew/bin', '/usr/bin'].join(':'),
        stderr: '',
      }
    }

    if (command === 'which' && args[0] === '-a' && args[1] === 'npm') {
      throw Object.assign(new Error('npm not found'), { code: 'ENOENT' })
    }

    if (command === 'which' && args[0] === '-a' && args[1] === 'claude') {
      if (!String(options.env?.PATH || '').split(':').includes('/Users/example/.npm-global/bin')) {
        throw Object.assign(new Error('claude not found'), { code: 'ENOENT' })
      }
      return { stdout: '/Users/example/.npm-global/bin/claude\n', stderr: '' }
    }

    if ((command === 'claude' || command === '/Users/example/.npm-global/bin/claude') && args[0] === '--version') {
      return { stdout: '1.2.3\n', stderr: '' }
    }

    throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
  }
  return { calls, execFile }
})

vi.mock('child_process', () => ({
  execFile: execState.execFile,
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: (path: string) => path === '/bin/zsh' || actual.existsSync(path),
  }
})

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
const originalPath = process.env.PATH
const originalShell = process.env.SHELL
const originalHermesDesktop = process.env.HERMES_DESKTOP

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform })
}

beforeEach(() => {
  execState.calls.length = 0
  setPlatform('darwin')
  process.env.HERMES_DESKTOP = 'true'
  process.env.SHELL = '/bin/zsh'
  process.env.PATH = '/usr/bin'
})

afterEach(() => {
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
  process.env.PATH = originalPath
  if (typeof originalShell === 'undefined') delete process.env.SHELL
  else process.env.SHELL = originalShell
  if (typeof originalHermesDesktop === 'undefined') delete process.env.HERMES_DESKTOP
  else process.env.HERMES_DESKTOP = originalHermesDesktop
  vi.resetModules()
})

describe('coding agent desktop PATH detection', () => {
  it('detects Claude from the login shell PATH when Electron PATH is minimal', async () => {
    const { getCodingAgentStatus } = await import('../../packages/server/src/bootstrap/coding-agents')
    const status = await getCodingAgentStatus({
      id: 'claude-code',
      name: 'Claude Code',
      provider: 'Anthropic',
      command: 'claude',
      packageName: '@anthropic-ai/claude-code',
    })

    expect(status.installed).toBe(true)
    expect(status.version).toBe('1.2.3')

    const versionCall = execState.calls.find(call => (call.command === 'claude' || call.command === '/Users/example/.npm-global/bin/claude') && call.args[0] === '--version')
    expect(versionCall?.command).toBe('/Users/example/.npm-global/bin/claude')
    expect(versionCall?.options.env.PATH.split(delimiter)).toContain('/Users/example/.npm-global/bin')
  })
})
