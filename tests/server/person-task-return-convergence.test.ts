import { afterEach, beforeEach, expect, it } from 'vitest'
import { acceptanceFixture, type AcceptanceFixture } from './fixtures/person-acceptance'

let f: AcceptanceFixture

beforeEach(async () => { f = await acceptanceFixture() })
afterEach(async context => { await f.close(context.task.name) })

async function terminalDelivery(state: 'finished' | 'failed' | 'interrupted') {
  const { task, execution } = await f.create()
  f.db.prepare('UPDATE person_executions SET state=?,error=? WHERE id=?')
    .run(state, state === 'interrupted' ? 'Task stopped before completion' : '', execution.id)
  f.store.personEvent(execution, state === 'interrupted' ? 'run.interrupted' : `run.${state}`, {
    execution_id: execution.id,
    state,
  })
  const delivery = await import('../../packages/server/src/modules/studio/services/person/delivery')
  delivery.readyPersonDelivery(f.store.getPersonExecution(1, execution.id))
  await delivery.deliverPersonResults()
  return { task, execution, delivery }
}

it.each(['finished', 'failed', 'interrupted'] as const)(
  'publishes one consumable callback for the %s terminal state',
  async state => {
    const { task, execution } = await terminalDelivery(state)
    expect(f.runtime.deliver).toHaveBeenCalledTimes(1)
    expect(f.runtime.deliver).toHaveBeenCalledWith(expect.objectContaining({
      executionId: execution.id,
      taskId: task.id,
      status: state,
    }))
  },
)

it('makes an interrupted result visible to incremental event readers', async () => {
  const { task, execution } = await terminalDelivery('interrupted')
  const { personTools } = await import('../../packages/server/src/modules/studio/services/person/tools')
  const tools = personTools(1, 'main', undefined, task.session_id)
  const events = tools.find(tool => tool.name === 'bot_execution_events')!
  const first: any = await events.execute({ execution_id: execution.id, after: 0 })
  expect(first).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'run.interrupted' }),
  ]))

  const lastId = Math.max(...first.map((event: any) => Number(event.id)))
  const emptyReads = await Promise.all([
    events.execute({ execution_id: execution.id, after: lastId }),
    events.execute({ execution_id: execution.id, after: lastId }),
    events.execute({ execution_id: execution.id, after: lastId }),
  ])
  expect(emptyReads).toEqual([[], [], []])

  const query = tools.find(tool => tool.name === 'bot_tasks_query')!
  const snapshots = await Promise.all([
    query.execute({ task_id: task.id }),
    query.execute({ task_id: task.id }),
    query.execute({ task_id: task.id }),
  ]) as any[]
  expect(snapshots.map(snapshot => snapshot.task.execution_state)).toEqual(['interrupted', 'interrupted', 'interrupted'])
  expect(new Set(snapshots.map(snapshot => snapshot.task.revision)).size).toBe(1)
})

it('deduplicates repeated delivery polling while a callback is queued', async () => {
  const { execution, delivery } = await terminalDelivery('failed')
  await delivery.deliverPersonResults()
  await delivery.deliverPersonResults()
  expect(f.runtime.deliver).toHaveBeenCalledTimes(1)
  expect(f.db.prepare('SELECT state FROM person_deliveries WHERE execution_id=?').get(execution.id)!.state).toBe('queued')
})

it('turns a stop-before-start into one terminal callback instead of a silent cancellation', async () => {
  const { task, execution } = await f.create()
  const current = f.get(task.id)
  await f.tasks.applyPersonTask(1, {
    action: 'stop',
    task_id: task.id,
    execution_id: execution.id,
    expected_revision: current.revision,
    expected_execution_id: current.execution_id,
    idempotency_key: 'stop-before-start',
  })
  await f.runner.tickPersonWork()
  expect(f.runtime.deliver).toHaveBeenCalledTimes(1)
  expect(f.runtime.deliver).toHaveBeenCalledWith(expect.objectContaining({
    executionId: execution.id,
    status: 'interrupted',
    error: 'Task stopped before execution',
  }))
})
