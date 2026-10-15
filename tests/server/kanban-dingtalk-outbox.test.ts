import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mockKillOwnedProcessTree = vi.hoisted(() => vi.fn((_pid: number | undefined, fallback: () => void) => fallback()))

vi.mock('../../packages/server/src/modules/studio/public/process-tree', () => ({
  killOwnedProcessTree: mockKillOwnedProcessTree,
}))

import {
  FileDingTalkApprovalOutboxStore,
  reconcileDingTalkApprovalOutbox,
  reconcileDingTalkApprovalEvent,
  startDingTalkApprovalOutboxDispatcher,
} from '../../packages/server/src/modules/hermes/services/kanban/dingtalk-approval-outbox'

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kanban-dingtalk-outbox-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function reviewDetail() {
  return {
    task: {
      id: 'task-1', title: 'Review from worker', status: 'review' as const,
      priority: 3, assignee: 'codex-worker',
    },
    comments: [],
    runs: [],
    events: [{
      id: 'task-1:event:4',
      task_id: 'task-1',
      kind: 'review_requested',
      payload: { summary: 'tests passed', implementer: 'codex-worker' },
      created_at: 1720000000,
      run_id: 17,
    }],
  }
}

describe('DingTalk approval notification outbox', () => {
  it('atomically enqueues one record under concurrent duplicate canonical events', async () => {
    const root = await tempRoot()
    const store = new FileDingTalkApprovalOutboxStore(root)
    const base = {
      schema: 1 as const,
      event_id: 'evt-race',
      canonical_event_key: 'canonical-1',
      canonical_kind: 'review_requested' as const,
      canonical_run_id: 17,
      canonical_created_at: 1720000000,
      board: 'codex-tech',
      task_id: 'task-1',
      payload: { msgtype: 'markdown' as const, markdown: { title: 'Review', text: 'Body' } },
      status: 'pending' as const,
      configured: false,
      api_accepted: false,
      attempts: 0,
      recipient_confirmed: false as const,
      retryable: true,
      error: null,
      created_at: 1720000000,
      updated_at: 1720000000,
    }

    const results = await Promise.all([
      store.enqueue(base),
      store.enqueue({ ...base, attempts: 99 }),
    ])

    expect(results.filter(result => result.created)).toHaveLength(1)
    expect(results.filter(result => !result.created)).toHaveLength(1)
    const persisted = await store.get('evt-race')
    expect(results.every(result => result.record.attempts === persisted?.attempts)).toBe(true)
  })

  it('discovers non-Studio canonical review events and sends each event once', async () => {
    const root = await tempRoot()
    const store = new FileDingTalkApprovalOutboxStore(root)
    const listTasks = vi.fn().mockResolvedValue([reviewDetail().task])
    const getTask = vi.fn().mockResolvedValue(reviewDetail())
    const send = vi.fn().mockResolvedValue({
      configured: true, api_accepted: true, attempts: 1, recipient_confirmed: false,
    })

    await reconcileDingTalkApprovalOutbox('codex-tech', {
      store, listTasks, getTask, send, studioUrl: 'http://127.0.0.1:8748', now: () => 1720000100,
    })
    await reconcileDingTalkApprovalOutbox('codex-tech', {
      store, listTasks, getTask, send, studioUrl: 'http://127.0.0.1:8748', now: () => 1720000101,
    })

    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0].markdown.text).toContain('Review from worker')
    expect(send.mock.calls[0][0].markdown.text).toContain('事件 ID：kanban-review-')
    const records = await store.list()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      board: 'codex-tech',
      task_id: 'task-1',
      canonical_kind: 'review_requested',
      canonical_run_id: 17,
      status: 'accepted',
      attempts: 1,
      recipient_confirmed: false,
    })
  })

  it('delivers an exact review event after a later event superseded its review state', async () => {
    const root = await tempRoot()
    const store = new FileDingTalkApprovalOutboxStore(root)
    const detail: any = reviewDetail()
    detail.task.status = 'ready'
    detail.events.push({
      id: 'task-1:event:5', task_id: 'task-1', kind: 'changes_requested', payload: {}, created_at: 1720000001, run_id: 17,
    })
    const getTask = vi.fn().mockResolvedValue(detail)
    const send = vi.fn().mockResolvedValue({
      configured: true, api_accepted: true, attempts: 1, recipient_confirmed: false,
    })

    const record = await reconcileDingTalkApprovalEvent('codex-tech', 'task-1', 'task-1:event:4', {
      store, getTask, send, studioUrl: 'http://127.0.0.1:8748', now: () => 1720000100,
    })

    expect(record).toMatchObject({ task_id: 'task-1', status: 'accepted' })
    expect(record?.canonical_event_key).toContain('task-1:event:4')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('replays review events created while Studio was stopped by using the durable discovery cursor', async () => {
    const root = await tempRoot()
    const store = new FileDingTalkApprovalOutboxStore(root)
    const detail: any = reviewDetail()
    const listTasks = vi.fn().mockResolvedValue([detail.task])
    const getTask = vi.fn().mockImplementation(async () => detail)
    const send = vi.fn().mockResolvedValue({
      configured: true, api_accepted: true, attempts: 1, recipient_confirmed: false,
    })

    await reconcileDingTalkApprovalOutbox('codex-tech', {
      store, listTasks, getTask, send, now: () => 1720000100,
    })
    detail.task.status = 'ready'
    detail.events.push(
      { id: 'task-1:event:5', task_id: 'task-1', kind: 'changes_requested', payload: {}, created_at: 1720000101, run_id: 17 },
      { id: 'task-1:event:6', task_id: 'task-1', kind: 'review_requested', payload: {}, created_at: 1720000150, run_id: 18 },
      { id: 'task-1:event:7', task_id: 'task-1', kind: 'changes_requested', payload: {}, created_at: 1720000151, run_id: 18 },
    )
    await reconcileDingTalkApprovalOutbox('codex-tech', {
      store, listTasks, getTask, send, now: () => 1720000200,
    })

    expect(send).toHaveBeenCalledTimes(2)
    expect((await store.list()).map(record => record.canonical_event_key)).toEqual([
      expect.stringContaining('task-1:event:4'),
      expect.stringContaining('task-1:event:6'),
    ])
  })

  it('recovers a failed delivery from disk after a new dispatcher instance starts', async () => {
    const root = await tempRoot()
    const listTasks = vi.fn().mockResolvedValue([reviewDetail().task])
    const getTask = vi.fn().mockResolvedValue(reviewDetail())
    const firstSend = vi.fn().mockResolvedValue({
      configured: true, api_accepted: false, attempts: 3, recipient_confirmed: false, retryable: true, error: 'HTTP 503',
    })

    await reconcileDingTalkApprovalOutbox('codex-tech', {
      store: new FileDingTalkApprovalOutboxStore(root),
      listTasks,
      getTask,
      send: firstSend,
      studioUrl: 'http://127.0.0.1:8748',
      now: () => 1720000100,
    })

    const recoveredStore = new FileDingTalkApprovalOutboxStore(root)
    const recoveredSend = vi.fn().mockResolvedValue({
      configured: true, api_accepted: true, attempts: 1, recipient_confirmed: false,
    })
    await reconcileDingTalkApprovalOutbox('codex-tech', {
      store: recoveredStore,
      listTasks,
      getTask,
      send: recoveredSend,
      studioUrl: 'http://127.0.0.1:8748',
      now: () => 1720000200,
    })

    expect(recoveredSend).toHaveBeenCalledTimes(1)
    const records = await recoveredStore.list()
    expect(records[0]).toMatchObject({ status: 'accepted', attempts: 4 })
  })

  it('does not retry a permanent DingTalk rejection on later reconciliation passes', async () => {
    const root = await tempRoot()
    const store = new FileDingTalkApprovalOutboxStore(root)
    const listTasks = vi.fn().mockResolvedValue([reviewDetail().task])
    const getTask = vi.fn().mockResolvedValue(reviewDetail())
    const send = vi.fn().mockResolvedValue({
      configured: true,
      api_accepted: false,
      attempts: 1,
      recipient_confirmed: false,
      retryable: false,
      error: 'DingTalk notification API rejected request: 310000',
    })

    await reconcileDingTalkApprovalOutbox('codex-tech', {
      store, listTasks, getTask, send, studioUrl: 'http://127.0.0.1:8748', now: () => 1720000100,
    })
    await reconcileDingTalkApprovalOutbox('codex-tech', {
      store, listTasks, getTask, send, studioUrl: 'http://127.0.0.1:8748', now: () => 1720000200,
    })

    expect(send).toHaveBeenCalledTimes(1)
    expect(await store.list()).toEqual([
      expect.objectContaining({ status: 'failed', attempts: 1, retryable: false }),
    ])
  })

  it('starts a canonical review watcher, reconciles on events, and closes owned processes', async () => {
    const stdout = new (await import('events')).EventEmitter()
    const child = new (await import('events')).EventEmitter() as any
    child.stdout = stdout
    child.pid = 123
    child.killed = false
    child.kill = vi.fn(() => { child.killed = true })
    const watch = vi.fn(() => child)
    const reconcile = vi.fn(async () => [])
    const reconcileEvent = vi.fn(async () => null)

    const dispatcher = startDingTalkApprovalOutboxDispatcher({
      boards: ['codex-tech'],
      reconcileIntervalMs: 60_000,
      watch: watch as any,
      reconcile,
      reconcileEvent,
    })
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1))
    stdout.emit('data', Buffer.from('[2026-09-11 15:00] task-1     review_requested   (@codex-worker)\n'))
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(2))
    const minuteStart = Math.floor(new Date('2026-09-11T15:00').getTime() / 60_000) * 60
    await vi.waitFor(() => expect(reconcileEvent).toHaveBeenCalledWith('codex-tech', 'task-1', `minute:${minuteStart}`))
    expect(watch).toHaveBeenCalledWith({ board: 'codex-tech', interval: 0.5, kinds: ['review_requested'] })

    dispatcher.close()
    expect(child.kill).toHaveBeenCalledTimes(1)
  })
})