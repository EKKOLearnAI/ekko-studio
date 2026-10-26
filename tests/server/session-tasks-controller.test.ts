import { beforeEach, expect, it, vi } from 'vitest'
import { listSessionTasks, updateSessionTasks } from '../../packages/server/src/modules/studio/controllers/session-tasks'
import { TaskPlanError } from '../../packages/server/src/modules/studio/services/task-plan-runs'
import { SessionTasksError } from '../../packages/server/src/modules/studio/services/session-tasks'

const runtime = vi.hoisted(() => ({ server: null as any }))
vi.mock('../../packages/server/src/modules/studio/public/chat-run', () => ({ getChatRunServer: () => runtime.server }))
const context = (body: unknown): any => ({ request: { body }, state: { profile: { name: 'research' } }, status: 200 })
beforeEach(() => {
  runtime.server = {
    listSessionTasks: vi.fn(() => ({ session_id: 'bound', revision: 0, updated_at: 0, tasks: [] })),
    updateSessionTasks: vi.fn(() => ({ session_id: 'bound', revision: 1, updated_at: 1, tasks: [] })),
  }
})

it('uses authenticated profile and live context for reads and writes', () => {
  const read = context({ context_id: 'live' })
  listSessionTasks(read)
  expect(runtime.server.listSessionTasks).toHaveBeenCalledWith('live', 'research')
  expect(read.body).toMatchObject({ ok: true, session_id: 'bound' })
  const update = { context_id: 'live', revision: 0, changes: [{ title: 'Export', summary: 'Requested', status: 'open' }] }
  const write = context(update)
  updateSessionTasks(write)
  expect(runtime.server.updateSessionTasks).toHaveBeenCalledWith('live', 'research', update)
  expect(write.body).toMatchObject({ ok: true, revision: 1 })
})

it.each([{}, { context_id: '' }, { context_id: 'live', session_id: 'other' }])('rejects invalid read input: %j', body => {
  const ctx = context(body)
  listSessionTasks(ctx)
  expect(ctx.status).toBe(400)
  expect(runtime.server.listSessionTasks).not.toHaveBeenCalled()
})

it.each([new TaskPlanError('Turn context expired', 409), new SessionTasksError('Revision conflict', 409)])('preserves interaction validation errors: %s', error => {
  runtime.server.updateSessionTasks.mockImplementation(() => { throw error })
  const ctx = context({ context_id: 'live', revision: 0, changes: [] })
  updateSessionTasks(ctx)
  expect(ctx.status).toBe(409)
  expect(ctx.body).toEqual({ ok: false, error: error.message })
})

it('reports an unavailable runtime', () => {
  runtime.server = null
  const ctx = context({ context_id: 'live' })
  listSessionTasks(ctx)
  expect(ctx.status).toBe(503)
})
