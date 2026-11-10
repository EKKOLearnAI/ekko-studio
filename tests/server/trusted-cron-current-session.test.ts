import './fixtures/isolated-studio-state'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import Koa from 'koa'

// Trusted current-session admission through the real cron-consent router, trusted controller and
// admission service. The native `hermes cron` CLI is simulated, and the admission credential is a
// FIXTURE hook: it sets ctx.state.cronAdmission from a real issued capability, standing in for the
// managed-MCP authentication that is not wired on this branch.
const STUDIO = '../../packages/server/src/modules/studio'
const HERMES = '../../packages/server/src/modules/hermes'
const PYTHON = process.env.SCRIPT_REPORT_TEST_PYTHON || 'python3'

let server: Server
let origin: string
let root: string
let hermesHome: string
let m: any
let authority: Record<string, unknown> | null = null
const cli: { calls: string[][]; jobs: any[]; createGate?: Promise<void>; editGate?: Promise<void>; failResume?: boolean; onResume?: () => void; resumeCommitsThenFails?: boolean; failPause?: boolean; corruptOnResume?: boolean; corruptOnPause?: boolean; corruptAfterResume?: boolean; corruptAfterCreate?: boolean; resumeNoop?: boolean } = { calls: [], jobs: [] }
const users: Record<string, { id: number; token: string; modelRun: string }> = {}

function corruptJobs() { writeFileSync(join(hermesHome, 'cron', 'jobs.json'), '{ not json') }
function saveJobs() { mkdirSync(join(hermesHome, 'cron'), { recursive: true }); writeFileSync(join(hermesHome, 'cron', 'jobs.json'), JSON.stringify({ jobs: cli.jobs })) }

beforeEach(async () => {
  vi.resetModules()
  root = realpathSync(mkdtempSync(join(tmpdir(), 'script-report-enroll-')))
  hermesHome = join(root, 'hermes')
  mkdirSync(join(hermesHome, 'scripts', 'reports'), { recursive: true })
  writeFileSync(join(hermesHome, 'scripts', 'reports', 'digest.py'), 'print("digest ready")\n')
  writeFileSync(join(hermesHome, 'scripts', 'reports', 'legacy.py'), 'print("legacy")\n')
  vi.stubEnv('AUTH_JWT_SECRET', 'script-report-test-secret')
  vi.stubEnv('HERMES_WEB_UI_HOME', join(root, 'studio'))
  vi.stubEnv('HERMES_HOME', hermesHome)
  vi.stubEnv('HERMES_WEB_UI_TEST_DB_DIR', join(root, 'db'))
  cli.calls = []; cli.jobs = []; cli.createGate = undefined; cli.editGate = undefined; cli.failResume = false; cli.onResume = undefined; cli.resumeCommitsThenFails = false; cli.failPause = false; cli.corruptOnResume = false; cli.corruptOnPause = false; cli.corruptAfterResume = false; cli.corruptAfterCreate = false; cli.resumeNoop = false
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
        if (cli.corruptAfterCreate) corruptJobs()
        return { stdout: `\u001b[32mCreated job: ${id}\u001b[0m\n`, stderr: '' }
      }
      const job = cli.jobs.find(item => item.id === rest[0])
      if (command === 'edit') { await cli.editGate; job.script = flag('--script') }
      if (command === 'resume') {
        cli.onResume?.()
        if (cli.failResume) throw new Error('resume refused')
        if (!cli.resumeNoop) job.enabled = true
        // Like a CLI that commits the change and then times out.
        if (cli.resumeCommitsThenFails) { saveJobs(); if (cli.corruptOnResume) corruptJobs(); throw new Error('resume timed out') }
      }
      if (command === 'pause') { if (cli.failPause) throw new Error('pause refused'); job.enabled = false }
      saveJobs()
      if (command === 'pause' && cli.corruptOnPause) corruptJobs()
      if (command === 'resume' && cli.corruptAfterResume) corruptJobs()
      return { stdout: '', stderr: '' }
    },
  }))
  // The native lifecycle-guard child is simulated too, accepting the target (as in cron-consent.test.ts).
  vi.doMock(`${HERMES}/services/script-reports/native-guard`, () => ({ defaultNativeLifecycleGuard: async () => ({ ok: true }) }))
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
  const { cronConsentRoutes } = await import(`${HERMES}/routes/cron-consent`)
  m.trusted = await import(`${STUDIO}/public/trusted-cron`)
  const app = new Koa()
  app.use(createRequestBodyParser())
  app.use(m.auth.requireUserJwt)
  app.use(m.auth.resolveUserProfile)
  app.use(async (ctx, next) => { if (authority) ctx.state.cronAdmission = authority; await next() })
  app.use(cronConsentRoutes.routes())
  server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  origin = `http://127.0.0.1:${(server.address() as any).port}`
})

afterEach(async () => {
  await new Promise(resolve => server.close(resolve))
  vi.unstubAllEnvs()
  vi.doUnmock(`${HERMES}/services/runtime/process`)
  vi.doUnmock(`${HERMES}/services/script-reports/native-guard`)
  rmSync(root, { recursive: true, force: true })
})

