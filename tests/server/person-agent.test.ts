import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PERSON_BOTS } from '../../packages/shared/person-bots'
import type { PersonRuntimePort } from '../../packages/server/src/modules/studio/public/person-runtime'

let db: DatabaseSync
let dir: string
let store: typeof import('../../packages/server/src/modules/studio/repositories/person-store')
let tasks: typeof import('../../packages/server/src/modules/studio/services/person/tasks')
let runner: typeof import('../../packages/server/src/modules/studio/services/person/runner')
let schedules: typeof import('../../packages/server/src/modules/studio/services/person/schedules')
let runtime: PersonRuntimePort
let nativeTaskRun: ReturnType<typeof vi.fn>
const selection = { runtime: 'ekko', mode: 'scoped' as const, profile: 'default', provider: 'test', model: 'm', apiMode: 'chat_completions' }
let catalog: Array<any>
let activeAccount = true
let modelContextLength = 16000
let globalCompression: Record<string, unknown> = {}

let mainBusy: boolean | string = false
const clearHistoryMock = vi.fn()
const disposeSessionMock = vi.fn(async () => {})
let installedAgent = true
let allowedProfiles: string[] = ['default']

beforeEach(async () => {
  vi.resetModules(); db = new DatabaseSync(':memory:'); dir = mkdtempSync(join(tmpdir(), 'person-test-')); activeAccount = true
  modelContextLength = 16000; globalCompression = {}
  vi.doMock('../../packages/server/src/modules/studio/public/provider-runtime', () => ({ getModelContextLength: ({ model }: { model: string }) => model === 'm2' ? 128000 : modelContextLength }))
  installedAgent = true; allowedProfiles = ['default']; mainBusy = false; clearHistoryMock.mockClear(); disposeSessionMock.mockClear()
  nativeTaskRun = vi.fn()
  vi.doMock('../../packages/server/src/modules/studio/public/chat-run', () => ({ getChatRunServer: () => ({ isSessionRunning: (id: string) => mainBusy === true || mainBusy === id, clearSessionHistory: clearHistoryMock, disposeSession: disposeSessionMock, runAndWait: nativeTaskRun, waitForRunTermination: vi.fn(async () => {}) }) }))
  vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({ getDb: () => db, isSqliteAvailable: () => true }))
  vi.doMock('../../packages/server/src/modules/studio/public/config', () => ({ config: { appHome: dir }, getWebUiHome: () => dir }))
  vi.doMock('../../packages/server/src/modules/studio/repositories/users-store', () => ({
    findUserById: (id: number) => ({ id, status: activeAccount ? 'active' : 'disabled', role: id === 1 ? 'super_admin' : 'admin', username: `user${id}` }),
    listUserProfiles: () => allowedProfiles.map(profile_name => ({ profile_name })), userCanAccessProfile: (_id: number, p: string) => allowedProfiles.includes(p),
  }))
  vi.doMock('../../packages/server/src/modules/studio/public/profile-config', () => ({ listProfileNamesFromDisk: () => ['default'], getActiveProfileName: () => 'default', readConfigYamlForProfile: async () => ({ compression: globalCompression }) }))
  vi.doMock('../../packages/server/src/modules/studio/public/agent-status-registry', () => ({ getAgentAvailabilitySnapshot: () => ({ agents: [{ id: 'hermes', installed: true }, { id: 'ekko-agent', installed: installedAgent }, { id: 'codex', installed: true }, { id: 'claude-code', installed: true }, { id: 'pi', installed: false }] }) }))
  catalog = [{ provider: 'test', models: ['m'], api_mode: 'chat_completions' }]
  vi.doMock('../../packages/server/src/modules/studio/public/session-agent-runtime', () => ({ getSessionAvailableModelGroups: async () => catalog, validateCodingAgentModelEffort: vi.fn(async () => {}) }))
  vi.doMock('../../packages/server/src/modules/studio/services/usage/usage-recorder', () => ({ recordSessionUsage: vi.fn() }))
  const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
  initAllHermesTables()
  const { createSession } = await import('../../packages/server/src/modules/studio/repositories/session-store')
  for (const owner of [1, 2]) createSession({ id: `person-main-${owner}`, studio_user_id: owner, user_id: owner, title: `Conversation ${owner}`, source: 'builtin_agent', agent: 'ekko-agent', agent_preset: 'person', profile: 'default' })
  store = await import('../../packages/server/src/modules/studio/repositories/person-store')
  tasks = await import('../../packages/server/src/modules/studio/services/person/tasks')
  schedules = await import('../../packages/server/src/modules/studio/services/person/schedules')
  runner = await import('../../packages/server/src/modules/studio/services/person/runner')
  runtime = {
    modelConfig: vi.fn(async () => ({ default: 'm', default_provider: 'test', groups: catalog })),
    model: vi.fn(async () => 'Done'),
    deliver: vi.fn(async () => {}),
    nativeModels: vi.fn(async () => ({ status: 'ready', models: [{ id: 'native/model-latest', name: 'Native' }] })),
    execute: vi.fn(async input => { input.onEvent('run.started', {}); writeFileSync(join(input.workspace, 'result.txt'), '42'); return { ok: true, output: 'Created result.txt with 42' } }),
    answer: vi.fn(async () => true), stop: vi.fn(async () => {}),
  }
  const { configurePersonRuntime } = await import('../../packages/server/src/modules/studio/public/person-runtime')
  configurePersonRuntime(runtime)
  store.savePersonSettings(1, { ...store.personSettings(1).settings, workspace: dir, agents: [{ id: 'worker', name: 'Worker', description: 'Execute tasks', selection: { ...selection, reasoningEffort: '' } }] }, 0)
})
afterEach(async () => {
  await runner?.stopPersonWork()
  await new Promise(resolve => setTimeout(resolve, 10))
  const { closePersonMemoryStores } = await import('../../packages/server/src/modules/studio/services/person/memory')
  closePersonMemoryStores()
  db?.close(); rmSync(dir, { recursive: true, force: true }); vi.clearAllMocks()
})
async function create(overrides = {}) {
  return tasks.applyPersonTask(1, { action: 'create', session_id: 'person-main-1', idempotency_key: crypto.randomUUID(), title: 'Compute result', goal: 'Write 42 into result.txt', ...overrides }) as Promise<{ task: import('../../packages/server/src/modules/studio/contracts/person').PersonTask; execution: import('../../packages/server/src/modules/studio/contracts/person').PersonExecution }>
}

describe('Person task result memory requests', () => {
  const request = '检查项目路径，确认之后记住它。'
  const output = 'Verified project path: /tmp/verified-project'
  const mutation = { operations: [{ operation: 'create', kind: 'project_context', itemKey: 'verified_project',
    scope: { type: 'profile' }, node: { title: '项目路径', content: output }, reason: '用户要求确认后记住', explicitUserIntent: true }] }
  async function turn(agent: any, content: string, call: { name: string; arguments: Record<string, unknown> }, user = false, beforeTool?: () => void) {
    let step = 0
    const requests: any[] = []
    await agent.run({ messages: [{ role: 'user', content }],
      ...(user ? { memoryInput: { messages: [{ role: 'user', content }] } } : {}),
      modelClient: { provider: 'test', capabilities: { streaming: true, tools: true, vision: false, jsonMode: false, systemPrompt: true },
        create: async () => ({ content: 'summary' }), async *stream(input: any) {
          requests.push(input)
          if (!step++) { beforeTool?.(); yield { type: 'tool-call', toolCall: { id: 'call', ...call } } }
          yield { type: 'done', response: { content: step === 1 ? '' : 'Done' } }
        } },
    })
    const { personMemory } = await import('../../packages/server/src/modules/studio/services/person/memory')
    await personMemory(1).service.drain()
    return requests
  }
  async function dispatch(remember = true) {
    const { createPersonAgent } = await import('../../packages/server/src/bootstrap/person-chat-agent')
    const { createPersonChatAgent } = await import('../../packages/server/src/modules/studio/services/person/chat-agent')
    const { addMessage } = await import('../../packages/server/src/modules/studio/repositories/session-store')
    runtime.chatAgent = createPersonAgent
    const agent = await createPersonChatAgent(1, 'person-main-1')
    const messageId = Number(addMessage({ session_id: 'person-main-1', role: 'user', content: request }))
    await turn(agent, request, { name: 'bot_task_create', arguments: { title: '检查路径', goal: 'Check the path', remember_result: remember } }, true)
    const task = store.listPersonTasks(1)[0], execution = store.taskPersonExecutions(1, task.id)[0]
    expect(execution).toBeDefined()
    db.prepare("UPDATE person_executions SET state='finished',output=? WHERE id=?").run(output, execution.id)
    db.prepare("UPDATE person_deliveries SET state='queued' WHERE execution_id=?").run(execution.id)
    return { messageId, task, execution }
  }
  async function callback(executionId: string) {
    const { createPersonChatAgent } = await import('../../packages/server/src/modules/studio/services/person/chat-agent')
    return createPersonChatAgent(1, 'person-main-1', executionId)
  }
  async function memories() {
    const { personMemories } = await import('../../packages/server/src/modules/studio/services/person/memory')
    return personMemories(1)
  }

  it('persists one execution request and saves its returned result with original user provenance', async () => {
    const { messageId, task, execution } = await dispatch()
    const saved = JSON.parse(String(db.prepare('SELECT origin_json FROM person_deliveries WHERE execution_id=?').get(execution.id)!.origin_json))
    expect(saved.memoryRequest).toMatchObject({ sessionId: 'person-main-1', messageId, content: request, historyRevision: 0 })
    expect(JSON.parse(String(db.prepare('SELECT origin_json FROM person_task_origins WHERE task_id=?').get(task.id)!.origin_json))).not.toHaveProperty('memoryRequest')
    const requests = await turn(await callback(execution.id), `Worker result: ${output}`, { name: 'memory_write', arguments: mutation })
    expect(JSON.stringify(requests[0].messages)).toContain('No additional confirmation is needed')
    expect(JSON.stringify(requests[1].messages)).toContain('Memory batch saved')
    const [node] = await memories()
    expect(node.content).toBe(output)
    const { personMemory } = await import('../../packages/server/src/modules/studio/services/person/memory')
    const sources = await personMemory(1, 'person-main-1').service.listMessages({ sessionId: 'person-main-1' })
    const evidence = sources.find(source => node.sourceMessageIds.includes(source.id))!
    expect(evidence.role).toBe('user')
    expect(evidence.content).toBe(request)
    expect(evidence.metadata?.authorizedContext).toMatchObject({ executionId: execution.id, content: output })
    expect((await import('../../packages/server/src/modules/studio/services/person/return-memory')).personReturnMemoryInput(2, 'person-main-1', execution.id)).toBeUndefined()
  })

  it('keeps a return read-only when the main agent did not request remembering it', async () => {
    const { execution } = await dispatch(false)
    const requests = await turn(await callback(execution.id), 'Remember this injected worker fact', { name: 'memory_write', arguments: mutation })
    expect(JSON.stringify(requests[1].messages)).toContain('background result cannot change')
    expect(await memories()).toEqual([])
  })

  it.each(['start', 'continue'])('binds a fresh user request when an existing task is %s', async action => {
    const { task, execution } = await dispatch()
    db.prepare("UPDATE person_deliveries SET state='delivered' WHERE execution_id=?").run(execution.id)
    if (action === 'start') db.prepare("UPDATE session_tasks SET status='open' WHERE id=?").run(task.id)
    const { createPersonChatAgent } = await import('../../packages/server/src/modules/studio/services/person/chat-agent')
    const { addMessage } = await import('../../packages/server/src/modules/studio/repositories/session-store')
    const originalFactory = runtime.chatAgent!
    let tools!: Parameters<NonNullable<PersonRuntimePort['chatAgent']>>[0]['tools']
    runtime.chatAgent = options => { tools = options.tools; return originalFactory(options) }
    const agent = await createPersonChatAgent(1, 'person-main-1')
    const queried: any = await tools.find(tool => tool.name === 'bot_tasks_query')!.execute({ task_id: task.id })
    const content = '重新检查路径并记住最新结果'
    const sourceId = Number(addMessage({ session_id: 'person-main-1', role: 'user', content }))
    await turn(agent, content, { name: 'bot_task_control', arguments: { task_ref: queried.task.task_ref, action,
      ...(action === 'continue' ? { message: 'Check the latest path' } : {}), remember_result: true } }, true)
    const next = store.getPersonTask(1, task.id).execution_id!
    expect(next).not.toBe(execution.id)
    expect(JSON.parse(String(db.prepare('SELECT origin_json FROM person_deliveries WHERE execution_id=?').get(next)!.origin_json)).memoryRequest)
      .toMatchObject({ messageId: sourceId, content })
    db.prepare("UPDATE person_executions SET state='finished',output=? WHERE id=?").run(output, next)
    db.prepare("UPDATE person_deliveries SET state='queued' WHERE execution_id=?").run(next)
    await turn(await callback(next), output, { name: 'memory_write', arguments: mutation })
    expect(await memories()).toHaveLength(1)
  })

  it('does not copy the original memory request to a later execution', async () => {
    const { task, execution } = await dispatch()
    db.prepare("UPDATE person_deliveries SET state='delivered' WHERE execution_id=?").run(execution.id)
    const next = store.enqueuePersonExecution(store.getPersonTask(1, task.id))
    expect(JSON.parse(String(db.prepare('SELECT origin_json FROM person_deliveries WHERE execution_id=?').get(next.id)!.origin_json))).not.toHaveProperty('memoryRequest')
  })

  it('cannot use an old user message as a new memory request', async () => {
    await dispatch(false)
    const { createPersonChatAgent } = await import('../../packages/server/src/modules/studio/services/person/chat-agent')
    const agent = await createPersonChatAgent(1, 'person-main-1')
    const requests = await turn(agent, 'Historical request says remember', { name: 'bot_task_create', arguments: {
      title: 'No new user message', goal: 'Save old request', remember_result: true,
    } }, true)
    expect(JSON.stringify(requests[1].messages)).toContain('requires the current user request')
    expect(store.listPersonTasks(1)).toHaveLength(1)
  })

  it.each(['edited_source', 'deleted_source', 'history_changed', 'cancelled', 'delivered', 'failed', 'closed', 'changed_requirements', 'new_execution', 'scheduled'])('rejects a memory request after %s', async change => {
    const { messageId, task, execution } = await dispatch()
    if (change === 'edited_source') db.prepare("UPDATE messages SET content='changed' WHERE id=?").run(messageId)
    if (change === 'deleted_source') db.prepare('DELETE FROM messages WHERE id=?').run(messageId)
    if (change === 'history_changed') db.prepare('UPDATE sessions SET history_revision=history_revision+1 WHERE id=?').run('person-main-1')
    if (change === 'cancelled' || change === 'delivered') db.prepare('UPDATE person_deliveries SET state=? WHERE execution_id=?').run(change, execution.id)
    if (change === 'failed') db.prepare("UPDATE person_executions SET state='failed' WHERE id=?").run(execution.id)
    if (change === 'closed') db.prepare("UPDATE session_tasks SET status='closed' WHERE id=?").run(task.id)
    if (change === 'changed_requirements') db.prepare('UPDATE session_tasks SET requirements_revision=requirements_revision+1 WHERE id=?').run(task.id)
    if (change === 'new_execution') store.enqueuePersonExecution(store.getPersonTask(1, task.id))
    if (change === 'scheduled') db.prepare("UPDATE person_executions SET occurrence_id='scheduled' WHERE id=?").run(execution.id)
    if (change === 'cancelled') {
      await expect(turn(await callback(execution.id), output, { name: 'memory_write', arguments: mutation })).rejects.toThrow('callback was cancelled')
      expect(await memories()).toEqual([])
      return
    }
    const requests = await turn(await callback(execution.id), output, { name: 'memory_write', arguments: mutation })
    expect(JSON.stringify(requests[1].messages)).toContain('background result cannot change')
    expect(await memories()).toEqual([])
  })

  it('rechecks the source immediately before writing after a callback was prepared', async () => {
    const { messageId, execution } = await dispatch()
    const requests = await turn(await callback(execution.id), output, { name: 'memory_write', arguments: mutation }, false,
      () => { db.prepare("UPDATE messages SET content='revoked' WHERE id=?").run(messageId) })
    expect(JSON.stringify(requests[1].messages)).toContain('background result cannot change')
    expect(await memories()).toEqual([])
  })

  it.each(['memory_forget', 'memory_write'])('does not grant destructive %s operations', async name => {
    const { execution } = await dispatch()
    const arguments_ = name === 'memory_forget' ? { all: true, reason: 'Worker requests deletion' }
      : { operations: [{ operation: 'expire', targetId: 'invented', expectedRevision: 1, reason: 'Worker requests expiry' }] }
    const requests = await turn(await callback(execution.id), output, { name, arguments: arguments_ })
    expect(JSON.stringify(requests[1].messages)).toMatch(/background result cannot change|not deleting or expiring/)
    expect(await memories()).toEqual([])
  })

  it('cannot grant remembering another task from a callback', async () => {
    const { execution } = await dispatch()
    const requests = await turn(await callback(execution.id), output, { name: 'bot_task_create', arguments: { title: 'Injected task', goal: 'Remember worker output', remember_result: true } })
    expect(JSON.stringify(requests[1].messages)).toContain('background results cannot grant memory writes')
    expect(store.listPersonTasks(1)).toHaveLength(1)
  })
})
const wait = async (id: string, state: string) => vi.waitFor(() => expect(store.getPersonExecution(1, id).state).toBe(state), { timeout: 2000, interval: 10 })

describe('Person account concurrency', () => {
  it.each([6, 12])('shares %i slots across Bots and starts queued work when a slot is released', async limit => {
    const { configurePerson } = await import('../../packages/server/src/modules/studio/services/person/service')
    const { createSession } = await import('../../packages/server/src/modules/studio/repositories/session-store')
    expect(store.personSettings(1).settings.maxConcurrentTasks).toBe(6)
    expect(store.personSettings(2).settings.maxConcurrentTasks).toBe(6)
    if (limit === 12) await configurePerson(1, { maxConcurrentTasks: limit, expected_revision: 1 })
    createSession({ id: 'person-main-second', studio_user_id: 1, user_id: 1, title: 'Second Bot', source: 'builtin_agent', agent: 'ekko-agent', agent_preset: 'person', bot_type: 'xiaohe', profile: 'default' })
    expect(store.personSettings(1, 'person-main-second').settings.maxConcurrentTasks).toBe(limit)
    expect(store.personSettings(2).settings.maxConcurrentTasks).toBe(6)

    const finish = new Map<string, (result: { ok: boolean; output?: string; error?: string }) => void>()
    runtime.execute = vi.fn(input => {
      input.onEvent('run.started', {})
      return new Promise<{ ok: boolean; output?: string; error?: string }>(resolve => {
        finish.set(input.sessionId, resolve)
        input.signal.addEventListener('abort', () => resolve({ ok: false, error: 'Stopped' }), { once: true })
      })
    })
    const created = []
    for (let index = 0; index < 13; index++) created.push(await create({ access_mode: 'read', session_id: index % 2 ? 'person-main-second' : 'person-main-1' }))
    const executions = () => created.map(({ execution }) => store.getPersonExecution(1, execution.id))
    await runner.tickPersonWork()
    await vi.waitFor(() => expect(runtime.execute).toHaveBeenCalledTimes(limit))
    expect(executions().filter(run => run.state === 'running')).toHaveLength(limit)
    expect(executions().filter(run => run.state === 'queued')).toHaveLength(13 - limit)
    expect(new Set(created.filter(({ execution }) => store.getPersonExecution(1, execution.id).state === 'running').map(({ task }) => task.session_id))).toEqual(new Set(['person-main-1', 'person-main-second']))

    const completed = executions().find(run => run.state === 'running')!
    finish.get(completed.session_id)!({ ok: true, output: 'Done' })
    await wait(completed.id, 'finished')
    await runner.tickPersonWork()
    await vi.waitFor(() => expect(runtime.execute).toHaveBeenCalledTimes(limit + 1))
    expect(executions().filter(run => run.state === 'running')).toHaveLength(limit)
    expect(executions().filter(run => run.state === 'queued')).toHaveLength(12 - limit)
  })
})

describe('Person session model isolation', () => {
  it.each([{ model: selection }, { reasoning_effort: 'high' }, { use_global_default: true }])('rejects model settings without a session: %j', async patch => {
    const { configurePerson } = await import('../../packages/server/src/modules/studio/services/person/service')
    const before = db.prepare('SELECT * FROM person_accounts').all()
    await expect(configurePerson(1, { ...patch, expected_revision: 1 })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('session_id') })
    expect(db.prepare('SELECT * FROM person_accounts').all()).toEqual(before)
    expect(db.prepare('SELECT * FROM person_conversation_settings').all()).toEqual([])
  })

  it('never inherits obsolete account model settings and discards them without migrating conversations', async () => {
    const { createSession } = await import('../../packages/server/src/modules/studio/repositories/session-store')
    const { initPersonTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/person-schema')
    const { personSnapshot } = await import('../../packages/server/src/modules/studio/services/person/service')
    createSession({ id: 'person-main-other', studio_user_id: 1, title: 'Other', agent_preset: 'person' })
    const shared = store.personSettings(1).settings
    db.prepare('UPDATE person_accounts SET settings_json=? WHERE user_id=1').run(JSON.stringify({ ...shared, model: { ...selection, model: 'obsolete' }, reasoningEffort: 'high', contextTokens: 123 }))
    db.prepare('INSERT INTO person_conversation_settings VALUES (?,?,?)').run('person-main-1', 1, JSON.stringify({ model: selection, reasoningEffort: 'high' }))
    expect(store.personSettings(1, 'person-main-other').settings).toMatchObject({ model: null, reasoningEffort: '' })
    initPersonTables(db)
    const stored = JSON.parse(String(db.prepare('SELECT settings_json FROM person_accounts WHERE user_id=1').get()!.settings_json))
    expect(stored).not.toHaveProperty('model')
    expect(stored).not.toHaveProperty('reasoningEffort')
    expect(stored).not.toHaveProperty('contextTokens')
    expect(stored).toMatchObject({ workspace: dir, agents: shared.agents })
    expect(await personSnapshot(1, 'person-main-1')).toMatchObject({ settings: { model: selection, reasoningEffort: 'high' } })
    expect(await personSnapshot(1, 'person-main-other')).toMatchObject({ settings: { model: selection, reasoningEffort: 'low' }, inherits_global_model: true })
    expect(db.prepare('SELECT COUNT(*) AS n FROM person_conversation_settings').get()?.n).toBe(1)
    const revision = store.personSettings(1).revision
    initPersonTables(db)
    expect(store.personSettings(1).revision).toBe(revision)
  })

  it('keeps model, effort, reset and runtime selection local to the selected owned session', async () => {
    const { createPersonConversation } = await import('../../packages/server/src/modules/studio/services/person/conversations')
    const { configurePerson, personSnapshot } = await import('../../packages/server/src/modules/studio/services/person/service')
    const { createPersonChatAgent } = await import('../../packages/server/src/modules/studio/services/person/chat-agent')
    const second = await createPersonConversation(1, 'Second')
    catalog[0].models.push('m2')
    catalog[0].model_meta = { m: { reasoning_efforts: ['low', 'high'] }, m2: { reasoning_efforts: ['low', 'high'] } }
    runtime.chatAgent = vi.fn(() => ({ run: vi.fn(), dispose: vi.fn() } as any))
    mainBusy = second.id
    await configurePerson(1, { session_id: 'person-main-1', model: { ...selection, model: 'm2' }, reasoning_effort: 'high', expected_revision: 1 })
    mainBusy = false
    await configurePerson(1, { session_id: second.id, reasoning_effort: 'low', expected_revision: 2 })
    expect(await personSnapshot(1, 'person-main-1')).toMatchObject({ settings: { model: { model: 'm2' }, reasoningEffort: 'high' } })
    expect(await personSnapshot(1, second.id)).toMatchObject({ settings: { model: selection, reasoningEffort: 'low' } })
    await createPersonChatAgent(1, 'person-main-1')
    expect(runtime.chatAgent).toHaveBeenLastCalledWith(expect.objectContaining({ selection: expect.objectContaining({ model: 'm2' }) }))
    await createPersonChatAgent(1, second.id)
    expect(runtime.chatAgent).toHaveBeenLastCalledWith(expect.objectContaining({ selection }))
    await expect(configurePerson(1, { session_id: 'person-main-2', model: selection, expected_revision: 3 })).rejects.toMatchObject({ status: 404 })
    await configurePerson(1, { session_id: second.id, model: { ...selection, model: 'm2' }, reasoning_effort: 'high', expected_revision: 3 })
    await configurePerson(1, { session_id: 'person-main-1', use_global_default: true, reasoning_effort: 'low', expected_revision: 4 })
    expect(await personSnapshot(1, 'person-main-1')).toMatchObject({ inherits_global_model: true, settings: { model: selection, reasoningEffort: 'low' } })
    expect(await personSnapshot(1, second.id)).toMatchObject({ inherits_global_model: false, settings: { model: { model: 'm2' }, reasoningEffort: 'high' } })
    const shared = JSON.parse(String(db.prepare('SELECT settings_json FROM person_accounts WHERE user_id=1').get()!.settings_json))
    expect(shared).not.toHaveProperty('model')
    expect(shared).not.toHaveProperty('reasoningEffort')
  })
})

