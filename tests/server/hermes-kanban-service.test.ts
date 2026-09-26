import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockExecFileAsync = vi.hoisted(() => vi.fn())
const mockSpawnHermes = vi.hoisted(() => vi.fn())
const mockLoggerError = vi.hoisted(() => vi.fn())
const mockApprovalAuditStore = vi.hoisted(() => ({
  get: vi.fn(),
  prepare: vi.fn(),
  complete: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/hermes/services/runtime/process', () => ({
  execHermes: (args: string[], options: unknown) => mockExecFileAsync('hermes', args, options),
  spawnHermes: mockSpawnHermes,
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: {
    error: mockLoggerError,
  },
}))

vi.mock('../../packages/server/src/modules/hermes/services/kanban/approval-audit-store', () => ({
  getKanbanApprovalAuditStore: () => mockApprovalAuditStore,
}))

import * as service from '../../packages/server/src/modules/hermes/services/kanban/kanban-service'

describe('hermes kanban service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const records = new Map<string, any>()
    const key = (board: string, taskId: string, eventId: string) => `${board}:${taskId}:${eventId}`
    mockApprovalAuditStore.get.mockImplementation(async (board: string, taskId: string, eventId: string) => (
      records.get(key(board, taskId, eventId)) || null
    ))
    mockApprovalAuditStore.prepare.mockImplementation(async (record: any) => {
      records.set(key(record.board, record.task_id, record.event_id), record)
      return { record, created: true }
    })
    mockApprovalAuditStore.complete.mockImplementation(async (recordKey: any, patch: any) => {
      const id = key(recordKey.board, recordKey.taskId, recordKey.eventId)
      const record = { ...records.get(id), ...patch, phase: 'completed' }
      records.set(id, record)
      return record
    })
  })

  it('lists boards without mutating or depending on CLI current', async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: JSON.stringify([{ slug: 'default' }]) })

    await expect(service.listBoards({ includeArchived: true })).resolves.toEqual([{ slug: 'default' }])

    expect(mockExecFileAsync.mock.calls[0][1]).toEqual(['kanban', 'boards', 'list', '--json', '--all'])
  })

  it('creates and archives boards through canonical CLI board commands', async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ slug: 'project-a', name: 'Project A' }]) })
      .mockResolvedValueOnce({ stdout: '' })

    await expect(service.createBoard({ slug: 'project-a', name: 'Project A', description: 'desc', icon: '📌', color: '#8b5cf6', switchCurrent: true })).resolves.toEqual({ slug: 'project-a', name: 'Project A' })
    await expect(service.archiveBoard('project-a')).resolves.toBeUndefined()

    expect(mockExecFileAsync.mock.calls[0][1]).toEqual(['kanban', 'boards', 'create', 'project-a', '--name', 'Project A', '--description', 'desc', '--icon', '📌', '--color', '#8b5cf6', '--switch'])
    expect(mockExecFileAsync.mock.calls[1][1]).toEqual(['kanban', 'boards', 'list', '--json', '--all'])
    expect(mockExecFileAsync.mock.calls[2][1]).toEqual(['kanban', 'boards', 'rm', 'project-a'])
  })

  it('exposes capability metadata for WUI/canonical parity gaps', async () => {
    await expect(service.getCapabilities()).resolves.toMatchObject({
      source: 'hermes-cli',
      supports: { boardsList: true, boardCreate: true, commentsWrite: true, dispatch: true, links: true },
      missing: expect.arrayContaining(['cliCurrentSwitch', 'bulk', 'homeSubscriptions']),
      capabilities: expect.arrayContaining([
        expect.objectContaining({ key: 'commentsWrite', status: 'supported', canonicalCommand: 'comment', requiresBoard: true }),
        expect.objectContaining({ key: 'attachments', status: 'supported', canonicalCommand: 'attachments --json', requiresBoard: true }),
        expect.objectContaining({ key: 'links', status: 'supported', canonicalRoute: '/links', canonicalCommand: 'link/unlink', requiresBoard: true }),
        expect.objectContaining({ key: 'bulk', status: 'partial', canonicalRoute: '/tasks/bulk', requiresBoard: true }),
        expect.objectContaining({ key: 'events', status: 'partial', canonicalRoute: '/events', canonicalCommand: 'watch', requiresBoard: true }),
      ]),
    })
  })

  it('builds board-scoped watch args for the kanban event bridge', () => {
    expect(service.buildWatchArgs({ board: 'Project_A', interval: 0.25 })).toEqual(['kanban', '--board', 'project_a', 'watch', '--interval', '0.25'])
    expect(service.buildWatchArgs()).toEqual(['kanban', '--board', 'default', 'watch', '--interval', '0.5'])
  })

  it('builds link/unlink and bulk-equivalent task commands with explicit board', async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: 'linked\n' })
      .mockResolvedValueOnce({ stdout: 'unlinked\n' })
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: '' })
      .mockRejectedValueOnce(new Error('cannot complete task-2'))

    await expect(service.linkTasks('task-1', 'task-2', { board: 'project-a' })).resolves.toEqual({ ok: true, output: 'linked\n' })
    await expect(service.unlinkTasks('task-1', 'task-2', { board: 'project-a' })).resolves.toEqual({ ok: true, output: 'unlinked\n' })
    await expect(service.bulkUpdateTasks({ board: 'project-a', ids: ['task-1', 'task-2'], status: 'done', assignee: 'alice', summary: 'closed' })).resolves.toEqual({
      results: [
        { id: 'task-1', ok: true },
        { id: 'task-2', ok: false, error: 'Failed to complete kanban tasks: cannot complete task-2' },
      ],
    })

    expect(mockExecFileAsync.mock.calls[0][1]).toEqual(['kanban', '--board', 'project-a', 'link', 'task-1', 'task-2'])
    expect(mockExecFileAsync.mock.calls[1][1]).toEqual(['kanban', '--board', 'project-a', 'unlink', 'task-1', 'task-2'])
    expect(mockExecFileAsync.mock.calls[2][1]).toEqual(['kanban', '--board', 'project-a', 'complete', 'task-1', '--summary', 'closed'])
    expect(mockExecFileAsync.mock.calls[3][1]).toEqual(['kanban', '--board', 'project-a', 'assign', 'task-1', 'alice'])
    expect(mockExecFileAsync.mock.calls[4][1]).toEqual(['kanban', '--board', 'project-a', 'complete', 'task-2', '--summary', 'closed'])
  })

  it('treats zero-exit stderr from mutation CLI calls as failures', async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: '', stderr: 'kanban: unknown task(s): missing-a, missing-b\n' })
      .mockResolvedValueOnce({ stdout: '', stderr: 'No such link: missing-a -> missing-b\n' })
      .mockResolvedValueOnce({ stdout: '', stderr: 'kanban: unknown task(s): task-1\n' })
      .mockResolvedValueOnce({ stdout: '', stderr: 'kanban: unknown task(s): task-2\n' })

    await expect(service.linkTasks('missing-a', 'missing-b', { board: 'project-a' })).rejects.toThrow('Failed to link kanban tasks: kanban: unknown task(s): missing-a, missing-b')
    await expect(service.unlinkTasks('missing-a', 'missing-b', { board: 'project-a' })).rejects.toThrow('Failed to unlink kanban tasks: No such link: missing-a -> missing-b')
    await expect(service.bulkUpdateTasks({ board: 'project-a', ids: ['task-1', 'task-2'], status: 'done' })).resolves.toEqual({
      results: [
        { id: 'task-1', ok: false, error: 'Failed to complete kanban tasks: kanban: unknown task(s): task-1' },
        { id: 'task-2', ok: false, error: 'Failed to complete kanban tasks: kanban: unknown task(s): task-2' },
      ],
    })
  })

  it('returns per-task bulk errors for unsupported direct status patches before shelling out', async () => {
    await expect(service.bulkUpdateTasks({ board: 'project-a', ids: ['task-1'], status: 'running' })).resolves.toEqual({
      results: [{ id: 'task-1', ok: false, error: 'Bulk status running is not supported by the CLI bridge' }],
    })
    expect(mockExecFileAsync).not.toHaveBeenCalled()
  })

  it('builds comment/log/diagnostics commands with explicit board', async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: 'comment added\n' })
      .mockResolvedValueOnce({ stdout: 'worker log\n' })
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ task_id: 'task-1', severity: 'warning' }]) })

    await expect(service.addComment('task-1', '--not-an-option', { board: 'default', author: 'han' })).resolves.toEqual({ ok: true, output: 'comment added\n' })
    await expect(service.getTaskLog('task-1', { board: 'default', tail: 4000 })).resolves.toEqual({ task_id: 'task-1', path: null, exists: true, size_bytes: 11, content: 'worker log\n', truncated: false })
    await expect(service.getDiagnostics({ board: 'default', task: 'task-1', severity: 'warning' })).resolves.toEqual([{ task_id: 'task-1', severity: 'warning' }])

    expect(mockExecFileAsync.mock.calls[0][1]).toEqual(['kanban', '--board', 'default', 'comment', 'task-1', '--not-an-option', '--author', 'han'])
    expect(mockExecFileAsync.mock.calls[1][1]).toEqual(['kanban', '--board', 'default', 'log', 'task-1', '--tail', '4000'])
    expect(mockExecFileAsync.mock.calls[2][1]).toEqual(['kanban', '--board', 'default', 'diagnostics', '--json', '--task', 'task-1', '--severity', 'warning'])
  })

  it('maps no-log task logs to canonical empty-log shape', async () => {
    mockExecFileAsync
      .mockRejectedValueOnce({ code: 1, stderr: '(no log for task-1 — task may not have spawned yet)' })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ task: { id: 'task-1' }, runs: [], comments: [], events: [] }) })

    await expect(service.getTaskLog('task-1', { board: 'default' })).resolves.toEqual({
      task_id: 'task-1',
      path: null,
      exists: false,
      size_bytes: 0,
      content: '',
      truncated: false,
    })

    expect(mockExecFileAsync.mock.calls[0][1]).toEqual(['kanban', '--board', 'default', 'log', 'task-1'])
    expect(mockExecFileAsync.mock.calls[1][1]).toEqual(['kanban', '--board', 'default', 'show', 'task-1', '--json'])
  })

  it('builds recovery and dispatch commands with explicit board', async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: 'reclaimed\n' })
      .mockResolvedValueOnce({ stdout: 'reassigned\n' })
      .mockResolvedValueOnce({ stdout: '{"task_id":"task-1","created":true}\n' })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ spawned: 1 }) })

    await expect(service.reclaimTask('task-1', { board: 'project-a', reason: 'stale lock' })).resolves.toEqual({ ok: true, output: 'reclaimed\n' })
    await expect(service.reassignTask('task-1', 'bob', { board: 'project-a', reclaim: true, reason: 'handoff' })).resolves.toEqual({ ok: true, output: 'reassigned\n' })
    await expect(service.specifyTask('task-1', { board: 'project-a', author: 'han' })).resolves.toEqual([{ task_id: 'task-1', created: true }])
    await expect(service.dispatch({ board: 'project-a', dryRun: true, max: 2, failureLimit: 3 })).resolves.toEqual({ spawned: 1 })

    expect(mockExecFileAsync.mock.calls[0][1]).toEqual(['kanban', '--board', 'project-a', 'reclaim', 'task-1', '--reason', 'stale lock'])
    expect(mockExecFileAsync.mock.calls[1][1]).toEqual(['kanban', '--board', 'project-a', 'reassign', 'task-1', 'bob', '--reclaim', '--reason', 'handoff'])
    expect(mockExecFileAsync.mock.calls[2][1]).toEqual(['kanban', '--board', 'project-a', 'specify', 'task-1', '--json', '--author', 'han'])
    expect(mockExecFileAsync.mock.calls[3][1]).toEqual(['kanban', '--board', 'project-a', 'dispatch', '--json', '--dry-run', '--max', '2', '--failure-limit', '3'])
  })

  it('builds list/create/stats CLI calls with global --board before the action', async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ id: 'task-1' }]) })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ id: 'task-2' }) })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ id: 'task-3' }) })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ by_status: { ready: 1 }, by_assignee: { alice: { ready: 1 } } }) })
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ id: 'archived-1', status: 'archived', assignee: null }, { id: 'archived-2', status: 'archived', assignee: null }]) })

    await expect(service.listTasks({ board: 'project-a', status: 'todo', assignee: 'alice', tenant: 'ops', includeArchived: true })).resolves.toEqual([{ id: 'task-1' }])
    await expect(service.createTask('Ship', { board: 'project-a', body: 'write', assignee: 'alice', priority: 3, tenant: 'ops' })).resolves.toEqual({ id: 'task-2' })
    await expect(service.createTask('Plan', {
      board: 'project-a',
      workspace: 'worktree:/repo',
      branch: 'kanban-ui',
      triage: true,
      skills: ['planner', ' reviewer '],
      maxRuntime: '2h',
      maxRetries: 3,
      goalMode: true,
      goalMaxTurns: 12,
    })).resolves.toEqual({ id: 'task-3' })
    await expect(service.getStats({ board: 'project-a' })).resolves.toEqual({
      total: 3,
      by_status: { ready: 1, archived: 2 },
      by_assignee: { alice: 1, default: 2 },
    })

    expect(mockExecFileAsync.mock.calls[0][1]).toEqual(['kanban', '--board', 'project-a', 'list', '--json', '--archived', '--status', 'todo', '--assignee', 'alice', '--tenant', 'ops'])
    expect(mockExecFileAsync.mock.calls[1][1]).toEqual(['kanban', '--board', 'project-a', 'create', 'Ship', '--json', '--body', 'write', '--assignee', 'alice', '--priority', '3', '--tenant', 'ops'])
    expect(mockExecFileAsync.mock.calls[2][1]).toEqual(['kanban', '--board', 'project-a', 'create', 'Plan', '--json', '--workspace', 'worktree:/repo', '--branch', 'kanban-ui', '--triage', '--max-runtime', '2h', '--max-retries', '3', '--goal', '--goal-max-turns', '12', '--skill', 'planner', '--skill', 'reviewer'])
    expect(mockExecFileAsync.mock.calls[3][1]).toEqual(['kanban', '--board', 'project-a', 'stats', '--json'])
    expect(mockExecFileAsync.mock.calls[4][1]).toEqual(['kanban', '--board', 'project-a', 'list', '--json', '--archived', '--status', 'archived'])
  })

  it('normalizes omitted board to default instead of falling through to CLI current', async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ total: 0, by_status: {}, by_assignee: {} }) })
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })

    await service.listTasks()
    await service.getStats()

    expect(mockExecFileAsync.mock.calls[0][1]).toEqual(['kanban', '--board', 'default', 'list', '--json'])
    expect(mockExecFileAsync.mock.calls[1][1]).toEqual(['kanban', '--board', 'default', 'stats', '--json'])
    expect(mockExecFileAsync.mock.calls[2][1]).toEqual(['kanban', '--board', 'default', 'list', '--json', '--archived', '--status', 'archived'])
  })

  it('builds action CLI calls and maps not-found show to null', async () => {
    mockExecFileAsync
      .mockRejectedValueOnce({ code: 1 })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ name: 'alice' }]) })

    await expect(service.getTask('missing', { board: 'default' })).resolves.toBeNull()
    await service.completeTasks(['task-1'], 'done', { board: 'default' })
    await service.blockTask('task-1', 'wait', { board: 'default' })
    await service.unblockTasks(['task-1'], { board: 'default' })
    await service.assignTask('task-1', 'alice', { board: 'default' })
    await expect(service.getAssignees({ board: 'default' })).resolves.toEqual([{ name: 'alice' }])

    expect(mockExecFileAsync.mock.calls[0][1]).toEqual(['kanban', '--board', 'default', 'show', 'missing', '--json'])
    expect(mockExecFileAsync.mock.calls[1][1]).toEqual(['kanban', '--board', 'default', 'complete', 'task-1', '--summary', 'done'])
    expect(mockExecFileAsync.mock.calls[2][1]).toEqual(['kanban', '--board', 'default', 'block', 'task-1', 'wait'])
    expect(mockExecFileAsync.mock.calls[3][1]).toEqual(['kanban', '--board', 'default', 'unblock', 'task-1'])
    expect(mockExecFileAsync.mock.calls[4][1]).toEqual(['kanban', '--board', 'default', 'assign', 'task-1', 'alice'])
    expect(mockExecFileAsync.mock.calls[5][1]).toEqual(['kanban', '--board', 'default', 'assignees', '--json'])
  })

  it('runs approval-center transitions through canonical CLI commands and verifies readback', async () => {
    const detail = (status: string, events: unknown[] = []) => JSON.stringify({
      task: { id: 'task-1', title: 'Ship', assignee: 'codex-worker', status },
      comments: [],
      events,
      runs: [],
    })
    mockExecFileAsync
      // ready -> running
      .mockResolvedValueOnce({ stdout: detail('ready') })
      .mockResolvedValueOnce({ stdout: 'Claimed task-1\n' })
      .mockResolvedValueOnce({ stdout: detail('running', [{ id: 11, kind: 'claimed', created_at: 101, run_id: 7 }]) })
      .mockResolvedValueOnce({ stdout: '' })
      // running -> review
      .mockResolvedValueOnce({ stdout: detail('running') })
      .mockResolvedValueOnce({ stdout: 'Requested review for task-1\n' })
      .mockResolvedValueOnce({ stdout: detail('review', [{ id: 12, kind: 'review_requested', created_at: 102, run_id: 7 }]) })
      .mockResolvedValueOnce({ stdout: '' })
      // review -> done
      .mockResolvedValueOnce({ stdout: detail('review') })
      .mockResolvedValueOnce({ stdout: 'Completed task-1\n' })
      .mockResolvedValueOnce({ stdout: detail('done', [{ id: 13, kind: 'completed', created_at: 103, run_id: 8 }]) })
      .mockResolvedValueOnce({ stdout: '' })
      // done -> archived
      .mockResolvedValueOnce({ stdout: detail('done') })
      .mockResolvedValueOnce({ stdout: 'Archived task-1\n' })
      .mockResolvedValueOnce({ stdout: detail('archived', [{ id: 14, kind: 'archived', created_at: 104, run_id: 8 }]) })
      .mockResolvedValueOnce({ stdout: '' })

    const actor = 'james'
    await expect(service.performApprovalAction('task-1', 'claim', { board: 'codex-tech', actor, eventId: 'evt-claim' }))
      .resolves.toMatchObject({ before_status: 'ready', after_status: 'running', event_id: 'evt-claim', canonical_event_id: 11 })
    await expect(service.performApprovalAction('task-1', 'request_review', { board: 'codex-tech', actor, eventId: 'evt-review', reason: 'tests pass' }))
      .resolves.toMatchObject({ before_status: 'running', after_status: 'review', canonical_event_id: 12 })
    await expect(service.performApprovalAction('task-1', 'approve', { board: 'codex-tech', actor, eventId: 'evt-approve', reason: 'approved' }))
      .resolves.toMatchObject({ before_status: 'review', after_status: 'done', canonical_event_id: 13 })
    await expect(service.performApprovalAction('task-1', 'archive', { board: 'codex-tech', actor, eventId: 'evt-archive' }))
      .resolves.toMatchObject({ before_status: 'done', after_status: 'archived', canonical_event_id: 14 })

    expect(mockExecFileAsync.mock.calls[1][1]).toEqual(['kanban', '--board', 'codex-tech', 'claim', 'task-1'])
    expect(mockExecFileAsync.mock.calls[5][1]).toEqual(expect.arrayContaining([
      'kanban', '--board', 'codex-tech', 'request-review', 'task-1', '--summary', 'tests pass', '--metadata',
    ]))
    expect(mockExecFileAsync.mock.calls[9][1]).toEqual(expect.arrayContaining([
      'kanban', '--board', 'codex-tech', 'complete', 'task-1', '--summary', 'approved', '--metadata',
    ]))
    expect(mockExecFileAsync.mock.calls[13][1]).toEqual(['kanban', '--board', 'codex-tech', 'archive', 'task-1'])
    for (const index of [3, 7, 11, 15]) {
      expect(mockExecFileAsync.mock.calls[index][1]).toEqual(expect.arrayContaining([
        'kanban', '--board', 'codex-tech', 'comment', 'task-1', expect.stringContaining('KANBAN_APPROVAL_AUDIT'), '--author', 'studio:james',
      ]))
    }
    expect(mockExecFileAsync.mock.calls[11][1][5]).toContain('"before_status":"review"')
    expect(mockExecFileAsync.mock.calls[11][1][5]).toContain('"after_status":"done"')
    expect(mockExecFileAsync.mock.calls[11][1][5]).toContain('"canonical_event_id":13')
  })

  it('rejects invalid and duplicate approval actions without running a transition', async () => {
    mockExecFileAsync.mockResolvedValueOnce({
      stdout: JSON.stringify({
        task: { id: 'task-1', status: 'review' },
        comments: [{ id: 1, body: '[KANBAN_APPROVAL_AUDIT] {"event_id":"evt-duplicate"}' }],
        events: [],
        runs: [],
      }),
    })

    await expect(service.performApprovalAction('task-1', 'approve', {
      board: 'codex-tech', actor: 'james', eventId: 'evt-duplicate',
    })).resolves.toMatchObject({ duplicate: true, before_status: 'review', after_status: 'review' })
    expect(mockExecFileAsync).toHaveBeenCalledTimes(1)

    mockExecFileAsync.mockResolvedValueOnce({
      stdout: JSON.stringify({ task: { id: 'task-2', status: 'ready' }, comments: [], events: [], runs: [] }),
    })
    await expect(service.performApprovalAction('task-2', 'approve', {
      board: 'codex-tech', actor: 'james', eventId: 'evt-wrong-state',
    })).rejects.toThrow('Cannot approve task "task-2" from status "ready"')
    expect(mockExecFileAsync).toHaveBeenCalledTimes(2)
  })

  it('fails closed before a transition when the durable audit intent cannot be prepared', async () => {
    mockExecFileAsync.mockResolvedValueOnce({
      stdout: JSON.stringify({
        task: { id: 'task-1', status: 'ready' }, comments: [], events: [], runs: [],
      }),
    })
    const auditStore = {
      get: vi.fn().mockResolvedValue(null),
      prepare: vi.fn().mockRejectedValue(new Error('audit disk unavailable')),
      complete: vi.fn(),
    }

    await expect(service.performApprovalAction('task-1', 'claim', {
      board: 'codex-tech', actor: 'james', eventId: 'evt-audit-down', auditStore,
    })).rejects.toThrow('audit disk unavailable')

    expect(mockExecFileAsync).toHaveBeenCalledTimes(1)
  })

  it('recovers an already-transitioned action after durable audit finalization fails', async () => {
    const ready = JSON.stringify({
      task: { id: 'task-1', title: 'Ship', status: 'ready' }, comments: [], events: [], runs: [],
    })
    const running = JSON.stringify({
      task: { id: 'task-1', title: 'Ship', status: 'running', current_run_id: 7 },
      comments: [],
      events: [{ id: 11, kind: 'claimed', created_at: 101, run_id: 7 }],
      runs: [{ id: 7, profile: process.env.HERMES_PROFILE || 'default', metadata: null }],
    })
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: ready })
      .mockResolvedValueOnce({ stdout: 'Claimed task-1\n' })
      .mockResolvedValueOnce({ stdout: running })
      .mockResolvedValueOnce({ stdout: running })
      .mockResolvedValueOnce({ stdout: '' })

    let record: any = null
    const auditStore = {
      get: vi.fn(async () => record),
      prepare: vi.fn(async (next: any) => {
        record = next
        return { record, created: true }
      }),
      complete: vi.fn()
        .mockRejectedValueOnce(new Error('audit finalize interrupted'))
        .mockImplementationOnce(async (_key: unknown, patch: any) => {
          record = { ...record, ...patch, phase: 'completed' }
          return record
        }),
    }

    await expect(service.performApprovalAction('task-1', 'claim', {
      board: 'codex-tech', actor: 'james', eventId: 'evt-recover', auditStore,
    })).rejects.toThrow('audit finalize interrupted')

    await expect(service.performApprovalAction('task-1', 'claim', {
      board: 'codex-tech', actor: 'james', eventId: 'evt-recover', auditStore,
    })).resolves.toMatchObject({
      duplicate: true,
      before_status: 'ready',
      after_status: 'running',
      canonical_event_id: 11,
    })

    const transitionCalls = mockExecFileAsync.mock.calls.filter(call => call[1]?.[3] === 'claim')
    expect(transitionCalls).toHaveLength(1)
    expect(auditStore.complete).toHaveBeenCalledTimes(2)
  })

  it('does not attribute a pre-existing canonical event to a prepared audit intent during recovery', async () => {
    mockExecFileAsync.mockResolvedValueOnce({
      stdout: JSON.stringify({
        task: { id: 'task-1', title: 'Ship', status: 'done', current_run_id: 7 },
        comments: [], runs: [],
        events: [{ id: 11, kind: 'completed', created_at: 100, run_id: 7 }],
      }),
    })
    const prepared = {
      schema: 1 as const,
      phase: 'prepared' as const,
      board: 'codex-tech',
      task_id: 'task-1',
      event_id: 'evt-stale-recovery',
      action: 'approve' as const,
      actor: 'james',
      channel: 'studio' as const,
      reason: null,
      before_status: 'review' as const,
      before_event_ids: ['11'],
      after_status: null,
      canonical_event_id: null,
      run_id: 7,
      timestamp: 101,
      updated_at: 101,
    }
    const auditStore = {
      get: vi.fn().mockResolvedValue(prepared),
      prepare: vi.fn(),
      complete: vi.fn(),
    }

    await expect(service.performApprovalAction('task-1', 'approve', {
      board: 'codex-tech', actor: 'james', eventId: 'evt-stale-recovery', auditStore,
    })).rejects.toThrow('Cannot recover approval event')
    expect(auditStore.complete).not.toHaveBeenCalled()
  })

  it('does not recover a prepared intent from another actor canonical event', async () => {
    mockExecFileAsync.mockResolvedValueOnce({
      stdout: JSON.stringify({
        task: { id: 'task-1', title: 'Ship', status: 'running', current_run_id: 7 },
        comments: [],
        events: [{ id: 11, kind: 'claimed', created_at: 101, run_id: 7 }],
        runs: [{ id: 7, profile: 'other-worker', metadata: null }],
      }),
    })
    const prepared = {
      schema: 1 as const,
      phase: 'prepared' as const,
      board: 'codex-tech',
      task_id: 'task-1',
      event_id: 'evt-wrong-actor',
      action: 'claim' as const,
      actor: 'james',
      channel: 'studio' as const,
      reason: null,
      reviewer: null,
      canonical_profile: 'default',
      before_status: 'ready' as const,
      before_event_ids: [],
      after_status: null,
      canonical_event_id: null,
      run_id: null,
      timestamp: 100,
      updated_at: 100,
    }
    const auditStore = {
      get: vi.fn().mockResolvedValue(prepared),
      prepare: vi.fn(),
      complete: vi.fn(),
    }

    await expect(service.performApprovalAction('task-1', 'claim', {
      board: 'codex-tech', actor: 'james', eventId: 'evt-wrong-actor', auditStore,
    })).rejects.toThrow('without matching canonical identity')
    expect(auditStore.complete).not.toHaveBeenCalled()
  })

  it('does not repeat a completed transition when a later action returned the task to its original status', async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          task: { id: 'task-1', title: 'Ship', status: 'ready', current_run_id: 8 },
          comments: [],
          runs: [{
            id: 7,
            profile: 'worker',
            metadata: { approval: { event_id: 'evt-lost-response', action: 'request_review' } },
          }],
          events: [
            { id: 11, kind: 'review_requested', created_at: 100, run_id: 7 },
            { id: 12, kind: 'changes_requested', created_at: 101, run_id: 8 },
          ],
        }),
      })
      .mockResolvedValueOnce({ stdout: '' })
    const prepared = {
      schema: 1 as const,
      phase: 'prepared' as const,
      board: 'codex-tech',
      task_id: 'task-1',
      event_id: 'evt-lost-response',
      action: 'request_review' as const,
      actor: 'james',
      channel: 'studio' as const,
      reason: null,
      reviewer: null,
      before_status: 'ready' as const,
      before_event_ids: [],
      after_status: null,
      canonical_event_id: null,
      run_id: 7,
      timestamp: 99,
      updated_at: 99,
    }
    const auditStore = {
      get: vi.fn().mockResolvedValue(prepared),
      prepare: vi.fn(),
      complete: vi.fn().mockImplementation(async (_key: unknown, patch: any) => ({
        ...prepared, ...patch, phase: 'completed',
      })),
    }

    await expect(service.performApprovalAction('task-1', 'request_review', {
      board: 'codex-tech', actor: 'james', eventId: 'evt-lost-response', auditStore,
    })).resolves.toMatchObject({ duplicate: true, before_status: 'ready', after_status: 'review', canonical_event_id: 11 })
    expect(mockExecFileAsync.mock.calls.filter(call => call[1]?.[3] === 'request-review')).toHaveLength(0)
  })

  it('retries the canonical audit comment after a completed durable audit without repeating the transition', async () => {
    const ready = JSON.stringify({
      task: { id: 'task-1', title: 'Ship', status: 'ready' }, comments: [], events: [], runs: [],
    })
    const running = JSON.stringify({
      task: { id: 'task-1', title: 'Ship', status: 'running', current_run_id: 7 },
      comments: [],
      events: [{ id: 11, kind: 'claimed', created_at: 101, run_id: 7 }],
      runs: [],
    })
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: ready })
      .mockResolvedValueOnce({ stdout: 'Claimed task-1\n' })
      .mockResolvedValueOnce({ stdout: running })
      .mockRejectedValueOnce(new Error('comment store unavailable'))
      .mockResolvedValueOnce({ stdout: running })
      .mockResolvedValueOnce({ stdout: '' })

    await expect(service.performApprovalAction('task-1', 'claim', {
      board: 'codex-tech', actor: 'james', eventId: 'evt-comment-recover',
    })).rejects.toThrow('Failed to comment on kanban task')

    await expect(service.performApprovalAction('task-1', 'claim', {
      board: 'codex-tech', actor: 'james', eventId: 'evt-comment-recover',
    })).resolves.toMatchObject({ duplicate: true, before_status: 'ready', after_status: 'running' })

    expect(mockExecFileAsync.mock.calls.filter(call => call[1]?.[3] === 'claim')).toHaveLength(1)
    expect(mockExecFileAsync.mock.calls.filter(call => call[1]?.[3] === 'comment')).toHaveLength(2)
  })

  it('serializes concurrent duplicate approval requests for the same task', async () => {
    let status = 'ready'
    let releaseTransition!: () => void
    const transitionGate = new Promise<void>(resolve => { releaseTransition = resolve })
    let transitionStarted!: () => void
    const transitionStartedGate = new Promise<void>(resolve => { transitionStarted = resolve })
    mockExecFileAsync.mockImplementation(async (_command: string, args: string[]) => {
      const operation = args[3]
      if (operation === 'show') {
        return {
          stdout: JSON.stringify({
            task: { id: 'task-1', title: 'Ship', status, current_run_id: status === 'running' ? 7 : null },
            comments: [],
            events: status === 'running' ? [{ id: 11, kind: 'claimed', created_at: 101, run_id: 7 }] : [],
            runs: [],
          }),
        }
      }
      if (operation === 'claim') {
        transitionStarted()
        await transitionGate
        status = 'running'
        return { stdout: 'Claimed task-1\n' }
      }
      if (operation === 'comment') return { stdout: '' }
      throw new Error(`Unexpected operation ${operation}`)
    })

    const first = service.performApprovalAction('task-1', 'claim', {
      board: 'codex-tech', actor: 'james', eventId: 'evt-concurrent',
    })
    await transitionStartedGate
    const second = service.performApprovalAction('task-1', 'claim', {
      board: 'codex-tech', actor: 'james', eventId: 'evt-concurrent',
    })
    releaseTransition()

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ duplicate: false, after_status: 'running' }),
      expect.objectContaining({ duplicate: true, after_status: 'running' }),
    ])
    expect(mockExecFileAsync.mock.calls.filter(call => call[1]?.[3] === 'claim')).toHaveLength(1)
  })

  it('continues the transition when a matching durable audit intent wins the creation race', async () => {
    const ready = JSON.stringify({
      task: { id: 'task-1', title: 'Ship', status: 'ready' }, comments: [], events: [], runs: [],
    })
    const running = JSON.stringify({
      task: { id: 'task-1', title: 'Ship', status: 'running', current_run_id: 7 },
      comments: [],
      events: [{ id: 11, kind: 'claimed', created_at: 101, run_id: 7 }],
      runs: [],
    })
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: ready })
      .mockResolvedValueOnce({ stdout: 'Claimed task-1\n' })
      .mockResolvedValueOnce({ stdout: running })
      .mockResolvedValueOnce({ stdout: '' })
    const racedRecord = {
      schema: 1 as const,
      phase: 'prepared' as const,
      board: 'codex-tech',
      task_id: 'task-1',
      event_id: 'evt-matching-race',
      action: 'claim' as const,
      actor: 'james',
      channel: 'studio' as const,
      reason: null,
      before_status: 'ready' as const,
      before_event_ids: [],
      after_status: null,
      canonical_event_id: null,
      run_id: null,
      timestamp: 1,
      updated_at: 1,
    }
    const auditStore = {
      get: vi.fn().mockResolvedValue(null),
      prepare: vi.fn().mockResolvedValue({ record: racedRecord, created: false }),
      complete: vi.fn(async (_key: unknown, patch: any) => ({
        ...racedRecord, ...patch, phase: 'completed' as const,
      })),
    }

    await expect(service.performApprovalAction('task-1', 'claim', {
      board: 'codex-tech', actor: 'james', eventId: 'evt-matching-race', auditStore,
    })).resolves.toMatchObject({
      duplicate: false,
      before_status: 'ready',
      after_status: 'running',
      canonical_event_id: 11,
    })

    expect(mockExecFileAsync.mock.calls.filter(call => call[1]?.[3] === 'claim')).toHaveLength(1)
    expect(auditStore.complete).toHaveBeenCalledTimes(1)
  })

  it('fails closed when another process wins the durable audit intent creation race', async () => {
    mockExecFileAsync.mockResolvedValueOnce({
      stdout: JSON.stringify({
        task: { id: 'task-1', title: 'Ship', status: 'ready' }, comments: [], events: [], runs: [],
      }),
    })
    const racedRecord = {
      schema: 1 as const,
      phase: 'prepared' as const,
      board: 'codex-tech',
      task_id: 'task-1',
      event_id: 'evt-race',
      action: 'archive' as const,
      actor: 'other-process',
      channel: 'studio' as const,
      reason: null,
      before_status: 'done' as const,
      after_status: null,
      canonical_event_id: null,
      run_id: null,
      timestamp: 1,
      updated_at: 1,
    }
    const auditStore = {
      get: vi.fn().mockResolvedValue(null),
      prepare: vi.fn().mockResolvedValue({ record: racedRecord, created: false }),
      complete: vi.fn(),
    }

    await expect(service.performApprovalAction('task-1', 'claim', {
      board: 'codex-tech', actor: 'james', eventId: 'evt-race', auditStore,
    })).rejects.toThrow('already bound to another action')

    expect(mockExecFileAsync.mock.calls.filter(call => call[1]?.[3] === 'claim')).toHaveLength(0)
  })

  it('fails closed when another actor wins the durable audit intent creation race', async () => {
    mockExecFileAsync.mockResolvedValueOnce({
      stdout: JSON.stringify({
        task: { id: 'task-1', title: 'Ship', status: 'ready' }, comments: [], events: [], runs: [],
      }),
    })
    const racedRecord = {
      schema: 1 as const,
      phase: 'prepared' as const,
      board: 'codex-tech',
      task_id: 'task-1',
      event_id: 'evt-actor-race',
      action: 'claim' as const,
      actor: 'other-process',
      channel: 'studio' as const,
      reason: null,
      before_status: 'ready' as const,
      after_status: null,
      canonical_event_id: null,
      run_id: null,
      timestamp: 1,
      updated_at: 1,
    }
    const auditStore = {
      get: vi.fn().mockResolvedValue(null),
      prepare: vi.fn().mockResolvedValue({ record: racedRecord, created: false }),
      complete: vi.fn(),
    }

    await expect(service.performApprovalAction('task-1', 'claim', {
      board: 'codex-tech', actor: 'james', eventId: 'evt-actor-race', auditStore,
    })).rejects.toThrow('already bound to another action')

    expect(mockExecFileAsync.mock.calls.filter(call => call[1]?.[3] === 'claim')).toHaveLength(0)
  })

  it('uses canonical changes-requested semantics for active reviewer runs and the canonical dashboard reopen for review cards', async () => {
    const base = (status: string, events: unknown[] = []) => JSON.stringify({
      task: { id: 'task-1', status }, comments: [], events, runs: [],
    })
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: base('running', [{ id: 20, kind: 'claimed', run_id: 9, payload: { source_status: 'review' } }]) })
      .mockResolvedValueOnce({ stdout: 'Requested changes for task-1\n' })
      .mockResolvedValueOnce({ stdout: base('ready', [{ id: 21, kind: 'changes_requested', created_at: 201, run_id: 9 }]) })
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: base('review') })
      .mockResolvedValueOnce({ stdout: 'Reopened task-1\n' })
      .mockResolvedValueOnce({ stdout: base('ready', [{ id: 22, kind: 'review_reopened', created_at: 202, run_id: null }]) })
      .mockResolvedValueOnce({ stdout: '' })

    await service.performApprovalAction('task-1', 'request_changes', {
      board: 'codex-tech', actor: 'james', eventId: 'evt-active-review', reason: 'add evidence',
    })
    expect(mockExecFileAsync.mock.calls[1][1]).toEqual([
      'kanban', '--board', 'codex-tech', 'request-changes', 'task-1', 'add evidence',
    ])

    await service.performApprovalAction('task-1', 'request_changes', {
      board: 'codex-tech', actor: 'james', eventId: 'evt-review-card', reason: 'fix tests',
    })
    expect(mockExecFileAsync.mock.calls[5][1]).toEqual([
      'kanban', '--board', 'codex-tech', 'reopen-review', 'task-1', '--reason', 'fix tests',
    ])
  })

  it('normalizes 0.19 detail ids and lists durable attachments', async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          task: { id: 'task-1' },
          comments: [{ author: 'alice', body: 'hi', created_at: 1 }],
          events: [{ kind: 'created', created_at: 1 }],
          runs: [],
        }),
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([{
          id: 7,
          filename: 'report.html',
          content_type: 'text/html',
          size: 42,
          uploaded_by: 'alice',
          stored_path: '/tmp/report.html',
          created_at: 2,
        }]),
      })

    await expect(service.getTask('task-1', { board: 'project-a' })).resolves.toMatchObject({
      comments: [{ id: 'task-1:comment:0', task_id: 'task-1' }],
      events: [{ id: 'task-1:event:0', task_id: 'task-1' }],
    })
    await expect(service.listAttachments('task-1', { board: 'project-a' })).resolves.toEqual([
      expect.objectContaining({ id: 7, filename: 'report.html' }),
    ])
    expect(mockExecFileAsync.mock.calls[1][1]).toEqual([
      'kanban', '--board', 'project-a', 'attachments', 'task-1', '--json',
    ])
  })

  it('isolates the goal judge for explicit operator completions', async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: 'Completed task-1\n', stderr: '' })

    await service.completeTasks(['task-1'], 'human approved', {
      board: 'project-a',
      operatorOverride: true,
    })

    expect(mockExecFileAsync.mock.calls[0][1]).toEqual([
      'kanban', '--board', 'project-a', 'complete', 'task-1', '--summary', 'human approved',
    ])
    const options = mockExecFileAsync.mock.calls[0][2] as any
    expect(options.env.HERMES_HOME).toContain('hermes-kanban-operator-')
    expect(options.env.HERMES_KANBAN_HOME).toBeTruthy()
  })

  it('rejects invalid board slugs before shelling out', async () => {
    await expect(service.listTasks({ board: 'bad;slug' })).rejects.toThrow('Invalid kanban board slug')
    expect(mockExecFileAsync).not.toHaveBeenCalled()
  })

  it('normalizes board slugs using canonical upstream-compatible rules', async () => {
    const sixtyFourChars = 'a'.repeat(64)
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })

    await service.listTasks({ board: 'Team_Alpha' })
    await service.listTasks({ board: sixtyFourChars })
    await service.listTasks({ board: 'default' })

    expect(mockExecFileAsync.mock.calls[0][1]).toEqual(['kanban', '--board', 'team_alpha', 'list', '--json'])
    expect(mockExecFileAsync.mock.calls[1][1]).toEqual(['kanban', '--board', sixtyFourChars, 'list', '--json'])
    expect(mockExecFileAsync.mock.calls[2][1]).toEqual(['kanban', '--board', 'default', 'list', '--json'])
    await expect(service.listTasks({ board: 'bad/slug' })).rejects.toThrow('Invalid kanban board slug')
    await expect(service.listTasks({ board: 'bad.slug' })).rejects.toThrow('Invalid kanban board slug')
    await expect(service.listTasks({ board: '..' })).rejects.toThrow('Invalid kanban board slug')
    await expect(service.listTasks({ board: 'bad slug' })).rejects.toThrow('Invalid kanban board slug')
    await expect(service.listTasks({ board: ' ' })).rejects.toThrow('Invalid kanban board slug')
  })

  it('does not hide non-no-log failures from the kanban log command', async () => {
    mockExecFileAsync
      .mockRejectedValueOnce({ code: 1, stderr: 'permission denied', message: 'permission denied' })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ task: { id: 'task-1' }, runs: [], comments: [], events: [] }) })

    await expect(service.getTaskLog('task-1', { board: 'default' })).rejects.toThrow('Failed to read kanban task log: permission denied')
    expect(mockLoggerError).toHaveBeenCalled()
  })

  it('does not treat misleading no-log fragments as canonical no-log messages', async () => {
    mockExecFileAsync
      .mockRejectedValueOnce({ code: 1, stderr: 'permission denied: no log for diagnostic file', message: 'permission denied' })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ task: { id: 'task-1' }, runs: [], comments: [], events: [] }) })

    await expect(service.getTaskLog('task-1', { board: 'default' })).rejects.toThrow('Failed to read kanban task log: permission denied')
  })

  it('wraps CLI failures with service-specific errors', async () => {
    mockExecFileAsync.mockRejectedValue(new Error('boom'))

    await expect(service.listTasks()).rejects.toThrow('Failed to list kanban tasks: boom')
    expect(mockLoggerError).toHaveBeenCalled()
  })
})
