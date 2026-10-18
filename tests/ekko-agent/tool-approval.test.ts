import { readFile, writeFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AgentToolRegistry,
  AgentRuntime,
  EkkoToolApprovalService,
  setupEkkoAgent,
  toolApprovalRequirement,
  type AgentTool,
  type AgentToolApprovalChoice,
  type AgentToolApprovalRequest,
  type EkkoAgentSetup,
  type ModelClient,
  type ModelRequest,
} from '../../packages/ekko-agent/src'

let baseDirectory = ''
let setup: EkkoAgentSetup | undefined

beforeEach(async () => {
  baseDirectory = await mkdtemp(join(tmpdir(), 'ekko-tool-approval-'))
})

afterEach(async () => {
  setup?.close()
  setup = undefined
  await rm(baseDirectory, { recursive: true, force: true })
})

function createService(): EkkoToolApprovalService {
  setup = setupEkkoAgent({ baseDirectory })
  return setup.toolApprovals
}

describe('Ekko tool approvals', () => {
  it.each(['once', 'session', 'always'] as const)('delivers %s approval to the next model request without breaking JSON output', async (choice) => {
    const service = createService()
    const requestToolApproval = vi.fn(async () => choice)
    const registry = new AgentToolRegistry(service.authorize)
    registry.register({
      definition: { name: 'code_exec', parameters: { type: 'object', properties: {} } },
      execute: async () => ({ ok: true, content: '{"output":"real result","exitCode":0}' }),
    })
    const create = vi.fn(async (request: ModelRequest) => {
      const result = request.messages.find(message => message.role === 'tool')
      if (!result) return { content: '', toolCalls: [{ id: 'call-1', name: 'code_exec', arguments: { language: 'python' } }] }
      expect(JSON.parse(result.content)).toEqual({
        output: 'real result', exitCode: 0,
        authorization: { approved: true, scope: choice, key: 'code_exec:python' },
      })
      return { content: 'done' }
    })
    const modelClient = {
      provider: 'test', requestStyle: 'custom-runtime',
      capabilities: { streaming: false, tools: true, vision: false, jsonMode: false, systemPrompt: true },
      create, stream: vi.fn(),
    } satisfies ModelClient
    const runtime = new AgentRuntime({ modelClient, tools: registry })
    const result = await runtime.run({
      messages: ['Read current state'],
      toolContext: { sessionId: 'approval-test', requestToolApproval },
    })
    expect(result.output.content).toBe('done')
    expect(create).toHaveBeenCalledTimes(2)
    expect(requestToolApproval).toHaveBeenCalledTimes(1)
    if (choice === 'always') {
      const reloaded = new EkkoToolApprovalService({ configPath: setup!.layout.configPath })
      registry.setAuthorizer(reloaded.authorize)
      const again = await registry.execute('code_exec', { language: 'python' })
      expect(JSON.parse(again.content).authorization.scope).toBe('always')
    }
  })

  it('retains approval on failed execution and multimodal results, but leaves safe reads untouched', async () => {
    const registry = new AgentToolRegistry(async () => ({ approved: true, scope: 'always', key: 'code_exec:node' }))
    const original = { ok: false, content: 'failure', error: 'failure', contentParts: [{ type: 'image' as const, data: 'aGVsbG8=', mimeType: 'image/png' }] }
    registry.register({ definition: { name: 'code_exec', parameters: {} }, execute: async () => original })
    const failed = await registry.execute('code_exec', {})
    expect(failed.ok).toBe(false)
    expect(failed.error).toBe('failure')
    expect(failed.content).toContain('"scope":"always"')
    expect(failed.contentParts?.[0]).toEqual(original.contentParts[0])
    expect(failed.contentParts?.at(-1)).toEqual({ type: 'text', text: expect.stringContaining('"scope":"always"') })
    registry.setAuthorizer(async () => ({ approved: true, scope: 'safe' }))
    expect(await registry.execute('code_exec', {})).toBe(original)
  })

  it('does not lose a granted approval when the executor throws', async () => {
    const registry = new AgentToolRegistry(async () => ({ approved: true, scope: 'once', key: 'code_exec:python' }))
    registry.register({ definition: { name: 'code_exec', parameters: {} }, execute: async () => { throw new Error('execution failed') } })
    const result = await registry.execute('code_exec', {})
    expect(result.ok).toBe(false)
    expect(result.error).toBe('execution failed')
    expect(result.content).toContain('"scope":"once"')
  })

  it('classifies arbitrary code and destructive terminal commands while leaving safe commands alone', () => {
    expect(toolApprovalRequirement('code_exec', {
      language: 'python',
      code: 'print("hello")',
    })).toMatchObject({
      key: 'code_exec:python',
      description: 'executes arbitrary Python code',
    })
    expect(toolApprovalRequirement('terminal_exec', {
      command: 'rm',
      args: ['-rf', 'build'],
    })).toMatchObject({
      key: 'terminal:delete',
    })
    expect(toolApprovalRequirement('terminal_exec', {
      command: 'git',
      args: ['reset', '--hard', 'HEAD'],
    })).toMatchObject({
      key: 'terminal:git-destructive',
    })
    expect(toolApprovalRequirement('terminal_exec', {
      command: 'env',
      args: ['MODE=test', 'rm', '-rf', 'build'],
    })).toMatchObject({
      key: 'terminal:delete',
    })
    expect(toolApprovalRequirement('terminal_exec', {
      command: 'npm',
      args: ['test'],
    })).toBeUndefined()
    expect(toolApprovalRequirement('ekko_repair_database', {
      strategy: 'rebuild',
      confirmed: true,
    })).toMatchObject({
      key: 'ekko:database-rebuild',
      description: 'quarantines and rebuilds the persistent Ekko database',
    })
    expect(toolApprovalRequirement('ekko_repair_database', {
      strategy: 'retry',
    })).toBeUndefined()
    expect(toolApprovalRequirement('read_file', {
      path: 'README.md',
    })).toBeUndefined()
  })

  it('allows only the current call for a once decision', async () => {
    const service = createService()
    const requests: AgentToolApprovalRequest[] = []
    const requestToolApproval = vi.fn(async (request: AgentToolApprovalRequest): Promise<AgentToolApprovalChoice> => {
      requests.push(request)
      return 'once'
    })

    await expect(service.authorize('code_exec', {
      language: 'node',
      code: 'console.log("one")',
    }, {
      sessionId: 'session-1',
      requestToolApproval,
    })).resolves.toMatchObject({ approved: true, scope: 'once' })
    await expect(service.authorize('code_exec', {
      language: 'node',
      code: 'console.log("two")',
    }, {
      sessionId: 'session-1',
      requestToolApproval,
    })).resolves.toMatchObject({ approved: true, scope: 'once' })

    expect(requestToolApproval).toHaveBeenCalledTimes(2)
    expect(requests[0]).toMatchObject({
      toolName: 'code_exec',
      key: 'code_exec:node',
      choices: ['once', 'session', 'always', 'deny'],
      allowPermanent: true,
    })
  })

  it('keeps a session approval in memory and scopes it to one chat session', async () => {
    const service = createService()
    const requestToolApproval = vi.fn(async (): Promise<AgentToolApprovalChoice> => 'session')

    await expect(service.authorize('terminal_exec', {
      command: 'rm',
      args: ['old.txt'],
    }, {
      sessionId: 'session-1',
      requestToolApproval,
    })).resolves.toMatchObject({ approved: true, scope: 'session' })
    await expect(service.authorize('terminal_exec', {
      command: 'rm',
      args: ['another.txt'],
    }, {
      sessionId: 'session-1',
      requestToolApproval,
    })).resolves.toMatchObject({ approved: true, scope: 'session' })
    await expect(service.authorize('terminal_exec', {
      command: 'rm',
      args: ['third.txt'],
    }, {
      sessionId: 'session-2',
      requestToolApproval,
    })).resolves.toMatchObject({ approved: true, scope: 'session' })

    expect(requestToolApproval).toHaveBeenCalledTimes(2)
    expect(service.sessionAllowlist('session-1')).toEqual(['terminal:delete'])
    expect(service.sessionAllowlist('session-2')).toEqual(['terminal:delete'])
  })

  it('writes permanent approvals into the global config and reloads them', async () => {
    const service = createService()
    const requestToolApproval = vi.fn(async (): Promise<AgentToolApprovalChoice> => 'always')
    const initialConfig = JSON.parse(await readFile(setup!.layout.configPath, 'utf8'))
    initialConfig.futureSetting = { preserved: true }
    await writeFile(setup!.layout.configPath, `${JSON.stringify(initialConfig, null, 2)}\n`)

    await expect(service.authorize('code_exec', {
      language: 'python',
      code: 'print("persist")',
    }, {
      sessionId: 'session-1',
      requestToolApproval,
    })).resolves.toMatchObject({ approved: true, scope: 'always' })

    const config = JSON.parse(await readFile(setup!.layout.configPath, 'utf8'))
    expect(config.tools.approvals).toMatchObject({
      enabled: true,
      permanentAllow: ['code_exec:python'],
    })
    expect(config.futureSetting).toEqual({ preserved: true })

    const reloaded = new EkkoToolApprovalService({ configPath: setup!.layout.configPath })
    await expect(reloaded.authorize('code_exec', {
      language: 'python',
      code: 'print("no prompt")',
    }, {
      sessionId: 'session-2',
      requestToolApproval,
    })).resolves.toMatchObject({ approved: true, scope: 'always' })
    expect(requestToolApproval).toHaveBeenCalledTimes(1)
  })

  it('preserves existing language grants and safety settings when a replacement runtime reloads approvals', async () => {
    createService()
    const configPath = setup!.layout.configPath
    const initialConfig = JSON.parse(await readFile(configPath, 'utf8'))
    initialConfig.tools.approvals = {
      enabled: true,
      timeoutMs: 120000,
      permanentAllow: ['code_exec:node'],
    }
    initialConfig.futureSetting = { preserved: true }
    await writeFile(configPath, `${JSON.stringify(initialConfig, null, 2)}\n`)
    const service = new EkkoToolApprovalService({ configPath })
    await expect(service.authorize('code_exec', { language: 'python' }, {
      requestToolApproval: vi.fn(async () => 'always'),
    })).resolves.toMatchObject({ approved: true, scope: 'always' })
    const expected = structuredClone(initialConfig)
    expected.tools.approvals.permanentAllow = ['code_exec:node', 'code_exec:python']
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual(expected)

    const reloaded = new EkkoToolApprovalService({ configPath })
    const requestToolApproval = vi.fn(async (): Promise<AgentToolApprovalChoice> => 'deny')
    const registry = new AgentToolRegistry(reloaded.authorize)
    registry.register({
      definition: { name: 'code_exec', parameters: {} },
      execute: async () => ({ ok: true, content: '{"output":"fixture"}' }),
    })
    for (const language of ['node', 'python']) {
      const result = await registry.execute('code_exec', { language }, { requestToolApproval })
      expect(JSON.parse(result.content).authorization).toEqual({
        approved: true, scope: 'always', key: `code_exec:${language}`,
      })
    }
    expect(requestToolApproval).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual(expected)
    await expect(reloaded.authorize('terminal_exec', { command: 'rm', args: ['fixture'] }))
      .resolves.toMatchObject({ approved: false, scope: 'denied' })
  })

  it('fails closed when approval is denied or no interactive handler exists', async () => {
    const service = createService()
    await expect(service.authorize('terminal_exec', {
      command: 'sudo',
      args: ['reboot'],
    }, {
      sessionId: 'session-1',
      requestToolApproval: vi.fn(async () => 'deny'),
    })).resolves.toMatchObject({
      approved: false,
      scope: 'denied',
      error: expect.stringContaining('User denied'),
    })

    await expect(service.authorize('code_exec', {
      language: 'node',
      code: 'console.log("blocked")',
    }, {
      sessionId: 'background-session',
    })).resolves.toMatchObject({
      approved: false,
      scope: 'denied',
      error: expect.stringContaining('no interactive approval handler'),
    })
  })

  it('blocks the registered tool before execution when authorization is denied', async () => {
    const service = createService()
    const execute = vi.fn(async () => ({ ok: true, content: 'should not run' }))
    const tool: AgentTool = {
      definition: {
        name: 'terminal_exec',
        description: 'test terminal',
        parameters: { type: 'object', properties: {} },
      },
      execute,
    }
    const registry = new AgentToolRegistry(service.authorize)
    registry.register(tool)

    await expect(registry.execute('terminal_exec', {
      command: 'rm',
      args: ['-rf', 'build'],
    }, {
      sessionId: 'session-1',
      requestToolApproval: vi.fn(async () => 'deny'),
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('User denied'),
      data: {
        authorization: {
          scope: 'denied',
          key: 'terminal:delete',
        },
      },
    })
    expect(execute).not.toHaveBeenCalled()
  })
})
