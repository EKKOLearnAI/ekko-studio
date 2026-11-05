import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { acceptance, acceptanceFixture, type AcceptanceFixture } from './fixtures/person-acceptance'
import { personResultPrompt } from '../../packages/server/src/modules/studio/services/person/result-prompt'

let f: AcceptanceFixture
beforeEach(async () => {
  f = await acceptanceFixture()
  vi.mocked(f.runtime.model).mockRejectedValue(new Error('Manual follow-ups must not call the coordinator'))
  const { finishPersonDelivery } = await import('../../packages/server/src/modules/studio/services/person/delivery')
  vi.mocked(f.runtime.deliver).mockImplementation(async result => finishPersonDelivery(1, result.executionId, true, '', result.origin.acceptanceReturnId))
})
afterEach(async context => {
  try { expect(f.runtime.model).not.toHaveBeenCalled() }
  finally { await f.close(context.task.name) }
})
function request(taskId: string, text: string) {
  const task = f.get(taskId)
  return { input: [{ type: 'text', text }], expected_revision: task.revision, expected_execution_id: task.execution_id, idempotency_key: randomUUID() }
}
async function send(taskId: string, body: Record<string, unknown>) {
  return (await import('../../packages/server/src/modules/studio/services/person/task-input')).submitPersonTaskInput(1, taskId, body)
}
async function deliver() { await (await import('../../packages/server/src/modules/studio/services/person/delivery')).deliverPersonResults() }
function saved(executionId: string) {
  return JSON.parse(String(f.db.prepare('SELECT origin_json FROM person_deliveries WHERE execution_id=?').get(executionId)!.origin_json))
}
function returned(executionId: string) {
  return vi.mocked(f.runtime.deliver).mock.calls.map(([result]) => result).find(result => result.executionId === executionId)!
}

it('returns a manual Guiyang result as the current user adjustment after the Xiamen task completed', async () => {
  const { addMessage } = await import('../../packages/server/src/modules/studio/repositories/session-store')
  addMessage({ session_id: 'person-main-1', role: 'user', content: '查询厦门天气' })
  const { task, execution } = await f.create({ title: '查询厦门天气', goal: '查询厦门天气并注明来源' })
  f.execute.mockResolvedValueOnce({ ok: true, output: '厦门天气：晴' })
  await f.run(task.id); await deliver()
  expect(returned(execution.id).manualFollowup).toBeUndefined()
  // The original round was reported and the task marked completed before the user's new turn.
  f.db.prepare("UPDATE session_tasks SET status='completed',completion_evidence='厦门天气：晴',completed_at=? WHERE id=?").run(Date.now(), task.id)
  const body = request(task.id, '现在查询贵阳天气')
  const followup = await send(task.id, body)
  expect(followup.execution.session_id).toBe(execution.session_id)
  f.execute.mockResolvedValueOnce({ ok: true, output: '贵阳天气：多云，来源：气象台' })
  await f.run(task.id); await deliver()
  const callback = returned(followup.execution.id)
  expect(callback).toMatchObject({ manualFollowup: { executionId: followup.execution.id, input: body.input }, output: '贵阳天气：多云，来源：气象台' })
  expect(callback.origin).not.toHaveProperty('manualFollowup')
  const prompt = personResultPrompt(callback)
  expect(prompt.messages[0].content).toBe('查询厦门天气')
  expect(prompt.messages.at(-1)?.content).toContain('现在查询贵阳天气')
  expect(prompt.input).toContain('not proof that a changed target is an error')
  expect(f.get(task.id).requirements_json).toBe(task.requirements_json)
})

it('persists each queued manual input across retries and restart without contaminating the next Bot turn', async () => {
  const { task, execution } = await f.create()
  const firstBody = request(task.id, '查贵阳天气')
  const first = await send(task.id, firstBody)
  const input = [{ type: 'text', text: '再查成都天气' }, { type: 'image', name: 'map.png', path: '/fixture/map.png', media_type: 'image/png', context: '参考城市地图' }]
  const second = await send(task.id, { ...request(task.id, ''), input })
  const replay = await send(task.id, firstBody)
  expect(replay.execution.id).toBe(first.execution.id)
  expect(saved(first.execution.id).manualFollowup.input).toEqual(firstBody.input)
  expect(saved(second.execution.id).manualFollowup.input).toEqual(input)
  await f.reopen()
  await vi.waitFor(async () => {
    await f.runner.tickPersonWork()
    expect(f.store.getPersonExecution(1, second.execution.id).state).toBe('finished')
    await deliver()
    expect(returned(second.execution.id)).toBeDefined()
  }, { timeout: 4000, interval: 15 })
  expect(returned(execution.id).manualFollowup).toBeUndefined()
  expect(returned(first.execution.id).manualFollowup?.input).toEqual(firstBody.input)
  expect(returned(second.execution.id).manualFollowup?.input).toEqual(input)
  const tools = f.personTaskTools(1, task.session_id)
  const queried: any = await tools.find(tool => tool.name === 'bot_tasks_query')!.execute({ task_id: task.id })
  const next: any = await tools.find(tool => tool.name === 'bot_task_control')!.execute({ action: 'continue', task_ref: queried.task.task_ref, message: 'Bot 补充汇总' })
  expect(next.ok).toBe(true)
  await f.run(task.id); await deliver()
  const latest = f.get(task.id).execution_id!
  expect(returned(latest).manualFollowup).toBeUndefined()
  expect(saved(latest)).not.toHaveProperty('manualFollowup')
  expect(JSON.parse(String(f.db.prepare('SELECT origin_json FROM person_task_origins WHERE task_id=?').get(task.id)!.origin_json))).not.toHaveProperty('manualFollowup')
  expect(f.execute.mock.calls.map(([i]) => i.sessionId)).toEqual(Array(4).fill(execution.session_id))
})

