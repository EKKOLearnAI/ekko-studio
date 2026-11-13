import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { acceptanceFixture, acceptance, type AcceptanceFixture } from './fixtures/person-acceptance'
import { parsePersonResultQueueId, personResultQueueId } from '../../packages/server/src/modules/studio/contracts/person-session'
import type { PersonChatAgentOptions } from '../../packages/server/src/modules/studio/public/person-runtime'

let f: AcceptanceFixture
beforeEach(async () => { f = await acceptanceFixture() })
afterEach(async context => { await f?.close(context.task.name) })
const complete = (id: string) => f.db.prepare("UPDATE session_tasks SET status='completed' WHERE id=?").run(id)

it('opens the original execution for a cross-Bot acceptance return and keeps its pending report visible', async () => {
  const { createSession } = await import('../../packages/server/src/modules/studio/repositories/session-store')
  const { createPersonChatAgent } = await import('../../packages/server/src/modules/studio/services/person/chat-agent')
  const { finishPersonDelivery } = await import('../../packages/server/src/modules/studio/services/person/delivery')
  const { personBackgroundTaskCount } = await import('../../packages/server/src/modules/studio/repositories/person-presence-store')
  const reviewer = 'person-main-reviewer'
  createSession({ id: reviewer, studio_user_id: 1, user_id: 1, title: '暖暖', workspace: f.workspace, source: 'builtin_agent', agent: 'ekko-agent', agent_preset: 'person', profile: 'default' })
  const { task, execution } = await f.create({ acceptance: { ...acceptance, reviewer_session_id: reviewer } })
  await f.run(task.id); await f.runner.tickPersonWork(); finishPersonDelivery(1, execution.id, true)
  const review = await f.verify(task.id); await f.run(review.task.id)
  await f.record(task.id, undefined, { sessionId: reviewer, runId: 'review-bot', messages: [], returnExecutionId: review.execution.id })
  await f.runner.tickPersonWork()
  const returned = vi.mocked(f.runtime.deliver).mock.calls.at(-1)![0]
  expect(returned).toMatchObject({ taskId: task.id, origin: { sessionId: 'person-main-1', acceptanceReturnId: review.execution.id }, acceptance: { next_action: 'report' } })
  const queueId = personResultQueueId(returned.executionId, returned.origin.acceptanceReturnId)
  const identity = parsePersonResultQueueId(queueId)!
  expect(identity).toEqual({ executionId: execution.id, acceptanceReturnId: review.execution.id })
  expect(f.store.personBackgroundPendingCount('person-main-1', identity.executionId)).toBe(0)
  expect(f.store.personBackgroundPendingCount('person-main-1', queueId.slice('person-result:'.length))).toBe(1)
  const factory = vi.fn((options: PersonChatAgentOptions) => ({ sessionWorkspaceDirectory: () => options.workspace, requestBoundaryInterrupt: vi.fn(), estimateContext: vi.fn(), run: vi.fn() }))
  f.runtime.chatAgent = factory
  await createPersonChatAgent(1, 'person-main-1', identity)
  const options = factory.mock.calls[0][0]
  expect(options).toMatchObject({ returnExecutionId: execution.id, acceptanceReturnId: review.execution.id, workspace: f.workspace })
  expect(() => options.beforeRequest!()).not.toThrow()
  expect(f.get(task.id)).toMatchObject({ status: 'completed', running: 1 })
  expect(personBackgroundTaskCount(1, 'person-main-1')).toBe(1)
  expect(f.store.listPersonTasks(1, '', 0, { sessionId: 'person-main-1', activeOnly: true })).toMatchObject([{ id: task.id, status: 'completed', execution_id: execution.id }])
  const opened = await f.chat.personTaskChat(1, task.id, identity.executionId)
  expect(opened.session?.id).toBe(execution.session_id)
  finishPersonDelivery(1, execution.id, true, '', identity.acceptanceReturnId)
  expect(personBackgroundTaskCount(1, 'person-main-1')).toBe(0)
  expect(f.store.listPersonTasks(1, '', 0, { sessionId: 'person-main-1', activeOnly: true })).toEqual([])
  f.db.prepare("UPDATE person_deliveries SET origin_json=json_set(origin_json,'$.acceptanceReturnId','newer-review') WHERE execution_id=?").run(execution.id)
  expect(() => options.beforeRequest!()).toThrow(/superseded/)
})

it('includes an older pending report in activity even beyond the recent task page, scoped to its Bot and owner', async () => {
  const { task, execution } = await f.create(); await f.run(task.id)
  f.db.prepare("UPDATE session_tasks SET updated_at=1 WHERE id=?").run(task.id)
  for (let i = 0; i < 101; i++) f.store.createPersonTask(1, `Recent idle ${i}`, 'No work', JSON.parse(task.selection_json), f.workspace, 'person-main-1')
  expect(f.store.listPersonTasks(1, '', 0, { sessionId: 'person-main-1', limit: 100 }).some(row => row.id === task.id)).toBe(false)
  const { personSnapshot } = await import('../../packages/server/src/modules/studio/services/person/service')
  const snapshot = await personSnapshot(1, 'person-main-1')
  expect(snapshot.active_agent_task_count).toBe(1)
  expect(snapshot.active_tasks).toMatchObject([{ id: task.id, status: 'completed', execution_id: execution.id }])
  expect(snapshot.tasks.some(row => row.id === task.id)).toBe(false)
  expect(f.store.listPersonTasks(1, '', 0, { sessionId: 'person-main-2', activeOnly: true })).toEqual([])
  expect(f.store.listPersonTasks(2, '', 0, { activeOnly: true })).toEqual([])
})

