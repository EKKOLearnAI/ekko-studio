import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = {
  listBoards: vi.fn(async (ctx: any) => { ctx.body = { boards: [] } }),
  createBoard: vi.fn(async (ctx: any) => { ctx.body = { board: {} } }),
  archiveBoard: vi.fn(async (ctx: any) => { ctx.body = { ok: true } }),
  capabilities: vi.fn(async (ctx: any) => { ctx.body = { capabilities: {} } }),
  approvalCapabilities: vi.fn(async (ctx: any) => { ctx.body = { approval: {} } }),
  stats: vi.fn(async (ctx: any) => { ctx.body = { stats: {} } }),
  assignees: vi.fn(async (ctx: any) => { ctx.body = { assignees: [] } }),
  readArtifact: vi.fn(async (ctx: any) => { ctx.body = { content: 'x' } }),
  listAttachments: vi.fn(async (ctx: any) => { ctx.body = { attachments: [] } }),
  readAttachment: vi.fn(async (ctx: any) => { ctx.body = Buffer.from('x') }),
  searchSessions: vi.fn(async (ctx: any) => { ctx.body = { results: [] } }),
  linkTasks: vi.fn(async (ctx: any) => { ctx.body = { ok: true } }),
  unlinkTasks: vi.fn(async (ctx: any) => { ctx.body = { ok: true } }),
  bulkUpdateTasks: vi.fn(async (ctx: any) => { ctx.body = { results: [] } }),
  list: vi.fn(async (ctx: any) => { ctx.body = { tasks: [] } }),
  get: vi.fn(async (ctx: any) => { ctx.body = { task: {} } }),
  create: vi.fn(async (ctx: any) => { ctx.body = { task: {} } }),
  complete: vi.fn(async (ctx: any) => { ctx.body = { ok: true } }),
  unblock: vi.fn(async (ctx: any) => { ctx.body = { ok: true } }),
  block: vi.fn(async (ctx: any) => { ctx.body = { ok: true } }),
  assign: vi.fn(async (ctx: any) => { ctx.body = { ok: true } }),
  addComment: vi.fn(async (ctx: any) => { ctx.body = { ok: true } }),
  taskLog: vi.fn(async (ctx: any) => { ctx.body = { log: '' } }),
  diagnostics: vi.fn(async (ctx: any) => { ctx.body = { diagnostics: [] } }),
  reclaim: vi.fn(async (ctx: any) => { ctx.body = { ok: true } }),
  reassign: vi.fn(async (ctx: any) => { ctx.body = { ok: true } }),
  specify: vi.fn(async (ctx: any) => { ctx.body = { results: [] } }),
  dispatch: vi.fn(async (ctx: any) => { ctx.body = { result: {} } }),
  claimTask: vi.fn(async (ctx: any) => { ctx.body = { receipt: {} } }),
  requestTaskReview: vi.fn(async (ctx: any) => { ctx.body = { receipt: {} } }),
  approveTask: vi.fn(async (ctx: any) => { ctx.body = { receipt: {} } }),
  requestTaskChanges: vi.fn(async (ctx: any) => { ctx.body = { receipt: {} } }),
  archiveApprovalTask: vi.fn(async (ctx: any) => { ctx.body = { receipt: {} } }),
}

vi.mock('../../packages/server/src/modules/hermes/controllers/kanban', () => handlers)
vi.mock('../../packages/server/src/modules/hermes/controllers/kanban-dingtalk-approval', () => ({
  receiveDingTalkKanbanApproval: vi.fn(),
}))

describe('kanban routes', () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(handlers).forEach(fn => fn.mockClear())
  })

  it('registers all kanban routes', async () => {
    const { kanbanRoutes } = await import('../../packages/server/src/modules/hermes/routes/kanban')
    const paths = kanbanRoutes.stack.map((entry: any) => entry.path)

    expect(paths).toEqual(expect.arrayContaining([
      '/api/hermes/kanban/boards',
      '/api/hermes/kanban/boards/:slug',
      '/api/hermes/kanban/capabilities',
      '/api/hermes/kanban/approval/capabilities',
      '/api/hermes/kanban/stats',
      '/api/hermes/kanban/assignees',
      '/api/hermes/kanban/diagnostics',
      '/api/hermes/kanban/dispatch',
      '/api/hermes/kanban/artifact',
      '/api/hermes/kanban/search-sessions',
      '/api/hermes/kanban/links',
      '/api/hermes/kanban/tasks/bulk',
      '/api/hermes/kanban',
      '/api/hermes/kanban/:id/attachments',
      '/api/hermes/kanban/:id/attachments/:attachmentId',
      '/api/hermes/kanban/:id',
      '/api/hermes/kanban/complete',
      '/api/hermes/kanban/unblock',
      '/api/hermes/kanban/:id/block',
      '/api/hermes/kanban/:id/assign',
      '/api/hermes/kanban/:id/comments',
      '/api/hermes/kanban/:id/log',
      '/api/hermes/kanban/:id/reclaim',
      '/api/hermes/kanban/:id/reassign',
      '/api/hermes/kanban/:id/specify',
      '/api/hermes/kanban/:id/claim',
      '/api/hermes/kanban/:id/request-review',
      '/api/hermes/kanban/:id/approve',
      '/api/hermes/kanban/:id/request-changes',
      '/api/hermes/kanban/:id/archive',
    ]))
    expect(paths).not.toContain('/api/hermes/kanban/dingtalk/approval-callback')
  })

  it('registers the signed DingTalk callback on the public router', async () => {
    const { kanbanPublicRoutes } = await import('../../packages/server/src/modules/hermes/routes/kanban')
    expect(kanbanPublicRoutes.stack.map((entry: any) => entry.path)).toEqual([
      '/api/hermes/kanban/dingtalk/approval-callback',
    ])
  })

  it('delegates search-sessions to the controller', async () => {
    const { kanbanRoutes } = await import('../../packages/server/src/modules/hermes/routes/kanban')
    const layer = kanbanRoutes.stack.find((entry: any) => entry.path === '/api/hermes/kanban/search-sessions')
    const ctx: any = { query: { task_id: 'task-1', profile: 'alice' }, body: null, params: {} }

    await layer.stack[0](ctx)

    expect(handlers.searchSessions).toHaveBeenCalledWith(ctx)
    expect(ctx.body).toEqual({ results: [] })
  })
})
