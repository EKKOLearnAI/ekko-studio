import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execState = vi.hoisted(() => {
  const customPromisify = Symbol.for('nodejs.util.promisify.custom')
  const calls: Array<{ command: string; args: string[]; options: any }> = []
  let requiredVersionPath = ''
  const execFile = vi.fn()
  ;(execFile as any)[customPromisify] = async (command: string, args: string[], options: any) => {
    calls.push({ command, args, options })
    if (command === 'where' && args[0] === 'npm.cmd') {
      throw Object.assign(new Error('npm not found'), { code: 'ENOENT' })
    }
    if (command === 'where' && args[0] === 'codex') {
      return { stdout: requiredVersionPath ? 'C:\\Users\\�\\AppData\\Roaming\\npm\\codex.cmd\r\n' : '"C:\\nvm4w\\nodejs\\codex.cmd"\r\n', stderr: '' }
    }
    if (command === 'cmd.exe') {
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
    get requiredVersionPath() { return requiredVersionPath },
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

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform })
}

beforeEach(() => {
  execState.calls.length = 0
  execState.requiredVersionPath = ''
  fsState.existingPaths.clear()
  setPlatform('win32')
})

afterEach(() => {
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
  vi.unstubAllEnvs()
})

describe('coding agent Windows command execution', () => {
  it('resolves Windows PATH entries and runs .cmd shims through verbatim cmd.exe', async () => {
    const commandPath = 'C:\\nvm4w\\nodejs\\codex.cmd'
    vi.stubEnv('PATH', '"C:\\nvm4w\\nodejs"')
    vi.stubEnv('PATHEXT', '.com;.exe;.bat;.cmd')
    fsState.existingPaths.add(commandPath)

    const status = await getCodingAgentStatus({
      id: 'codex',
      name: 'Codex',
      provider: 'OpenAI',
      command: 'codex',
      packageName: '@openai/codex',
    })

    expect(status.installed).toBe(true)
    expect(status.version).toBe('1.2.3')

    const versionCall = execState.calls.find(call => call.command === 'cmd.exe')
    expect(versionCall).toBeTruthy()
    expect(versionCall?.args).toEqual([
      '/d',
      '/s',
      '/c',
      `"${commandPath} ^"--version^""`,
    ])
    expect(versionCall?.options).toMatchObject({
      windowsHide: true,
      windowsVerbatimArguments: true,
    })
  })

  it('resolves coding agents from a non-ASCII Windows PATH without decoding where.exe output', async () => {
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
    expect(execState.calls).not.toContainEqual(expect.objectContaining({ command: 'where' }))
  })
})