it('preserves ordinary return identity and ignores other background queue formats', () => {
  expect(parsePersonResultQueueId(personResultQueueId('worker'))).toEqual({ executionId: 'worker' })
  for (const value of [undefined, 'person-stage:worker', 'person-result:', 'person-result:worker:', 'person-result:worker:review:extra']) expect(parsePersonResultQueueId(value)).toBeUndefined()
})

it('returns development and criteria to Bot, then a fresh task passes through real tools and HTTP detail', async () => {
  const { default: Koa } = await import('koa')
  const { bodyParser } = await import('@koa/bodyparser')
  const { personRoutes } = await import('../../packages/server/src/modules/studio/routes/person')
  const app = new Koa()
  app.use(bodyParser()); app.use(async (ctx, next) => { ctx.state.user = { id: 1 }; await next() }); app.use(personRoutes.routes())
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/studio/person`
  try {
    const response = await fetch(base + '/tasks/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'create', session_id: 'person-main-1', title: 'HTTP result', goal: 'Write 42 into result.txt.', acceptance, idempotency_key: randomUUID() }) })
    expect(response.status).toBe(200)
    const { task, execution } = await response.json() as any
    expect(() => complete(task.id)).toThrow(/Acceptance/)
    expect((await f.run(task.id)).status).toBe('open')
    expect(f.receipt(execution.id).state).toBe('awaiting_dispatch')
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(f.execute.mock.calls[0][0].prompt)).not.toContain('REVIEW_ONLY')
    await f.runner.tickPersonWork()
    expect(f.runtime.deliver).toHaveBeenCalledWith(expect.objectContaining({ taskId: task.id, output: expect.stringContaining('result.txt'), acceptance: expect.objectContaining({ next_action: 'verify', criteria: [{ id: 'c1', text: acceptance.criteria[0] }] }) }))
    const tools = f.personTaskTools(1, 'person-main-1')
    const query: any = await tools.find(t => t.name === 'bot_tasks_query')!.execute({ task_id: task.id })
    const review: any = await tools.find(t => t.name === 'bot_task_control')!.execute({ action: 'verify', task_ref: query.task.task_ref })
    expect(review.ok).toBe(true); expect(review.task.id).not.toBe(task.id)
    expect(() => complete(review.task.id)).toThrow(/verification/)
    await f.run(review.task.id)
    expect(f.receipt(execution.id).state).toBe('awaiting_review')
    expect(f.get(task.id).status).toBe('open')
    expect(() => complete(task.id)).toThrow(/Acceptance/)
    await f.runner.tickPersonWork()
    expect(f.runtime.deliver).toHaveBeenCalledWith(expect.objectContaining({taskId:review.task.id,output:expect.stringContaining('I independently checked'),acceptance:expect.objectContaining({next_action:'review'})}))
    const returned:any=await tools.find(t=>t.name==='bot_tasks_query')!.execute({task_id:task.id})
    expect(returned.task.acceptance_result.report.text).toContain('I independently checked')
    const recorded=await tools.find(t=>t.name==='bot_task_control')!.execute({action:'record_acceptance',task_ref:returned.task.task_ref,verification_execution_id:review.execution.id,report:f.decisions.get(f.store.getPersonExecution(1,review.execution.id).session_id)},
      {sessionId:'person-main-1',runId:'bot-reviewed',messages:[],returnExecutionId:review.execution.id})
    expect(recorded).toMatchObject({ok:true})
    const detail = await (await fetch(base + `/tasks/${task.id}/chat`)).json() as any
    expect(detail.task.status).toBe('completed')
    expect(detail.acceptance).toMatchObject({ state: 'passed', verification_task_id: review.task.id })
    const [round] = detail.acceptance.attempts
    const evidence = round.evidence[0]
    expect(evidence.sha256).toBe(createHash('sha256').update(readFileSync(evidence.path)).digest('hex'))
    expect(round.session_id).not.toBe(execution.session_id)
    expect(round.run_id).toBeTruthy()
    expect(round.raw_output).toContain('I independently checked')
    expect(JSON.parse(round.decision_json)).toMatchObject({source:'bot_callback',run_id:'bot-reviewed'})
    expect(f.execute.mock.calls.map(([input]) => input.purpose)).toEqual(['development', 'verification'])
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

it('repairs in the original developer task/session and rechecks in the SAME review task and Agent', async () => {
  f.worker('41')
  const { task, execution } = await f.create({ acceptance })
  await f.run(task.id)
  const first = await f.verify(task.id); await f.run(first.task.id)
  await f.record(task.id)
  expect(f.receipt(execution.id)).toMatchObject({ state: 'repair_required', attempt: 1 })
  await expect(f.verify(task.id)).rejects.toThrow(/repair/)
  const repair = await f.repair(task.id)
  expect(repair.task.id).toBe(task.id); expect(repair.execution.session_id).toBe(execution.session_id)
  expect(f.receipt(repair.execution.id).deadline).toBe(f.receipt(execution.id).deadline)
  await f.run(task.id)
  const second = await f.verify(task.id)
  expect(second.task.id).toBe(first.task.id)
  expect(second.execution.selection_json).toBe(first.execution.selection_json)
  expect(second.execution.id).not.toBe(first.execution.id)
  await f.run(second.task.id)
  await f.record(task.id)
  expect(f.get(task.id).status).toBe('completed')
  const rounds = f.detail.personAcceptanceDetail(1, task.id)!.attempts
  expect(rounds.map(r => r.ordinal)).toEqual([1, 2])
  expect(new Set(rounds.map(r => r.run_id)).size).toBe(2)
  expect(f.store.listPersonTasks(1)).toHaveLength(2)
  const calls = f.execute.mock.calls.map(([input]) => input)
  expect(JSON.stringify(calls[2].prompt)).toContain('Expected 42; observed 41')
  expect(JSON.stringify(calls[2].prompt)).not.toContain('REVIEW_ONLY')
  expect(calls.map(i => i.purpose)).toEqual(['development', 'verification', 'development', 'verification'])
})

it('exhausts one shared budget across repairs and stops with a concrete unfinished reason', async () => {
  f.worker('41', '41')
  const { task } = await f.create({ acceptance: { ...acceptance, max_attempts: 2 } })
  await f.run(task.id)
  const first = await f.verify(task.id); await f.run(first.task.id)
  await f.record(task.id)
  await f.repair(task.id); await f.run(task.id)
  const second = await f.verify(task.id); await f.run(second.task.id)
  await f.record(task.id)
  expect(second.task.id).toBe(first.task.id)
  expect(f.receipt(f.get(task.id).execution_id!)).toMatchObject({ state: 'failed', attempt: 2, reason: expect.stringContaining('Expected 42') })
  expect(f.get(task.id).status).toBe('open')
  await expect(f.verify(task.id)).rejects.toThrow()
  await f.runner.tickPersonWork(); expect(f.execute).toHaveBeenCalledTimes(4)
  expect(() => complete(task.id)).toThrow(/Acceptance/)
})

it('retries missing review evidence in the same task without rerunning development', async () => {
  const { task, execution } = await f.create({ acceptance }); await f.run(task.id)
  const first = await f.verify(task.id); await f.run(first.task.id)
  const unsupported=structuredClone(f.decisions.get(first.execution.session_id)!)
  unsupported.checks[0].evidence=[]
  await expect(f.record(task.id,unsupported)).rejects.toThrow(/Missing evidence/)
  expect(f.receipt(execution.id).state).toBe('awaiting_review')
  expect(() => complete(task.id)).toThrow(/Acceptance/)
  const second = await f.verify(task.id); await f.run(second.task.id)
  await f.record(task.id)
  expect(second.task.id).toBe(first.task.id); expect(f.get(task.id).status).toBe('completed')
  expect(f.execute.mock.calls.map(([input]) => input.purpose)).toEqual(['development', 'verification', 'verification'])
})

it.each(['empty', 'outside', 'contradictory', 'partial'])('rejects a Bot decision with %s evidence/checks rather than completing', async kind => {
  const { task, execution } = await f.create({ acceptance: { ...acceptance, max_attempts: 1 } }); await f.run(task.id)
  const review = await f.verify(task.id); await f.run(review.task.id)
  const report=structuredClone(f.decisions.get(review.execution.session_id)!)
  if (kind === 'partial') report.checks=[]
  if (kind === 'contradictory') report.checks[0].status='failed'
  if (kind === 'outside') report.checks[0].evidence[0].path=join(f.workspace,'result.txt')
  if (kind === 'empty') { const path=join(f.workspace,'.studio-acceptance',execution.id,'1','empty.log');writeFileSync(path,'');report.checks[0].evidence[0].path=path }
  await expect(f.record(task.id,report)).rejects.toThrow(/Cannot record acceptance/)
  expect(f.receipt(execution.id)).toMatchObject({ state:'awaiting_review',attempt:1 })
  expect(f.get(task.id).status).toBe('open'); expect(() => complete(task.id)).toThrow(/Acceptance/)
})

it.each(['prose', 'markdown', 'Chinese'])('returns %s reports to Bot without parsing or automatically accepting them', async format => {
  f.worker('42', '42', input => {
    const result=f.report(input)
    return {...result,output:format==='prose'?result.output:format==='markdown'?`# Review\n\n${result.output}\n\nChecked {layout}, "email" and C:\\screenshots\\.`:'已经逐项独立检查，文件内容符合要求。证据保存在 check.log，可查看实际命令输出。'}
  })
  const { task, execution } = await f.create({ acceptance }); await f.run(task.id)
  const review = await f.verify(task.id); await f.run(review.task.id)
  expect(f.receipt(execution.id).state).toBe('awaiting_review')
  expect(f.get(task.id).status).toBe('open')
  await f.record(task.id)
  expect(f.receipt(execution.id)).toMatchObject({ state: 'passed', attempt: 1 })
  expect(f.get(task.id).status).toBe('completed')
  expect(f.execute).toHaveBeenCalledTimes(2)
})

