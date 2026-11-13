import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import Koa from 'koa'

// Common cron consent through the production auth middleware, routes, consent store and executors.
// Only the native `hermes cron` CLI and the native lifecycle-guard child are simulated. Runtime
// credentials come from the real issuers (`writeModelRunProfileToken`, `issueModelRunJwt`).
const STUDIO = '../../packages/server/src/modules/studio'
const HERMES = '../../packages/server/src/modules/hermes'

let server: Server
let origin: string
let root: string
let hermesHome: string
let studioHome: string
let m: any
let turns: any
const published: string[] = []
const guard = { verdict: { ok: true } as any, calls: [] as string[] }
const cli: { calls: string[][]; jobs: any[]; createGate?: Promise<void>; editGate?: Promise<void>; resumeGate?: Promise<void>; onCreate?: (id: string) => void; onResume?: (job: any) => void; onCommand?: (command: string) => void; afterSave?: (command: string) => void } = { calls: [], jobs: [] }
const users: Record<string, { id: number; token: string; modelRun: string; legacy: string }> = {}

function saveJobs() { mkdirSync(join(hermesHome, 'cron'), { recursive: true }); writeFileSync(join(hermesHome, 'cron', 'jobs.json'), JSON.stringify({ jobs: cli.jobs })) }
function corruptJobs() { writeFileSync(join(hermesHome, 'cron', 'jobs.json'), '{ not json') }
const job = (id: string) => cli.jobs.find(item => item.id === id)

beforeEach(async () => {
  vi.resetModules()
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cron-consent-')))
  hermesHome = join(root, 'hermes')
  studioHome = join(root, 'studio')
  mkdirSync(join(hermesHome, 'scripts', 'reports'), { recursive: true })
  writeFileSync(join(hermesHome, 'scripts', 'reports', 'digest.py'), 'print("digest ready")\n')
  writeFileSync(join(hermesHome, 'scripts', 'reports', 'legacy.sh'), 'echo legacy\n')
  vi.stubEnv('AUTH_JWT_SECRET', 'cron-consent-test-secret')
  vi.stubEnv('HERMES_WEB_UI_HOME', studioHome)
  vi.stubEnv('HERMES_HOME', hermesHome)
  vi.stubEnv('HERMES_WEB_UI_TEST_DB_DIR', join(root, 'db'))
  cli.calls = []; cli.createGate = undefined; cli.editGate = undefined; cli.resumeGate = undefined; cli.onCreate = undefined; cli.onResume = undefined; cli.onCommand = undefined; cli.afterSave = undefined
  cli.jobs = [
    { id: 'agent1', name: 'Morning brief', prompt: 'Summarize the news', no_agent: false, deliver: 'local', enabled: true,
      schedule: { kind: 'cron', expr: '0 9 * * *', display: '0 9 * * *' }, schedule_display: '0 9 * * *', repeat: { times: null, completed: 4 },
      last_run_at: 'x' },
    { id: 'legacy1', name: 'Legacy check', script: 'reports/legacy.sh', no_agent: true, deliver: 'local', enabled: true,
      schedule_display: 'every 1h', repeat: { times: null, completed: 0 } },
    { id: 'slack1', name: 'Slack digest', script: 'reports/legacy.sh', no_agent: true, deliver: 'slack:C1', enabled: true },
  ]
  saveJobs()
  guard.verdict = { ok: true }; guard.calls = []; published.length = 0
  vi.doMock(`${HERMES}/services/runtime/process`, () => ({
    execHermesWithBin: async (_bin: string, args: string[], options: any) => {
      cli.calls.push(args.slice(1))
      expect(options.env.HERMES_HOME).toBe(hermesHome)
      const [, command, , , ...rest] = args
      const flag = (name: string) => rest[rest.indexOf(name) + 1]
      if (command === 'create') {
        await cli.createGate
        const id = `job${cli.jobs.length + 1}`
        cli.jobs.push({ id, name: flag('--name'), script: flag('--script'), no_agent: rest.includes('--no-agent'), deliver: flag('--deliver'),
          enabled: !rest.includes('--paused'), schedule_display: rest[rest.length - 1] })
        saveJobs()
        // A job is visible to other writers as soon as Hermes saved it, before this command returns.
        cli.onCreate?.(id)
        return { stdout: `Created job: ${id}\n`, stderr: '' }
      }
      const target = job(rest[0])
      // A command the CLI refuses changes nothing.
      cli.onCommand?.(command)
      if (command === 'edit') {
        await cli.editGate
        if (rest.includes('--script')) target.script = flag('--script')
        if (rest.includes('--schedule')) target.schedule_display = flag('--schedule')
      }
      if (command === 'resume') { await cli.resumeGate; target.enabled = true; cli.onResume?.(structuredClone(target)) }
      if (command === 'pause') target.enabled = false
      saveJobs()
      // After the change is saved: an unreadable jobs file, or a CLI that fails after committing.
      cli.afterSave?.(command)
      return { stdout: '', stderr: '' }
    },
  }))
  vi.doMock(`${HERMES}/services/script-reports/native-guard`, () => ({
    defaultNativeLifecycleGuard: async (home: string, script: string) => {
      expect(home).toBe(hermesHome)
      guard.calls.push(script)
      return guard.verdict
    },
  }))
  const { initAllHermesTables } = await import(`${STUDIO}/infrastructure/database/schemas`)
  initAllHermesTables()
  m = {
    db: (await import(`${STUDIO}/infrastructure/database/index`)).getDb(),
    store: await import(`${STUDIO}/repositories/session-store`),
    users: await import(`${STUDIO}/repositories/users-store`),
    auth: await import(`${STUDIO}/middleware/auth`),
    notifications: await import(`${STUDIO}/public/session-notifications`),
    inbox: await import(`${STUDIO}/repositories/session-notification-store`),
    bindings: await import(`${STUDIO}/public/cron-session-bindings`),
    reports: await import(`${STUDIO}/repositories/script-report-store`),
    paths: await import(`${STUDIO}/public/script-report-paths`),
    consent: await import(`${HERMES}/services/cron-consent/consent`),
    jobLock: await import(`${HERMES}/services/cron-jobs/job-lock`),
  }
  const { TaskPlanRuns } = await import(`${STUDIO}/services/task-plan-runs`)
  turns = new TaskPlanRuns(() => {}, () => {})
  ;(await import(`${STUDIO}/services/chat-run/server-registry`)).setChatRunServer({
    cronConsentTurnAuthority: (contextId: string, profile: string) => turns.authorityForContext(contextId, profile),
    publishCronConsentUpdate: (sessionId: string) => published.push(sessionId),
  })
  for (const [name, profiles, role] of [['member', ['default'], 'admin'], ['peer', ['default'], 'admin'], ['outsider', ['other'], 'admin'], ['root', [], 'super_admin']] as const) {
    const user = m.users.createUser({ username: name, password: 'password-1', role, status: 'active', profiles: [...profiles] })
    const secret = 'cron-consent-test-secret'
    users[name] = { id: user.id, token: await m.auth.issueUserJwt(user), modelRun: await m.auth.issueModelRunJwt(user), legacy: m.auth.signUserJwt(user, secret) }
  }
  m.store.createSession({ id: 'chat-1', profile: 'default', source: 'cli', studio_user_id: users.member.id, title: 'Chat one' })
  m.store.createSession({ id: 'chat-2', profile: 'default', source: 'cli', studio_user_id: users.member.id, title: 'Chat two' })
  m.store.createSession({ id: 'peer-1', profile: 'default', source: 'cli', studio_user_id: users.peer.id, title: 'Peer chat' })
  m.store.createSession({ id: 'unowned-1', profile: 'default', source: 'cli', title: 'Imported chat' })
  const { createRequestBodyParser } = await import(`${STUDIO}/middleware/request-body-parser`)
  const { cronConsentRoutes } = await import(`${HERMES}/routes/cron-consent`)
  const { scriptReportRoutes } = await import(`${HERMES}/routes/script-reports`)
  const { cronSessionBindingRoutes } = await import(`${HERMES}/routes/cron-session-bindings`)
  const { jobRoutes } = await import(`${HERMES}/routes/jobs`)
  const app = new Koa()
  app.use(createRequestBodyParser())
  app.use(m.auth.requireUserJwt)
  app.use(m.auth.resolveUserProfile)
  app.use(cronConsentRoutes.routes())
  app.use(scriptReportRoutes.routes())
  app.use(cronSessionBindingRoutes.routes())
  app.use(jobRoutes.routes())
  server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  origin = `http://127.0.0.1:${(server.address() as any).port}`
})

