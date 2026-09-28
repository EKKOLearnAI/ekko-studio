import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execState = vi.hoisted(() => {
  const customPromisify = Symbol.for('nodejs.util.promisify.custom')
  const calls: Array<{ command: string; args: string[]; options: any }> = []
  let requiredVersionPath = ''
  const execFile = vi.fn()
  ;(execFile as any)[customPromisify] = async (command: string, args: string[], options: any) => {
    calls.push({ command, args, options })
    if (command === (process.env.comspec || 'cmd.exe')) {
      if (requiredVersionPath && !args.some(arg => arg.includes(requiredVersionPath))) {
        throw new Error('The system cannot find the path specified.')
      }
      return { stdout: 'codex-cli 1.2.3\n', stderr: '' }
    }
    throw new Error(`unexpected command: ${command}`)
  }
  return {
    calls,
    execFile,
    set requiredVersionPath(value: string) { requiredVersionPath = value },
  }
})

const fsState = vi.hoisted(() => ({ existingPaths: new Set<string>() }))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn((path: import('fs').PathLike) =>
      fsState.existingPaths.has(String(path)) || actual.existsSync(path)),
  }
})

vi.mock('child_process', () => ({
  execFile: execState.execFile,
}))

import { getCodingAgentStatus } from '../../packages/server/src/bootstrap/coding-agents'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

beforeEach(() => {
  execState.calls.length = 0
  execState.requiredVersionPath = ''
  fsState.existingPaths.clear()
  Object.defineProperty(process, 'platform', { value: 'win32' })
})

afterEach(() => {
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
  vi.unstubAllEnvs()
})

describe('coding agent Unicode Windows PATH resolution', () => {
  it('resolves coding agents without decoding where.exe output', async () => {
    const unicodeBin = 'C:\\Users\\项\\AppData\\Roaming\\npm'
    const unicodeCommand = `${unicodeBin}\\codex.cmd`
    vi.stubEnv('PATH', unicodeBin)
    vi.stubEnv('PATHEXT', '.com;.exe;.bat;.cmd')
    fsState.existingPaths.add(unicodeCommand)
    execState.requiredVersionPath = unicodeCommand

    const status = await getCodingAgentStatus({
      id: 'codex',
      name: 'Codex',
      provider: 'OpenAI',
      command: 'codex',
      packageName: '@openai/codex',
    })

    expect(status).toMatchObject({
      installed: true,
      version: '1.2.3',
      path: unicodeCommand,
    })
    expect(execState.calls).not.toContainEqual(expect.objectContaining({
      command: 'where',
      args: ['codex'],
    }))
  })
})
