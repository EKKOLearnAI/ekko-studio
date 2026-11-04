import { afterEach, beforeEach, expect, it } from 'vitest'
import { acceptanceFixture, type AcceptanceFixture } from './fixtures/person-acceptance'
let f: AcceptanceFixture
beforeEach(async () => { f = await acceptanceFixture() })
afterEach(async context => { await f.close(context.task.name) })
it('returns the selected historical execution identity instead of the task latest identity', async () => {
  const { task, execution } = await f.create()
  expect(JSON.parse(task.selection_json)).toMatchObject({ agentId: 'reviewer', agentName: 'Fixture worker' })
  expect(JSON.parse(execution.selection_json)).toMatchObject({ agentId: 'reviewer', agentName: 'Fixture worker' })
  const original = JSON.stringify({ ...JSON.parse(execution.selection_json), agentId: 'old-worker', agentName: '原执行器' })
  f.db.prepare('UPDATE person_executions SET selection_json=? WHERE id=?').run(original, execution.id)
  f.db.prepare('UPDATE session_tasks SET selection_json=? WHERE id=?').run(JSON.stringify({ runtime: 'codex', agentName: '新执行器' }), task.id)
  const snapshot = await f.chat.personTaskChat(1, task.id, execution.id)
  expect(snapshot.session?.id).toBe(execution.session_id)
  expect(JSON.parse(snapshot.task.execution_selection_json!)).toMatchObject({ agentName: '原执行器', agentId: 'old-worker' })
  expect(JSON.parse(snapshot.task.selection_json).agentName).toBe('新执行器')
})
