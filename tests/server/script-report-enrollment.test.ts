import './fixtures/isolated-studio-state'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import Koa from 'koa'

// Opt-in enrollment through the production auth middleware, routes and enrollment service. Only the
// native `hermes cron` CLI is simulated: it records its calls and, like Hermes' create-time lifecycle
// guard, refuses a script containing a gateway lifecycle command.
const STUDIO = '../../packages/server/src/modules/studio'
const HERMES = '../../packages/server/src/modules/hermes'
const PYTHON = process.env.SCRIPT_REPORT_TEST_PYTHON || 'python3'

let server: Server
let origin: string
let root: string
let hermesHome: string
let m: any
const cli: { calls: string[][]; jobs: any[]; createGate?: Promise<void>; editGate?: Promise<void>; failResume?: boolean } = { calls: [], jobs: [] }
const users: Record<string, { id: number; token: string; modelRun: string }> = {}

function saveJobs() { mkdirSync(join(hermesHome, 'cron'), { recursive: true }); writeFileSync(join(hermesHome, 'cron', 'jobs.json'), JSON.stringify({ jobs: cli.jobs })) }

beforeEach(async () => {
  vi.resetModules()
  root = realpathSync(mkdtempSync(join(tmpdir(), 'script-report-enroll-')))
  hermesHome = join(root, 'hermes')
  mkdirSync(join(hermesHome, 'scripts', 'reports'), { recursive: true })
  writeFileSync(join(hermesHome, 'scripts', 'reports', 'digest.py'), 'print("digest ready")\n')
  writeFileSync(join(hermesHome, 'scripts', 'reports', 'restart.sh'), 'hermes gateway restart\n')
  vi.stubEnv('AUTH_JWT_SECRET', 'script-report-test-secret')
  vi.stubEnv('HERMES_WEB_UI_HOME', join(root, 'studio'))
  vi.stubEnv('HERMES_HOME', hermesHome)
  vi.stubEnv('HERMES_WEB_UI_TEST_DB_DIR', join(root, 'db'))
  cli.calls = []; cli.jobs = []; cli.createGate = undefined; cli.editGate = undefined; cli.failResume = false
  vi.doMock(`${HERMES}/services/runtime/process`, () => ({
    execHermesWithBin: async (_bin: string, args: string[], options: any) => {
      cli.calls.push(args.slice(1))
      expect(options.env.HERMES_HOME).toBe(hermesHome)
      const [, command, , , ...rest] = args
      const flag = (name: string) => rest[rest.indexOf(name) + 1]
      if (command === 'create') {
        await cli.createGate
        const script = readFileSync(join(hermesHome, 'scripts', flag('--script')), 'utf8')
        if (script.includes('gateway restart')) throw Object.assign(new Error('failed'), { stderr: 'Failed to create job: Blocked: gateway lifecycle command' })
        const id = `job${cli.jobs.length + 1}`
        cli.jobs.push({ id, name: flag('--name'), script: flag('--script'), no_agent: rest.includes('--no-agent'), deliver: flag('--deliver'),
          enabled: !rest.includes('--paused') })
        saveJobs()
        return { stdout: `\u001b[32mCreated job: ${id}\u001b[0m\n`, stderr: '' }
      }
      const job = cli.jobs.find(item => item.id === rest[0])
      if (command === 'edit') { await cli.editGate; job.script = flag('--script') }
      if (command === 'resume') { if (cli.failResume) throw new Error('resume refused'); job.enabled = true }
      if (command === 'pause') job.enabled = false
      saveJobs()
      return { stdout: '', stderr: '' }
    },
  }))
  const { initAllHermesTables } = await import(`${STUDIO}/infrastructure/database/schemas`)
  initAllHermesTables()
  m = {
    db: (await import(`${STUDIO}/infrastructure/database/index`)).getDb(),
    store: await import(`${STUDIO}/repositories/session-store`),
    reports: await import(`${STUDIO}/repositories/script-report-store`),
    importer: await import(`${STUDIO}/services/session-notifications/script-reports`),
    users: await import(`${STUDIO}/repositories/users-store`),
    auth: await import(`${STUDIO}/middleware/auth`),
    paths: await import(`${STUDIO}/public/script-report-paths`),
    jobs: await import(`${HERMES}/services/script-reports/native-jobs`),
  }
  ;(await import(`${STUDIO}/repositories/session-notification-store`)).getSessionNotificationById(0)
  m.importer.setScriptReportJobInspector(m.jobs.readNativeJob)
  for (const [name, profiles] of [['member', ['default']], ['outsider', ['other']]] as const) {
    const user = m.users.createUser({ username: name, password: 'password-1', role: 'admin', status: 'active', profiles: [...profiles] })
    users[name] = { id: user.id, token: await m.auth.issueUserJwt(user), modelRun: await m.auth.issueModelRunJwt(user) }
  }
  m.store.createSession({ id: 'chat-1', profile: 'default', source: 'cli' })
  m.store.createSession({ id: 'ekko-1', profile: 'default', source: 'builtin_agent', agent: 'ekko-agent' })
  const { createRequestBodyParser } = await import(`${STUDIO}/middleware/request-body-parser`)
  const { scriptReportRoutes } = await import(`${HERMES}/routes/script-reports`)
  const app = new Koa()
  app.use(createRequestBodyParser())
  app.use(m.auth.requireUserJwt)
  app.use(m.auth.resolveUserProfile)
  app.use(scriptReportRoutes.routes())
  server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  origin = `http://127.0.0.1:${(server.address() as any).port}`
})

