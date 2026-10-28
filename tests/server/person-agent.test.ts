import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

let mainBusy = false
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
  vi.doMock('../../packages/server/src/modules/studio/public/chat-run', () => ({ getChatRunServer: () => ({ isSessionRunning: () => mainBusy, clearSessionHistory: clearHistoryMock, disposeSession: disposeSessionMock, runAndWait: nativeTaskRun }) }))
  vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({ getDb: () => db, isSqliteAvailable: () => true }))
  vi.doMock('../../packages/server/src/modules/studio/public/config', () => ({ config: { appHome: dir }, getWebUiHome: () => dir }))
  vi.doMock('../../packages/server/src/modules/studio/repositories/users-store', () => ({
    findUserById: (id: number) => ({ id, status: activeAccount ? 'active' : 'disabled', role: id === 1 ? 'super_admin' : 'admin', username: `user${id}` }),
    listUserProfiles: () => allowedProfiles.map(profile_name => ({ profile_name })), userCanAccessProfile: (_id: number, p: string) => allowedProfiles.includes(p),
  }))
  vi.doMock('../../packages/server/src/modules/studio/public/profile-config', () => ({ listProfileNamesFromDisk: () => ['default'], getActiveProfileName: () => 'default', readConfigYamlForProfile: async () => ({ compression: globalCompression }) }))
  vi.doMock('../../packages/server/src/modules/studio/public/agent-status-registry', () => ({ getAgentAvailabilitySnapshot: () => ({ agents: [{ id: 'hermes', installed: true }, { id: 'ekko-agent', installed: installedAgent }, { id: 'codex', installed: true }, { id: 'pi', installed: false }] }) }))
  catalog = [{ provider: 'test', models: ['m'], api_mode: 'chat_completions' }]
  vi.doMock('../../packages/server/src/modules/studio/public/session-agent-runtime', () => ({ getSessionAvailableModelGroups: async () => catalog, validateCodingAgentModelEffort: vi.fn(async () => {}) }))
  vi.doMock('../../packages/server/src/modules/studio/services/usage/usage-recorder', () => ({ recordSessionUsage: vi.fn() }))
  const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
  initAllHermesTables()
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
  store.savePersonSettings(1, { ...store.personSettings(1).settings, model: selection, workspace: dir, agents: [{ id: 'worker', name: 'Worker', description: 'Execute tasks', selection: { ...selection, reasoningEffort: '' } }] }, 0)
})
afterEach(async () => {
  await runner?.stopPersonWork()
  await new Promise(resolve => setTimeout(resolve, 10))
  const { closePersonMemoryStores } = await import('../../packages/server/src/modules/studio/services/person/memory')
  closePersonMemoryStores()
  db?.close(); rmSync(dir, { recursive: true, force: true }); vi.clearAllMocks()
})
async function create(overrides = {}) {
  return tasks.applyPersonTask(1, { action: 'create', idempotency_key: crypto.randomUUID(), title: 'Compute result', goal: 'Write 42 into result.txt', ...overrides }) as Promise<{ task: import('../../packages/server/src/modules/studio/contracts/person').PersonTask; execution: import('../../packages/server/src/modules/studio/contracts/person').PersonExecution }>
}
const wait = async (id: string, state: string) => vi.waitFor(() => expect(store.getPersonExecution(1, id).state).toBe(state), { timeout: 2000, interval: 10 })

