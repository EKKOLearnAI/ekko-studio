import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

const execFileCalls = vi.hoisted(() => [] as Array<{ command: string; args: string[]; options: any }>)
const spawnCalls = vi.hoisted(() => [] as Array<{ command: string; args: string[]; options: any }>)

vi.mock('child_process', () => ({
  execFile: vi.fn((command: string, args: string[], options: any, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    execFileCalls.push({ command, args, options })
    callback(null, 'ok\n', '')
  }),
  spawn: vi.fn((command: string, args: string[], options: any) => {
    spawnCalls.push({ command, args, options })
    return {} as any
  }),
}))

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform })
}

afterEach(() => {
  execFileCalls.length = 0
  spawnCalls.length = 0
  delete process.env.HERMES_AGENT_BRIDGE_PYTHON
  delete process.env.HERMES_AGENT_CLI_PYTHON
  delete process.env.HERMES_BIN
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
  vi.resetModules()
})

describe('Hermes process invocation', () => {
  it('bypasses the uv hermes.exe trampoline on Windows packaged installs', async () => {
    setPlatform('win32')
    process.env.HERMES_BIN = 'C:\\Users\\me\\AppData\\Local\\Programs\\Ekko Studio\\resources\\python\\Scripts\\hermes.exe'
    process.env.HERMES_AGENT_CLI_PYTHON = 'C:\\Users\\me\\AppData\\Local\\Programs\\Ekko Studio\\resources\\python\\python.exe'
    const { execHermesWithBin } = await import('../../packages/server/src/modules/hermes/services/runtime/process')

    const result = await execHermesWithBin(
      'C:\\Users\\me\\AppData\\Local\\Programs\\Ekko Studio\\resources\\python\\Scripts\\hermes.exe',
      ['kanban', '--board', 'default', 'create', 'demo', '--json'],
      { windowsHide: true },
    )

    expect(result.stdout).toBe('ok\n')
    expect(execFileCalls[0]).toMatchObject({
      command: process.env.HERMES_AGENT_CLI_PYTHON,
      args: ['-m', 'hermes_cli.main', 'kanban', '--board', 'default', 'create', 'demo', '--json'],
      options: expect.objectContaining({ windowsHide: true }),
    })
  })

  it('discovers sibling python.exe for a Windows hermes.exe launcher', async () => {
    setPlatform('win32')
    const root = mkdtempSync(join(tmpdir(), 'hermes-process-'))
    try {
      const scripts = join(root, 'Scripts')
      mkdirSync(scripts)
      writeFileSync(join(root, 'python.exe'), '')
      writeFileSync(join(scripts, 'hermes.exe'), '')
      const { execHermesWithBin } = await import('../../packages/server/src/modules/hermes/services/runtime/process')

      await execHermesWithBin(join(scripts, 'hermes.exe'), ['--version'])

      expect(execFileCalls[0]).toMatchObject({
        command: join(root, 'python.exe'),
        args: ['-m', 'hermes_cli.main', '--version'],
        options: expect.objectContaining({ windowsHide: true }),
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('discovers sibling python.exe for a Windows hermes.cmd launcher', async () => {
    setPlatform('win32')
    const root = mkdtempSync(join(tmpdir(), 'hermes-process-'))
    try {
      const scripts = join(root, 'Scripts')
      mkdirSync(scripts)
      writeFileSync(join(root, 'python.exe'), '')
      writeFileSync(join(scripts, 'hermes.cmd'), '')
      const { execHermesWithBin } = await import('../../packages/server/src/modules/hermes/services/runtime/process')

      await execHermesWithBin(join(scripts, 'hermes.cmd'), ['--version'])

      expect(execFileCalls[0]).toMatchObject({
        command: join(root, 'python.exe'),
        args: ['-m', 'hermes_cli.main', '--version'],
        options: expect.objectContaining({ windowsHide: true }),
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('runs a standalone Windows hermes.cmd launcher through cmd.exe', async () => {
    setPlatform('win32')
    const root = mkdtempSync(join(tmpdir(), 'hermes-process-'))
    try {
      const scripts = join(root, 'Scripts')
      mkdirSync(scripts)
      const hermes = join(scripts, 'hermes.cmd')
      writeFileSync(hermes, '@echo off\r\n')
      const { execHermesWithBin } = await import('../../packages/server/src/modules/hermes/services/runtime/process')

      await execHermesWithBin(hermes, ['profile', 'list'])

      expect(execFileCalls[0]).toMatchObject({
        command: process.env.comspec || 'cmd.exe',
        args: expect.arrayContaining(['/d', '/s', '/c']),
        options: expect.objectContaining({
          windowsHide: true,
          windowsVerbatimArguments: true,
        }),
      })
      expect(execFileCalls[0].args.at(-1)).toContain('hermes.cmd')
      expect(execFileCalls[0].args.at(-1)).toContain('profile')
      expect(execFileCalls[0].args.at(-1)).toContain('list')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not probe a user Windows CLI through the selected Runtime Python', async () => {
    setPlatform('win32')
    const root = mkdtempSync(join(tmpdir(), 'hermes-process-'))
    try {
      const userCli = join(root, 'user', 'hermes.cmd')
      const runtimeCli = join(root, 'runtime', 'Scripts', 'hermes.cmd')
      const runtimePython = join(root, 'runtime', 'python.exe')
      mkdirSync(join(root, 'user'), { recursive: true })
      mkdirSync(join(root, 'runtime', 'Scripts'), { recursive: true })
      writeFileSync(userCli, '@echo off\r\n')
      writeFileSync(runtimeCli, '@echo off\r\n')
      writeFileSync(runtimePython, '')
      const env = {
        ...process.env,
        HERMES_BIN: runtimeCli,
        HERMES_AGENT_CLI_PYTHON: runtimePython,
      }
      const { execHermesWithBin } = await import('../../packages/server/src/modules/hermes/services/runtime/process')

      await execHermesWithBin(userCli, ['--version'], { env })

      expect(execFileCalls[0]).toMatchObject({
        command: process.env.comspec || 'cmd.exe',
        args: expect.arrayContaining(['/d', '/s', '/c']),
      })
      expect(execFileCalls[0].command).not.toBe(runtimePython)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('resolves the Bridge Python and Agent Root for a Windows user CLI install', async () => {
    setPlatform('win32')
    const root = mkdtempSync(join(tmpdir(), 'hermes-process-'))
    try {
      const hermesHome = join(root, '.hermes')
      const agentRoot = join(hermesHome, 'hermes-agent')
      const python = join(agentRoot, 'venv', 'Scripts', 'python.exe')
      const userCli = join(root, 'bin', 'hermes.cmd')
      mkdirSync(join(agentRoot, 'venv', 'Scripts'), { recursive: true })
      mkdirSync(join(root, 'bin'), { recursive: true })
      writeFileSync(join(agentRoot, 'run_agent.py'), '')
      writeFileSync(python, '')
      writeFileSync(userCli, '@echo off\r\n')
      const { resolveHermesInstallationEnvironment } = await import('../../packages/server/src/modules/hermes/services/runtime/installation')

      expect(resolveHermesInstallationEnvironment(userCli, hermesHome)).toEqual({
        python,
        agentRoot,
        environmentRoot: join(agentRoot, 'venv'),
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('resolves python through a chained shell exec wrapper on Unix installs', async () => {
    setPlatform('linux')
    const root = mkdtempSync(join(tmpdir(), 'hermes-process-'))
    try {
      const hermesHome = join(root, '.hermes')
      const repo = join(root, 'hermes-agent')
      const python = join(root, 'tools', 'python3')
      const innerBin = join(repo, '.hermes', 'bin')
      const innerCli = join(innerBin, 'hermes')
      const outerCli = join(root, '.local', 'bin', 'hermes')
      mkdirSync(innerBin, { recursive: true })
      mkdirSync(join(root, '.local', 'bin'), { recursive: true })
      mkdirSync(dirname(python), { recursive: true })
      writeFileSync(join(repo, 'run_agent.py'), '')
      writeFileSync(python, '')
      // Inner launcher carries the python path bare (unquoted), inside an
      // exec line — the shape written by the git-install repo launcher.
      writeFileSync(innerCli, [
        '#!/bin/sh',
        `exec ${python} -I -c 'import hermes_bootstrap' "$@"`,
        '',
      ].join('\n'))
      chmodSync(innerCli, 0o755)
      writeFileSync(outerCli, [
        '#!/bin/sh',
        `exec ${innerCli} "$@"`,
        '',
      ].join('\n'))
      chmodSync(outerCli, 0o755)
      const { resolveHermesInstallationEnvironment } = await import('../../packages/server/src/modules/hermes/services/runtime/installation')

      expect(resolveHermesInstallationEnvironment(outerCli, hermesHome)).toEqual({
        python,
        agentRoot: repo,
        environmentRoot: join(root, 'tools'),
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not loop forever on a self-referencing exec wrapper', async () => {
    setPlatform('linux')
    const root = mkdtempSync(join(tmpdir(), 'hermes-process-'))
    try {
      const hermesHome = join(root, '.hermes')
      const cli = join(root, 'hermes')
      writeFileSync(cli, `#!/bin/sh\nexec ${cli} "$@"\n`)
      chmodSync(cli, 0o755)
      const { resolveHermesInstallationEnvironment } = await import('../../packages/server/src/modules/hermes/services/runtime/installation')

      expect(resolveHermesInstallationEnvironment(cli, hermesHome)).toEqual({})
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps normal Hermes command execution unchanged on non-Windows platforms', async () => {
    setPlatform('darwin')
    const { execHermesWithBin } = await import('../../packages/server/src/modules/hermes/services/runtime/process')

    await execHermesWithBin('/opt/hermes/bin/hermes', ['--version'], { windowsHide: true })

    expect(execFileCalls[0]).toMatchObject({
      command: '/opt/hermes/bin/hermes',
      args: ['--version'],
    })
  })

  it('defaults spawned Windows Hermes processes to hidden windows', async () => {
    setPlatform('win32')
    process.env.HERMES_BIN = 'C:\\Ekko Studio\\resources\\python\\Scripts\\hermes.exe'
    process.env.HERMES_AGENT_CLI_PYTHON = 'C:\\Ekko Studio\\resources\\python\\python.exe'
    const { spawnHermesWithBin } = await import('../../packages/server/src/modules/hermes/services/runtime/process')

    spawnHermesWithBin('C:\\Ekko Studio\\resources\\python\\Scripts\\hermes.exe', ['gateway', 'run'])

    expect(spawnCalls[0]).toMatchObject({
      command: process.env.HERMES_AGENT_CLI_PYTHON,
      args: ['-m', 'hermes_cli.main', 'gateway', 'run'],
      options: expect.objectContaining({ windowsHide: true }),
    })
  })

  it('spawns a standalone Windows hermes.cmd gateway through cmd.exe', async () => {
    setPlatform('win32')
    const root = mkdtempSync(join(tmpdir(), 'hermes-process-'))
    try {
      const scripts = join(root, 'Scripts')
      mkdirSync(scripts)
      const hermes = join(scripts, 'hermes.cmd')
      writeFileSync(hermes, '@echo off\r\n')
      const { spawnHermesWithBin } = await import('../../packages/server/src/modules/hermes/services/runtime/process')

      spawnHermesWithBin(hermes, ['gateway', 'run'])

      expect(spawnCalls[0]).toMatchObject({
        command: process.env.comspec || 'cmd.exe',
        args: expect.arrayContaining(['/d', '/s', '/c']),
        options: expect.objectContaining({
          windowsHide: true,
          windowsVerbatimArguments: true,
        }),
      })
      expect(spawnCalls[0].args.at(-1)).toContain('gateway')
      expect(spawnCalls[0].args.at(-1)).toContain('run')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
