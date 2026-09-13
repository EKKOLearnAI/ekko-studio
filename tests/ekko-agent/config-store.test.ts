import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_EKKO_CONFIG,
  EKKO_CONFIG_SCHEMA_VERSION,
  EkkoAgent,
  EkkoConfigError,
  EkkoConfigStore,
  resolveConfiguredModelProvider,
  setupEkkoAgent,
} from '../../packages/ekko-agent/src'

let baseDirectory = ''

beforeEach(async () => {
  baseDirectory = await mkdtemp(join(tmpdir(), 'ekko-config-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(baseDirectory, { recursive: true, force: true })
})

async function configBackups(configPath: string): Promise<string[]> {
  return (await readdir(dirname(configPath)))
    .filter(name => name.startsWith('config.invalid-') && name.endsWith('.json'))
    .sort()
}

describe('EkkoConfigStore', () => {
  it('applies constructor config before creating global Profile agents', async () => {
    const agent = new EkkoAgent({
      baseDirectory,
      env: { NODE_ENV: 'test' },
      config: {
        runtime: { maxSteps: 42 },
        compression: {
          enabled: true,
          threshold: 0.7,
          targetRatio: 0.3,
          protectLastN: 16,
          protectFirstN: 4,
        },
        prompt: { instructions: ['Keep responses concise.'] },
      },
    })
    try {
      expect(agent.readConfig()).toMatchObject({
        runtime: { maxSteps: 42 },
        compression: {
          enabled: true,
          threshold: 0.7,
          targetRatio: 0.3,
          protectLastN: 16,
          protectFirstN: 4,
        },
        prompt: { instructions: ['Keep responses concise.'] },
      })
      expect(JSON.parse(await readFile(agent.layout.configPath, 'utf8'))).toMatchObject({
        runtime: { maxSteps: 42 },
        compression: { threshold: 0.7 },
      })
    } finally {
      agent.close()
    }
  })

  it('collects model and authorization management on new EkkoAgent()', () => {
    const agent = new EkkoAgent({ baseDirectory, env: { NODE_ENV: 'test' } })
    try {
      agent.installModelProviderPreset('qwen-oauth')
      agent.setModelAuthorization('qwen-oauth', {
        type: 'oauth',
        accessToken: 'qwen-token',
      })

      expect(agent.listModelProviders()).toEqual([
        expect.objectContaining({ id: 'qwen-oauth' }),
      ])
      expect(agent.getModelProvider('qwen-oauth')).toMatchObject({
        apiMode: 'chat_completions',
      })
      expect(agent.listModelAuthorizations()).toEqual([
        expect.objectContaining({ provider: 'qwen-oauth' }),
      ])
      agent.updateModelProvider('qwen-oauth', { defaultModel: 'qwen3-coder-plus' })
      agent.updateModelAuthorization('qwen-oauth', { accessToken: 'updated-qwen-token' })
      expect(agent.deleteModelAuthorization('qwen-oauth')).toBe(true)
      expect(agent.deleteModelProvider('qwen-oauth')).toBe(true)
    } finally {
      agent.close()
    }
  })

  it('fills newly added leaves without replacing user values or unknown fields', async () => {
    const setup = setupEkkoAgent({ baseDirectory, env: { NODE_ENV: 'test' } })
    const configPath = setup.layout.configPath
    setup.close()
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      runtime: { maxSteps: 17 },
      model: { reasoningEffort: 'high' },
      tools: { approvals: { permanentAllow: ['terminal:delete'] } },
      futureModule: { userOwned: true },
    }, null, 2))

    const config = new EkkoConfigStore({ configPath }).ensureDefaults()

    expect(config.runtime).toMatchObject({
      maxSteps: 17,
      maxModelRetries: DEFAULT_EKKO_CONFIG.runtime.maxModelRetries,
      toolFailureRecoveryThreshold: DEFAULT_EKKO_CONFIG.runtime.toolFailureRecoveryThreshold,
      maxConsecutiveToolFailures: DEFAULT_EKKO_CONFIG.runtime.maxConsecutiveToolFailures,
    })
    expect(config.model).toMatchObject({
      reasoningEffort: 'high',
      reasoningSummary: DEFAULT_EKKO_CONFIG.model.reasoningSummary,
      providers: {},
    })
    expect(config.tools.approvals.permanentAllow).toEqual(['terminal:delete'])
    expect(config).toHaveProperty('futureModule.userOwned', true)
    expect(config.schemaVersion).toBe(DEFAULT_EKKO_CONFIG.schemaVersion)

    const persisted = JSON.parse(await readFile(configPath, 'utf8'))
    expect(persisted.runtime.maxSteps).toBe(17)
    expect(persisted.runtime.maxModelRetries).toBe(DEFAULT_EKKO_CONFIG.runtime.maxModelRetries)
    expect(persisted.futureModule).toEqual({ userOwned: true })
  })

  it('upgrades schema version 6 in place without creating a recovery backup', async () => {
    const initial = setupEkkoAgent({ baseDirectory, env: { NODE_ENV: 'test' } })
    const configPath = initial.layout.configPath
    initial.close()
    await writeFile(configPath, JSON.stringify({
      ...DEFAULT_EKKO_CONFIG,
      schemaVersion: 6,
      runtime: { ...DEFAULT_EKKO_CONFIG.runtime, maxSteps: 61 },
      futureModule: { userOwned: true },
    }, null, 2))

    const upgraded = setupEkkoAgent({ baseDirectory, env: { NODE_ENV: 'test' } })
    try {
      expect(upgraded.config.read()).toMatchObject({
        schemaVersion: EKKO_CONFIG_SCHEMA_VERSION,
        runtime: { maxSteps: 61 },
        futureModule: { userOwned: true },
      })
      expect(await configBackups(configPath)).toEqual([])
    } finally {
      upgraded.close()
    }
  })

  it('backs up a future schema and restores defaults during the same startup', async () => {
    const initial = setupEkkoAgent({ baseDirectory, env: { NODE_ENV: 'test' } })
    const configPath = initial.layout.configPath
    initial.close()
    const futureConfig = {
      ...structuredClone(DEFAULT_EKKO_CONFIG),
      schemaVersion: EKKO_CONFIG_SCHEMA_VERSION + 1,
      runtime: { ...DEFAULT_EKKO_CONFIG.runtime, maxSteps: 99 },
      futureModule: { userOwned: true },
    }
    await writeFile(configPath, JSON.stringify(futureConfig, null, 2))
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const recovered = setupEkkoAgent({
      baseDirectory,
      env: { NODE_ENV: 'test' },
      config: { runtime: { maxSteps: 42 } },
    })
    try {
      expect(recovered.config.read()).toMatchObject({
        schemaVersion: EKKO_CONFIG_SCHEMA_VERSION,
        runtime: { maxSteps: 42 },
      })
      expect(recovered.config.read()).not.toHaveProperty('futureModule')
      const backups = await configBackups(configPath)
      expect(backups).toHaveLength(1)
      await expect(readFile(join(dirname(configPath), backups[0]), 'utf8'))
        .resolves.toBe(JSON.stringify(futureConfig, null, 2))
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('defaults restored'))
    } finally {
      recovered.close()
    }
  })

  it('backs up malformed JSON and continues startup with current defaults', async () => {
    const initial = setupEkkoAgent({ baseDirectory, env: { NODE_ENV: 'test' } })
    const configPath = initial.layout.configPath
    initial.close()
    const malformed = '{"schemaVersion": 7, "runtime":'
    await writeFile(configPath, malformed)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const recovered = setupEkkoAgent({ baseDirectory, env: { NODE_ENV: 'test' } })
    try {
      expect(recovered.config.read()).toEqual(DEFAULT_EKKO_CONFIG)
      const backups = await configBackups(configPath)
      expect(backups).toHaveLength(1)
      await expect(readFile(join(dirname(configPath), backups[0]), 'utf8')).resolves.toBe(malformed)
    } finally {
      recovered.close()
    }
  })

  it('does not replace the config when the filesystem read fails', async () => {
    const initial = setupEkkoAgent({ baseDirectory, env: { NODE_ENV: 'test' } })
    const configPath = initial.layout.configPath
    initial.close()
    await rm(configPath)
    await mkdir(configPath)

    expect(() => setupEkkoAgent({ baseDirectory, env: { NODE_ENV: 'test' } })).toThrow()
    expect(await configBackups(configPath)).toEqual([])
  })

  it('removes obsolete memory review and session-summary intervals', async () => {
    const setup = setupEkkoAgent({ baseDirectory, env: { NODE_ENV: 'test' } })
    const configPath = setup.layout.configPath
    setup.close()
    await writeFile(configPath, JSON.stringify({
      ...DEFAULT_EKKO_CONFIG,
      schemaVersion: 4,
      memory: {
        ...DEFAULT_EKKO_CONFIG.memory,
        reviewEveryUserMessages: 1,
        summaryEveryUserMessages: 8,
      },
    }, null, 2))

    const config = new EkkoConfigStore({ configPath }).ensureDefaults()

    expect(config.schemaVersion).toBe(9)
    expect(config.memory).not.toHaveProperty('reviewEveryUserMessages')
    expect(config.memory).not.toHaveProperty('summaryEveryUserMessages')
  })

  it('validates context compression policy bounds', () => {
    const setup = setupEkkoAgent({ baseDirectory, env: { NODE_ENV: 'test' } })
    try {
      expect(() => setup.config.update({ compression: { threshold: 1 } }))
        .toThrow('compression.threshold: must be a number between 0.05 and 0.95')
      expect(() => setup.config.update({ compression: { protectLastN: -1 } }))
        .toThrow('compression.protectLastN: must be an integer between 0 and 500')
    } finally {
      setup.close()
    }
  })

  it('patches nested leaves without replacing their sibling settings', () => {
    const setup = setupEkkoAgent({ baseDirectory, env: { NODE_ENV: 'test' } })
    try {
      setup.config.update({
        runtime: { maxSteps: 12 },
        model: { temperature: 0.4 },
      })
      const updated = setup.config.update({
        runtime: { maxModelRetries: 8 },
        model: { reasoningEffort: 'low' },
      })

      expect(updated.runtime).toMatchObject({ maxSteps: 12, maxModelRetries: 8 })
      expect(updated.model).toMatchObject({ temperature: 0.4, reasoningEffort: 'low' })
    } finally {
      setup.close()
    }
  })

  it('persists profile-scoped MCP servers in the canonical config', async () => {
    const setup = setupEkkoAgent({ baseDirectory, env: { NODE_ENV: 'test' } })
    try {
      setup.config.setMcpServer('local-tools', {
        command: process.execPath,
        args: ['server.cjs', '--stdio'],
        env: { LOCAL_MODE: '1' },
        enabled: true,
      }, 'work')

      expect(setup.config.listMcpServers()).toEqual({})
      expect(setup.config.getMcpServer('local-tools', 'work')).toEqual({
        command: process.execPath,
        args: ['server.cjs', '--stdio'],
        env: { LOCAL_MODE: '1' },
        enabled: true,
      })

      setup.config.setMcpServer('remote-tools', {
        type: 'streamableHttp' as 'streamable_http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer test' },
        enabled: true,
      }, 'work')
      expect(setup.config.getMcpServer('remote-tools', 'work')).toEqual({
        type: 'streamable_http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer test' },
        enabled: true,
      })

      setup.config.setMcpServer('local-tools', {
        command: process.execPath,
        args: ['server.cjs', '--stdio'],
        env: { LOCAL_MODE: '1' },
        enabled: false,
      }, 'work')
      expect(setup.config.getMcpServer('local-tools', 'work')?.enabled).toBe(false)

      const persisted = JSON.parse(await readFile(setup.layout.configPath, 'utf8'))
      expect(persisted.mcp.profiles.work.servers['local-tools'].enabled).toBe(false)
      expect(setup.config.deleteMcpServer('local-tools', 'work')).toBe(true)
      expect(setup.config.deleteMcpServer('local-tools', 'work')).toBe(false)
      expect(setup.config.deleteMcpServer('remote-tools', 'work')).toBe(true)
    } finally {
      setup.close()
    }
  })

  it('loads configured profile MCP servers into newly created runtimes', async () => {
    const setup = setupEkkoAgent({ baseDirectory, env: { NODE_ENV: 'test' } })
    try {
      setup.config.setMcpServer('fake', {
        command: process.execPath,
        args: [join(process.cwd(), 'tests/fixtures/fake-mcp-server.cjs')],
        enabled: true,
      })
      const create = vi.fn(async () => ({ content: 'done' }))
      const runtime = setup.createRuntime({
        modelClient: {
          provider: 'test',
          requestStyle: 'custom-runtime',
          capabilities: {
            streaming: false,
            tools: true,
            vision: false,
            jsonMode: false,
            systemPrompt: true,
          },
          create,
          stream: vi.fn(),
        },
        memory: false,
      })

      await runtime.run({ messages: ['hello'] })

      expect(create).toHaveBeenCalledWith(expect.objectContaining({
        tools: expect.arrayContaining([
          expect.objectContaining({ name: 'fake_echo' }),
        ]),
      }))
    } finally {
      setup.close()
    }
  })

  it('supports model provider CRUD with credentials in the same config object', () => {
    const setup = setupEkkoAgent({
      baseDirectory,
      env: { NODE_ENV: 'test' },
    })
    try {
      setup.config.setModelProvider('acme', {
        type: 'openai-compatible',
        requestStyle: 'openai-chat',
        baseUrl: 'https://models.example.test/v1',
        defaultModel: 'acme-large',
        apiKey: 'stored-secret',
      })
      setup.config.setDefaultModel('acme', 'acme-fast')

      expect(setup.config.listModelProviders()).toEqual([
        expect.objectContaining({ id: 'acme', isDefault: true }),
      ])
      expect(setup.config.getModelProvider('acme')).toMatchObject({
        defaultModel: 'acme-large',
        apiKey: 'stored-secret',
      })
      expect(setup.modelProviderConfig()).toMatchObject({
        id: 'acme',
        apiKey: 'stored-secret',
        defaultModel: 'acme-fast',
        timeoutMs: DEFAULT_EKKO_CONFIG.model.requestTimeoutMs,
      })

      setup.config.updateModelProvider('acme', { defaultModel: 'acme-v2' })
      expect(setup.config.getModelProvider('acme')?.defaultModel).toBe('acme-v2')
      expect(setup.config.deleteModelProvider('acme')).toBe(true)
      expect(setup.config.read().model).toMatchObject({ defaultProvider: '', defaultModel: '' })
      expect(setup.config.deleteModelProvider('acme')).toBe(false)
    } finally {
      setup.close()
    }
  })

  it('stores API-mode-aware built-in presets and exposes preset CRUD and installation', () => {
    const setup = setupEkkoAgent({ baseDirectory, env: { NODE_ENV: 'test' } })
    try {
      expect(setup.config.getModelProviderPreset('openai-codex')).toMatchObject({
        label: 'OpenAI Codex',
        apiMode: 'codex_responses',
        requestStyle: 'openai-responses',
        authType: 'oauth',
      })
      expect(setup.config.getModelProviderPreset('qwen-oauth')).toMatchObject({
        apiMode: 'chat_completions',
        requestStyle: 'openai-chat',
      })
      expect(setup.config.getModelProviderPreset('minimax-oauth')).toMatchObject({
        apiMode: 'anthropic_messages',
        requestStyle: 'anthropic-messages',
      })

      setup.config.installModelProviderPreset('openai-codex', {
        defaultModel: 'gpt-5.6-terra',
      })
      expect(setup.config.getModelProvider('openai-codex')).toMatchObject({
        source: 'builtin',
        apiMode: 'codex_responses',
        requestStyle: 'openai-responses',
        defaultModel: 'gpt-5.6-terra',
      })
      expect(setup.modelProviderConfig({ provider: 'openai-codex' })).toMatchObject({
        apiMode: 'codex_responses',
        requestStyle: 'openai-responses',
      })

      const deepseek = setup.config.getModelProviderPreset('deepseek')!
      setup.config.setModelProviderPreset('internal-deepseek', {
        ...deepseek,
        id: 'internal-deepseek',
        label: 'Internal DeepSeek',
        builtin: false,
      })
      setup.config.updateModelProviderPreset('internal-deepseek', { defaultModel: 'deepseek-chat' })
      expect(setup.config.getModelProviderPreset('internal-deepseek')).toMatchObject({
        defaultModel: 'deepseek-chat',
        builtin: false,
      })
      setup.config.installModelProviderPreset('internal-deepseek')
      expect(setup.config.getModelProvider('internal-deepseek')).toMatchObject({ source: 'custom' })
      expect(setup.config.deleteModelProviderPreset('internal-deepseek')).toBe(true)
      expect(setup.config.deleteModelProviderPreset('internal-deepseek')).toBe(false)
    } finally {
      setup.close()
    }
  })

  it('exposes authorization add update list and delete operations', () => {
    const setup = setupEkkoAgent({ baseDirectory, env: { NODE_ENV: 'test' } })
    try {
      setup.config.installModelProviderPreset('xai-oauth')
      setup.config.setModelAuthorization('xai-oauth', {
        type: 'oauth',
        accessToken: 'initial-token',
        refreshToken: 'refresh-token',
        expiresAt: '2026-08-20T08:00:00Z',
      })
      expect(setup.config.listModelAuthorizations()).toEqual([
        expect.objectContaining({ provider: 'xai-oauth' }),
      ])
      setup.config.updateModelAuthorization('xai-oauth', { accessToken: 'updated-token' })
      expect(setup.config.getModelAuthorization('xai-oauth')?.accessToken).toBe('updated-token')
      expect(setup.config.deleteModelAuthorization('xai-oauth')).toBe(true)
      expect(setup.config.deleteModelAuthorization('xai-oauth')).toBe(false)
    } finally {
      setup.close()
    }
  })

  it('keeps explicitly deleted built-in presets deleted across setup', () => {
    const first = setupEkkoAgent({ baseDirectory, env: { NODE_ENV: 'test' } })
    expect(first.config.deleteModelProviderPreset('deepseek')).toBe(true)
    first.close()

    const second = setupEkkoAgent({ baseDirectory, env: { NODE_ENV: 'test' } })
    try {
      expect(second.config.getModelProviderPreset('deepseek')).toBeUndefined()
      expect(second.config.read().model.disabledProviderPresets).toContain('deepseek')
    } finally {
      second.close()
    }
  })

  it('creates a configured model client through the setup facade', async () => {
    const setup = setupEkkoAgent({ baseDirectory, env: { NODE_ENV: 'test' } })
    try {
      setup.config.setModelProvider('local', {
        type: 'openai-compatible',
        requestStyle: 'openai-chat',
        baseUrl: 'http://127.0.0.1:11434/v1',
        defaultModel: 'local-model',
      })
      setup.config.setDefaultModel('local')
      const fetch = vi.fn(async () => new Response(JSON.stringify({
        choices: [{ message: { content: 'configured' }, finish_reason: 'stop' }],
      })))

      const response = await setup.createModelClient({}, { fetch }).create({
        messages: [{ role: 'user', content: 'hello' }],
      })

      expect(response.content).toBe('configured')
      expect(fetch.mock.calls[0]?.[0]).toBe('http://127.0.0.1:11434/v1/chat/completions')
    } finally {
      setup.close()
    }
  })

  it('applies current config when creating a runtime and refreshes approval policy', async () => {
    const setup = setupEkkoAgent({ baseDirectory, env: { NODE_ENV: 'test' } })
    try {
      setup.config.update({
        runtime: { maxSteps: 7, maxModelRetries: 0 },
        model: {
          defaultModel: 'configured-model',
          temperature: 0.25,
          maxTokens: 321,
          reasoningEffort: 'high',
        },
        tools: { enabled: false, approvals: { enabled: false } },
        memory: { enabled: false },
        skills: { enabled: false },
        prompt: { instructions: ['Keep the configured instruction.'] },
      })

      await expect(setup.toolApprovals.authorize('terminal_exec', {
        command: 'rm',
        args: ['file.txt'],
      })).resolves.toMatchObject({ approved: true, scope: 'safe' })

      const create = vi.fn(async () => ({ content: 'done' }))
      const runtime = setup.createRuntime({
        modelClient: {
          provider: 'test',
          requestStyle: 'custom-runtime',
          capabilities: {
            streaming: false,
            tools: true,
            vision: false,
            jsonMode: false,
            systemPrompt: true,
          },
          create,
          stream: vi.fn(),
        },
      })
      await runtime.run({ messages: ['hello'] })

      expect(create).toHaveBeenCalledWith(expect.objectContaining({
        model: 'configured-model',
        temperature: 0.25,
        maxTokens: 321,
        reasoningEffort: 'high',
        tools: undefined,
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'system',
            content: expect.stringContaining('Keep the configured instruction.'),
          }),
        ]),
      }))
    } finally {
      setup.close()
    }
  })

  it('rejects malformed known fields and credential headers outside apiKey', () => {
    expect(() => resolveConfiguredModelProvider({
      config: {
        ...structuredClone(DEFAULT_EKKO_CONFIG),
        model: {
          ...structuredClone(DEFAULT_EKKO_CONFIG.model),
          defaultProvider: 'missing',
        },
      },
    })).toThrow('Configured model provider not found')

    const setup = setupEkkoAgent({ baseDirectory, env: { NODE_ENV: 'test' } })
    try {
      expect(() => setup.config.update({ runtime: { maxSteps: -1 } })).toThrow(EkkoConfigError)
      expect(() => setup.config.setModelProvider('unsafe', {
        type: 'openai-compatible',
        defaultModel: 'unsafe-model',
        headers: { Authorization: 'Bearer must-not-persist' },
      })).toThrow(/credential headers/)
    } finally {
      setup.close()
    }
  })

  it('persists Profile-scoped external Skill directories and disabled names', () => {
    const setup = setupEkkoAgent({ baseDirectory, env: { NODE_ENV: 'test' } })
    try {
      setup.config.setSkillExternalDirectories(['~/shared-skills', '$TEAM_SKILLS'], 'work')
      setup.config.setSkillEnabled('weather', false, 'work')

      expect(setup.config.getSkillProfile()).toEqual({ disabled: [], externalDirectories: [] })
      expect(setup.config.getSkillProfile('work')).toEqual({
        disabled: ['weather'],
        externalDirectories: ['~/shared-skills', '$TEAM_SKILLS'],
      })

      setup.config.setSkillEnabled('weather', true, 'work')
      expect(setup.config.getSkillProfile('work').disabled).toEqual([])
    } finally {
      setup.close()
    }
  })
})
