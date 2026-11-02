import { expect, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PersonRuntimePort } from '../../../packages/server/src/modules/studio/public/person-runtime'
import type { PersonExecution, PersonTask } from '../../../packages/server/src/modules/studio/contracts/person'
import type { PersonAcceptanceReport } from '../../../packages/server/src/modules/studio/contracts/person-acceptance'

export const selection = { runtime: 'ekko', mode: 'scoped' as const, profile: 'default', provider: 'fixture', model: 'test-model', apiMode: 'chat_completions' }
export const acceptance = { enabled: true, criteria: ['REVIEW_ONLY: independently check result.txt equals 42 and save evidence'], verifier_agent_id: 'reviewer', max_attempts: 3, timeout_minutes: 2 }
type Result = { task: PersonTask; execution: PersonExecution }
type RunInput = Parameters<PersonRuntimePort['execute']>[0]

/** Feature-local fixture: real schema, tasks, queue, callbacks and files; no provider or user DB. */
export async function acceptanceFixture(options: { automatic?: boolean } = {}) {
  vi.resetModules()
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'studio-acceptance-')))
  const databasePath = join(workspace, 'state.db')
  let db = new DatabaseSync(databasePath)
  vi.doMock('../../../packages/server/src/modules/studio/infrastructure/database/index', () => ({ getDb: () => db, isSqliteAvailable: () => true }))
  vi.doMock('../../../packages/server/src/modules/studio/public/config', () => ({ config: { appHome: workspace }, getWebUiHome: () => workspace }))
  vi.doMock('../../../packages/server/src/modules/studio/public/provider-runtime', () => ({ getModelContextLength: () => 16000 }))
  vi.doMock('../../../packages/server/src/modules/studio/public/chat-run', () => ({ getChatRunServer: () => ({ isSessionRunning: () => false, disposeSession: vi.fn(async () => {}), clearSessionHistory: vi.fn() }) }))
  vi.doMock('../../../packages/server/src/modules/studio/repositories/users-store', () => ({
    findUserById: (id: number) => ({ id, status: 'active', role: 'super_admin', username: `fixture-${id}` }),
    listUserProfiles: () => [{ profile_name: 'default' }], userCanAccessProfile: () => true,
  }))
  vi.doMock('../../../packages/server/src/modules/studio/public/profile-config', () => ({ listProfileNamesFromDisk: () => ['default'], getActiveProfileName: () => 'default', readConfigYamlForProfile: async () => ({}) }))
  vi.doMock('../../../packages/server/src/modules/studio/public/agent-status-registry', () => ({ getAgentAvailabilitySnapshot: () => ({ agents: [{ id: 'ekko-agent', installed: true }] }) }))
  vi.doMock('../../../packages/server/src/modules/studio/public/session-agent-runtime', () => ({ getSessionAvailableModelGroups: async () => [{ provider: 'fixture', models: ['test-model'], api_mode: 'chat_completions' }], validateCodingAgentModelEffort: vi.fn(async () => {}) }))
  vi.doMock('../../../packages/server/src/modules/studio/services/usage/usage-recorder', () => ({ recordSessionUsage: vi.fn() }))
  const schema = await import('../../../packages/server/src/modules/studio/infrastructure/database/schemas')
  schema.initAllHermesTables()
  const { createSession } = await import('../../../packages/server/src/modules/studio/repositories/session-store')
  for (const owner of [1, 2]) createSession({ id: `person-main-${owner}`, studio_user_id: owner, user_id: owner, title: 'Fixture', workspace, source: 'builtin_agent', agent: 'ekko-agent', agent_preset: 'person', profile: 'default' })
  const store = await import('../../../packages/server/src/modules/studio/repositories/person-store')
  const tasks = await import('../../../packages/server/src/modules/studio/services/person/tasks')
  const runner = await import('../../../packages/server/src/modules/studio/services/person/runner')
  const schedules = await import('../../../packages/server/src/modules/studio/services/person/schedules')
  const detail = await import('../../../packages/server/src/modules/studio/repositories/person-acceptance-store')
  const chat = await import('../../../packages/server/src/modules/studio/services/person/task-chat')
  const { personTaskTools } = await import('../../../packages/server/src/modules/studio/services/person/task-tools')
  const runtime: PersonRuntimePort = {
    modelConfig: vi.fn(async () => ({ default: 'test-model', default_provider: 'fixture', groups: [{ provider: 'fixture', models: ['test-model'], api_mode: 'chat_completions' }] })),
    model: vi.fn(async () => 'unused'), nativeModels: vi.fn(async () => ({ status: 'ready', models: [] })),
    deliver: vi.fn(async () => {}), deliverStage: vi.fn(async () => {}),
    execute: vi.fn(), answer: vi.fn(async () => true), stop: vi.fn(async () => {}),
  }
  const { configurePersonRuntime } = await import('../../../packages/server/src/modules/studio/public/person-runtime')
  configurePersonRuntime(runtime)
  const current = store.personSettings(1)
  store.savePersonSettings(1, { ...current.settings, workspace, agents: [{ id: 'reviewer', name: 'Fixture worker', description: 'Fixture only', selection }] }, current.revision)

  const get = (taskId: string) => store.getPersonTask(1, taskId)
  const receipt = (executionId: string) => db.prepare('SELECT * FROM person_acceptance WHERE execution_id=?').get(executionId)!
  const execute = vi.mocked(runtime.execute)
  const decisions = new Map<string,PersonAcceptanceReport>()
  function assessment(input: RunInput): PersonAcceptanceReport {
    const round = db.prepare('SELECT * FROM person_acceptance_attempts WHERE session_id=?').get(input.sessionId)!
    const directory = join(workspace, '.studio-acceptance', String(round.execution_id), String(round.ordinal))
    let passed = true, evidence = ''
    try {
      evidence = execFileSync(process.execPath, ['-e', "const fs=require('node:fs'),assert=require('node:assert/strict');const actual=fs.readFileSync(process.argv[1],'utf8');console.log(JSON.stringify({actual,expected:'42'}));assert.equal(actual,'42');console.log('PASS');", join(workspace, 'result.txt')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error: any) { passed = false; evidence = `${error.stdout}\n${error.stderr}` }
    writeFileSync(join(directory, 'check.log'), evidence)
    const result:PersonAcceptanceReport={ verdict: passed ? 'passed' : 'failed', summary: passed ? 'File check passed' : 'Expected 42; observed 41', checks: [{ criterion_id: 'c1', status: passed ? 'passed' : 'failed', findings: passed ? 'Checked artifact with Node assert' : 'Expected 42; observed 41', evidence: [{ path: 'check.log', description: 'Actual Node subprocess output' }],issues:[] }] }
    decisions.set(input.sessionId,result)
    return result
  }
  function report(input:RunInput) {
    const result=assessment(input)
    return {ok:true,output:`I independently checked result.txt with a Node assertion subprocess.\n\n${result.summary}. ${result.checks[0].findings}.\n\nEvidence: check.log — actual command output.\nThe product files were not changed.`}
  }
  function worker(first = '42', repaired = '42', review = report) {
    let development = 0
    execute.mockImplementation(async input => {
      input.onEvent('run.started', { run_id: randomUUID() })
      if (input.purpose === 'verification') {
        const round=db.prepare('SELECT execution_id FROM person_acceptance_attempts WHERE session_id=?').get(input.sessionId)!
        if(receipt(String(round.execution_id)).orchestration==='legacy') return {ok:true,output:JSON.stringify(assessment(input))}
        return review(input)
      }
      writeFileSync(join(workspace, 'result.txt'), development++ ? repaired : first)
      return { ok: true, output: 'Created result.txt; open the file to read the result.' }
    })
  }
  worker()
  function retainPreviousProgression(taskId: string) {
    if (options.automatic) return
    // Existing compatibility cases represent immutable cycles created before host progression.
    db.prepare("UPDATE session_tasks SET requirements_json=json_remove(requirements_json,'$.acceptance.progression') WHERE id=?").run(taskId)
    db.prepare("UPDATE person_acceptance SET snapshot_json=json_remove(snapshot_json,'$.requirements.acceptance.progression') WHERE task_id=?").run(taskId)
  }
  async function create(overrides = {}): Promise<Result> {
    const result = await tasks.applyPersonTask(1, { action: 'create', session_id: 'person-main-1', idempotency_key: randomUUID(), title: 'Write a result', goal: 'Write 42 into result.txt and deliver its path.', ...overrides }) as Result
    retainPreviousProgression(result.task.id)
    return { ...result, task: get(result.task.id) }
  }
  async function settle(taskId: string) {
    await vi.waitFor(() => expect(['finished', 'failed', 'interrupted']).toContain(get(taskId).execution_state), { timeout: 4000, interval: 10 })
    return get(taskId)
  }
  async function run(taskId: string) { retainPreviousProgression(taskId); await runner.tickPersonWork(); return settle(taskId) }
  async function verify(taskId: string): Promise<Result> {
    const task = get(taskId)
    return await tasks.applyPersonTask(1, { action: 'verify', task_id: taskId, expected_revision: task.revision, expected_execution_id: task.execution_id, idempotency_key: randomUUID() }) as Result
  }
  async function repair(taskId: string) {
    const task = get(taskId)
    return chat.continuePersonTask(1, taskId, { expected_revision: task.revision, expected_execution_id: task.execution_id, idempotency_key: randomUUID(), input: [{ type: 'text', text: 'Repair the concrete defects in the review.' }] })
  }
  async function record(taskId:string,report?:PersonAcceptanceReport,origin?:Parameters<typeof tasks.applyPersonTask>[3]) {
    const task=get(taskId), round=db.prepare('SELECT * FROM person_acceptance_attempts WHERE execution_id=? AND ordinal=?').get(task.execution_id!,receipt(task.execution_id!).attempt)!
    return tasks.applyPersonTask(1,{action:'record_acceptance',task_id:task.id,expected_revision:task.revision,expected_execution_id:task.execution_id,verification_execution_id:round.verification_execution_id,report:report || decisions.get(String(round.session_id)),idempotency_key:randomUUID()},undefined,origin)
  }
  async function reopen() {
    await runner.stopPersonWork()
    db.close(); db = new DatabaseSync(databasePath)
    schema.initAllHermesTables()
  }
  async function close(name: string) {
    await runner.stopPersonWork()
    const { closePersonMemoryStores } = await import('../../../packages/server/src/modules/studio/services/person/memory')
    closePersonMemoryStores()
    if (process.env.ACCEPTANCE_TEST_EVIDENCE_DIR) {
      const destination = join(process.env.ACCEPTANCE_TEST_EVIDENCE_DIR, createHash('sha256').update(name).digest('hex').slice(0, 16))
      mkdirSync(destination, { recursive: true })
      writeFileSync(join(destination, 'receipts.json'), JSON.stringify({ test: name, dispatch: 'stubbed runtime; real SQLite, HTTP/task tools, files and assertion subprocess', calls: execute.mock.calls.map(([i]) => ({ purpose: i.purpose, session_id: i.sessionId, prompt: i.prompt })), tasks: store.listPersonTasks(1), receipts: db.prepare('SELECT * FROM person_acceptance').all(), rounds: db.prepare('SELECT * FROM person_acceptance_attempts').all() }, null, 2))
      if (existsSync(join(workspace, '.studio-acceptance'))) cpSync(join(workspace, '.studio-acceptance'), join(destination, 'evidence'), { recursive: true })
    }
    db.close(); rmSync(workspace, { recursive: true, force: true }); vi.restoreAllMocks()
  }
  return { get db() { return db }, workspace, databasePath, store, tasks, runner, schedules, detail, chat, personTaskTools, schema, runtime, execute, get, receipt, report, assessment, decisions, worker, create, settle, run, verify, repair, record, reopen, close }
}
export type AcceptanceFixture = Awaited<ReturnType<typeof acceptanceFixture>>
