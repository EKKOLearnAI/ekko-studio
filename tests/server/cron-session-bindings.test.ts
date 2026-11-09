import './fixtures/isolated-studio-state'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import Koa from 'koa'

// Explicit binding of an existing agent-backed native cron job to a session, through the production
// auth middleware and route.
const STUDIO = '../../packages/server/src/modules/studio'
const HERMES = '../../packages/server/src/modules/hermes'

let server: Server
let origin: string
let root: string
let m: any
const users: Record<string, { token: string; modelRun: string }> = {}

beforeEach(async () => {
  vi.resetModules()
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cron-binding-')))
  mkdirSync(join(root, 'hermes', 'cron'), { recursive: true })
  writeFileSync(join(root, 'hermes', 'cron', 'jobs.json'), JSON.stringify({ jobs: [
    { id: 'agent1', deliver: 'local' }, { id: 'script1', deliver: 'local', no_agent: true }, { id: 'slack1', deliver: 'slack:C1' },
  ] }))
  vi.stubEnv('AUTH_JWT_SECRET', 'cron-binding-test-secret')
  vi.stubEnv('HERMES_WEB_UI_HOME', join(root, 'studio'))
  vi.stubEnv('HERMES_HOME', join(root, 'hermes'))
  vi.stubEnv('HERMES_WEB_UI_TEST_DB_DIR', join(root, 'db'))
  const { initAllHermesTables } = await import(`${STUDIO}/infrastructure/database/schemas`)
  initAllHermesTables()
  m = {
    store: await import(`${STUDIO}/repositories/session-store`),
    users: await import(`${STUDIO}/repositories/users-store`),
    auth: await import(`${STUDIO}/middleware/auth`),
    bindings: await import(`${STUDIO}/public/cron-session-bindings`),
    inbox: await import(`${STUDIO}/repositories/session-notification-store`),
    notifications: await import(`${STUDIO}/public/session-notifications`),
  }
  for (const [name, profiles] of [['member', ['default']], ['outsider', ['other']]] as const) {
    const user = m.users.createUser({ username: name, password: 'password-1', role: 'admin', status: 'active', profiles: [...profiles] })
    users[name] = { id: user.id, token: await m.auth.issueUserJwt(user), modelRun: await m.auth.issueModelRunJwt(user) }
  }
  m.store.createSession({ id: 'chat-1', profile: 'default', source: 'cli' })
  const { createRequestBodyParser } = await import(`${STUDIO}/middleware/request-body-parser`)
  const { cronSessionBindingRoutes } = await import(`${HERMES}/routes/cron-session-bindings`)
  const app = new Koa()
  app.use(createRequestBodyParser())
  app.use(m.auth.requireUserJwt)
  app.use(m.auth.resolveUserProfile)
  app.use(cronSessionBindingRoutes.routes())
  server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  origin = `http://127.0.0.1:${(server.address() as any).port}`
})

afterEach(async () => {
  await new Promise(resolve => server.close(resolve))
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

async function bind(job_id: string, token = users.member.token, overrides: Record<string, unknown> = {}) {
  const response = await fetch(`${origin}/api/hermes/cron/session-bindings`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ profile: 'default', session_id: 'chat-1', expected_session_generation: m.store.getSessionGeneration('chat-1'), job_id, ...overrides }),
  })
  return { status: response.status, body: await response.json() as any }
}

