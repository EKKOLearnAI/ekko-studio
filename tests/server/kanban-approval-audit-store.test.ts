import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FileKanbanApprovalAuditStore,
  type KanbanApprovalAuditRecord,
} from '../../packages/server/src/modules/hermes/services/kanban/approval-audit-store'

const roots: string[] = []

function record(actor: string): KanbanApprovalAuditRecord {
  return {
    schema: 1,
    phase: 'prepared',
    board: 'codex-tech',
    task_id: 'task-1',
    event_id: 'evt-1',
    action: 'approve',
    actor,
    channel: 'studio',
    reason: 'verified',
    before_status: 'review',
    after_status: null,
    canonical_event_id: null,
    run_id: 7,
    timestamp: 1,
    updated_at: 1,
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('kanban approval audit store', () => {
  it('atomically creates one immutable intent under concurrent duplicate requests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kanban-approval-audit-'))
    roots.push(root)
    const store = new FileKanbanApprovalAuditStore(root)

    const results = await Promise.all([
      store.prepare(record('james-a')),
      store.prepare(record('james-b')),
    ])

    expect(results.filter(result => result.created)).toHaveLength(1)
    expect(results.filter(result => !result.created)).toHaveLength(1)
    const persisted = await store.get('codex-tech', 'task-1', 'evt-1')
    expect(['james-a', 'james-b']).toContain(persisted?.actor)
    expect(results.every(result => result.record.actor === persisted?.actor)).toBe(true)
  })
})
