import './fixtures/isolated-studio-state'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Server } from 'node:http'
import Koa from 'koa'
import Router from '@koa/router'

// Detached completion read back over HTTP: the repository wrapper's completion helper writes the
// detached spool, the public importer port accepts it, and the production sessions route serves the
// passive notice. The import trigger below is a test-only route; in the app the chat-run socket
// timer calls the same public port. Only the native scheduler is absent.
const STUDIO = '../../packages/server/src/modules/studio'
const HERMES = '../../packages/server/src/modules/hermes'
const PYTHON = process.env.SCRIPT_REPORT_TEST_PYTHON || 'python3'
const FIXTURE = resolve(__dirname, 'fixtures', 'detached-report')

let root: string
let hermesHome: string
let server: Server
let origin: string
let m: any
let member: any
let memberToken: string
let outsiderToken: string
const jobs: any[] = []

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'script-report-detached-http-')))
  hermesHome = join(root, 'hermes')
  mkdirSync(join(hermesHome, 'scripts', 'reports'), { recursive: true })
  copyFileSync(join(FIXTURE, 'launcher.sh'), join(hermesHome, 'scripts', 'reports', 'launcher.sh'))
  process.env.HERMES_HOME = hermesHome
  process.env.AUTH_JWT_SECRET = 'script-report-http-test-secret'
  const { initAllHermesTables } = await import(`${STUDIO}/infrastructure/database/schemas`)
  initAllHermesTables()
  m = {
    db: (await import(`${STUDIO}/infrastructure/database/index`)).getDb(),
    store: await import(`${STUDIO}/repositories/session-store`),
    reports: await import(`${STUDIO}/repositories/script-report-store`),
    users: await import(`${STUDIO}/repositories/users-store`),
    auth: await import(`${STUDIO}/middleware/auth`),
    paths: await import(`${STUDIO}/public/script-report-paths`),
    port: await import(`${STUDIO}/public/script-reports`),
    instance: (await import(`${STUDIO}/public/session-notifications`)).studioInstanceId,
    wrapper: await import(`${HERMES}/services/script-reports/wrapper`),
    jobs: await import(`${HERMES}/services/script-reports/native-jobs`),
  }
  m.port.setScriptReportJobInspector(m.jobs.readNativeJob)
  member = m.users.createUser({ username: 'member', password: 'password-1', role: 'admin', status: 'active', profiles: ['default'] })
  const outsider = m.users.createUser({ username: 'outsider', password: 'password-1', role: 'admin', status: 'active', profiles: ['other'] })
  memberToken = await m.auth.issueUserJwt(member)
  outsiderToken = await m.auth.issueUserJwt(outsider)
  m.store.createSession({ id: 'chat-1', profile: 'default', source: 'cli', studio_user_id: String(member.id), title: 'Reports' })

  const { sessionRoutes } = await import(`${STUDIO}/routes/sessions`)
  // Test-only trigger (not an app endpoint): the same public port the chat-run import timer calls.
  const fixture = new Router()
  fixture.post('/__test__/script-reports/import', ctx => {
    const result = m.port.importScriptReports()
    ctx.body = { accepted: result.accepted.length, processed: result.processed }
  })
  const app = new Koa()
  app.use(m.auth.requireUserJwt)
  app.use(m.auth.resolveUserProfile)
  app.use(fixture.routes())
  app.use(sessionRoutes.routes())
  server = app.listen(0, '127.0.0.1')
  await new Promise(done => server.once('listening', done))
  origin = `http://127.0.0.1:${(server.address() as any).port}`
})

afterAll(async () => {
  await new Promise(done => server.close(done))
  rmSync(root, { recursive: true, force: true })
})

function saveJobs() { mkdirSync(join(hermesHome, 'cron'), { recursive: true }); writeFileSync(join(hermesHome, 'cron', 'jobs.json'), JSON.stringify({ jobs })) }

