import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  closeGlobalEkkoAgent,
  createGlobalEkkoAgent,
  getGlobalEkkoAgent,
  GlobalEkkoAgent,
  setupGlobalEkkoAgent,
} from '../../packages/server/src/modules/ekko/services/manager'
import { DEFAULT_EKKO_JEV_CONFIG, EkkoFileLogReader, noul, setupEkkoAgent } from '../../packages/ekko-agent/src'
import type { EkkoAgentSetup, ModelClient, ModelRequest } from '../../packages/ekko-agent/src'

const getHermesBaseDirMock = vi.hoisted(() => vi.fn())
const getJevRuntimeConfigMock = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/modules/studio/public/jev', () => ({
  getJevRuntimeConfig: getJevRuntimeConfigMock,
}))

vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({
  getProfilesBaseDir: getHermesBaseDirMock,
  listProfileNames: vi.fn(() => ['default']),
}))

let baseDirectory = ''
let setups: EkkoAgentSetup[] = []

beforeEach(async () => {
  baseDirectory = await mkdtemp(join(tmpdir(), 'global-ekko-agent-'))
  setups = []
  getHermesBaseDirMock.mockReturnValue(join(baseDirectory, 'hermes'))
  getJevRuntimeConfigMock.mockReset().mockResolvedValue({ ...DEFAULT_EKKO_JEV_CONFIG })
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  closeGlobalEkkoAgent()
  for (const setup of setups) setup.close()
  await rm(baseDirectory, { recursive: true, force: true })
})

function createTestSetup(profiles: string[] = []): EkkoAgentSetup {
  const setup = setupEkkoAgent({
    baseDirectory,
    hermesRootDirectory: getHermesBaseDirMock(),
    profiles,
  })
  setups.push(setup)
  return setup
}

function createTestAgent(
  options: Omit<ConstructorParameters<typeof GlobalEkkoAgent>[0], 'setup'> = {},
): GlobalEkkoAgent {
  return new GlobalEkkoAgent({
    setup: createTestSetup(options.profile ? [options.profile] : []),
    ...options,
  })
}

function modelClient(content: string): ModelClient {
  return {
    provider: 'test',
    requestStyle: 'custom-runtime',
    capabilities: {
      streaming: false,
      tools: true,
      vision: false,
      jsonMode: false,
      systemPrompt: true,
    },
    create: vi.fn(async () => ({ content })),
    stream: vi.fn(),
  }
}

