import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { acceptanceFixture, type AcceptanceFixture } from './fixtures/person-acceptance'

let f: AcceptanceFixture
beforeEach(async () => { f = await acceptanceFixture() })
afterEach(async context => { await f.close(context.task.name) })
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }
function request(taskId: string, text: string) {
  const t = f.get(taskId)
  return { input: [{ type: 'text', text }], expected_revision: t.revision, expected_execution_id: t.execution_id, idempotency_key: randomUUID() }
}
async function send(taskId: string, body: ReturnType<typeof request>, signal?: AbortSignal) {
  return (await import('../../packages/server/src/modules/studio/services/person/task-input')).submitPersonTaskInput(1, taskId, body, signal)
}
function decide(value: Record<string, unknown>) {
  vi.mocked(f.runtime.model).mockImplementation(async call => { call.beforeRequest?.(); await call.tools[0].execute(value); return '' })
}
const replacement = { action: 'redirect', goal: '查询贵阳实时天气和今日预报；注明来源和查询时间，不编造数据。', title: '查询贵阳天气' }

it('handles the actual Xiamen to Guiyang wording through ordinary chat and waits for stop confirmation', async () => {
  const { task, execution } = await f.create({ title: '查询厦门天气', goal: '查询厦门实时天气和今日预报；注明来源和查询时间，不编造数据。' })
  f.db.prepare("UPDATE person_executions SET state='running' WHERE id=?").run(execution.id)
  const oldInput = await f.chat.continuePersonTask(1, task.id, request(task.id, '旧城市还要湿度'))
  const barrier = deferred(); vi.mocked(f.runtime.stop).mockImplementation(() => barrier.promise)
  decide(replacement)
  try {
    const result = await send(task.id, request(task.id, '哦不查贵阳的吧'))
    expect(f.runtime.model).toHaveBeenCalledTimes(1)
    const call = vi.mocked(f.runtime.model).mock.calls[0][0]
    const context = JSON.parse(String(call.messages[0].content))
    expect(context.goal).toContain('厦门'); expect(context.new_user_input[0].text).toBe('哦不查贵阳的吧')
    expect(context.pending[0].input[0].text).toBe('旧城市还要湿度')
    expect(call.tools.map(t => t.name)).toEqual(['choose_task_input'])
    expect(result.task.title).toBe('查询贵阳天气')
    expect(f.store.listPersonTasks(1)).toHaveLength(1)
    expect(result.execution.state).toBe('pending')
    expect(f.store.getPersonExecution(1, execution.id).state).toBe('stopping')
    expect(f.store.getPersonExecution(1, oldInput.execution.id).state).toBe('interrupted')
    await f.runner.tickPersonWork(); expect(f.execute).not.toHaveBeenCalled()
    barrier.resolve(); await f.tasks.acknowledgePersonStop(f.store.getPersonExecution(1, execution.id))
    await f.run(task.id)
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect(f.execute.mock.calls[0][0].sessionId).toBe(result.execution.session_id)
  } finally { barrier.resolve() }
})

it('keeps compatible input in the same queue without keyword-based cancellation', async () => {
  const { task, execution } = await f.create(); f.db.prepare("UPDATE person_executions SET state='running' WHERE id=?").run(execution.id)
  decide({ action: 'append' })
  const result = await send(task.id, request(task.id, '不要漏掉数据来源，其他继续'))
  expect(result.execution.state).toBe('pending')
  expect(result.execution.session_id).toBe(execution.session_id)
  expect(f.get(task.id).requirements_revision).toBe(0)
  expect(f.runtime.stop).not.toHaveBeenCalled()
})

it('honors a stop-only instruction without creating replacement work', async () => {
  const { task, execution } = await f.create(); f.db.prepare("UPDATE person_executions SET state='running' WHERE id=?").run(execution.id)
  decide({ action: 'stop' })
  await send(task.id, request(task.id, '先停下来，不要继续查了'))
  await f.tasks.acknowledgePersonStop(f.store.getPersonExecution(1, execution.id))
  expect(f.store.getPersonExecution(1, execution.id).state).toBe('interrupted')
  expect(f.store.taskPersonExecutions(1, task.id)).toHaveLength(1)
  expect(f.execute).not.toHaveBeenCalled()
})

it('does not accept contradictory model decisions or truncate a valid long request key', async () => {
  const { task } = await f.create()
  vi.mocked(f.runtime.model).mockImplementation(async call => {
    await call.tools[0].execute({ action: 'append' })
    try { await call.tools[0].execute(replacement) } catch { /* model tool errors are recoverable in the runtime */ }
    return ''
  })
  await expect(send(task.id, request(task.id, '哦不查贵阳的吧'))).rejects.toMatchObject({ status: 502 })
  expect(f.store.taskPersonExecutions(1, task.id)).toHaveLength(1)
  decide(replacement)
  const body = { ...request(task.id, '哦不查贵阳的吧'), idempotency_key: 'x'.repeat(200) }
  const result = await send(task.id, body)
  const replay = await send(task.id, body)
  expect(replay.execution.id).toBe(result.execution.id)
  expect(f.store.listPersonTasks(1)).toHaveLength(1)
})