/** An active detached binding as enrollment leaves it. */
function bind() {
  const target = join(hermesHome, 'scripts', 'reports', 'launcher.sh')
  const bindingId = randomUUID()
  const wrapperScript = `ekko-script-reports/${bindingId}.py`
  for (const dir of [m.paths.scriptReportBindingDir(bindingId), m.paths.scriptReportSpoolDir(bindingId), join(hermesHome, 'scripts', 'ekko-script-reports'),
    m.paths.scriptReportOutboxDir(bindingId), m.paths.scriptReportReceiptsDir(bindingId)]) { mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700) }
  const manifest = m.paths.scriptReportManifestPath(bindingId, 1)
  writeFileSync(manifest, JSON.stringify({ schema_version: 1, binding_id: bindingId, binding_revision: 1,
    target: { path: target, kind: 'bash', cwd: join(hermesHome, 'scripts', 'reports') },
    target_sha256: createHash('sha256').update(readFileSync(target)).digest('hex'), spool_dir: m.paths.scriptReportSpoolDir(bindingId),
    revoked_marker: m.paths.scriptReportRevokedMarker(bindingId), max_pending: 200, completion: 'detached',
    outbox_dir: m.paths.scriptReportOutboxDir(bindingId), receipts_dir: m.paths.scriptReportReceiptsDir(bindingId) }), { mode: 0o600 })
  writeFileSync(join(hermesHome, 'scripts', wrapperScript), m.wrapper.renderWrapper(manifest), { mode: 0o700 })
  m.reports.insertScriptReportBinding({ binding_id: bindingId, revision: 1, namespace: m.instance(), profile: 'default',
    session_id: 'chat-1', session_generation: m.store.getSessionGeneration('chat-1'), account_id: member.id,
    job_name: 'Daily digest', target_script: 'reports/launcher.sh', wrapper_script: wrapperScript, completion: 'detached' })
  const jobId = `job-${bindingId.slice(0, 8)}`
  m.reports.transitionScriptReportBinding(bindingId, ['enrolling'], 'active', { job_id: jobId })
  jobs.push({ id: jobId, script: wrapperScript, no_agent: true, deliver: 'local', enabled: true })
  saveJobs()
  return m.reports.getScriptReportBinding(bindingId)
}

const wrapperOf = (binding: any) => join(hermesHome, 'scripts', binding.wrapper_script)
/** A reserved detached invocation, exactly as the wrapper leaves it after a clean launcher exit. */
function reserve(binding: any): string {
  const out = spawnSync(PYTHON, ['-c', [
    'import importlib.util, time, uuid',
    `spec = importlib.util.spec_from_file_location("w", ${JSON.stringify(wrapperOf(binding))})`,
    'w = importlib.util.module_from_spec(spec); spec.loader.exec_module(w)',
    'i = str(uuid.uuid4()); w.reserve_invocation(w.load_manifest(w.MANIFEST_PATH), i, time.time()); print(i)',
  ].join('\n')], { encoding: 'utf8' })
  expect(out.status, out.stderr).toBe(0)
  return out.stdout.trim()
}
/** The repository producer: the wrapper's completion helper. */
function helper(binding: any, args: string[], input?: string, env: Record<string, string> = {}) {
  const result = spawnSync(PYTHON, [wrapperOf(binding), ...args], { encoding: 'utf8', input, env: { ...process.env, ...env } })
  return { status: result.status, json: JSON.parse(result.stdout || '{}') }
}
const receipt = (binding: any, invocation: string) => {
  const path = join(m.paths.scriptReportReceiptsDir(binding.binding_id), `${invocation}.json`)
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
}

async function importOverHttp() {
  const response = await fetch(`${origin}/__test__/script-reports/import`, { method: 'POST', headers: { authorization: `Bearer ${memberToken}` } })
  expect(response.status).toBe(200)
  return await response.json() as { accepted: number; processed: number }
}
async function sessionNotices(token = memberToken) {
  const response = await fetch(`${origin}/api/studio/sessions/conversations/chat-1/messages/paginated?offset=0&limit=50`, { headers: { authorization: `Bearer ${token}` } })
  const body = await response.json().catch(() => null) as any
  return { status: response.status, notices: (body?.messages ?? []).filter((message: any) => message.studio_notice?.kind === 'script_report'), body }
}