describe('GlobalEkkoAgent', () => {
  it('passes current Profile JEV settings to Ekko without overwriting its persisted defaults', async () => {
    const setup = createTestSetup(['work', 'personal'])
    setup.config.update({ jev: { enabled: true, memoryEnabled: true, apiKey: 'ekko-local-key' } })
    const before = await readFile(setup.layout.configPath, 'utf8')
    const createRuntime = vi.spyOn(setup, 'createRuntime')
    getJevRuntimeConfigMock.mockImplementation(async profile => ({
      ...DEFAULT_EKKO_JEV_CONFIG, enabled: true, memoryEnabled: profile === 'personal', apiKey: `studio-${profile}`, model: `jev-${profile}`,
    }))
    const work = createGlobalEkkoAgent({ setup, profile: 'work', memory: false })
    const personal = createGlobalEkkoAgent({ setup, profile: 'personal', memory: false })
    await work.run({ messages: ['first'], modelClient: modelClient('work') })
    await personal.run({ messages: ['second'], modelClient: modelClient('personal') })
    expect(createRuntime.mock.calls[0][0]?.jev).toMatchObject({ apiKey: 'studio-work' })
    expect(createRuntime.mock.calls[1][0]?.jev).toMatchObject({ apiKey: 'studio-personal' })
    const workRuntime = createRuntime.mock.results[0].value
    const personalRuntime = createRuntime.mock.results[1].value
    expect(workRuntime.jev).not.toBe(personalRuntime.jev)
    expect(workRuntime.jev.settings.model).toBe('jev-work')
    expect(personalRuntime.jev.settings.model).toBe('jev-personal')
    expect(workRuntime.jev.settings.memoryEnabled).toBe(false)
    expect(personalRuntime.jev.settings.memoryEnabled).toBe(true)
    // The cached runtime picks up edits before the next run.
    getJevRuntimeConfigMock.mockResolvedValue({ ...DEFAULT_EKKO_JEV_CONFIG, enabled: true, memoryEnabled: true, apiKey: 'edited-key', model: 'jev-edited',
      memoryKindRoutingEnabled: true, memoryRerankEnabled: true, memoryWriteReviewEnabled: true,
      memoryCandidateLimit: 7, memoryMinConfidence: 0.95, memoryTimeoutMs: 1200 })
    await work.run({ messages: ['again'], modelClient: modelClient('updated') })
    expect(createRuntime).toHaveBeenCalledTimes(2)
    expect(workRuntime.jev.settings.model).toBe('jev-edited')
    expect(workRuntime.jev.settings).toMatchObject({ memoryKindRoutingEnabled: true, memoryRerankEnabled: true,
      memoryWriteReviewEnabled: true, memoryCandidateLimit: 7, memoryMinConfidence: 0.95, memoryTimeoutMs: 1200 })
    expect(workRuntime.jev.settings.memoryEnabled).toBe(true)
    expect(personalRuntime.jev.settings.model).toBe('jev-personal')
    getJevRuntimeConfigMock.mockResolvedValue({ ...DEFAULT_EKKO_JEV_CONFIG, enabled: true, apiKey: 'edited-key', model: 'jev-edited', memoryEnabled: false })
    await work.run({ messages: ['memory JEV off'], modelClient: modelClient('continued') })
    expect(workRuntime.jev.settings.memoryEnabled).toBe(false)
    expect(workRuntime.jev.available).toBe(true)
    expect(personalRuntime.jev.settings.memoryEnabled).toBe(true)
    // Removing Studio's key explicitly disables JEV instead of falling back to Ekko's local key.
    getJevRuntimeConfigMock.mockResolvedValue({ ...DEFAULT_EKKO_JEV_CONFIG })
    await work.run({ messages: ['no JEV'], modelClient: modelClient('normal response') })
    expect(workRuntime.jev.available).toBe(false)
    expect(workRuntime.jev.settings.memoryEnabled).toBe(false)
    expect(await readFile(setup.layout.configPath, 'utf8')).toBe(before)
  })

  it('passes Profile JEV settings into isolated runs and degrades config read failures', async () => {
    const setup = createTestSetup(['work'])
    const createRuntime = vi.spyOn(setup, 'createRuntime')
    const agent = createGlobalEkkoAgent({ setup, profile: 'work', memory: false })
    getJevRuntimeConfigMock.mockResolvedValue({ ...DEFAULT_EKKO_JEV_CONFIG, enabled: true, memoryEnabled: true, apiKey: 'isolated-key' })
    await agent.runIsolated({ modelClient: modelClient('isolated') }, { messages: ['isolated'] })
    expect(createRuntime.mock.calls[0][0]?.jev).toMatchObject({ enabled: true, memoryEnabled: true, apiKey: 'isolated-key' })
    getJevRuntimeConfigMock.mockRejectedValue(new Error('private configuration details'))
    await expect(agent.run({ messages: ['continue'], modelClient: modelClient('continued') }))
      .resolves.toMatchObject({ output: { content: 'continued' } })
    const runtime = createRuntime.mock.results[1].value
    const upstream = vi.fn()
    vi.stubGlobal('fetch', upstream)
    expect(await runtime.jev.evaluate({ state: null, questions: { ok: noul('OK?') } })).toBeUndefined()
    expect(upstream).not.toHaveBeenCalled()
  })

  it('sets up global directories and the memory database before any agent run', () => {
    const setup = setupGlobalEkkoAgent({
      baseDirectory,
      profiles: ['default', 'work'],
      config: {
        runtime: { maxSteps: 48 },
        compression: { threshold: 0.65 },
      },
      env: { NODE_ENV: 'test' },
    })

    expect(existsSync(join(baseDirectory, '.ekko', 'config', 'config.json'))).toBe(true)
    expect(existsSync(join(baseDirectory, '.ekko', 'ekko.db'))).toBe(true)
    expect(existsSync(join(baseDirectory, '.ekko', 'skills', 'work'))).toBe(true)
    expect(existsSync(join(baseDirectory, '.ekko', 'logs', 'work'))).toBe(true)
    expect(existsSync(join(baseDirectory, '.ekko', 'workspace', 'work'))).toBe(true)
    expect(setup.memory.isEnabled).toBe(true)
    expect(setup.config.read()).toMatchObject({
      runtime: { maxSteps: 48 },
      compression: { threshold: 0.65 },
    })
  })

  it('automatically reopens persistent storage after a repaired fallback database', async () => {
    const ekkoRoot = join(baseDirectory, '.ekko')
    const databasePath = join(ekkoRoot, 'ekko.db')
    const initial = setupEkkoAgent({ baseDirectory, env: { NODE_ENV: 'test' } })
    initial.close()
    await rm(databasePath)
    await mkdir(databasePath, { recursive: true })
    await chmod(ekkoRoot, 0o500)

    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const degradedSetup = setupGlobalEkkoAgent({
      baseDirectory,
      profiles: ['default'],
      env: { NODE_ENV: 'test' },
    })
    const degradedAgent = getGlobalEkkoAgent()
    const repairClient = modelClient('database repaired automatically')

    try {
      expect(degradedSetup.database.databasePath).toBe(':memory:')
      await chmod(ekkoRoot, 0o700)
      await rm(databasePath, { recursive: true })

      await expect(degradedAgent.run({
        messages: ['Repair the persistent database.'],
        modelClient: repairClient,
      })).resolves.toMatchObject({ output: { content: 'database repaired automatically' } })
      expect(vi.mocked(repairClient.create).mock.calls[0]?.[0]).toMatchObject({
        toolChoice: undefined,
      })

      const recoveredSetup = setupGlobalEkkoAgent()
      const recoveredAgent = getGlobalEkkoAgent()
      expect(recoveredSetup).not.toBe(degradedSetup)
      expect(recoveredAgent).not.toBe(degradedAgent)
      expect(recoveredSetup.database.databasePath).toBe(databasePath)
      expect(recoveredSetup.recovery.snapshot()).toMatchObject({
        status: 'ok',
        capabilities: {
          database: {
            activeStorage: 'persistent',
            targetReady: true,
            restartRequired: false,
          },
        },
      })

      await expect(recoveredAgent.run({
        messages: ['Continue after recovery.'],
        modelClient: modelClient('persistent again'),
      })).resolves.toMatchObject({ output: { content: 'persistent again' } })
      expect(recoveredAgent.status()).toMatchObject({ memoryDatabasePath: databasePath })
    } finally {
      await chmod(ekkoRoot, 0o700)
      warning.mockRestore()
    }
  })

  it('accepts a config patch when creating a Studio global agent', () => {
    const agent = createGlobalEkkoAgent({
      setup: createTestSetup(),
      memory: false,
      config: {
        compression: {
          enabled: false,
          threshold: 0.75,
          protectLastN: 8,
        },
        prompt: { instructions: ['Studio global instruction.'] },
      },
    })

    expect(agent.readConfig()).toMatchObject({
      compression: { enabled: false, threshold: 0.75, protectLastN: 8 },
      prompt: { instructions: ['Studio global instruction.'] },
    })
  })

  it('is created once and handles repeated runs through the same runtime', async () => {
    const agent = createTestAgent({ memory: false })
    const firstClient = modelClient('first')
    const secondClient = modelClient('second')

    const first = await agent.run({ messages: ['hi'], modelClient: firstClient })
    const second = await agent.run({ messages: ['again'], modelClient: secondClient })

    expect(first.output.content).toBe('first')
    expect(second.output.content).toBe('second')
    expect(agent.runCount).toBe(2)
    expect(firstClient.create).toHaveBeenCalledTimes(1)
    expect(secondClient.create).toHaveBeenCalledTimes(1)
    expect(existsSync(join(baseDirectory, '.ekko', 'skills', 'default'))).toBe(true)
  })

  it('recreates the cached runtime after settings change', async () => {
    const setup = createTestSetup()
    const createRuntime = vi.spyOn(setup, 'createRuntime')
    const agent = createGlobalEkkoAgent({ setup, memory: false })

    await agent.run({ messages: ['first'], modelClient: modelClient('first') })
    expect(createRuntime).toHaveBeenCalledTimes(1)
    setup.config.update({ logging: { maxBytes: 2_048 } })
    expect(agent.refreshRuntime()).toBe('refreshed')
    await agent.run({ messages: ['second'], modelClient: modelClient('second') })

    expect(createRuntime).toHaveBeenCalledTimes(2)
    expect(createRuntime.mock.calls[1]?.[0]?.logWriter).toMatchObject({ maxBytes: 2_048 })
  })

  it('exposes the runtime-owned boundary interrupt without creating queue policy', async () => {
    const agent = createTestAgent({ memory: false })
    let signalModelStarted!: () => void
    const modelStarted = new Promise<void>((resolve) => {
      signalModelStarted = resolve
    })
    const client: ModelClient = {
      ...modelClient('unused'),
      create: vi.fn(request => new Promise((_resolve, reject) => {
        signalModelStarted()
        request.signal?.addEventListener('abort', () => {
          const error = new Error('Run aborted.')
          error.name = 'AbortError'
          reject(error)
        }, { once: true })
      })),
    }
    let runId = ''
    const run = agent.run({
      messages: ['hi'],
      modelClient: client,
      metadata: { session_id: 'session-boundary' },
      onEvent: event => {
        if (event.type === 'run.started') runId = event.runId
      },
    })

    await modelStarted
    expect(agent.requestBoundaryInterrupt({
      sessionId: 'session-boundary',
      expectedRunId: runId,
    })).toEqual({ status: 'accepted', runId, phase: 'model' })
    await expect(run).resolves.toMatchObject({
      output: { finishReason: 'boundary_interrupt' },
    })
  })

  it('does not import Hermes profile skills when the Ekko skills root does not exist', async () => {
    const hermesRoot = join(baseDirectory, 'hermes')
    await mkdir(join(hermesRoot, 'skills', 'default-skill'), { recursive: true })
    await mkdir(join(hermesRoot, 'profiles', 'work', 'skills', 'work-skill'), { recursive: true })
    await writeFile(join(hermesRoot, 'skills', 'default-skill', 'SKILL.md'), '# Default\n')
    await writeFile(join(hermesRoot, 'profiles', 'work', 'skills', 'work-skill', 'SKILL.md'), '# Work\n')

    const agent = createTestAgent({ memory: false, profile: 'work' })
    try {
      expect(existsSync(join(baseDirectory, '.ekko', 'skills', 'default', 'default-skill'))).toBe(false)
      expect(existsSync(join(baseDirectory, '.ekko', 'skills', 'work', 'work-skill'))).toBe(false)
      expect(existsSync(join(hermesRoot, 'skills', 'default-skill', 'SKILL.md'))).toBe(true)
      expect(existsSync(join(hermesRoot, 'profiles', 'work', 'skills', 'work-skill', 'SKILL.md'))).toBe(true)
    } finally {
      agent.close()
    }
  })

  it('estimates context without incrementing the completed run count', async () => {
    const agent = createTestAgent({ memory: false })
    const client = modelClient('unused')

    const estimate = await agent.estimateContext({
      messages: ['estimate this'],
      modelClient: client,
    })

    expect(estimate.contextTokens).toBeGreaterThan(0)
    expect(agent.runCount).toBe(0)
    expect(client.create).not.toHaveBeenCalled()
  })

  it('passes per-run model defaults, metadata, and tool context', async () => {
    const agent = createTestAgent({ memory: false })
    const client = modelClient('ok')

    await agent.run({
      messages: ['hi'],
      modelClient: client,
      modelDefaults: { model: 'test-model' },
      metadata: { session_id: 'session-1' },
      toolContext: { mcpServers: { test: { command: 'node', enabled: false } } },
    })

    const request = vi.mocked(client.create).mock.calls[0]?.[0] as ModelRequest
    expect(request.model).toBe('test-model')
    expect(request.metadata).toEqual({ session_id: 'session-1' })
    expect(request.messages[0].content).toContain('## Image and File Output')
    expect(request.messages[0].content).toContain(
      `workspaceRoot: ${join(baseDirectory, '.ekko', 'workspace', 'default', 'session-1')}`,
    )
    expect(request.messages[0].content).toContain('![description](/absolute/path/image.png)')
    expect(request.messages[0].content).toContain('![description](<C:/absolute/path/image.png>)')
    expect(existsSync(join(baseDirectory, '.ekko', 'workspace', 'default', 'session-1'))).toBe(true)
  })

  it('binds skill tools to the directory provided when the agent is created', async () => {
    const agent = createTestAgent({ memory: false, profile: 'work' })
    const skillDirectory = join(baseDirectory, '.ekko', 'skills', 'work')
    await mkdir(join(skillDirectory, 'demo-skill'), { recursive: true })
    await writeFile(join(skillDirectory, 'demo-skill', 'SKILL.md'), '# Demo\nInstance-bound instructions.\n')
    let call = 0
    const client: ModelClient = {
      provider: 'test',
      requestStyle: 'custom-runtime',
      capabilities: {
        streaming: false,
        tools: true,
        vision: false,
        jsonMode: false,
        systemPrompt: true,
      },
      create: vi.fn(async () => {
        call += 1
        return call === 1
          ? {
              content: '',
              toolCalls: [{ id: 'skill-call', name: 'skill_list', arguments: {} }],
              finishReason: 'tool_calls',
            }
          : { content: 'done' }
      }),
      stream: vi.fn(),
    }
    try {
      const result = await agent.run({ messages: ['find skills'], modelClient: client })

      expect(result.messages.find(message => message.role === 'tool')?.content).toContain('demo-skill')
      expect(agent.status()).toMatchObject({ skillDirectory })
    } finally {
      agent.close()
    }
  })

  it('uses the persistent Ekko database initialized by setup', async () => {
    const agent = createTestAgent()
    try {
      await agent.run({
        messages: ['hello'],
        modelClient: modelClient('ok'),
        metadata: { session_id: 'session-1' },
      })

      expect(agent.status()).toMatchObject({
        memoryEnabled: true,
        memoryDatabasePath: join(baseDirectory, '.ekko', 'ekko.db'),
      })
      expect(existsSync(join(baseDirectory, '.ekko', 'ekko.db'))).toBe(true)
    } finally {
      agent.close()
    }
  })

  it('initializes persistent Ekko memory in production', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const agent = createGlobalEkkoAgent({ setup: createTestSetup() })
    try {
      const result = await agent.run({
        messages: ['hello'],
        modelClient: modelClient('ok'),
        metadata: { session_id: 'session-1' },
      })

      expect(result.output.content).toBe('ok')
      expect(agent.status()).toMatchObject({
        memoryEnabled: true,
        memoryDatabasePath: join(baseDirectory, '.ekko', 'ekko.db'),
        dataDirectory: join(baseDirectory, '.ekko'),
        configDirectory: join(baseDirectory, '.ekko', 'config'),
        configPath: join(baseDirectory, '.ekko', 'config', 'config.json'),
        skillDirectory: join(baseDirectory, '.ekko', 'skills', 'default'),
        logDirectory: join(baseDirectory, '.ekko', 'logs', 'default'),
        workspaceDirectory: join(baseDirectory, '.ekko', 'workspace', 'default'),
        logFilePath: join(baseDirectory, '.ekko', 'logs', 'default', 'ekko-agent.jsonl'),
      })
      expect(existsSync(join(baseDirectory, '.ekko', 'config', 'config.json'))).toBe(true)
      expect(existsSync(join(baseDirectory, '.ekko', 'skills'))).toBe(true)
      expect(existsSync(join(baseDirectory, '.ekko', 'workspace'))).toBe(true)
      expect(existsSync(join(baseDirectory, '.ekko', 'logs', 'default', 'ekko-agent.jsonl'))).toBe(true)
      expect(existsSync(join(baseDirectory, '.ekko', 'ekko.db'))).toBe(true)
    } finally {
      agent.close()
    }
  })

  it('lets the runtime own compact model request logs', async () => {
    const agent = createTestAgent({ memory: false, profile: 'work' })
    try {
      await agent.run({
        messages: ['diagnose this'],
        model: 'test-model',
        modelClient: modelClient('done'),
        logContext: {
          profile: 'work',
          sessionId: 'session-1',
          turnId: 'turn-1',
        },
      })

      const reader = new EkkoFileLogReader({
        directory: join(baseDirectory, '.ekko', 'logs', 'work'),
      })
      expect(reader.query({ sessionId: 'session-1' })).toMatchObject([
        {
          category: 'model',
          event: 'model.request',
          profile: 'work',
          level: 'info',
          sessionId: 'session-1',
          turnId: 'turn-1',
          data: expect.objectContaining({
            status: 'completed',
            provider: 'test',
            model: 'test-model',
            messageCount: 2,
          }),
        },
      ])
      expect('writeLog' in agent).toBe(false)
    } finally {
      agent.close()
    }
  })

  it('injects compact request logging into isolated runtimes', async () => {
    const agent = createTestAgent({ memory: false, profile: 'work' })
    try {
      await agent.runIsolated(
        {
          modelClient: modelClient('compressed'),
          toolsEnabled: false,
          skillsEnabled: false,
          maxSteps: 1,
          modelDefaults: {
            model: 'summary-model',
          },
        },
        {
          messages: ['compress this history'],
          memoryEnabled: false,
          metadata: {
            purpose: 'context-compression',
            session_id: 'session-1',
          },
          logContext: {
            profile: 'work',
            sessionId: 'session-1',
          },
        },
      )

      const reader = new EkkoFileLogReader({
        directory: join(baseDirectory, '.ekko', 'logs', 'work'),
      })
      expect(reader.query({ sessionId: 'session-1' })).toMatchObject([
        {
          category: 'model',
          event: 'model.request',
          profile: 'work',
          sessionId: 'session-1',
          data: expect.objectContaining({
            status: 'completed',
            purpose: 'context-compression',
            provider: 'test',
            model: 'summary-model',
          }),
        },
      ])
    } finally {
      agent.close()
    }
  })
})
