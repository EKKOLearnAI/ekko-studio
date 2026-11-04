import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { startOpenCodeTurn } from '../../packages/server/src/modules/coding-agents/services/opencode/chat-turn'

vi.mock('../../packages/server/src/modules/coding-agents/services/runtime/workspace', () => ({
  codingAgentWorkingDirectory: (launch: { workspaceDir: string }) => launch.workspaceDir || '/fallback/workspace',
}))

vi.mock('../../packages/server/src/modules/coding-agents/services/prompt-file', () => ({
  updateManagedPromptFileSync: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

describe('OpenCode child environment isolation (#3664)', () => {
  function createFakeHost() {
    let spawnedArgs: string[] = []
    let spawnedOptions: any = null
    const child: any = new EventEmitter()
    child.stdin = { on: vi.fn(), end: vi.fn() }
    child.stdout = { on: vi.fn() }
    child.stderr = { on: vi.fn() }
    child.on = vi.fn()

    const host = {
      isRunning: () => false,
      response: vi.fn(),
      spawn: (command: string, args: string[], options: any) => {
        spawnedArgs = args
        spawnedOptions = options
        return child
      },
      touch: vi.fn(),
      line: vi.fn(),
      stderr: () => '',
      fail: vi.fn(),
      complete: vi.fn(),
      processError: (err: any) => err,
      exitError: () => new Error('exit'),
      terminate: vi.fn(),
    }

    return { host, getSpawned: () => ({ args: spawnedArgs, options: spawnedOptions }) }
  }

  it('overrides stale PWD from launch env and removes OLDPWD in scoped mode', () => {
    const { host, getSpawned } = createFakeHost()
    const fakeWorkspace = '/home/agent/.hermes/fleet-lab'

    const run: any = {
      id: 'run-scoped',
      launch: {
        sessionId: 'session-scoped',
        model: 'test-model',
        command: 'opencode',
        args: [],
        mode: 'scoped',
        workspaceDir: fakeWorkspace,
        env: {
          PWD: '/app',
          OLDPWD: '/old/app',
          CUSTOM_VAR: 'preserved',
        },
      },
    }

    startOpenCodeTurn(run, 'test input', '', [], host as any)
    const { args, options } = getSpawned()

    expect(options.cwd).toBe(fakeWorkspace)
    expect(options.env.PWD).toBe(fakeWorkspace)
    expect(options.env.OLDPWD).toBeUndefined()
    expect(options.env.CUSTOM_VAR).toBe('preserved')
    expect(args).toContain('--dir')
    expect(args).toContain(fakeWorkspace)
  })

  it('overrides stale PWD from process.env and removes OLDPWD in global mode', () => {
    const originalPwd = process.env.PWD
    const originalOldPwd = process.env.OLDPWD
    process.env.PWD = '/app'
    process.env.OLDPWD = '/old/app'

    try {
      const { host, getSpawned } = createFakeHost()
      const fakeWorkspace = '/home/agent/.hermes/fleet-lab-global'

      const run: any = {
        id: 'run-global',
        launch: {
          sessionId: 'session-global',
          model: 'test-model',
          command: 'opencode',
          args: ['--existing-flag'],
          mode: 'global',
          workspaceDir: fakeWorkspace,
          env: {},
        },
      }

      startOpenCodeTurn(run, 'test input', '', [], host as any)
      const { args, options } = getSpawned()

      expect(options.cwd).toBe(fakeWorkspace)
      expect(options.env.PWD).toBe(fakeWorkspace)
      expect(options.env.OLDPWD).toBeUndefined()
      expect(args).toContain('--dir')
      expect(args).toContain(fakeWorkspace)
      expect(args).toContain('--existing-flag')
    } finally {
      process.env.PWD = originalPwd
      process.env.OLDPWD = originalOldPwd
    }
  })

  it('does not duplicate --dir when already provided in launch.args', () => {
    const { host, getSpawned } = createFakeHost()
    const fakeWorkspace = '/home/agent/.hermes/custom-ws'

    const run: any = {
      id: 'run-custom',
      launch: {
        sessionId: 'session-custom',
        model: 'test-model',
        command: 'opencode',
        args: ['--dir', '/explicit/dir'],
        mode: 'scoped',
        workspaceDir: fakeWorkspace,
        env: {},
      },
    }

    startOpenCodeTurn(run, 'test input', '', [], host as any)
    const { args } = getSpawned()

    const dirCount = args.filter((a: string) => a === '--dir').length
    expect(dirCount).toBe(1)
  })
})