it('does not treat a passed keyword or an embedded JSON claim as a decision', async () => {
  f.worker('41','41',input=>{f.assessment(input);return {ok:true,output:'Earlier note: {"verdict":"passed"}. Final review: this did NOT pass; expected 42 but found 41. See check.log.'}})
  const { task, execution } = await f.create({ acceptance: { ...acceptance, max_attempts: 1 } }); await f.run(task.id)
  const review = await f.verify(task.id); await f.run(review.task.id)
  expect(f.receipt(execution.id).state).toBe('awaiting_review')
  await f.record(task.id)
  expect(f.receipt(execution.id).state).toBe('failed')
  expect(f.get(task.id).status).toBe('open')
  expect(() => complete(task.id)).toThrow(/Acceptance/)
})

it.each(['environment', 'runtime', 'user-decision', 'identity', 'empty-report'])('blocks on %s without automatic loops or false completion', async kind => {
  f.worker('42', '42', input => {
    if (kind === 'environment') return { ok: true, output: 'Browser is missing; could not independently check this criterion. Install a browser before continuing.' }
    if (kind === 'runtime') return { ok: false, output: '', error: 'Provider unavailable' }
    if (kind === 'empty-report') return { ok:true,output:'  ' }
    if (kind === 'user-decision') { input.onEvent('clarify.requested', { question: 'Which environment may I access?' }); return { ok: false, output: '', error: 'User decision required' } }
    f.db.prepare("UPDATE person_acceptance_attempts SET run_id='' WHERE session_id=?").run(input.sessionId)
    return f.report(input)
  })
  const { task, execution } = await f.create({ acceptance }); await f.run(task.id)
  const review = await f.verify(task.id); await f.run(review.task.id)
  if(kind==='environment') await f.record(task.id,{verdict:'blocked',summary:'Browser missing',checks:[{criterion_id:'c1',status:'blocked',findings:'Install a browser',evidence:[],issues:[]}]})
  expect(f.receipt(execution.id).state).toBe('blocked')
  expect(f.receipt(execution.id).reason).toBeTruthy()
  expect(f.get(task.id).status).toBe('open')
  expect(() => complete(task.id)).toThrow(/Acceptance/)
  await expect(f.verify(task.id)).rejects.toThrow()
  await f.runner.tickPersonWork(); expect(f.execute).toHaveBeenCalledTimes(2)
})