afterEach(async () => {
  await new Promise(resolve => server.close(resolve))
  vi.unstubAllEnvs()
  vi.doUnmock(`${HERMES}/services/runtime/process`)
  rmSync(root, { recursive: true, force: true })
})

async function post(path: string, body: unknown, token = users.member.token) {
  const response = await fetch(`${origin}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json().catch(() => null) as any }
}
const generation = (sessionId = 'chat-1') => m.store.getSessionGeneration(sessionId)
const enroll = (overrides: Record<string, unknown> = {}, token?: string) => post('/api/hermes/script-reports/enrollments', {
  profile: 'default', session_id: 'chat-1', expected_session_generation: generation(), name: 'Daily digest', schedule: 'every 1h',
  script: 'reports/digest.py', ...overrides,
}, token)
const commands = () => cli.calls.map(call => call[0])

describe('script report enrollment', () => {
  it('Hermes validates the original target at create, then the job is pointed at the wrapper and resumed', async () => {
    const result = await enroll()
    expect(result.status).toBe(201)
    const binding = result.body.binding
    expect(commands()).toEqual(['create', 'edit', 'resume'])
    expect(cli.calls[0]).toEqual(expect.arrayContaining(['--no-agent', '--paused', '--deliver', 'local', '--script', 'reports/digest.py']))
    expect(cli.calls[1]).toEqual(['edit', '--profile', 'default', 'job1', '--script', binding.wrapper_script])
    expect(binding).toMatchObject({ state: 'active', job_id: 'job1', session_generation: generation(), target_script: 'reports/digest.py',
      wrapper_script: `ekko-script-reports/${binding.binding_id}.py`, identity_kind: 'wrapper_invocation' })
    expect(result.body.job).toMatchObject({ id: 'job1', enabled: true, script: binding.wrapper_script })
    expect(statSync(m.paths.scriptReportManifestPath(binding.binding_id, 1)).mode & 0o777).toBe(0o600)
    expect(statSync(m.paths.scriptReportsRoot()).mode & 0o777).toBe(0o700)
  })

  it('a target refused by the native lifecycle guard creates nothing and leaves no wrapper', async () => {
    const refused = await enroll({ script: 'reports/restart.sh' })
    expect(refused.body).toMatchObject({ error: 'native_create_rejected' })
    expect(refused.status).toBe(422)
    expect(commands()).toEqual(['create'])
    expect(cli.jobs).toEqual([])
    expect(existsSync(join(hermesHome, 'scripts', 'ekko-script-reports')) ? readdirSync(join(hermesHome, 'scripts', 'ekko-script-reports')) : []).toEqual([])
  })

  it('a revoke during enrollment waits for it, then pauses the recorded job; nothing runs unreported', async () => {
    let release!: () => void
    cli.createGate = new Promise(resolve => { release = resolve })
    const enrolling = enroll()
    await vi.waitFor(() => expect(m.reports.listScriptReportBindings((m.db.prepare('SELECT namespace FROM script_report_bindings').get() as any)?.namespace ?? '')).toHaveLength(1))
    const [pending] = m.db.prepare('SELECT binding_id FROM script_report_bindings').all() as any[]
    const revoking = post(`/api/hermes/script-reports/enrollments/${pending.binding_id}/revoke`, {})
    // Let the revoke reach the server while the native create is still pending.
    await new Promise(resolve => setTimeout(resolve, 1500))
    expect(m.reports.getScriptReportBinding(pending.binding_id).state).toBe('enrolling')
    release()
    const [enrolled, revoked] = await Promise.all([enrolling, revoking])
    expect(enrolled.status).toBe(201)
    expect(revoked.body).toMatchObject({ binding: { state: 'revoked', job_id: 'job1' }, native_job_paused: true })
    expect(commands()).toEqual(['create', 'edit', 'resume', 'pause'])
    expect(cli.jobs[0].enabled).toBe(false)
  })

  it('a binding revoked before activation is never resumed and keeps its job id', async () => {
    let release!: () => void
    cli.editGate = new Promise(resolve => { release = resolve })
    const enrolling = enroll()
    await vi.waitFor(() => expect(commands()).toContain('edit'))
    const [pending] = m.db.prepare('SELECT binding_id FROM script_report_bindings').all() as any[]
    // Revoked outside this enrollment (no shared lock), between native configuration and activation.
    m.reports.transitionScriptReportBinding(pending.binding_id, ['enrolling'], 'revoked')
    release()
    const result = await enrolling
    expect(result).toMatchObject({ status: 409, body: { error: 'binding_revoked', job_id: 'job1' } })
    expect(commands()).toEqual(['create', 'edit'])
    expect(cli.jobs[0].enabled).toBe(false)
    expect(m.reports.getScriptReportBinding(pending.binding_id)).toMatchObject({ state: 'revoked', job_id: 'job1' })
  })

  it('requires an interactive login token and fences the destination before any write', async () => {
    expect((await enroll({}, users.member.modelRun)).status).toBe(403)
    expect((await enroll({ expected_session_generation: 'stale' })).body.error).toBe('session_generation_mismatch')
    expect((await enroll({}, users.outsider.token)).status).toBe(403)
    expect((await enroll({ session_id: 'ekko-1', expected_session_generation: generation('ekko-1') })).body.error).toBe('unsupported_notification_target')
    expect((await enroll({ session_id: 'missing' })).body.error).toBe('session_not_found')
    expect(cli.calls).toEqual([])
  })

  it('accepts only a script inside the profile scripts directory', async () => {
    writeFileSync(join(root, 'outside.py'), 'print(1)\n')
    symlinkSync(join(root, 'outside.py'), join(hermesHome, 'scripts', 'escape.py'))
    for (const [script, error] of [['../outside.py', 'invalid_script'], ['/etc/hosts', 'invalid_script'], ['escape.py', 'script_outside_scripts_dir'],
      ['reports/missing.py', 'script_not_found'], ['reports/digest.rb', 'unsupported_script_type']] as const) {
      expect((await enroll({ script })).body.error, script).toBe(error)
    }
    expect(cli.calls).toEqual([])
  })

  it('uses the interpreter of the resolved target behind an in-directory symlink alias', async () => {
    symlinkSync(join(hermesHome, 'scripts', 'reports', 'digest.py'), join(hermesHome, 'scripts', 'reports', 'alias.sh'))
    const { status, body } = await enroll({ script: 'reports/alias.sh' })
    expect(status).toBe(201)
    expect(cli.calls[0]).toEqual(expect.arrayContaining(['--script', 'reports/digest.py']))
    const manifest = JSON.parse(readFileSync(m.paths.scriptReportManifestPath(body.binding.binding_id, 1), 'utf8'))
    expect(manifest.target).toMatchObject({ kind: 'python', path: join(hermesHome, 'scripts', 'reports', 'digest.py') })
    const run = spawnSync(PYTHON, [join(hermesHome, 'scripts', body.binding.wrapper_script)], { cwd: join(hermesHome, 'scripts', 'ekko-script-reports'), encoding: 'utf8' })
    expect(run).toMatchObject({ status: 0, stdout: 'digest ready\n' })
  })

  it('leaves the job paused when resume fails', async () => {
    cli.failResume = true
    const failed = await enroll()
    expect(failed.body).toMatchObject({ error: 'native_resume_failed', job_id: 'job1' })
    expect(cli.jobs[0].enabled).toBe(false)
  })

  it('end to end: an enrolled wrapper run by its native script path reaches the session; health lists it', async () => {
    const { body } = await enroll()
    const run = spawnSync(PYTHON, [join(hermesHome, 'scripts', body.binding.wrapper_script)], { cwd: join(hermesHome, 'scripts', 'ekko-script-reports'), encoding: 'utf8' })
    expect(run.stdout).toBe('digest ready\n')
    m.importer.importScriptReports()
    const rows = m.db.prepare("SELECT disposition, payload FROM session_notifications").all() as any[]
    expect(rows.map(row => [row.disposition, JSON.parse(row.payload).content])).toEqual([['notified', 'digest ready']])
    const list = await fetch(`${origin}/api/hermes/script-reports/enrollments?profile=default`, { headers: { authorization: `Bearer ${users.member.token}` } })
    const [health] = (await list.json() as any).bindings
    expect(health).toMatchObject({ state: 'active', imported: { accepted: 1 }, incomplete: [] })
    const revoked = await post(`/api/hermes/script-reports/enrollments/${body.binding.binding_id}/revoke`, {})
    expect(revoked.body).toMatchObject({ binding: { state: 'revoked' }, native_job_paused: true })
  })
})