afterEach(async () => {
  await new Promise(resolve => server.close(resolve))
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.doUnmock(`${HERMES}/services/runtime/process`)
  vi.doUnmock(`${HERMES}/services/script-reports/native-guard`)
  rmSync(root, { recursive: true, force: true })
})

async function call(method: string, path: string, token: string, body?: unknown) {
  const response = await fetch(`${origin}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: response.status, body: await response.json().catch(() => null) as any }
}
const prepare = (sessionId = 'chat-1', token = users.member.token) => call('POST', '/api/hermes/cron/consent-contexts', token, { profile: 'default', session_id: sessionId })
const request = (contextId: string, operation: Record<string, unknown>, token = users.member.modelRun) =>
  call('POST', '/api/hermes/cron/consent-requests', token, { profile: 'default', context_id: contextId, ...operation })
const list = (sessionId = 'chat-1', token = users.member.token) => call('GET', `/api/hermes/cron/consent-requests?profile=default&session_id=${sessionId}`, token)
const approve = (id: string, token = users.member.token) => call('POST', `/api/hermes/cron/consent-requests/${id}/approve`, token, { profile: 'default' })
const deny = (id: string, token = users.member.token) => call('POST', `/api/hermes/cron/consent-requests/${id}/deny`, token, { profile: 'default' })
const newScript = { kind: 'script_report_enrollment', mode: 'new', name: 'Daily digest', schedule: 'every 1h', script: 'reports/digest.py' }
const adopt = { kind: 'script_report_enrollment', mode: 'existing', job_id: 'legacy1' }
const bindAgent = { kind: 'cron_session_binding', job_id: 'agent1' }
const commands = () => cli.calls.map(item => item[0])
const bindingRows = () => m.reports.listScriptReportBindings(m.notifications.studioInstanceId())
const cronBindings = () => m.bindings.readCronSessionBindings(m.notifications.cronBindingsDbPath(), m.notifications.studioInstanceId())
function turn(sessionId: string, accountId?: number, state: any = { isWorking: true, activeRunMarker: 'run-1' }) {
  return turns.begin(sessionId, 'default', () => state, undefined, true, accountId)
}
function decodePurpose(token: string) { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).purpose }

// With script enrollment supported, the boundary case uses a kind no admission knows; the consent
// service refuses unknown kinds as invalid_kind (the agent-binding-only admission additionally refused
// script_report_enrollment as unsupported_kind on its own branch).
describe('operation kinds', () => {
  it('refuses an unknown operation kind before anything is frozen or listed', async () => {
    const context = await prepare()
    const runtime = readFileSync(join(studioHome, 'profiles', 'default', '.model-run-token'), 'utf8').trim()
    const refused = await request(context.body.context_id, { kind: 'webhook_delivery', job_id: 'agent1' }, runtime)
    expect(refused).toMatchObject({ status: 400, body: { error: 'invalid_kind' } })
    expect((await list()).body.requests).toEqual([])
    expect(cli.calls).toEqual([])
    expect(cronBindings()).toEqual([])
    expect(bindingRows()).toEqual([])
  })

  it('accepts a script report enrollment request as pending, with nothing created before approval', async () => {
    const context = await prepare()
    const runtime = readFileSync(join(studioHome, 'profiles', 'default', '.model-run-token'), 'utf8').trim()
    const pending = await request(context.body.context_id, newScript, runtime)
    expect(pending).toMatchObject({ status: 202, body: { status: 'pending_user_consent', kind: 'script_report_enrollment', session_id: 'chat-1' } })
    expect((await list()).body.requests[0]).toMatchObject({ action: 'create_job', script: 'reports/digest.py' })
    expect(cli.calls).toEqual([])
    expect(bindingRows()).toEqual([])
    expect(cronBindings()).toEqual([])
  })
})

describe('prepared setup context (no model turn)', () => {
  it('issues the ordinary runtime credential, and that credential can only request; the login click executes', async () => {
    const context = await prepare()
    expect(context.status).toBe(201)
    // The real issuer wrote the profile credential the MCP process reads; its verified purpose is model_run.
    const runtime = readFileSync(join(studioHome, 'profiles', 'default', '.model-run-token'), 'utf8').trim()
    expect(decodePurpose(runtime)).toBe('model_run')
    // The same credential is refused by the direct login binding endpoint (the script enrollment
    // endpoint and its check belong to the script enrollment unit).
    const bind = await call('POST', '/api/hermes/cron/session-bindings', runtime, { profile: 'default', session_id: 'chat-1',
      expected_session_generation: m.store.getSessionGeneration('chat-1'), job_id: 'agent1' })
    expect(bind).toMatchObject({ status: 403, body: { error: 'login_token_required' } })

    const pending = await request(context.body.context_id, bindAgent, runtime)
    expect(pending).toMatchObject({ status: 202, body: { status: 'pending_user_consent', kind: 'cron_session_binding', session_id: 'chat-1' } })
    expect(published).toContain('chat-1')
    // Before consent: no native call, no binding, no manifest or wrapper.
    expect(cli.calls).toEqual([])
    expect(cronBindings()).toEqual([])
    expect(existsSync(join(studioHome, 'script-reports'))).toBe(false)
    expect(existsSync(join(hermesHome, 'scripts', 'ekko-script-reports'))).toBe(false)
    // The prepared context was single use.
    expect((await request(context.body.context_id, bindAgent, runtime)).body.error).toBe('context_unavailable')

    const shown = await list()
    expect(shown.body.requests).toHaveLength(1)
    expect(shown.body.requests[0]).toMatchObject({ action: 'subscribe_job', job_id: 'agent1', session_title: 'Chat one', requested_via: 'model_run' })
    expect(typeof shown.body.requests[0].prompt).toBe('string')
    // Runtime, legacy and other non-login credentials cannot list, approve or deny.
    for (const token of [runtime, users.member.legacy]) {
      expect((await list('chat-1', token)).status).toBe(403)
      expect((await approve(pending.body.request_id, token)).status).toBe(403)
      expect((await deny(pending.body.request_id, token)).status).toBe(403)
    }
    expect(cli.calls).toEqual([])

    const approved = await approve(pending.body.request_id)
    expect(approved).toMatchObject({ status: 200, body: { status: 'approved', kind: 'cron_session_binding' } })
    expect(cronBindings()).toHaveLength(1)
    expect(cronBindings()[0]).toMatchObject({ job_id: 'agent1', session_id: 'chat-1', account_id: users.member.id })
    // Replay of the same decision is refused and executes nothing more.
    expect((await approve(pending.body.request_id)).status).toBe(404)
    expect(cronBindings()).toHaveLength(1)
  })

  it('replaces an unused setup context when the user prepares again', async () => {
    const first = await prepare()
    const second = await prepare()
    for (let i = 0; i < 4; i++) expect((await prepare()).status).toBe(201)
    expect((await request(first.body.context_id, bindAgent)).body.error).toBe('context_unavailable')
    expect((await request(second.body.context_id, bindAgent)).body.error).toBe('context_unavailable')
    const latest = await prepare()
    expect((await request(latest.body.context_id, bindAgent)).status).toBe(202)
  })

  it('binds the context to the login account and a permitted session', async () => {
    expect((await prepare('peer-1')).body.error).toBe('session_account_mismatch')
    expect((await prepare('chat-1', users.outsider.token)).status).toBe(403)
    expect((await prepare('chat-1', users.member.modelRun)).status).toBe(403)
    // An unattributed session may be prepared by an authorized account; ownership is not transferred.
    const unowned = await prepare('unowned-1')
    expect(unowned.status).toBe(201)
    expect(m.store.getSession('unowned-1').studio_user_id ?? null).toBeNull()
    // Another account cannot use (or consume) it.
    expect((await request(unowned.body.context_id, bindAgent, users.peer.modelRun)).body.error).toBe('context_account_mismatch')
    expect((await request(unowned.body.context_id, bindAgent)).status).toBe(202)
  })
})

describe('live turn context', () => {
  it('targets the session of the turn the account started, never a caller-chosen one', async () => {
    const context = turn('chat-1', users.member.id)
    const pending = await request(context, bindAgent)
    expect(pending.body.session_id).toBe('chat-1')
    expect((await request(context, { ...bindAgent, session_id: 'chat-2' })).body.error).toBe('destination_override_refused')
    expect((await request(context, { ...bindAgent, expected_session_generation: 'x' })).body.error).toBe('destination_override_refused')
    expect((await request('invented-context', bindAgent)).body.error).toBe('context_unavailable')
    // Another account's live turn context is refused for this credential.
    expect((await request(turn('peer-1', users.peer.id), bindAgent)).body.error).toBe('context_account_mismatch')
    // A turn without a captured account (e.g. group run) cannot request.
    expect((await request(turn('chat-2'), bindAgent)).body.error).toBe('context_unavailable')
  })

  it('documents the account-wide credential boundary: a valid context of another own session targets that session visibly', async () => {
    const chat2 = turn('chat-2', users.member.id)
    const pending = await request(chat2, bindAgent)
    expect(pending.body.session_id).toBe('chat-2')
    expect((await list('chat-1')).body.requests).toEqual([])
    expect((await list('chat-2')).body.requests[0]).toMatchObject({ session_id: 'chat-2', session_title: 'Chat two', context_kind: 'turn' })
    m.store.renameSession('chat-2', 'Renamed chat')
    expect((await list('chat-2')).body.requests[0].session_title).toBe('Renamed chat')
    // Still requires that account's login approval.
    expect((await approve(pending.body.request_id, users.peer.token)).status).toBe(404)
    expect((await approve(pending.body.request_id)).status).toBe(200)
  })

  it('refuses an ended turn and non-request credential classes', async () => {
    const state = { isWorking: true, activeRunMarker: 'run-1' }
    const context = turn('chat-1', users.member.id, state)
    state.isWorking = false
    expect((await request(context, bindAgent)).body.error).toBe('context_unavailable')
    const live = turn('chat-1', users.member.id)
    expect((await request(live, bindAgent, users.member.legacy)).body.error).toBe('credential_not_permitted')
    expect((await request(live, bindAgent, 'not-a-token')).status).toBe(401)
    expect((await call('POST', '/api/hermes/cron/consent-requests', users.member.modelRun, { profile: 'other', context_id: live, ...bindAgent })).status).toBe(403)
  })
})

describe('approval, denial and races', () => {
  it('only the requesting account approves; others cannot read or consume it', async () => {
    const pending = await request(turn('chat-1', users.member.id), bindAgent)
    for (const other of [users.peer.token, users.root.token]) {
      expect((await approve(pending.body.request_id, other)).status).toBe(404)
      expect((await deny(pending.body.request_id, other)).status).toBe(404)
      expect((await list('chat-1', other)).body.requests).toEqual([])
    }
    expect((await approve(pending.body.request_id)).body.status).toBe('approved')
  })

  it('has exactly one winner among concurrent approvals and denials', async () => {
    const pending = await request(turn('chat-1', users.member.id), bindAgent)
    const results = await Promise.all([approve(pending.body.request_id), approve(pending.body.request_id), deny(pending.body.request_id)])
    expect(results.filter(result => result.status === 200)).toHaveLength(1)
    expect(results.filter(result => result.status === 404)).toHaveLength(2)
    expect(cronBindings().length).toBeLessThanOrEqual(1)
  })

  it('denial, expiry, capacity and restart create nothing', async () => {
    const context = turn('chat-1', users.member.id)
    const denied = await request(context, bindAgent)
    expect((await deny(denied.body.request_id)).body.status).toBe('denied')
    expect((await approve(denied.body.request_id)).status).toBe(404)
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const expiring = await request(context, bindAgent)
    vi.spyOn(Date, 'now').mockReturnValue(now + m.consent.CONSENT_TTL_MS + 1)
    expect((await approve(expiring.body.request_id)).body.error).toBe('consent_expired')
    vi.restoreAllMocks()
    for (let i = 0; i < 5; i++) expect((await request(context, bindAgent)).status).toBe(202)
    expect((await request(context, bindAgent)).body.error).toBe('consent_capacity')
    const pendingIds = (await list()).body.requests.map((item: any) => item.id)
    m.consent.cronConsentStore.clear() // A Studio restart drops all in-memory consent state.
    expect((await approve(pendingIds[0])).status).toBe(404)
    expect(cli.calls).toEqual([])
    expect(cronBindings()).toEqual([])
  })

  it('a session reset or lost access invalidates a pending request', async () => {
    const pending = await request(turn('chat-1', users.member.id), bindAgent)
    m.store.clearSessionMessages('chat-1')
    expect((await list()).body.requests).toEqual([])
    expect((await approve(pending.body.request_id)).status).toBe(404)
    const second = await request(turn('chat-1', users.member.id), bindAgent)
    m.db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(users.member.id)
    expect((await approve(second.body.request_id)).status).toBe(403)
    expect(cli.calls).toEqual([])
  })
})

describe('frozen script plan', () => {
  it('refuses changed bytes while pending, without any native call', async () => {
    const pending = await request(turn('chat-1', users.member.id), newScript)
    writeFileSync(join(hermesHome, 'scripts', 'reports', 'digest.py'), 'print("changed")\n')
    expect((await approve(pending.body.request_id)).body.error).toBe('target_changed')
    expect(cli.calls).toEqual([])
  })

  it('rechecks the plan and destination after the native create await and never resumes', async () => {
    let release!: () => void
    cli.createGate = new Promise(resolve => { release = resolve })
    const pending = await request(turn('chat-1', users.member.id), newScript)
    const approval = approve(pending.body.request_id)
    await new Promise(resolve => setTimeout(resolve, 50))
    writeFileSync(join(hermesHome, 'scripts', 'reports', 'digest.py'), 'print("swapped during create")\n')
    release()
    const result = await approval
    expect(result.body).toMatchObject({ error: 'target_changed', job_id: 'job4' })
    expect(commands()).toEqual(['create'])
    expect(job('job4').enabled).toBe(false)
    expect(bindingRows()[0]).toMatchObject({ state: 'failed', job_id: 'job4' })
  })

  it('stops before resuming when the session is reset during the native edit await', async () => {
    let release!: () => void
    cli.editGate = new Promise(resolve => { release = resolve })
    const pending = await request(turn('chat-1', users.member.id), newScript)
    const approval = approve(pending.body.request_id)
    await new Promise(resolve => setTimeout(resolve, 50))
    m.store.clearSessionMessages('chat-1')
    release()
    expect((await approval).body.error).toBe('session_generation_mismatch')
    expect(commands()).toEqual(['create', 'edit'])
    expect(job('job4').enabled).toBe(false)
  })

  it('stores the approved digest in the manifest', async () => {
    const before = (await request(turn('chat-1', users.member.id), newScript)).body.request_id
    const sha = (await list()).body.requests[0].script_sha256
    const approved = await approve(before)
    const bindingId = approved.body.binding.binding_id
    const manifest = JSON.parse(readFileSync(join(studioHome, 'script-reports', 'bindings', bindingId, 'manifest.r1.json'), 'utf8'))
    expect(manifest.target_sha256).toBe(sha)
  })
})

describe('existing no_agent job adoption', () => {
  it('guards, pauses, wraps, verifies and resumes the same job: no duplicate job', async () => {
    const pending = await request(turn('chat-1', users.member.id), adopt)
    expect((await list()).body.requests[0]).toMatchObject({ action: 'modify_job', job_id: 'legacy1', script: 'reports/legacy.sh', resume: true })
    expect(cli.calls).toEqual([])
    const approved = await approve(pending.body.request_id)
    expect(approved).toMatchObject({ status: 200, body: { mode: 'existing', resumed: true } })
    expect(guard.calls).toEqual(['reports/legacy.sh'])
    expect(commands()).toEqual(['pause', 'edit', 'resume'])
    expect(cli.jobs.map(item => item.id)).toEqual(['agent1', 'legacy1', 'slack1'])
    expect(job('legacy1')).toMatchObject({ enabled: true, no_agent: true, deliver: 'local' })
    expect(job('legacy1').script).toMatch(/^ekko-script-reports\/[0-9a-f-]+\.py$/)
    expect(approved.body.binding).toMatchObject({ state: 'active', job_id: 'legacy1', target_script: 'reports/legacy.sh' })
    // Adopted once: a second adoption is refused at request time.
    expect((await request(turn('chat-1', users.member.id), adopt)).body.error).toBe('already_enrolled')
  })

  it('refuses a guard rejection, a busy job or a changed job without touching it', async () => {
    guard.verdict = { ok: false, refused: true, reason: 'Blocked: gateway lifecycle command' }
    let pending = await request(turn('chat-1', users.member.id), adopt)
    expect((await approve(pending.body.request_id)).body.error).toBe('native_guard_rejected')
    guard.verdict = { ok: false, refused: false, reason: 'python missing' }
    pending = await request(turn('chat-1', users.member.id), adopt)
    expect((await approve(pending.body.request_id)).body.error).toBe('native_guard_unavailable')
    guard.verdict = { ok: true }
    const ledger = new DatabaseSync(join(hermesHome, 'cron', 'executions.db'))
    ledger.exec("CREATE TABLE executions (id TEXT PRIMARY KEY, job_id TEXT, status TEXT)")
    ledger.prepare("INSERT INTO executions VALUES ('e1', 'legacy1', 'running')").run()
    pending = await request(turn('chat-1', users.member.id), adopt)
    expect((await approve(pending.body.request_id)).body.error).toBe('job_busy')
    ledger.exec('DELETE FROM executions'); ledger.close()
    pending = await request(turn('chat-1', users.member.id), adopt)
    job('legacy1').schedule_display = 'every 5m'; saveJobs()
    expect((await approve(pending.body.request_id)).body.error).toBe('job_changed')
    expect(cli.calls).toEqual([])
    expect(bindingRows()).toEqual([])
    expect(job('legacy1')).toMatchObject({ enabled: true, script: 'reports/legacy.sh' })
  })

  it('keeps a paused job paused and refuses agent or explicit-target jobs', async () => {
    job('legacy1').enabled = false; saveJobs()
    const pending = await request(turn('chat-1', users.member.id), adopt)
    expect((await approve(pending.body.request_id)).body.resumed).toBe(false)
    expect(commands()).toEqual(['edit'])
    expect((await request(turn('chat-1', users.member.id), { ...adopt, job_id: 'agent1' })).body.error).toBe('agent_job_requires_session_binding')
    expect((await request(turn('chat-1', users.member.id), { ...adopt, job_id: 'slack1' })).body.error).toBe('explicit_delivery_target')
  })
})

describe('agent job binding', () => {
  it('binds the approved job with the approving account; volatile run state does not invalidate it', async () => {
    const pending = await request(turn('chat-1', users.member.id), bindAgent)
    expect((await list()).body.requests[0]).toMatchObject({ action: 'subscribe_job', prompt: 'Summarize the news', prior_binding: null })
    job('agent1').last_run_at = 'later'; job('agent1').repeat.completed = 9; job('agent1').enabled = false; saveJobs()
    const approved = await approve(pending.body.request_id)
    expect(approved.body.binding).toMatchObject({ job_id: 'agent1', session_id: 'chat-1' })
    expect(cronBindings()[0]).toMatchObject({ job_id: 'agent1', session_id: 'chat-1', account_id: users.member.id,
      session_generation: m.store.getSessionGeneration('chat-1') })
    expect(cli.calls).toEqual([])
  })

  it('refuses a changed job configuration and a stale prior binding (no last-writer-wins)', async () => {
    const toOne = await request(turn('chat-1', users.member.id), bindAgent)
    const toTwo = await request(turn('chat-2', users.member.id), bindAgent)
    expect((await approve(toOne.body.request_id)).status).toBe(200)
    expect((await approve(toTwo.body.request_id)).body.error).toBe('binding_changed')
    expect(cronBindings()[0].session_id).toBe('chat-1')
    // An explicit transfer shows the current binding and applies against it.
    const transfer = await request(turn('chat-2', users.member.id), bindAgent)
    expect((await list('chat-2')).body.requests[0].prior_binding).toMatchObject({ session_id: 'chat-1', session_title: 'Chat one' })
    job('agent1').failure_deliver = 'slack:C1'; saveJobs()
    expect((await approve(transfer.body.request_id)).body.error).toBe('job_changed')
    expect((await request(turn('chat-1', users.member.id), { ...bindAgent, job_id: 'legacy1' })).body.error).toBe('script_job_requires_script_report')
  })

  it('keeps direct login binding semantics unchanged (profile-shared, no account fence)', async () => {
    const response = await call('POST', '/api/hermes/cron/session-bindings', users.peer.token, { profile: 'default', session_id: 'chat-1',
      expected_session_generation: m.store.getSessionGeneration('chat-1'), job_id: 'agent1' })
    expect(response.status).toBe(201)
    expect(cronBindings()[0]).toMatchObject({ session_id: 'chat-1', account_id: null })
  })

  it('stops delivering a consent binding once the approving account is disabled', async () => {
    const pending = await request(turn('chat-1', users.member.id), bindAgent)
    await approve(pending.body.request_id)
    const binding = cronBindings()[0]
    m.db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(users.member.id)
    const { observeCronBindings } = await import(`${STUDIO}/services/session-notifications/cron-observer`)
    const delivered: any[] = []
    await observeCronBindings({
      namespace: m.notifications.studioInstanceId(), bindingsPath: m.notifications.cronBindingsDbPath(),
      observe: async () => ({ jobs: [{ job_id: 'agent1', state: 'present', deliver: 'local' }], executions: [{
        job_id: 'agent1', execution_id: 'exec-1', source: 'builtin', scheduled_instant: '2026-11-03T09:00:00+00:00', status: 'completed',
        no_agent: false, receipt: 'exact', success: true, answer: 'private answer', silent: false,
      }] }),
      getSession: () => ({ profile: 'default', generation: binding.session_generation }),
      publish: (record: any) => delivered.push(record),
    })
    expect(delivered).toEqual([])
    expect((m.db.prepare('SELECT disposition FROM session_notifications WHERE namespace=? AND profile=? AND producer_key=?')
      .get(m.notifications.studioInstanceId(), 'default', 'cron:agent1:exec-1') as any)?.disposition).toBe('owner_missing')
  })
})

describe('isolation of the consent journey', () => {
  it('writes no file before approval except the issued runtime credential', async () => {
    await prepare()
    const files = (dir: string): string[] => existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String) : []
    expect(files(join(studioHome, 'profiles'))).toEqual(['default', 'default/.model-run-token'])
    expect(files(join(hermesHome, 'scripts'))).toEqual(['reports', 'reports/digest.py', 'reports/legacy.sh'])
  })
})

async function until(predicate: () => boolean, label: string) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)) }
  throw new Error(`timeout: ${label}`)
}

describe('exact-head review regressions', () => {
  it('direct binding rechecks the destination after waiting for the job lock', async () => {
    let release!: () => void
    const held = m.jobLock.withCronJobLock('default', 'agent1', () => new Promise<void>(resolve => { release = resolve }))
    const pending = call('POST', '/api/hermes/cron/session-bindings', users.peer.token, { profile: 'default', session_id: 'chat-1',
      expected_session_generation: m.store.getSessionGeneration('chat-1'), job_id: 'agent1' })
    await new Promise(resolve => setTimeout(resolve, 100))
    m.users.replaceUserProfiles(users.peer.id, ['other'])
    release()
    await held
    expect((await pending)).toMatchObject({ status: 403, body: { error: 'profile_access_denied' } })
    expect(cronBindings()).toEqual([])
  })

  for (const change of ['access', 'generation'] as const) {
    it(`a destination change during native resume stops a new enrollment, paused and identifiable (${change})`, async () => {
      let release!: () => void
      cli.resumeGate = new Promise(resolve => { release = resolve })
      const pending = await request(turn('chat-1', users.member.id), newScript)
      const approval = approve(pending.body.request_id)
      await until(() => commands().includes('resume'), 'resume started')
      if (change === 'access') m.users.replaceUserProfiles(users.member.id, ['other'])
      else m.store.clearSessionMessages('chat-1')
      release()
      const result = await approval
      expect(result.body).toMatchObject({ error: change === 'access' ? 'profile_access_denied' : 'session_generation_mismatch', job_id: 'job4' })
      expect(commands()).toEqual(['create', 'edit', 'resume', 'pause'])
      expect(job('job4').enabled).toBe(false)
      const binding = bindingRows()[0]
      expect(binding).toMatchObject({ state: 'failed', job_id: 'job4' })
      expect(existsSync(m.paths.scriptReportRevokedMarker(binding.binding_id))).toBe(true)
    })
  }

  it('an access change during resume of an adopted job pauses it again and fails the binding', async () => {
    let release!: () => void
    cli.resumeGate = new Promise(resolve => { release = resolve })
    const pending = await request(turn('chat-1', users.member.id), adopt)
    const approval = approve(pending.body.request_id)
    await until(() => commands().includes('resume'), 'resume started')
    m.users.replaceUserProfiles(users.member.id, ['other'])
    release()
    expect((await approval).body).toMatchObject({ error: 'profile_access_denied', job_id: 'legacy1' })
    expect(commands()).toEqual(['pause', 'edit', 'resume', 'pause'])
    expect(job('legacy1').enabled).toBe(false)
    expect(bindingRows()[0]).toMatchObject({ state: 'failed', job_id: 'legacy1' })
  })

  it('a managed schedule edit racing native creation waits; the job resumes with the approved schedule', async () => {
    let mutation: Promise<unknown> | undefined
    cli.onCreate = id => {
      mutation = m.jobLock.withCronJobLock('default', id, async () => { job(id).schedule_display = 'every 5m'; saveJobs() })
    }
    let atResume: any
    cli.onResume = snapshot => { atResume = snapshot }
    const pending = await request(turn('chat-1', users.member.id), newScript)
    const result = await approve(pending.body.request_id)
    await mutation
    expect(result.body).toMatchObject({ status: 'approved', resumed: true })
    expect(atResume.schedule_display).toBe('every 1h')
    // The later managed edit is a separate, serialized change after enrollment.
    expect(job('job4').schedule_display).toBe('every 5m')
  })

  it('an out-of-band schedule change during wrapper installation is detected; the job stays paused', async () => {
    let release!: () => void
    cli.editGate = new Promise(resolve => { release = resolve })
    const pending = await request(turn('chat-1', users.member.id), newScript)
    const approval = approve(pending.body.request_id)
    await until(() => commands().includes('edit'), 'edit started')
    job('job4').schedule_display = 'every 5m'; saveJobs()
    release()
    expect((await approval).body).toMatchObject({ error: 'native_config_mismatch', job_id: 'job4' })
    expect(commands()).toEqual(['create', 'edit'])
    expect(job('job4').enabled).toBe(false)
  })

  for (const [label, before, after] of [['paused', true, false], ['resumed', false, true]] as const) {
    it(`an adoption proposal is stale once the user ${label} the job before approval`, async () => {
      job('legacy1').enabled = before; saveJobs()
      const pending = await request(turn('chat-1', users.member.id), adopt)
      job('legacy1').enabled = after; saveJobs()
      expect((await approve(pending.body.request_id)).body.error).toBe('job_changed')
      expect(cli.calls).toEqual([])
      expect(job('legacy1').enabled).toBe(after)
      expect(bindingRows()).toEqual([])
    })
  }

  it('adopts an existing job configured through an in-profile alias', async () => {
    symlinkSync('legacy.sh', join(hermesHome, 'scripts', 'reports', 'alias.sh'))
    job('legacy1').script = 'reports/alias.sh'; saveJobs()
    const pending = await request(turn('chat-1', users.member.id), adopt)
    expect(pending.status).toBe(202)
    const approved = await approve(pending.body.request_id)
    expect(approved).toMatchObject({ status: 200, body: { status: 'approved', mode: 'existing', resumed: true } })
    expect(commands()).toEqual(['pause', 'edit', 'resume'])
    expect(approved.body.binding).toMatchObject({ state: 'active', job_id: 'legacy1', target_script: 'reports/legacy.sh' })
  })
})

describe('native readback and state through approval', () => {
  it('an unreadable job after the adoption pause fails the binding with its job id and pauses again, never wrapping or resuming', async () => {
    let pauses = 0
    cli.afterSave = command => { if (command === 'pause' && ++pauses === 1) corruptJobs() }
    const pending = await request(turn('chat-1', users.member.id), adopt)
    const result = await approve(pending.body.request_id)
    expect(result.status).toBe(502)
    expect(result.body).toEqual({ error: 'native_config_mismatch', job_id: 'legacy1', native_state: 'paused' })
    expect(commands()).toEqual(['pause', 'pause'])
    expect(job('legacy1')).toMatchObject({ enabled: false, script: 'reports/legacy.sh' })
    expect(bindingRows()).toMatchObject([{ state: 'failed', job_id: 'legacy1', error: 'native_config_mismatch' }])
  })

  it('an unreadable job after the adoption edit fails the binding with its job id and an unconfirmed pause, never resuming', async () => {
    let broken = false
    cli.afterSave = command => { if (command === 'edit') broken = true; if (broken) corruptJobs() }
    const pending = await request(turn('chat-1', users.member.id), adopt)
    const result = await approve(pending.body.request_id)
    expect(result.status).toBe(502)
    expect(result.body).toEqual({ error: 'native_config_mismatch', job_id: 'legacy1', native_state: 'unknown' })
    expect(commands()).toEqual(['pause', 'edit', 'pause'])
    expect(job('legacy1').enabled).toBe(false)
    expect(bindingRows()).toMatchObject([{ state: 'failed', job_id: 'legacy1', error: 'native_config_mismatch' }])
  })

  it('a refused resume on approval reports the job id and the observed paused state', async () => {
    cli.onCommand = command => { if (command === 'resume') throw new Error('resume refused') }
    const pending = await request(turn('chat-1', users.member.id), newScript)
    const result = await approve(pending.body.request_id)
    expect(result.status).toBe(502)
    expect(result.body).toEqual({ error: 'native_resume_failed', job_id: 'job4', native_state: 'paused' })
    expect(commands()).toEqual(['create', 'edit', 'resume'])
    expect(job('job4').enabled).toBe(false)
  })

  it('a resume that committed then failed, with a refused pause, reports an unknown native state', async () => {
    cli.afterSave = command => { if (command === 'resume') throw new Error('resume timed out') }
    cli.onCommand = command => { if (command === 'pause') throw new Error('pause refused') }
    const pending = await request(turn('chat-1', users.member.id), newScript)
    const result = await approve(pending.body.request_id)
    expect(result.status).toBe(502)
    expect(result.body).toEqual({ error: 'native_resume_failed', job_id: 'job4', native_state: 'unknown' })
    expect(commands()).toEqual(['create', 'edit', 'resume', 'pause'])
    expect(job('job4').enabled).toBe(true)
  })

  it('a successful resume whose job cannot be read back stays approved with an unknown native state', async () => {
    cli.afterSave = command => { if (command === 'resume') corruptJobs() }
    const pending = await request(turn('chat-1', users.member.id), newScript)
    const result = await approve(pending.body.request_id)
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ status: 'approved', mode: 'new', job: null, resumed: true, native_state: 'unknown',
      binding: { state: 'active', job_id: 'job4', identity_kind: 'wrapper_invocation' } })
    expect(commands()).toEqual(['create', 'edit', 'resume'])
  })
})

describe('credential classes at the consent endpoints', () => {
  it('refuses App, model API key and run credentials; a delegated run credential still cannot request', async () => {
    const context = turn('chat-1', users.member.id)
    const body = { profile: 'default', context_id: context, ...bindAgent }
    const user = m.users.findUserById(users.member.id)
    const app = m.auth.signAppJwt(user, 'device-1', 'lan', 'cron-consent-test-secret')
    const { MODEL_API_KEY_PREFIX } = await import(`${STUDIO}/services/model-api/keys`)
    const modelKey = `${MODEL_API_KEY_PREFIX}${'x'.repeat(40)}`
    for (const token of [app, modelKey, 'not-a-token']) {
      expect((await call('POST', '/api/hermes/cron/consent-requests', token, body)).status).toBeGreaterThanOrEqual(401)
      expect((await call('POST', '/api/hermes/cron/consent-requests', token, body)).status).toBeLessThanOrEqual(403)
      expect((await list('chat-1', token)).status).toBeGreaterThanOrEqual(401)
    }
    const { runMcpCredentials } = await import(`${STUDIO}/services/auth/run-mcp-credentials`)
    const runCall = async (delegated: boolean) => {
      const file = await runMcpCredentials.issue({ sessionId: 'chat-1', contextId: `run-${delegated}`, profile: 'default', agentId: 'agent',
        ...(delegated ? { userId: users.member.id } : {}), isActive: () => true })
      const runToken = JSON.parse(readFileSync(file, 'utf8')).token
      const response = await fetch(`${origin}/api/hermes/cron/consent-requests`, { method: 'POST', body: JSON.stringify(body),
        headers: { authorization: `Bearer ${runToken}`, 'content-type': 'application/json', 'x-studio-run-context': `run-${delegated}` } })
      return { status: response.status, body: await response.json() as any }
    }
    expect(await runCall(false)).toMatchObject({ status: 403 })
    expect(await runCall(true)).toMatchObject({ status: 403, body: { error: 'credential_not_permitted' } })
    expect((await list()).body.requests).toEqual([])
  })
})

describe('queued job API mutations', () => {
  const mutations = [
    ['resume', 'POST', '/api/hermes/jobs/agent1/resume', undefined],
    ['pause', 'POST', '/api/hermes/jobs/agent1/pause', undefined],
    ['update', 'PATCH', '/api/hermes/jobs/agent1', { name: 'Renamed brief' }],
    ['remove', 'DELETE', '/api/hermes/jobs/agent1', undefined],
  ] as const

  async function queued(method: string, path: string, body: unknown, whileQueued: () => void) {
    let release!: () => void
    const held = m.jobLock.withCronJobLock('default', 'agent1', () => new Promise<void>(resolve => { release = resolve }))
    const pending = call(method, `${path}?profile=default`, users.peer.token, body)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(cli.calls).toEqual([])
    whileQueued()
    release()
    await held
    return pending
  }

  for (const [name, method, path, body] of mutations) {
    it(`a queued ${name} is refused once the account loses profile access while it waits`, async () => {
      const response = await queued(method, path, body, () => m.users.replaceUserProfiles(users.peer.id, ['other']))
      expect(response.status).toBe(403)
      expect(cli.calls).toEqual([])
    })

    it(`a queued ${name} by a still-authorized account runs after the lock is released`, async () => {
      const response = await queued(method, path, body, () => {})
      expect(response.status).toBe(200)
      expect(cli.calls.map(item => item[0])).toEqual([name === 'update' ? 'edit' : name])
    })
  }

  it('a queued resume is refused once the account is disabled while it waits', async () => {
    const response = await queued('POST', '/api/hermes/jobs/agent1/resume', undefined,
      () => m.db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(users.peer.id))
    expect(response.status).toBe(403)
    expect(cli.calls).toEqual([])
  })
})