it('keeps ordinary and explicitly disabled tasks on their original completion path', async () => {
  for (const config of [undefined, { enabled: false }]) {
    const { task, execution } = await f.create({ acceptance: config })
    expect((await f.run(task.id)).status).toBe('completed')
    expect(f.receipt(execution.id)).toBeUndefined()
  }
  expect(f.execute).toHaveBeenCalledTimes(2)
})

it('validates opt-in before writes, allows pre-execution configuration and freezes it on execution', async () => {
  await expect(f.create({ acceptance: { ...acceptance, criteria: [] } })).rejects.toThrow(/criteria/)
  expect(f.store.listPersonTasks(1)).toHaveLength(0)
  const { task } = await f.create({ start: false })
  await f.tasks.applyPersonTask(1, { action: 'configure_acceptance', task_id: task.id, expected_revision: task.revision, acceptance, idempotency_key: randomUUID() })
  const configured = f.get(task.id)
  expect(JSON.parse(configured.requirements_json).acceptance).toMatchObject({ initial_goal: 'Write 42 into result.txt and deliver its path.', orchestration: 'bot_tasks' })
  await f.chat.continuePersonTask(1, task.id, { expected_revision: configured.revision, idempotency_key: randomUUID(), input: [{ type: 'text', text: 'Start development.' }] })
  const running = f.get(task.id)
  await expect(f.tasks.applyPersonTask(1, { action: 'configure_acceptance', task_id: task.id, expected_revision: running.revision, acceptance: { enabled: false }, idempotency_key: randomUUID() })).rejects.toThrow()
  await f.run(task.id)
})

it('rejects duplicate/cross-owner dispatch and changes to the verifier scope', async () => {
  const { task } = await f.create({ acceptance }); await f.run(task.id)
  await expect(f.tasks.applyPersonTask(2, { action: 'verify', task_id: task.id, idempotency_key: randomUUID() })).rejects.toThrow()
  const review = await f.verify(task.id)
  await expect(f.verify(task.id)).rejects.toThrow()
  await expect(f.tasks.applyPersonTask(1, { action: 'update', task_id: review.task.id, expected_revision: review.task.revision, goal: 'Skip independent checks', idempotency_key: randomUUID() })).rejects.toThrow(/scope/)
  expect(() => f.schedules.applyPersonSchedule(1, { action: 'create', mode: 'worker', task_id: review.task.id, idempotency_key: randomUUID() })).toThrow(/scheduled/)
  await f.run(review.task.id)
})

it('rejects forged passed flags, null check status and an unfinished verification execution in SQL', async () => {
  const { task, execution } = await f.create({ acceptance }); await f.run(task.id)
  const review = await f.verify(task.id)
  expect(() => complete(review.task.id)).toThrow(/verification/)
  f.db.prepare("UPDATE person_acceptance SET state='passed' WHERE execution_id=?").run(execution.id)
  f.db.prepare("UPDATE person_acceptance_attempts SET state='passed',run_id='claimed',report_json=?,evidence_json='[{}]' WHERE verification_execution_id=?").run('{"verdict":"passed","checks":[{}]}', review.execution.id)
  expect(() => complete(task.id)).toThrow(/Acceptance/)
  expect(f.db.prepare('SELECT 1 FROM person_acceptance_passes WHERE execution_id=?').get(execution.id)).toBeUndefined()
})

it('expires a lost Bot dispatch with an explicit blocked reason instead of implicitly starting review', async () => {
  const { task, execution } = await f.create({ acceptance }); await f.run(task.id)
  f.db.prepare('UPDATE person_acceptance SET deadline=? WHERE execution_id=?').run(Date.now() - 1, execution.id)
  await f.runner.tickPersonWork()
  expect(f.receipt(execution.id)).toMatchObject({ state: 'blocked', reason: expect.stringContaining('Bot did not finish') })
  expect(f.get(task.id).status).toBe('open'); expect(f.execute).toHaveBeenCalledTimes(1)
  expect(f.store.listPersonTasks(1)).toHaveLength(1)
})

it('retains waiting/queued work and custom user schema across database reopen and repeated migration', async () => {
  const { task, execution } = await f.create({ acceptance }); await f.run(task.id)
  f.db.exec("ALTER TABLE session_tasks ADD COLUMN user_note TEXT; CREATE INDEX user_note_index ON session_tasks(user_note)")
  f.db.prepare('UPDATE session_tasks SET user_note=? WHERE id=?').run('Keep user data', task.id)
  await f.reopen()
  expect(f.receipt(execution.id).state).toBe('awaiting_dispatch')
  expect(f.execute).toHaveBeenCalledTimes(1)
  expect(f.db.prepare('SELECT user_note FROM session_tasks WHERE id=?').get(task.id)!.user_note).toBe('Keep user data')
  expect(f.db.prepare("SELECT name FROM sqlite_master WHERE name='user_note_index'").get()).toBeTruthy()
  const review = await f.verify(task.id); await f.reopen(); f.runner.startPersonWork()
  expect(f.get(review.task.id).execution_state).toBe('queued')
  await f.run(review.task.id)
  await f.record(task.id)
  expect(f.get(task.id).status).toBe('completed')
})