describe('explicit cron session binding', () => {
  it('binds an existing agent-backed local job to the frozen session generation', async () => {
    expect(await bind('agent1')).toMatchObject({ status: 201, body: { job_id: 'agent1', session_id: 'chat-1' } })
    const bindings = m.bindings.readCronSessionBindings(m.notifications.cronBindingsDbPath(), m.notifications.studioInstanceId())
    expect(bindings).toEqual([expect.objectContaining({ job_id: 'agent1', session_id: 'chat-1', stored_deliver: 'local',
      session_generation: m.store.getSessionGeneration('chat-1') })])
  })

  it('refuses script-only jobs, explicit targets and unknown jobs without writing', async () => {
    expect((await bind('script1')).body.error).toBe('script_job_requires_script_report')
    expect((await bind('slack1')).body.error).toBe('explicit_delivery_target')
    expect((await bind('missing')).body.error).toBe('job_not_found')
    expect(m.bindings.readCronSessionBindings(m.notifications.cronBindingsDbPath(), m.notifications.studioInstanceId())).toEqual([])
  })

  it('a deliberate rebinding of a stopped job resumes its observation', async () => {
    expect((await bind('agent1')).status).toBe(201)
    const namespace = m.notifications.studioInstanceId()
    // The observer stopped it, e.g. after an out-of-band delivery change since restored to local.
    m.inbox.setCronJobObservationState(namespace, 'default', 'agent1', 'stopped')
    m.inbox.setCronJobObserveCursor(namespace, 'default', 'agent1', '2026-11-01T00:00:00')
    expect((await bind('agent1')).status).toBe(201)
    expect(m.inbox.cronJobObservationState(namespace, 'default', 'agent1')).toBe('observing')
    expect(m.inbox.cronJobObserveCursor(namespace, 'default', 'agent1')).toBeNull()
    const { observeCronBindings } = await import(`${STUDIO}/services/session-notifications/cron-observer`)
    const observed: string[] = []
    await observeCronBindings({
      namespace, bindingsPath: m.notifications.cronBindingsDbPath(),
      observe: async (_profile: string, jobs: Array<{ job_id: string }>) => { observed.push(...jobs.map(job => job.job_id)); return { jobs: [], executions: [] } },
      getSession: () => ({ profile: 'default', generation: m.store.getSessionGeneration('chat-1') }),
      publish: () => {},
    } as any)
    expect(observed).toEqual(['agent1'])
  })

  it.each(['changed-target', 'missing-job'])('an older in-flight %s answer does not stop the replacement binding', async (scenario) => {
    expect((await bind('agent1')).status).toBe(201)
    const namespace = m.notifications.studioInstanceId()
    const { observeCronBindings } = await import(`${STUDIO}/services/session-notifications/cron-observer`)
    const published: any[] = []
    const deps = {
      namespace, bindingsPath: m.notifications.cronBindingsDbPath(),
      getSession: () => ({ profile: 'default', generation: m.store.getSessionGeneration('chat-1') }),
      publish: (record: any) => published.push(record),
    }
    let release!: (response: any) => void
    const pending = observeCronBindings({ ...deps, observe: () => new Promise<any>(resolve => { release = resolve }) } as any)
    // Possibly within the same millisecond as the first binding: the revision still moves forward.
    expect((await bind('agent1')).status).toBe(201)
    release({ jobs: [scenario === 'changed-target'
      ? { job_id: 'agent1', state: 'present', deliver: 'slack:old', older_before: '2026-11-01T00:00:00' }
      : { job_id: 'agent1', state: 'missing' }], executions: [] })
    await pending
    expect(m.inbox.cronJobObservationState(namespace, 'default', 'agent1')).toBe('observing')
    expect(m.inbox.cronJobObserveCursor(namespace, 'default', 'agent1')).toBeNull()
    const next = vi.fn(async () => ({ jobs: [{ job_id: 'agent1', state: 'present', deliver: 'local' }], executions: [{
      job_id: 'agent1', execution_id: 'after-rebind', source: 'builtin', status: 'ok', no_agent: false,
      receipt: 'exact', success: true, answer: 'fresh result',
    }] }))
    await observeCronBindings({ ...deps, observe: next } as any)
    expect(next).toHaveBeenCalledTimes(1)
    expect(published).toEqual([expect.objectContaining({ session_id: 'chat-1', disposition: 'notified' })])
  })

  it('requires a login token and fences the destination', async () => {
    expect((await bind('agent1', users.member.modelRun)).status).toBe(403)
    expect((await bind('agent1', users.outsider.token)).status).toBe(403)
    expect((await bind('agent1', users.member.token, { expected_session_generation: 'stale' })).body.error).toBe('session_generation_mismatch')
    expect((await bind('agent1', users.member.token, { session_id: 'missing' })).body.error).toBe('session_not_found')
    m.store.createSession({ id: 'workflow-1', profile: 'default', source: 'workflow' })
    expect((await bind('agent1', users.member.token, { session_id: 'workflow-1',
      expected_session_generation: m.store.getSessionGeneration('workflow-1') })).body.error).toBe('unsupported_notification_target')
    // Private Person conversations: the request is refused before the controller, and the
    // destination check itself refuses them too.
    for (const id of ['person-main-1', 'person-task-1']) {
      m.store.createSession({ id, profile: 'default', source: 'cli' })
      const generation = m.store.getSessionGeneration(id)
      expect((await bind('agent1', users.member.token, { session_id: id, expected_session_generation: generation })).status).toBe(404)
      expect(m.bindings.authorizeNoticeDestination(users.member.id, 'default', id, generation)).toBe('unsupported')
    }
    expect(m.bindings.readCronSessionBindings(m.notifications.cronBindingsDbPath(), m.notifications.studioInstanceId())).toEqual([])
  })
})
