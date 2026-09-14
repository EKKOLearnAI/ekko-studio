import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { delimiter, join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getSessionMock = vi.fn()
const updateSessionMock = vi.fn()
const readConfigYamlForProfileMock = vi.fn()
const safeReadFileMock = vi.fn()
const startRunMock = vi.fn()

vi.doMock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
  getSession: getSessionMock,
  updateSession: updateSessionMock,
}))

vi.doMock('../../packages/server/src/modules/hermes/services/profiles/config', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../packages/server/src/modules/hermes/services/profiles/config')>(),
  PROVIDER_ENV_MAP: {
    deepseek: { api_key_env: 'DEEPSEEK_API_KEY', base_url_env: 'DEEPSEEK_BASE_URL' },
  },
  readConfigYamlForProfile: readConfigYamlForProfileMock,
  safeReadFile: safeReadFileMock,
}))

vi.doMock('../../packages/server/src/modules/hermes/services/profiles/profile', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../packages/server/src/modules/hermes/services/profiles/profile')>(),
  getProfileDir: (profile: string) => `/tmp/hermes-profile/${profile}`,
}))

vi.doMock('../../packages/server/src/modules/coding-agents/services/runtime/run-manager', () => ({
  codingAgentRunManager: {
    start: startRunMock,
  },
}))

const homes: string[] = []
const originalPath = process.env.PATH
const originalNpmConfigPrefix = process.env.NPM_CONFIG_PREFIX

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'hermes-coding-agent-resume-'))
  homes.push(home)
  process.env.HERMES_WEB_UI_HOME = home
  return home
}

function installPiMcpAdapter(home: string) {
  const entry = join(home, 'coding-agent', 'pi-mcp-adapter', 'node_modules', 'pi-mcp-adapter', 'index.ts')
  mkdirSync(join(entry, '..'), { recursive: true })
  writeFileSync(entry, 'export default {}')
}