it('fences an in-flight review on restart without silently replaying it', async () => {
  const { task, execution } = await f.create({ acceptance }); await f.run(task.id)
  const review = await f.verify(task.id)
  f.db.prepare("UPDATE person_executions SET state='running',generation=1 WHERE id=?").run(review.execution.id)
  f.db.prepare("UPDATE person_acceptance_attempts SET state='running' WHERE verification_execution_id=?").run(review.execution.id)
  await f.reopen(); f.runner.startPersonWork()
  expect(f.receipt(execution.id).state).toBe('interrupted')
  expect(f.get(review.task.id).execution_state).toBe('stopping')
  await f.run(review.task.id)
  expect(f.execute).toHaveBeenCalledTimes(1); expect(f.get(task.id).status).toBe('open')
})

it('ignores a late successful review after stopping its parent', async () => {
  const { task, execution } = await f.create({ acceptance }); await f.run(task.id)
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  f.execute.mockImplementation(async input => { input.onEvent('run.started', { run_id: randomUUID() }); await pending; return f.report(input) })
  const review = await f.verify(task.id)
  try {
    await f.runner.tickPersonWork()
    await vi.waitFor(() => expect(f.get(review.task.id).execution_state).toBe('running'))
    await f.tasks.applyPersonTask(1, { action: 'stop', task_id: task.id, execution_id: execution.id, expected_revision: f.get(task.id).revision, idempotency_key: randomUUID() })
    await f.runner.tickPersonWork(); release(); await f.settle(review.task.id)
    expect(f.receipt(execution.id).state).toBe('interrupted')
    expect(f.get(task.id).status).toBe('open'); expect(() => complete(task.id)).toThrow(/Acceptance/)
  } finally { release() }
})

it('denies replacing linked acceptance with an ordinary callback-created task', async () => {
  const { task, execution } = await f.create({ acceptance }); await f.run(task.id)
  const result = await f.personTaskTools(1, 'person-main-1').find(t => t.name === 'bot_task_create')!.execute({ title: 'Unlinked review', goal: 'Skip host acceptance' }, { sessionId: 'person-main-1', runId: 'fixture-callback', messages: [], returnExecutionId: execution.id })
  expect(result).toMatchObject({ ok: false, error: { code: 'ACCESS_DENIED' } })
  expect(f.store.listPersonTasks(1)).toHaveLength(1)
})

it('keeps worker occurrences unfinished during review and skips overlapping due work', async () => {
  const { task } = await f.create({ start: false, acceptance })
  function due() {
    const schedule = f.schedules.applyPersonSchedule(1, { action: 'create', mode: 'worker', task_id: task.id, kind: 'once', expression: new Date(Date.now() + 60_000).toISOString(), timezone: 'UTC', idempotency_key: randomUUID() })
    f.db.prepare('UPDATE person_schedules SET next_at=? WHERE id=?').run(Date.now() - 10, schedule.id)
    return schedule
  }
  const first = due(); await f.run(task.id)
  expect(f.db.prepare('SELECT state FROM person_occurrences WHERE schedule_id=?').get(first.id)!.state).toBe('awaiting_acceptance')
  const overlapping = due(); await f.runner.tickPersonWork()
  expect(f.db.prepare('SELECT state FROM person_occurrences WHERE schedule_id=?').get(overlapping.id)!.state).toBe('skipped')
  const review = await f.verify(task.id); await f.run(review.task.id)
  await f.record(task.id)
  expect(f.db.prepare('SELECT state FROM person_occurrences WHERE schedule_id=?').get(first.id)!.state).toBe('finished')
})

it.each([false,true])('prevents stage completion until its child passes review, external reviewer=%s', async external => {
  const { createSession } = await import('../../packages/server/src/modules/studio/repositories/session-store')
  const { createPersonFlow, controlPersonFlow } = await import('../../packages/server/src/modules/studio/services/person/stage-flows')
  const { getPersonFlow } = await import('../../packages/server/src/modules/studio/repositories/person-stage-store')
  createSession({ id: 'person-main-role', studio_user_id: 1, user_id: 1, title: 'Role', workspace: f.workspace, source: 'builtin_agent', agent: 'ekko-agent', agent_preset: 'person', profile: 'default' })
  const flow = createPersonFlow(1, { title: 'Build a result', goal: 'Deliver a verified result', stages: [{ session_id: 'person-main-role', goal: 'Build the result', return_expectation: 'Validated artifact' }], idempotency_key: randomUUID() }, { sessionId: 'person-main-1', runId: 'creator', messages: [] })
  const origin = { sessionId: 'person-main-role', runId: 'role-turn', messages: [], stage: { flowId: flow.id, stageId: flow.stages[0].id, generation: flow.generation } }
  const child = await f.tasks.applyPersonTask(1, { action: 'create', title: 'Child result', goal: 'Write 42 into result.txt', acceptance:external?{...acceptance,reviewer_session_id:'person-main-1'}:acceptance, idempotency_key: randomUUID() }, undefined, origin)
  const finishStage = () => controlPersonFlow(1, { action: 'complete', flow_id: flow.id, expected_revision: getPersonFlow(1, flow.id).revision, idempotency_key: randomUUID() }, origin)
  await f.run(child.task.id)
  await expect(finishStage()).rejects.toThrow(/acceptance-enabled/)
  const current = f.get(child.task.id)
  const review = await f.tasks.applyPersonTask(1, { action: 'verify', task_id: current.id, expected_revision: current.revision, idempotency_key: randomUUID() }, undefined, origin)
  expect(f.db.prepare('SELECT stage_id FROM person_stage_tasks WHERE task_id=?').get(review.task.id)?.stage_id).toBe(external?undefined:flow.stages[0].id)
  await f.run(review.task.id)
  await f.record(child.task.id,undefined,external?{sessionId:'person-main-1',runId:'assigned-reviewer',messages:[],returnExecutionId:review.execution!.id}:origin)
  expect(f.get(child.task.id).status).toBe('completed')
  await expect(finishStage()).resolves.toBeDefined()
})