describe('detached script report import read back over HTTP', { timeout: 30_000 }, () => {
  let binding: any
  let invocation: string
  const content = '**Daily digest** <b>3 items</b>'

  it('imports a detached completion through the public port and serves it as a passive notice', async () => {
    binding = bind()
    invocation = reserve(binding)
    const submitted = helper(binding, ['complete', '--event-id', 'digest:2026-11-10', '--content-file', '-'], content,
      { EKKO_SCRIPT_REPORT_INVOCATION: invocation })
    // Published and waiting for Studio's receipt: the helper reports it as queued (exit 3).
    expect(submitted).toMatchObject({ status: 3, json: { status: 'queued' } })
    expect(await importOverHttp()).toMatchObject({ accepted: 1 })

    const { status, notices, body } = await sessionNotices()
    expect(status).toBe(200)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ role: 'system', content, studio_notice: { kind: 'script_report', identity_kind: 'wrapper_invocation',
      invocation_id: invocation, job_name: 'Daily digest', outcome: 'output' } })
    // Passive: the stored conversation has no message rows, only the merged notice.
    expect(body.messages.filter((message: any) => !message.studio_notice)).toEqual([])
    expect(m.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id='chat-1'").get().n).toBe(0)

    const sha = createHash('sha256').update(content).digest('hex')
    expect(receipt(binding, invocation)).toMatchObject({ binding_id: binding.binding_id, session_id: 'chat-1', invocation_id: invocation,
      event_id: 'digest:2026-11-10', state: 'accepted', outcome: 'output', notification_id: expect.any(Number),
      submitted_sha256: sha, accepted_sha256: sha, exact: true })
    expect(helper(binding, ['receipt', '--event-id', 'digest:2026-11-10'])).toMatchObject({ status: 0, json: { status: 'accepted' } })
  })

  it('a replayed import and an identical retry add no second visible notice', async () => {
    expect(await importOverHttp()).toMatchObject({ accepted: 0 })
    const retry = reserve(binding)
    helper(binding, ['complete', '--event-id', 'digest:2026-11-10', '--content-file', '-'], content, { EKKO_SCRIPT_REPORT_INVOCATION: retry })
    await importOverHttp()
    expect((await sessionNotices()).notices).toHaveLength(1)
    expect(receipt(binding, retry)).toMatchObject({ invocation_id: retry, event_id: 'digest:2026-11-10', retry_of: invocation })
  })

  it('an account without the session\'s profile is refused before any session data is returned', async () => {
    // Cross-profile denial by the sessions route's profile access check; this does not test same-profile ownership.
    const { status, notices, body } = await sessionNotices(outsiderToken)
    expect(status).toBe(403)
    expect(body).toEqual({ error: 'Profile "default" is not available for this user' })
    expect(notices).toEqual([])
  })

  it('a history reset, a disabled account and a revoked binding fail closed with rejection receipts', async () => {
    const send = (event: string) => {
      const id = reserve(binding)
      helper(binding, ['complete', '--event-id', event, '--content-file', '-'], `body ${event}`, { EKKO_SCRIPT_REPORT_INVOCATION: id })
      return id
    }
    m.store.clearSessionMessages('chat-1') // rotates the frozen generation
    const reset = send('reset-day')
    await importOverHttp()
    expect(receipt(binding, reset)).toMatchObject({ state: 'rejected', notification_id: null })
    expect(helper(binding, ['receipt', '--event-id', 'reset-day'])).toMatchObject({ status: 4, json: { status: 'rejected' } })

    const fresh = bind()
    m.users.updateUser({ userId: member.id, status: 'disabled' })
    const id = reserve(fresh)
    helper(fresh, ['complete', '--event-id', 'disabled-day', '--content-file', '-'], 'body disabled-day', { EKKO_SCRIPT_REPORT_INVOCATION: id })
    m.port.importScriptReports() // the member's token is refused while disabled; trigger the same port directly
    expect(receipt(fresh, id)).toMatchObject({ state: 'rejected', notification_id: null })
    m.users.updateUser({ userId: member.id, status: 'active' })

    const revokedBinding = bind()
    m.reports.transitionScriptReportBinding(revokedBinding.binding_id, ['active'], 'revoked')
    const revoked = reserve(revokedBinding)
    helper(revokedBinding, ['complete', '--event-id', 'revoked-day', '--content-file', '-'], 'body revoked-day', { EKKO_SCRIPT_REPORT_INVOCATION: revoked })
    await importOverHttp()
    expect(helper(revokedBinding, ['receipt', '--event-id', 'revoked-day']).json).toMatchObject({ status: 'rejected', receipt: { reason: 'binding_revoked' } })

    // Nothing was rerouted or added: the reset session shows no notice from before or after.
    const { status, notices } = await sessionNotices()
    expect(status).toBe(200)
    expect(notices).toHaveLength(0)
  })
})
