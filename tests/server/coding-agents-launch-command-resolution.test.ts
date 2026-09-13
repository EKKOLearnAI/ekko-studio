import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
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

    if (command === 'which' && args[0] === '-a' && args[1] === 'claude') {
      if (!String(options.env?.PATH || '').split(':').includes('/Users/example/.npm-global/bin')) {
        throw Object.assign(new Error('claude not found'), { code: 'ENOENT' })
      }
      return { stdout: '/Users/example/.npm-global/bin/claude\n', stderr: '' }
    }

    throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
  }
  return { calls, execFile }
})

const runStart = vi.hoisted(() => vi.fn())

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

vi.mock('../../packages/server/src/modules/studio/public/sessions', () => ({
  getSession: () => null,
  updateSession: () => undefined,
}))

vi.mock('../../packages/server/src/modules/coding-agents/services/runtime/run-manager', () => ({
  codingAgentRunManager: {
    start: runStart,
  },
}))

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
const originalPath = process.env.PATH
const originalShell = process.env.SHELL
const originalHermesDesktop = process.env.HERMES_DESKTOP
const originalWebUiHome = process.env.HERMES_WEB_UI_HOME
const originalCodingAgentGlobalHome = process.env.HERMES_CODING_AGENT_GLOBAL_HOME

const homes: string[] = []

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform })
}

beforeEach(() => {
  execState.calls.length = 0
  runStart.mockReset()
  runStart.mockReturnValue({ pid: 123 })
  setPlatform('darwin')
  process.env.HERMES_DESKTOP = 'true'
  process.env.SHELL = '/bin/zsh'
  process.env.PATH = '/usr/bin'
  const home = mkdtempSync(join(tmpdir(), 'hermes-coding-agent-launch-path-'))
  homes.push(home)
  process.env.HERMES_WEB_UI_HOME = home
  process.env.HERMES_CODING_AGENT_GLOBAL_HOME = join(home, 'global-home')
})

afterEach(() => {
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
  process.env.PATH = originalPath
  if (typeof originalShell === 'undefined') delete process.env.SHELL
  else process.env.SHELL = originalShell
  if (typeof originalHermesDesktop === 'undefined') delete process.env.HERMES_DESKTOP
  else process.env.HERMES_DESKTOP = originalHermesDesktop
  if (typeof originalWebUiHome === 'undefined') delete process.env.HERMES_WEB_UI_HOME
  else process.env.HERMES_WEB_UI_HOME = originalWebUiHome
  if (typeof originalCodingAgentGlobalHome === 'undefined') delete process.env.HERMES_CODING_AGENT_GLOBAL_HOME
  else process.env.HERMES_CODING_AGENT_GLOBAL_HOME = originalCodingAgentGlobalHome
  vi.resetModules()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('coding agent launch command resolution', () => {
  it('spawns Claude from the login shell PATH when Electron PATH is minimal', async () => {
    const { startCodingAgentRun } = await import('../../packages/server/src/bootstrap/coding-agents')
    const result = await startCodingAgentRun('claude-code', {
      sessionId: 'session-1',
      agentSessionId: 'agent-session-1',
      profile: 'default',
      mode: 'global',
      groupSystemPrompt: 'test system prompt',
      workspace: join(process.env.HERMES_WEB_UI_HOME!, 'workspace'),
    })

    expect(result.pid).toBe(123)
    expect(runStart).toHaveBeenCalledTimes(1)
    const started = runStart.mock.calls[0][0]
    expect(started.command).toBe('/Users/example/.npm-global/bin/claude')
    // The child env keeps the launch contract (no inherited process env),
    // while the command was resolved with the enriched desktop PATH.
    expect(started.env).toEqual({ HERMES_STUDIO_SESSION_ID: 'session-1' })
  })

  it('resolves scoped launches without leaking parent secrets into the child environment', async () => {
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'sk-parent-secret')
    vi.stubEnv('CLAUDECODE', '1')

    const { configureProfileConfig } = await import('../../packages/server/src/modules/studio/public/profile-config')
    const home = process.env.HERMES_WEB_UI_HOME!
    configureProfileConfig({
      buildModelGroups: () => ({ default: '', groups: [] }),
      getProfilesBaseDir: () => join(home, 'profiles'),
      getProfileDir: profile => join(home, 'profiles', profile),
      getActiveProfileName: () => 'default',
      listProfileNames: () => ['default'],
      providerEnvironmentMap: {},
      readConfigYaml: async () => ({}),
      readConfigYamlForProfile: async () => ({}),
      safeReadFile: async filePath => existsSync(filePath) ? readFileSync(filePath, 'utf-8') : null,
      saveEnvValue: async () => undefined,
      saveEnvValueForProfile: async () => undefined,
      updateConfigYaml: async () => undefined,
      updateConfigYamlForProfile: async () => undefined,
    })

    const { startCodingAgentRun } = await import('../../packages/server/src/bootstrap/coding-agents')
    const result = await startCodingAgentRun('claude-code', {
      sessionId: 'session-scoped',
      agentSessionId: 'agent-session-scoped',
      profile: 'default',
      mode: 'scoped',
      provider: 'custom:test',
      model: 'claude-sonnet-test',
      apiMode: 'anthropic_messages',
      baseUrl: 'https://provider.example/anthropic',
      apiKey: 'sk-upstream',
      workspace: join(home, 'workspace'),
    })

    expect(result.pid).toBe(123)
    expect(runStart).toHaveBeenCalledTimes(1)
    const started = runStart.mock.calls[0][0]
    expect(started.command).toBe('/Users/example/.npm-global/bin/claude')

    const { isolatedCodingAgentChildEnv } = await import('../../packages/server/src/modules/coding-agents/services/runtime/child-env')
    // The scoped spawn path applies this isolation on top of the launch env.
    const childEnv = isolatedCodingAgentChildEnv(started.env)
    expect(childEnv.ANTHROPIC_API_KEY).toMatch(/^hwui_/)
    expect(childEnv.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(childEnv.CLAUDECODE).toBeUndefined()
  })
})
