import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import type { Context } from 'koa'
import { acceptanceFixture, type AcceptanceFixture } from './fixtures/person-acceptance'

let f: AcceptanceFixture
beforeEach(async () => {
  f = await acceptanceFixture()
  vi.mocked(f.runtime.model).mockRejectedValue(new Error('The coordinator must not run for manual task input'))
})
afterEach(async context => {
  try { expect(f.runtime.model).not.toHaveBeenCalled() }
  finally { await f.close(context.task.name) }
})
function request(taskId: string, text: string) {
  const task = f.get(taskId)
  return { input: [{ type: 'text', text }], expected_revision: task.revision, expected_execution_id: task.execution_id, idempotency_key: randomUUID() }
}
async function send(taskId: string, body: Record<string, unknown>, userId = 1) {
  return (await import('../../packages/server/src/modules/studio/services/person/task-input')).submitPersonTaskInput(userId, taskId, body)
}
function active(executionId: string) {
  f.db.prepare("UPDATE person_executions SET state='running',lease_until=? WHERE id=?").run(Date.now() + 90_000, executionId)
}

it.each(['不要漏掉数据来源，其他继续', '哦不查贵阳的吧', '先停下来，不要继续查了'])(
  'appends manual input without interpreting its intent: %s', async text => {
    const { task, execution } = await f.create({ title: '查询厦门天气', goal: '查询厦门实时天气并注明来源。' })
    active(execution.id)
    const older = await send(task.id, request(task.id, '旧城市还要湿度'))
    const result = await send(task.id, request(task.id, text))
    expect(result.execution.state).toBe('pending')
    expect(result.execution.session_id).toBe(execution.session_id)
    expect(JSON.parse(result.execution.input_json)).toEqual([{ type: 'text', text }])
    expect(result.pending.map(item => item.id)).toEqual([older.execution.id, result.execution.id])
    expect(f.store.getPersonExecution(1, execution.id).state).toBe('running')
    expect(f.get(task.id)).toMatchObject({ title: task.title, requirements_revision: task.requirements_revision })
    expect(f.get(task.id).requirements_json).toBe(task.requirements_json)
    expect(f.runtime.stop).not.toHaveBeenCalled()
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM person_task_redirects WHERE task_id=?').get(task.id)!.n).toBe(0)
    await f.runner.tickPersonWork()
    expect(f.execute).not.toHaveBeenCalled()
  },
)

it('accepts manual HTTP input without consulting the Bot model', async () => {
  const { task } = await f.create()
  vi.mocked(f.runtime.modelConfig).mockClear().mockRejectedValue(new Error('Bot model configuration unavailable'))
  const { taskContinue } = await import('../../packages/server/src/modules/studio/controllers/person')
  const ctx = { state: { user: { id: 1 } }, params: { id: task.id }, request: { body: request(task.id, '继续补充来源') }, set: vi.fn() } as unknown as Context
  await taskContinue(ctx)
  expect(ctx.body).toMatchObject({ task: { id: task.id }, execution: { state: 'pending' } })
  expect(f.runtime.modelConfig).not.toHaveBeenCalled()
  expect(f.runtime.stop).not.toHaveBeenCalled()
})

it('queues and executes attachments in the existing conversation after the prior turn finishes', async () => {
  const { task, execution } = await f.create()
  await f.run(task.id)
  f.execute.mockClear()
  const input = [
    { type: 'text', text: '补充这些材料' },
    { type: 'file', name: 'notes.txt', path: '/fixture/notes.txt', media_type: 'text/plain' },
    { type: 'image', name: 'screen.png', path: '/fixture/screen.png', media_type: 'image/png' },
  ]
  const result = await send(task.id, { ...request(task.id, ''), input })
  expect(result.execution.state).toBe('queued')
  expect(result.execution.session_id).toBe(execution.session_id)
  expect(result.execution.selection_json).toBe(execution.selection_json)
  expect(JSON.parse(result.execution.input_json)).toEqual(input)
  expect(f.get(task.id).status).toBe('open')
  await f.run(task.id)
  expect(f.execute).toHaveBeenCalledTimes(1)
  expect(f.execute.mock.calls[0][0]).toMatchObject({ sessionId: execution.session_id, prompt: input })
  expect(f.store.getPersonExecution(1, result.execution.id).state).toBe('finished')
})

it('deduplicates concurrent and later retries, including a 200-character request key', async () => {
  const { task } = await f.create()
  const body = { ...request(task.id, '补充来源'), idempotency_key: 'x'.repeat(200) }
  const [a, b] = await Promise.all([send(task.id, body), send(task.id, body)])
  const replay = await send(task.id, body)
  expect(b.execution.id).toBe(a.execution.id)
  expect(replay.execution.id).toBe(a.execution.id)
  expect(f.store.taskPersonExecutions(1, task.id)).toHaveLength(2)
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM person_operations WHERE operation_key LIKE 'task-input:%'").get()!.n).toBe(0)
})

