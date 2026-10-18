import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureProfileConfig } from '../../../../packages/server/src/modules/studio/public/profile-config'

const getSessionMock = vi.fn()
const updateSessionMock = vi.fn()
const startRunMock = vi.fn()

vi.doMock('../../../../packages/server/src/modules/studio/repositories/session-store', () => ({
  getSession: getSessionMock,
  updateSession: updateSessionMock,
}))

vi.doMock('../../../../packages/server/src/modules/coding-agents/services/runtime/run-manager', () => ({
  codingAgentRunManager: {
    start: startRunMock,
  },
}))

const homes: string[] = []

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'hermes-cursor-global-mode-'))
  homes.push(home)
  process.env.HERMES_WEB_UI_HOME = home
  process.env.HERMES_CODING_AGENT_GLOBAL_HOME = home
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
  mkdirSync(join(home, '.cursor'), { recursive: true })
  return home
}

describe('Cursor launch mode is always global', () => {
  beforeEach(() => {
    vi.resetModules()
    getSessionMock.mockReset()
    updateSessionMock.mockReset()
    startRunMock.mockReset()
    startRunMock.mockReturnValue({ runId: 'cursor-run-1', pid: 0 })
  })

  afterEach(() => {
    delete process.env.HERMES_WEB_UI_HOME
    delete process.env.HERMES_CODING_AGENT_GLOBAL_HOME
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  it('stores agent_mode global when start is asked for scoped, including old scoped sessions', async () => {
    makeHome()
    getSessionMock.mockReturnValue({
      id: 'session-cursor-old',
      profile: 'default',
      source: 'coding_agent',
      agent: 'cursor',
      agent_mode: 'scoped',
      agent_session_id: 'cursor-run-old',
      agent_native_session_id: 'cursor-thread-1',
      provider: 'openai',
      model: 'gpt-4',
    })

    const { startCodingAgentRun } = await import('../../../../packages/server/src/bootstrap/coding-agents')
    const started = await startCodingAgentRun('cursor', {
      sessionId: 'session-cursor-old',
      mode: 'scoped',
      profile: 'default',
    })

    expect(started.agentId).toBe('cursor')
    expect(started.mode).toBe('global')
    expect(started.command).toBe('agent')
    expect(startRunMock).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'cursor',
      mode: 'global',
      provider: 'global',
      agentNativeSessionId: 'cursor-thread-1',
      nativeResume: true,
    }))
    expect(updateSessionMock).toHaveBeenCalledWith('session-cursor-old', expect.objectContaining({
      agent: 'cursor',
      agent_mode: 'global',
      agent_native_session_id: 'cursor-thread-1',
      provider: 'global',
    }))
  })
})