describe('Person account-owned tasks and runtime', () => {
  it.each(['hermes', 'ekko', 'codex'])('automatically handles %s approvals on initial, continued and scheduled tasks without creating user interactions', async agent => {
    const { executePersonTask } = await import('../../packages/server/src/bootstrap/person-task-runtime')
    const { configurePerson } = await import('../../packages/server/src/modules/studio/services/person/service')
    const { continuePersonTask } = await import('../../packages/server/src/modules/studio/services/person/task-chat')
    const { ensurePersonSession } = await import('../../packages/server/src/modules/studio/services/person/chat-agent')
    const { deliverPersonResults, finishPersonDelivery } = await import('../../packages/server/src/modules/studio/services/person/delivery')
    await ensurePersonSession(1)
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
    await schedules.applyPersonSchedule(1, { action: 'create', task_id: scheduled.task.id, kind: 'cron', expression: '* * * * *', timezone: 'UTC', expected_revision: 0, idempotency_key: 'auto-schedule' })
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
    await ensurePersonSession(1); await ensurePersonSession(2)
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
    expect(await personSnapshot(1)).toMatchObject({ inherits_global_model: true, settings: { model: selection } })
    expect(store.personSettings(1).settings.model).toBeNull()
    expect(await personSnapshot(1)).toMatchObject({ session: { id: 'person-main-1', model: 'm', reasoning_effort: 'low', studio_user_id: '1' } })
    catalog[0].models.push('m2')
    vi.mocked(runtime.modelConfig).mockResolvedValue({ default: 'm2', default_provider: 'test', groups: catalog })
    expect(await personSnapshot(1)).toMatchObject({ session: { id: 'person-main-1', model: 'm2' } })
    expect(store.personSettings(1).settings.model).toBeNull()
  })

  it('persists model and supported reasoning choices, then restores global inheritance', async () => {
    catalog[0].models.push('m2')
    catalog[0].model_meta = { m: { reasoning_efforts: ['low', 'high'] }, m2: { reasoning: false } }
    const { configurePerson, personSnapshot } = await import('../../packages/server/src/modules/studio/services/person/service')
    await configurePerson(1, { reasoning_effort: 'high', expected_revision: 1 })
    expect(await personSnapshot(1)).toMatchObject({ session: { reasoning_effort: 'high' } })
    const switched = await configurePerson(1, { model: { profile: 'default', provider: 'test', model: 'm2' }, expected_revision: 2 })
    expect(switched).toMatchObject({ inherits_global_model: false, reasoning_efforts: [], settings: { model: { model: 'm2' }, reasoningEffort: '' } })
    expect(await personSnapshot(1)).toMatchObject({ settings: { model: { model: 'm2' } } })
    await expect(configurePerson(1, { reasoning_effort: 'high', expected_revision: 3 })).rejects.toThrow('does not support')
    const restored = await configurePerson(1, { use_global_default: true, expected_revision: 3 })
    expect(restored).toMatchObject({ inherits_global_model: true, settings: { model: selection } })
    expect(store.personSettings(1).settings.model).toBeNull()
  })

  it('preserves xhigh independently for the main coordinator and saved execution preset', async () => {
    const { configurePerson, personSnapshot } = await import('../../packages/server/src/modules/studio/services/person/service')
    const { runPersonModel } = await import('../../packages/server/src/modules/studio/services/person/model')
    catalog[0].model_meta = { m: { reasoning_efforts: ['low', 'medium', 'high', 'xhigh', 'max'] } }
    const agent = { id: 'worker', name: 'Worker', description: 'Execute tasks', selection: { ...selection, reasoningEffort: 'xhigh' } }
    await configurePerson(1, { agents: [agent], expected_revision: 1 })
    await runPersonModel(1, 'main', [{ role: 'user', content: 'Hello' }], [], new AbortController().signal)
    expect(vi.mocked(runtime.model).mock.calls.at(-1)![0].reasoningEffort).toBe('low')
    await configurePerson(1, { reasoning_effort: 'xhigh', expected_revision: 2 })
    expect(await personSnapshot(1)).toMatchObject({ settings: { reasoningEffort: 'xhigh', agents: [agent] }, session: { reasoning_effort: 'xhigh' } })
    await runPersonModel(1, 'main', [{ role: 'user', content: 'Think carefully' }], [], new AbortController().signal)
    expect(vi.mocked(runtime.model).mock.calls.at(-1)![0].reasoningEffort).toBe('xhigh')
    expect(JSON.parse((await create({ start: false })).task.selection_json).reasoningEffort).toBe('xhigh')
    await expect(configurePerson(1, { reasoning_effort: 'none', expected_revision: 3 })).rejects.toThrow('does not support')
  })

  it('saves general settings independently and follows the interaction model window and global threshold', async () => {
    const { configurePerson, personSnapshot } = await import('../../packages/server/src/modules/studio/services/person/service')
    const { createPersonChatAgent, ensurePersonSession } = await import('../../packages/server/src/modules/studio/services/person/chat-agent')
    const { createPersonAgent } = await import('../../packages/server/src/bootstrap/person-chat-agent')
    const { runPersonModel } = await import('../../packages/server/src/modules/studio/services/person/model')
    modelContextLength = 200000
    const original = store.personSettings(1)
    db.prepare('UPDATE person_accounts SET settings_json=? WHERE user_id=1').run(JSON.stringify({ ...original.settings, contextTokens: 16000 }))
    expect(await personSnapshot(1)).toMatchObject({ contextTokens: 200000, compression: { enabled: true, threshold: 0.5, globalThreshold: 0.5 } })
    expect(store.personSettings(1).settings).not.toHaveProperty('contextTokens')
    globalCompression = { threshold: 0.7 }
    expect((await personSnapshot(1)).compression.threshold).toBe(0.7)
    const patch = { compressionThreshold: 0.6, maxSteps: 20, maxConcurrentTasks: 3, timezone: 'Europe/London' }
    await configurePerson(1, { ...patch, expected_revision: 1 })
    const snapshot = await personSnapshot(1)
    expect(snapshot).toMatchObject({ contextTokens: 200000, compression: { threshold: 0.6, globalThreshold: 0.7 }, settings: { ...patch, agents: original.settings.agents, model: selection } })
    expect(store.personSettings(2).settings.timezone).toBe('Asia/Shanghai')
    await expect(configurePerson(1, { compressionThreshold: 0.4, expected_revision: 1 })).rejects.toThrow('changed')
    runtime.chatAgent = vi.fn(createPersonAgent)
    await ensurePersonSession(1)
    await createPersonChatAgent(1, 'person-main-1')
    expect(runtime.chatAgent).toHaveBeenLastCalledWith(expect.objectContaining({ contextTokens: 200000, maxSteps: 20, compression: expect.objectContaining({ threshold: 0.6 }), systemPrompt: expect.stringContaining('Account timezone: Europe/London') }))
    catalog[0].models.push('m2')
    await configurePerson(1, { model: { ...selection, model: 'm2' }, expected_revision: 2 })
    expect((await personSnapshot(1)).contextTokens).toBe(128000)
    await createPersonChatAgent(1, 'person-main-1')
    expect(runtime.chatAgent).toHaveBeenLastCalledWith(expect.objectContaining({ contextTokens: 128000, compression: expect.objectContaining({ threshold: 0.6 }) }))
    await runPersonModel(1, 'main', [{ role: 'user', content: 'Hello' }], [], new AbortController().signal)
    expect(runtime.model).toHaveBeenLastCalledWith(expect.objectContaining({ contextTokens: 128000, compression: expect.objectContaining({ threshold: 0.6 }) }))
    globalCompression.enabled = false
    await configurePerson(1, { compressionThreshold: null, expected_revision: 3 })
    expect(await personSnapshot(1)).toMatchObject({ compression: { enabled: false, threshold: 0.7 }, settings: { compressionThreshold: null } })
  })

  it.each([{ compressionThreshold: 0.01 }, { compressionThreshold: 0.96 }, { compressionThreshold: '50' }, { contextTokens: 16000 }, { maxSteps: 31 }, { maxConcurrentTasks: 5 }])('rejects invalid general settings without saving: %j', async patch => {
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
    await expect(configurePerson(1, { model: { profile: 'forbidden', provider: 'test', model: 'm' }, expected_revision: 1 })).rejects.toThrow('unavailable')
    await expect(configurePerson(1, { model: { profile: 'default', provider: 'test', model: 'hidden' }, expected_revision: 1 })).rejects.toThrow('unavailable')
    await expect(configurePerson(1, { reasoning_effort: 'invented', expected_revision: 1 })).rejects.toThrow('Invalid reasoning')
    await expect(configurePerson(1, { reasoning_effort: 'high', expected_revision: 0 })).rejects.toThrow('changed')
  })

  it('does not send a request if the global default is missing or disabled', async () => {
    const agents = store.personSettings(1).settings.agents
    db.prepare('DELETE FROM person_accounts WHERE user_id=1').run()
    store.savePersonSettings(1, { ...store.personSettings(1).settings, agents }, 0)
    catalog[0].model_meta = { m: { disabled: true } }
    const { personSnapshot } = await import('../../packages/server/src/modules/studio/services/person/service')
    expect(await personSnapshot(1)).toMatchObject({ inherits_global_model: true, settings: { model: null } })
    const { createPersonChatAgent } = await import('../../packages/server/src/modules/studio/services/person/chat-agent')
    await expect(createPersonChatAgent(1, 'person-main-1')).rejects.toThrow('global default model')
    expect(runtime.model).not.toHaveBeenCalled()
    expect(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id='person-main-1'").get()).toMatchObject({ n: 0 })
  })

  it('requires a saved preset before chat or task creation and relocks after the last preset is removed', async () => {
    const { configurePerson, personSnapshot } = await import('../../packages/server/src/modules/studio/services/person/service')
    const { createPersonChatAgent } = await import('../../packages/server/src/modules/studio/services/person/chat-agent')
    const { personExecutionAgents } = await import('../../packages/server/src/modules/studio/services/person/agents')
    const agents = store.personSettings(1).settings.agents
    db.prepare('DELETE FROM person_accounts WHERE user_id=1').run()
    runtime.chatAgent = vi.fn(async () => ({} as any))
    expect(await personSnapshot(1)).toMatchObject({ session: { id: 'person-main-1' }, settings: { agents: [], model: selection } })
    expect(await personExecutionAgents(1)).toEqual([])
    await expect(createPersonChatAgent(1, 'person-main-1')).rejects.toMatchObject({ status: 409 })
    await expect(create()).rejects.toThrow('Configure at least one Agent preset')
    expect(runtime.chatAgent).not.toHaveBeenCalled()
    expect(store.listPersonTasks(1)).toEqual([])
    await configurePerson(1, { agents, expected_revision: 0 })
    await expect(createPersonChatAgent(1, 'person-main-1')).resolves.toEqual({})
    expect(runtime.chatAgent).toHaveBeenCalledTimes(1)
    await configurePerson(1, { agents: [], expected_revision: 1 })
    await expect(createPersonChatAgent(1, 'person-main-1')).rejects.toThrow('Configure at least one Agent preset')
    expect(await personExecutionAgents(1)).toEqual([])
    expect(runtime.chatAgent).toHaveBeenCalledTimes(1)
  })

  it('reuses a hidden owned session and preserves ordinary history', async () => {
    const { ensurePersonSession } = await import('../../packages/server/src/modules/studio/services/person/chat-agent')
    const sessions = await import('../../packages/server/src/modules/studio/repositories/session-store')
    const first = await ensurePersonSession(1)
    sessions.addMessage({ session_id: first.session.id, role: 'user', content: 'Private message' })
    await ensurePersonSession(1)
    const other = await ensurePersonSession(2)
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
    await ensurePersonSession(1)
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
    expect(personChatInteraction(1)).toBeUndefined()
    store.setPersonExecution(execution, 'waiting_user')
    expect(personChatInteraction(1)).toMatchObject({ event: 'clarify.requested', data: { session_id: 'person-main-1', question: 'Which scope?', choices: ['A','B'] } })
    expect(personChatInteraction(2)).toBeUndefined()
  })

  it('separates account memory, conversations and tasks while reusing the existing goal table', async () => {
    const { personMemory, personMemories } = await import('../../packages/server/src/modules/studio/services/person/memory')
    const memory = personMemory(1)
    await memory.service.write({ operation: 'create', kind: 'language_preference', node: { title: 'Language', content: 'Prefer Chinese', valueJson: 'Chinese' }, identity: memory.identity, reason: 'User preference' })
    expect(await personMemories(2)).toEqual([])
    const { task } = await create({ start: false })
    expect(() => store.getPersonTask(2, task.id)).toThrow('not found')
    expect(db.prepare('SELECT session_id,source_message_id,bot_id FROM session_tasks WHERE id=?').get(task.id)).toMatchObject({ session_id: null, source_message_id: null, bot_id: 'person:1' })
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
    await ensurePersonSession(1)
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
    await configurePerson(1, { reasoning_effort: 'high', expected_revision: 1 })
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
    await ensurePersonSession(1)
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
  it.each(['queued','starting','running','waiting_person','waiting_user','waiting_approval','stopping'])('locks task mutations while %s', async state => {
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
    for (const action of ['accept','pause','resume','cancel','steer']) {
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
    await schedules.applyPersonSchedule(1, { action: 'create', task_id: task.id, kind: 'cron', expression: '* * * * *', timezone: 'UTC', expected_revision: 0, idempotency_key: 'schedule' })
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
    const main = personTools(1, 'main').map(t => t.name)
    expect(main).toEqual(expect.arrayContaining(['bot_task_create','bot_task_control','bot_agents_list','bot_schedule_apply','bot_decision_request']))
    expect(main.some(t => /shell|terminal|browser|exec_command|file_write/.test(t))).toBe(false)
    expect(main).not.toContain('bot_review_submit')
    expect(main).not.toContain('bot_models_search')
    activeAccount = false
    const { personSnapshot } = await import('../../packages/server/src/modules/studio/services/person/service')
    await expect(personSnapshot(1)).rejects.toThrow('unavailable')
  })
  it('binds revisions and deduplicates concurrent creates, stops and resumes without model plumbing', async () => {
    const { personTools } = await import('../../packages/server/src/modules/studio/services/person/tools')
    const tools = personTools(1, 'main')
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
    expect((await call('bot_tasks_query', { task_id: created.task.id })).task.allowed_actions).toEqual(['stop'])
  })
  it('rejects injected host fields, invalid actions and missing requirements before side effects', async () => {
    const { personTools } = await import('../../packages/server/src/modules/studio/services/person/tools')
    const tools = personTools(1, 'main')
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
    store.createPersonTask(2, 'Private task', 'Private requirements', selection, dir)
    const query = personTools(1, 'main').find(tool => tool.name === 'bot_tasks_query')!
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
    await ensurePersonSession(1); await ensurePersonSession(2)
    const own = addMessage({ session_id: 'person-main-1', role: 'user', content: '仓库调研 report' })
    const foreign = addMessage({ session_id: 'person-main-2', role: 'user', content: 'Private report' })
    const search = personTools(1, 'main').find(tool => tool.name === 'bot_context_search')!
    expect(await search.execute({ query: 'report', ...(messageId !== undefined ? { message_id: messageId } : {}), offset: 0 }))
      .toMatchObject({ evidence: [{ id: own, content: '仓库调研 report' }] })
    expect(await search.execute({ query: '', message_id: own, offset: 0 })).toMatchObject({ evidence: [{ id: own }] })
    await expect(search.execute({ query: 'report', message_id: foreign, offset: 0 })).rejects.toThrow('not found')
    await expect(search.execute({ query: 'report', message_id: -1, offset: 0 })).rejects.toThrow()
  })
  it('rejects cross-account, previous-turn, expired and evicted references', async () => {
    const { personTools } = await import('../../packages/server/src/modules/studio/services/person/tools')
    const tools = personTools(1, 'main')
    const query = tools.find(t => t.name === 'bot_tasks_query')!
    const control = tools.find(t => t.name === 'bot_task_control')!
    const { task } = await create({ start: false })
    const snapshot: any = await query.execute({ task_id: task.id })
    const request = { task_ref: snapshot.task.task_ref, action: 'start' }
    for (const userId of [1, 2]) expect(await personTools(userId, 'main').find(t => t.name === 'bot_task_control')!.execute(request)).toMatchObject({ ok: false, error: { code: 'INVALID_TASK_REF' } })
    expect(await personTools(2, 'main').find(t => t.name === 'bot_tasks_query')!.execute({ task_id: task.id })).toMatchObject({ ok: false, error: { code: 'TASK_UNAVAILABLE' } })
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
    const tools = personTools(1, 'main')
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
    const tools = personTools(1, 'main')
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
    const tools = personTools(1, 'main')
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
    const adopt = { action: 'adopt', task_ref: goals.tasks[0].task_ref, goal: 'Adopted goal', start: false }
    expect(goals.tasks[0].allowed_actions).toEqual(['adopt'])
    expect(await call('bot_task_control', adopt)).toMatchObject({ ok: true, task: { id: 'goal', status: 'open' } })
    expect(await call('bot_task_control', adopt)).toMatchObject({ replayed: true })
    expect(store.getPersonTask(1, 'goal').owner_user_id).toBe(1)
  })
  it('bounds task pages and recovers a committed result after a lost response without duplicate execution', async () => {
    const { personTools } = await import('../../packages/server/src/modules/studio/services/person/tools')
    for (let i = 0; i < 12; i++) await create({ start: false, title: '长'.repeat(200), goal: '详'.repeat(8000) })
    const tools = personTools(1, 'main')
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
    await ensurePersonSession(1)
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
    await ensurePersonSession(1)
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
    schedules.applyPersonSchedule(1, { action: 'create', task_id: task.id, kind: 'cron', expression: '0 9 * * *', timezone: 'UTC', idempotency_key: 'recurring' })
    await runner.tickPersonWork(); await wait(execution.id, 'finished')
    expect(store.getPersonTask(1, task.id).status).toBe('open')
    expect(store.listPersonSchedules(1)[0].state).toBe('active')
    expect(store.getPersonTask(1, task.id).completion_evidence).toBe('Created result.txt with 42')
  })
  it('claims a due occurrence once, persists revisions and skips overlaps', async () => {
    const { task } = await create({ start: false }); const at = Date.now() + 60_000
    const schedule = schedules.applyPersonSchedule(1, { action:'create', task_id:task.id, kind:'once', expression:new Date(at).toISOString(), timezone:'UTC', misfire:'run_latest', idempotency_key:'schedule' })
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
  await ensurePersonSession(1)
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
  await expect(continuePersonTask(1, task.id, { ...request, expected_revision: next.task.revision, idempotency_key: 'busy' })).rejects.toThrow('running')
  await runner.tickPersonWork(); await wait(next.execution.id, 'finished')
  expect(vi.mocked(runtime.execute).mock.calls[0][0].displayInput).toBe('Write 42 into result.txt')
  expect(vi.mocked(runtime.execute).mock.calls[1][0]).toMatchObject({ sessionId: execution.session_id, prompt: input, displayInput: undefined })
  await deliverPersonResults(); finishPersonDelivery(1, next.execution.id, true); await deliverPersonResults()
  expect(runtime.deliver).toHaveBeenCalledTimes(2)
  expect(vi.mocked(runtime.deliver).mock.calls[1][0]).toMatchObject({ origin: { sessionId: 'person-main-1' }, executionId: next.execution.id })
  const { listSessions } = await import('../../packages/server/src/modules/studio/repositories/session-store')
  expect(listSessions().some((s: any) => s.id.startsWith('person-task-'))).toBe(false)
})

it('requires reopening closed tasks and rejects stale, unauthorized or invalid chat turns', async () => {
  const { continuePersonTask, personTaskChat, ownedPersonTaskSession } = await import('../../packages/server/src/modules/studio/services/person/task-chat')
  const { task } = await create({ start: false })
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
  const task = store.createPersonTask(2, 'Private task', 'Read history', selection, dir)
  const chat = await personTaskChat(2, task.id)
  allowedProfiles = []
  await expect(personTaskChat(2, task.id)).rejects.toThrow('permission revoked')
  expect(() => ownedPersonTaskSession(2, chat.session.id)).toThrow('permission revoked')
})


it('queries the same 100-task window as single chat with account-scoped search, status and ordering', async () => {
  for (let i = 0; i < 55; i++) {
    const task = store.createPersonTask(1, `Task ${i}`, 'Find reports', selection, dir)
    db.prepare('UPDATE session_tasks SET updated_at=?,status=? WHERE id=?').run(i + 1, i % 2 ? 'completed' : 'open', task.id)
  }
  store.createPersonTask(2, 'Private report', 'Find reports', selection, dir)
  expect(store.listPersonTasks(1)).toHaveLength(20)
  expect(store.listPersonTasks(1, '', 0, { limit: 100 })).toHaveLength(55)
  const completed = store.listPersonTasks(1, 'reports', 0, { limit: 100, status: 'completed', order: 'oldest' })
  expect(completed).toHaveLength(27)
  expect(completed[0].title).toBe('Task 1')
  expect(completed.at(-1)?.title).toBe('Task 53')
  expect(store.listPersonTasks(1, 'Private report', 0, { limit: 100 })).toEqual([])
})


it('uses the complete native memory toolset within the minimum Person budget', async () => {
  const { createPersonAgent } = await import('../../packages/server/src/bootstrap/person-chat-agent')
  const { createPersonChatAgent, ensurePersonSession } = await import('../../packages/server/src/modules/studio/services/person/chat-agent')
  const { personMemory } = await import('../../packages/server/src/modules/studio/services/person/memory')
  const { countTextTokens } = await import('../../packages/ekko-agent/src/model/tokens')
  runtime.chatAgent = createPersonAgent
  modelContextLength = 8000
  await ensurePersonSession(1)
  const account = personMemory(1)
  await account.service.write({operation:'create',kind:'profile_name',identity:account.identity,reason:'User name',node:{title:'Name',content:'用户的名字是 ekko',valueJson:'ekko'}})
  const requests: any[] = []
  const agent = await createPersonChatAgent(1, 'person-main-1')
  await agent.run({ messages: [{role:'user',content:'我的名字是什么'}], memoryInput: {messages:[{role:'user',content:'我的名字是什么'}]},
    modelClient: { provider:'test', capabilities:{streaming:true,tools:true,vision:false,jsonMode:false,systemPrompt:true},
      create:async()=>({content:'summary'}), async *stream(request) { requests.push(request); yield {type:'done',response:{content:'ekko'}} } } })
  await account.service.drain()
  expect(requests).toHaveLength(1)
  expect(requests[0].tools.map((t:any)=>t.name)).toContain('memory_write')
  expect(JSON.stringify(requests[0].messages)).toContain('用户的名字是 ekko')
  expect(Math.ceil(countTextTokens(JSON.stringify({ messages: requests[0].messages, tools: requests[0].tools })) * 1.15) + 2048 + 1024).toBeLessThanOrEqual(8000)
})

it('resumes a saved task through Responses list, history search and control without exhausting steps', async () => {
  const { createPersonAgent } = await import('../../packages/server/src/bootstrap/person-chat-agent')
  const { createPersonChatAgent, ensurePersonSession } = await import('../../packages/server/src/modules/studio/services/person/chat-agent')
  const { OpenAIResponsesModelClient } = await import('../../packages/ekko-agent/src/model/providers/openai-responses')
  const { addMessage } = await import('../../packages/server/src/modules/studio/repositories/session-store')
  runtime.chatAgent = createPersonAgent
  await ensurePersonSession(1)
  const evidenceId = addMessage({ session_id: 'person-main-1', role: 'user', content: '调研这个仓库，并给我一份报告。' })
  const { task } = await create({ title: '仓库调研', goal: '调研仓库并提供报告', start: false })
  const bodies: any[] = [], events: any[] = []
  let taskRef = ''
  const modelClient = new OpenAIResponsesModelClient({ id: 'test', type: 'openai', defaultModel: 'm', baseUrl: 'https://model.example.test/v1' }, {
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)); bodies.push(body)
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
  await ensurePersonSession(1)
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
  await ensurePersonSession(1)
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

it('uses one account workspace for creation, adoption, scheduled runs and follow-up turns', async () => {
  const { configurePerson, personSnapshot } = await import('../../packages/server/src/modules/studio/services/person/service')
  const { personTaskChat, continuePersonTask } = await import('../../packages/server/src/modules/studio/services/person/task-chat')
  const sessions = await import('../../packages/server/src/modules/studio/repositories/session-store')
  const delivery = await import('../../packages/server/src/modules/studio/services/person/delivery')
  const selected = join(dir, 'selected-workspace')
  await configurePerson(1, { workspace: selected, expected_revision: 1 })
  expect((await personSnapshot(1)).session.workspace).toBe(selected)
  sessions.createSession({ id: 'workspace-owned', profile: 'default', studio_user_id: '1', source: 'coding_agent' })
  sessions.addMessage({ session_id: 'workspace-owned', role: 'user', content: 'Take over this goal' })
  const goals = await import('../../packages/server/src/modules/studio/services/session-tasks')
  const original = goals.updateSessionTasks('workspace-owned', 'default', { revision: 0, changes: [{ title: 'Existing goal', summary: 'Take over', status: 'open' }] }).tasks[0]
  const adopted = await create({ action: 'adopt', task_id: original.id, expected_revision: original.updated_at, start: false })
  expect(adopted.task.workspace).toBe(selected)
  const first = await create()
  const second = await create({ start: false })
  expect(first.task.workspace).toBe(selected)
  expect(second.task.workspace).toBe(selected)
  await expect(create({ workspace: join(dir, 'individual-override') })).rejects.toThrow('managed by Person')
  await expect(configurePerson(1, { workspace: dir, expected_revision: 2 })).rejects.toThrow('Wait for Person tasks')
  await runner.tickPersonWork(); await wait(first.execution.id, 'finished')
  await delivery.deliverPersonResults(); delivery.finishPersonDelivery(1, first.execution.id, true)
  expect(vi.mocked(runtime.execute).mock.calls[0][0].workspace).toBe(selected)
  const chat = await personTaskChat(1, first.task.id)
  const nextWorkspace = join(dir, 'next-workspace')
  await configurePerson(1, { workspace: nextWorkspace, expected_revision: 2 })
  expect(store.getPersonTask(1, first.task.id).workspace).toBe(nextWorkspace)
  expect(store.getPersonTask(1, adopted.task.id).workspace).toBe(nextWorkspace)
  expect(sessions.getSession(chat.session.id)?.workspace).toBe(nextWorkspace)
  const next: any = await continuePersonTask(1, first.task.id, { input: [{ type: 'text', text: 'Continue the same work' }], expected_revision: store.getPersonTask(1, first.task.id).revision, idempotency_key: 'workspace-follow-up' })
  await runner.tickPersonWork(); await wait(next.execution.id, 'finished')
  await delivery.deliverPersonResults(); delivery.finishPersonDelivery(1, next.execution.id, true)
  expect(vi.mocked(runtime.execute).mock.calls[1][0]).toMatchObject({ sessionId: chat.session.id, workspace: nextWorkspace })
  const at = Date.now() + 60_000
  schedules.applyPersonSchedule(1, { action: 'create', task_id: second.task.id, kind: 'once', expression: new Date(at).toISOString(), timezone: 'UTC', idempotency_key: 'workspace-schedule' })
  schedules.tickPersonSchedules(at)
  const occurrence = store.taskPersonExecutions(1, second.task.id)[0]
  await runner.tickPersonWork(); await wait(occurrence.id, 'finished')
  expect(vi.mocked(runtime.execute).mock.calls[2][0].workspace).toBe(nextWorkspace)
  expect((await personSnapshot(2)).session.workspace).not.toBe(nextWorkspace)
})

it('restores a shared private workspace when the selected workspace is cleared', async () => {
  const { configurePerson, personSnapshot } = await import('../../packages/server/src/modules/studio/services/person/service')
  await expect(configurePerson(1, { workspace: '../relative', expected_revision: 1 })).rejects.toThrow('absolute')
  await configurePerson(1, { workspace: '', expected_revision: 1 })
  const snapshot = await personSnapshot(1)
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
  await ensurePersonSession(1); await ensurePersonSession(2)
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
  const other = store.createPersonTask(2, 'Other account task', 'Keep this task', selection, dir)
  const { task, execution } = await create()
  const chat = await personTaskChat(1, task.id)
  sessions.addMessage({ session_id: chat.session.id, role: 'user', content: 'Private worker input' })
  store.setPersonExecution(execution, 'finished', { output: 'Old result' })
  db.prepare("UPDATE person_deliveries SET state='delivered' WHERE execution_id=?").run(execution.id)
  store.personEvent(execution, 'run.finished', { output: 'Old result' })
  store.addPersonInteraction(1, execution, 'old-question', 'Old question', [])
  savePersonTaskReturn(1, execution.id, 'person-main-1', assistant)
  const schedule = schedules.applyPersonSchedule(1, { action: 'create', task_id: task.id, kind: 'cron', expression: '0 9 * * *', timezone: 'UTC', idempotency_key: 'clear-schedule' })
  db.prepare('INSERT INTO person_occurrences VALUES (?,?,?,?,?,?)').run('past-occurrence', schedule.id, 0, 1, 'finished', execution.id)
  const file = join(dir, 'keep-result.txt'); writeFileSync(file, 'Keep the output file')
  const settingsBefore = store.personSettings(1)
  expect((await personSnapshot(1)).can_clear).toBe(true)
  expect(await clearPerson(1, { expected_history_revision: 0 })).toMatchObject({ cleared: true, deleted_tasks: 1 })
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
  await expect(clearPerson(1, { expected_history_revision: 0 })).rejects.toThrow('changed')
  expect(sessions.getSessionDetail('person-main-1')?.messages).toHaveLength(1)
})

it.each(['queued','starting','running','waiting_person','waiting_user','waiting_approval','stopping','pending_delivery','queued_delivery','main_reply'])('rejects clearing while %s without removing records', async state => {
  const { ensurePersonSession } = await import('../../packages/server/src/modules/studio/services/person/chat-agent')
  const { clearPerson } = await import('../../packages/server/src/modules/studio/services/person/history')
  const { personSnapshot } = await import('../../packages/server/src/modules/studio/services/person/service')
  const sessions = await import('../../packages/server/src/modules/studio/repositories/session-store')
  await ensurePersonSession(1)
  sessions.addMessage({ session_id: 'person-main-1', role: 'user', content: 'Keep while running' })
  const { task, execution } = await create()
  if (state.endsWith('_delivery')) {
    store.setPersonExecution(execution, 'finished')
    db.prepare('UPDATE person_deliveries SET state=? WHERE execution_id=?').run(state.startsWith('pending') ? 'pending' : 'queued', execution.id)
  } else if (state === 'main_reply') { mainBusy = true }
  else db.prepare('UPDATE person_executions SET state=? WHERE id=?').run(state, execution.id)
  expect((await personSnapshot(1)).can_clear).toBe(false)
  await expect(clearPerson(1, { expected_history_revision: 0 })).rejects.toThrow('finish')
  expect(store.getPersonTask(1, task.id)).toBeTruthy()
  expect(sessions.getSessionDetail('person-main-1')?.messages).toHaveLength(1)
  mainBusy = false
})