it('retains manual request context on linked review callbacks while preserving explicit acceptance', async () => {
  const { task } = await f.create({ start: false, acceptance })
  const body = request(task.id, '写入 42，并补充交付说明')
  const followup = await send(task.id, body)
  await f.run(task.id)
  const review = await f.verify(task.id)
  await f.run(review.task.id); await deliver()
  const callback = returned(review.execution.id)
  expect(callback).toMatchObject({ manualFollowup: { executionId: followup.execution.id, input: body.input }, acceptance: { kind: 'verification', next_action: 'review' } })
  expect(personResultPrompt(callback).input).toContain('record_acceptance')
  expect(saved(review.execution.id)).not.toHaveProperty('manualFollowup')
  expect(JSON.parse(f.receipt(followup.execution.id).snapshot_json).requirements.acceptance.criteria).toEqual(JSON.parse(f.get(task.id).requirements_json).acceptance.criteria)
  await f.record(task.id)
  expect(f.receipt(followup.execution.id).state).toBe('passed')
})

it('retains the original manual instruction when repair feedback is prepended internally', async () => {
  const { task } = await f.create({ acceptance })
  f.worker('41', '42')
  await f.run(task.id)
  const review = await f.verify(task.id)
  await f.run(review.task.id); await f.record(task.id)
  expect(f.receipt(f.get(task.id).execution_id!).state).toBe('repair_required')
  const body = request(task.id, '请修复评审指出的问题，保留说明')
  const followup = await send(task.id, body)
  expect(JSON.parse(followup.execution.input_json)).toHaveLength(2)
  expect(saved(followup.execution.id).manualFollowup.input).toEqual(body.input)
})

it('keeps manual context on a failed execution and a retried callback after restart', async () => {
  const { task } = await f.create({ start: false })
  const body = request(task.id, '查贵阳天气')
  const followup = await send(task.id, body)
  f.execute.mockResolvedValueOnce({ ok: false, output: '', error: 'Weather provider unavailable' })
  await f.run(task.id)
  vi.mocked(f.runtime.deliver).mockRejectedValueOnce(new Error('Bot temporarily busy'))
  await deliver()
  expect(f.db.prepare('SELECT state FROM person_deliveries WHERE execution_id=?').get(followup.execution.id)!.state).toBe('pending')
  await f.reopen()
  f.db.prepare('UPDATE person_deliveries SET updated_at=0 WHERE execution_id=?').run(followup.execution.id)
  await deliver()
  const callbacks = vi.mocked(f.runtime.deliver).mock.calls.map(([result]) => result)
  expect(callbacks).toHaveLength(2)
  expect(callbacks[1]).toMatchObject({ status: 'failed', manualFollowup: { executionId: followup.execution.id, input: body.input }, error: 'Weather provider unavailable' })
  expect(personResultPrompt(callbacks[1]).receipt).toContain('Weather provider unavailable')
  expect(f.db.prepare('SELECT state FROM person_deliveries WHERE execution_id=?').get(followup.execution.id)!.state).toBe('delivered')
})

it('strips execution-only metadata from a reused callback origin and ignores client source flags', async () => {
  const { task } = await f.create({ start: false })
  const fake = { executionId: 'unrelated', input: [{ type: 'text', text: '假的人工要求' }] }
  const bot = await f.chat.continuePersonTask(1, task.id, { ...request(task.id, 'Bot 原有指令'), manualFollowup: fake },
    { sessionId: task.session_id, runId: 'bot', messages: [], manualFollowup: fake } as any)
  expect(saved(bot.execution.id)).not.toHaveProperty('manualFollowup')
  const manual = await send(task.id, { ...request(task.id, '真实人工要求'), manualFollowup: fake })
  expect(saved(manual.execution.id).manualFollowup).toEqual({ executionId: manual.execution.id, input: [{ type: 'text', text: '真实人工要求' }] })
})
