import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockReadFile = vi.hoisted(() => vi.fn())
const mockListBoards = vi.hoisted(() => vi.fn())
const mockCreateBoard = vi.hoisted(() => vi.fn())
const mockArchiveBoard = vi.hoisted(() => vi.fn())
const mockGetCapabilities = vi.hoisted(() => vi.fn())
const mockListTasks = vi.hoisted(() => vi.fn())
const mockGetTask = vi.hoisted(() => vi.fn())
const mockCreateTask = vi.hoisted(() => vi.fn())
const mockCompleteTasks = vi.hoisted(() => vi.fn())
const mockBlockTask = vi.hoisted(() => vi.fn())
const mockUnblockTasks = vi.hoisted(() => vi.fn())
const mockAssignTask = vi.hoisted(() => vi.fn())
const mockAddComment = vi.hoisted(() => vi.fn())
const mockLinkTasks = vi.hoisted(() => vi.fn())
const mockUnlinkTasks = vi.hoisted(() => vi.fn())
const mockBulkUpdateTasks = vi.hoisted(() => vi.fn())
const mockGetTaskLog = vi.hoisted(() => vi.fn())
const mockGetDiagnostics = vi.hoisted(() => vi.fn())
const mockReclaimTask = vi.hoisted(() => vi.fn())
const mockReassignTask = vi.hoisted(() => vi.fn())
const mockSpecifyTask = vi.hoisted(() => vi.fn())
const mockDispatch = vi.hoisted(() => vi.fn())
const mockGetStats = vi.hoisted(() => vi.fn())
const mockGetAssignees = vi.hoisted(() => vi.fn())
const mockListAttachments = vi.hoisted(() => vi.fn())
const mockPerformApprovalAction = vi.hoisted(() => vi.fn())
const mockReconcileDingTalkApprovalEvent = vi.hoisted(() => vi.fn())
const mockSearchSessions = vi.hoisted(() => vi.fn())
const mockGetSessionDetail = vi.hoisted(() => vi.fn())
const mockGetExactSessionDetail = vi.hoisted(() => vi.fn())
const mockFindLatestExactSessionId = vi.hoisted(() => vi.fn())
const mockListUserProfiles = vi.hoisted(() => vi.fn())

vi.mock('fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('fs/promises')>(),
  readFile: mockReadFile,
}))

vi.mock('os', () => ({
  homedir: () => '/Users/tester',
}))

vi.mock('../../packages/server/src/modules/hermes/services/runtime/path', () => ({
  detectHermesRootHome: () => '/Users/tester/.hermes',
  isRealPathWithin: vi.fn(async () => true),
}))

vi.mock('../../packages/server/src/modules/hermes/services/kanban/kanban-service', () => ({
  normalizeBoardSlug: (board?: string | null) => {
    const value = board?.trim().toLowerCase() || 'default'
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) throw new Error('Invalid kanban board slug')
    return value
  },
  listBoards: mockListBoards,
  createBoard: mockCreateBoard,
  archiveBoard: mockArchiveBoard,
  getCapabilities: mockGetCapabilities,
  listTasks: mockListTasks,
  getTask: mockGetTask,
  createTask: mockCreateTask,
  completeTasks: mockCompleteTasks,
  blockTask: mockBlockTask,
  unblockTasks: mockUnblockTasks,
  assignTask: mockAssignTask,
  addComment: mockAddComment,
  linkTasks: mockLinkTasks,
  unlinkTasks: mockUnlinkTasks,
  bulkUpdateTasks: mockBulkUpdateTasks,
  getTaskLog: mockGetTaskLog,
  getDiagnostics: mockGetDiagnostics,
  reclaimTask: mockReclaimTask,
  reassignTask: mockReassignTask,
  specifyTask: mockSpecifyTask,
  dispatch: mockDispatch,
  getStats: mockGetStats,
  getAssignees: mockGetAssignees,
  listAttachments: mockListAttachments,
  performApprovalAction: mockPerformApprovalAction,
}))

vi.mock('../../packages/server/src/modules/hermes/services/kanban/dingtalk-approval-outbox', () => ({
  reconcileDingTalkApprovalEvent: mockReconcileDingTalkApprovalEvent,
  notificationResultFromOutboxRecord: (record: any) => ({
    configured: record.configured,
    api_accepted: record.api_accepted,
    attempts: record.attempts,
    recipient_confirmed: false,
  }),
}))

vi.mock('../../packages/server/src/modules/hermes/services/history/sessions-db', () => ({
  searchSessionSummariesWithProfile: mockSearchSessions,
  getSessionDetailFromDbWithProfile: mockGetSessionDetail,
  getExactSessionDetailFromDbWithProfile: mockGetExactSessionDetail,
  findLatestExactSessionIdWithProfile: mockFindLatestExactSessionId,
}))

vi.mock('../../packages/server/src/modules/studio/public/users', () => ({
  listUserProfiles: mockListUserProfiles,
}))

import * as ctrl from '../../packages/server/src/modules/hermes/controllers/kanban'

function ctx(overrides: Record<string, any> = {}) {
  return {
    query: {},
    params: {},
    request: { body: {} },
    status: 200,
    body: null,
    ...overrides,
  } as any
}