it('explicitly rejects direct stage, assistant-schedule and legacy next_steps acceptance', async () => {
  const { createPersonFlow } = await import('../../packages/server/src/modules/studio/services/person/stage-flows')
  expect(() => createPersonFlow(1, { acceptance })).toThrow(/Direct stage acceptance/)
  expect(() => f.schedules.applyPersonSchedule(1, { action: 'create', mode: 'assistant', acceptance })).toThrow(/acceptance/i)
  await expect(f.create({ acceptance, next_steps: [] })).rejects.toThrow(/legacy task routes/)
  expect(f.store.listPersonTasks(1)).toHaveLength(0)
})

it('sends a readable requirement/checklist brief and readable repair feedback to Agents', async () => {
  f.worker('41')
  const {task}=await f.create({acceptance})
  await f.run(task.id)
  const review=await f.verify(task.id);await f.run(review.task.id)
  const prompt=String(f.execute.mock.calls[1][0].prompt)
  expect(prompt).toContain('## Product requirements\n\nWrite 42 into result.txt')
  expect(prompt).toContain(`1. ${acceptance.criteria[0]}`)
  expect(prompt).toContain('Created result.txt')
  expect(prompt).not.toMatch(/snapshot_json|selection_json|verifier_selection|Return ONLY JSON|"requirements"\s*:/)
  await f.record(task.id);await f.repair(task.id);await f.run(task.id)
  const feedback=JSON.stringify(f.execute.mock.calls[2][0].prompt)
  expect(feedback).toContain('Expected 42; observed 41')
  expect(feedback).not.toContain('criterion_id')
  const second=await f.verify(task.id);await f.run(second.task.id)
  expect(String(f.execute.mock.calls[3][0].prompt)).toContain('### Round 1')
  expect(String(f.execute.mock.calls[3][0].prompt)).toContain('Expected 42; observed 41')
})

it('keeps a returned report across restart until Bot records its decision', async () => {
  const {task,execution}=await f.create({acceptance});await f.run(task.id)
  const review=await f.verify(task.id);await f.run(review.task.id)
  const raw=f.detail.personAcceptanceDetail(1,task.id)!.attempts[0].raw_output
  await f.reopen();f.runner.startPersonWork()
  expect(f.receipt(execution.id).state).toBe('awaiting_review')
  expect(f.detail.personAcceptanceDetail(1,task.id)!.attempts[0].raw_output).toBe(raw)
  expect(f.execute).toHaveBeenCalledTimes(2)
  await f.record(task.id)
  expect(f.get(task.id).status).toBe('completed')
})

it('rejects stopped, superseded and wrong-Bot decisions with the actual current verification identity', async () => {
  const {task,execution}=await f.create({acceptance});await f.run(task.id)
  const first=await f.verify(task.id);await f.run(first.task.id)
  await expect(f.record(task.id,undefined,{sessionId:'person-main-2',runId:'wrong',messages:[]})).rejects.toThrow(/owning Bot/)
  const second=await f.verify(task.id);await f.run(second.task.id)
  await expect(f.tasks.applyPersonTask(1,{action:'record_acceptance',task_id:task.id,expected_revision:f.get(task.id).revision,verification_execution_id:first.execution.id,report:f.decisions.get(first.execution.session_id),idempotency_key:randomUUID()})).rejects.toThrow(/current returned verification report/)
  await expect(f.record(task.id,undefined,{sessionId:'person-main-1',runId:'stale-callback',messages:[],returnExecutionId:first.execution.id})).rejects.toThrow(/callback/)
  await f.tasks.applyPersonTask(1,{action:'stop',task_id:task.id,execution_id:execution.id,expected_revision:f.get(task.id).revision,idempotency_key:randomUUID()})
  await expect(f.record(task.id)).rejects.toThrow(/current returned verification report/)
  expect(f.get(task.id).status).toBe('open')
})

it('uses the verification callback to record defects and continue the SAME developer', async () => {
  f.worker('41')
  const {task}=await f.create({acceptance});await f.run(task.id)
  const review=await f.verify(task.id);await f.run(review.task.id)
  const origin={sessionId:'person-main-1',runId:'bot-defects',messages:[],returnExecutionId:review.execution.id}
  const tools=f.personTaskTools(1,'person-main-1'), query=tools.find(t=>t.name==='bot_tasks_query')!,control=tools.find(t=>t.name==='bot_task_control')!
  const before:any=await query.execute({task_id:task.id})
  expect(await control.execute({action:'continue',task_ref:before.task.task_ref,message:'Repair'},origin)).toMatchObject({ok:false})
  const record:any=await control.execute({action:'record_acceptance',task_ref:before.task.task_ref,verification_execution_id:review.execution.id,report:f.decisions.get(review.execution.session_id)},origin)
  expect(record).toMatchObject({ok:true,task:{id:task.id,acceptance_state:'repair_required'}})
  const resumed:any=await control.execute({action:'continue',task_ref:record.task.task_ref,message:'Fix the independently observed mismatch.'},origin)
  expect(resumed).toMatchObject({ok:true,task:{id:task.id}})
  expect(f.store.listPersonTasks(1)).toHaveLength(2)
})

it('provides all pages of a long ordinary report without requiring JSON or losing the final finding', async () => {
  const long='Independent browser check notes.\n'.repeat(500)+'Final finding: the result is correct; see check.log.'
  f.worker('42','42',input=>{f.assessment(input);return {ok:true,output:long}})
  const {task}=await f.create({acceptance});await f.run(task.id)
  const review=await f.verify(task.id);await f.run(review.task.id)
  const query=f.personTaskTools(1,'person-main-1').find(t=>t.name==='bot_tasks_query')!
  let offset:number|null=0,received=''
  while(offset!==null){const result:any=await query.execute({task_id:task.id,report_offset:offset});const page=result.task.acceptance_result.report;received+=page.text;offset=page.next_offset}
  expect(received).toBe(long)
  await f.record(task.id)
  expect(f.get(task.id).status).toBe('completed')
})