it('replays an append receipt accepted by the previous model-routing endpoint', async () => {
  const { task } = await f.create()
  const body = request(task.id, '  补充来源  ')
  const accepted = await f.chat.continuePersonTask(1, task.id, {
    ...body, input: f.chat.personTaskInput(body.input), idempotency_key: `input:${createHash('sha256').update(body.idempotency_key).digest('hex')}`,
  })
  const replay = await send(task.id, body)
  expect(replay.execution.id).toBe(accepted.execution.id)
  expect(f.store.taskPersonExecutions(1, task.id)).toHaveLength(2)
})

it.each(['revision', 'execution'])('rejects a stale expected %s without enqueuing', async field => {
  const { task } = await f.create()
  const body = request(task.id, '补充来源')
  if (field === 'revision') f.db.prepare('UPDATE session_tasks SET revision=revision+1 WHERE id=?').run(task.id)
  else body.expected_execution_id = 'not-current'
  await expect(send(task.id, body)).rejects.toMatchObject({ status: 409 })
  expect(f.store.taskPersonExecutions(1, task.id)).toHaveLength(1)
})

it.each(['closed', 'stopping'])('preserves the %s task barrier', async state => {
  const { task, execution } = await f.create()
  if (state === 'closed') f.db.prepare("UPDATE session_tasks SET status='closed' WHERE id=?").run(task.id)
  else f.db.prepare("UPDATE person_executions SET state='stopping' WHERE id=?").run(execution.id)
  await expect(send(task.id, request(task.id, '继续'))).rejects.toMatchObject({ status: 409 })
  expect(f.store.taskPersonExecutions(1, task.id)).toHaveLength(1)
})

it('preserves account ownership and input validation', async () => {
  const { task } = await f.create()
  await expect(send(task.id, request(task.id, '继续'), 2)).rejects.toMatchObject({ status: 404 })
  await expect(send(task.id, { ...request(task.id, '继续'), input: [] })).rejects.toMatchObject({ status: 400 })
  await expect(send(task.id, { ...request(task.id, '继续'), idempotency_key: 'x'.repeat(201) })).rejects.toMatchObject({ status: 400 })
  expect(f.store.taskPersonExecutions(1, task.id)).toHaveLength(1)
})

it('leaves Bot redirection intact and permits manual appends through the original conversation link', async () => {
  const { task, execution } = await f.create()
  const tools = f.personTaskTools(1, task.session_id)
  const query: any = await tools.find(t => t.name === 'bot_tasks_query')!.execute({ task_id: task.id })
  const corrected: any = await tools.find(t => t.name === 'bot_task_control')!.execute({
    task_ref: query.task.task_ref, action: 'redirect', goal: '查询贵阳天气并注明来源', title: '查询贵阳天气', message: '哦不查贵阳的吧',
  })
  expect(corrected.ok).toBe(true)
  expect(f.get(task.id)).toMatchObject({ title: '查询贵阳天气', requirements_revision: 1 })
  const followup = await send(task.id, { ...request(task.id, '补充数据来源'), execution_id: execution.id })
  expect(followup.execution.session_id).toBe(execution.session_id)
  expect(followup.execution.requirements_revision).toBe(1)
  expect(f.store.listPersonTasks(1)).toHaveLength(1)
})

it('leaves explicit Bot stop control able to cancel pending manual followups', async () => {
  const { task, execution } = await f.create()
  active(execution.id)
  const followup = await send(task.id, request(task.id, '补充来源'))
  const tools = f.personTaskTools(1, task.session_id)
  const query: any = await tools.find(t => t.name === 'bot_tasks_query')!.execute({ task_id: task.id })
  const stopped: any = await tools.find(t => t.name === 'bot_task_control')!.execute({ task_ref: query.task.task_ref, action: 'stop' })
  expect(stopped.ok).toBe(true)
  await f.tasks.acknowledgePersonStop(f.store.getPersonExecution(1, execution.id))
  expect(f.store.getPersonExecution(1, execution.id).state).toBe('interrupted')
  expect(f.store.getPersonExecution(1, followup.execution.id).state).toBe('interrupted')
  expect(f.runtime.stop).toHaveBeenCalledWith(execution.session_id)
})

it('keeps a genuinely separate obsolete conversation read-only', async () => {
  const { task, execution } = await f.create()
  f.db.prepare("UPDATE person_executions SET state='finished' WHERE id=?").run(execution.id)
  const updated = await f.tasks.applyPersonTask(1, { action: 'update', task_id: task.id, goal: 'A different explicit start', expected_revision: f.get(task.id).revision, idempotency_key: randomUUID() })
  await f.tasks.applyPersonTask(1, { action: 'start', task_id: task.id, expected_revision: updated.task.revision, idempotency_key: randomUUID() })
  await expect(send(task.id, { ...request(task.id, '补充来源'), execution_id: execution.id })).rejects.toMatchObject({ status: 409 })
  expect(f.store.taskPersonExecutions(1, task.id)).toHaveLength(2)
})
