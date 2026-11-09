import './fixtures/isolated-studio-state'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const STORE = '../../packages/server/src/modules/studio/repositories/session-notification-store'
const OBSERVER = '../../packages/server/src/modules/studio/services/session-notifications/cron-observer'

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

  const row = (key: string) => db.prepare('SELECT * FROM session_notifications WHERE namespace=? AND profile=? AND producer_key=?')
    .get('inst-1', 'default', key) as any

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

    // Nothing is accepted for a stale owner, so nothing can be shown or rerouted.
    expect(published).toEqual([])
    expect(row('cron:job-1:exec-1')).toBeUndefined()
    expect(row('cron:job-1:exec-2')).toBeUndefined()
  })

  it('fails closed for an owner reset under the same session id', async () => {
    await writeBinding({ job_id: 'job-1', session_id: 'session-A', bound_at: 1000, generation: 'g-A1' })
    const published: any[] = []
    // A history clear rotated the session generation after the job was bound.
    await observeOnce({ jobs: [{ job_id: 'job-1', state: 'present', deliver: 'local' }], executions: [execution()] },
      { 'session-A': { profile: 'default', generation: 'g-A2' } }, published)
    expect(published).toEqual([])
    expect(row('cron:job-1:exec-1')).toBeUndefined()
  })

  it('never treats a binding without a generation as owned', async () => {
    await writeBinding({ job_id: 'job-1', session_id: 'session-A', bound_at: 1000, generation: null })
    const published: any[] = []
    await observeOnce({ jobs: [{ job_id: 'job-1', state: 'present', deliver: 'local' }], executions: [execution()] },
      { 'session-A': { profile: 'default', started_at: 900, generation: '7:900:0' } }, published)
    expect(published).toEqual([])
    expect(row('cron:job-1:exec-1')).toBeUndefined()
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

    const disposition = (id: string) => row(`cron:job-1:${id}`)?.disposition
    expect(disposition('silent')).toBe('silent')
    // An empty answer is recorded once but never shown, like silence.
    expect(disposition('empty')).toBe('silent')
    expect(JSON.parse(row('cron:job-1:empty').payload).reason).toBe('no_content')
    expect(disposition('unknown')).toBe('unknown')
    expect(disposition('script')).toBe('status_only')
    expect(JSON.parse(row('cron:job-1:script').payload).reason).toBe('output_unavailable_for_runtime')
    expect(disposition('chat-manual')).toBeUndefined()
    expect(published.map(record => record.payload.execution_id).sort()).toEqual(['script', 'unknown'])
  })

  it('stops observing when the native delivery target is edited to an explicit target', async () => {
    await writeBinding({ job_id: 'job-1', session_id: 'session-A', bound_at: 1000 })
    const published: any[] = []
    await observeOnce({ jobs: [{ job_id: 'job-1', state: 'present', deliver: 'slack:C123' }], executions: [execution()] },
      { 'session-A': { profile: 'default', generation: 'g-A1' } }, published)

    const { cronJobObservationState } = await import(STORE)
    expect(published).toEqual([])
    expect(row('cron:job-1:exec-1')).toBeUndefined()
    expect(cronJobObservationState('inst-1', 'default', 'job-1')).toBe('stopped')
  })

  it('keeps a known failure with an empty answer visible, before success silence or emptiness', async () => {
    await writeBinding({ job_id: 'job-1', session_id: 'session-A', bound_at: 1000 })
    const published: any[] = []
    await observeOnce({ jobs: [{ job_id: 'job-1', state: 'present', deliver: 'local' }],
      executions: [execution({ execution_id: 'failed', success: false, answer: '', silent: true, result_error: 'provider timeout' })] },
      { 'session-A': { profile: 'default', generation: 'g-A1' } }, published)
    expect(published.map(record => record.disposition)).toEqual(['notified'])
    expect(published[0].payload).toMatchObject({ success: false, error: 'provider timeout' })
  })

  it('never delivers a fire claimed before the binding, even one the previous binding never observed', async () => {
    // Rebound to session B at T; a fire claimed at T-0.5s still belongs to the previous owner.
    const T = 1_793_300_000.25
    await writeBinding({ job_id: 'job-1', session_id: 'session-B', bound_at: T, generation: 'g-B1' })
    const fires = [{ claimed: T - 0.5, ...execution({ execution_id: 'before-rebind', answer: 'old owner result' }) },
      { claimed: T + 0.5, ...execution({ execution_id: 'after-rebind', answer: 'new owner result' }) }]
    const asked: number[] = []
    const { observeCronBindings } = await import(OBSERVER)
    const published: any[] = []
    // The bridge returns terminal fires claimed at or after `since`, as bridge_studio_cron.py does.
    await observeCronBindings({
      namespace: 'inst-1', bindingsPath,
      observe: async (_profile: string, jobs: Array<{ job_id: string; since: number }>) => {
        asked.push(jobs[0].since)
        return { jobs: [{ job_id: 'job-1', state: 'present', deliver: 'local' }],
          executions: fires.filter(fire => fire.claimed >= jobs[0].since).map(({ claimed, ...fire }) => fire) }
      },
      getSession: (id: string) => (id === 'session-B' ? { profile: 'default', generation: 'g-B1' } : null),
      publish: (record: any) => published.push(record),
    })
    expect(asked).toEqual([T])
    expect(published.map(record => record.payload.execution_id)).toEqual(['after-rebind'])
    expect(row('cron:job-1:before-rebind')).toBeUndefined()
  })

  it('ignores bindings written by another Studio instance', async () => {
    await writeBinding({ job_id: 'job-1', session_id: 'session-A', bound_at: 1000, instance_id: 'other' })
    const observe = vi.fn()
    const { observeCronBindings } = await import(OBSERVER)
    await observeCronBindings({ namespace: 'inst-1', bindingsPath, observe, getSession: () => null, publish: () => {} })
    expect(observe).not.toHaveBeenCalled()
  })
})