it('does not allow a fabricated passed state to bypass the Bot decision receipt', async () => {
  const {task,execution}=await f.create({acceptance});await f.run(task.id)
  const review=await f.verify(task.id);await f.run(review.task.id);await f.record(task.id)
  f.db.prepare("UPDATE session_tasks SET status='open' WHERE id=?").run(task.id)
  f.db.prepare("UPDATE person_acceptance_attempts SET decision_json='' WHERE verification_execution_id=?").run(review.execution.id)
  expect(f.receipt(execution.id).state).toBe('passed')
  expect(()=>complete(task.id)).toThrow(/Acceptance/)
})

it('expires a returned report waiting for Bot instead of completing or resetting its budget', async () => {
  const {task,execution}=await f.create({acceptance});await f.run(task.id)
  const review=await f.verify(task.id);await f.run(review.task.id)
  f.db.prepare('UPDATE person_acceptance SET deadline=? WHERE execution_id=?').run(Date.now()-1,execution.id)
  await expect(f.record(task.id)).rejects.toThrow(/current returned verification report/)
  await f.runner.tickPersonWork()
  expect(f.receipt(execution.id).state).toBe('blocked')
  expect(f.get(task.id).status).toBe('open')
})

it('blocks if persisting the verification execution fails after the report returned', async () => {
  const {task,execution}=await f.create({acceptance});await f.run(task.id)
  const review=await f.verify(task.id)
  f.db.exec(`CREATE TRIGGER fixture_finish_failure BEFORE UPDATE OF state ON person_executions WHEN NEW.id='${review.execution.id}' AND NEW.state='finished' BEGIN SELECT RAISE(ABORT,'Fixture finalization failed'); END`)
  await f.run(review.task.id)
  expect(f.receipt(execution.id)).toMatchObject({state:'blocked',reason:expect.stringContaining('Fixture finalization failed')})
  expect(f.get(review.task.id).execution_state).toBe('failed')
  await expect(f.record(task.id)).rejects.toThrow(/current returned verification report/)
  expect(f.get(task.id).status).toBe('open')
})

it('keeps an explicitly persisted legacy receipt readable and executable without upgrading its orchestration', async () => {
  const { task, execution } = await f.create({ acceptance })
  // Simulate an already-dispatched pre-upgrade receipt; new tasks always use bot_tasks.
  f.db.prepare("UPDATE person_acceptance SET orchestration='legacy' WHERE execution_id=?").run(execution.id)
  await f.reopen()
  expect(f.receipt(execution.id).orchestration).toBe('legacy')
  await f.run(task.id)
  expect(f.get(task.id).status).toBe('completed')
  expect(f.receipt(execution.id).state).toBe('passed')
  expect(f.db.prepare('SELECT * FROM person_acceptance_tasks').all()).toEqual([])
})

it('repairs an in-scope non-blocking issue even when Bot initially labels the review passed', async () => {
  const {task,execution}=await f.create({acceptance});await f.run(task.id)
  const first=await f.verify(task.id);await f.run(first.task.id)
  const decision=structuredClone(f.decisions.get(first.execution.session_id)!)
  decision.summary='Passed, with minor contrast improvements'
  decision.checks[0].issues=[{description:'Placeholder text has insufficient contrast',disposition:'repair',reason:'The requested UI must be readable; this product issue is still unfixed'}]
  await f.record(task.id,decision)
  expect(f.receipt(execution.id)).toMatchObject({state:'repair_required',attempt:1})
  expect(f.get(task.id).status).toBe('open')
  const repair=await f.repair(task.id);await f.run(task.id)
  expect(repair.task.id).toBe(task.id)
  expect(repair.execution.session_id).toBe(execution.session_id)
  expect(JSON.stringify(f.execute.mock.calls[2][0].prompt)).toContain('Placeholder text has insufficient contrast')
  const second=await f.verify(task.id);expect(second.task.id).toBe(first.task.id)
  await f.run(second.task.id);await f.record(task.id)
  expect(f.get(task.id).status).toBe('completed')
})

it('distinguishes coverage limitations and verified resolved issues from outstanding product defects', async () => {
  const {task}=await f.create({acceptance});await f.run(task.id)
  const review=await f.verify(task.id);await f.run(review.task.id)
  const decision=structuredClone(f.decisions.get(review.execution.session_id)!)
  decision.checks[0].issues=[{description:'No physical phone test',disposition:'out_of_scope',reason:'The request requires browser layout checks; no physical-device claim is made'},
    {description:'Previous contrast issue',disposition:'resolved',reason:'The current independent evidence confirms the corrected contrast'}]
  await f.record(task.id,decision)
  expect(f.get(task.id).status).toBe('completed')
})

it('requires an explicit issue reconciliation without requiring a formatted verifier reply', async () => {
  const {task}=await f.create({acceptance});await f.run(task.id)
  const review=await f.verify(task.id);await f.run(review.task.id)
  const decision=structuredClone(f.decisions.get(review.execution.session_id)!)
  delete decision.checks[0].issues
  await expect(f.record(task.id,decision)).rejects.toThrow(/List product issues/)
  expect(f.get(task.id).status).toBe('open')
})