function admitAs(sessionId = 'chat-1') {
  const accountId = users.member.id
  const policy = m.trusted.updateTrustedCronPolicy(accountId, 'default', true, m.trusted.trustedCronPolicy(accountId, 'default').revision)
  const token = m.trusted.issueTrustedCronCapability({ accountId, profile: 'default', sessionId, isActive: () => true, singleUse: true })
  expect(token).toEqual(expect.any(String))
  authority = { accountId, profile: 'default', sessionId, generation: m.store.getSessionGeneration(sessionId), epoch: (policy?.epoch ?? m.trusted.trustedCronPolicy(accountId, 'default').epoch), token, isActive: () => true }
}
async function admit(body: Record<string, unknown>) {
  const response = await fetch(`${origin}/api/hermes/cron/current-session`, { method: 'POST',
    headers: { authorization: `Bearer ${users.member.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ profile: 'default', ...body }) })
  return { status: response.status, body: await response.json().catch(() => null) as any }
}
const fresh = { kind: 'script_report_enrollment', name: 'Daily digest', schedule: 'every 1h', script: 'reports/digest.py' }
const commands = () => cli.calls.map(call => call[0])

describe('trusted current-session admission route', () => {
  beforeEach(() => { authority = null })

  it('refuses without the admission authority', async () => {
    expect(await admit(fresh)).toEqual({ status: 403, body: { error: 'trusted_capability_required' } })
    expect(cli.calls).toEqual([])
  })

  it('new enrollment: an unreadable snapshot after a successful resume returns native_state unknown with the job id', async () => {
    admitAs(); cli.corruptAfterResume = true
    const result = await admit(fresh)
    expect(commands()).toEqual(['create', 'edit', 'resume'])
    expect(result.status).toBe(201)
    expect(result.body).toMatchObject({ status: 'admitted', kind: 'script_report_enrollment', session_id: 'chat-1', job_id: 'job1', resumed: true, native_state: 'unknown' })
  })

  it('existing job: an unreadable snapshot after a successful resume returns native_state unknown with the job id', async () => {
    cli.jobs.push({ id: 'legacy1', name: 'Legacy', script: 'reports/legacy.py', no_agent: true, deliver: 'local', enabled: true }); saveJobs()
    admitAs(); cli.corruptAfterResume = true
    const result = await admit({ kind: 'script_report_enrollment', mode: 'existing', job_id: 'legacy1' })
    expect(result.status).toBe(201)
    expect(result.body).toMatchObject({ status: 'admitted', kind: 'script_report_enrollment', session_id: 'chat-1', job_id: 'legacy1', resumed: true, native_state: 'unknown' })
  })

  it('reconciliation: an acknowledged resume that leaves the job paused reports native_state paused with the job id', async () => {
    admitAs(); cli.resumeNoop = true
    const result = await admit(fresh)
    expect(result).toEqual({ status: 502, body: { error: 'native_resume_failed', job_id: 'job1', native_state: 'paused' } })
  })

  it('reconciliation: a policy revoked during a successful resume, unreadable and unconfirmed pause, keeps the refusal, job id and native_state unknown', async () => {
    admitAs(); cli.corruptAfterResume = true; cli.corruptOnPause = true
    // Real policy API: the resume itself succeeds, then the admission epoch is no longer current.
    cli.onResume = () => { const accountId = users.member.id; m.trusted.updateTrustedCronPolicy(accountId, 'default', false, m.trusted.trustedCronPolicy(accountId, 'default').revision) }
    const result = await admit(fresh)
    expect(commands()).toEqual(['create', 'edit', 'resume', 'pause'])
    expect(result).toEqual({ status: 403, body: { error: 'trusted_policy_changed', job_id: 'job1', native_state: 'unknown' } })
  })

  // Native admission authentication: the issued Cron admission credential itself, no fixture hook.
  function nativeCredential() {
    const accountId = users.member.id
    m.trusted.updateTrustedCronPolicy(accountId, 'default', true, m.trusted.trustedCronPolicy(accountId, 'default').revision)
    const token = m.trusted.issueTrustedCronCapability({ accountId, profile: 'default', sessionId: 'chat-1', isActive: () => true, contextId: 'dispatch-1', singleUse: true })
    expect(token).toEqual(expect.any(String))
    return token as string
  }
  async function nativeAdmit(token: string, body: Record<string, unknown>, path = '/api/hermes/cron/current-session', context = 'dispatch-1') {
    const response = await fetch(`${origin}${path}`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'x-studio-run-context': context, 'content-type': 'application/json' }, body: JSON.stringify({ profile: 'default', ...body }) })
    return { status: response.status, body: await response.json().catch(() => null) as any }
  }

  it('native credential: refused off its admission route or run context, before any native call', async () => {
    const token = nativeCredential()
    expect((await nativeAdmit(token, fresh, '/api/hermes/cron/trusted-automation')).status).toBe(403)
    expect((await nativeAdmit(token, { ...fresh, profile: 'other' })).status).toBe(403)
    expect(cli.calls).toEqual([])
  })

  it('native credential: the capability alone authorizes its route, without a run-context header', async () => {
    const token = nativeCredential(); cli.corruptAfterResume = true
    const response = await fetch(`${origin}/api/hermes/cron/current-session`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ profile: 'default', ...fresh }) })
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ status: 'admitted', job_id: 'job1', native_state: 'unknown' })
  })

  it('native credential: unknown snapshot after a successful resume returns the exact job id', async () => {
    const token = nativeCredential(); cli.corruptAfterResume = true
    const result = await nativeAdmit(token, fresh)
    expect(result.status).toBe(201)
    expect(result.body).toMatchObject({ status: 'admitted', session_id: 'chat-1', job_id: 'job1', native_state: 'unknown' })
    // Single use: the same credential cannot admit again.
    expect((await nativeAdmit(token, fresh)).body).toEqual({ error: 'capability_claimed' })
  })

  it('native credential: a still-paused reconciliation returns native_state paused with the job id', async () => {
    const token = nativeCredential(); cli.resumeNoop = true
    expect(await nativeAdmit(token, fresh)).toEqual({ status: 502, body: { error: 'native_resume_failed', job_id: 'job1', native_state: 'paused' } })
  })

  // Public login dispatch -> real ChatRunSocket.dispatchCurrentSessionCron -> SIMULATED Bridge: it forwards
  // the issued capability to the real admission route as the managed MCP would, then returns the envelope.
  async function dispatchVia(body: Record<string, unknown>) {
    const { ChatRunSocket } = await import(`${STUDIO}/sockets/chat-run`)
    const { setChatRunServer } = await import(`${STUDIO}/services/chat-run/server-registry`)
    const { runMcpCredentials } = await import(`${STUDIO}/services/auth/run-mcp-credentials`)
    const runtime = await import(`${STUDIO}/public/chat-agent-runtime`)
    const seen: string[] = []
    let envelope: unknown
    vi.spyOn(runtime, 'createPrimaryAgentBridge').mockReturnValue({
      studioCronDispatch: async (_profile: string, _session: string, capability: string, fixed: Record<string, unknown>) => {
        seen.push(capability)
        const admitted = await nativeAdmit(capability, fixed, undefined, runMcpCredentials.authenticate(capability)!.contextId)
        envelope = { result: JSON.stringify(admitted) }
        return { ok: true, run_id: 'run-1', status: 'running' }
      },
      getResult: async () => ({ status: 'complete', result: { output: JSON.stringify(envelope) } }),
    } as any)
    setChatRunServer(Object.create(ChatRunSocket.prototype))
    const accountId = users.member.id
    m.trusted.updateTrustedCronPolicy(accountId, 'default', true, m.trusted.trustedCronPolicy(accountId, 'default').revision)
    const response = await fetch(`${origin}/api/hermes/cron/current-session/dispatch`, { method: 'POST',
      headers: { authorization: `Bearer ${users.member.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ profile: 'default', session_id: 'chat-1', ...body }) })
    return { status: response.status, body: await response.json().catch(() => null) as any, seen, revoked: seen.every(token => !runMcpCredentials.authenticate(token)) }
  }

  it('dispatch: the server method returns the admission paused result with the job id, then revokes the capability', async () => {
    cli.resumeNoop = true
    const result = await dispatchVia(fresh)
    expect(result).toMatchObject({ status: 502, body: { error: 'native_resume_failed', job_id: 'job1', native_state: 'paused' }, revoked: true })
    expect(result.seen).toHaveLength(1)
  })

  it('dispatch: an unreadable snapshot after resume returns 201 native_state unknown with the job id', async () => {
    cli.corruptAfterResume = true
    const result = await dispatchVia(fresh)
    expect(result).toMatchObject({ status: 201, body: { status: 'admitted', job_id: 'job1', native_state: 'unknown' }, revoked: true })
  })

  it('dispatch: refuses an unauthenticated caller before any Bridge call', async () => {
    const response = await fetch(`${origin}/api/hermes/cron/current-session/dispatch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile: 'default', session_id: 'chat-1', ...fresh }) })
    expect(response.status).toBe(401)
    expect(cli.calls).toEqual([])
  })

  it('native credential: revoked while the resume is in flight, the admission ends with the job id and its paused state', async () => {
    const token = nativeCredential()
    cli.onResume = () => m.trusted.revokeTrustedCronCapability('chat-1', 'dispatch-1')
    const result = await nativeAdmit(token, fresh)
    expect(result).toEqual({ status: 409, body: { error: 'execution_ended', job_id: 'job1', native_state: 'paused' } })
    expect(commands()).toEqual(['create', 'edit', 'resume', 'pause'])
  })

  it('failed resume: a re-pause that cannot be confirmed reports native_state unknown with the job id', async () => {
    admitAs(); cli.resumeCommitsThenFails = true; cli.corruptOnResume = true; cli.failPause = true
    const result = await admit(fresh)
    expect(result.status).toBe(502)
    expect(result.body).toMatchObject({ error: 'native_resume_failed', job_id: 'job1', native_state: 'unknown' })
  })
})
