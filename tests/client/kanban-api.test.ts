// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockRequest = vi.hoisted(() => vi.fn())
const mockGetApiKey = vi.hoisted(() => vi.fn(() => ''))
const mockGetBaseUrlValue = vi.hoisted(() => vi.fn(() => ''))

vi.mock('../../packages/client/src/api/client', () => ({
  request: mockRequest,
  getApiKey: mockGetApiKey,
  getBaseUrlValue: mockGetBaseUrlValue,
}))

import {
  listBoards,
  createBoard,
  archiveBoard,
  getCapabilities,
  getApprovalCapabilities,
  performApprovalAction,
  listTasks,
  getTask,
  listAttachments,
  getAttachmentContentPath,
  createTask,
  completeTasks,
  blockTask,
  unblockTasks,
  assignTask,
  addComment,
  linkTasks,
  unlinkTasks,
  bulkUpdateTasks,
  getTaskLog,
  getDiagnostics,
  reclaimTask,
  reassignTask,
  specifyTask,
  dispatch,
  getStats,
  getAssignees,
  buildKanbanEventsWebSocketUrl,
} from '../../packages/client/src/api/hermes/kanban'

describe('Kanban API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    mockGetApiKey.mockReturnValue('')
    mockGetBaseUrlValue.mockReturnValue('')
  })

  it('builds board-scoped kanban event websocket URLs with auth token', () => {
    mockGetBaseUrlValue.mockReturnValue('https://wui.example.test')
    mockGetApiKey.mockReturnValue('token value')
    localStorage.setItem('hermes_active_profile_name', 'research')

    expect(buildKanbanEventsWebSocketUrl({ board: 'project-a' })).toBe('wss://wui.example.test/api/hermes/kanban/events?board=project-a&token=token+value&profile=research')
    expect(buildKanbanEventsWebSocketUrl()).toBe('wss://wui.example.test/api/hermes/kanban/events?board=default&token=token+value&profile=research')
  })

  it('serializes board, list filters, and archived inclusion into query params', async () => {
    mockRequest.mockResolvedValue({ tasks: [{ id: 'task-1' }] })

    const result = await listTasks({ board: 'default', status: 'blocked', assignee: 'alice', tenant: 'ops', includeArchived: true })

    expect(mockRequest).toHaveBeenCalledWith('/api/hermes/kanban?board=default&status=blocked&assignee=alice&tenant=ops&includeArchived=true')
    expect(result).toEqual([{ id: 'task-1' }])
  })

  it('keeps default board explicit when no board is supplied', async () => {
    mockRequest
      .mockResolvedValueOnce({ tasks: [] })
      .mockResolvedValueOnce({ stats: { total: 0, by_status: {}, by_assignee: {} } })
      .mockResolvedValueOnce({ assignees: [] })
      .mockResolvedValueOnce({ task: { id: 'task-1' }, comments: [], events: [], runs: [] })

    await listTasks()
    await getStats()
    await getAssignees()
    await getTask('task-1')

    expect(mockRequest.mock.calls.map(call => call[0])).toEqual([
      '/api/hermes/kanban?board=default',
      '/api/hermes/kanban/stats?board=default',
      '/api/hermes/kanban/assignees?board=default',
      '/api/hermes/kanban/task-1?board=default',
    ])
  })

  it('posts create and action payloads with explicit board in the URL', async () => {
    mockRequest
      .mockResolvedValueOnce({ task: { id: 'task-1' } })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })

    expect(await createTask({ title: 'Ship', assignee: 'alice', priority: 3 }, { board: 'project-a' })).toEqual({ id: 'task-1' })
    await completeTasks(['task-1'], 'done', { board: 'project-a' })
    await blockTask('task-1', 'waiting', { board: 'project-a' })
    await unblockTasks(['task-1'], { board: 'project-a' })
    await assignTask('task-1', 'bob', { board: 'project-a' })

    expect(mockRequest.mock.calls).toEqual([
      ['/api/hermes/kanban?board=project-a', { method: 'POST', body: JSON.stringify({ title: 'Ship', assignee: 'alice', priority: 3 }) }],
      ['/api/hermes/kanban/complete?board=project-a', { method: 'POST', body: JSON.stringify({ task_ids: ['task-1'], summary: 'done' }) }],
      ['/api/hermes/kanban/task-1/block?board=project-a', { method: 'POST', body: JSON.stringify({ reason: 'waiting' }) }],
      ['/api/hermes/kanban/unblock?board=project-a', { method: 'POST', body: JSON.stringify({ task_ids: ['task-1'] }) }],
      ['/api/hermes/kanban/task-1/assign?board=project-a', { method: 'POST', body: JSON.stringify({ profile: 'bob' }) }],
    ])
  })

  it('uses dedicated approval endpoints and keeps decision reasons out of the URL', async () => {
    const approval = { can_approve: true, allowed_boards: ['codex-tech'], dingtalk_configured: true }
    const result = { receipt: { event_id: 'evt-1', after_status: 'done' } }
    mockRequest.mockResolvedValueOnce({ approval }).mockResolvedValueOnce(result)

    await expect(getApprovalCapabilities()).resolves.toEqual(approval)
    await expect(performApprovalAction('task 1', 'request_changes', {
      reason: 'missing rollback test',
      event_id: 'evt-1',
    }, { board: 'codex-tech' })).resolves.toEqual(result)

    expect(mockRequest.mock.calls).toEqual([
      ['/api/hermes/kanban/approval/capabilities'],
      ['/api/hermes/kanban/task%201/request-changes?board=codex-tech', {
        method: 'POST',
        body: JSON.stringify({ reason: 'missing rollback test', event_id: 'evt-1' }),
      }],
    ])
  })

  it('lists attachments and builds their authenticated content path', async () => {
    mockRequest.mockResolvedValueOnce({
      attachments: [{ id: 7, filename: 'report.html', size: 42 }],
    })

    await expect(listAttachments('task 1', { board: 'project-a' })).resolves.toEqual([
      { id: 7, filename: 'report.html', size: 42 },
    ])
    expect(mockRequest).toHaveBeenCalledWith('/api/hermes/kanban/task%201/attachments?board=project-a')
    expect(getAttachmentContentPath('task 1', 7, { board: 'project-a' })).toBe(
      '/api/hermes/kanban/task%201/attachments/7?board=project-a',
    )
  })

  it('lists and manages boards through explicit board endpoints', async () => {
    mockRequest
      .mockResolvedValueOnce({ boards: [{ slug: 'default' }] })
      .mockResolvedValueOnce({ board: { slug: 'project-a' } })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ capabilities: { source: 'hermes-cli', supports: { boardsList: true }, missing: [] } })
      .mockResolvedValueOnce({ stats: { total: 3, by_status: {}, by_assignee: {} } })
      .mockResolvedValueOnce({ assignees: [{ name: 'alice', on_disk: true, counts: { todo: 1 } }] })

    await expect(listBoards({ includeArchived: true })).resolves.toEqual([{ slug: 'default' }])
    await expect(createBoard({ slug: 'project-a', name: 'Project A' })).resolves.toEqual({ slug: 'project-a' })
    await expect(archiveBoard('project-a')).resolves.toEqual({ ok: true })
    await expect(getCapabilities()).resolves.toEqual({ source: 'hermes-cli', supports: { boardsList: true }, missing: [] })
    await expect(getStats({ board: 'project-a' })).resolves.toEqual({ total: 3, by_status: {}, by_assignee: {} })
    await expect(getAssignees({ board: 'project-a' })).resolves.toEqual([{ name: 'alice', on_disk: true, counts: { todo: 1 } }])

    expect(mockRequest.mock.calls).toEqual([
      ['/api/hermes/kanban/boards?includeArchived=true'],
      ['/api/hermes/kanban/boards', { method: 'POST', body: JSON.stringify({ slug: 'project-a', name: 'Project A' }) }],
      ['/api/hermes/kanban/boards/project-a', { method: 'DELETE' }],
      ['/api/hermes/kanban/capabilities'],
      ['/api/hermes/kanban/stats?board=project-a'],
      ['/api/hermes/kanban/assignees?board=project-a'],
    ])
  })

  it('calls parity-gap APIs with explicit board query params', async () => {
    mockRequest
      .mockResolvedValueOnce({ ok: true, output: 'commented' })
      .mockResolvedValueOnce({ ok: true, output: 'linked' })
      .mockResolvedValueOnce({ ok: true, output: 'unlinked' })
      .mockResolvedValueOnce({ results: [{ id: 'task-1', ok: true }] })
      .mockResolvedValueOnce({ task_id: 'task-1', path: null, exists: true, size_bytes: 10, content: 'worker log', truncated: false })
      .mockResolvedValueOnce({ diagnostics: [{ task_id: 'task-1' }] })
      .mockResolvedValueOnce({ ok: true, output: 'reclaimed' })
      .mockResolvedValueOnce({ ok: true, output: 'reassigned' })
      .mockResolvedValueOnce({ results: [{ task_id: 'task-1' }] })
      .mockResolvedValueOnce({ result: { spawned: 1 } })

    await addComment('task-1', { body: 'needs review', author: 'han' }, { board: 'default' })
    await linkTasks({ parent_id: 'task-1', child_id: 'task-2' }, { board: 'project-a' })
    await unlinkTasks({ parent_id: 'task-1', child_id: 'task-2' }, { board: 'project-a' })
    await expect(bulkUpdateTasks({ ids: ['task-1'], status: 'done', assignee: null, summary: 'closed' }, { board: 'project-a' })).resolves.toEqual({ results: [{ id: 'task-1', ok: true }] })
    await expect(getTaskLog('task-1', { board: 'default', tail: 4000 })).resolves.toEqual({ task_id: 'task-1', path: null, exists: true, size_bytes: 10, content: 'worker log', truncated: false })
    await expect(getDiagnostics({ board: 'default', task: 'task-1', severity: 'warning' })).resolves.toEqual([{ task_id: 'task-1' }])
    await reclaimTask('task-1', { board: 'project-a', reason: 'stale' })
    await reassignTask('task-1', 'bob', { board: 'project-a', reclaim: true, reason: 'handoff' })
    await expect(specifyTask('task-1', { board: 'default', author: 'han' })).resolves.toEqual([{ task_id: 'task-1' }])
    await expect(dispatch({ board: 'default', dryRun: true, max: 2, failureLimit: 3 })).resolves.toEqual({ spawned: 1 })

    expect(mockRequest.mock.calls).toEqual([
      ['/api/hermes/kanban/task-1/comments?board=default', { method: 'POST', body: JSON.stringify({ body: 'needs review', author: 'han' }) }],
      ['/api/hermes/kanban/links?board=project-a', { method: 'POST', body: JSON.stringify({ parent_id: 'task-1', child_id: 'task-2' }) }],
      ['/api/hermes/kanban/links?board=project-a&parent_id=task-1&child_id=task-2', { method: 'DELETE' }],
      ['/api/hermes/kanban/tasks/bulk?board=project-a', { method: 'POST', body: JSON.stringify({ ids: ['task-1'], status: 'done', assignee: null, summary: 'closed' }) }],
      ['/api/hermes/kanban/task-1/log?board=default&tail=4000'],
      ['/api/hermes/kanban/diagnostics?board=default&task=task-1&severity=warning'],
      ['/api/hermes/kanban/task-1/reclaim?board=project-a', { method: 'POST', body: JSON.stringify({ reason: 'stale' }) }],
      ['/api/hermes/kanban/task-1/reassign?board=project-a', { method: 'POST', body: JSON.stringify({ profile: 'bob', reclaim: true, reason: 'handoff' }) }],
      ['/api/hermes/kanban/task-1/specify?board=default', { method: 'POST', body: JSON.stringify({ author: 'han' }) }],
      ['/api/hermes/kanban/dispatch?board=default', { method: 'POST', body: JSON.stringify({ dryRun: true, max: 2, failureLimit: 3 }) }],
    ])
  })
})