it('routes a named reviewing Bot back to the original developer for repair and then the SAME Bot for recheck', async () => {
  const {createSession}=await import('../../packages/server/src/modules/studio/repositories/session-store')
  const {finishPersonDelivery}=await import('../../packages/server/src/modules/studio/services/person/delivery')
  const reviewer='person-main-reviewer'
  createSession({id:reviewer,studio_user_id:1,user_id:1,title:'暖暖',workspace:f.workspace,source:'builtin_agent',agent:'ekko-agent',agent_preset:'person',profile:'default'})
  f.worker('41')
  const {task,execution}=await f.create({acceptance:{...acceptance,reviewer_session_id:reviewer}})
  await f.run(task.id);await f.runner.tickPersonWork();finishPersonDelivery(1,execution.id,true)
  const first=await f.verify(task.id)
  expect(first.task.session_id).toBe(reviewer)
  expect(JSON.parse(String(f.db.prepare('SELECT origin_json FROM person_task_origins WHERE task_id=?').get(first.task.id)!.origin_json))).toMatchObject({sessionId:reviewer,messages:[]})
  await f.run(first.task.id);await f.runner.tickPersonWork()
  expect(f.runtime.deliver).toHaveBeenCalledWith(expect.objectContaining({taskId:first.task.id,origin:expect.objectContaining({sessionId:reviewer}),acceptance:expect.objectContaining({reviewer_session_id:reviewer,developer_session_id:'person-main-1',next_action:'review'})}))
  const reviewTools=f.personTaskTools(1,reviewer), developerTools=f.personTaskTools(1,'person-main-1')
  const query=reviewTools.find(t=>t.name==='bot_tasks_query')!,control=reviewTools.find(t=>t.name==='bot_task_control')!
  const root:any=await query.execute({task_id:task.id})
  const developerView:any=await developerTools.find(t=>t.name==='bot_tasks_query')!.execute({task_id:task.id})
  expect(developerView.task.allowed_actions).not.toContain('record_acceptance')
  const origin={sessionId:reviewer,runId:'review-bot',messages:[],returnExecutionId:first.execution.id}
  const recorded:any=await control.execute({action:'record_acceptance',task_ref:root.task.task_ref,verification_execution_id:first.execution.id,report:f.decisions.get(first.execution.session_id)},origin)
  expect(recorded).toMatchObject({ok:true,task:{acceptance_state:'repair_required'},instruction:expect.stringContaining('original developer Bot')})
  expect(f.db.prepare('SELECT state FROM person_deliveries WHERE execution_id=?').get(execution.id)!.state).toBe('pending')
  const {personDeliveryCurrent,cancelPersonDelivery}=await import('../../packages/server/src/modules/studio/services/person/delivery')
  f.db.prepare("UPDATE person_deliveries SET state='queued' WHERE execution_id=?").run(execution.id)
  finishPersonDelivery(1,execution.id,true)
  cancelPersonDelivery(1,execution.id)
  expect(f.db.prepare('SELECT state FROM person_deliveries WHERE execution_id=?').get(execution.id)!.state).toBe('queued')
  expect(personDeliveryCurrent(1,execution.id,'')).toBe(false)
  expect(personDeliveryCurrent(1,execution.id,first.execution.id)).toBe(true)
  f.db.prepare("UPDATE person_deliveries SET state='pending' WHERE execution_id=?").run(execution.id)
  expect(await control.execute({action:'continue',task_ref:recorded.task.task_ref,message:'Repair here'},origin)).toMatchObject({ok:false})
  await f.runner.tickPersonWork()
  expect(f.runtime.deliver).toHaveBeenCalledWith(expect.objectContaining({taskId:task.id,origin:expect.objectContaining({sessionId:'person-main-1'}),acceptance:expect.objectContaining({next_action:'repair'})}))
  const repair=await f.repair(task.id);expect(repair.execution.session_id).toBe(execution.session_id);await f.run(task.id)
  const second=await f.verify(task.id);expect(second.task.id).toBe(first.task.id);expect(second.task.session_id).toBe(reviewer)
  await f.run(second.task.id)
  await f.record(task.id,undefined,{...origin,returnExecutionId:second.execution.id})
  expect(f.get(task.id).status).toBe('completed')
  const latest=f.detail.personAcceptanceDetail(1,task.id)!.attempts.at(-1)!
  expect(JSON.parse(latest.decision_json).session_id).toBe(reviewer)
  expect(f.store.listPersonTasks(1)).toHaveLength(2)
})

it.each(['person-main-2','person-main-missing'])('rejects an unavailable or foreign reviewer %s before creating work', async reviewer => {
  await expect(f.create({acceptance:{...acceptance,reviewer_session_id:reviewer}})).rejects.toThrow(/conversation not found/)
  expect(f.store.listPersonTasks(1)).toHaveLength(0)
})

it('keeps legacy completed decisions valid while SQL rejects a passed verdict with outstanding repair issues', async () => {
  const {task}=await f.create({acceptance});await f.run(task.id)
  const review=await f.verify(task.id);await f.run(review.task.id);await f.record(task.id)
  const attempt=f.detail.personAcceptanceDetail(1,task.id)!.attempts[0],report=attempt.report!
  delete report.checks[0].issues
  const actor=JSON.parse(attempt.decision_json);delete actor.version
  f.db.prepare('UPDATE person_acceptance_attempts SET report_json=?,decision_json=? WHERE id=?').run(JSON.stringify(report),JSON.stringify(actor),attempt.id)
  await f.reopen()
  expect(f.db.prepare('SELECT 1 FROM person_acceptance_passes WHERE task_id=?').get(task.id)).toBeTruthy()
  f.db.prepare("UPDATE session_tasks SET status='open' WHERE id=?").run(task.id)
  report.checks[0].issues=[{description:'Unfixed contrast',disposition:'repair',reason:'Requested readability'}]
  f.db.prepare('UPDATE person_acceptance_attempts SET report_json=? WHERE id=?').run(JSON.stringify(report),attempt.id)
  expect(()=>complete(task.id)).toThrow(/Acceptance/)
})