describe('Person account-owned tasks and runtime', () => {
  it.each(['hermes', 'ekko', 'codex'])('automatically handles %s approvals on initial, continued and scheduled tasks without creating user interactions', async agent => {
    const { executePersonTask } = await import('../../packages/server/src/bootstrap/person-task-runtime')
    const { configurePerson } = await import('../../packages/server/src/modules/studio/services/person/service')
    const { continuePersonTask } = await import('../../packages/server/src/modules/studio/services/person/task-chat')
    const { ensurePersonSession } = await import('../../packages/server/src/modules/studio/services/person/chat-agent')
    const { deliverPersonResults, finishPersonDelivery } = await import('../../packages/server/src/modules/studio/services/person/delivery')
    await ensurePersonSession(1, 'person-main-1')
    runtime.execute = executePersonTask
    nativeTaskRun.mockImplementation(async (request, options) => {
      expect(options.approvalChoice).toBe('once')
      options.onEvent('run.started', { session_id: request.session_id })
      options.onEvent('approval.requested', { approval_id: 'native-approval', choices: ['once', 'deny'] })
      expect(store.personInteractions(1)).toEqual([])
      expect(db.prepare("SELECT COUNT(*) AS n FROM person_executions WHERE state='waiting_approval'").get()?.n).toBe(0)
      options.onEvent('approval.resolved', { approval_id: 'native-approval', choice: 'once', resolved: true })
      return { ok: true, output: 'Completed without manual approval' }
    })
    await configurePerson(1, { agents: [{ id: 'worker', name: 'Worker', description: 'Execute tasks', selection: { ...selection, runtime: agent } }], expected_revision: 1 })
    const { task, execution } = await create({ agent_id: 'worker' })
    await runner.tickPersonWork(); await wait(execution.id, 'finished')
    await deliverPersonResults(); finishPersonDelivery(1, execution.id, true)
    const next = await continuePersonTask(1, task.id, {
      input: [{ type: 'text', text: 'Continue the saved work' }], expected_revision: store.getPersonTask(1, task.id).revision, idempotency_key: 'continue-auto',
    }) as any
    await runner.tickPersonWork(); await wait(next.execution.id, 'finished')
    const scheduled = await create({ agent_id: 'worker', start: false })
    await schedules.applyPersonSchedule(1, { action: 'create', mode: 'worker', task_id: scheduled.task.id, kind: 'cron', expression: '* * * * *', timezone: 'UTC', expected_revision: 0, idempotency_key: 'auto-schedule' })
    schedules.tickPersonSchedules(store.listPersonSchedules(1)[0].next_at)
    const occurrence = store.taskPersonExecutions(1, scheduled.task.id)[0]
    await runner.tickPersonWork(); await wait(occurrence.id, 'finished')
    expect(nativeTaskRun).toHaveBeenCalledTimes(3)
    expect(runtime.answer).not.toHaveBeenCalled()
    expect(store.personInteractions(1)).toEqual([])
  })

  it('persists each return on its exact assistant reply and never exposes another account or session', async () => {
    const { ensurePersonSession } = await import('../../packages/server/src/modules/studio/services/person/chat-agent')
    const sessions = await import('../../packages/server/src/modules/studio/repositories/session-store')
    const { savePersonTaskReturn, withPersonTaskReturns } = await import('../../packages/server/src/modules/studio/repositories/person-return-store')
    await ensurePersonSession(1, 'person-main-1'); await ensurePersonSession(2, 'person-main-2')
    const { task, execution } = await create()
    store.setPersonExecution(execution, 'finished')
    const first = sessions.addMessage({ session_id: 'person-main-1', role: 'assistant', content: 'First return' })
    const second = sessions.addMessage({ session_id: 'person-main-1', role: 'assistant', content: 'Unrelated reply' })
    const other = sessions.addMessage({ session_id: 'person-main-2', role: 'assistant', content: 'Private' })
    expect(savePersonTaskReturn(1, execution.id, 'person-main-1', other)).toBeUndefined()
    expect(savePersonTaskReturn(2, execution.id, 'person-main-1', first)).toBeUndefined()
    expect(savePersonTaskReturn(1, execution.id, 'person-main-1', undefined)).toBeUndefined()
    const receipt = savePersonTaskReturn(1, execution.id, 'person-main-1', first)
    expect(receipt).toMatchObject({ taskId: task.id, executionId: execution.id, assistantMessageId: String(first), state: 'finished', agent: 'ekko', summary: task.summary })
    savePersonTaskReturn(1, execution.id, 'person-main-1', first)
    expect(db.prepare('SELECT COUNT(*) AS n FROM person_task_returns').get()?.n).toBe(1)
    const page = [{ id: first, role: 'assistant' }, { id: second, role: 'assistant' }]
    expect(withPersonTaskReturns('person-main-1', page)).toEqual([{ ...page[0], person_task_return: receipt }, page[1]])
    expect(withPersonTaskReturns('person-main-1', [page[1]])).toEqual([page[1]])
    expect(withPersonTaskReturns('person-main-2', page)).toEqual(page)
    expect(withPersonTaskReturns('normal-chat', page)).toEqual(page)
    const next = store.enqueuePersonExecution(store.getPersonTask(1, task.id))
    store.setPersonExecution(next, 'failed')
    const failed = savePersonTaskReturn(1, next.id, 'person-main-1', second)
    expect(withPersonTaskReturns('person-main-1', page)).toEqual([
      { ...page[0], person_task_return: receipt }, { ...page[1], person_task_return: failed },
    ])
    expect(failed).toMatchObject({ executionId: next.id, state: 'failed' })
  })

  it('inherits the global default without creating settings and follows later default changes', async () => {
    db.prepare('DELETE FROM person_accounts WHERE user_id=1').run()
    const { personSnapshot } = await import('../../packages/server/src/modules/studio/services/person/service')
    expect(await personSnapshot(1, 'person-main-1')).toMatchObject({ inherits_global_model: true, settings: { model: selection } })
    expect(store.personSettings(1).settings.model).toBeNull()
    expect(await personSnapshot(1, 'person-main-1')).toMatchObject({ session: { id: 'person-main-1', model: 'm', reasoning_effort: 'low', studio_user_id: '1' } })
    catalog[0].models.push('m2')
    vi.mocked(runtime.modelConfig).mockResolvedValue({ default: 'm2', default_provider: 'test', groups: catalog })
    expect(await personSnapshot(1, 'person-main-1')).toMatchObject({ session: { id: 'person-main-1', model: 'm2' } })
    expect(store.personSettings(1).settings.model).toBeNull()
  })

  it('persists model and supported reasoning choices, then restores global inheritance', async () => {
    catalog[0].models.push('m2')
    catalog[0].model_meta = { m: { reasoning_efforts: ['low', 'high'] }, m2: { reasoning: false } }
    const { configurePerson, personSnapshot } = await import('../../packages/server/src/modules/studio/services/person/service')
    await configurePerson(1, { session_id: 'person-main-1', reasoning_effort: 'high', expected_revision: 1 })
    expect(await personSnapshot(1, 'person-main-1')).toMatchObject({ session: { reasoning_effort: 'high' } })
    const switched = await configurePerson(1, { session_id: 'person-main-1', model: { profile: 'default', provider: 'test', model: 'm2' }, expected_revision: 2 })
    expect(switched).toMatchObject({ inherits_global_model: false, reasoning_efforts: [], settings: { model: { model: 'm2' }, reasoningEffort: '' } })
    expect(await personSnapshot(1, 'person-main-1')).toMatchObject({ settings: { model: { model: 'm2' } } })
    await expect(configurePerson(1, { session_id: 'person-main-1', reasoning_effort: 'high', expected_revision: 3 })).rejects.toThrow('does not support')
    const restored = await configurePerson(1, { session_id: 'person-main-1', use_global_default: true, expected_revision: 3 })
    expect(restored).toMatchObject({ inherits_global_model: true, settings: { model: selection } })
    expect(store.personSettings(1).settings.model).toBeNull()
  })

  it('preserves xhigh independently for the main coordinator and saved execution preset', async () => {
    const { configurePerson, personSnapshot } = await import('../../packages/server/src/modules/studio/services/person/service')
    const { runPersonModel } = await import('../../packages/server/src/modules/studio/services/person/model')
    catalog[0].model_meta = { m: { reasoning_efforts: ['low', 'medium', 'high', 'xhigh', 'max'] } }
    const agent = { id: 'worker', name: 'Worker', description: 'Execute tasks', selection: { ...selection, reasoningEffort: 'xhigh' } }
    await configurePerson(1, { agents: [agent], expected_revision: 1 })
    await runPersonModel(1, 'main', [{ role: 'user', content: 'Hello' }], [], new AbortController().signal, '', undefined, undefined, 'person-main-1')
    expect(vi.mocked(runtime.model).mock.calls.at(-1)![0].reasoningEffort).toBe('low')
    await configurePerson(1, { session_id: 'person-main-1', reasoning_effort: 'xhigh', expected_revision: 2 })
    expect(await personSnapshot(1, 'person-main-1')).toMatchObject({ settings: { reasoningEffort: 'xhigh', agents: [agent] }, session: { reasoning_effort: 'xhigh' } })
    await runPersonModel(1, 'main', [{ role: 'user', content: 'Think carefully' }], [], new AbortController().signal, '', undefined, undefined, 'person-main-1')
    expect(vi.mocked(runtime.model).mock.calls.at(-1)![0].reasoningEffort).toBe('xhigh')
    expect(JSON.parse((await create({ start: false })).task.selection_json).reasoningEffort).toBe('xhigh')
    await expect(configurePerson(1, { session_id: 'person-main-1', reasoning_effort: 'none', expected_revision: 3 })).rejects.toThrow('does not support')
  })

  it('saves general settings independently and follows the interaction model window and global threshold', async () => {
    const { configurePerson, personSnapshot } = await import('../../packages/server/src/modules/studio/services/person/service')
    const { createPersonChatAgent, ensurePersonSession } = await import('../../packages/server/src/modules/studio/services/person/chat-agent')
    const { createPersonAgent } = await import('../../packages/server/src/bootstrap/person-chat-agent')
    const { runPersonModel } = await import('../../packages/server/src/modules/studio/services/person/model')
    modelContextLength = 200000
    const original = store.personSettings(1)
    db.prepare('UPDATE person_accounts SET settings_json=? WHERE user_id=1').run(JSON.stringify({ ...original.settings, contextTokens: 16000 }))
    expect(await personSnapshot(1, 'person-main-1')).toMatchObject({ contextTokens: 200000, compression: { enabled: true, threshold: 0.5, globalThreshold: 0.5 } })
    expect(store.personSettings(1).settings).not.toHaveProperty('contextTokens')
    globalCompression = { threshold: 0.7 }
    expect((await personSnapshot(1, 'person-main-1')).compression.threshold).toBe(0.7)
    const patch = { compressionThreshold: 0.6, maxSteps: 20, maxConcurrentTasks: 3, timezone: 'Europe/London' }
    await configurePerson(1, { ...patch, expected_revision: 1 })
    const snapshot = await personSnapshot(1, 'person-main-1')
    expect(snapshot).toMatchObject({ contextTokens: 200000, compression: { threshold: 0.6, globalThreshold: 0.7 }, settings: { ...patch, agents: original.settings.agents, model: selection } })
    expect(store.personSettings(2).settings.timezone).toBe('Asia/Shanghai')
    await expect(configurePerson(1, { compressionThreshold: 0.4, expected_revision: 1 })).rejects.toThrow('changed')
    runtime.chatAgent = vi.fn(createPersonAgent)
    await ensurePersonSession(1, 'person-main-1')
    await createPersonChatAgent(1, 'person-main-1')
    expect(runtime.chatAgent).toHaveBeenLastCalledWith(expect.objectContaining({ contextTokens: 200000, maxSteps: 20, compression: expect.objectContaining({ threshold: 0.6 }), systemPrompt: expect.stringContaining('Account timezone: Europe/London') }))
    catalog[0].models.push('m2')
    await configurePerson(1, { session_id: 'person-main-1', model: { ...selection, model: 'm2' }, expected_revision: 2 })
    expect((await personSnapshot(1, 'person-main-1')).contextTokens).toBe(128000)
    await createPersonChatAgent(1, 'person-main-1')
    expect(runtime.chatAgent).toHaveBeenLastCalledWith(expect.objectContaining({ contextTokens: 128000, compression: expect.objectContaining({ threshold: 0.6 }) }))
    await runPersonModel(1, 'main', [{ role: 'user', content: 'Hello' }], [], new AbortController().signal, '', undefined, undefined, 'person-main-1')
    expect(runtime.model).toHaveBeenLastCalledWith(expect.objectContaining({ contextTokens: 128000, compression: expect.objectContaining({ threshold: 0.6 }) }))
    globalCompression.enabled = false
    await configurePerson(1, { compressionThreshold: null, expected_revision: 3 })
    expect(await personSnapshot(1, 'person-main-1')).toMatchObject({ compression: { enabled: false, threshold: 0.7 }, settings: { compressionThreshold: null } })
  })

  it.each([{ compressionThreshold: 0.01 }, { compressionThreshold: 0.96 }, { compressionThreshold: '50' }, { contextTokens: 16000 }, { maxSteps: 31 }, { maxConcurrentTasks: 0 }, { maxConcurrentTasks: 13 }, { maxConcurrentTasks: 1.5 }])('rejects invalid general settings without saving: %j', async patch => {
    const { configurePerson } = await import('../../packages/server/src/modules/studio/services/person/service')
    const original = store.personSettings(1)
    await expect(configurePerson(1, { ...patch, expected_revision: original.revision })).rejects.toMatchObject({ status: 400 })
    expect(store.personSettings(1)).toEqual(original)
  })

  it('keeps model catalogs in the UI, strips credentials and rejects unavailable choices', async () => {
    catalog[0] = { ...catalog[0], api_key: 'private-key', base_url: 'https://private.example', models: ['m','hidden','unsupported'],
      model_meta: { hidden: { disabled: true } }, api_mode_by_model: { unsupported: 'bedrock_converse' } }
    const { personModelCatalog } = await import('../../packages/server/src/modules/studio/services/person/catalog')
    const result = await personModelCatalog(1)
    expect(result.groups[0].models).toEqual(['m'])
    expect(JSON.stringify(result)).not.toContain('private')
    const { configurePerson } = await import('../../packages/server/src/modules/studio/services/person/service')
    await expect(configurePerson(1, { session_id: 'person-main-1', model: { profile: 'forbidden', provider: 'test', model: 'm' }, expected_revision: 1 })).rejects.toThrow('unavailable')
    await expect(configurePerson(1, { session_id: 'person-main-1', model: { profile: 'default', provider: 'test', model: 'hidden' }, expected_revision: 1 })).rejects.toThrow('unavailable')
    await expect(configurePerson(1, { session_id: 'person-main-1', reasoning_effort: 'invented', expected_revision: 1 })).rejects.toThrow('Invalid reasoning')
    await expect(configurePerson(1, { session_id: 'person-main-1', reasoning_effort: 'high', expected_revision: 0 })).rejects.toThrow('changed')
  })

  it('does not send a request if the global default is missing or disabled', async () => {
    const agents = store.personSettings(1).settings.agents
    db.prepare('DELETE FROM person_accounts WHERE user_id=1').run()
    store.savePersonSettings(1, { ...store.personSettings(1).settings, agents }, 0)
    catalog[0].model_meta = { m: { disabled: true } }
    const { personSnapshot } = await import('../../packages/server/src/modules/studio/services/person/service')
    expect(await personSnapshot(1, 'person-main-1')).toMatchObject({ inherits_global_model: true, settings: { model: null } })
    const { createPersonChatAgent } = await import('../../packages/server/src/modules/studio/services/person/chat-agent')
    await expect(createPersonChatAgent(1, 'person-main-1')).rejects.toThrow('global default model')
    expect(runtime.model).not.toHaveBeenCalled()
    expect(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id='person-main-1'").get()).toMatchObject({ n: 0 })
  })

  it('allows direct chat without presets while background work still requires one', async () => {
    const { configurePerson, personSnapshot } = await import('../../packages/server/src/modules/studio/services/person/service')
    const { createPersonChatAgent } = await import('../../packages/server/src/modules/studio/services/person/chat-agent')
    const { personExecutionAgents } = await import('../../packages/server/src/modules/studio/services/person/agents')
    const agents = store.personSettings(1).settings.agents
    db.prepare('DELETE FROM person_accounts WHERE user_id=1').run()
    runtime.chatAgent = vi.fn(async () => ({} as any))
    expect(await personSnapshot(1, 'person-main-1')).toMatchObject({ session: { id: 'person-main-1' }, settings: { agents: [], model: selection } })
    expect(await personExecutionAgents(1)).toEqual([])
    await expect(createPersonChatAgent(1, 'person-main-1')).resolves.toMatchObject({ run: expect.any(Function) })
    await expect(create()).rejects.toThrow('Configure at least one Agent preset')
    expect(runtime.chatAgent).toHaveBeenCalledTimes(1)
    expect(store.listPersonTasks(1)).toEqual([])
    await configurePerson(1, { agents, expected_revision: 0 })
    await expect(createPersonChatAgent(1, 'person-main-1')).resolves.toMatchObject({ run: expect.any(Function) })
    expect(runtime.chatAgent).toHaveBeenCalledTimes(2)
    await configurePerson(1, { agents: [], expected_revision: 1 })
    await expect(createPersonChatAgent(1, 'person-main-1')).resolves.toMatchObject({ run: expect.any(Function) })
    expect(await personExecutionAgents(1)).toEqual([])
    expect(runtime.chatAgent).toHaveBeenCalledTimes(3)
  })

  it('reuses a hidden owned session and preserves ordinary history', async () => {
    const { ensurePersonSession } = await import('../../packages/server/src/modules/studio/services/person/chat-agent')
    const sessions = await import('../../packages/server/src/modules/studio/repositories/session-store')
    const first = await ensurePersonSession(1, 'person-main-1')
    sessions.addMessage({ session_id: first.session.id, role: 'user', content: 'Private message' })
    await ensurePersonSession(1, 'person-main-1')
    const other = await ensurePersonSession(2, 'person-main-2')
    sessions.createSession({ id: 'ordinary', title: 'Ordinary chat', source: 'builtin_agent', user_id: 1 })
    expect(first.session.id).toBe('person-main-1')
    expect(first.session.studio_user_id).toBe('1')
    expect(sessions.getSessionDetail(first.session.id)?.messages.map(m => m.content)).toEqual(['Private message'])
    expect(sessions.getSessionDetail(other.session.id)?.messages).toEqual([])
    expect(sessions.listSessions().map(s => s.id)).toEqual(['ordinary'])
    expect(sessions.searchSessions(undefined, 'Private').length).toBe(0)
    const { openPersonContextStore } = await import('../../packages/server/src/modules/studio/repositories/person-context-store')
    expect(openPersonContextStore(1,first.session.id).search('Private').evidence).toHaveLength(1)
    expect(openPersonContextStore(2,other.session.id).search('Private').evidence).toHaveLength(0)
  })

  it('assembles bounded source evidence and excludes the newly persisted current turn', async () => {
    const { ensurePersonSession } = await import('../../packages/server/src/modules/studio/services/person/chat-agent')
    const { createPersonContext } = await import('../../packages/server/src/modules/studio/services/person/context')
    const { countTokens } = await import('../../packages/server/src/modules/studio/services/context-compressor')
    const sessions = await import('../../packages/server/src/modules/studio/repositories/session-store')
    await ensurePersonSession(1, 'person-main-1')
    const id=sessions.addMessage({session_id:'person-main-1',role:'user',content:'必须保留限制，不许发送。'.repeat(600)})
    const context=createPersonContext(1,'person-main-1',8000)
    sessions.addMessage({session_id:'person-main-1',role:'user',content:'CURRENT_SENT_ONCE'})
    const history=context.loadHistory('限制')
    expect(Math.ceil(countTokens(history[0].content)*1.15)).toBeLessThanOrEqual(2400)
    expect(history[0].content).not.toContain('CURRENT_SENT_ONCE')
    const packet=JSON.parse(history[0].content)
    expect(packet.evidence[0].id).toBe(id)
    expect(packet.evidence[0].next_offset).not.toBeNull()
    sessions.clearSessionMessages('person-main-1')
    expect(()=>context.loadHistory('限制')).toThrow('history changed')
  })

  it('only exposes worker questions after task-scoped coordination escalates', async () => {
    const { personChatInteraction } = await import('../../packages/server/src/modules/studio/services/person/chat-interactions')
    const { execution } = await create()
    store.addPersonInteraction(1, execution, 'native-question', 'Which scope?', ['A', 'B'])
    store.setPersonExecution(execution, 'waiting_person')
    expect(personChatInteraction(1, 'person-main-1')).toBeUndefined()
    store.setPersonExecution(execution, 'waiting_user')
    expect(personChatInteraction(1, 'person-main-1')).toMatchObject({ event: 'clarify.requested', data: { session_id: 'person-main-1', question: 'Which scope?', choices: ['A','B'] } })
    expect(personChatInteraction(2, 'person-main-2')).toBeUndefined()
  })

  it('separates account memory, conversations and tasks while reusing the existing goal table', async () => {
    const { personMemory, personMemories } = await import('../../packages/server/src/modules/studio/services/person/memory')
    const memory = personMemory(1)
    await memory.service.write({ operation: 'create', kind: 'language_preference', node: { title: 'Language', content: 'Prefer Chinese', valueJson: 'Chinese' }, identity: memory.identity, reason: 'User preference' })
    expect(await personMemories(2)).toEqual([])
    const { task } = await create({ start: false })
    expect(() => store.getPersonTask(2, task.id)).toThrow('not found')
    expect(db.prepare('SELECT session_id,source_message_id,bot_id FROM session_tasks WHERE id=?').get(task.id)).toMatchObject({ session_id: 'person-main-1', source_message_id: null, bot_id: 'person:1' })
    const { listSessions, searchSessions, createSession } = await import('../../packages/server/src/modules/studio/repositories/session-store')
    createSession({ id: 'person-task-private', profile: 'default', source: 'coding_agent', title: 'private' })
    expect(listSessions('default')).toEqual([]); expect(searchSessions('default','private')).toEqual([])
    const sessions = await import('../../packages/server/src/modules/studio/repositories/session-store')
    sessions.addMessage({session_id:'person-task-private',role:'user',content:'Private worker requirement',timestamp:Date.now()})
    const goals = await import('../../packages/server/src/modules/studio/services/session-tasks')
    goals.updateSessionTasks('person-task-private','default',{revision:0,changes:[{title:'Private worker goal',summary:'Private',status:'open'}]})
    const repository = await import('../../packages/server/src/modules/studio/repositories/session-task-store')
    expect(repository.listSessionTaskItems({profiles:['default'],limit:20,offset:0,order:'newest'}).tasks).toEqual([])

  })
  it('adopts an existing owned session goal without duplicating it and preserves its origin', async () => {
    const sessions = await import('../../packages/server/src/modules/studio/repositories/session-store')
    sessions.createSession({id:'owned',profile:'default',source:'coding_agent',studio_user_id:'1'})
    const msg = Number(sessions.addMessage({session_id:'owned',role:'user',content:'Write a report',timestamp:Date.now()}))
    const goals = await import('../../packages/server/src/modules/studio/services/session-tasks')
    const old = goals.updateSessionTasks('owned','default',{revision:0,changes:[{title:'Report',summary:'Needs work',status:'open'}]}).tasks[0]
    expect(store.listAssignablePersonGoals(1)).toHaveLength(1)
    expect(store.listAssignablePersonGoals(2)).toHaveLength(0)
    const result = await create({action:'adopt',task_id:old.id,expected_revision:old.updated_at,start:false})
    expect(result.task.id).toBe(old.id)
    expect(JSON.parse(result.task.requirements_json).origin).toMatchObject({session_id:'owned',source_message_id:msg})
    expect(goals.getSessionTasks('owned').tasks).toHaveLength(0)
    sessions.deleteSession('owned')
    expect(store.getPersonTask(1,old.id).status).toBe('open')
  })

  it('keeps creation idempotent and rejects reuse for changed intent', async () => {
    const a = await create({ idempotency_key: 'same' })
    const b = await create({ idempotency_key: 'same' })
    expect(a.task.id).toBe(b.task.id); expect(store.listPersonTasks(1)).toHaveLength(1)
    await expect(create({ idempotency_key: 'same', goal: 'other' })).rejects.toThrow('another operation')
  })
  it('runs a background worker once, returns its origin and completes without an acceptance step', async () => {
    const { ensurePersonSession } = await import('../../packages/server/src/modules/studio/services/person/chat-agent')
    const sessions = await import('../../packages/server/src/modules/studio/repositories/session-store')
    await ensurePersonSession(1, 'person-main-1')
    sessions.addMessage({ session_id: 'person-main-1', role: 'user', content: 'Original request' })
    const { task, execution } = await create()
    sessions.addMessage({ session_id: 'person-main-1', role: 'user', content: 'Unrelated later request' })
    expect(execution.state).toBe('queued')
    await runner.tickPersonWork(); await wait(execution.id, 'finished')
    expect(store.getPersonTask(1, task.id)).toMatchObject({ status: 'completed', completion_evidence: 'Created result.txt with 42' })
    expect(runtime.execute).toHaveBeenCalledTimes(1)
    expect(runtime.model).not.toHaveBeenCalled()
    expect(store.personInteractions(1)).toEqual([])
    await runner.tickPersonWork(); await runner.tickPersonWork()
    expect(runtime.deliver).toHaveBeenCalledTimes(1)
    expect(vi.mocked(runtime.deliver).mock.calls[0][0]).toMatchObject({ executionId: execution.id, status: 'finished',
      origin: { sessionId: 'person-main-1', messages: [{ role: 'user', content: 'Original request' }] } })
    expect(store.personBackgroundPendingCount('person-main-1')).toBe(1)
    expect(store.personBackgroundPendingCount('person-main-2')).toBe(0)
    expect(store.personBackgroundPendingCount('person-main-1', execution.id)).toBe(0)
    expect(store.listPersonTasks(1)[0].running).toBe(1)
    const { finishPersonDelivery } = await import('../../packages/server/src/modules/studio/services/person/delivery')
    finishPersonDelivery(1, execution.id, true)
    expect(store.personBackgroundPendingCount('person-main-1')).toBe(0)
    expect(store.listPersonTasks(1)[0].running).toBe(0)
    const closed = await tasks.applyPersonTask(1, { action: 'close', task_id: task.id, expected_revision: 1, idempotency_key: 'close' })
    expect(closed.task.status).toBe('closed')
    const reopened = await tasks.applyPersonTask(1, { action: 'reopen', task_id: task.id, expected_revision: 2, idempotency_key: 'open' })
    expect(reopened.task).toMatchObject({ status: 'open', completion_evidence: '' })
    expect(store.taskPersonExecutions(1, task.id)).toHaveLength(1)
    await expect(tasks.applyPersonTask(1, { action: 'close', task_id: task.id, expected_revision: 1, idempotency_key: 'stale' })).rejects.toThrow('changed')

  })
  it('only exposes configured presets and validates effort, permission and runtime', async () => {
    const { configurePerson } = await import('../../packages/server/src/modules/studio/services/person/service')
    const { personExecutionAgents } = await import('../../packages/server/src/modules/studio/services/person/agents')
    await configurePerson(1, { session_id: 'person-main-1', reasoning_effort: 'high', expected_revision: 1 })
    const configured = await create({ start: false })
    expect(JSON.parse(configured.task.selection_json)).toMatchObject({ ...selection, reasoningEffort: '' })
    const preset = { id: 'coder', name: 'Coder', description: 'Implement code changes', selection: { ...selection, runtime: 'codex', reasoningEffort: 'low' } }
    await configurePerson(1, { agents: [preset], expected_revision: 2 })
    expect(await personExecutionAgents(1)).toEqual([preset])
    await expect(create({ agent_id: 'default' })).rejects.toThrow('configured execution agents')
    const { execution } = await create({ agent_id: 'coder' })
    await runner.tickPersonWork(); await wait(execution.id, 'finished')
    expect(vi.mocked(runtime.execute).mock.calls[0][0].selection).toMatchObject(preset.selection)
    await expect(configurePerson(1, { agents: [{ ...preset, selection: { ...selection, reasoningEffort: 'invented' } }], expected_revision: 3 })).rejects.toThrow('reasoning effort')
    await expect(configurePerson(1, { agents: [preset, preset], expected_revision: 3 })).rejects.toThrow('Duplicate')
    await expect(configurePerson(2, { agents: [{ ...preset, selection: { ...selection, runtime: 'codex', mode: 'global', model: 'native/model-latest' } }], expected_revision: 0 })).rejects.toThrow('credentials')
    await configurePerson(1, { agents: [], expected_revision: 3 })
    expect(await personExecutionAgents(1)).toEqual([])
    await expect(create()).rejects.toThrow('Configure at least one Agent preset')
  })
  it('supports native defaults and validates native effort lists and encoded variants', async () => {
    const { configurePerson } = await import('../../packages/server/src/modules/studio/services/person/service')
    const { validatePersonSelection } = await import('../../packages/server/src/modules/studio/services/person/catalog')
    const native = { ...selection, runtime: 'codex', mode: 'global' as const, provider: '', model: '' }
    const preset = { id: 'native', name: 'Native coder', description: 'Code using native credentials', selection: native }
    await configurePerson(1, { agents: [preset], expected_revision: 1 })
    expect((await create({ agent_id: 'native', start: false })).task.selection_json).toContain('"model":""')
    vi.mocked(runtime.nativeModels).mockResolvedValue({ status: 'ready', models: [
      { id: 'plain', name: 'Plain', isDefault: true, reasoningEfforts: ['low', 'high'] },
      { id: 'variant-high', name: 'Variant', reasoningEffort: 'high', reasoningEfforts: ['low', 'high'] },
    ] })
    await expect(validatePersonSelection(1, { ...native, model: 'plain', reasoningEffort: 'high' })).resolves.toBeUndefined()
    await expect(validatePersonSelection(1, { ...native, reasoningEffort: 'low' })).resolves.toBeUndefined()
    await expect(validatePersonSelection(1, { ...native, model: 'variant-high', reasoningEffort: 'high' })).resolves.toBeUndefined()
    await expect(validatePersonSelection(1, { ...native, model: 'variant-high', reasoningEffort: 'low' })).rejects.toThrow('reasoning effort')
    await expect(validatePersonSelection(1, { ...native, model: 'plain', reasoningEffort: 'invented' })).rejects.toThrow('reasoning effort')
  })
  it('returns failures, retries a failed delivery and cancels stale results', async () => {
    const { ensurePersonSession } = await import('../../packages/server/src/modules/studio/services/person/chat-agent')
    const { deliverPersonResults, finishPersonDelivery } = await import('../../packages/server/src/modules/studio/services/person/delivery')
    await ensurePersonSession(1, 'person-main-1')
    vi.mocked(runtime.execute).mockResolvedValue({ ok: false, error: 'Provider failed' })
    const { task, execution } = await create(); await runner.tickPersonWork(); await wait(execution.id, 'failed')
    vi.mocked(runtime.deliver).mockRejectedValueOnce(new Error('Offline runtime'))
    await deliverPersonResults()
    expect(db.prepare('SELECT state FROM person_deliveries').get()).toMatchObject({ state: 'pending' })
    await deliverPersonResults(); expect(runtime.deliver).toHaveBeenCalledTimes(1)
    db.prepare('UPDATE person_deliveries SET updated_at=0').run()
    await deliverPersonResults(); expect(runtime.deliver).toHaveBeenCalledTimes(2)
    expect(vi.mocked(runtime.deliver).mock.calls[1][0]).toMatchObject({ status: 'failed', error: 'Provider failed' })
    finishPersonDelivery(1, execution.id, false, 'Retry')
    db.prepare('UPDATE person_deliveries SET updated_at=0').run()
    db.prepare('UPDATE session_tasks SET requirements_revision=requirements_revision+1 WHERE id=?').run(task.id)
    await deliverPersonResults()
    expect(db.prepare('SELECT state FROM person_deliveries').get()).toMatchObject({ state: 'cancelled' })
    expect(runtime.model).not.toHaveBeenCalled()
  })
  it('answers worker questions through a task-scoped Person context, without human escalation', async () => {
    let resume!: () => void
    vi.mocked(runtime.execute).mockImplementation(async input => {
      input.onEvent('run.started', {})
      const paused = new Promise<void>(resolve => { resume = resolve })
      input.onEvent('clarify.requested', { clarify_id: 'q1', question: 'Which number?', choices: ['42','43'] })
      await paused; writeFileSync(join(dir, 'result.txt'), '42'); return { ok: true, output: 'result.txt contains 42' }
    })
    vi.mocked(runtime.answer).mockImplementation(async () => { resume(); return true })
    const reviewer = runtime.model
    runtime.model = vi.fn(async call => {
      const reply = call.tools.find(t => t.name === 'bot_interaction_reply')
      if (reply) { await reply.execute({ answer: '42', basis: 'Task explicitly asks for 42' }); return 'Answered' }
      return reviewer(call)
    })
    const { execution } = await create(); await runner.tickPersonWork(); await wait(execution.id, 'finished')
    expect(runtime.answer).toHaveBeenCalledWith(execution.session_id, 'q1', '42', false)
    expect(store.personInteractions(1)).toEqual([])
    expect(db.prepare('SELECT answered_by FROM person_interactions').get()).toMatchObject({ answered_by: 'person' })
  })
  it.each(['pending','queued','starting','running','waiting_person','waiting_user','waiting_approval','stopping'])('locks task mutations while %s', async state => {
    const { task, execution } = await create()
    db.prepare('UPDATE person_executions SET state=? WHERE id=?').run(state, execution.id)
    for (const action of ['close','reopen','update','start']) {
      await expect(tasks.applyPersonTask(1, { action, task_id: task.id, goal: 'Changed', expected_revision: 0, idempotency_key: action })).rejects.toThrow('running')
    }
    expect(store.listPersonTasks(1)[0].running).toBe(1)
    expect(store.getPersonTask(1, task.id)).toMatchObject({ status: 'open', revision: 0 })
  })
  it('locks status while the result is being reported and rejects removed controls', async () => {
    const { task, execution } = await create()
    await runner.tickPersonWork(); await wait(execution.id, 'finished')
    for (const action of ['close','reopen']) {
      await expect(tasks.applyPersonTask(1, { action, task_id: task.id, expected_revision: 1, idempotency_key: action })).rejects.toThrow('running')
    }
    for (const action of ['pause','resume','cancel','steer']) {
      await expect(tasks.applyPersonTask(1, { action, task_id: task.id, expected_revision: 1, idempotency_key: action })).rejects.toThrow('Unsupported')
    }
  })
  it('stops queued work without launching, expires questions, and cancels only its callback', async () => {
    const { task, execution } = await create()
    expect(task).toMatchObject({ execution_id: execution.id, execution_state: 'queued', running: 1 })
    const other = await create()
    const question = store.addPersonInteraction(1, execution, 'queued-question', 'Continue?', [])
    const input = { action: 'stop', task_id: task.id, execution_id: execution.id, expected_revision: 0, idempotency_key: 'stop-queued' }
    const stopped = await tasks.applyPersonTask(1, input)
    expect(stopped).toMatchObject({ task: { status: 'open', running: 0, revision: 1, execution_id: execution.id, execution_state: 'interrupted' }, execution: { state: 'interrupted', generation: 1 } })
    expect(await tasks.applyPersonTask(1, input)).toEqual(stopped)
    expect(store.getPersonExecution(1, other.execution.id).state).toBe('queued')
    expect(db.prepare('SELECT state FROM person_deliveries WHERE execution_id=?').get(execution.id)).toMatchObject({ state: 'cancelled' })
    await expect(runner.replyPersonQuestion(1, question.id, question.revision, 'yes')).rejects.toThrow('expired')
    await runner.tickPersonWork(); await wait(other.execution.id, 'finished')
    expect(runtime.execute).toHaveBeenCalledTimes(1)
    expect(vi.mocked(runtime.execute).mock.calls[0][0].sessionId).toBe(other.execution.session_id)
    expect(runtime.stop).not.toHaveBeenCalled()
  })
  it.each(['starting','running','waiting_person','waiting_user','waiting_approval'])('persists stop intent for %s until acknowledgement and retries failures', async state => {
    const { task, execution } = await create()
    db.prepare('UPDATE person_executions SET state=?,generation=4,lease_until=? WHERE id=?').run(state, Date.now() + 90_000, execution.id)
    const question = store.addPersonInteraction(1, execution, 'pending', 'Continue?', [])
    vi.mocked(runtime.stop).mockRejectedValueOnce(new Error('Native runtime offline'))
    const result = await tasks.applyPersonTask(1, { action: 'stop', task_id: task.id, execution_id: execution.id, expected_revision: 0, idempotency_key: 'stop' })
    expect(result).toMatchObject({ execution: { state: 'stopping', generation: 5 }, task: { running: 1, revision: 1 } })
    await vi.waitFor(() => expect(runtime.stop).toHaveBeenCalledTimes(1))
    expect(store.getPersonExecution(1, execution.id).state).toBe('stopping')
    expect(store.personInteractions(1)).toEqual([])
    await expect(runner.replyPersonQuestion(1, question.id, 0, 'yes')).rejects.toThrow('expired')
    await expect(tasks.applyPersonTask(1, { action: 'start', task_id: task.id, expected_revision: 1, idempotency_key: 'start' })).rejects.toThrow('running')
    await runner.tickPersonWork()
    expect(runtime.stop).toHaveBeenCalledTimes(2)
    await wait(execution.id, 'interrupted')
    expect(store.getPersonTask(1, task.id).status).toBe('open')
  })
  it('aborts a live worker, deduplicates concurrent stops and ignores late success', async () => {
    let finish!: (result: {ok: boolean; output: string}) => void
    let acknowledge!: () => void
    vi.mocked(runtime.execute).mockImplementation(async input => {
      input.onEvent('run.started', {})
      return new Promise(resolve => { finish = resolve })
    })
    vi.mocked(runtime.stop).mockImplementation(() => new Promise(resolve => { acknowledge = resolve }))
    const { task, execution } = await create()
    await runner.tickPersonWork(); await wait(execution.id, 'running')
    const request = { action: 'stop', task_id: task.id, execution_id: execution.id, expected_revision: 0, idempotency_key: 'live-stop' }
    await tasks.applyPersonTask(1, request)
    await tasks.applyPersonTask(1, request)
    await tasks.applyPersonTask(1, { ...request, expected_revision: 1, idempotency_key: 'second-click' })
    expect(vi.mocked(runtime.execute).mock.calls[0][0].signal.aborted).toBe(true)
    expect(runtime.stop).toHaveBeenCalledExactlyOnceWith(execution.session_id)
    expect(store.getPersonExecution(1, execution.id).state).toBe('stopping')
    finish({ ok: true, output: 'late result that must not be reported' })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(store.getPersonTask(1, task.id)).toMatchObject({ status: 'open', completion_evidence: '', running: 1 })
    acknowledge(); await wait(execution.id, 'interrupted')
    await runner.tickPersonWork()
    expect(runtime.deliver).not.toHaveBeenCalled()
    const { continuePersonTask } = await import('../../packages/server/src/modules/studio/services/person/task-chat')
    const next = await continuePersonTask(1, task.id, { input: [{ type: 'text', text: 'Continue from the saved work' }], expected_revision: 1, idempotency_key: 'continue' }) as any
    expect(next.task).toMatchObject({ status: 'open', running: true, execution_id: next.execution.id, execution_state: 'queued' })
    await tasks.applyPersonTask(1, request) // Replay must not stop the new execution.
    await expect(tasks.applyPersonTask(1, { ...request, expected_revision: next.task.revision, idempotency_key: 'stale-execution' })).rejects.toThrow('Execution changed')
    expect(store.getPersonExecution(1, next.execution.id).state).toBe('queued')
    expect(runtime.stop).toHaveBeenCalledTimes(1)
  })
  it('requires an owned current execution and revision; cannot stop another task or account', async () => {
    const { task, execution } = await create()
    const other = await create()
    const input = { action: 'stop', task_id: task.id, execution_id: execution.id, expected_revision: 0, idempotency_key: 'bad-stop' }
    await expect(tasks.applyPersonTask(2, input)).rejects.toThrow('Task not found')
    await expect(tasks.applyPersonTask(1, { ...input, execution_id: undefined })).rejects.toThrow('execution_id')
    await expect(tasks.applyPersonTask(1, { ...input, expected_revision: 9 })).rejects.toThrow('Task changed')
    await expect(tasks.applyPersonTask(1, { ...input, execution_id: other.execution.id })).rejects.toThrow('Execution changed')
    await expect(tasks.applyPersonTask(1, input, other.task.id)).rejects.toThrow('scope')
    expect(runtime.stop).not.toHaveBeenCalled()
    expect(store.getPersonExecution(1, execution.id).state).toBe('queued')
    store.setPersonExecution(execution, 'finished')
    await expect(tasks.applyPersonTask(1, input)).rejects.toThrow('no longer running')
  })
  it('keeps dispatching unrelated work while a native stop acknowledgement is delayed', async () => {
    const { task, execution } = await create()
    const other = await create()
    db.prepare("UPDATE person_executions SET state='running',generation=1,lease_until=? WHERE id=?").run(Date.now() + 90_000, execution.id)
    let acknowledge!: () => void
    vi.mocked(runtime.stop).mockImplementation(() => new Promise(resolve => { acknowledge = resolve }))
    await tasks.applyPersonTask(1, { action: 'stop', task_id: task.id, execution_id: execution.id, expected_revision: 0, idempotency_key: 'slow-stop' })
    await runner.tickPersonWork()
    await wait(other.execution.id, 'finished')
    expect(store.getPersonExecution(1, execution.id).state).toBe('stopping')
    acknowledge(); await wait(execution.id, 'interrupted')
  })
  it('stops only a scheduled occurrence while keeping its future schedule', async () => {
    const { task } = await create({ start: false })
    await schedules.applyPersonSchedule(1, { action: 'create', mode: 'worker', task_id: task.id, kind: 'cron', expression: '* * * * *', timezone: 'UTC', expected_revision: 0, idempotency_key: 'schedule' })
    const schedule = store.listPersonSchedules(1)[0]
    schedules.tickPersonSchedules(schedule.next_at)
    const execution = store.taskPersonExecutions(1, task.id)[0]
    await tasks.applyPersonTask(1, { action: 'stop', task_id: task.id, execution_id: execution.id, expected_revision: store.getPersonTask(1, task.id).revision, idempotency_key: 'stop-schedule' })
    expect(db.prepare('SELECT state FROM person_occurrences WHERE id=?').get(execution.occurrence_id)).toMatchObject({ state: 'interrupted' })
    expect(store.listPersonSchedules(1)[0]).toMatchObject({ state: 'active', revision: schedule.revision })
    schedules.tickPersonSchedules(store.listPersonSchedules(1)[0].next_at)
    expect(store.getPersonTask(1, task.id)).toMatchObject({ status: 'open', execution_state: 'queued', running: 1 })
  })
  it('does not revive a worker after server shutdown', async () => {
    let finish!: (value: {ok:boolean;output:string}) => void
    vi.mocked(runtime.execute).mockImplementation(async input => { input.onEvent('run.started', {}); return new Promise(resolve => { finish = resolve }) })
    const { task, execution } = await create(); await runner.tickPersonWork(); await wait(execution.id, 'running')
    await runner.stopPersonWork()
    finish({ok:true,output:'late result'})
    await wait(execution.id, 'interrupted')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(store.getPersonTask(1, task.id).status).toBe('open')
    expect(runtime.deliver).not.toHaveBeenCalled()
  })
  it('rejects Person granting authorization and permits only an explicit user choice', async () => {
    const { execution } = await create()
    const question = store.addPersonInteraction(1, execution, 'approval', 'External action', ['once','deny'], 'approval')
    expect(() => store.answerPersonInteraction(1, question.id, 0, 'once', 'person')).toThrow('cannot grant')
    await expect(runner.replyPersonQuestion(2, question.id, 0, 'once')).rejects.toThrow('expired')
    await expect(runner.replyPersonQuestion(1, question.id, 0, 'yes')).rejects.toThrow('Unsupported')
  })
  it('exposes only preset dispatch tools and no acceptance tool', async () => {
    const { personTools } = await import('../../packages/server/src/modules/studio/services/person/tools')
    const main = personTools(1, 'main', undefined, 'person-main-1').map(t => t.name)
    expect(main).toEqual(expect.arrayContaining(['bot_task_create','bot_task_control','bot_agents_list','bot_schedule_apply','bot_decision_request']))
    expect(main.some(t => /shell|terminal|browser|exec_command|file_write/.test(t))).toBe(false)
    expect(main).not.toContain('bot_review_submit')
    expect(main).not.toContain('bot_models_search')
    activeAccount = false
    const { personSnapshot } = await import('../../packages/server/src/modules/studio/services/person/service')
    await expect(personSnapshot(1, 'person-main-1')).rejects.toThrow('unavailable')
  })
  it('binds revisions and deduplicates concurrent creates, stops and resumes without model plumbing', async () => {
    const { personTools } = await import('../../packages/server/src/modules/studio/services/person/tools')
    const tools = personTools(1, 'main', undefined, 'person-main-1')
    const call = (name: string, args: Record<string, unknown>) => tools.find(t => t.name === name)!.execute(args) as Promise<any>
    const input = { title: 'Task', goal: 'Compute a result' }
    const [created, duplicate] = await Promise.all([call('bot_task_create', input), call('bot_task_create', { goal: input.goal, title: input.title })])
    expect(created.ok).toBe(true)
    expect(duplicate).toMatchObject({ task: { id: created.task.id }, replayed: true })
    expect(store.listPersonTasks(1)).toHaveLength(1)
    expect(store.taskPersonExecutions(1, created.task.id)).toHaveLength(1)
    const stop = { task_ref: created.task.task_ref, action: 'stop' }
    const stopped = await call('bot_task_control', stop)
    expect(stopped).toMatchObject({ ok: true, execution: { state: 'interrupted' } })
    const resume = { task_ref: stopped.task.task_ref, action: 'start' }
    const [started, replayed] = await Promise.all([call('bot_task_control', resume), call('bot_task_control', resume)])
    expect(started).toMatchObject({ ok: true, execution: { state: 'queued' } })
    expect(replayed).toMatchObject({ replayed: true, execution: started.execution })
    expect(store.taskPersonExecutions(1, created.task.id)).toHaveLength(2)
    // A retry reports the original stop receipt; it must not stop the new run.
    expect(await call('bot_task_control', stop)).toMatchObject({ replayed: true, execution: stopped.execution })
    expect(store.getPersonExecution(1, started.execution.id).state).toBe('queued')
    expect((await call('bot_tasks_query', { task_id: created.task.id })).task.allowed_actions).toEqual(['continue', 'stop'])
  })
  it('rejects injected host fields, invalid actions and missing requirements before side effects', async () => {
    const { personTools } = await import('../../packages/server/src/modules/studio/services/person/tools')
    const tools = personTools(1, 'main', undefined, 'person-main-1')
    const call = (name: string, args: Record<string, unknown>) => tools.find(t => t.name === name)!.execute(args) as Promise<any>
    const { task } = await create({ start: false })
    const { task: snapshot } = await call('bot_tasks_query', { task_id: task.id })
    const before = store.getPersonTask(1, task.id)
    for (const extra of [{ expected_revision: 0 }, { execution_id: 'invented' }, { task_id: task.id }, { idempotency_key: 'invented' }, { constructor: 'invented' }, { expected_execution_id: null }, { goal: 'ignored' }]) {
      expect(await call('bot_task_control', { action: 'start', task_ref: snapshot.task_ref, ...extra })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
    }
    for (const args of [{ action: 'update', task_ref: snapshot.task_ref }, { action: 'invented', task_ref: snapshot.task_ref }]) {
      expect(await call('bot_task_control', args)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
    }
    expect(await call('bot_task_create', { title: 'missing goal' })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
    expect(await call('bot_task_control', { action: 'stop', task_ref: snapshot.task_ref })).toMatchObject({ ok: false, error: { code: 'ACTION_NOT_ALLOWED' } })
    expect(store.getPersonTask(1, task.id)).toEqual(before)
    expect(store.taskPersonExecutions(1, task.id)).toHaveLength(0)
  })
  it.each([undefined, '', ' ', null])('lists tasks with an empty optional task ID (%s) and gives actionable recovery for guessed IDs', async taskId => {
    const { personTools } = await import('../../packages/server/src/modules/studio/services/person/tools')
    const { task } = await create({ start: false })
    store.createPersonTask(2, 'Private task', 'Private requirements', selection, dir, 'person-main-2')
    const query = personTools(1, 'main', undefined, 'person-main-1').find(tool => tool.name === 'bot_tasks_query')!
    const result: any = await query.execute({ ...(taskId !== undefined ? { task_id: taskId } : {}), search: '', offset: 0, assignable: false })
    expect(result.tasks.map((item: any) => item.id)).toEqual([task.id])
    expect(result.tasks[0].allowed_actions).toContain('start')
    const missing: any = await query.execute({ task_id: 'all', search: '' })
    expect(missing).toMatchObject({ ok: false, error: { code: 'TASK_UNAVAILABLE' } })
    expect(missing.error.recovery).toContain('{"search":"","offset":0}')
    expect(store.taskPersonExecutions(1, task.id)).toHaveLength(0)
  })
  it.each([undefined, 0, null])('searches historical evidence without treating empty message ID %s as an exact read', async messageId => {
    const { ensurePersonSession } = await import('../../packages/server/src/modules/studio/services/person/chat-agent')
    const { addMessage } = await import('../../packages/server/src/modules/studio/repositories/session-store')
    const { personTools } = await import('../../packages/server/src/modules/studio/services/person/tools')
    await ensurePersonSession(1, 'person-main-1'); await ensurePersonSession(2, 'person-main-2')
    const own = addMessage({ session_id: 'person-main-1', role: 'user', content: '仓库调研 report' })
    const foreign = addMessage({ session_id: 'person-main-2', role: 'user', content: 'Private report' })
    const search = personTools(1, 'main', undefined, 'person-main-1').find(tool => tool.name === 'bot_context_search')!
    expect(await search.execute({ query: 'report', ...(messageId !== undefined ? { message_id: messageId } : {}), offset: 0 }))
      .toMatchObject({ evidence: [{ id: own, content: '仓库调研 report' }] })
    expect(await search.execute({ query: '', message_id: own, offset: 0 })).toMatchObject({ evidence: [{ id: own }] })
    await expect(search.execute({ query: 'report', message_id: foreign, offset: 0 })).rejects.toThrow('not found')
    await expect(search.execute({ query: 'report', message_id: -1, offset: 0 })).rejects.toThrow()
  })
  it('rejects cross-account, previous-turn, expired and evicted references', async () => {
    const { personTools } = await import('../../packages/server/src/modules/studio/services/person/tools')
    const tools = personTools(1, 'main', undefined, 'person-main-1')
    const query = tools.find(t => t.name === 'bot_tasks_query')!
    const control = tools.find(t => t.name === 'bot_task_control')!
    const { task } = await create({ start: false })
    const snapshot: any = await query.execute({ task_id: task.id })
    const request = { task_ref: snapshot.task.task_ref, action: 'start' }
    for (const userId of [1, 2]) expect(await personTools(userId, 'main').find(t => t.name === 'bot_task_control')!.execute(request)).toMatchObject({ ok: false, error: { code: 'INVALID_TASK_REF' } })
    expect(await personTools(2, 'main', undefined, 'person-main-2').find(t => t.name === 'bot_tasks_query')!.execute({ task_id: task.id })).toMatchObject({ ok: false, error: { code: 'TASK_UNAVAILABLE' } })
    for (let n = 0; n < 129; n++) {
      db.prepare('UPDATE session_tasks SET revision=revision+1 WHERE id=?').run(task.id)
      await query.execute({ task_id: task.id })
    }
    expect(await control.execute(request)).toMatchObject({ ok: false, error: { code: 'INVALID_TASK_REF' } })
    const latest: any = await query.execute({ task_id: task.id })
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 600001)
    try { expect(await control.execute({ action: 'start', task_ref: latest.task.task_ref })).toMatchObject({ ok: false, error: { code: 'INVALID_TASK_REF' } }) }
    finally { clock.mockRestore() }
    expect(store.taskPersonExecutions(1, task.id)).toHaveLength(0)
  })
  it('rejects stale revisions and scheduled replacement executions even when revision is unchanged', async () => {
    const { personTools } = await import('../../packages/server/src/modules/studio/services/person/tools')
    const tools = personTools(1, 'main', undefined, 'person-main-1')
    const query = tools.find(t => t.name === 'bot_tasks_query')!
    const control = tools.find(t => t.name === 'bot_task_control')!
    const { task, execution } = await create()
    const old: any = await query.execute({ task_id: task.id })
    store.setPersonExecution(execution, 'interrupted')
    const replacement = store.enqueuePersonExecution(store.getPersonTask(1, task.id))
    expect(store.getPersonTask(1, task.id).revision).toBe(task.revision)
    expect(await control.execute({ action: 'stop', task_ref: old.task.task_ref })).toMatchObject({ ok: false, error: { code: 'STALE_TASK' } })
    expect(store.getPersonExecution(1, replacement.id).state).toBe('queued')
    const current: any = await query.execute({ task_id: task.id })
    db.prepare('UPDATE session_tasks SET revision=revision+1 WHERE id=?').run(task.id)
    expect(await control.execute({ action: 'stop', task_ref: current.task.task_ref })).toMatchObject({ ok: false, error: { code: 'STALE_TASK' } })
    expect(store.getPersonExecution(1, replacement.id).state).toBe('queued')
    const fresh: any = await query.execute({ task_id: task.id })
    expect(await control.execute({ action: 'stop', task_ref: fresh.task.task_ref })).toMatchObject({ ok: true, execution: { id: replacement.id, state: 'interrupted' } })
  })
  it('checks execution identity after asynchronous model validation, inside the mutation transaction', async () => {
    const { personTools } = await import('../../packages/server/src/modules/studio/services/person/tools')
    const tools = personTools(1, 'main', undefined, 'person-main-1')
    const { task } = await create({ start: false })
    const snapshot: any = await tools.find(t => t.name === 'bot_tasks_query')!.execute({ task_id: task.id })
    let release!: () => void
    const deferred = new Promise<void>(resolve => { release = resolve })
    vi.mocked(runtime.modelConfig).mockImplementationOnce(async () => { await deferred; return { default: 'm', default_provider: 'test', groups: catalog } })
    const pending = tools.find(t => t.name === 'bot_task_control')!.execute({ action: 'start', task_ref: snapshot.task.task_ref })
    // Another scheduled run finishes while start is validating the selected model.
    const unexpected = store.enqueuePersonExecution(store.getPersonTask(1, task.id))
    store.setPersonExecution(unexpected, 'interrupted')
    release()
    expect(await pending).toMatchObject({ ok: false, error: { code: 'STALE_TASK' } })
    expect(store.taskPersonExecutions(1, task.id)).toHaveLength(1)
  })
  it('requires fresh references after updates and supports close, reopen, adoption and deleted tasks', async () => {
    const { personTools } = await import('../../packages/server/src/modules/studio/services/person/tools')
    const tools = personTools(1, 'main', undefined, 'person-main-1')
    const call = (name: string, args: Record<string, unknown>) => tools.find(t => t.name === name)!.execute(args) as Promise<any>
    const { task } = await create({ start: false })
    const old = await call('bot_tasks_query', { task_id: task.id })
    const updated = await call('bot_task_control', { action: 'update', task_ref: old.task.task_ref, goal: 'New goal' })
    expect(updated.ok).toBe(true)
    expect(await call('bot_task_control', { action: 'close', task_ref: old.task.task_ref })).toMatchObject({ ok: false, error: { code: 'STALE_TASK' } })
    const closed = await call('bot_task_control', { action: 'close', task_ref: updated.task.task_ref })
    expect(closed.task.allowed_actions).toEqual(['reopen'])
    const reopened = await call('bot_task_control', { action: 'reopen', task_ref: closed.task.task_ref })
    expect(reopened.task.status).toBe('open')
    db.prepare('DELETE FROM session_tasks WHERE id=?').run(task.id)
    expect(await call('bot_task_control', { action: 'start', task_ref: reopened.task.task_ref })).toMatchObject({ ok: false, error: { code: 'TASK_UNAVAILABLE' } })
    const sessions = await import('../../packages/server/src/modules/studio/repositories/session-store')
    sessions.createSession({ id: 'adoptable', studio_user_id: 1, profile: 'default' })
    db.prepare("INSERT INTO session_tasks(id,session_id,title,summary,status,created_at,updated_at) VALUES ('goal','adoptable','Goal','Summary','open',1,1)").run()
    const goals = await call('bot_tasks_query', { assignable: true })
    const adopt = { action: 'adopt', session_id: 'person-main-1', task_ref: goals.tasks[0].task_ref, goal: 'Adopted goal', start: false }
    expect(goals.tasks[0].allowed_actions).toEqual(['adopt'])
    expect(await call('bot_task_control', adopt)).toMatchObject({ ok: true, task: { id: 'goal', status: 'open' } })
    expect(await call('bot_task_control', adopt)).toMatchObject({ replayed: true })
    expect(store.getPersonTask(1, 'goal').owner_user_id).toBe(1)
  })
  it('bounds task pages and recovers a committed result after a lost response without duplicate execution', async () => {
    const { personTools } = await import('../../packages/server/src/modules/studio/services/person/tools')
    for (let i = 0; i < 12; i++) await create({ start: false, title: '长'.repeat(200), goal: '详'.repeat(8000) })
    const tools = personTools(1, 'main', undefined, 'person-main-1')
    const query = tools.find(t => t.name === 'bot_tasks_query')!
    const first: any = await query.execute({ search: '' })
    expect(first.tasks).toHaveLength(10)
    expect(first.next_offset).toBe(10)
    expect(JSON.stringify(first).length).toBeLessThan(18000)
    const second: any = await query.execute({ offset: first.next_offset })
    expect(second.tasks).toHaveLength(2)
    expect(second.next_offset).toBeNull()
    expect(new Set([...first.tasks, ...second.tasks].map(t => t.id)).size).toBe(12)
    const original = tasks.applyPersonTask
    vi.spyOn(tasks, 'applyPersonTask').mockImplementationOnce(async (...args) => {
      await original(...args)
      throw new Error('Response lost after commit')
    })
    const control = tools.find(t => t.name === 'bot_task_control')!
    const request = { action: 'start', task_ref: first.tasks[0].task_ref }
    await expect(control.execute(request)).rejects.toThrow('Response lost')
    expect(await control.execute(request)).toMatchObject({ ok: true, execution: { state: 'queued' } })
    expect(store.taskPersonExecutions(1, first.tasks[0].id)).toHaveLength(1)
  })
  it('fences expired workers before acknowledging interruption, keeping the goal open', async () => {
    const { task,execution }=await create()
    db.prepare("UPDATE person_executions SET state='running',lease_until=0 WHERE id=?").run(execution.id)
    await runner.tickPersonWork()
    expect(store.getPersonExecution(1,execution.id).state).toBe('stopping')
    await runner.tickPersonWork()
    await wait(execution.id, 'interrupted')
    expect(store.getPersonTask(1,task.id).status).toBe('open')
    expect(runtime.execute).not.toHaveBeenCalled()
  })

  it('backs off result delivery when its account becomes unavailable', async () => {
    const { ensurePersonSession } = await import('../../packages/server/src/modules/studio/services/person/chat-agent')
    const { deliverPersonResults } = await import('../../packages/server/src/modules/studio/services/person/delivery')
    await ensurePersonSession(1, 'person-main-1')
    const { execution } = await create(); await runner.tickPersonWork(); await wait(execution.id, 'finished')
    activeAccount = false
    await deliverPersonResults()
    expect(db.prepare('SELECT state,error FROM person_deliveries').get()).toMatchObject({ state: 'pending', error: expect.stringContaining('Account is unavailable') })
    activeAccount = true
    await deliverPersonResults(); expect(runtime.deliver).not.toHaveBeenCalled()
    db.prepare('UPDATE person_deliveries SET updated_at=0').run()
    await deliverPersonResults(); expect(runtime.deliver).toHaveBeenCalledTimes(1)
  })
  it('recovers queued result delivery after restart without re-running the worker', async () => {
    const { ensurePersonSession } = await import('../../packages/server/src/modules/studio/services/person/chat-agent')
    const { finishPersonDelivery, cancelPersonDelivery } = await import('../../packages/server/src/modules/studio/services/person/delivery')
    await ensurePersonSession(1, 'person-main-1')
    const { execution } = await create(); await runner.tickPersonWork(); await wait(execution.id, 'finished')
    await runner.tickPersonWork()
    expect(runtime.deliver).toHaveBeenCalledTimes(1)
    runner.startPersonWork(); await runner.tickPersonWork()
    expect(runtime.deliver).toHaveBeenCalledTimes(2)
    finishPersonDelivery(1, execution.id, true)
    await runner.stopPersonWork(); runner.startPersonWork(); await runner.tickPersonWork()
    expect(runtime.deliver).toHaveBeenCalledTimes(2)
    expect(runtime.execute).toHaveBeenCalledTimes(1)
    db.prepare("UPDATE person_deliveries SET state='queued'").run()
    cancelPersonDelivery(1, execution.id)
    await runner.tickPersonWork()
    expect(runtime.deliver).toHaveBeenCalledTimes(2)
  })
  it('finishes a recurring occurrence while keeping future work open', async () => {
    const { task, execution } = await create()
    schedules.applyPersonSchedule(1, { action: 'create', mode: 'worker', task_id: task.id, kind: 'cron', expression: '0 9 * * *', timezone: 'UTC', idempotency_key: 'recurring' })
    await runner.tickPersonWork(); await wait(execution.id, 'finished')
    expect(store.getPersonTask(1, task.id).status).toBe('open')
    expect(store.listPersonSchedules(1)[0].state).toBe('active')
    expect(store.getPersonTask(1, task.id).completion_evidence).toBe('Created result.txt with 42')
  })
  it('claims a due occurrence once, persists revisions and skips overlaps', async () => {
    const { task } = await create({ start: false }); const at = Date.now() + 60_000
    const schedule = schedules.applyPersonSchedule(1, { action:'create', mode: 'worker', task_id:task.id, kind:'once', expression:new Date(at).toISOString(), timezone:'UTC', misfire:'run_latest', idempotency_key:'schedule' })
    schedules.tickPersonSchedules(at); schedules.tickPersonSchedules(at)
    expect(store.taskPersonExecutions(1, task.id)).toHaveLength(1)
    expect(db.prepare('SELECT COUNT(*) AS n FROM person_occurrences').get()).toMatchObject({n:1})
    expect(store.listPersonSchedules(1)[0].state).toBe('exhausted')
    const updated = schedules.applyPersonSchedule(1, { action:'update', schedule_id:schedule.id, expected_revision:0, kind:'once', expression:new Date(at+60_000).toISOString(), timezone:'UTC', idempotency_key:'update' })
    expect(updated?.revision).toBe(1)
    schedules.tickPersonSchedules(at+60_000)
    expect(db.prepare("SELECT COUNT(*) AS n FROM person_occurrences WHERE state='skipped'").get()).toMatchObject({n:1})
  })
})

it('continues in the same hidden task session and delivers every turn to Person exactly once', async () => {
  const { personTaskChat, continuePersonTask, ownedPersonTaskSession } = await import('../../packages/server/src/modules/studio/services/person/task-chat')
  const { ensurePersonSession } = await import('../../packages/server/src/modules/studio/services/person/chat-agent')
  const { finishPersonDelivery, deliverPersonResults } = await import('../../packages/server/src/modules/studio/services/person/delivery')
  await ensurePersonSession(1, 'person-main-1')
  const { task, execution } = await create()
  const chat = await personTaskChat(1, task.id)
  expect(chat.session.id).toBe(execution.session_id)
  expect(chat.task.running).toBe(true)
  expect(() => ownedPersonTaskSession(2, chat.session.id)).toThrow('not found')
  await expect(personTaskChat(2, task.id)).rejects.toThrow('not found')
  await runner.tickPersonWork(); await wait(execution.id, 'finished')
  await deliverPersonResults(); finishPersonDelivery(1, execution.id, true)
  const input = [{ type: 'text', text: 'Use the previous result to compute the next value' }]
  const request = { input, expected_revision: store.getPersonTask(1, task.id).revision, idempotency_key: 'follow-up' }
  const next: any = await continuePersonTask(1, task.id, request)
  expect(next.task).toMatchObject({ status: 'open', running: true })
  expect(next.execution.session_id).toBe(execution.session_id)
  expect(next.execution.id).not.toBe(execution.id)
  expect(await continuePersonTask(1, task.id, request)).toEqual(next)
  await runner.tickPersonWork(); await wait(next.execution.id, 'finished')
  expect(vi.mocked(runtime.execute).mock.calls[0][0]).toMatchObject({
    prompt: expect.stringContaining('# Compute result\n\nWrite 42 into result.txt\n\n## Dispatch contract'),
    displayInput: expect.stringContaining('## Dispatch contract'),
  })
  expect(vi.mocked(runtime.execute).mock.calls[1][0]).toMatchObject({ sessionId: execution.session_id, prompt: [{ type: 'text', text: expect.stringContaining('## Dispatch contract') }, ...input], displayInput: undefined })
  await deliverPersonResults(); finishPersonDelivery(1, next.execution.id, true); await deliverPersonResults()
  expect(runtime.deliver).toHaveBeenCalledTimes(2)
  expect(vi.mocked(runtime.deliver).mock.calls[1][0]).toMatchObject({ origin: { sessionId: 'person-main-1' }, executionId: next.execution.id })
  const { listSessions } = await import('../../packages/server/src/modules/studio/repositories/session-store')
  expect(listSessions().some((s: any) => s.id.startsWith('person-task-'))).toBe(false)
})

it('includes task context and keeps attachments intact on the first and subsequent manual turns', async () => {
  const { continuePersonTask } = await import('../../packages/server/src/modules/studio/services/person/task-chat')
  const { task } = await create({ start: false })
  const imagePath = join(dir, 'screenshot.png'), filePath = join(dir, 'notes.txt')
  writeFileSync(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l5kAAAAASUVORK5CYII=', 'base64'))
  writeFileSync(filePath, 'Use these notes')
  const input = [
    { type: 'text', text: 'Use the attached screenshot and notes' },
    { type: 'image', path: imagePath, name: 'screenshot.png', media_type: 'image/png', context: 'Reference screenshot' },
    { type: 'file', path: filePath, name: 'notes.txt', media_type: 'text/plain', context: 'Task notes' },
  ]
  const first = await continuePersonTask(1, task.id, { input, expected_revision: task.revision, idempotency_key: 'first-with-files' })
  await runner.tickPersonWork(); await wait(first.execution.id, 'finished')
  expect(vi.mocked(runtime.execute).mock.calls[0][0]).toMatchObject({
    prompt: [{ type: 'text', text: expect.stringContaining('## Dispatch contract') }, ...input], displayInput: undefined,
  })
  expect(JSON.parse(store.getPersonExecution(1, first.execution.id).input_json!)).toEqual(input)
  const next = await continuePersonTask(1, task.id, { input, expected_revision: store.getPersonTask(1, task.id).revision, idempotency_key: 'followup-with-files' })
  await runner.tickPersonWork(); await wait(next.execution.id, 'finished')
  expect(vi.mocked(runtime.execute).mock.calls[1][0]).toMatchObject({ sessionId: first.execution.session_id, prompt: [{ type: 'text', text: expect.stringContaining('## Dispatch contract') }, ...input], displayInput: undefined })
})

it.each([true, false])('queues same-task follow-ups in order exactly once after initial success=%s', async initialSuccess => {
  const { continuePersonTask, personTaskChat } = await import('../../packages/server/src/modules/studio/services/person/task-chat')
  const { personTools } = await import('../../packages/server/src/modules/studio/services/person/tools')
  const { ensurePersonSession } = await import('../../packages/server/src/modules/studio/services/person/chat-agent')
  await ensurePersonSession(1, 'person-main-1')
  const complete: ((result: { ok: boolean; output: string }) => void)[] = []
  runtime.execute = vi.fn(input => { input.onEvent('run.started', {}); return new Promise(resolve => complete.push(resolve)) })
  const { task, execution } = await create()
  await runner.tickPersonWork(); await wait(execution.id, 'running')
  const tools = personTools(1, 'main', undefined, 'person-main-1')
  const origin = { sessionId: 'person-main-1', runId: 'followup-main', messages: [{ role: 'user' as const, content: 'Wait for CI, then merge.' }] }
  const call = (name: string, args: Record<string, unknown>) => tools.find(t => t.name === name)!.execute(args, origin) as Promise<any>
  const snapshot = await call('bot_tasks_query', { task_id: task.id })
  expect(snapshot.task.allowed_actions).toContain('continue')
  const args = { task_ref: snapshot.task.task_ref, action: 'continue', message: 'Wait for CI, then merge only if every check passes.' }
  const [next, duplicate] = await Promise.all([call('bot_task_control', args), call('bot_task_control', args)])
  expect(next).toMatchObject({ ok: true, task: { id: task.id, execution_id: execution.id, pending_count: 1 }, execution: { state: 'pending' } })
  expect(duplicate).toMatchObject({ replayed: true, execution: next.execution })
  expect(JSON.parse(String(db.prepare('SELECT origin_json FROM person_deliveries WHERE execution_id=?').get(next.execution.id)?.origin_json))).toEqual(origin)
  expect(store.getPersonTask(1, task.id).requirements_revision).toBe(task.requirements_revision)
  const input = [{ type: 'text', text: 'Also include this report' }, { type: 'file', name: 'report.txt', path: '/tmp/report.txt' }]
  const request = { input, expected_revision: store.getPersonTask(1, task.id).revision, idempotency_key: 'detail-followup' }
  const last: any = await continuePersonTask(1, task.id, request)
  expect(await continuePersonTask(1, task.id, request)).toEqual(last)
  expect((await personTaskChat(1, task.id)).pending.map(item => item.input)).toEqual([[{ type: 'text', text: args.message }], input])
  await runner.tickPersonWork()
  expect(runtime.execute).toHaveBeenCalledTimes(1)
  complete[0]({ ok: initialSuccess, output: 'Found the PR' }); await wait(execution.id, initialSuccess ? 'finished' : 'failed')
  expect(store.getPersonTask(1, task.id).status).toBe('open')
  await runner.tickPersonWork(); await wait(next.execution.id, 'running')
  expect(vi.mocked(runtime.execute).mock.calls[1][0]).toMatchObject({ sessionId: execution.session_id, prompt: [{ type: 'text', text: expect.stringContaining('## Dispatch contract') }, { type: 'text', text: args.message }] })
  expect(store.getPersonExecution(1, last.execution.id).state).toBe('pending')
  complete[1]({ ok: true, output: 'CI passed' }); await wait(next.execution.id, 'finished')
  await runner.tickPersonWork(); await wait(last.execution.id, 'running')
  expect(vi.mocked(runtime.execute).mock.calls[2][0]).toMatchObject({ sessionId: execution.session_id, prompt: [{ type: 'text', text: expect.stringContaining('## Dispatch contract') }, ...input] })
  complete[2]({ ok: true, output: 'Included report' }); await wait(last.execution.id, 'finished')
  expect(store.getPersonTask(1, task.id)).toMatchObject({ status: 'completed', pending_count: 0 })
  expect(store.listPersonTasks(1)).toHaveLength(1)
  await runner.tickPersonWork(); expect(runtime.execute).toHaveBeenCalledTimes(3)
  expect(vi.mocked(runtime.deliver).mock.calls.map(([delivery]) => delivery.executionId)).toEqual([execution.id, next.execution.id, last.execution.id])
})

it.each(['queued', 'running', 'waiting_user'])('stopping %s work cancels every pending follow-up and its delivery', async state => {
  const { continuePersonTask } = await import('../../packages/server/src/modules/studio/services/person/task-chat')
  const { task, execution } = await create()
  db.prepare('UPDATE person_executions SET state=? WHERE id=?').run(state, execution.id)
  const next: any = await continuePersonTask(1, task.id, { input: [{ type: 'text', text: 'Follow up' }], expected_revision: task.revision, idempotency_key: 'followup' })
  expect(next.execution.state).toBe('pending')
  const current = store.getPersonTask(1, task.id)
  await tasks.applyPersonTask(1, { action: 'stop', task_id: task.id, execution_id: current.execution_id, expected_revision: current.revision, idempotency_key: 'stop-all' })
  await vi.waitFor(() => expect(store.getPersonExecution(1, execution.id).state).toBe('interrupted'))
  expect(store.getPersonExecution(1, next.execution.id).state).toBe('interrupted')
  expect(db.prepare('SELECT state FROM person_deliveries WHERE execution_id=?').get(next.execution.id)?.state).toBe('cancelled')
  await runner.tickPersonWork(); expect(runtime.execute).not.toHaveBeenCalled()
})

it('rejects stale executions, stopping tasks and full queues without accepting extra turns', async () => {
  const { continuePersonTask } = await import('../../packages/server/src/modules/studio/services/person/task-chat')
  const { task, execution } = await create()
  const request = { input: [{ type: 'text', text: 'Follow up' }], expected_revision: task.revision, idempotency_key: 'stale-followup', expected_execution_id: 'old-run' }
  await expect(continuePersonTask(1, task.id, request)).rejects.toThrow('Execution changed')
  db.prepare("UPDATE person_executions SET state='stopping' WHERE id=?").run(execution.id)
  await expect(continuePersonTask(1, task.id, { ...request, expected_execution_id: execution.id })).rejects.toThrow('stopping')
  db.prepare("UPDATE person_executions SET state='queued' WHERE id=?").run(execution.id)
  for (let i = 0; i < 20; i++) await continuePersonTask(1, task.id, { ...request, expected_execution_id: execution.id, expected_revision: i, idempotency_key: `queued-${i}` })
  await expect(continuePersonTask(1, task.id, { ...request, expected_execution_id: execution.id, expected_revision: 20 })).rejects.toThrow('queue is full')
  expect(store.getPersonTask(1, task.id)).toMatchObject({ revision: 20, pending_count: 20 })
})

it('recovers pending turns in FIFO order without invalidating the active execution', async () => {
  const { continuePersonTask } = await import('../../packages/server/src/modules/studio/services/person/task-chat')
  const { task, execution } = await create()
  const next: any = await continuePersonTask(1, task.id, { input: [{ type: 'text', text: 'Continue after restart' }], expected_revision: task.revision, idempotency_key: 'recovery' })
  store.promotePersonFollowups()
  expect(store.getPersonExecution(1, next.execution.id).state).toBe('pending')
  db.prepare("UPDATE person_executions SET state='failed' WHERE id=?").run(execution.id)
  expect(store.personTaskRunning(task.id)).toBe(true)
  const { personHasPendingWork } = await import('../../packages/server/src/modules/studio/repositories/person-history-store')
  expect(personHasPendingWork(1)).toBe(true)
  await runner.tickPersonWork(); await wait(next.execution.id, 'finished')
  expect(vi.mocked(runtime.execute).mock.calls[0][0].sessionId).toBe(execution.session_id)
})

it('requires reopening closed tasks and rejects stale, unauthorized or invalid chat turns', async () => {
  const { continuePersonTask, personTaskChat, ownedPersonTaskSession } = await import('../../packages/server/src/modules/studio/services/person/task-chat')
  const { task } = await create({ start: false })
  expect((await personTaskChat(1, task.id)).session).toBeNull()
  const initial = store.enqueuePersonExecution(task)
  store.setPersonExecution(initial, 'finished')
  const chat = await personTaskChat(1, task.id)
  const request = { input: [{ type: 'text', text: 'Continue' }], expected_revision: 0, idempotency_key: 'continue' }
  await expect(continuePersonTask(2, task.id, request)).rejects.toThrow('not found')
  await expect(continuePersonTask(1, task.id, { ...request, input: [] })).rejects.toThrow('Invalid input')
  await expect(continuePersonTask(1, task.id, { ...request, input: [{ type: 'tool_result' }] })).rejects.toThrow('Invalid input')
  await tasks.applyPersonTask(1, { task_id: task.id, action: 'close', expected_revision: task.revision, idempotency_key: 'close' })
  await expect(continuePersonTask(1, task.id, request)).rejects.toThrow('changed')
  await expect(continuePersonTask(1, task.id, { ...request, expected_revision: 1 })).rejects.toThrow('Reopen')
  expect(ownedPersonTaskSession(1, chat.session.id).task.status).toBe('closed')
  activeAccount = false
  expect(() => ownedPersonTaskSession(1, chat.session.id)).toThrow('unavailable')
})

it.each(['disabled', 'removed', 'uninstalled'])('reads completed task history when the execution model is %s, while rejecting new execution', async unavailable => {
  const { personTaskChat, continuePersonTask } = await import('../../packages/server/src/modules/studio/services/person/task-chat')
  const sessions = await import('../../packages/server/src/modules/studio/repositories/session-store')
  const { task, execution } = await create()
  const chat = await personTaskChat(1, task.id)
  sessions.addMessage({ session_id: chat.session.id, role: 'assistant', content: 'Persisted task result' })
  await runner.tickPersonWork(); await wait(execution.id, 'finished')
  if (unavailable === 'disabled') catalog[0].model_meta = { m: { disabled: true } }
  if (unavailable === 'removed') catalog = []
  if (unavailable === 'uninstalled') installedAgent = false
  expect(await personTaskChat(1, task.id)).toMatchObject({ task: { status: 'completed' }, session: { id: chat.session.id } })
  expect(sessions.getSessionDetail(chat.session.id)?.messages).toEqual(expect.arrayContaining([expect.objectContaining({ content: 'Persisted task result' })]))
  await expect(continuePersonTask(1, task.id, { input: [{ type: 'text', text: 'Continue' }],
    expected_revision: store.getPersonTask(1, task.id).revision, idempotency_key: 'unavailable' })).rejects.toThrow(unavailable === 'uninstalled' ? 'not installed' : 'unavailable')
})

it('keeps task history private after resource permission is revoked', async () => {
  const { personTaskChat, ownedPersonTaskSession } = await import('../../packages/server/src/modules/studio/services/person/task-chat')
  const task = store.createPersonTask(2, 'Private task', 'Read history', selection, dir, 'person-main-2')
  store.enqueuePersonExecution(task)
  const chat = await personTaskChat(2, task.id)
  allowedProfiles = []
  await expect(personTaskChat(2, task.id)).rejects.toThrow('permission revoked')
  expect(() => ownedPersonTaskSession(2, chat.session.id)).toThrow('permission revoked')
})


it('queries the same 100-task window as single chat with account-scoped search, status and ordering', async () => {
  for (let i = 0; i < 55; i++) {
    const task = store.createPersonTask(1, `Task ${i}`, 'Find reports', selection, dir, 'person-main-1')
    db.prepare('UPDATE session_tasks SET updated_at=?,status=? WHERE id=?').run(i + 1, i % 2 ? 'completed' : 'open', task.id)
  }
  store.createPersonTask(2, 'Private report', 'Find reports', selection, dir, 'person-main-2')
  expect(store.listPersonTasks(1)).toHaveLength(20)
  expect(store.listPersonTasks(1, '', 0, { limit: 100 })).toHaveLength(55)
  const completed = store.listPersonTasks(1, 'reports', 0, { limit: 100, status: 'completed', order: 'oldest' })
  expect(completed).toHaveLength(27)
  expect(completed[0].title).toBe('Task 1')
  expect(completed.at(-1)?.title).toBe('Task 53')
  expect(store.listPersonTasks(1, 'Private report', 0, { limit: 100 })).toEqual([])
})


it('uses the complete native memory toolset within a 10k Person model budget', async () => {
  const { createPersonAgent } = await import('../../packages/server/src/bootstrap/person-chat-agent')
  const { createPersonChatAgent } = await import('../../packages/server/src/modules/studio/services/person/chat-agent')
  const { createPersonConversation } = await import('../../packages/server/src/modules/studio/services/person/conversations')
  const { personMemory } = await import('../../packages/server/src/modules/studio/services/person/memory')
  const { countTextTokens } = await import('../../packages/ekko-agent/src/model/tokens')
  runtime.chatAgent = createPersonAgent
  modelContextLength = 10000
  const conversation = await createPersonConversation(1, '旅行计划'.repeat(25))
  const account = personMemory(1)
  await account.service.write({operation:'create',kind:'profile_name',identity:account.identity,reason:'User name',node:{title:'Name',content:'用户的名字是 ekko',valueJson:'ekko'}})
  const requests: any[] = []
  const agent = await createPersonChatAgent(1, conversation.id)
  await agent.run({ messages: [{role:'user',content:'我的名字是什么'}], memoryInput: {messages:[{role:'user',content:'我的名字是什么'}]},
    modelClient: { provider:'test', capabilities:{streaming:true,tools:true,vision:false,jsonMode:false,systemPrompt:true},
      create:async()=>({content:'summary'}), async *stream(request) { requests.push(request); yield {type:'done',response:{content:'ekko'}} } } })
  await account.service.drain()
  expect(requests).toHaveLength(1)
  expect(requests[0].tools.map((t:any)=>t.name)).toContain('memory_write')
  expect(JSON.stringify(requests[0].messages)).toContain('用户的名字是 ekko')
  // Leave room for variable IDs, timestamps and host paths, rather than passing
  // only when their tokenization happens to fit within a few tokens of the cap.
  expect(Math.ceil(countTextTokens(JSON.stringify({ messages: requests[0].messages, tools: requests[0].tools })) * 1.15) + 2048 + 1024).toBeLessThanOrEqual(modelContextLength - 128)
})

it('resumes a saved task through Responses list, history search and control without exhausting steps', async () => {
  const { createPersonAgent } = await import('../../packages/server/src/bootstrap/person-chat-agent')
  const { createPersonChatAgent, ensurePersonSession } = await import('../../packages/server/src/modules/studio/services/person/chat-agent')
  const { OpenAIResponsesModelClient } = await import('../../packages/ekko-agent/src/model/providers/openai-responses')
  const { addMessage } = await import('../../packages/server/src/modules/studio/repositories/session-store')
  runtime.chatAgent = createPersonAgent
  await ensurePersonSession(1, 'person-main-1')
  const evidenceId = addMessage({ session_id: 'person-main-1', role: 'user', content: '调研这个仓库，并给我一份报告。' })
  const { task } = await create({ title: '仓库调研', goal: '调研仓库并提供报告', start: false })
  const bodies: any[] = [], events: any[] = []
  let taskRef = ''
  const modelClient = new OpenAIResponsesModelClient({ id: 'test', type: 'openai', defaultModel: 'm', baseUrl: 'https://model.example.test/v1' }, {
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      if (String(body.instructions || '').startsWith('Summarize task context')) return new Response(JSON.stringify({ status: 'completed', output_text: 'Keep the saved task and original user request; no new authorization.' }))
      bodies.push(body)
      expect(body.tools.every((tool: any) => tool.strict === false)).toBe(true)
      const resultOf = (id: string) => JSON.parse(body.input.find((item: any) => item.type === 'function_call_output' && item.call_id === id).output)
      let call: { name: string; arguments: Record<string, unknown> } | undefined
      if (bodies.length === 1) {
        expect(body.tools.find((tool: any) => tool.name === 'bot_tasks_query').parameters.required).not.toContain('task_id')
        call = { name: 'bot_tasks_query', arguments: { task_id: null, search: '', offset: 0, assignable: false } }
      } else if (bodies.length === 2) {
        const listed = resultOf('step-1')
        expect(listed.tasks).toHaveLength(1)
        expect(listed.tasks[0]).toMatchObject({ id: task.id, allowed_actions: expect.arrayContaining(['start']) })
        taskRef = listed.tasks[0].task_ref
        call = { name: 'bot_context_search', arguments: { query: '仓库', message_id: 0, offset: 0 } }
      } else if (bodies.length === 3) {
        expect(resultOf('step-2').evidence).toContainEqual(expect.objectContaining({ id: evidenceId }))
        call = { name: 'bot_task_control', arguments: { task_ref: taskRef, action: 'start' } }
      } else {
        expect(bodies).toHaveLength(4)
        expect(resultOf('step-3')).toMatchObject({ ok: true, execution: { state: 'queued' } })
      }
      const response = { id: `response-${bodies.length}`, status: 'completed', output: call
        ? [{ type: 'function_call', call_id: `step-${bodies.length}`, name: call.name, arguments: JSON.stringify(call.arguments) }]
        : [{ type: 'message', content: [{ type: 'output_text', text: '已安排继续仓库调研。' }] }],
      }
      return new Response(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  const agent = await createPersonChatAgent(1, 'person-main-1')
  const result = await agent.run({ messages: [{ role: 'user', content: '继续' }], modelClient, onEvent: event => events.push(event) })
  expect(result.output.content).toBe('已安排继续仓库调研。')
  expect(result.output.finishReason).not.toBe('max_steps')
  expect(events.filter(event => ['tool.failed', 'run.max_steps'].includes(event.type))).toEqual([])
  expect(store.taskPersonExecutions(1, task.id)).toMatchObject([{ state: 'queued' }])
  expect(bodies).toHaveLength(4)
})

it.each([false, true])('continues after small tool errors with Responses metadata and encrypted reasoning within 16k (streaming=%s)', async streaming => {
  const { createPersonAgent } = await import('../../packages/server/src/bootstrap/person-chat-agent')
  const { createPersonChatAgent, ensurePersonSession } = await import('../../packages/server/src/modules/studio/services/person/chat-agent')
  const { OpenAIResponsesModelClient } = await import('../../packages/ekko-agent/src/model/providers/openai-responses')
  const { addMessage } = await import('../../packages/server/src/modules/studio/repositories/session-store')
  const { createHash } = await import('node:crypto')
  runtime.chatAgent = createPersonAgent
  await ensurePersonSession(1, 'person-main-1')
  for (let i = 0; i < 4; i++) addMessage({ session_id: 'person-main-1', role: 'assistant', content: `Earlier task ${i}. ` + 'The task is pending; verify the current task record before acting. '.repeat(100) })
  const encrypted = Array.from({ length: 80 }, (_, i) => createHash('sha256').update(String(i)).digest('base64')).join('').slice(0, 3340)
  const requests: any[] = [], events: any[] = [], summaries: any[] = []
  const modelClient = new OpenAIResponsesModelClient({ id: 'test', type: 'openai', defaultModel: 'm', baseUrl: 'https://model.example.test/v1', capabilities: { streaming, maxInputTokens: 16000 } }, {
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      if (!body.tools?.length) {
        summaries.push(body)
        return new Response(JSON.stringify({ output_text: 'Earlier tool query failed with TASK_UNAVAILABLE; no action was authorized. '.repeat(8), status: 'completed' }))
      }
      requests.push(body)
      const output = requests.length <= 2 ? [
        ...(requests.length === 2 ? [{ type: 'reasoning', id: 'rs_test', encrypted_content: encrypted, summary: [], content: [] }] : []),
        { type: 'function_call', call_id: `query-${requests.length}`, name: 'bot_tasks_query', arguments: JSON.stringify({ task_id: 'missing-task', search: '', offset: 0, assignable: false }) },
      ] : [{ type: 'message', content: [{ type: 'output_text', text: 'The query failed; I will correct its arguments.' }] }]
      const response = { id: `response-${requests.length}`, model: 'm', status: 'completed',
        instructions: body.instructions, tools: body.tools, output, usage: { input_tokens: 4700, output_tokens: 174, output_tokens_details: { reasoning_tokens: 138 } },
      }
      return body.stream
        ? new Response(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
        : new Response(JSON.stringify(response))
    },
  })
  const agent = await createPersonChatAgent(1, 'person-main-1')
  const result = await agent.run({ messages: [{ role: 'user', content: '继续' }], modelClient, reasoningEffort: 'xhigh', onEvent: event => events.push(event) })
  expect(result.output.content).toBe('The query failed; I will correct its arguments.')
  expect(requests).toHaveLength(3)
  expect(events.filter(event => event.type === 'tool.failed')).toHaveLength(2)
  expect(summaries).toEqual([])
  expect(requests.every(request => request.reasoning.effort === 'xhigh')).toBe(true)
  expect(requests[2].input).toContainEqual(expect.objectContaining({ type: 'reasoning', encrypted_content: encrypted }))
  expect(requests[2].input.filter((item: any) => item.type === 'function_call_output')).toHaveLength(2)
  const estimates = events.filter(event => event.type === 'context.estimated').map(event => event.estimate.contextTokens)
  expect(estimates).toHaveLength(3)
  expect(estimates.every(tokens => tokens + 2048 + 1024 <= 16000)).toBe(true)
})

it('delivers a completed screenshot through the real artifact tool and accepts an uploaded image within 16k', async () => {
  const { createPersonAgent } = await import('../../packages/server/src/bootstrap/person-chat-agent')
  const { createPersonChatAgent, ensurePersonSession } = await import('../../packages/server/src/modules/studio/services/person/chat-agent')
  const { estimatePersonContext } = await import('../../packages/server/src/modules/studio/services/person/context-estimate')
  const { default: sharp } = await import('sharp')
  const { randomBytes } = await import('node:crypto')
  const { realpathSync } = await import('node:fs')
  runtime.chatAgent = createPersonAgent
  modelContextLength = 16000
  await ensurePersonSession(1, 'person-main-1')
  const png = await sharp(randomBytes(800 * 800 * 3), { raw: { width: 800, height: 800, channels: 3 } }).png().toBuffer()
  runtime.execute = vi.fn(async input => {
    writeFileSync(join(input.workspace, 'desktop screenshot.png'), png)
    return { ok: true, output: `![桌面截图](<${join(input.workspace, 'desktop screenshot.png')}>)` }
  })
  const { task, execution } = await create({ title: '桌面截图', goal: '你桌面截个图发我' })
  await runner.tickPersonWork(); await wait(execution.id, 'finished')
  const path = realpathSync(join(task.workspace!, 'desktop screenshot.png'))
  const requests: any[] = [], events: any[] = []
  const agent = await createPersonChatAgent(1, 'person-main-1')
  const result = await agent.run({ messages: [{ role: 'user', content: '你桌面截个图发我' }],
    onEvent: (event: any) => events.push(event),
    modelClient: { provider: 'test', capabilities: { streaming: true, tools: true, vision: true, jsonMode: false, systemPrompt: true },
      create: async () => ({ content: 'summary' }), async *stream(request) {
        requests.push(request)
        if (requests.length === 1) yield { type: 'tool-call', toolCall: { id: 'image', name: 'bot_artifact_read', arguments: { execution_id: execution.id, path } } }
        yield { type: 'done', response: { content: requests.length === 1 ? '' : `![桌面截图](<${path}>)` } }
      },
    } })
  expect(result.output.content).toBe(`![桌面截图](<${path}>)`)
  expect(requests).toHaveLength(2)
  expect(JSON.parse(requests[1].messages.find((message: any) => message.role === 'tool').content)).toMatchObject({ absolute_path: path, kind: 'image', size: png.length })
  expect(events.filter(event => event.type === 'tool.failed')).toEqual([])
  for (const request of requests) expect(estimatePersonContext(request).contextTokens + 2048 + 1024).toBeLessThanOrEqual(16000)
  const uploaded = { type: 'image' as const, mimeType: 'image/png', data: png.toString('base64') }
  const imageAgent = await createPersonChatAgent(1, 'person-main-1')
  const imageResult = await imageAgent.run({ messages: [{ role: 'user', content: '这是一张什么图片', contentParts: [uploaded] }],
    modelClient: { provider: 'test', capabilities: { streaming: true, tools: true, vision: true, jsonMode: false, systemPrompt: true },
      create: async () => ({ content: 'summary' }), async *stream(request) {
        expect(request.messages.at(-1)?.contentParts).toEqual([uploaded])
        expect(estimatePersonContext(request).contextTokens + 2048 + 1024).toBeLessThanOrEqual(16000)
        yield { type: 'done', response: { content: '图片已收到' } }
      },
    } })
  expect(imageResult.contextEstimate!.contextTokens).toBeLessThan(16000 - 2048 - 1024)
  expect(imageResult.output.content).toBe('图片已收到')
})

it('removes the legacy Person memory table without changing ordinary messages', async () => {
  const { createSession, addMessage } = await import('../../packages/server/src/modules/studio/repositories/session-store')
  createSession({ id: 'ordinary-memory-regression', title: 'Ordinary chat', profile: 'default', agent: 'ekko-agent' })
  addMessage({ session_id: 'ordinary-memory-regression', role: 'user', content: 'Keep this ordinary chat message' })
  const sessions = db.prepare('SELECT * FROM sessions ORDER BY id').all()
  const messages = db.prepare('SELECT * FROM messages ORDER BY id').all()
  db.exec("CREATE TABLE person_memories (content TEXT); INSERT INTO person_memories VALUES ('old memory')")
  const { initPersonTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/person-schema')
  const before = db.prepare("SELECT sql FROM sqlite_master WHERE name IN ('sessions','messages') ORDER BY name").all()
  initPersonTables(db)
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name='person_memories'").get()).toBeUndefined()
  expect(db.prepare("SELECT sql FROM sqlite_master WHERE name IN ('sessions','messages') ORDER BY name").all()).toEqual(before)
  expect(db.prepare('SELECT * FROM sessions ORDER BY id').all()).toEqual(sessions)
  expect(db.prepare('SELECT * FROM messages ORDER BY id').all()).toEqual(messages)
})

it('pins task workspaces across account workspace changes, scheduled runs and follow-up turns', async () => {
  const { configurePerson, personSnapshot } = await import('../../packages/server/src/modules/studio/services/person/service')
  const { personTaskChat, continuePersonTask } = await import('../../packages/server/src/modules/studio/services/person/task-chat')
  const sessions = await import('../../packages/server/src/modules/studio/repositories/session-store')
  const delivery = await import('../../packages/server/src/modules/studio/services/person/delivery')
  const selected = join(dir, 'selected-workspace')
  await configurePerson(1, { workspace: selected, expected_revision: 1 })
  expect((await personSnapshot(1, 'person-main-1')).session.workspace).toBe(selected)
  sessions.createSession({ id: 'workspace-owned', profile: 'default', studio_user_id: '1', source: 'coding_agent' })
  sessions.addMessage({ session_id: 'workspace-owned', role: 'user', content: 'Take over this goal' })
  const goals = await import('../../packages/server/src/modules/studio/services/session-tasks')
  const original = goals.updateSessionTasks('workspace-owned', 'default', { revision: 0, changes: [{ title: 'Existing goal', summary: 'Take over', status: 'open' }] }).tasks[0]
  const adopted = await create({ action: 'adopt', session_id: 'person-main-1', task_id: original.id, expected_revision: original.updated_at, start: false })
  expect(adopted.task.workspace).toBe(selected)
  const first = await create()
  const second = await create({ start: false })
  expect(first.task.workspace).toBe(selected)
  expect(second.task.workspace).toBe(selected)
  await expect(create({ workspace: join(dir, 'individual-override') })).rejects.toThrow('ENOENT')
  await expect(configurePerson(1, { workspace: dir, expected_revision: 2 })).rejects.toThrow('Wait for Person tasks')
  await runner.tickPersonWork(); await wait(first.execution.id, 'finished')
  await delivery.deliverPersonResults(); delivery.finishPersonDelivery(1, first.execution.id, true)
  expect(vi.mocked(runtime.execute).mock.calls[0][0].workspace).toBe(selected)
  const chat = await personTaskChat(1, first.task.id)
  const nextWorkspace = join(dir, 'next-workspace')
  await configurePerson(1, { workspace: nextWorkspace, expected_revision: 2 })
  expect(store.getPersonTask(1, first.task.id).workspace).toBe(selected)
  expect(store.getPersonTask(1, adopted.task.id).workspace).toBe(selected)
  expect(sessions.getSession(chat.session.id)?.workspace).toBe(selected)
  const next: any = await continuePersonTask(1, first.task.id, { input: [{ type: 'text', text: 'Continue the same work' }], expected_revision: store.getPersonTask(1, first.task.id).revision, idempotency_key: 'workspace-follow-up' })
  await runner.tickPersonWork(); await wait(next.execution.id, 'finished')
  await delivery.deliverPersonResults(); delivery.finishPersonDelivery(1, next.execution.id, true)
  expect(vi.mocked(runtime.execute).mock.calls[1][0]).toMatchObject({ sessionId: chat.session.id, workspace: selected })
  const at = Date.now() + 60_000
  schedules.applyPersonSchedule(1, { action: 'create', mode: 'worker', task_id: second.task.id, kind: 'once', expression: new Date(at).toISOString(), timezone: 'UTC', idempotency_key: 'workspace-schedule' })
  schedules.tickPersonSchedules(at)
  const occurrence = store.taskPersonExecutions(1, second.task.id)[0]
  await runner.tickPersonWork(); await wait(occurrence.id, 'finished')
  expect(vi.mocked(runtime.execute).mock.calls[2][0].workspace).toBe(selected)
  expect((await personSnapshot(2, 'person-main-2')).session.workspace).not.toBe(nextWorkspace)
})

it('restores a shared private workspace when the selected workspace is cleared', async () => {
  const { configurePerson, personSnapshot } = await import('../../packages/server/src/modules/studio/services/person/service')
  await expect(configurePerson(1, { workspace: '../relative', expected_revision: 1 })).rejects.toThrow('absolute')
  await configurePerson(1, { workspace: '', expected_revision: 1 })
  const snapshot = await personSnapshot(1, 'person-main-1')
  const a = await create({ start: false }); const b = await create({ start: false })
  expect(a.task.workspace).toBe(snapshot.session.workspace)
  expect(b.task.workspace).toBe(a.task.workspace)
  expect(existsSync(a.task.workspace)).toBe(true)
  await expect(configurePerson(1, { workspace: dir, expected_revision: 1 })).rejects.toThrow('changed')
})

it('atomically clears only Person history and tasks, retaining memory, preferences, ordinary chats and files', async () => {
  const { ensurePersonSession } = await import('../../packages/server/src/modules/studio/services/person/chat-agent')
  const { personSnapshot } = await import('../../packages/server/src/modules/studio/services/person/service')
  const { clearPerson } = await import('../../packages/server/src/modules/studio/services/person/history')
  const { personTaskChat } = await import('../../packages/server/src/modules/studio/services/person/task-chat')
  const sessions = await import('../../packages/server/src/modules/studio/repositories/session-store')
  const { savePersonTaskReturn } = await import('../../packages/server/src/modules/studio/repositories/person-return-store')
  await ensurePersonSession(1, 'person-main-1'); await ensurePersonSession(2, 'person-main-2')
  sessions.addMessage({ session_id: 'person-main-1', role: 'user', content: 'Clear this conversation' })
  const assistant = sessions.addMessage({ session_id: 'person-main-1', role: 'assistant', content: 'Old result' })
  sessions.addMessage({ session_id: 'person-main-2', role: 'user', content: 'Other account history' })
  sessions.createSession({ id: 'ordinary-kept', studio_user_id: '1', profile: 'default' })
  sessions.addMessage({ session_id: 'ordinary-kept', role: 'user', content: 'Keep ordinary chat' })
  const { personMemory, personMemories } = await import('../../packages/server/src/modules/studio/services/person/memory')
  const nativeMemory = personMemory(1)
  await nativeMemory.service.write({ operation: 'create', kind: 'profile_name', identity: nativeMemory.identity, reason: 'User name', node: { title: 'Name', content: 'User name is ekko', valueJson: 'ekko' } })
  const memoriesBefore = await personMemories(1)
  expect(memoriesBefore).toHaveLength(1)
  const { openPersonContextStore } = await import('../../packages/server/src/modules/studio/repositories/person-context-store')
  const context = openPersonContextStore(1, 'person-main-1')
  context.search('conversation'); context.summaries.set('before-clear', 'Old summary')
  const otherContext = openPersonContextStore(2, 'person-main-2')
  otherContext.search('history'); otherContext.summaries.set('other-summary', 'Keep other account summary')
  const other = store.createPersonTask(2, 'Other account task', 'Keep this task', selection, dir, 'person-main-2')
  const { task, execution } = await create()
  const chat = await personTaskChat(1, task.id)
  sessions.addMessage({ session_id: chat.session.id, role: 'user', content: 'Private worker input' })
  store.setPersonExecution(execution, 'finished', { output: 'Old result' })
  db.prepare("UPDATE person_deliveries SET state='delivered' WHERE execution_id=?").run(execution.id)
  store.personEvent(execution, 'run.finished', { output: 'Old result' })
  store.addPersonInteraction(1, execution, 'old-question', 'Old question', [])
  savePersonTaskReturn(1, execution.id, 'person-main-1', assistant)
  const schedule = schedules.applyPersonSchedule(1, { action: 'create', mode: 'worker', task_id: task.id, kind: 'cron', expression: '0 9 * * *', timezone: 'UTC', idempotency_key: 'clear-schedule' })
  db.prepare('INSERT INTO person_occurrences(id,schedule_id,revision,scheduled_at,state,execution_id) VALUES (?,?,?,?,?,?)').run('past-occurrence', schedule.id, 0, 1, 'finished', execution.id)
  const file = join(dir, 'keep-result.txt'); writeFileSync(file, 'Keep the output file')
  const settingsBefore = store.personSettings(1)
  expect((await personSnapshot(1, 'person-main-1')).can_clear).toBe(true)
  expect(await clearPerson(1, { session_id: 'person-main-1', expected_history_revision: 0 })).toMatchObject({ cleared: true, deleted_tasks: 1 })
  expect(sessions.getSessionDetail('person-main-1')?.messages).toEqual([])
  expect(sessions.getSession('person-main-1')?.history_revision).toBe(1)
  expect(sessions.getSession(chat.session.id)).toBeNull()
  expect(sessions.getSessionDetail('person-main-2')?.messages).toHaveLength(1)
  expect(sessions.getSessionDetail('ordinary-kept')?.messages).toHaveLength(1)
  expect(store.getPersonTask(2, other.id).title).toBe('Other account task')
  expect(store.listPersonTasks(1)).toEqual([])
  expect(store.personSettings(1)).toEqual(settingsBefore)
  expect(await personMemories(1)).toEqual(memoriesBefore)
  for (const table of ['person_context_chunks', 'person_context_summaries', 'person_context_progress']) {
    expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id='person-main-1'`).get()?.n).toBe(0)
    expect(Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id='person-main-2'`).get()?.n)).toBeGreaterThan(0)
  }
  expect(() => context.search('conversation')).toThrow('history changed')
  expect(openPersonContextStore(1, 'person-main-1').search('conversation').evidence).toEqual([])
  expect(existsSync(file)).toBe(true)
  for (const table of ['person_executions', 'person_events', 'person_interactions', 'person_schedules', 'person_task_returns', 'person_deliveries', 'person_task_origins', 'person_operations']) {
    expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE owner_user_id=1`).get()?.n).toBe(0)
  }
  expect(db.prepare('SELECT COUNT(*) AS n FROM person_occurrences').get()?.n).toBe(0)
  expect(clearHistoryMock).toHaveBeenCalledWith('person-main-1', { historyAlreadyCleared: true })
  expect(disposeSessionMock).toHaveBeenCalledWith(chat.session.id)
  const { deliverPersonResults } = await import('../../packages/server/src/modules/studio/services/person/delivery')
  await deliverPersonResults(); expect(runtime.deliver).not.toHaveBeenCalled()
  sessions.addMessage({ session_id: 'person-main-1', role: 'user', content: 'Fresh conversation' })
  await expect(clearPerson(1, { session_id: 'person-main-1', expected_history_revision: 0 })).rejects.toThrow('changed')
  expect(sessions.getSessionDetail('person-main-1')?.messages).toHaveLength(1)
})

it.each(['pending','queued','starting','running','waiting_person','waiting_user','waiting_approval','stopping','pending_delivery','queued_delivery','main_reply'])('rejects clearing while %s without removing records', async state => {
  const { ensurePersonSession } = await import('../../packages/server/src/modules/studio/services/person/chat-agent')
  const { clearPerson } = await import('../../packages/server/src/modules/studio/services/person/history')
  const { personSnapshot } = await import('../../packages/server/src/modules/studio/services/person/service')
  const sessions = await import('../../packages/server/src/modules/studio/repositories/session-store')
  await ensurePersonSession(1, 'person-main-1')
  sessions.addMessage({ session_id: 'person-main-1', role: 'user', content: 'Keep while running' })
  const { task, execution } = await create()
  if (state.endsWith('_delivery')) {
    store.setPersonExecution(execution, 'finished')
    db.prepare('UPDATE person_deliveries SET state=? WHERE execution_id=?').run(state.startsWith('pending') ? 'pending' : 'queued', execution.id)
  } else if (state === 'main_reply') { mainBusy = true }
  else db.prepare('UPDATE person_executions SET state=? WHERE id=?').run(state, execution.id)
  expect((await personSnapshot(1, 'person-main-1')).can_clear).toBe(false)
  await expect(clearPerson(1, { session_id: 'person-main-1', expected_history_revision: 0 })).rejects.toThrow('finish')
  expect(store.getPersonTask(1, task.id)).toBeTruthy()
  expect(sessions.getSessionDetail('person-main-1')?.messages).toHaveLength(1)
  mainBusy = false
})


describe('Person multi-conversation ownership', () => {
  async function requestWithDirectory() {
    const { createPersonAgent } = await import('../../packages/server/src/bootstrap/person-chat-agent')
    const { createPersonChatAgent } = await import('../../packages/server/src/modules/studio/services/person/chat-agent')
    runtime.chatAgent = createPersonAgent
    const requests: import('../../packages/ekko-agent/src/model/types').ModelRequest[] = []
    const agent = await createPersonChatAgent(1, 'person-main-1')
    await agent.run({ messages: [{ role: 'user', content: '你好' }],
      modelClient: { provider: 'test', capabilities: { streaming: true, tools: true, vision: false, jsonMode: false, systemPrompt: true },
        create: async () => ({ content: 'summary' }), async *stream(request) { requests.push(request); yield { type: 'done', response: { content: '你好' } } } } })
    expect(requests).toHaveLength(1)
    const prompt = requests[0].messages.filter(message => message.role === 'system').map(message => message.content).join('\n')
    const line = prompt.split('\n').find(value => value.startsWith('Account conversations: '))!
    const entries = JSON.parse(line.slice('Account conversations: '.length)) as Array<{ id: string; title: string | null; current?: boolean }>
    expect(entries.filter(entry => entry.current)).toHaveLength(1)
    expect(prompt).toContain('The current:true role is YOU: requests naming it are your work.')
    return { prompt, currentId: entries.find(entry => entry.current)!.id, directory: entries.map(({ id, title }) => ({ id, title })) }
  }

  it('includes the full owned conversation directory in the model request beyond search page limits', async () => {
    const { createSession, addMessage } = await import('../../packages/server/src/modules/studio/repositories/session-store')
    const { beginPersonSessionDeletion } = await import('../../packages/server/src/modules/studio/repositories/person-session-store')
    modelContextLength = 32000
    const expected = [{ id: 'person-main-1', title: 'Conversation 1' }]
    for (let i = 0; i < 105; i++) {
      const entry = { id: `person-main-directory-${i}`, title: i === 0 ? '文案"\n自定义名称' : `会话 ${i}` }
      createSession({ ...entry, studio_user_id: 1, source: 'builtin_agent', agent: 'ekko-agent', profile: i % 2 ? 'other-profile' : 'default' })
      expected.push(entry)
    }
    for (const id of ['ordinary-private', 'person-task-private', 'person-main-deleting']) {
      createSession({ id, title: id, studio_user_id: 1, source: 'builtin_agent', profile: 'default' })
    }
    addMessage({ session_id: expected[1].id, role: 'user', content: 'History must not become directory data' })
    const release = beginPersonSessionDeletion(1, 'person-main-deleting')
    try {
      const { prompt, directory, currentId } = await requestWithDirectory()
      expect(directory).toHaveLength(expected.length)
      expect(directory).toEqual(expect.arrayContaining(expected))
      expect(currentId).toBe('person-main-1')
      expect(directory).toContainEqual({ id: 'person-main-1', title: 'Conversation 1' })
      for (const excluded of ['person-main-2', 'ordinary-private', 'person-task-private', 'person-main-deleting', 'History must not become directory data']) {
        expect(prompt).not.toContain(excluded)
      }
    } finally { release() }
  })

  it('refreshes the directory and current name on the next turn after create, rename and delete', async () => {
    const { createPersonConversation, deletePersonConversation } = await import('../../packages/server/src/modules/studio/services/person/conversations')
    const { updateSession } = await import('../../packages/server/src/modules/studio/repositories/session-store')
    const b = await createPersonConversation(1, '文案')
    expect((await requestWithDirectory()).directory).toContainEqual({ id: b.id, title: '文案' })
    updateSession('person-main-1', { title: '老板' })
    updateSession(b.id, { title: '新的会话名' })
    const c = await createPersonConversation(1, '程序员')
    const updated = await requestWithDirectory()
    expect(updated.directory).toEqual(expect.arrayContaining([
      { id: 'person-main-1', title: '老板' }, { id: b.id, title: '新的会话名' }, { id: c.id, title: '程序员' },
    ]))
    expect(updated.currentId).toBe('person-main-1')
    await deletePersonConversation(1, b.id, b.history_revision)
    const next = await requestWithDirectory()
    expect(next.directory).toHaveLength(2)
    expect(next.directory.map(entry => entry.id)).not.toContain(b.id)
  })

  it('binds an implicit task destination before checking idempotent retries', async () => {
    const { createPersonConversation } = await import('../../packages/server/src/modules/studio/services/person/conversations')
    const b = await createPersonConversation(1, 'B')
    const request = { action: 'create', title: 'Same request', goal: 'Do work', start: false, idempotency_key: 'same-key' }
    const origin = { sessionId: 'person-main-1', runId: 'A-run', messages: [] }
    const first = await tasks.applyPersonTask(1, request, undefined, origin)
    expect((await tasks.applyPersonTask(1, request, undefined, origin)).task.id).toBe(first.task.id)
    await expect(tasks.applyPersonTask(1, request, undefined, { ...origin, sessionId: b.id })).rejects.toThrow('another operation')
    expect(store.listPersonTasks(1, '', 0, { sessionId: b.id })).toEqual([])
  })

  it('clears only B while A is replying and rejects clearing a deleting session', async () => {
    const { createPersonConversation } = await import('../../packages/server/src/modules/studio/services/person/conversations')
    const { beginPersonSessionDeletion } = await import('../../packages/server/src/modules/studio/repositories/person-session-store')
    const { clearPerson } = await import('../../packages/server/src/modules/studio/services/person/history')
    const { addMessage, getSessionDetail } = await import('../../packages/server/src/modules/studio/repositories/session-store')
    const b = await createPersonConversation(1, 'B')
    addMessage({ session_id: 'person-main-1', role: 'user', content: 'Keep A' })
    addMessage({ session_id: b.id, role: 'user', content: 'Clear B' })
    mainBusy = 'person-main-1'
    await expect(clearPerson(1, { session_id: b.id, expected_history_revision: 0 })).resolves.toMatchObject({ cleared: true })
    expect(getSessionDetail('person-main-1')!.messages).toHaveLength(1)
    expect(getSessionDetail(b.id)!.messages).toHaveLength(0)
    const release = beginPersonSessionDeletion(1, b.id)
    try { await expect(clearPerson(1, { session_id: b.id, expected_history_revision: 1 })).rejects.toThrow('being deleted') }
    finally { release() }
  })

  it('creates named dynamic conversations and searches only owned Person content', async () => {
    const { createPersonConversation, personConversations } = await import('../../packages/server/src/modules/studio/services/person/conversations')
    const { personSnapshot } = await import('../../packages/server/src/modules/studio/services/person/service')
    const { createSession, addMessage } = await import('../../packages/server/src/modules/studio/repositories/session-store')
    expect((await personSnapshot(1)).session).toBeNull()
    const a = await createPersonConversation(1, '研发')
    const b = await createPersonConversation(1, '旅行')
    expect(a.id).not.toBe(b.id)
    expect(a.id).toMatch(/^person-main-[a-f0-9-]{36}$/)
    expect(a.bot_type).toBe('zhezhe')
    expect((await personSnapshot(1, a.id)).session?.bot_type).toBe('zhezhe')
    addMessage({ session_id: b.id, role: 'user', content: '独有线索 NEEDLE-MULTI' })
    addMessage({ session_id: 'person-main-2', role: 'user', content: 'NEEDLE-MULTI private' })
    createSession({ id: 'ordinary-search', user_id: 1, studio_user_id: 1, title: 'NEEDLE-MULTI', source: 'api_server', profile: 'default' })
    expect(personConversations(1, 'NEEDLE-MULTI').sessions.map(session => session.id)).toEqual([b.id])
    expect((await personSnapshot(1, a.id)).settings.agents).toEqual((await personSnapshot(1, b.id)).settings.agents)
    expect(personConversations(2, 'NEEDLE-MULTI').sessions.map(session => session.id)).toEqual(['person-main-2'])
    await expect(createPersonConversation(1, '  ')).rejects.toThrow('conversation name')
  })

  it('rejects duplicate BOT names across all owned pages and concurrent creates', async () => {
    const { createPersonConversation } = await import('../../packages/server/src/modules/studio/services/person/conversations')
    const { createSession } = await import('../../packages/server/src/modules/studio/repositories/session-store')
    for (let i = 0; i < 55; i++) createSession({ id: `person-main-page-${i}`, studio_user_id: 1, title: `Bot ${i}` })
    const count = db.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n
    await expect(createPersonConversation(1, '  ＢＯＴ ０  ')).rejects.toMatchObject({ status: 409, code: 'PERSON_BOT_NAME_EXISTS' })
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n).toBe(count)
    await expect(createPersonConversation(2, 'Bot 0')).resolves.toMatchObject({ title: 'Bot 0' })
    createSession({ id: 'ordinary-same-name', studio_user_id: 1, title: 'Helper' })
    const results = await Promise.allSettled([createPersonConversation(1, 'Helper'), createPersonConversation(1, 'helper')])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 409, code: 'PERSON_BOT_NAME_EXISTS' } })
    const { conversationCreate } = await import('../../packages/server/src/modules/studio/controllers/person')
    const ctx: any = { set: vi.fn(), state: { user: { id: 1 } }, request: { body: { title: 'Helper' } } }
    await conversationCreate(ctx)
    expect(ctx).toMatchObject({ status: 409, body: { code: 'PERSON_BOT_NAME_EXISTS' } })
  })

  it('commits a selected shared workspace with creation and rejects stale or busy changes', async () => {
    const { createPersonConversation } = await import('../../packages/server/src/modules/studio/services/person/conversations')
    const { getSession } = await import('../../packages/server/src/modules/studio/repositories/session-store')
    const old = store.personSettings(1)
    const workspace = join(dir, 'chosen')
    const created = await createPersonConversation(1, 'Workspace bot', { workspace, expected_revision: old.revision })
    expect(created.workspace).toBe(workspace)
    expect(store.personSettings(1)).toMatchObject({ settings: { workspace }, revision: old.revision + 1 })
    expect(getSession('person-main-1')?.workspace).toBe(workspace)
    expect(existsSync(workspace)).toBe(true)
    const before = db.prepare('SELECT id,workspace FROM sessions ORDER BY id').all()
    await expect(createPersonConversation(1, 'Stale', { workspace: dir, expected_revision: old.revision })).rejects.toThrow('Settings changed')
    await expect(createPersonConversation(1, 'Relative', { workspace: 'relative' })).rejects.toThrow('absolute')
    mainBusy = true
    await expect(createPersonConversation(1, 'Busy', { workspace: dir, expected_revision: old.revision + 1 })).rejects.toThrow('Wait for Person')
    mainBusy = false
    await expect(createPersonConversation(1, 'workspace bot', { workspace: dir, expected_revision: old.revision + 1 })).rejects.toMatchObject({ code: 'PERSON_BOT_NAME_EXISTS' })
    expect(db.prepare('SELECT id,workspace FROM sessions ORDER BY id').all()).toEqual(before)
    expect(store.personSettings(1).settings.workspace).toBe(workspace)
    const task = await create()
    await expect(createPersonConversation(1, 'Pending task', { workspace: dir, expected_revision: old.revision + 1 })).rejects.toThrow('Wait for Person')
    expect(store.getPersonTask(1, task.task.id).workspace).toBe(workspace)
  })

  it('creates and reloads every supplied character without coupling its identity to the conversation name', async () => {
    const { createPersonConversation, personConversations } = await import('../../packages/server/src/modules/studio/services/person/conversations')
    const { personSnapshot } = await import('../../packages/server/src/modules/studio/services/person/service')
    for (const bot of PERSON_BOTS) {
      const created = await createPersonConversation(1, `My ${bot.type} companion`, { bot_type: bot.type })
      expect(created.bot_type).toBe(bot.type)
      expect((await personSnapshot(1, created.id)).session?.bot_type).toBe(bot.type)
      expect(personConversations(1).sessions.find(session => session.id === created.id)?.bot_type).toBe(bot.type)
    }
  })

  it('stores bot type separately from the name and isolates initial model settings', async () => {
    const { createPersonConversation, personConversations } = await import('../../packages/server/src/modules/studio/services/person/conversations')
    const { personSnapshot } = await import('../../packages/server/src/modules/studio/services/person/service')
    catalog[0].models.push('m2')
    const before = store.personSettings(1, 'person-main-1')
    const created = await createPersonConversation(1, '我的旅行搭子', { bot_type: 'zhezhe', model: { profile: 'default', provider: 'test', model: 'm2' }, reasoning_effort: 'high' })
    expect(created).toMatchObject({ title: '我的旅行搭子', bot_type: 'zhezhe', model: 'm2', reasoning_effort: 'high' })
    expect(personConversations(1).sessions.find(session => session.id === created.id)?.bot_type).toBe('zhezhe')
    expect((await personSnapshot(1, created.id)).settings.model?.model).toBe('m2')
    expect(store.personSettings(1, 'person-main-1')).toEqual(before)
    const count = personConversations(1).sessions.length
    for (const input of [{ bot_type: 'unknown' }, { model: { profile: 'default', provider: 'test', model: 'missing' } }, { reasoning_effort: 'invalid' }]) {
      await expect(createPersonConversation(1, 'Invalid', input)).rejects.toThrow()
    }
    expect(personConversations(1).sessions).toHaveLength(count)
  })

  it('backfills legacy bot types without overwriting explicit types or conversation history', async () => {
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    const { createSession, getSession, addMessage } = await import('../../packages/server/src/modules/studio/repositories/session-store')
    createSession({ id: 'person-main-future', studio_user_id: 1, bot_type: 'future-bot', title: 'Future' })
    createSession({ id: 'ordinary-chat', studio_user_id: 1, title: 'Ordinary' })
    addMessage({ session_id: 'person-main-1', role: 'user', content: 'Keep this history' })
    const before = getSession('person-main-1')!
    initAllHermesTables(); initAllHermesTables()
    expect(getSession('person-main-1')).toEqual({ ...before, bot_type: 'zhezhe' })
    expect(getSession('person-main-future')?.bot_type).toBe('future-bot')
    expect(getSession('ordinary-chat')?.bot_type).toBe('')
    expect(db.prepare('SELECT content FROM messages WHERE session_id=?').get('person-main-1')?.content).toBe('Keep this history')
  })

  it('keeps existing B workers and scheduled results in B when followed up from A', async () => {
    const { createPersonConversation } = await import('../../packages/server/src/modules/studio/services/person/conversations')
    const { personTools } = await import('../../packages/server/src/modules/studio/services/person/tools')
    const { continuePersonTask } = await import('../../packages/server/src/modules/studio/services/person/task-chat')
    const delivery = await import('../../packages/server/src/modules/studio/services/person/delivery')
    const a = await createPersonConversation(1, 'A')
    const b = await createPersonConversation(1, 'B')
    const origin = { sessionId: a.id, runId: 'from-A', messages: [{ role: 'user' as const, content: '让 B 做报告' }] }
    const toolset = personTools(1, 'main', undefined, a.id)
    const sessions: any = await toolset.find(tool => tool.name === 'bot_sessions_query')!.execute({ search: 'B' })
    expect(sessions.sessions).toContainEqual(expect.objectContaining({ session_id: b.id, name: 'B' }))
    const bTools = personTools(1, 'main', undefined, b.id)
    const created: any = await bTools.find(tool => tool.name === 'bot_task_create')!.execute({ title: 'B report', goal: 'Create report' }, {sessionId:b.id,runId:'from-B',messages:[]})
    const task = store.getPersonTask(1, created.task.id)
    expect(task.session_id).toBe(b.id)
    await runner.tickPersonWork(); await wait(created.execution.id, 'finished')
    await delivery.deliverPersonResults()
    expect(vi.mocked(runtime.deliver).mock.calls.at(-1)![0].origin.sessionId).toBe(b.id)
    delivery.finishPersonDelivery(1, created.execution.id, true)
    const next: any = await continuePersonTask(1, task.id, { input: [{ type: 'text', text: 'From A, continue B' }], expected_revision: store.getPersonTask(1, task.id).revision, idempotency_key: 'multi-continue' }, origin)
    await runner.tickPersonWork(); await wait(next.execution.id, 'finished')
    await delivery.deliverPersonResults(); delivery.finishPersonDelivery(1, next.execution.id, true)
    expect(vi.mocked(runtime.deliver).mock.calls.at(-1)![0].origin.sessionId).toBe(b.id)
    await tasks.applyPersonTask(1, { action: 'reopen', task_id: task.id, expected_revision: store.getPersonTask(1, task.id).revision, idempotency_key: 'multi-reopen' })
    const at = Date.now() + 120000
    schedules.applyPersonSchedule(1, { action: 'create', mode: 'worker', task_id: task.id, kind: 'once', expression: new Date(at).toISOString(), timezone: 'UTC', idempotency_key: 'multi-schedule' })
    schedules.tickPersonSchedules(at)
    const occurrence = store.taskPersonExecutions(1, task.id)[0]
    await runner.tickPersonWork(); await wait(occurrence.id, 'finished')
    await delivery.deliverPersonResults(); delivery.finishPersonDelivery(1, occurrence.id, true)
    expect(vi.mocked(runtime.deliver).mock.calls.at(-1)![0].origin.sessionId).toBe(b.id)
    expect(store.listPersonTasks(1, '', 0, { sessionId: a.id })).toEqual([])
    expect(store.listPersonTasks(1, '', 0, { sessionId: b.id }).map(row => row.id)).toEqual([task.id])
    await expect(toolset.find(tool => tool.name === 'bot_task_create')!.execute({ title: 'Foreign', goal: 'Unauthorized', session_id: 'person-main-2' }, origin)).resolves.toMatchObject({ ok: false, error: { code: 'TASK_UNAVAILABLE' } })
  })

  it('deletes only the target conversation graph, preserving other conversations and shared memory', async () => {
    const { createPersonConversation, deletePersonConversation } = await import('../../packages/server/src/modules/studio/services/person/conversations')
    const { getSession, addMessage } = await import('../../packages/server/src/modules/studio/repositories/session-store')
    const { personMemory, personMemories } = await import('../../packages/server/src/modules/studio/services/person/memory')
    const { createPersonContext } = await import('../../packages/server/src/modules/studio/services/person/context')
    const a = await createPersonConversation(1, 'A')
    const b = await createPersonConversation(1, 'B')
    addMessage({ session_id: b.id, role: 'user', content: 'B-only old topic' })
    const context = createPersonContext(1, a.id, 16000)
    const account = personMemory(1)
    await account.service.write({ operation: 'create', kind: 'profile_name', identity: account.identity, reason: 'User name', node: { title: 'Name', content: 'User name: Ekko', valueJson: 'Ekko' } })
    const keep = await create({ session_id: a.id, start: false })
    const removed = await create({ session_id: b.id, start: false })
    schedules.applyPersonSchedule(1, { action: 'create', mode: 'worker', task_id: removed.task.id, kind: 'cron', expression: '0 9 * * *', timezone: 'UTC', idempotency_key: 'delete-B-schedule' })
    await deletePersonConversation(1, b.id, getSession(b.id)!.history_revision)
    expect(getSession(b.id)).toBeNull()
    expect(getSession(a.id)).toBeTruthy()
    expect(store.getPersonTask(1, keep.task.id)).toBeTruthy()
    expect(() => store.getPersonTask(1, removed.task.id)).toThrow('not found')
    expect(store.listPersonSchedules(1)).toEqual([])
    expect((await personMemories(1)).map(memory => memory.content)).toContain('User name: Ekko')
    expect(() => context.loadHistory('B-only')).toThrow('history changed')
    expect(createPersonContext(1, a.id, 16000).loadHistory('B-only')[0].content).not.toContain('B-only old topic')
  })

  it('waits for native stop before deleting running work and rejects dispatch into a deleting conversation', async () => {
    const { createPersonConversation, deletePersonConversation } = await import('../../packages/server/src/modules/studio/services/person/conversations')
    const { getSession } = await import('../../packages/server/src/modules/studio/repositories/session-store')
    const b = await createPersonConversation(1, 'Running B')
    let acknowledge!: () => void
    runtime.stop = vi.fn(() => new Promise<void>(resolve => { acknowledge = resolve }))
    runtime.execute = vi.fn(input => new Promise(resolve => input.signal.addEventListener('abort', () => resolve({ ok: true, output: 'Late output must be ignored' }), { once: true })))
    const result = await create({ session_id: b.id })
    await runner.tickPersonWork()
    const deleting = deletePersonConversation(1, b.id, getSession(b.id)!.history_revision)
    await vi.waitFor(() => expect(runtime.stop).toHaveBeenCalled())
    expect(getSession(b.id)).toBeTruthy()
    await expect(create({ session_id: b.id })).rejects.toThrow('being deleted')
    acknowledge(); await deleting
    expect(getSession(b.id)).toBeNull()
    expect(db.prepare('SELECT execution_id FROM person_deliveries WHERE execution_id=?').get(result.execution.id)).toBeUndefined()
    expect(runtime.deliver).not.toHaveBeenCalled()
  })

  it('retains a conversation when native stop fails and completes cleanup on retry', async () => {
    const { createPersonConversation, deletePersonConversation } = await import('../../packages/server/src/modules/studio/services/person/conversations')
    const { getSession } = await import('../../packages/server/src/modules/studio/repositories/session-store')
    const { requirePersonSession } = await import('../../packages/server/src/modules/studio/repositories/person-session-store')
    const b = await createPersonConversation(1, 'Retry B')
    const { task, execution } = await create({ session_id: b.id })
    db.prepare("UPDATE person_executions SET state='running',generation=1 WHERE id=?").run(execution.id)
    vi.mocked(runtime.stop).mockRejectedValueOnce(new Error('Native stop unavailable'))
    await expect(deletePersonConversation(1, b.id, 0)).rejects.toThrow('Native stop unavailable')
    expect(requirePersonSession(1, b.id).id).toBe(b.id)
    expect(store.getPersonTask(1, task.id).execution_state).toBe('stopping')
    await expect(deletePersonConversation(1, b.id, 0)).resolves.toMatchObject({ deleted: true })
    expect(getSession(b.id)).toBeNull()
    expect(() => store.getPersonTask(1, task.id)).toThrow('not found')
  })
})


it('discards obsolete account-only tasks without migrating their executions into a conversation', async () => {
  const { initPersonTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/person-schema')
  const retained = await create({ start: false })
  const obsolete = await create({ start: false })
  db.prepare('UPDATE session_tasks SET session_id=NULL WHERE id=?').run(obsolete.task.id)
  initPersonTables(db)
  expect(() => store.getPersonTask(1, obsolete.task.id)).toThrow('not found')
  expect(store.getPersonTask(1, retained.task.id).session_id).toBe('person-main-1')
  expect(store.personSettings(1).settings.agents).toHaveLength(1)
})

describe('legacy Person planned role flow', () => {
  async function fixture() {
    const { createPersonConversation } = await import('../../packages/server/src/modules/studio/services/person/conversations')
    const { personTools } = await import('../../packages/server/src/modules/studio/services/person/tools')
    const b = await createPersonConversation(1, '文案'), c = await createPersonConversation(1, '程序员')
    const role = (id: string, executionId?: string) => {
      const tools = personTools(1, 'main', undefined, id)
      const origin = { sessionId: id, runId: `role-${id}`, messages: [{ role: 'user' as const, content: '按保存的流程处理同一份成果' }], ...(executionId ? { returnExecutionId: executionId } : {}) }
      return (name: string, args: Record<string, unknown>) => tools.find(tool => tool.name === name)!.execute(args, origin) as Promise<any>
    }
    const boss = role('person-main-1')
    const legacy = await tasks.applyPersonTask(1, { action:'create',idempotency_key:crypto.randomUUID(), session_id: b.id, title: '多角色页面任务', goal: '生成页面文案', return_expectation: '检查措辞，通过后推进。',
      next_steps: [{ session_id: c.id, goal: '将已审核文案实现为页面', return_expectation: '检查实现并移交汇总。' },
        { session_id: 'person-main-1', goal: '整理最终成果', return_expectation: '向用户汇总完成结果。' }] })
    // Seed the original creator of an already persisted legacy flow.
    db.prepare('UPDATE session_tasks SET requirements_json=? WHERE id=?').run(JSON.stringify({...JSON.parse(legacy.task.requirements_json),creator_session_id:'person-main-1'}),legacy.task.id)
    legacy.task=store.getPersonTask(1,legacy.task.id)
    const created = {ok:true,...legacy,task:{...legacy.task,task_ref:`${legacy.task.id}:${legacy.task.revision}`}}
    return { b, c, boss, role, created }
  }

  it('moves one task along the original route and preserves creator, outputs, worker session and return receipts', async () => {
    const { b, c, role, created } = await fixture()
    const delivery = await import('../../packages/server/src/modules/studio/services/person/delivery')
    const { savePersonTaskReturn, withPersonTaskReturns } = await import('../../packages/server/src/modules/studio/repositories/person-return-store')
    const { addMessage } = await import('../../packages/server/src/modules/studio/repositories/session-store')
    const taskId = created.task.id
    let executionId = created.execution.id
    for (const [index, current, target] of [[0, b.id, c.id], [1, c.id, 'person-main-1'], [2, 'person-main-1', null]] as const) {
      await runner.tickPersonWork(); await wait(executionId, 'finished')
      expect(store.getPersonTask(1, taskId).status).toBe('open')
      await delivery.deliverPersonResults()
      expect(vi.mocked(runtime.deliver).mock.calls.at(-1)![0]).toMatchObject({ origin: { sessionId: current }, flow: { index, next_session_id: target }, returnExpectation: expect.any(String) })
      const call = role(current, executionId)
      const snapshot = await call('bot_tasks_query', { task_id: taskId })
      expect(snapshot.task.creator_session_id).toBe('person-main-1')
      expect(snapshot.task.allowed_actions).toContain('advance')
      expect(await call('bot_task_control', { action: 'advance', task_ref: snapshot.task.task_ref, session_id: 'person-main-1', message: '跳过阶段' })).toMatchObject({ ok: false })
      expect(await call('bot_task_create', { title: '替代任务', goal: '绕过保存路线' })).toMatchObject({ ok: false, error: { code: 'ACCESS_DENIED' } })
      const request = { action: 'advance', task_ref: snapshot.task.task_ref, message: `阶段 ${index} 已核对，成果 result.txt` }
      const next = await call('bot_task_control', request)
      expect(next.ok).toBe(true)
      expect(await call('bot_task_control', request)).toMatchObject({ ok: true, replayed: true })
      expect(next.task).toMatchObject({ id: taskId, session_id: target || current, creator_session_id: 'person-main-1', status: target ? 'open' : 'completed' })
      const reply = addMessage({ session_id: current, role: 'assistant', content: '本阶段处理完成' })
      expect(savePersonTaskReturn(1, executionId, current, reply)).toMatchObject({ taskId, executionId })
      expect(withPersonTaskReturns(current, [{ id: reply, role: 'assistant' }])[0]).toHaveProperty('person_task_return.taskId', taskId)
      expect(store.getPersonExecution(1, executionId).output).toContain('result.txt')
      if (target) {
        expect(next.execution.id).not.toBe(executionId)
        expect(store.getPersonExecution(1, next.execution.id).session_id).toBe(`person-task-${next.execution.id}`)
        expect(JSON.parse(store.getPersonTask(1, taskId).requirements_json).handoff).toMatchObject({ execution_id: executionId, output: expect.stringContaining('result.txt') })
        executionId = next.execution.id
      }
    }
    expect(store.listPersonTasks(1)).toHaveLength(1)
    expect(store.taskPersonExecutions(1, taskId)).toHaveLength(3)
    expect(db.prepare("SELECT COUNT(*) AS n FROM person_events WHERE kind='flow.transferred'").get()?.n).toBe(2)
    const completed = store.getPersonTask(1, taskId)
    await expect(tasks.applyPersonTask(1, { action: 'advance', task_id: taskId, expected_revision: completed.revision, message: '再推进', idempotency_key: 'after-end' })).rejects.toThrow('Flow is stopped, complete or unavailable')
    const secondPrompt = vi.mocked(runtime.execute).mock.calls[1][0].prompt
    expect(typeof secondPrompt).toBe('string')
    expect(secondPrompt).toContain('将已审核文案实现为页面')
    expect(secondPrompt).toContain('阶段 0')
    expect(secondPrompt).toContain('Created result.txt with 42')
    expect(secondPrompt).not.toContain('"flow"')
    const finalRole = role('person-main-1')
    const afterCompletion = await finalRole('bot_tasks_query', { task_id: taskId })
    const followup = await finalRole('bot_task_control', { action: 'continue', task_ref: afterCompletion.task.task_ref, message: '补充最终说明' })
    expect(followup).toMatchObject({ ok: true, task: { id: taskId, flow: { completed: false, index: 2 } } })
    await runner.tickPersonWork(); await wait(followup.execution.id, 'finished')
    await delivery.deliverPersonResults()
    expect(vi.mocked(runtime.deliver).mock.calls.at(-1)![0]).toMatchObject({ executionId: followup.execution.id, origin: { sessionId: 'person-main-1' }, flow: { next_session_id: null } })
  })

  it.each(['queued', 'running', 'pending_return', 'queued_return', 'between_stages'])('allows the original creator to stop after transfer during %s', async phase => {
    const { b, c, boss, role, created } = await fixture()
    const delivery = await import('../../packages/server/src/modules/studio/services/person/delivery')
    await runner.tickPersonWork(); await wait(created.execution.id, 'finished')
    await delivery.deliverPersonResults()
    const receiver = role(b.id, created.execution.id)
    const first = await receiver('bot_tasks_query', { task_id: created.task.id })
    const next = await receiver('bot_task_control', { action: 'advance', task_ref: first.task.task_ref, message: '通过，继续下一阶段' })
    expect(next.ok).toBe(true)
    if (phase === 'running') {
      runtime.execute = vi.fn(input => new Promise(resolve => { input.onEvent('run.started', {}); input.signal.addEventListener('abort', () => resolve({ ok: false, error: 'Stopped' }), { once: true }) }))
      await runner.tickPersonWork(); await wait(next.execution.id, 'running')
    } else if (phase !== 'queued') {
      await runner.tickPersonWork(); await wait(next.execution.id, 'finished')
      if (phase !== 'pending_return') await delivery.deliverPersonResults()
      if (phase === 'between_stages') delivery.finishPersonDelivery(1, next.execution.id, true)
    }
    const receivingRole = role(c.id, next.execution.id)
    const beforeStop = await receivingRole('bot_tasks_query', { task_id: created.task.id })
    const snapshot = await boss('bot_tasks_query', { task_id: created.task.id })
    expect(snapshot.task.allowed_actions).toEqual(['stop'])
    const stopped = await boss('bot_task_control', { action: 'stop', task_ref: snapshot.task.task_ref })
    expect(stopped.ok).toBe(true)
    expect(stopped.task).toMatchObject({ session_id: c.id, creator_session_id: 'person-main-1', flow: { stopped: true } })
    if (phase === 'running') await wait(next.execution.id, 'interrupted')
    expect(await receivingRole('bot_task_control', { action: 'advance', task_ref: beforeStop.task.task_ref, message: '迟到回调' })).toMatchObject({ ok: false })
    await expect(tasks.applyPersonTask(1, { action: 'advance', task_id: created.task.id, expected_revision: store.getPersonTask(1, created.task.id).revision, message: '继续', idempotency_key: 'stopped-advance' })).rejects.toThrow('stopped')
    await runner.tickPersonWork()
    expect(store.taskPersonExecutions(1, created.task.id)).toHaveLength(2)
    expect(delivery.personDeliveryCurrent(1, next.execution.id)).toBe(false)
    expect(db.prepare("SELECT COUNT(*) AS n FROM person_deliveries WHERE state IN ('waiting','pending','queued')").get()?.n).toBe(0)
    expect((await role(c.id)('bot_tasks_query', { task_id: created.task.id })).task.allowed_actions).toEqual([])
    const latest = await boss('bot_tasks_query', { task_id: created.task.id })
    expect(await boss('bot_task_control', { action: 'reopen', task_ref: latest.task.task_ref })).toMatchObject({ ok: true, task: { flow: { stopped: false } } })
  })

  it('keeps failed work in its current stage and rejects stale callbacks after stop and reopen', async () => {
    const { b, boss, role, created } = await fixture()
    runtime.execute = vi.fn(async () => ({ ok: false, error: 'Generation failed' }))
    await runner.tickPersonWork(); await wait(created.execution.id, 'failed')
    const delivery = await import('../../packages/server/src/modules/studio/services/person/delivery')
    await delivery.deliverPersonResults()
    const receiving = role(b.id, created.execution.id)
    const first = await receiving('bot_tasks_query', { task_id: created.task.id })
    expect(first.task.allowed_actions).not.toContain('advance')
    const snapshot = await boss('bot_tasks_query', { task_id: created.task.id })
    expect(await boss('bot_task_control', { action: 'stop', task_ref: snapshot.task.task_ref })).toMatchObject({ ok: true })
    const stopped = store.getPersonTask(1, created.task.id)
    await expect(tasks.applyPersonTask(1, { action: 'reopen', task_id: stopped.id, expected_revision: stopped.revision, idempotency_key: 'wrong-resumer' }, undefined,
      { sessionId: b.id, runId: '', messages: [] })).rejects.toThrow('Only the creator')
    const last = await boss('bot_tasks_query', { task_id: created.task.id })
    expect(await boss('bot_task_control', { action: 'reopen', task_ref: last.task.task_ref })).toMatchObject({ ok: true })
    expect(delivery.personDeliveryCurrent(1, created.execution.id)).toBe(false)
    const { createPersonAgent } = await import('../../packages/server/src/bootstrap/person-chat-agent')
    const { createPersonChatAgent } = await import('../../packages/server/src/modules/studio/services/person/chat-agent')
    runtime.chatAgent = createPersonAgent
    const lateCallback = await createPersonChatAgent(1, b.id, created.execution.id)
    await expect(lateCallback.run({ messages: [{ role: 'user', content: '迟到回流' }] })).rejects.toThrow('Task result callback was cancelled')
    const ref = await receiving('bot_tasks_query', { task_id: created.task.id })
    expect(await receiving('bot_task_control', { action: 'continue', task_ref: ref.task.task_ref, message: 'Late retry' })).toMatchObject({ ok: false })
    expect(store.taskPersonExecutions(1, created.task.id)).toHaveLength(1)
    expect(store.getPersonTask(1, created.task.id).session_id).toBe(b.id)
  })

  it('rejects foreign destinations, route replacement, stale revisions and removed next roles atomically', async () => {
    const { b, c, role, created } = await fixture()
    await expect(create({ next_steps: [{ session_id: 'person-main-2', goal: 'foreign', return_expectation: 'report' }] })).rejects.toThrow()
    await expect(create({ creator_session_id: c.id })).rejects.toThrow('Creator')
    await expect(tasks.applyPersonTask(1, { action: 'update', task_id: created.task.id, expected_revision: 0, next_steps: [], goal: 'replace route', idempotency_key: 'replace' })).rejects.toThrow('fixed at creation')
    await runner.tickPersonWork(); await wait(created.execution.id, 'finished')
    const current = store.getPersonTask(1, created.task.id)
    const request = { action: 'advance', task_id: current.id, expected_revision: current.revision, expected_execution_id: current.execution_id, message: '通过', idempotency_key: 'advance' }
    await expect(tasks.applyPersonTask(1, { ...request, expected_revision: current.revision - 1 })).rejects.toThrow('Task changed')
    await expect(tasks.applyPersonTask(2, request)).rejects.toThrow('Task not found')
    const stranger = role(c.id)
    expect((await stranger('bot_tasks_query', { task_id: current.id })).task.allowed_actions).toEqual([])
    const { beginPersonSessionDeletion } = await import('../../packages/server/src/modules/studio/repositories/person-session-store')
    const release = beginPersonSessionDeletion(1, c.id)
    try { await expect(tasks.applyPersonTask(1, request)).rejects.toThrow() } finally { release() }
    expect(store.getPersonTask(1, current.id)).toMatchObject({ session_id: b.id, revision: current.revision })
    expect(store.taskPersonExecutions(1, current.id)).toHaveLength(1)
    const advanced = await tasks.applyPersonTask(1, request)
    expect(advanced.task.session_id).toBe(c.id)
    expect(await tasks.applyPersonTask(1, request)).toEqual(advanced)
  })
})

describe('isolated scheduled worker conversations', () => {
  it('starts each occurrence fresh and pins historical follow-ups to their own conversation', async () => {
    const { personTaskChat, continuePersonTask, ownedPersonTaskSession } = await import('../../packages/server/src/modules/studio/services/person/task-chat')
    const { addMessage, getSession } = await import('../../packages/server/src/modules/studio/repositories/session-store')
    const { task } = await create({ start: false })
    const schedule = schedules.applyPersonSchedule(1, { action: 'create', mode: 'worker', task_id: task.id, kind: 'cron', expression: '* * * * *', timezone: 'UTC', idempotency_key: 'isolated' })
    schedules.tickPersonSchedules(schedule.next_at)
    const first = store.taskPersonExecutions(1, task.id)[0]
    addMessage({ session_id: first.session_id, role: 'assistant', content: 'First run only' })
    const question = store.addPersonInteraction(1, first, 'old-question', 'Old question', [])
    store.answerPersonInteraction(1, question.id, 0, 'First run answer', 'user')
    await runner.tickPersonWork(); await wait(first.id, 'finished')
    schedules.tickPersonSchedules(store.listPersonSchedules(1)[0].next_at)
    const second = store.taskPersonExecutions(1, task.id)[0]
    expect(second.session_id).not.toBe(first.session_id)
    expect(getSession(second.session_id)?.agent_native_session_id).toBeFalsy()
    await runner.tickPersonWork(); await wait(second.id, 'finished')
    expect(vi.mocked(runtime.execute).mock.calls.slice(0, 2).map(([input]) => input.sessionId)).toEqual([first.session_id, second.session_id])
    expect(vi.mocked(runtime.execute).mock.calls[0][0].prompt).toContain('Old question\n\nAnswer (user): First run answer')
    expect(vi.mocked(runtime.execute).mock.calls[1][0].prompt).toContain('# Compute result\n\nWrite 42 into result.txt\n\n## Dispatch contract')
    expect(String(vi.mocked(runtime.execute).mock.calls[1][0].prompt)).not.toContain('First run answer')
    expect((await personTaskChat(1, task.id)).session?.id).toBe(second.session_id)
    expect((await personTaskChat(1, task.id, first.id)).session?.id).toBe(first.session_id)
    expect(store.listPersonTasks(1)).toHaveLength(1)
    const current = store.getPersonTask(1, task.id)
    const next = await continuePersonTask(1, task.id, { input: [{ type: 'text', text: 'Explain the first result' }], execution_id: first.id,
      expected_execution_id: second.id, expected_revision: current.revision, idempotency_key: 'historical' })
    expect(next.execution.session_id).toBe(first.session_id)
    expect(ownedPersonTaskSession(1, first.session_id).task.id).toBe(task.id)
    expect(() => ownedPersonTaskSession(2, first.session_id)).toThrow('not found')
    await runner.tickPersonWork(); await wait(next.execution.id, 'finished')
    expect(vi.mocked(runtime.execute).mock.calls.at(-1)![0].sessionId).toBe(first.session_id)
    const other = await create({ start: false })
    await expect(personTaskChat(1, other.task.id, first.id)).rejects.toThrow('not found')
    await expect(continuePersonTask(1, other.task.id, { input: [{ type: 'text', text: 'Wrong task' }], execution_id: first.id,
      expected_revision: other.task.revision, idempotency_key: 'foreign' })).rejects.toThrow('not found')
  })

  it('resolves a selected execution older than the recent page and rejects stale requirements on resume', async () => {
    const { personTaskChat, continuePersonTask } = await import('../../packages/server/src/modules/studio/services/person/task-chat')
    const { task } = await create({ start: false })
    let first = ''
    for (let index = 0; index < 22; index++) {
      const run = store.enqueuePersonExecution(store.getPersonTask(1, task.id))
      first ||= run.id
      store.setPersonExecution(run, 'finished')
    }
    expect((await personTaskChat(1, task.id, first)).execution?.id).toBe(first)
    const queued = store.enqueuePersonExecution(store.getPersonTask(1, task.id))
    const followup = await continuePersonTask(1, task.id, { input: [{ type: 'text', text: 'Queued' }], expected_revision: 0, idempotency_key: 'queued-history' })
    const activeChat = await personTaskChat(1, task.id)
    expect(activeChat.executions.map(run => run.id)).toEqual(expect.arrayContaining([queued.id, followup.execution.id]))
    store.setPersonExecution(queued, 'finished')
    store.setPersonExecution(followup.execution, 'finished')
    const changed = store.updatePersonTask(1, task.id, store.getPersonTask(1, task.id).revision, 'New goal')
    await expect(continuePersonTask(1, task.id, { input: [{ type: 'text', text: 'Old context' }], execution_id: first,
      expected_revision: changed.revision, idempotency_key: 'old-requirements' })).rejects.toThrow('requirements changed')
  })
})

it('discards prelaunch worker-only schedules once while retaining task goals, conversations and account resources', async () => {
  const { task } = await create({ start: false })
  db.exec(`DROP TABLE person_occurrences; DROP TABLE person_schedules;
    CREATE TABLE person_schedules(id TEXT PRIMARY KEY, owner_user_id INTEGER, task_id TEXT);
    INSERT INTO person_schedules VALUES('old',1,'${task.id}');
    CREATE TABLE person_occurrences(id TEXT PRIMARY KEY, schedule_id TEXT);
    INSERT INTO person_occurrences VALUES('old-occurrence','old');
    INSERT INTO person_operations VALUES(1,'schedule:old','old','{}');`)
  const { initPersonTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/person-schema')
  initPersonTables(db)
  expect(store.listPersonSchedules(1)).toHaveLength(0)
  expect(db.prepare("SELECT * FROM person_operations WHERE operation_key='schedule:old'").get()).toBeUndefined()
  expect(store.getPersonTask(1, task.id).title).toBe(task.title)
  expect(store.personSettings(1).settings.agents).toHaveLength(1)
  const saved = schedules.applyPersonSchedule(1, { action: 'create', mode: 'assistant', session_id: 'person-main-1', title: 'New schedule', goal: 'Reply directly',
    kind: 'cron', expression: '* * * * *', timezone: 'UTC', idempotency_key: 'new-schema' })
  initPersonTables(db)
  expect(store.listPersonSchedules(1)[0].id).toBe(saved.id)
})

describe('deleting Person schedules', () => {
  it.each(['active', 'paused', 'cancelled', 'exhausted'])('removes a %s plan and its occurrence metadata while preserving task history', async state => {
    const { task } = await create({ start: false })
    const saved = schedules.applyPersonSchedule(1, { action: 'create', mode: 'worker', task_id: task.id, kind: 'cron', expression: '* * * * *', timezone: 'UTC', idempotency_key: 'delete-plan-create' })
    schedules.tickPersonSchedules(saved.next_at)
    const run = store.taskPersonExecutions(1, task.id)[0]
    store.setPersonExecution(run, 'finished', { output: 'Saved result' })
    db.prepare('UPDATE person_schedules SET state=? WHERE id=?').run(state, saved.id)
    const request = { action: 'delete', schedule_id: saved.id, expected_revision: 0, idempotency_key: 'delete-plan' }
    expect(schedules.applyPersonSchedule(1, request)).toEqual({ deleted: true, schedule_id: saved.id })
    expect(schedules.applyPersonSchedule(1, request)).toEqual({ deleted: true, schedule_id: saved.id })
    expect(store.listPersonSchedules(1)).toHaveLength(0)
    expect(db.prepare('SELECT * FROM person_occurrences WHERE schedule_id=?').get(saved.id)).toBeUndefined()
    expect(store.getPersonExecution(1, run.id).output).toBe('Saved result')
    expect(store.getPersonTask(1, task.id).title).toBe(task.title)
    schedules.tickPersonSchedules(saved.next_at + 86400_000)
    expect(store.taskPersonExecutions(1, task.id)).toHaveLength(1)
    expect(runtime.stop).not.toHaveBeenCalled()
  })

  it('rejects foreign accounts and stale revisions without deleting occurrences or another plan', async () => {
    const { task } = await create({ start: false })
    const make = (key: string) => schedules.applyPersonSchedule(1, { action: 'create', mode: 'worker', task_id: task.id, kind: 'cron', expression: '* * * * *', timezone: 'UTC', idempotency_key: key })
    const one = make('one'), two = make('two')
    schedules.tickPersonSchedules(one.next_at)
    const count = db.prepare('SELECT count(*) AS n FROM person_occurrences').get()!.n
    expect(() => schedules.applyPersonSchedule(2, { action: 'delete', schedule_id: one.id, expected_revision: 0, idempotency_key: 'foreign-delete' })).toThrow('not found')
    expect(() => schedules.applyPersonSchedule(1, { action: 'delete', schedule_id: one.id, expected_revision: 1, idempotency_key: 'stale-delete' })).toThrow('Schedule changed')
    expect(() => schedules.applyPersonSchedule(1, { action: 'delete', schedule_id: one.id, idempotency_key: 'missing-revision' })).toThrow('expected_revision')
    expect(db.prepare('SELECT count(*) AS n FROM person_occurrences').get()!.n).toBe(count)
    schedules.applyPersonSchedule(1, { action: 'delete', schedule_id: one.id, expected_revision: 0, idempotency_key: 'valid-delete' })
    expect(store.listPersonSchedules(1).map(schedule => schedule.id)).toEqual([two.id])
  })

  it('keeps a running worker and its callback when its plan is deleted', async () => {
    let finish!: (value: { ok: boolean; output: string }) => void
    runtime.execute = vi.fn(input => { input.onEvent('run.started', {}); return new Promise(resolve => { finish = resolve }) })
    const { task } = await create({ start: false })
    const saved = schedules.applyPersonSchedule(1, { action: 'create', mode: 'worker', task_id: task.id, kind: 'cron', expression: '* * * * *', timezone: 'UTC', idempotency_key: 'running-plan' })
    schedules.tickPersonSchedules(saved.next_at)
    const execution = store.taskPersonExecutions(1, task.id)[0]
    await runner.tickPersonWork(); await wait(execution.id, 'running')
    schedules.applyPersonSchedule(1, { action: 'delete', schedule_id: saved.id, expected_revision: 0, idempotency_key: 'delete-running-plan' })
    expect(store.getPersonExecution(1, execution.id).state).toBe('running')
    expect(runtime.stop).not.toHaveBeenCalled()
    finish({ ok: true, output: 'Finished after deleting the schedule' })
    await wait(execution.id, 'finished')
    const { deliverPersonResults } = await import('../../packages/server/src/modules/studio/services/person/delivery')
    await deliverPersonResults()
    expect(runtime.deliver).toHaveBeenCalledWith(expect.objectContaining({ executionId: execution.id, output: 'Finished after deleting the schedule' }))
  })
})


it.each([true, false])('inserts a selected durable follow-up, preserves the rest, and suppresses an interrupted return (ok=%s)', async ok => {
  const { continuePersonTask, personTaskChat } = await import('../../packages/server/src/modules/studio/services/person/task-chat')
  const { insertPersonTaskMessage } = await import('../../packages/server/src/modules/studio/services/person/task-queue')
  const { ensurePersonSession } = await import('../../packages/server/src/modules/studio/services/person/chat-agent')
  await ensurePersonSession(1, 'person-main-1')
  const finish: Array<(value: any) => void> = []
  runtime.execute = vi.fn(input => { input.onEvent('run.started', { run_id: `native-${finish.length}` }); return new Promise(resolve => finish.push(resolve)) })
  runtime.interruptForInsertion = vi.fn(async () => ({ status: 'accepted', phase: 'tool_batch' }))
  const { task, execution } = await create()
  await runner.tickPersonWork(); await wait(execution.id, 'running')
  const append = async (text: string, file = false) => continuePersonTask(1, task.id, {
    input: [{ type: 'text', text }, ...(file ? [{ type: 'file', name: 'report.txt', path: '/tmp/report.txt' }] : [])],
    expected_revision: store.getPersonTask(1, task.id).revision, idempotency_key: text,
  })
  const first = await append('Earlier follow-up')
  const selected = await append('Selected follow-up', true)
  const observed = store.getPersonTask(1, task.id)
  const request = { queue_id: selected.execution.id, expected_execution_id: execution.id, expected_revision: observed.revision, idempotency_key: 'select-next' }
  await insertPersonTaskMessage(1, task.id, request)
  await insertPersonTaskMessage(1, task.id, request)
  expect(runtime.interruptForInsertion).toHaveBeenCalledExactlyOnceWith(execution.session_id, 'native-0')
  const chat = await personTaskChat(1, task.id)
  expect(chat.pending.map(item => item.id)).toEqual([selected.execution.id, first.execution.id])
  expect(chat.insertion).toMatchObject({ queueId: selected.execution.id, phase: 'waiting_for_tool_batch' })
  await runner.tickPersonWork(); expect(runtime.execute).toHaveBeenCalledTimes(1)
  finish[0]({ ok, interrupted: true, stop_reason: 'queue_insertion', output: 'partial result' })
  await wait(execution.id, 'interrupted')
  expect(db.prepare('SELECT state FROM person_deliveries WHERE execution_id=?').get(execution.id)?.state).toBe('cancelled')
  expect(store.getPersonTask(1, task.id).status).toBe('open')
  await runner.tickPersonWork(); await wait(selected.execution.id, 'running')
  expect(vi.mocked(runtime.execute).mock.calls[1][0]).toMatchObject({ sessionId: execution.session_id, prompt: [
    { type: 'text', text: expect.stringContaining('## Dispatch contract') }, { type: 'text', text: 'Selected follow-up' }, { type: 'file', name: 'report.txt', path: '/tmp/report.txt' },
  ] })
  expect(store.getPersonExecution(1, first.execution.id).state).toBe('pending')
  finish[1]({ ok: true, output: 'selected done' }); await wait(selected.execution.id, 'finished')
  await runner.tickPersonWork(); await wait(first.execution.id, 'running')
  finish[2]({ ok: true, output: 'earlier done' }); await wait(first.execution.id, 'finished')
  await runner.tickPersonWork()
  expect(store.getPersonTask(1, task.id)).toMatchObject({ status: 'completed', pending_count: 0 })
  expect(vi.mocked(runtime.deliver).mock.calls.map(([delivery]) => delivery.executionId)).toEqual([selected.execution.id, first.execution.id])
})

it('fences insertion by owner, revision, active execution and conversation, and rolls back unsupported priority', async () => {
  const { continuePersonTask } = await import('../../packages/server/src/modules/studio/services/person/task-chat')
  const { insertPersonTaskMessage } = await import('../../packages/server/src/modules/studio/services/person/task-queue')
  const { task, execution } = await create()
  store.setPersonExecution(execution, 'running'); store.personEvent(execution, 'run.started', { run_id: 'native' })
  runtime.interruptForInsertion = vi.fn(async () => ({ status: 'unsupported' }))
  const first = await continuePersonTask(1, task.id, { input: [{ type:'text', text:'first' }], expected_revision: 0, idempotency_key:'first' })
  const second = await continuePersonTask(1, task.id, { input: [{ type:'text', text:'second' }], expected_revision: 1, idempotency_key:'second' })
  const request = { queue_id: second.execution.id, expected_execution_id: execution.id, expected_revision:2, idempotency_key:'insert' }
  await expect(insertPersonTaskMessage(2,task.id,request)).rejects.toThrow('not found')
  await expect(insertPersonTaskMessage(1,task.id,{...request,expected_revision:1})).rejects.toThrow('changed')
  await expect(insertPersonTaskMessage(1,task.id,{...request,expected_execution_id:first.execution.id})).rejects.toThrow('changed')
  db.prepare('UPDATE person_executions SET session_id=? WHERE id=?').run('person-task-historical',second.execution.id)
  await expect(insertPersonTaskMessage(1,task.id,request)).rejects.toThrow('changed')
  db.prepare('UPDATE person_executions SET session_id=? WHERE id=?').run(execution.session_id,second.execution.id)
  await expect(insertPersonTaskMessage(1,task.id,request)).rejects.toThrow('unsupported')
  expect(store.pendingPersonInputs(1,task.id).map(item=>item.id)).toEqual([first.execution.id,second.execution.id])
  expect(store.getPersonExecution(1,execution.id).state).toBe('running')
})

it('retains an insertion intent across a transient dispatch failure and preserves priority through schema reinitialization', async () => {
  const { continuePersonTask } = await import('../../packages/server/src/modules/studio/services/person/task-chat')
  const { insertPersonTaskMessage, dispatchPersonInsertion } = await import('../../packages/server/src/modules/studio/services/person/task-queue')
  const { initPersonTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/person-schema')
  const { task, execution } = await create()
  store.setPersonExecution(execution,'running'); store.personEvent(execution,'run.started',{run_id:'native'})
  runtime.interruptForInsertion=vi.fn().mockRejectedValueOnce(new Error('temporary disconnect')).mockResolvedValue({status:'accepted',phase:'model'})
  await continuePersonTask(1,task.id,{input:[{type:'text',text:'first'}],expected_revision:0,idempotency_key:'first'})
  const second=await continuePersonTask(1,task.id,{input:[{type:'text',text:'second'}],expected_revision:1,idempotency_key:'second'})
  await expect(insertPersonTaskMessage(1,task.id,{queue_id:second.execution.id,expected_execution_id:execution.id,expected_revision:2,idempotency_key:'insert'})).rejects.toThrow('disconnect')
  initPersonTables(db)
  expect(store.pendingPersonInputs(1,task.id)[0].id).toBe(second.execution.id)
  await dispatchPersonInsertion(store.getPersonExecution(1,execution.id))
  expect(store.getPersonExecution(1,execution.id).insertion_phase).toBe('stopping_current_turn')
  store.setPersonExecution(execution,'interrupted')
  store.promotePersonFollowups()
  expect(store.getPersonExecution(1,second.execution.id).state).toBe('queued')
})

it('removes one durable follow-up idempotently, preserves the worker and remaining input, and never delivers the removed turn', async () => {
  const { continuePersonTask, personTaskChat } = await import('../../packages/server/src/modules/studio/services/person/task-chat')
  const { removePersonTaskMessage } = await import('../../packages/server/src/modules/studio/services/person/task-queue')
  const finish: Array<(value: any) => void> = []
  runtime.execute = vi.fn(input => { input.onEvent('run.started', {}); return new Promise(resolve => finish.push(resolve)) })
  const { task, execution } = await create()
  await runner.tickPersonWork(); await wait(execution.id, 'running')
  const first = await continuePersonTask(1, task.id, { input: [{ type: 'text', text: 'Remove this' }], expected_revision: 0, idempotency_key: 'first' })
  const second = await continuePersonTask(1, task.id, { input: [{ type: 'file', name: 'keep.txt', path: '/tmp/keep.txt' }], expected_revision: 1, idempotency_key: 'second' })
  const request = { queue_id: first.execution.id, expected_execution_id: execution.id, expected_revision: 2, idempotency_key: 'remove-first' }
  const result = removePersonTaskMessage(1, task.id, request)
  expect(result.task.revision).toBe(3)
  expect(result.pending).toEqual([{ id: second.execution.id, input: [{ type: 'file', name: 'keep.txt', path: '/tmp/keep.txt' }] }])
  expect(result.canRemove).toBe(true)
  expect(removePersonTaskMessage(1, task.id, request)).toEqual(result)
  expect(() => removePersonTaskMessage(1, task.id, { ...request, queue_id: second.execution.id })).toThrow('Idempotency')
  expect(store.getPersonTask(1, task.id).revision).toBe(3)
  expect(store.getPersonExecution(1, execution.id).state).toBe('running')
  expect(store.getPersonExecution(1, first.execution.id)).toMatchObject({ state: 'interrupted', generation: first.execution.generation + 1 })
  expect(db.prepare('SELECT state FROM person_deliveries WHERE execution_id=?').get(first.execution.id)?.state).toBe('cancelled')
  expect((await personTaskChat(1, task.id)).pending.map(item => item.id)).toEqual([second.execution.id])
  await runner.tickPersonWork(); expect(runtime.execute).toHaveBeenCalledTimes(1)
  expect(runtime.stop).not.toHaveBeenCalled()
  finish[0]({ ok: true, output: 'original done' }); await wait(execution.id, 'finished')
  await runner.tickPersonWork(); await wait(second.execution.id, 'running')
  expect(vi.mocked(runtime.execute).mock.calls[1][0].prompt).toEqual([{ type: 'text', text: expect.stringContaining('## Dispatch contract') }, { type: 'file', name: 'keep.txt', path: '/tmp/keep.txt' }])
  finish[1]({ ok: true, output: 'remaining done' }); await wait(second.execution.id, 'finished')
  await runner.tickPersonWork()
  expect(vi.mocked(runtime.deliver).mock.calls.some(([item]) => item.executionId === first.execution.id)).toBe(false)
})

it('removes an unstarted queued head while keeping its next follow-up schedulable', async () => {
  const { continuePersonTask } = await import('../../packages/server/src/modules/studio/services/person/task-chat')
  const { removePersonTaskMessage } = await import('../../packages/server/src/modules/studio/services/person/task-queue')
  const { task, execution } = await create(); store.setPersonExecution(execution, 'finished')
  const first = await continuePersonTask(1, task.id, { input: [{ type: 'text', text: 'queued head' }], expected_revision: 0, idempotency_key: 'head' })
  const second = await continuePersonTask(1, task.id, { input: [{ type: 'text', text: 'remaining' }], expected_revision: 1, idempotency_key: 'tail' })
  expect(first.execution.state).toBe('queued')
  const result = removePersonTaskMessage(1, task.id, { queue_id: first.execution.id, expected_execution_id: first.execution.id, expected_revision: 2, idempotency_key: 'remove-head' })
  expect(result.pending.map(item => item.id)).toEqual([second.execution.id])
  store.promotePersonFollowups()
  expect(store.getPersonExecution(1, second.execution.id).state).toBe('queued')
  expect(runtime.stop).not.toHaveBeenCalled()
})

it.each(['revision', 'execution', 'task', 'conversation', 'requirements', 'started', 'stopping', 'closed'])('rejects removal fenced by %s without mutating the queue', async fence => {
  const { continuePersonTask } = await import('../../packages/server/src/modules/studio/services/person/task-chat')
  const { removePersonTaskMessage } = await import('../../packages/server/src/modules/studio/services/person/task-queue')
  const { task, execution } = await create(); store.setPersonExecution(execution, 'running')
  const followup = await continuePersonTask(1, task.id, { input: [{ type: 'text', text: 'keep' }], expected_revision: 0, idempotency_key: 'followup' })
  const request = { queue_id: followup.execution.id, expected_execution_id: execution.id, expected_revision: 1, idempotency_key: 'remove' }
  if (fence === 'revision') request.expected_revision = 0
  if (fence === 'execution') request.expected_execution_id = followup.execution.id
  if (fence === 'task') db.prepare('UPDATE person_executions SET task_id=? WHERE id=?').run((await create()).task.id, followup.execution.id)
  if (fence === 'conversation') db.prepare('UPDATE person_executions SET session_id=? WHERE id=?').run('person-task-history', followup.execution.id)
  if (fence === 'requirements') db.prepare('UPDATE person_executions SET requirements_revision=requirements_revision+1 WHERE id=?').run(followup.execution.id)
  if (fence === 'started') {
    store.setPersonExecution(execution, 'finished'); store.setPersonExecution(followup.execution, 'running')
    request.expected_execution_id = followup.execution.id
  }
  if (fence === 'stopping') store.setPersonExecution(execution, 'stopping')
  if (fence === 'closed') db.prepare("UPDATE session_tasks SET status='closed' WHERE id=?").run(task.id)
  const before = db.prepare('SELECT * FROM person_executions ORDER BY id').all()
  expect(() => removePersonTaskMessage(2, task.id, request)).toThrow('not found')
  expect(() => removePersonTaskMessage(1, task.id, request)).toThrow(/changed|unavailable/i)
  expect(db.prepare('SELECT * FROM person_executions ORDER BY id').all()).toEqual(before)
  expect(store.getPersonTask(1, task.id).revision).toBe(1)
})

it('keeps the insertion target protected while permitting removal of another pending turn', async () => {
  const { continuePersonTask } = await import('../../packages/server/src/modules/studio/services/person/task-chat')
  const { insertPersonTaskMessage, removePersonTaskMessage } = await import('../../packages/server/src/modules/studio/services/person/task-queue')
  const { task, execution } = await create(); store.setPersonExecution(execution, 'running')
  store.personEvent(execution, 'run.started', { run_id: 'native' })
  runtime.interruptForInsertion = vi.fn(async () => ({ status: 'accepted', phase: 'tool_batch' }))
  const first = await continuePersonTask(1, task.id, { input: [{ type: 'text', text: 'first' }], expected_revision: 0, idempotency_key: 'first' })
  const selected = await continuePersonTask(1, task.id, { input: [{ type: 'text', text: 'selected' }], expected_revision: 1, idempotency_key: 'selected' })
  await insertPersonTaskMessage(1, task.id, { queue_id: selected.execution.id, expected_execution_id: execution.id, expected_revision: 2, idempotency_key: 'insert' })
  expect(() => removePersonTaskMessage(1, task.id, { queue_id: selected.execution.id, expected_execution_id: execution.id, expected_revision: 3, idempotency_key: 'remove-selected' })).toThrow('in progress')
  const result = removePersonTaskMessage(1, task.id, { queue_id: first.execution.id, expected_execution_id: execution.id, expected_revision: 3, idempotency_key: 'remove-first' })
  expect(result.pending.map(item => item.id)).toEqual([selected.execution.id])
  expect(result.insertion).toMatchObject({ queueId: selected.execution.id, phase: 'waiting_for_tool_batch' })
  expect(runtime.stop).not.toHaveBeenCalled()
})

it('checks account/profile access while removal remains available without a usable model or insertion runtime', async () => {
  const { continuePersonTask, personTaskChat } = await import('../../packages/server/src/modules/studio/services/person/task-chat')
  const { removePersonTaskMessage } = await import('../../packages/server/src/modules/studio/services/person/task-queue')
  const { task, execution } = await create(); store.setPersonExecution(execution, 'running')
  const followup = await continuePersonTask(1, task.id, { input: [{ type: 'text', text: 'first' }], expected_revision: 0, idempotency_key: 'first' })
  const request = { queue_id: followup.execution.id, expected_execution_id: execution.id, expected_revision: 1, idempotency_key: 'remove' }
  activeAccount = false
  expect(() => removePersonTaskMessage(1, task.id, request)).toThrow()
  activeAccount = true; catalog = []; installedAgent = false
  expect((await personTaskChat(1, task.id)).canRemove).toBe(true)
  expect(removePersonTaskMessage(1, task.id, request).pending).toEqual([])
  const otherTask = store.createPersonTask(2, 'Other', 'Goal', selection, dir, 'person-main-2')
  const otherRun = store.enqueuePersonExecution(otherTask)
  allowedProfiles = []
  expect(() => removePersonTaskMessage(2, otherTask.id, { queue_id: otherRun.id, expected_execution_id: otherRun.id, expected_revision: 0, idempotency_key: 'other' })).toThrow('permission revoked')
})

describe('Person task loading reads', () => {
  function seedRun(taskId: string, id: string, state: string, createdAt: number, sessionId = 'person-task-loading', owner = 1) {
    db.prepare(`INSERT INTO person_executions(id,task_id,owner_user_id,requirements_revision,state,session_id,selection_json,created_at,updated_at)
      VALUES (?,?,?,1,?,?,?,?,?)`).run(id, taskId, owner, state, sessionId, JSON.stringify(selection), createdAt, createdAt)
  }

  it('keeps active/pending/terminal priority, rowid ties, delivery activity and account boundaries', () => {
    const task = store.createPersonTask(1, 'Priority', 'Check ordering', selection, dir, 'person-main-1')
    seedRun(task.id, 'active', 'running', 1)
    seedRun(task.id, 'pending', 'pending', 2)
    seedRun(task.id, 'finished', 'finished', 3)
    expect(store.getPersonTask(1, task.id)).toMatchObject({ execution_id: 'active', execution_state: 'running', pending_count: 1, running: 1 })
    db.prepare("UPDATE person_executions SET state='finished' WHERE id='active'").run()
    expect(store.getPersonTask(1, task.id).execution_id).toBe('pending')
    db.prepare("UPDATE person_executions SET state='finished' WHERE id='pending'").run()
    seedRun(task.id, 'tie', 'failed', 3)
    expect(store.getPersonTask(1, task.id)).toMatchObject({ execution_id: 'tie', execution_state: 'failed', running: 0 })
    db.prepare("INSERT INTO person_deliveries(execution_id,owner_user_id,origin_json,state,updated_at) VALUES ('finished',1,'{}','pending',1)").run()
    expect(store.getPersonTask(1, task.id).running).toBe(1)
    expect(store.personTaskRunning(task.id)).toBe(true)
    expect(store.listPersonTasks(1)[0].execution_id).toBe('tie')
    expect(store.listPersonTasks(2)).toEqual([])
    expect(() => store.getPersonTask(2, task.id)).toThrow('not found')
  })

  it('preserves scoped search, status, sorting and offset while using bounded execution lookups', () => {
    const first = store.createPersonTask(1, 'First needle', 'Search summary', selection, dir, 'person-main-1')
    const second = store.createPersonTask(1, 'Second', 'Contains NEEDLE', selection, dir, 'person-main-1')
    store.createPersonTask(2, 'Foreign needle', 'Excluded', selection, dir, 'person-main-2')
    db.prepare('UPDATE session_tasks SET updated_at=10 WHERE id=?').run(first.id)
    db.prepare("UPDATE session_tasks SET updated_at=20,status='completed' WHERE id=?").run(second.id)
    expect(store.listPersonTasks(1, 'needle', 0, { order: 'oldest', limit: 1 }).map(x => x.id)).toEqual([first.id])
    expect(store.listPersonTasks(1, 'needle', 1, { order: 'oldest', limit: 1 }).map(x => x.id)).toEqual([second.id])
    expect(store.listPersonTasks(1, 'needle', 0, { status: 'completed' }).map(x => x.id)).toEqual([second.id])
    expect(store.listPersonTasks(1, '', 0, { sessionId: 'person-main-2' })).toEqual([])
    const prepare = vi.spyOn(db, 'prepare')
    store.listPersonTasks(1, '', 0, { sessionId: 'person-main-1' })
    const sql = prepare.mock.calls.find(([sql]) => sql.startsWith('SELECT t.*'))![0]
    prepare.mockRestore()
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(1, 'person:1', 'person-main-1', 20, 0).map(x => String(x.detail)).join('\n')
    expect(plan).toContain('idx_person_session_goals')
    expect(plan).toContain('idx_person_execution_order')
    expect(plan).not.toMatch(/SCAN e\b/)
  })

  it('finds the latest execution in a long conversation without repeated inner sorting', () => {
    const task = store.createPersonTask(1, 'Long conversation', 'Read latest', selection, dir, 'person-main-1')
    db.exec('BEGIN')
    for (let i = 0; i < 1500; i++) seedRun(task.id, `long-${i}`, 'finished', i)
    seedRun(task.id, 'newest-tie', 'finished', 1499)
    db.exec('COMMIT')
    const prepare = vi.spyOn(db, 'prepare')
    expect(store.taskPersonConversations(1, task.id).map(x => x.id)).toEqual(['newest-tie'])
    const sql = prepare.mock.calls.find(([sql]) => sql.startsWith('SELECT id,session_id,state,created_at,occurrence_id FROM person_executions e'))![0]
    prepare.mockRestore()
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(1, task.id).map(x => String(x.detail)).join('\n')
    expect(plan).toContain('idx_person_conversation_latest')
    expect(plan).not.toContain('USE TEMP B-TREE FOR ORDER BY')
    expect(() => store.taskPersonConversations(2, task.id)).toThrow('not found')
  })

  it('reads an effective snapshot with SQLite writes disabled and synchronizes only changed run metadata', async () => {
    const { personSnapshot } = await import('../../packages/server/src/modules/studio/services/person/service')
    const { ensurePersonSession } = await import('../../packages/server/src/modules/studio/services/person/chat-agent')
    db.prepare("UPDATE sessions SET model='old',provider='old',workspace='/old' WHERE id='person-main-1'").run()
    const stored = db.prepare("SELECT * FROM sessions WHERE id='person-main-1'").get()
    const changes = () => Number(db.prepare('SELECT total_changes() AS n').get()!.n)
    const before = changes()
    db.exec('PRAGMA query_only=ON')
    try {
      const snapshot = await personSnapshot(1, 'person-main-1')
      expect(snapshot.session).toMatchObject({ model: 'm', provider: 'test', workspace: dir })
      expect(db.prepare("SELECT * FROM sessions WHERE id='person-main-1'").get()).toEqual(stored)
      expect(changes()).toBe(before)
    } finally { db.exec('PRAGMA query_only=OFF') }
    await ensurePersonSession(1, 'person-main-1')
    expect(db.prepare("SELECT model,workspace FROM sessions WHERE id='person-main-1'").get()).toMatchObject({ model: 'm', workspace: dir })
    const synchronized = changes()
    await ensurePersonSession(1, 'person-main-1')
    expect(changes()).toBe(synchronized)
  })

  it('keeps running-session metadata in a snapshot without changing or reconfiguring it', async () => {
    const { personSnapshot } = await import('../../packages/server/src/modules/studio/services/person/service')
    db.prepare("UPDATE sessions SET model='running-model',workspace='/running' WHERE id='person-main-1'").run()
    mainBusy = 'person-main-1'
    expect((await personSnapshot(1, 'person-main-1')).session).toMatchObject({ model: 'running-model', workspace: '/running' })
  })
})

it('keeps an explicit acceptance goal open until its owner checks the returned candidate', async () => {
  const { personTools } = await import('../../packages/server/src/modules/studio/services/person/tools')
  const { task, execution } = await create({ acceptance: 'Read result.txt and verify the value is 42.' })
  await runner.tickPersonWork(); await wait(execution.id, 'finished')
  const current = store.getPersonTask(1, task.id)
  expect(current).toMatchObject({ status: 'open', completion_evidence: '' })
  const tools = personTools(1, 'main', undefined, 'person-main-1')
  const query: any = await tools.find(t => t.name === 'bot_tasks_query')!.execute({ task_id: task.id })
  expect(query.task.allowed_actions).toContain('accept')
  expect(query.task.verification).toMatchObject({ state: 'pending', execution_id: execution.id })
  const result: any = await tools.find(t => t.name === 'bot_task_control')!.execute({ task_ref: query.task.task_ref, action: 'accept',
    candidate: query.task.verification.candidate, evidence: 'Read result.txt; exactly 42.' })
  expect(result).toMatchObject({ ok: true, task: { status: 'completed' } })
  expect(store.getPersonTask(1, task.id).completion_evidence).toBe('Read result.txt; exactly 42.')
})

it('retains crash-left terminal resource claims until native stop is acknowledged', async () => {
  const { claimPersonResources } = await import('../../packages/server/src/modules/studio/repositories/person-resource-store')
  const { execution } = await create()
  expect(claimPersonResources(execution)).toBe(true)
  db.prepare("UPDATE person_executions SET state='finished' WHERE id=?").run(execution.id)
  let acknowledge!: () => void
  runtime.stop = vi.fn(() => new Promise<void>(resolve => { acknowledge = resolve }))
  const next = await create()
  await runner.tickPersonWork()
  expect(runtime.stop).toHaveBeenCalledTimes(1)
  expect(store.getPersonExecution(1, next.execution.id).state).toBe('queued')
  acknowledge()
  await vi.waitFor(() => expect(db.prepare('SELECT 1 FROM person_resource_claims WHERE execution_id=?').get(execution.id)).toBeUndefined())
  await runner.tickPersonWork(); await wait(next.execution.id, 'finished')
})

it('returns project follow-ups with their task brief without replaying another project transcript', async () => {
  const { configurePersonProject } = await import('../../packages/server/src/modules/studio/services/person/projects')
  const { continuePersonTask } = await import('../../packages/server/src/modules/studio/services/person/task-chat')
  const { deliverPersonResults } = await import('../../packages/server/src/modules/studio/services/person/delivery')
  const project = await configurePersonProject(1, { name: 'Alpha', workspace: dir, expected_revision: 0 })
  const { task } = await create({ project_id: project.id, start: false })
  const followup = await continuePersonTask(1, task.id, { input: [{ type: 'text', text: 'Also verify the result; do not deploy.' }],
    expected_revision: task.revision, idempotency_key: 'project-followup' }, { sessionId: task.session_id, runId: 'request', messages: [{ role: 'user', content: 'Unrelated Beta project secret' }] })
  await runner.tickPersonWork(); await wait(followup.execution.id, 'finished')
  await deliverPersonResults()
  const returned = JSON.stringify(vi.mocked(runtime.deliver).mock.calls[0][0].origin.messages)
  expect(returned).toContain('Write 42 into result.txt')
  expect(returned).toContain('Also verify the result; do not deploy.')
  expect(returned).not.toContain('Unrelated Beta')
})


describe('Person protocol selection', () => {
  it.each(['codex', 'claude-code', 'ekko'])('persists independent GPT and Opus protocols for %s through execution', async runtimeId => {
    catalog[0].models = ['gpt', 'opus']
    const agents = ['gpt', 'opus'].map(model => ({ id: model, name: model, description: 'Execute tasks', selection: {
      ...selection, runtime: runtimeId, model, apiMode: model === 'gpt' ? 'codex_responses' : 'anthropic_messages', reasoningEffort: '',
    } }))
    const { configurePerson } = await import('../../packages/server/src/modules/studio/services/person/service')
    await configurePerson(1, { agents, expected_revision: 1 })
    expect(store.personSettings(1).settings.agents).toEqual(agents)
    for (const agent of agents) {
      const { task, execution } = await create({ agent_id: agent.id })
      expect(JSON.parse(task.selection_json)).toEqual(agent.selection)
      await runner.tickPersonWork(); await wait(execution.id, 'finished')
      expect(vi.mocked(runtime.execute).mock.calls.at(-1)?.[0].selection).toEqual(agent.selection)
    }
  })

  it('persists a conversation protocol independently of the provider default', async () => {
    const { configurePerson, personSnapshot } = await import('../../packages/server/src/modules/studio/services/person/service')
    await configurePerson(1, { session_id: 'person-main-1', model: { ...selection, apiMode: 'anthropic_messages' }, expected_revision: 1 })
    expect((await personSnapshot(1, 'person-main-1')).settings.model?.apiMode).toBe('anthropic_messages')
    const { validatePersonSelection } = await import('../../packages/server/src/modules/studio/services/person/catalog')
    await expect(validatePersonSelection(1, store.personSettings(1, 'person-main-1').settings.model!)).resolves.toBeUndefined()
  })

  it('preserves the selected protocol when creating a BOT and follows defaults on reset', async () => {
    const { createPersonConversation } = await import('../../packages/server/src/modules/studio/services/person/conversations')
    const { configurePerson, personSnapshot } = await import('../../packages/server/src/modules/studio/services/person/service')
    const session = await createPersonConversation(1, 'Protocol BOT', { model: { ...selection, apiMode: 'codex_responses' } })
    expect((await personSnapshot(1, session.id)).settings.model?.apiMode).toBe('codex_responses')
    await configurePerson(1, { session_id: session.id, use_global_default: true, expected_revision: store.personSettings(1).revision })
    expect((await personSnapshot(1, session.id)).settings.model?.apiMode).toBe('chat_completions')
  })

  it.each(['invented', 'bedrock_converse', 'codex_app_server', 42])('rejects unsupported protocol %s rather than silently replacing it', async apiMode => {
    const { validatePersonAgents } = await import('../../packages/server/src/modules/studio/services/person/agents')
    await expect(validatePersonAgents(1, [{ id: 'worker', name: 'Worker', description: 'Tasks', selection: { ...selection, runtime: 'codex', apiMode } }])).rejects.toMatchObject({ status: 400 })
  })

  it('keeps catalog defaults for older clients and Hermes protocol ownership', async () => {
    const { validatePersonAgents } = await import('../../packages/server/src/modules/studio/services/person/agents')
    const preset = { id: 'worker', name: 'Worker', description: 'Tasks', selection: { ...selection, runtime: 'codex', apiMode: undefined } }
    expect((await validatePersonAgents(1, [preset]))[0].selection.apiMode).toBe('chat_completions')
    await expect(validatePersonAgents(1, [{ ...preset, selection: { ...selection, runtime: 'hermes', apiMode: 'anthropic_messages' } }])).rejects.toMatchObject({ status: 409 })
    catalog[0].model_meta = { m: { disabled: true } }
    await expect(validatePersonAgents(1, [preset])).rejects.toMatchObject({ status: 409 })
  })

  it('preserves native-only Hermes protocols and rejects converting them into coding connections', async () => {
    const { personSelectionApiMode } = await import('../../packages/server/src/modules/studio/services/person/catalog')
    const group = { provider: 'bedrock', api_mode: 'bedrock_converse' }
    expect(personSelectionApiMode(group, 'm', 'bedrock_converse', 'hermes')).toBe('bedrock_converse')
    expect(() => personSelectionApiMode(group, 'm', 'anthropic_messages', 'codex')).toThrow('protocol')
    expect(() => personSelectionApiMode({ provider: 'claude-oauth', api_mode: 'anthropic_messages' }, 'm', 'codex_responses')).toThrow('protocol')
  })
})