describe('kanban controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.HERMES_STUDIO_KANBAN_APPROVERS
    delete process.env.HERMES_STUDIO_KANBAN_APPROVAL_BOARDS
    delete process.env.DINGTALK_APPROVAL_WEBHOOK_URL
    mockListUserProfiles.mockReturnValue([{ profile_name: 'research' }])
    mockGetTask.mockImplementation(async (id: string) => ({
      task: { id, assignee: null, status: 'ready' },
      comments: [],
      events: [],
      runs: [],
    }))
  })

  it('gates approval-center actions to explicit Studio identities and board allowlists', async () => {
    process.env.HERMES_STUDIO_KANBAN_APPROVERS = 'james'
    process.env.HERMES_STUDIO_KANBAN_APPROVAL_BOARDS = 'codex-tech'
    mockPerformApprovalAction.mockResolvedValue({
      ok: true,
      action: 'approve',
      event_id: 'evt-1',
      after_status: 'done',
      task: { id: 'task-1', status: 'done' },
    })

    const deniedIdentity = ctx({
      state: { user: { id: 2, username: 'alice', role: 'super_admin' } },
      query: { board: 'codex-tech' },
      params: { id: 'task-1' },
      request: { body: { reason: 'approved' } },
    })
    await ctrl.approveTask(deniedIdentity)
    expect(deniedIdentity.status).toBe(403)

    const deniedBoard = ctx({
      state: { user: { id: 1, username: 'james', role: 'super_admin' } },
      query: { board: 'default' },
      params: { id: 'task-1' },
      request: { body: { reason: 'approved' } },
    })
    await ctrl.approveTask(deniedBoard)
    expect(deniedBoard.status).toBe(403)

    const allowed = ctx({
      state: { user: { id: 1, username: 'james', role: 'super_admin' } },
      query: { board: 'codex-tech' },
      params: { id: 'task-1' },
      request: { body: { reason: 'approved', event_id: 'evt-1' } },
    })
    await ctrl.approveTask(allowed)
    expect(mockPerformApprovalAction).toHaveBeenCalledWith('task-1', 'approve', {
      actor: 'james',
      board: 'codex-tech',
      channel: 'studio',
      eventId: 'evt-1',
      reason: 'approved',
      reviewer: undefined,
    })
    expect(allowed.body).toMatchObject({ receipt: { event_id: 'evt-1', after_status: 'done' } })
  })

  it('returns approval capabilities without treating super-admin as an allow-all approver', async () => {
    process.env.HERMES_STUDIO_KANBAN_APPROVERS = 'james'
    const allowed = ctx({ state: { user: { id: 1, username: 'james', role: 'super_admin' } } })
    await ctrl.approvalCapabilities(allowed)
    expect(allowed.body).toEqual({ approval: { can_approve: true, allowed_boards: ['codex-tech'], dingtalk_configured: false } })

    const denied = ctx({ state: { user: { id: 2, username: 'admin', role: 'super_admin' } } })
    await ctrl.approvalCapabilities(denied)
    expect(denied.body).toEqual({ approval: { can_approve: false, allowed_boards: ['codex-tech'], dingtalk_configured: false } })
  })

  it('requests review, performs readback, and reports DingTalk API acceptance separately from receipt', async () => {
    process.env.HERMES_STUDIO_KANBAN_APPROVERS = 'james'
    process.env.DINGTALK_APPROVAL_WEBHOOK_URL = 'https://example.com/hook'
    mockPerformApprovalAction.mockResolvedValue({
      ok: true,
      action: 'request_review',
      event_id: 'evt-review',
      canonical_event_id: 42,
      after_status: 'review',
      task: { id: 'task-1', title: 'Review me', priority: 3, status: 'review' },
    })
    mockReconcileDingTalkApprovalEvent.mockResolvedValue({
      task_id: 'task-1', configured: true, api_accepted: true, attempts: 1, recipient_confirmed: false,
    })
    const c = ctx({
      state: { user: { id: 1, username: 'james', role: 'super_admin' } },
      query: { board: 'codex-tech' },
      params: { id: 'task-1' },
      request: { body: { reason: 'tests pass', event_id: 'evt-review' } },
      origin: 'http://127.0.0.1:8748',
    })

    await ctrl.requestTaskReview(c)

    expect(c.body).toMatchObject({
      receipt: { after_status: 'review' },
      notification: { api_accepted: true, recipient_confirmed: false },
    })
    expect(mockReconcileDingTalkApprovalEvent).toHaveBeenCalledWith('codex-tech', 'task-1', '42')
  })

  it('lists boards and tasks with explicit/default board context', async () => {
    mockListBoards.mockResolvedValue([{ slug: 'default' }])
    mockListTasks.mockResolvedValue([{ id: 'task-1' }])

    const boardsCtx = ctx({ query: { includeArchived: 'true' } })
    await ctrl.listBoards(boardsCtx)
    expect(mockListBoards).toHaveBeenCalledWith({ includeArchived: true })
    expect(boardsCtx.body).toEqual({ boards: [{ slug: 'default' }] })

    const c = ctx({ query: { board: 'project-a', status: 'todo', assignee: 'alice', tenant: 'ops', includeArchived: 'true' } })
    await ctrl.list(c)
    expect(mockListTasks).toHaveBeenCalledWith({ board: 'project-a', status: 'todo', assignee: 'alice', tenant: 'ops', includeArchived: true })
    expect(c.body).toEqual({ tasks: [{ id: 'task-1' }] })

    mockCreateBoard.mockResolvedValue({ slug: 'project-b' })
    const createBoardCtx = ctx({ request: { body: { slug: 'project-b', name: 'Project B', switchCurrent: false } } })
    await ctrl.createBoard(createBoardCtx)
    expect(mockCreateBoard).toHaveBeenCalledWith({ slug: 'project-b', name: 'Project B', description: undefined, icon: undefined, color: undefined, switchCurrent: false })
    expect(createBoardCtx.body).toEqual({ board: { slug: 'project-b' } })

    mockArchiveBoard.mockResolvedValue(undefined)
    const archiveCtx = ctx({ params: { slug: 'project-b' } })
    await ctrl.archiveBoard(archiveCtx)
    expect(mockArchiveBoard).toHaveBeenCalledWith('project-b')
    expect(archiveCtx.body).toEqual({ ok: true })

    mockGetCapabilities.mockResolvedValue({ source: 'hermes-cli', supports: {}, missing: [] })
    const capabilitiesCtx = ctx()
    await ctrl.capabilities(capabilitiesCtx)
    expect(capabilitiesCtx.body).toEqual({ capabilities: { source: 'hermes-cli', supports: {}, missing: [] } })

    const defaultCtx = ctx({ query: { status: 'ready' } })
    await ctrl.list(defaultCtx)
    expect(mockListTasks).toHaveBeenLastCalledWith({ board: 'default', status: 'ready', assignee: undefined, tenant: undefined, includeArchived: false })
  })

  it('filters kanban tasks, stats, and assignees to the user-bound profiles', async () => {
    const tasks = [
      { id: 'task-1', assignee: 'research', status: 'todo' },
      { id: 'task-2', assignee: 'travel', status: 'done' },
      { id: 'task-3', assignee: null, status: 'blocked' },
    ]
    mockListTasks.mockResolvedValue(tasks)
    mockGetAssignees.mockResolvedValue([
      { name: 'research', on_disk: true, counts: { todo: 1 } },
      { name: 'travel', on_disk: true, counts: { done: 1 } },
      { name: 'default', on_disk: true, counts: { blocked: 1 } },
    ])

    const state = { user: { id: 7, role: 'admin' }, profile: { name: 'research' } }
    const listCtx = ctx({ state, query: { board: 'default', includeArchived: 'true' } })
    await ctrl.list(listCtx)
    expect(listCtx.body).toEqual({ tasks: [tasks[0]] })

    const statsCtx = ctx({ state, query: { board: 'default' } })
    await ctrl.stats(statsCtx)
    expect(statsCtx.body).toEqual({ stats: { by_status: { todo: 1 }, by_assignee: { research: 1 }, total: 1 } })

    const assigneesCtx = ctx({ state, query: { board: 'default' } })
    await ctrl.assignees(assigneesCtx)
    expect(assigneesCtx.body).toEqual({ assignees: [{ name: 'research', on_disk: true, counts: { todo: 1 } }] })
  })

  it('loads kanban data for every profile bound to the user instead of only the active header profile', async () => {
    mockListUserProfiles.mockReturnValue([{ profile_name: 'research' }, { profile_name: 'travel' }])
    const tasks = [
      { id: 'task-1', assignee: 'research', status: 'todo' },
      { id: 'task-2', assignee: 'travel', status: 'done' },
      { id: 'task-3', assignee: 'default', status: 'blocked' },
    ]
    mockListTasks.mockResolvedValue(tasks)
    mockGetAssignees.mockResolvedValue([
      { name: 'research', on_disk: true, counts: { todo: 1 } },
    ])

    const state = { user: { id: 7, role: 'admin' }, profile: { name: 'research' } }
    const listCtx = ctx({ state, query: { board: 'default', includeArchived: 'true' } })
    await ctrl.list(listCtx)
    expect(listCtx.body).toEqual({ tasks: [tasks[0], tasks[1]] })

    const statsCtx = ctx({ state, query: { board: 'default' } })
    await ctrl.stats(statsCtx)
    expect(statsCtx.body).toEqual({
      stats: {
        by_status: { todo: 1, done: 1 },
        by_assignee: { research: 1, travel: 1 },
        total: 2,
      },
    })

    const assigneesCtx = ctx({ state, query: { board: 'default' } })
    await ctrl.assignees(assigneesCtx)
    expect(assigneesCtx.body).toEqual({
      assignees: [
        { name: 'research', on_disk: true, counts: { todo: 1 } },
        { name: 'travel', on_disk: true, counts: null },
      ],
    })
  })

  it('defaults created kanban tasks to the requested profile and rejects unauthorized assignees', async () => {
    mockCreateTask.mockResolvedValue({ id: 'task-1', assignee: 'research' })
    const state = { user: { id: 7, role: 'admin' }, profile: { name: 'research' } }

    const createCtx = ctx({ state, query: { board: 'default' }, request: { body: { title: 'Ship it' } } })
    await ctrl.create(createCtx)
    expect(mockCreateTask).toHaveBeenCalledWith('Ship it', { board: 'default', body: undefined, assignee: 'research', priority: undefined, tenant: undefined })
    expect(createCtx.body).toEqual({ task: { id: 'task-1', assignee: 'research' } })

    const assignCtx = ctx({ state, query: { board: 'default' }, params: { id: 'task-1' }, request: { body: { profile: 'travel' } } })
    await ctrl.assign(assignCtx)
    expect(assignCtx.status).toBe(403)
    expect(mockAssignTask).not.toHaveBeenCalled()
  })

  it('prevents profile-scoped users from mutating or inspecting hidden tasks', async () => {
    const state = { user: { id: 7, role: 'admin' }, profile: { name: 'research' } }
    mockGetTask.mockResolvedValue({
      task: { id: 'task-hidden', assignee: 'travel', status: 'ready' },
      comments: [],
      events: [],
      runs: [],
    })

    const cases = [
      { invoke: ctrl.complete, context: ctx({ state, request: { body: { task_ids: ['task-hidden'] } } }), mock: mockCompleteTasks },
      { invoke: ctrl.block, context: ctx({ state, params: { id: 'task-hidden' }, request: { body: { reason: 'wait' } } }), mock: mockBlockTask },
      { invoke: ctrl.unblock, context: ctx({ state, request: { body: { task_ids: ['task-hidden'] } } }), mock: mockUnblockTasks },
      { invoke: ctrl.assign, context: ctx({ state, params: { id: 'task-hidden' }, request: { body: { profile: 'research' } } }), mock: mockAssignTask },
      { invoke: ctrl.addComment, context: ctx({ state, params: { id: 'task-hidden' }, request: { body: { body: 'secret' } } }), mock: mockAddComment },
      { invoke: ctrl.bulkUpdateTasks, context: ctx({ state, request: { body: { ids: ['task-hidden'], status: 'done' } } }), mock: mockBulkUpdateTasks },
      { invoke: ctrl.taskLog, context: ctx({ state, params: { id: 'task-hidden' } }), mock: mockGetTaskLog },
      { invoke: ctrl.reclaim, context: ctx({ state, params: { id: 'task-hidden' } }), mock: mockReclaimTask },
      { invoke: ctrl.reassign, context: ctx({ state, params: { id: 'task-hidden' }, request: { body: { profile: 'research' } } }), mock: mockReassignTask },
      { invoke: ctrl.specify, context: ctx({ state, params: { id: 'task-hidden' } }), mock: mockSpecifyTask },
    ]

    for (const testCase of cases) {
      vi.clearAllMocks()
      mockListUserProfiles.mockReturnValue([{ profile_name: 'research' }])
      mockGetTask.mockResolvedValue({
        task: { id: 'task-hidden', assignee: 'travel', status: 'ready' },
        comments: [],
        events: [],
        runs: [],
      })
      await testCase.invoke(testCase.context)
      expect(testCase.context.status).toBe(404)
      expect(testCase.mock).not.toHaveBeenCalled()
    }

    const dispatchCtx = ctx({ state, request: { body: { dryRun: true } } })
    await ctrl.dispatch(dispatchCtx)
    expect(dispatchCtx.status).toBe(403)
    expect(mockDispatch).not.toHaveBeenCalled()
  })

  it('lists and reads only attachments belonging to an authorized task', async () => {
    const storedPath = '/Users/tester/.hermes/kanban/attachments/task-1/report.html'
    mockGetTask.mockResolvedValue({
      task: { id: 'task-1', assignee: null, status: 'done' },
      comments: [],
      events: [],
      runs: [],
    })
    mockListAttachments.mockResolvedValue([{
      id: 7,
      filename: 'report.html',
      content_type: 'text/html',
      size: 42,
      uploaded_by: 'default',
      stored_path: storedPath,
      created_at: 1,
    }])
    mockReadFile.mockResolvedValue(Buffer.from('<h1>report</h1>'))

    const listCtx = ctx({ params: { id: 'task-1' } })
    await ctrl.listAttachments(listCtx)
    expect(listCtx.body.attachments[0]).toMatchObject({ id: 7, filename: 'report.html' })
    expect(listCtx.body.attachments[0]).not.toHaveProperty('stored_path')

    const headers: Record<string, string> = {}
    const readCtx = ctx({
      params: { id: 'task-1', attachmentId: '7' },
      set: (name: string, value: string) => { headers[name] = value },
    })
    await ctrl.readAttachment(readCtx)
    expect(readCtx.body).toEqual(Buffer.from('<h1>report</h1>'))
    expect(readCtx.type).toBe('text/html')
    expect(headers['Content-Disposition']).toBe("attachment; filename*=UTF-8''report.html")
    expect(headers['X-Content-Type-Options']).toBe('nosniff')
  })

  it('proxies comment/log/diagnostics with explicit board context', async () => {
    const taskLog = { task_id: 'task-1', path: null, exists: true, size_bytes: 10, content: 'worker log', truncated: false }
    mockAddComment.mockResolvedValue({ ok: true, output: 'commented' })
    mockGetTaskLog.mockResolvedValue(taskLog)
    mockGetDiagnostics.mockResolvedValue([{ task_id: 'task-1' }])

    const commentCtx = ctx({ query: { board: 'project-a' }, params: { id: 'task-1' }, request: { body: { body: 'needs review', author: 'han' } } })
    await ctrl.addComment(commentCtx)
    expect(mockAddComment).toHaveBeenCalledWith('task-1', 'needs review', { board: 'project-a', author: 'han' })
    expect(commentCtx.body).toEqual({ ok: true, output: 'commented' })

    const logCtx = ctx({ query: { board: 'default', tail: '4000' }, params: { id: 'task-1' } })
    await ctrl.taskLog(logCtx)
    expect(mockGetTaskLog).toHaveBeenCalledWith('task-1', { board: 'default', tail: 4000 })
    expect(logCtx.body).toEqual(taskLog)

    const diagnosticsCtx = ctx({ query: { board: 'default', task: 'task-1', severity: 'warning' } })
    await ctrl.diagnostics(diagnosticsCtx)
    expect(mockGetDiagnostics).toHaveBeenCalledWith({ board: 'default', task: 'task-1', severity: 'warning' })
    expect(diagnosticsCtx.body).toEqual({ diagnostics: [{ task_id: 'task-1' }] })
  })

  it('proxies links and bulk actions with explicit board context', async () => {
    mockLinkTasks.mockResolvedValue({ ok: true, output: 'linked' })
    mockUnlinkTasks.mockResolvedValue({ ok: true, output: 'unlinked' })
    mockBulkUpdateTasks.mockResolvedValue({ results: [{ id: 'task-1', ok: true }] })

    const linkCtx = ctx({ query: { board: 'project-a' }, request: { body: { parent_id: 'task-1', child_id: 'task-2' } } })
    await ctrl.linkTasks(linkCtx)
    expect(mockLinkTasks).toHaveBeenCalledWith('task-1', 'task-2', { board: 'project-a' })
    expect(linkCtx.body).toEqual({ ok: true, output: 'linked' })

    const unlinkCtx = ctx({ query: { board: 'project-a', parent_id: 'task-1', child_id: 'task-2' } })
    await ctrl.unlinkTasks(unlinkCtx)
    expect(mockUnlinkTasks).toHaveBeenCalledWith('task-1', 'task-2', { board: 'project-a' })
    expect(unlinkCtx.body).toEqual({ ok: true, output: 'unlinked' })

    const bulkCtx = ctx({ query: { board: 'project-a' }, request: { body: { ids: ['task-1'], status: 'done', assignee: null, summary: 'closed' } } })
    await ctrl.bulkUpdateTasks(bulkCtx)
    expect(mockBulkUpdateTasks).toHaveBeenCalledWith({ board: 'project-a', ids: ['task-1'], status: 'done', assignee: null, archive: undefined, summary: 'closed', reason: undefined, operatorOverride: true })
    expect(bulkCtx.body).toEqual({ results: [{ id: 'task-1', ok: true }] })
  })

  it('validates canonical parity endpoint inputs before shelling out', async () => {
    const invalidTailCtx = ctx({ query: { board: 'default', tail: '0' }, params: { id: 'task-1' } })
    await ctrl.taskLog(invalidTailCtx)
    expect(invalidTailCtx.status).toBe(400)
    expect(mockGetTaskLog).not.toHaveBeenCalled()

    const oversizedTailCtx = ctx({ query: { board: 'default', tail: '1000001' }, params: { id: 'task-1' } })
    await ctrl.taskLog(oversizedTailCtx)
    expect(oversizedTailCtx.status).toBe(400)
    expect(mockGetTaskLog).not.toHaveBeenCalled()

    const invalidSeverityCtx = ctx({ query: { board: 'default', severity: 'info' } })
    await ctrl.diagnostics(invalidSeverityCtx)
    expect(invalidSeverityCtx.status).toBe(400)
    expect(mockGetDiagnostics).not.toHaveBeenCalled()

    const emptyBoardCtx = ctx({ query: { board: ' ' } })
    await ctrl.list(emptyBoardCtx)
    expect(emptyBoardCtx.status).toBe(400)
    expect(mockListTasks).not.toHaveBeenCalled()

    const invalidDispatchCtx = ctx({ query: { board: 'default' }, request: { body: { dryRun: 'yes', max: -1, failureLimit: 0 } } })
    await ctrl.dispatch(invalidDispatchCtx)
    expect(invalidDispatchCtx.status).toBe(400)
    expect(mockDispatch).not.toHaveBeenCalled()

    const oversizedDispatchCtx = ctx({ query: { board: 'default' }, request: { body: { dryRun: false, max: 999999999 } } })
    await ctrl.dispatch(oversizedDispatchCtx)
    expect(oversizedDispatchCtx.status).toBe(400)
    expect(mockDispatch).not.toHaveBeenCalled()
  })

  it('rejects malformed parity action bodies before shelling out', async () => {
    const cases: Array<{ name: string; invoke: (c: any) => Promise<void>; context: any; mock: ReturnType<typeof vi.fn> }> = [
      { name: 'comment body object', invoke: ctrl.addComment, context: ctx({ query: { board: 'default' }, params: { id: 'task-1' }, request: { body: { body: {}, author: 'han' } } }), mock: mockAddComment },
      { name: 'comment request body array', invoke: ctrl.addComment, context: ctx({ query: { board: 'default' }, params: { id: 'task-1' }, request: { body: [] } }), mock: mockAddComment },
      { name: 'comment author object', invoke: ctrl.addComment, context: ctx({ query: { board: 'default' }, params: { id: 'task-1' }, request: { body: { body: 'ok', author: {} } } }), mock: mockAddComment },
      { name: 'link missing child', invoke: ctrl.linkTasks, context: ctx({ query: { board: 'default' }, request: { body: { parent_id: 'task-1' } } }), mock: mockLinkTasks },
      { name: 'unlink missing parent', invoke: ctrl.unlinkTasks, context: ctx({ query: { board: 'default', child_id: 'task-2' } }), mock: mockUnlinkTasks },
      { name: 'bulk empty ids', invoke: ctrl.bulkUpdateTasks, context: ctx({ query: { board: 'default' }, request: { body: { ids: [], status: 'done' } } }), mock: mockBulkUpdateTasks },
      { name: 'bulk invalid status', invoke: ctrl.bulkUpdateTasks, context: ctx({ query: { board: 'default' }, request: { body: { ids: ['task-1'], status: 'invalid' } } }), mock: mockBulkUpdateTasks },
      { name: 'bulk archive with status', invoke: ctrl.bulkUpdateTasks, context: ctx({ query: { board: 'default' }, request: { body: { ids: ['task-1'], archive: true, status: 'done' } } }), mock: mockBulkUpdateTasks },
      { name: 'bulk no action', invoke: ctrl.bulkUpdateTasks, context: ctx({ query: { board: 'default' }, request: { body: { ids: ['task-1'] } } }), mock: mockBulkUpdateTasks },
      { name: 'reclaim request body string', invoke: ctrl.reclaim, context: ctx({ query: { board: 'default' }, params: { id: 'task-1' }, request: { body: 'bad' } }), mock: mockReclaimTask },
      { name: 'reclaim reason array', invoke: ctrl.reclaim, context: ctx({ query: { board: 'default' }, params: { id: 'task-1' }, request: { body: { reason: [] } } }), mock: mockReclaimTask },
      { name: 'reassign reclaim string', invoke: ctrl.reassign, context: ctx({ query: { board: 'default' }, params: { id: 'task-1' }, request: { body: { profile: 'bob', reclaim: 'false' } } }), mock: mockReassignTask },
      { name: 'reassign reclaim number', invoke: ctrl.reassign, context: ctx({ query: { board: 'default' }, params: { id: 'task-1' }, request: { body: { profile: 'bob', reclaim: 1 } } }), mock: mockReassignTask },
      { name: 'reassign profile number', invoke: ctrl.reassign, context: ctx({ query: { board: 'default' }, params: { id: 'task-1' }, request: { body: { profile: 123 } } }), mock: mockReassignTask },
      { name: 'specify request body number', invoke: ctrl.specify, context: ctx({ query: { board: 'default' }, params: { id: 'task-1' }, request: { body: 123 } }), mock: mockSpecifyTask },
      { name: 'specify author object', invoke: ctrl.specify, context: ctx({ query: { board: 'default' }, params: { id: 'task-1' }, request: { body: { author: {} } } }), mock: mockSpecifyTask },
      { name: 'dispatch request body array', invoke: ctrl.dispatch, context: ctx({ query: { board: 'default' }, request: { body: [] } }), mock: mockDispatch },
    ]

    for (const testCase of cases) {
      vi.clearAllMocks()
      await testCase.invoke(testCase.context)
      expect(testCase.context.status, testCase.name).toBe(400)
      expect(testCase.mock, testCase.name).not.toHaveBeenCalled()
    }
  })

  it('proxies recovery and dispatch actions with explicit board context', async () => {
    mockReclaimTask.mockResolvedValue({ ok: true, output: 'reclaimed' })
    mockReassignTask.mockResolvedValue({ ok: true, output: 'reassigned' })
    mockSpecifyTask.mockResolvedValue([{ task_id: 'task-1' }])
    mockDispatch.mockResolvedValue({ spawned: 1 })

    const reclaimCtx = ctx({ query: { board: 'project-a' }, params: { id: 'task-1' }, request: { body: { reason: 'stale' } } })
    await ctrl.reclaim(reclaimCtx)
    expect(mockReclaimTask).toHaveBeenCalledWith('task-1', { board: 'project-a', reason: 'stale' })

    const reassignCtx = ctx({ query: { board: 'project-a' }, params: { id: 'task-1' }, request: { body: { profile: 'bob', reclaim: true, reason: 'handoff' } } })
    await ctrl.reassign(reassignCtx)
    expect(mockReassignTask).toHaveBeenCalledWith('task-1', 'bob', { board: 'project-a', reclaim: true, reason: 'handoff' })

    const specifyCtx = ctx({ query: { board: 'default' }, params: { id: 'task-1' }, request: { body: { author: 'han' } } })
    await ctrl.specify(specifyCtx)
    expect(mockSpecifyTask).toHaveBeenCalledWith('task-1', { board: 'default', author: 'han' })
    expect(specifyCtx.body).toEqual({ results: [{ task_id: 'task-1' }] })

    const dispatchCtx = ctx({ query: { board: 'default' }, request: { body: { dryRun: true, max: 2, failureLimit: 3 } } })
    await ctrl.dispatch(dispatchCtx)
    expect(mockDispatch).toHaveBeenCalledWith({ board: 'default', dryRun: true, max: 2, failureLimit: 3 })
    expect(dispatchCtx.body).toEqual({ result: { spawned: 1 } })
  })

  it('enriches completed task details using the latest run profile', async () => {
    mockGetTask.mockResolvedValue({
      task: { id: 'task-1', status: 'done' },
      runs: [{ profile: 'stale' }, { profile: 'fresh' }],
      comments: [],
      events: [],
    })
    mockFindLatestExactSessionId.mockResolvedValue('session-1')
    mockGetExactSessionDetail.mockResolvedValue({
      title: 'Session one',
      source: 'codex',
      model: 'gpt-5.5',
      started_at: 1,
      ended_at: 2,
      messages: [],
    })

    const c = ctx({ params: { id: 'task-1' }, query: { board: 'project-a' } })
    await ctrl.get(c)

    expect(mockFindLatestExactSessionId).toHaveBeenCalledWith('task-1', 'fresh')
    expect(mockGetExactSessionDetail).toHaveBeenCalledWith('session-1', 'fresh')
    expect(c.body.session).toMatchObject({ id: 'session-1', title: 'Session one' })
  })

  it('enriches archived task details using the latest run profile', async () => {
    mockGetTask.mockResolvedValue({
      task: { id: 'task-archived', status: 'archived' },
      runs: [{ profile: 'reviewer' }],
      comments: [],
      events: [],
    })
    mockFindLatestExactSessionId.mockResolvedValue('session-archived')
    mockGetExactSessionDetail.mockResolvedValue({
      title: 'Archived session',
      source: 'codex',
      model: 'gpt-5.5',
      started_at: 1,
      ended_at: 2,
      messages: [],
    })

    const c = ctx({ params: { id: 'task-archived' }, query: { board: 'project-a' } })
    await ctrl.get(c)

    expect(mockFindLatestExactSessionId).toHaveBeenCalledWith('task-archived', 'reviewer')
    expect(mockGetExactSessionDetail).toHaveBeenCalledWith('session-archived', 'reviewer')
    expect(c.body.session).toMatchObject({ id: 'session-archived', title: 'Archived session' })
  })

  it('prefers exact kanban-task session matches over later sessions that merely reference the task id', async () => {
    mockGetTask.mockResolvedValue({
      task: { id: 't_348bfaaf', status: 'done' },
      runs: [{ profile: 'default' }],
      comments: [],
      events: [],
    })
    mockFindLatestExactSessionId.mockResolvedValue('session_20260508_110903_58e664')
    mockGetExactSessionDetail.mockResolvedValue({
      title: 'work kanban task t_348bfaaf',
      source: 'codex',
      model: 'gpt-5.5',
      started_at: 1,
      ended_at: 2,
      messages: [{ id: 'm1', role: 'user', content: 'work kanban task t_348bfaaf', timestamp: 1 }],
    })

    const c = ctx({ params: { id: 't_348bfaaf' }, query: { board: 'project-a' } })
    await ctrl.get(c)

    expect(c.body.session).toMatchObject({
      id: 'session_20260508_110903_58e664',
      title: 'work kanban task t_348bfaaf',
    })
    expect(c.body.session.messages[0].content).toBe('work kanban task t_348bfaaf')
  })

  it('validates create/search/readArtifact requests', async () => {
    const createCtx = ctx({ request: { body: {} } })
    await ctrl.create(createCtx)
    expect(createCtx.status).toBe(400)
    expect(mockCreateTask).not.toHaveBeenCalled()

    const invalidCompleteCtx = ctx({ request: { body: { task_ids: ['task-1', 123] } } })
    await ctrl.complete(invalidCompleteCtx)
    expect(invalidCompleteCtx.status).toBe(400)
    expect(mockCompleteTasks).not.toHaveBeenCalled()

    const invalidBlockCtx = ctx({ params: { id: 'task-1' }, request: { body: { reason: [] } } })
    await ctrl.block(invalidBlockCtx)
    expect(invalidBlockCtx.status).toBe(400)
    expect(mockBlockTask).not.toHaveBeenCalled()

    const invalidUnblockCtx = ctx({ request: { body: [] } })
    await ctrl.unblock(invalidUnblockCtx)
    expect(invalidUnblockCtx.status).toBe(400)
    expect(mockUnblockTasks).not.toHaveBeenCalled()

    const invalidAssignCtx = ctx({ params: { id: 'task-1' }, request: { body: { profile: 123 } } })
    await ctrl.assign(invalidAssignCtx)
    expect(invalidAssignCtx.status).toBe(400)
    expect(mockAssignTask).not.toHaveBeenCalled()

    const searchCtx = ctx({ query: { task_id: 'task-1' } })
    await ctrl.searchSessions(searchCtx)
    expect(searchCtx.status).toBe(400)

    const fileCtx = ctx({ query: { path: '/tmp/outside.txt' } })
    await ctrl.readArtifact(fileCtx)
    expect(fileCtx.status).toBe(400)
  })

  it('reads workspace artifacts and proxies action routes', async () => {
    mockReadFile.mockResolvedValue('artifact-content')
    mockCreateTask.mockResolvedValue({ id: 'task-2' })
    mockCompleteTasks.mockResolvedValue(undefined)
    mockBlockTask.mockResolvedValue(undefined)
    mockUnblockTasks.mockResolvedValue(undefined)
    mockAssignTask.mockResolvedValue(undefined)
    mockGetStats.mockResolvedValue({ total: 1, by_status: {}, by_assignee: {} })
    mockGetAssignees.mockResolvedValue([{ name: 'alice' }])
    mockSearchSessions.mockResolvedValue([{ id: 'session-2' }])
    mockFindLatestExactSessionId.mockResolvedValue('session-2')
    mockGetExactSessionDetail.mockResolvedValue({
      id: 'session-2',
      source: 'codex',
      title: 'Matched session',
      preview: 'task-id matched',
      model: 'gpt-5.5',
      started_at: 100,
      ended_at: 101,
      last_active: 101,
      message_count: 2,
      tool_call_count: 0,
      input_tokens: 1,
      output_tokens: 1,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: null,
      estimated_cost_usd: 0,
      actual_cost_usd: null,
      cost_status: '',
      messages: [],
      thread_session_count: 1,
    })

    mockGetTask.mockResolvedValueOnce({
      task: {
        id: 'task-1',
        assignee: null,
        workspace_path: '/Users/tester/.hermes/kanban/workspaces/task',
      },
      comments: [],
      events: [],
      runs: [],
    })
    const fileCtx = ctx({ query: { path: '/Users/tester/.hermes/kanban/workspaces/task/out.txt', task_id: 'task-1' } })
    await ctrl.readArtifact(fileCtx)
    expect(fileCtx.body).toEqual({
      content: 'artifact-content',
      path: '/Users/tester/.hermes/kanban/workspaces/task/out.txt',
    })

    const createCtx = ctx({
      query: { board: 'project-a' },
      request: {
        body: {
          title: 'Ship',
          body: 'x',
          workspace: 'worktree:/repo',
          branch: 'kanban-ui',
          triage: true,
          skills: ['planner', ' reviewer ', ''],
          maxRuntime: '2h',
          maxRetries: 3,
          goalMode: true,
          goalMaxTurns: 12,
        },
      },
    })
    await ctrl.create(createCtx)
    expect(mockCreateTask).toHaveBeenCalledWith('Ship', {
      board: 'project-a',
      body: 'x',
      assignee: undefined,
      priority: undefined,
      tenant: undefined,
      workspace: 'worktree:/repo',
      branch: 'kanban-ui',
      triage: true,
      skills: ['planner', 'reviewer'],
      maxRuntime: '2h',
      maxRetries: 3,
      goalMode: true,
      goalMaxTurns: 12,
    })
    expect(createCtx.body).toEqual({ task: { id: 'task-2' } })

    const completeCtx = ctx({ query: { board: 'project-a' }, request: { body: { task_ids: ['task-1'], summary: 'done' } } })
    await ctrl.complete(completeCtx)
    expect(mockCompleteTasks).toHaveBeenCalledWith(['task-1'], 'done', { board: 'project-a', operatorOverride: true })

    const blockCtx = ctx({ query: { board: 'project-a' }, params: { id: 'task-1' }, request: { body: { reason: 'wait' } } })
    await ctrl.block(blockCtx)
    expect(mockBlockTask).toHaveBeenCalledWith('task-1', 'wait', { board: 'project-a' })

    mockGetTask.mockResolvedValueOnce({
      task: { id: 'task-1', assignee: null, status: 'blocked' },
      comments: [],
      events: [],
      runs: [],
    })
    const unblockCtx = ctx({ query: { board: 'project-a' }, request: { body: { task_ids: ['task-1'] } } })
    await ctrl.unblock(unblockCtx)
    expect(mockUnblockTasks).toHaveBeenCalledWith(['task-1'], { board: 'project-a' })

    const assignCtx = ctx({ query: { board: 'project-a' }, params: { id: 'task-1' }, request: { body: { profile: 'alice' } } })
    await ctrl.assign(assignCtx)
    expect(mockAssignTask).toHaveBeenCalledWith('task-1', 'alice', { board: 'project-a' })

    const statsCtx = ctx({ query: { board: 'project-a' } })
    await ctrl.stats(statsCtx)
    expect(mockGetStats).toHaveBeenCalledWith({ board: 'project-a' })
    expect(statsCtx.body).toEqual({ stats: { total: 1, by_status: {}, by_assignee: {} } })

    const assigneesCtx = ctx({ query: { board: 'project-a' } })
    await ctrl.assignees(assigneesCtx)
    expect(mockGetAssignees).toHaveBeenCalledWith({ board: 'project-a' })
    expect(assigneesCtx.body).toEqual({ assignees: [{ name: 'alice' }] })

    const searchCtx = ctx({ query: { task_id: 'task-1', profile: 'alice', q: 'custom' } })
    await ctrl.searchSessions(searchCtx)
    expect(mockSearchSessions).toHaveBeenCalledWith('custom', 'alice', undefined, 10)

    const exactSearchCtx = ctx({ query: { task_id: 'task-1', profile: 'alice' } })
    await ctrl.searchSessions(exactSearchCtx)
    expect(exactSearchCtx.body.results[0]).toMatchObject({ id: 'session-2', title: 'Matched session' })
  })

  it('rejects invalid transitions before invoking mutating CLI commands', async () => {
    mockGetTask.mockResolvedValue({
      task: { id: 'task-1', assignee: null, status: 'todo' },
      comments: [],
      events: [],
      runs: [],
    })

    const blockCtx = ctx({
      params: { id: 'task-1' },
      request: { body: { reason: 'wait' } },
    })
    await ctrl.block(blockCtx)

    expect(blockCtx.status).toBe(409)
    expect(blockCtx.body).toEqual({ error: 'Cannot block task "task-1" from status "todo"' })
    expect(mockBlockTask).not.toHaveBeenCalled()
  })
})