describe('coding agent resumed session config', () => {
  beforeEach(() => {
    vi.resetModules()
    getSessionMock.mockReset()
    updateSessionMock.mockReset()
    readConfigYamlForProfileMock.mockReset()
    safeReadFileMock.mockReset()
    startRunMock.mockReset()
    startRunMock.mockReturnValue({ runId: 'agent-session-1', pid: 0 })
  })

  afterEach(() => {
    delete process.env.HERMES_WEB_UI_HOME
    if (typeof originalPath === 'undefined') delete process.env.PATH
    else process.env.PATH = originalPath
    if (typeof originalNpmConfigPrefix === 'undefined') delete process.env.NPM_CONFIG_PREFIX
    else process.env.NPM_CONFIG_PREFIX = originalNpmConfigPrefix
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  it('adds the npm global bin to the POSIX Codex runtime PATH', async () => {
    if (process.platform === 'win32') return
    const home = makeHome()
    const npmPrefix = join(home, 'coding-agent', 'npm')
    process.env.NPM_CONFIG_PREFIX = npmPrefix
    process.env.PATH = '/usr/bin:/bin'
    getSessionMock.mockReturnValue(null)
    readConfigYamlForProfileMock.mockResolvedValue({})
    safeReadFileMock.mockResolvedValue('')

    const { startCodingAgentRun } = await import('../../packages/server/src/bootstrap/coding-agents')
    await startCodingAgentRun('codex', {
      sessionId: 'session-path',
      mode: 'global',
      profile: 'default',
    })

    const launch = startRunMock.mock.calls[0][0]
    const entries = String(launch.env.PATH || '').split(delimiter)
    expect(launch.command).toBe('codex')
    expect(entries[0]).toBe(join(npmPrefix, 'bin'))
    expect(entries).toContain('/usr/bin')
    expect(entries).toContain('/bin')
    expect(entries.filter((entry: string) => entry === join(npmPrefix, 'bin'))).toHaveLength(1)
  })

  it('rebuilds Claude scoped proxy credentials from stored provider config after restart', async () => {
    const home = makeHome()
    getSessionMock.mockReturnValue({
      id: 'session-1',
      profile: 'default',
      source: 'coding_agent',
      agent: 'claude',
      agent_session_id: 'agent-session-1',
      provider: 'custom:corp-claude',
      model: 'claude-sonnet-test',
    })
    readConfigYamlForProfileMock.mockResolvedValue({
      custom_providers: [{
        name: 'corp-claude',
        base_url: 'https://provider.example/anthropic',
        api_key: 'sk-upstream',
        model: 'claude-sonnet-test',
        api_mode: 'anthropic_messages',
      }],
    })
    safeReadFileMock.mockResolvedValue('')

    const { startCodingAgentRun } = await import('../../packages/server/src/bootstrap/coding-agents')
    const result = await startCodingAgentRun('claude-code', { sessionId: 'session-1' })

    expect(startRunMock).toHaveBeenCalledWith(expect.objectContaining({
      agentSessionId: 'agent-session-1',
      provider: 'custom:corp-claude',
      model: 'claude-sonnet-test',
      sessionId: 'session-1',
    }))
    const launch = startRunMock.mock.calls[0][0]
    expect(launch.env.ANTHROPIC_API_KEY).toMatch(/^hwui_/)
    expect(launch.env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN')
    expect(launch.env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/claude-code-proxy\/.+$/)
    const settings = JSON.parse(readFileSync(join(result.rootDir, 'settings.json'), 'utf-8'))
    expect(settings.env.ANTHROPIC_API_KEY).toBe(launch.env.ANTHROPIC_API_KEY)
  })

  it('recovers legacy sanitized custom provider keys from existing sessions', async () => {
    const home = makeHome()
    getSessionMock.mockReturnValue({
      id: 'session-1',
      profile: 'default',
      source: 'coding_agent',
      agent: 'claude',
      agent_session_id: 'agent-session-1',
      provider: 'custom_glm-coding-plan',
      model: 'glm-5-turbo',
    })
    readConfigYamlForProfileMock.mockResolvedValue({
      custom_providers: [{
        name: 'glm-coding-plan',
        base_url: 'https://api.z.ai/api/anthropic',
        api_key: 'sk-glm',
        model: 'glm-5-turbo',
      }],
    })
    safeReadFileMock.mockResolvedValue('')

    const { startCodingAgentRun } = await import('../../packages/server/src/bootstrap/coding-agents')
    const result = await startCodingAgentRun('claude-code', { sessionId: 'session-1' })

    expect(result.provider).toBe('custom:glm-coding-plan')
    expect(updateSessionMock).toHaveBeenCalledWith('session-1', expect.objectContaining({
      provider: 'custom:glm-coding-plan',
      agent_native_session_id: expect.any(String),
    }))
    const launch = startRunMock.mock.calls[0][0]
    expect(launch.env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/claude-code-proxy\/.+$/)
    expect(Buffer.from(launch.env.ANTHROPIC_BASE_URL.split('/').pop() || '', 'base64url').toString('utf8')).toContain('anthropic_messages')
    const settings = JSON.parse(readFileSync(join(result.rootDir, 'settings.json'), 'utf-8'))
    expect(settings.env.ANTHROPIC_API_KEY).toMatch(/^hwui_/)
  })

  it('preserves the stored workspace when a coding agent session switches provider and model', async () => {
    const home = makeHome()
    const originalWorkspace = join(home, 'coding-agent', 'workspace', 'default', 'openrouter')
    getSessionMock.mockReturnValue({
      id: 'session-1',
      profile: 'default',
      source: 'coding_agent',
      agent: 'codex',
      agent_session_id: 'agent-session-1',
      agent_native_session_id: 'old-native-thread',
      provider: 'openrouter',
      model: 'old-model',
      workspace: originalWorkspace,
    })

    const { startCodingAgentRun } = await import('../../packages/server/src/bootstrap/coding-agents')
    await startCodingAgentRun('codex', {
      sessionId: 'session-1',
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-test',
      apiMode: 'chat_completions',
    })

    const launch = startRunMock.mock.calls[0][0]
    expect(launch.workspaceDir).toBe(originalWorkspace)
    expect(launch.agentNativeSessionId).toBe('')
    expect(launch.nativeResume).toBe(false)
    expect(updateSessionMock).toHaveBeenCalledWith('session-1', expect.objectContaining({
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      agent_native_session_id: '',
      workspace: originalWorkspace,
    }))
  })

  it('ignores a stale builtin base URL when the requested provider changed', async () => {
    makeHome()
    getSessionMock.mockReturnValue({
      id: 'session-1',
      profile: 'default',
      source: 'coding_agent',
      agent: 'codex',
      agent_session_id: 'agent-session-1',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
    })
    readConfigYamlForProfileMock.mockResolvedValue({})
    safeReadFileMock.mockResolvedValue('DEEPSEEK_API_KEY=sk-deepseek\n')

    const { startCodingAgentRun } = await import('../../packages/server/src/bootstrap/coding-agents')
    const result = await startCodingAgentRun('codex', {
      sessionId: 'session-1',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      baseUrl: 'https://api.xiaomimimo.com/v1',
      apiKey: 'sk-xiaomi',
      apiMode: 'chat_completions',
    })

    const config = readFileSync(join(result.rootDir, 'config.toml'), 'utf-8')
    const routeKey = config.match(/\/api\/codex-proxy\/([^/]+)\/v1/)?.[1] || ''
    const routeParts = JSON.parse(Buffer.from(routeKey, 'base64url').toString('utf8'))
    expect(routeParts).toEqual(expect.arrayContaining([
      'deepseek',
      'deepseek-v4-pro',
      'chat_completions',
      'https://api.deepseek.com',
    ]))
    expect(routeParts).not.toContain('https://api.xiaomimimo.com/v1')
  })

  it('resumes Claude with a stored native session id after service restart', async () => {
    makeHome()
    getSessionMock.mockReturnValue({
      id: 'session-1',
      profile: 'default',
      source: 'coding_agent',
      agent: 'claude',
      agent_session_id: 'agent-session-1',
      agent_native_session_id: '11111111-1111-4111-8111-111111111111',
      provider: 'custom:corp-claude',
      model: 'claude-sonnet-test',
    })
    readConfigYamlForProfileMock.mockResolvedValue({
      custom_providers: [{
        name: 'corp-claude',
        base_url: 'https://provider.example/anthropic',
        api_key: 'sk-upstream',
        model: 'claude-sonnet-test',
        api_mode: 'anthropic_messages',
      }],
    })
    safeReadFileMock.mockResolvedValue('')

    const { startCodingAgentRun } = await import('../../packages/server/src/bootstrap/coding-agents')
    await startCodingAgentRun('claude-code', { sessionId: 'session-1' })

    expect(startRunMock).toHaveBeenCalledWith(expect.objectContaining({
      agentNativeSessionId: '11111111-1111-4111-8111-111111111111',
      nativeResume: true,
    }))
  })

  it('resumes a global Codex native thread after the active runner is stopped', async () => {
    makeHome()
    getSessionMock.mockReturnValue({
      id: 'session-1',
      profile: 'default',
      source: 'coding_agent',
      agent: 'codex',
      agent_mode: 'global',
      agent_session_id: 'agent-session-1',
      agent_native_session_id: 'global-codex-thread-1',
      provider: 'global',
      model: '',
      api_mode: '',
      workspace: '/tmp/existing-workspace',
    })

    const { startCodingAgentRun } = await import('../../packages/server/src/bootstrap/coding-agents')
    await startCodingAgentRun('codex', {
      sessionId: 'session-1',
      mode: 'global',
      workspace: '/tmp/existing-workspace',
    })

    expect(startRunMock).toHaveBeenCalledWith(expect.objectContaining({
      agentNativeSessionId: 'global-codex-thread-1',
      nativeResume: true,
    }))
    expect(updateSessionMock).toHaveBeenCalledWith('session-1', expect.objectContaining({
      agent_native_session_id: 'global-codex-thread-1',
    }))
  })

  it('passes the stored native session id to Pi so its RPC process resumes after restart', async () => {
    const home = makeHome()
    installPiMcpAdapter(home)
    getSessionMock.mockReturnValue({
      id: 'session-1',
      profile: 'default',
      source: 'coding_agent',
      agent: 'pi',
      agent_mode: 'scoped',
      agent_session_id: 'agent-session-1',
      agent_native_session_id: '11111111-2222-4333-8444-555555555555',
      provider: 'custom:corp-pi',
      model: 'gpt-test',
      api_mode: 'codex_responses',
    })
    readConfigYamlForProfileMock.mockResolvedValue({
      custom_providers: [{
        name: 'corp-pi',
        base_url: 'https://provider.example/v1',
        api_key: 'sk-upstream',
        model: 'gpt-test',
        api_mode: 'codex_responses',
      }],
    })
    safeReadFileMock.mockResolvedValue('')

    const { startCodingAgentRun } = await import('../../packages/server/src/bootstrap/coding-agents')
    await startCodingAgentRun('pi', { sessionId: 'session-1' })

    const launch = startRunMock.mock.calls[0][0]
    expect(launch).toEqual(expect.objectContaining({
      agentNativeSessionId: '11111111-2222-4333-8444-555555555555',
      nativeResume: true,
    }))
    expect(launch.args).toEqual(expect.arrayContaining([
      '--session-id', '11111111-2222-4333-8444-555555555555',
    ]))
  })

  it('uses the same generated native session id for a new Pi launch and persistence', async () => {
    const home = makeHome()
    installPiMcpAdapter(home)
    getSessionMock.mockReturnValue(null)
    readConfigYamlForProfileMock.mockResolvedValue({})
    safeReadFileMock.mockResolvedValue('')

    const { startCodingAgentRun } = await import('../../packages/server/src/bootstrap/coding-agents')
    await startCodingAgentRun('pi', {
      sessionId: 'session-new',
      profile: 'default',
      provider: 'custom:corp-pi',
      model: 'gpt-test',
      baseUrl: 'https://provider.example/v1',
      apiKey: 'sk-upstream',
      apiMode: 'codex_responses',
    })

    const launch = startRunMock.mock.calls[0][0]
    expect(launch.agentNativeSessionId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(launch.nativeResume).toBe(false)
    expect(launch.args).toEqual(expect.arrayContaining([
      '--session-id', launch.agentNativeSessionId,
    ]))
    expect(updateSessionMock).toHaveBeenCalledWith('session-new', expect.objectContaining({
      agent_native_session_id: launch.agentNativeSessionId,
    }))
  })

  it('does not resume a stored scoped Codex native session when launching global mode', async () => {
    makeHome()
    getSessionMock.mockReturnValue({
      id: 'session-1',
      profile: 'default',
      source: 'coding_agent',
      agent: 'codex',
      agent_mode: 'scoped',
      agent_session_id: 'agent-session-1',
      agent_native_session_id: 'codex-scoped-thread',
      provider: 'custom:glm-coding-plan',
      model: 'glm-5-turbo',
    })
    readConfigYamlForProfileMock.mockResolvedValue({})
    safeReadFileMock.mockResolvedValue('')

    const { startCodingAgentRun } = await import('../../packages/server/src/bootstrap/coding-agents')
    const result = await startCodingAgentRun('codex', { sessionId: 'session-1', mode: 'global' })

    expect(result).toEqual(expect.objectContaining({
      mode: 'global',
      provider: 'global',
      model: '',
    }))
    expect(startRunMock).toHaveBeenCalledWith(expect.objectContaining({
      agentSessionId: 'agent-session-1',
      agentNativeSessionId: '',
      nativeResume: false,
      provider: 'global',
      model: '',
      env: expect.objectContaining({
        HERMES_STUDIO_SESSION_ID: 'session-1',
        CODEX_HOME: expect.stringContaining(join('coding-agent', 'model', 'default', 'global', 'codex', 'runs')),
      }),
      args: [],
      promptFile: expect.stringContaining(join('AGENTS.md')),
    }))
    expect(updateSessionMock).toHaveBeenCalledWith('session-1', expect.objectContaining({
      agent_mode: 'global',
      agent_native_session_id: '',
      provider: 'global',
      model: '',
    }))
  })


  it('prefers a stored coding-agent API mode when resuming without an explicit mode', async () => {
    makeHome()
    getSessionMock.mockReturnValue({
      id: 'session-1',
      profile: 'default',
      source: 'coding_agent',
      agent: 'codex',
      agent_session_id: 'agent-session-1',
      provider: 'fun-codex',
      model: 'gpt-5.5',
      api_mode: 'chat_completions',
    })
    readConfigYamlForProfileMock.mockResolvedValue({})
    safeReadFileMock.mockResolvedValue('')

    const { startCodingAgentRun } = await import('../../packages/server/src/bootstrap/coding-agents')
    const result = await startCodingAgentRun('codex', {
      sessionId: 'session-1',
      baseUrl: 'https://api.apikey.fan/v1',
      apiKey: 'sk-test',
    })

    const launch = startRunMock.mock.calls[0][0]
    expect(launch.apiMode).toBe('chat_completions')
    const config = readFileSync(join(result.rootDir, 'config.toml'), 'utf-8')
    const routeKey = config.match(/\/api\/codex-proxy\/([^/]+)\/v1/)?.[1] || ''
    expect(Buffer.from(routeKey, 'base64url').toString('utf8')).toContain('chat_completions')
    expect(updateSessionMock).toHaveBeenCalledWith('session-1', expect.objectContaining({
      api_mode: 'chat_completions',
    }))
  })

  it('rejects OAuth/subscription providers for scoped coding-agent launches', async () => {
    makeHome()
    getSessionMock.mockReturnValue(null)
    readConfigYamlForProfileMock.mockResolvedValue({})
    safeReadFileMock.mockResolvedValue('')

    const { startCodingAgentRun } = await import('../../packages/server/src/bootstrap/coding-agents')
    await expect(startCodingAgentRun('codex', {
      sessionId: 'session-1',
      mode: 'scoped',
      profile: 'default',
      provider: 'copilot',
      model: 'gpt-5.5',
      baseUrl: 'https://api.githubcopilot.com',
      apiKey: 'oauth-token',
      apiMode: 'codex_responses',
    })).rejects.toThrow('does not support OAuth/subscription providers')
    expect(startRunMock).not.toHaveBeenCalled()
  })

  it('starts and resumes OpenCode Free without reading upstream credentials', async () => {
    makeHome()
    getSessionMock.mockReturnValue({
      id: 'session-free', profile: 'default', source: 'coding_agent', agent: 'codex',
      agent_session_id: 'agent-session-1', provider: 'opencode-free', model: 'muse-spark-free',
    })
    safeReadFileMock.mockResolvedValue('')
    const { startCodingAgentRun } = await import('../../packages/server/src/bootstrap/coding-agents')
    await startCodingAgentRun('codex', { sessionId: 'session-free' })
    const resumed = startRunMock.mock.calls[0][0]
    expect(resumed.provider).toBe('opencode-free')
    expect(resumed.model).toBe('muse-spark-free')
    expect(readConfigYamlForProfileMock).not.toHaveBeenCalled()
    getSessionMock.mockReturnValue(null)
    await startCodingAgentRun('codex', {
      sessionId: 'session-new-free', provider: 'opencode-free', model: 'mimo-v2.5-free',
      apiKey: 'stale-key', baseUrl: 'https://stale.example/v1',
    })
    expect(startRunMock).toHaveBeenCalledTimes(2)
    const started = startRunMock.mock.calls[1][0]
    expect(started.provider).toBe('opencode-free')
    expect(started.model).toBe('mimo-v2.5-free')
  })

  it('fails clearly instead of launching Claude without scoped credentials', async () => {
    makeHome()
    getSessionMock.mockReturnValue({
      id: 'session-1',
      profile: 'default',
      source: 'coding_agent',
      agent: 'claude',
      agent_session_id: 'agent-session-1',
      provider: 'custom:missing',
      model: 'claude-sonnet-test',
    })
    readConfigYamlForProfileMock.mockResolvedValue({ custom_providers: [] })
    safeReadFileMock.mockResolvedValue('')

    const { startCodingAgentRun } = await import('../../packages/server/src/bootstrap/coding-agents')
    await expect(startCodingAgentRun('claude-code', { sessionId: 'session-1' }))
      .rejects.toThrow('Coding agent provider credentials are missing')
    expect(startRunMock).not.toHaveBeenCalled()
  })

  it('resolves custom-provider credentials from key_env on continuation', async () => {
    const home = makeHome()
    getSessionMock.mockReturnValue({
      id: 'session-1',
      profile: 'default',
      source: 'coding_agent',
      agent: 'claude',
      agent_session_id: 'agent-session-1',
      provider: 'custom:sensenova',
      model: 'deepseek-v4-flash',
    })
    readConfigYamlForProfileMock.mockResolvedValue({
      custom_providers: [{
        name: 'sensenova',
        base_url: 'https://api.sensenova.cn/v1',
        key_env: 'SENSENOVA_API_KEY',
        model: 'deepseek-v4-flash',
      }],
    })
    safeReadFileMock.mockResolvedValue('SENSENOVA_API_KEY=sk-from-env\n')

    const { startCodingAgentRun } = await import('../../packages/server/src/bootstrap/coding-agents')
    await expect(startCodingAgentRun('claude-code', { sessionId: 'session-1' })).resolves.toEqual(
      expect.objectContaining({
        provider: 'custom:sensenova',
      }),
    )
    expect(startRunMock).toHaveBeenCalled()
    expect(home).toBeTruthy()
  })

  it('resolves Profile credentials for a new session from an explicit execution identity', async () => {
    makeHome()
    getSessionMock.mockReturnValue(null)
    readConfigYamlForProfileMock.mockResolvedValue({
      custom_providers: [{
        name: 'corp-codex',
        base_url: 'https://provider.example/v1',
        api_key: 'test-only',
        model: 'gpt-5.6-terra',
        api_mode: 'codex_responses',
      }],
    })
    safeReadFileMock.mockResolvedValue('')

    const { startCodingAgentRun } = await import('../../packages/server/src/bootstrap/coding-agents')
    await expect(startCodingAgentRun('codex', {
      sessionId: 'new-session',
      mode: 'scoped',
      profile: 'default',
      provider: 'custom:corp-codex',
      model: 'gpt-5.6-terra',
      apiMode: 'codex_responses',
    })).resolves.toEqual(expect.objectContaining({
      provider: 'custom:corp-codex',
      model: 'gpt-5.6-terra',
      apiMode: 'codex_responses',
    }))

    expect(startRunMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'new-session',
      provider: 'custom:corp-codex',
      model: 'gpt-5.6-terra',
      apiMode: 'codex_responses',
    }))
  })
})
