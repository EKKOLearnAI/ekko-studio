import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const STORE = '../../packages/server/src/modules/studio/repositories/session-notification-store'
const OBSERVER = '../../packages/server/src/modules/studio/services/session-notifications/cron-observer'
const PRESENTATION = '../../packages/server/src/modules/studio/services/session-notifications/presentation'

describe('cron session notifications', () => {
  let db: any
  let home: string
  let bindingsPath: string

  async function writeBinding(row: { job_id: string; session_id: string; bound_at: number; profile?: string; stored_deliver?: string; instance_id?: string; generation?: string | null }) {
    const { DatabaseSync } = await import('node:sqlite')
    const bindings = new DatabaseSync(bindingsPath)
    bindings.exec(`CREATE TABLE IF NOT EXISTS cron_session_bindings (instance_id TEXT NOT NULL, profile TEXT NOT NULL,
      job_id TEXT NOT NULL, session_id TEXT NOT NULL, bound_at REAL NOT NULL, requested_deliver TEXT, stored_deliver TEXT,
      requested_paused INTEGER NOT NULL DEFAULT 0, session_generation TEXT, PRIMARY KEY (instance_id, profile, job_id))`)
    bindings.prepare('INSERT INTO cron_session_bindings VALUES (?, ?, ?, ?, ?, NULL, ?, 0, ?)')
      .run(row.instance_id || 'inst-1', row.profile || 'default', row.job_id, row.session_id, row.bound_at, row.stored_deliver || 'local',
        row.generation === undefined ? 'g-A1' : row.generation)
    bindings.close()
  }

  function execution(overrides: Record<string, unknown> = {}) {
    return {
      job_id: 'job-1', job_name: 'Daily brief', execution_id: 'exec-1', source: 'builtin',
      scheduled_instant: '2026-10-30T09:00:00+00:00', status: 'completed', no_agent: false,
      receipt: 'exact', success: true, answer: 'Exact final answer', silent: false, ...overrides,
    }
  }

  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    home = mkdtempSync(join(tmpdir(), 'session-notifications-'))
    bindingsPath = join(home, 'cron-bindings.db')
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      getDb: () => db, isSqliteAvailable: () => true, getStoragePath: () => ':memory:',
    }))
    // Notices are scoped to the owner session generation, so the owners exist in the real schema.
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
    const { createSession } = await import('../../packages/server/src/modules/studio/repositories/session-store')
    for (const [id, generation] of [['session-A', 'g-A1'], ['session-B', 'g-B1']]) {
      createSession({ id, source: 'cli', profile: 'default' })
      db.prepare('UPDATE sessions SET generation_id=? WHERE id=?').run(generation, id)
    }
  })

  afterEach(() => {
    vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
    rmSync(home, { recursive: true, force: true })
  })

  async function observeOnce(response: any, sessions: Record<string, any>, published: any[]) {
    const { observeCronBindings } = await import(OBSERVER)
    return observeCronBindings({
      namespace: 'inst-1',
      bindingsPath,
      observe: async () => response,
      getSession: (id: string) => sessions[id] || null,
      publish: (record: any) => published.push(record),
    })
  }

  it('delivers an exact scheduled agent-backed result once to the bound session only', async () => {
    await writeBinding({ job_id: 'job-1', session_id: 'session-A', bound_at: 1000 })
    const response = { jobs: [{ job_id: 'job-1', state: 'present', deliver: 'local' }], executions: [execution()] }
    const sessions = { 'session-A': { profile: 'default', generation: 'g-A1' }, 'session-B': { profile: 'default', generation: 'g-B1' } }
    const published: any[] = []

    const first = await observeOnce(response, sessions, published)
    const replay = await observeOnce(response, sessions, published)

    expect(first).toHaveLength(1)
    expect(replay).toHaveLength(0)
    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({ session_id: 'session-A', disposition: 'notified', attention_pending: 1 })
    expect(published[0].payload).toMatchObject({ content: 'Exact final answer', execution_id: 'exec-1', success: true })
    const { listVisibleSessionNotifications } = await import(STORE)
    expect(listVisibleSessionNotifications('session-B')).toEqual([])
  })

  it('fails closed for a deleted or regenerated owner and never reroutes', async () => {
    await writeBinding({ job_id: 'job-1', session_id: 'session-A', bound_at: 1000 })
    const response = { jobs: [{ job_id: 'job-1', state: 'present', deliver: 'local' }], executions: [execution()] }
    const published: any[] = []

    await observeOnce(response, {}, published)
    // Same id, recreated after the binding: a different row generation.
    await observeOnce({ ...response, executions: [execution({ execution_id: 'exec-2' })] },
      { 'session-A': { profile: 'default', generation: 'g-A2' } }, published)

    const { getSessionNotification } = await import(STORE)
    expect(published).toEqual([])
    expect(getSessionNotification('inst-1', 'default', 'cron:job-1:exec-1')?.disposition).toBe('owner_missing')
    expect(getSessionNotification('inst-1', 'default', 'cron:job-1:exec-2')?.disposition).toBe('owner_missing')
  })

  it('fails closed for an owner reset under the same session id', async () => {
    await writeBinding({ job_id: 'job-1', session_id: 'session-A', bound_at: 1000, generation: '7:900:0' })
    const published: any[] = []
    // history_cleared_at changed: the conversation was reset after the job was bound.
    await observeOnce({ jobs: [{ job_id: 'job-1', state: 'present', deliver: 'local' }], executions: [execution()] },
      { 'session-A': { profile: 'default', started_at: 900, generation: '7:900:1793300000000' } }, published)
    const { getSessionNotification } = await import(STORE)
    expect(published).toEqual([])
    expect(getSessionNotification('inst-1', 'default', 'cron:job-1:exec-1')?.disposition).toBe('owner_missing')
  })

  it('never treats a binding without a generation as owned', async () => {
    await writeBinding({ job_id: 'job-1', session_id: 'session-A', bound_at: 1000, generation: null })
    const published: any[] = []
    await observeOnce({ jobs: [{ job_id: 'job-1', state: 'present', deliver: 'local' }], executions: [execution()] },
      { 'session-A': { profile: 'default', started_at: 900, generation: '7:900:0' } }, published)
    const { getSessionNotification } = await import(STORE)
    expect(published).toEqual([])
    expect(getSessionNotification('inst-1', 'default', 'cron:job-1:exec-1')?.disposition).toBe('owner_missing')
  })

  it('records silent, empty, unknown, script-only and manual executions truthfully', async () => {
    await writeBinding({ job_id: 'job-1', session_id: 'session-A', bound_at: 1000 })
    const response = {
      jobs: [{ job_id: 'job-1', state: 'present', deliver: 'local' }],
      executions: [
        execution({ execution_id: 'silent', answer: '[SILENT]', silent: true }),
        execution({ execution_id: 'empty', answer: '   ' }),
        execution({ execution_id: 'unknown', status: 'unknown', receipt: 'unavailable', answer: undefined }),
        execution({ execution_id: 'script', no_agent: true, receipt: 'unavailable', answer: undefined }),
        execution({ execution_id: 'chat-manual', source: 'direct', scheduled_instant: null }),
      ],
    }
    const published: any[] = []
    await observeOnce(response, { 'session-A': { profile: 'default', generation: 'g-A1' } }, published)

    const { getSessionNotification } = await import(STORE)
    const disposition = (id: string) => getSessionNotification('inst-1', 'default', `cron:job-1:${id}`)?.disposition
    expect(disposition('silent')).toBe('silent')
    expect(disposition('empty')).toBe('no_content')
    expect(disposition('unknown')).toBe('unknown')
    expect(disposition('script')).toBe('status_only')
    expect(getSessionNotification('inst-1', 'default', 'cron:job-1:script')?.payload.reason).toBe('output_unavailable_for_runtime')
    expect(disposition('chat-manual')).toBeUndefined()
    expect(published.map(record => record.payload.execution_id).sort()).toEqual(['script', 'unknown'])
  })

  it('stops observing when the native delivery target is edited to an explicit target', async () => {
    await writeBinding({ job_id: 'job-1', session_id: 'session-A', bound_at: 1000 })
    const published: any[] = []
    await observeOnce({ jobs: [{ job_id: 'job-1', state: 'present', deliver: 'slack:C123' }], executions: [execution()] },
      { 'session-A': { profile: 'default', generation: 'g-A1' } }, published)

    const { getSessionNotification, cronJobObservationState } = await import(STORE)
    expect(published).toEqual([])
    expect(getSessionNotification('inst-1', 'default', 'cron-target:job-1')?.payload).toMatchObject({ current_deliver: 'slack:C123' })
    expect(getSessionNotification('inst-1', 'default', 'cron:job-1:exec-1')).toBeNull()
    expect(cronJobObservationState('inst-1', 'default', 'job-1')).toBe('stopped')
  })

  it('ignores bindings written by another Studio instance', async () => {
    await writeBinding({ job_id: 'job-1', session_id: 'session-A', bound_at: 1000, instance_id: 'other' })
    const observe = vi.fn()
    const { observeCronBindings } = await import(OBSERVER)
    await observeCronBindings({ namespace: 'inst-1', bindingsPath, observe, getSession: () => null, publish: () => {} })
    expect(observe).not.toHaveBeenCalled()
  })

  it('projects passive notices to the model once, bounded, and keeps them out of stored messages', async () => {
    await writeBinding({ job_id: 'job-1', session_id: 'session-A', bound_at: 1000 })
    await observeOnce({ jobs: [{ job_id: 'job-1', state: 'present', deliver: 'local' }], executions: [execution({ answer: 'x'.repeat(9000) })] },
      { 'session-A': { profile: 'default', generation: 'g-A1' } }, [])
    const { buildNoticeProjection, withSessionNotices } = await import(PRESENTATION)
    const { markSessionNotificationsProjected } = await import(STORE)

    const projection = buildNoticeProjection('session-A')
    expect(projection?.ids).toHaveLength(1)
    expect(projection!.text.length).toBeLessThan(4600)
    expect(projection!.text).toContain('Scheduled task "Daily brief"')
    markSessionNotificationsProjected(projection!.ids)
    expect(buildNoticeProjection('session-A')).toBeNull()

    const merged = withSessionNotices('session-A', [{ id: 1, role: 'user', timestamp: 1 }], { offset: 0, storedCount: 0 })
    expect(merged).toHaveLength(2)
    expect(merged[1]).toMatchObject({ role: 'system', studio_notice: { execution_id: 'exec-1', disposition: 'notified' } })
  })

  it('settles a machine-event admission interrupted by a crash as unknown, never re-dispatched', async () => {
    const store = await import(STORE)
    const record = store.acceptSessionNotification({ namespace: 'inst-1', profile: 'default', producerKey: 'hermes-process:default:proc_1:1',
      sessionId: 'session-A', sessionGeneration: 'g-A1', kind: 'process_completion', disposition: 'admitting', payload: {}, attention: false })
    expect(record).not.toBeNull()
    expect(store.settleInterruptedProcessAdmissions('inst-1')).toBe(1)
    expect(store.getSessionNotification('inst-1', 'default', 'hermes-process:default:proc_1:1')?.disposition).toBe('unknown')
    expect(store.acceptSessionNotification({ namespace: 'inst-1', profile: 'default', producerKey: 'hermes-process:default:proc_1:1',
      sessionId: 'session-A', sessionGeneration: 'g-A1', kind: 'process_completion', disposition: 'admitting', payload: {}, attention: false })).toBeNull()
  })
})