it('rejects a stale classification before it can stop newer work', async () => {
  const { task } = await f.create(); const barrier = deferred(), entered = deferred()
  vi.mocked(f.runtime.model).mockImplementation(async call => { entered.resolve(); await barrier.promise; await call.tools[0].execute(replacement); return '' })
  const pending = send(task.id, request(task.id, '哦不查贵阳的吧'))
  const rejected = expect(pending).rejects.toMatchObject({ status: 409 })
  await entered.promise
  await f.chat.continuePersonTask(1, task.id, request(task.id, 'Another accepted input'))
  barrier.resolve(); await rejected
  expect(f.get(task.id).requirements_revision).toBe(0)
  expect(f.runtime.stop).not.toHaveBeenCalled()
})

it('retains replay meaning after a newer correction even when the caller omits expected execution', async () => {
  const { task } = await f.create(); decide(replacement)
  const body: any = request(task.id, '哦不查贵阳的吧'); delete body.expected_execution_id
  const first = await send(task.id, body)
  const latest = await send(task.id, request(task.id, '再改一次'))
  const replay = await send(task.id, body)
  expect(replay.execution.id).toBe(first.execution.id)
  expect(replay.task.execution_id).toBe(latest.execution.id)
  expect(f.runtime.model).toHaveBeenCalledTimes(2)
  expect(f.store.taskPersonExecutions(1, task.id)).toHaveLength(3)
})

it('continues the original conversation through older execution links after correcting requirements', async () => {
  const { task, execution } = await f.create(); decide(replacement)
  const corrected = await send(task.id, request(task.id, '哦不查贵阳的吧'))
  expect(corrected.execution.session_id).toBe(execution.session_id)
  const chat = await f.chat.personTaskChat(1, task.id, execution.id)
  expect(chat.execution?.id).toBe(execution.id)
  expect(chat.task.execution_id).toBe(corrected.execution.id)
  expect(chat.session?.id).toBe(execution.session_id)
  expect(chat.executions).toHaveLength(1)
  decide({ action: 'append' })
  const followup = await send(task.id, { ...request(task.id, '补充数据来源'), execution_id: execution.id })
  expect(followup.execution.session_id).toBe(execution.session_id)
  expect(followup.execution.requirements_revision).toBe(1)
  expect(f.store.listPersonTasks(1)).toHaveLength(1)
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id LIKE ?').get('person-task-%')!.n).toBe(1)
})

it('keeps a genuinely separate obsolete conversation read-only without hiding it', async () => {
  const { task, execution } = await f.create()
  f.db.prepare("UPDATE person_executions SET state='finished' WHERE id=?").run(execution.id)
  const updated = await f.tasks.applyPersonTask(1,{ action:'update',task_id:task.id,goal:'A different explicit start',expected_revision:f.get(task.id).revision,idempotency_key:randomUUID() })
  await f.tasks.applyPersonTask(1,{ action:'start',task_id:task.id,expected_revision:updated.task.revision,idempotency_key:randomUUID() })
  const body = { ...request(task.id, '补充数据来源'), execution_id:execution.id }
  await expect(send(task.id, body)).rejects.toMatchObject({ status:409 })
  await expect(f.chat.continuePersonTask(1,task.id,body)).rejects.toMatchObject({ status:409 })
  expect(f.runtime.model).not.toHaveBeenCalled()
  const chat = await f.chat.personTaskChat(1,task.id,execution.id)
  expect(chat.execution?.id).toBe(execution.id)
  expect(chat.executions).toHaveLength(2)
})

it('deduplicates concurrent copies of one input without stopping the new correction', async () => {
  const { task } = await f.create(); decide(replacement)
  const body = request(task.id, '哦不查贵阳的吧')
  const results = await Promise.allSettled([send(task.id, body), send(task.id, body)])
  // A duplicate model request may finish after the first mutation; it must replay
  // the already saved decision rather than reclassify/replace the replacement.
  expect(results.every(r => r.status === 'fulfilled')).toBe(true)
  const [a, b] = results.map(r => (r as PromiseFulfilledResult<any>).value)
  expect(a.execution.id).toBe(b.execution.id)
  expect(f.store.taskPersonExecutions(1, task.id)).toHaveLength(2)
  expect(f.runtime.stop).not.toHaveBeenCalled()
})

it.each(['missing', 'invalid', 'failure', 'aborted'])('does not silently append or stop when routing is %s', async mode => {
  const { task, execution } = await f.create()
  const controller = new AbortController()
  vi.mocked(f.runtime.model).mockImplementation(async call => {
    if (mode === 'invalid') await call.tools[0].execute({ action: 'redirect', goal: '' })
    if (mode === 'failure') throw new Error('Provider unavailable')
    if (mode === 'aborted') { await call.tools[0].execute(replacement); controller.abort() }
    return ''
  })
  await expect(send(task.id, request(task.id, '哦不查贵阳的吧'), controller.signal)).rejects.toBeDefined()
  expect(f.store.taskPersonExecutions(1, task.id)).toHaveLength(1)
  expect(f.get(task.id).execution_id).toBe(execution.id)
  expect(f.get(task.id).requirements_revision).toBe(0)
  expect(f.runtime.stop).not.toHaveBeenCalled()
})
