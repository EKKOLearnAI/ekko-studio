import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Detached completion on real file storage: the generated wrapper launches a real detached
// launcher, its setsid worker completes the reserved invocation through the wrapper's helper, and
// the importer accepts into the passive inbox and writes the producer-readable receipt.
// Directory fsync faults for the importer only (it imports 'fs'; this file uses 'node:fs').
const fsFaults = vi.hoisted(() => ({ dirSyncs: 0, failDirSync: null as Error | null }))
vi.mock('fs', async importOriginal => {
  const real = await importOriginal<typeof import('fs')>()
  const fsyncSync = (fd: number) => {
    if (real.fstatSync(fd).isDirectory()) {
      fsFaults.dirSyncs++
      if (fsFaults.failDirSync) throw fsFaults.failDirSync
    }
    return real.fsyncSync(fd)
  }
  return { ...real, default: { ...real, fsyncSync }, fsyncSync }
})
const STUDIO = '../../packages/server/src/modules/studio'
const HERMES = '../../packages/server/src/modules/hermes'
const PYTHON = process.env.SCRIPT_REPORT_TEST_PYTHON || 'python3'
const FIXTURE = resolve(__dirname, 'fixtures', 'detached-report')

let root: string
let hermesHome: string
let state: string
let m: any
let member: any
const jobs: any[] = []

beforeEach(async () => {
  fsFaults.dirSyncs = 0
  fsFaults.failDirSync = null
  vi.resetModules()
  jobs.length = 0
  root = realpathSync(mkdtempSync(join(tmpdir(), 'script-report-detached-')))
  hermesHome = join(root, 'hermes')
  state = join(root, 'producer')
  mkdirSync(join(hermesHome, 'scripts', 'reports'), { recursive: true })
  for (const file of ['launcher.sh', 'worker.py']) copyFileSync(join(FIXTURE, file), join(hermesHome, 'scripts', 'reports', file))
  vi.stubEnv('AUTH_JWT_SECRET', 'script-report-test-secret')
  vi.stubEnv('HERMES_WEB_UI_HOME', join(root, 'studio'))
  vi.stubEnv('HERMES_HOME', hermesHome)
  vi.stubEnv('HERMES_WEB_UI_TEST_DB_DIR', join(root, 'db'))
  const { initAllHermesTables } = await import(`${STUDIO}/infrastructure/database/schemas`)
  initAllHermesTables()
  m = {
    db: (await import(`${STUDIO}/infrastructure/database/index`)).getDb(),
    store: await import(`${STUDIO}/repositories/session-store`),
    reports: await import(`${STUDIO}/repositories/script-report-store`),
    importer: await import(`${STUDIO}/services/session-notifications/script-reports`),
    users: await import(`${STUDIO}/repositories/users-store`),
    paths: await import(`${STUDIO}/public/script-report-paths`),
    instance: (await import(`${STUDIO}/public/session-notifications`)).studioInstanceId,
    wrapper: await import(`${HERMES}/services/script-reports/wrapper`),
    jobs: await import(`${HERMES}/services/script-reports/native-jobs`),
  }
  m.importer.setScriptReportJobInspector(m.jobs.readNativeJob)
  ;(await import(`${STUDIO}/repositories/session-notification-store`)).getSessionNotificationById(0)
  member = m.users.createUser({ username: 'member', password: 'password-1', role: 'admin', status: 'active', profiles: ['default'] })
  m.store.createSession({ id: 'chat-1', profile: 'default', source: 'cli' })
})

afterEach(async () => {
  // A worker still holding the fixture lock is left alone by the next test: wait for it.
  for (let i = 0; i < 100 && existsSync(join(state, 'lock')); i++) await sleep(100)
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

const sleep = (ms: number) => new Promise(done => setTimeout(done, ms))
function saveJobs() { mkdirSync(join(hermesHome, 'cron'), { recursive: true }); writeFileSync(join(hermesHome, 'cron', 'jobs.json'), JSON.stringify({ jobs })) }

/** An active binding as enrollment leaves it; `completion: detached` adds the outbox and receipts. */
function bind(script: string, completion: 'sync' | 'detached' = 'detached') {
  const target = join(hermesHome, 'scripts', 'reports', script)
  const bindingId = randomUUID()
  const wrapperScript = `ekko-script-reports/${bindingId}.py`
  const dirs = [m.paths.scriptReportBindingDir(bindingId), m.paths.scriptReportSpoolDir(bindingId), join(hermesHome, 'scripts', 'ekko-script-reports')]
  if (completion === 'detached') dirs.push(m.paths.scriptReportOutboxDir(bindingId), m.paths.scriptReportReceiptsDir(bindingId))
  for (const dir of dirs) { mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700) }
  const manifest = m.paths.scriptReportManifestPath(bindingId, 1)
  writeFileSync(manifest, JSON.stringify({ schema_version: 1, binding_id: bindingId, binding_revision: 1,
    target: { path: target, kind: script.endsWith('.sh') ? 'bash' : 'python', cwd: join(hermesHome, 'scripts', 'reports') },
    target_sha256: createHash('sha256').update(readFileSync(target)).digest('hex'), spool_dir: m.paths.scriptReportSpoolDir(bindingId),
    revoked_marker: m.paths.scriptReportRevokedMarker(bindingId), max_pending: 200,
    ...(completion === 'detached' ? { completion, outbox_dir: m.paths.scriptReportOutboxDir(bindingId), receipts_dir: m.paths.scriptReportReceiptsDir(bindingId) } : {}) }), { mode: 0o600 })
  writeFileSync(join(hermesHome, 'scripts', wrapperScript), m.wrapper.renderWrapper(manifest), { mode: 0o700 })
  m.reports.insertScriptReportBinding({ binding_id: bindingId, revision: 1, namespace: m.instance(), profile: 'default',
    session_id: 'chat-1', session_generation: m.store.getSessionGeneration('chat-1'), account_id: member.id,
    job_name: `Job ${script}`, target_script: `reports/${script}`, wrapper_script: wrapperScript, completion })
  const jobId = `job-${bindingId.slice(0, 8)}`
  m.reports.transitionScriptReportBinding(bindingId, ['enrolling'], 'active', { job_id: jobId })
  jobs.push({ id: jobId, script: wrapperScript, no_agent: true, deliver: 'local', enabled: true })
  saveJobs()
  return m.reports.getScriptReportBinding(bindingId)
}

const wrapperOf = (binding: any) => join(hermesHome, 'scripts', binding.wrapper_script)
/** Run the generated wrapper the way Hermes runs a no_agent script. */
function fire(binding: any, env: Record<string, string> = {}) {
  return spawnSync(PYTHON, [wrapperOf(binding)], { cwd: join(hermesHome, 'scripts', 'ekko-script-reports'), encoding: 'utf8',
    env: { ...process.env, SYNTHETIC_REPORT_STATE: state, SYNTHETIC_REPORT_DAY: '2026-11-04', ...env } })
}
/** The completion helper, as a producer calls it. */
function helper(binding: any, args: string[], input?: string, env: Record<string, string> = {}) {
  const result = spawnSync(PYTHON, [wrapperOf(binding), ...args], { encoding: 'utf8', input, env: { ...process.env, ...env } })
  return { status: result.status, json: JSON.parse(result.stdout || '{}') }
}
const spoolDir = (binding: any) => m.paths.scriptReportSpoolDir(binding.binding_id)
const spool = (binding: any) => existsSync(spoolDir(binding)) ? readdirSync(spoolDir(binding)).filter((name: string) => !name.startsWith('.')) : []
const notices = () => (m.db.prepare("SELECT * FROM session_notifications WHERE kind='script_report' ORDER BY id").all() as any[])
  .map(row => ({ ...row, payload: JSON.parse(row.payload) }))
const receipt = (binding: any, invocation: string) => {
  const path = join(m.paths.scriptReportReceiptsDir(binding.binding_id), `${invocation}.json`)
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
}
async function until<T>(probe: () => T, label: string, ms = 20_000): Promise<T> {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(100)) {
    const value = probe()
    if (value) return value
  }
  throw new Error(`timeout: ${label}`)
}
const finalOf = (binding: any, id: string) => join(spoolDir(binding), id, 'final.json')
const idle = () => until(() => !existsSync(join(state, 'lock')), 'worker exit')

// Real Python and Bash processes per test: a loaded runner can exceed the 5 s default.
describe('detached script report completion', { timeout: 30_000 }, () => {
  it('a silent launcher exit is a handoff; the detached worker delivers the report and receives its receipt', async () => {
    const binding = bind('launcher.sh')
    const gate = join(root, 'release-1')
    const launch = fire(binding, { SYNTHETIC_REPORT_GATE: gate })
    expect(launch).toMatchObject({ status: 0, stdout: '', stderr: '' })
    const [invocation] = spool(binding)
    const dir = join(spoolDir(binding), invocation)
    // The launcher has exited: a handoff is recorded, never a final report, and nothing is imported.
    expect(JSON.parse(readFileSync(join(dir, 'started.json'), 'utf8'))).toMatchObject({ completion: 'detached', invocation_id: invocation })
    expect(JSON.parse(readFileSync(join(dir, 'handoff.json'), 'utf8'))).toMatchObject({ phase: 'handoff', launcher_exit_code: 0 })
    expect(existsSync(join(dir, 'final.json'))).toBe(false)
    expect(m.importer.importScriptReports().processed).toBe(0)
    expect(m.importer.incompleteScriptReports(binding)).toEqual([expect.objectContaining({ invocation_id: invocation, handed_off: true })])
    writeFileSync(gate, '')

    await until(() => existsSync(join(dir, 'final.json')), 'worker completion')
    await idle()
    expect(existsSync(join(state, 'pending.md'))).toBe(true) // queued is not delivered: business state not committed
    expect(m.importer.importScriptReports().accepted).toHaveLength(1)
    const [row] = notices()
    const draft = readFileSync(join(state, 'pending.md'), 'utf8')
    expect(row).toMatchObject({ disposition: 'notified', attention_pending: 1, session_id: 'chat-1' })
    expect(row.payload).toMatchObject({ completion: 'detached', event_id: 'synthetic-daily-report:v1:2026-11-04', invocation_id: invocation,
      retry_of: null, outcome: 'output', content: draft, identity_kind: 'wrapper_invocation', native_execution_id: null })
    expect(draft).toContain('| [SYN-2 \\[flaky\\]](https://example.com/issues/SYN-2) | Done | bob |')
    const sha = createHash('sha256').update(draft).digest('hex')
    expect(receipt(binding, invocation)).toEqual({ schema_version: 1, binding_id: binding.binding_id, binding_revision: 1, job_id: binding.job_id,
      session_id: 'chat-1', session_generation: binding.session_generation, invocation_id: invocation, event_id: 'synthetic-daily-report:v1:2026-11-04',
      retry_of: null, state: 'accepted', outcome: 'output', reason: null, notification_id: row.id, submitted_sha256: sha, accepted_sha256: sha,
      exact: true, settled_at: expect.any(Number) })
    expect(spool(binding)).toEqual([])
    // The next scheduled run retries the identical pending draft (no recomposition) and commits on the receipt.
    fire(binding)
    await idle()
    expect(existsSync(join(state, 'pending.md'))).toBe(false)
    expect(Object.keys(JSON.parse(readFileSync(join(state, 'delivered.json'), 'utf8')))).toEqual(['synthetic-daily-report:v1:2026-11-04'])
    expect(readFileSync(join(state, 'compositions'), 'utf8')).toBe('2026-11-04\n')
    m.importer.importScriptReports()
    expect(notices().filter(item => item.disposition === 'notified')).toHaveLength(1)
    expect(notices().find(item => item.payload.retry_of === invocation)).toMatchObject({ disposition: 'silent', payload: { reason: 'event_retry' } })
  })

  it('a retry after a crash past the envelope publishes the original invocation with identical bytes', async () => {
    const binding = bind('launcher.sh')
    // Crash point: the worker dies after its envelope is durable, before the report exists.
    const first = spawnSync(PYTHON, ['-c', [
      'import importlib.util, os, sys',
      `spec = importlib.util.spec_from_file_location("w", ${JSON.stringify(wrapperOf(binding))})`,
      'w = importlib.util.module_from_spec(spec); spec.loader.exec_module(w)',
      'w._status = lambda *a, **k: os._exit(9)',
      `sys.exit(w.helper(["complete", "--event-id", "e-1", "--content-file", "-"]))`,
    ].join('\n')], { input: 'report body\n', encoding: 'utf8', env: { ...process.env, EKKO_SCRIPT_REPORT_INVOCATION: reserve(binding) } })
    expect(first.status).toBe(9)
    const [original] = spool(binding)
    expect(existsSync(finalOf(binding, original))).toBe(false)
    // Studio settles nothing while the original is incomplete.
    expect(m.importer.importScriptReports().processed).toBe(0)
    const vehicle = reserve(binding)
    const retry = helper(binding, ['complete', '--event-id', 'e-1', '--content-file', '-'], 'report body\n', { EKKO_SCRIPT_REPORT_INVOCATION: vehicle })
    expect(retry).toMatchObject({ status: 3, json: { status: 'queued', invocation_id: original, vehicle_invocation_id: vehicle } })
    m.importer.importScriptReports()
    expect(helper(binding, ['receipt', '--event-id', 'e-1'])).toMatchObject({ status: 0, json: { status: 'accepted', invocation_id: original,
      receipt: { exact: true, event_id: 'e-1', invocation_id: original } } })
    expect(notices().filter(row => row.disposition === 'notified').map(row => [row.payload.invocation_id, row.payload.content])).toEqual([[original, 'report body\n']])
  })

  it('a conflicting resubmission never consumes the original invocation; a pending draft keeps its own event', async () => {
    const binding = bind('launcher.sh')
    const original = reserve(binding)
    const crash = spawnSync(PYTHON, ['-c', [
      'import importlib.util, os, sys',
      `spec = importlib.util.spec_from_file_location("w", ${JSON.stringify(wrapperOf(binding))})`,
      'w = importlib.util.module_from_spec(spec); spec.loader.exec_module(w)',
      'w._status = lambda *a, **k: os._exit(9)',
      'sys.exit(w.helper(["complete", "--event-id", "e-5", "--content-file", "-"]))',
    ].join('\n')], { input: 'original', encoding: 'utf8', env: { ...process.env, EKKO_SCRIPT_REPORT_INVOCATION: original } })
    expect(crash.status).toBe(9)
    const same = { EKKO_SCRIPT_REPORT_INVOCATION: original }
    expect(helper(binding, ['complete', '--event-id', 'e-5', '--content-file', '-'], 'tampered', same)).toMatchObject({ status: 5, json: { status: 'conflict' } })
    expect(existsSync(finalOf(binding, original))).toBe(false)
    expect(helper(binding, ['complete', '--event-id', 'e-5', '--content-file', '-'], 'original', same)).toMatchObject({ status: 3 })
    m.importer.importScriptReports()
    expect(helper(binding, ['receipt', '--event-id', 'e-5']).json).toMatchObject({ status: 'accepted', receipt: { invocation_id: original, exact: true } })
    // The launcher settled the original invocation as a failure: a waiting retry must not confirm the event.
    const taken = reserve(binding)
    spawnSync(PYTHON, ['-c', [
      'import importlib.util, os, sys',
      `spec = importlib.util.spec_from_file_location("w", ${JSON.stringify(wrapperOf(binding))})`,
      'w = importlib.util.module_from_spec(spec); spec.loader.exec_module(w)',
      'w._status = lambda *a, **k: os._exit(9)',
      'sys.exit(w.helper(["complete", "--event-id", "e-6", "--content-file", "-"]))',
    ].join('\n')], { input: 'lost', encoding: 'utf8', env: { ...process.env, EKKO_SCRIPT_REPORT_INVOCATION: taken } })
    spawnSync(PYTHON, ['-c', [
      'import importlib.util, time',
      `spec = importlib.util.spec_from_file_location("w", ${JSON.stringify(wrapperOf(binding))})`,
      'w = importlib.util.module_from_spec(spec); spec.loader.exec_module(w)',
      'm = w.load_manifest(w.MANIFEST_PATH)',
      `w.publish_json(m["spool_dir"] + "/${taken}", "final.json", w.build_final(m, "${taken}", time.time(), time.monotonic(), {"outcome": "failed", "exit_code": 3, "detail": "launcher failed"}, True))`,
    ].join('\n')], { encoding: 'utf8' })
    const waiting = new Promise<{ status: number | null; out: string }>(done => {
      const child = spawn(PYTHON, [wrapperOf(binding), 'complete', '--event-id', 'e-6', '--content-file', '-', '--wait', '20'])
      let out = ''
      child.stdout.on('data', chunk => { out += chunk })
      child.on('exit', status => done({ status, out }))
      child.stdin.end('lost')
    })
    await sleep(1000)
    m.importer.importScriptReports()
    const answer = await waiting
    expect(answer.status).toBe(6)
    expect(JSON.parse(answer.out)).toMatchObject({ status: 'unknown', invocation_id: taken, receipt: { outcome: 'failed', event_id: null } })
    // Day 1 stays pending (Studio does not import); the next day's run resubmits day 1, not a new day.
    const worker = bind('launcher.sh')
    fire(worker, { SYNTHETIC_REPORT_DAY: '2026-11-04' })
    await idle()
    fire(worker, { SYNTHETIC_REPORT_DAY: '2026-11-05' })
    await idle()
    m.importer.importScriptReports()
    const days = notices().filter(row => row.payload.binding_id === worker.binding_id).map(row => [row.disposition, row.payload.event_id]).sort()
    expect(days).toEqual([['notified', 'synthetic-daily-report:v1:2026-11-04'], ['silent', 'synthetic-daily-report:v1:2026-11-04']])
    expect(readFileSync(join(state, 'compositions'), 'utf8')).toBe('2026-11-04\n')
  })

  it('refuses different bytes under an accepted event, unreserved invocations and sync bindings', async () => {
    const binding = bind('launcher.sh')
    expect(helper(binding, ['complete', '--event-id', 'e-2', '--content-file', '-'], 'v1', { EKKO_SCRIPT_REPORT_INVOCATION: reserve(binding) }).status).toBe(3)
    m.importer.importScriptReports()
    const envelopes = readdirSync(m.paths.scriptReportOutboxDir(binding.binding_id)).filter((name: string) => !name.startsWith('.'))
    const before = readFileSync(join(m.paths.scriptReportOutboxDir(binding.binding_id), envelopes[0]), 'utf8')
    const vehicle = reserve(binding)
    expect(helper(binding, ['complete', '--event-id', 'e-2', '--content-file', '-'], 'v2 tampered', { EKKO_SCRIPT_REPORT_INVOCATION: vehicle }))
      .toMatchObject({ status: 5, json: { status: 'conflict' } })
    expect(readFileSync(join(m.paths.scriptReportOutboxDir(binding.binding_id), envelopes[0]), 'utf8')).toBe(before)
    m.importer.importScriptReports()
    const shown = notices().filter(row => row.disposition === 'notified')
    expect(shown.map(row => row.payload.outcome)).toEqual(['output', 'failed'])
    expect(shown[1].payload).toMatchObject({ invocation_id: vehicle, content: expect.stringContaining('already submitted with different content') })
    expect(helper(binding, ['receipt', '--event-id', 'e-2']).json).toMatchObject({ status: 'accepted', receipt: { exact: true } })
    // An invented or another binding's invocation is never completed; nothing is written for it.
    for (const invocation of [randomUUID(), '../escape']) {
      expect(helper(binding, ['complete', '--event-id', 'e-3', '--content-file', '-'], 'x', { EKKO_SCRIPT_REPORT_INVOCATION: invocation }))
        .toMatchObject({ status: 2, json: { error: 'invocation_not_reserved' } })
    }
    expect(helper(binding, ['complete', '--event-id', 'e-3', '--content-file', '-'], 'x')).toMatchObject({ json: { error: 'invocation_required' } })
    const sync = bind('worker.py', 'sync')
    expect(helper(sync, ['complete', '--event-id', 'e-3', '--content-file', '-'], 'x')).toMatchObject({ status: 2, json: { error: 'completion_not_detached' } })
    expect(readdirSync(m.paths.scriptReportOutboxDir(binding.binding_id)).filter((name: string) => !name.startsWith('.'))).toHaveLength(1)
  })

  it('a report cannot switch its binding\'s completion mode', () => {
    const detached = bind('launcher.sh')
    const sync = bind('worker.py', 'sync')
    const forge = (binding: any, extra: Record<string, unknown>) => {
      const invocation = randomUUID()
      mkdirSync(join(spoolDir(binding), invocation), { mode: 0o700 })
      writeFileSync(finalOf(binding, invocation), JSON.stringify({ schema_version: 1, phase: 'final', identity_kind: 'wrapper_invocation',
        binding_id: binding.binding_id, binding_revision: 1, invocation_id: invocation, native_execution_id: null, wrapper_version: '1',
        policy_version: 'p', sanitizer_version: 's', child_launched: true, outcome: 'output', exit_code: 0, signal: null, content: 'x',
        truncated: false, omitted_reason: null, redaction_status: 'clean', started_at: 1, finished_at: 2, duration_ms: 1, ...extra }), { mode: 0o600 })
      return invocation
    }
    const a = forge(sync, { completion: 'detached', event_id: 'e', submitted_sha256: null, retry_of: null })
    const b = forge(detached, {})
    m.importer.importScriptReports()
    expect(notices()).toHaveLength(0)
    expect(m.reports.getScriptReportInvocation(sync.binding_id, a)).toMatchObject({ state: 'quarantined' })
    expect(receipt(detached, b)).toMatchObject({ state: 'quarantined', reason: 'invalid_report', event_id: null })
  })

  it('fails closed after revocation or a session reset: the receipt records the rejection, nothing is rerouted', async () => {
    const binding = bind('launcher.sh')
    const send = (event: string) => helper(binding, ['complete', '--event-id', event, '--content-file', '-'], `body ${event}`,
      { EKKO_SCRIPT_REPORT_INVOCATION: reserve(binding) })
    send('reset-day')
    m.store.clearSessionMessages('chat-1') // a history reset rotates the frozen generation
    m.importer.importScriptReports()
    expect(helper(binding, ['receipt', '--event-id', 'reset-day'])).toMatchObject({ status: 4, json: { status: 'rejected', receipt: { reason: 'owner_missing', notification_id: null } } })
    m.reports.transitionScriptReportBinding(binding.binding_id, ['active'], 'revoked')
    send('revoked-day')
    m.importer.importScriptReports()
    expect(helper(binding, ['receipt', '--event-id', 'revoked-day']).json).toMatchObject({ status: 'rejected', receipt: { reason: 'binding_revoked' } })
    expect(notices()).toHaveLength(0)
  })

  it('an importer crash between the durable disposition and the receipt replays to the same receipt and one notice', async () => {
    const binding = bind('launcher.sh')
    const invocation = reserve(binding)
    helper(binding, ['complete', '--event-id', 'e-4', '--content-file', '-'], 'once', { EKKO_SCRIPT_REPORT_INVOCATION: invocation })
    const copy = join(root, 'entry-copy')
    cpSync(join(spoolDir(binding), invocation), copy, { recursive: true })
    m.importer.importScriptReports()
    const first = receipt(binding, invocation)
    // Crash state: disposition committed, receipt not yet written, entry still in the spool.
    rmSync(join(m.paths.scriptReportReceiptsDir(binding.binding_id), `${invocation}.json`))
    cpSync(copy, join(spoolDir(binding), invocation), { recursive: true })
    m.importer.importScriptReports()
    expect(receipt(binding, invocation)).toEqual(first)
    expect(notices()).toHaveLength(1)
    expect(spool(binding)).toEqual([])
  })

  it('a replay rewritten with another event after the disposition keeps the committed identity in the receipt', async () => {
    const binding = bind('launcher.sh')
    const invocation = reserve(binding)
    helper(binding, ['complete', '--event-id', 'e-5', '--content-file', '-'], 'same body', { EKKO_SCRIPT_REPORT_INVOCATION: invocation })
    const copy = join(root, 'entry-copy')
    cpSync(join(spoolDir(binding), invocation), copy, { recursive: true })
    m.importer.importScriptReports()
    const first = receipt(binding, invocation)
    // Crash state before the receipt, then the replayed entry names another event with the same bytes.
    rmSync(join(m.paths.scriptReportReceiptsDir(binding.binding_id), `${invocation}.json`))
    const final = JSON.parse(readFileSync(join(copy, 'final.json'), 'utf8'))
    writeFileSync(join(copy, 'final.json'), JSON.stringify({ ...final, event_id: 'e-replaced' }))
    cpSync(copy, join(spoolDir(binding), invocation), { recursive: true })
    m.importer.importScriptReports()
    expect(receipt(binding, invocation)).toEqual(first)
    expect(receipt(binding, invocation)).toMatchObject({ event_id: 'e-5', state: 'accepted', exact: true })
    expect(notices()).toHaveLength(1)
  })

  it('a receipt linked before a crash gets its directory synced on replay before the entry is acknowledged', async () => {
    const binding = bind('launcher.sh')
    const invocation = reserve(binding)
    helper(binding, ['complete', '--event-id', 'e-6', '--content-file', '-'], 'body', { EKKO_SCRIPT_REPORT_INVOCATION: invocation })
    const copy = join(root, 'entry-copy')
    cpSync(join(spoolDir(binding), invocation), copy, { recursive: true })
    m.importer.importScriptReports()
    const first = receipt(binding, invocation)
    // Crash state: receipt linked, directory not yet synced, entry not acknowledged.
    cpSync(copy, join(spoolDir(binding), invocation), { recursive: true })
    fsFaults.dirSyncs = 0
    m.importer.importScriptReports()
    expect(fsFaults.dirSyncs).toBeGreaterThan(0)
    expect(receipt(binding, invocation)).toEqual(first)
    expect(spool(binding)).toEqual([])
  })

  it('a failed receipt directory sync keeps the spool entry for a later pass', async () => {
    const binding = bind('launcher.sh')
    const invocation = reserve(binding)
    helper(binding, ['complete', '--event-id', 'e-7', '--content-file', '-'], 'body', { EKKO_SCRIPT_REPORT_INVOCATION: invocation })
    fsFaults.failDirSync = Object.assign(new Error('directory sync failed'), { code: 'EIO' })
    m.importer.importScriptReports()
    expect(spool(binding)).toEqual([invocation])
    expect(notices()).toHaveLength(1)
    fsFaults.failDirSync = null
    m.importer.importScriptReports()
    expect(spool(binding)).toEqual([])
    expect(receipt(binding, invocation)).toMatchObject({ event_id: 'e-7', state: 'accepted', exact: true })
    expect(notices()).toHaveLength(1)
  })

  it('a launcher failure is reported as a failure; concurrent launches keep one worker and one delivery', async () => {
    const binding = bind('launcher.sh')
    // A launcher that cannot start its worker exits nonzero: that invocation is final (failed).
    mkdirSync(state, { recursive: true }); writeFileSync(join(state, 'runs'), 'not a directory')
    expect(fire(binding).status).not.toBe(0)
    rmSync(join(state, 'runs'))
    m.importer.importScriptReports()
    expect(notices().map(row => row.payload.outcome)).toEqual(['failed'])
    // The first worker is held until all three launchers have exited, so the overlap is certain.
    const gate = join(root, 'release-2')
    const launches = await Promise.all([0, 1, 2].map(() => new Promise<number>(done => {
      const child = spawn(PYTHON, [wrapperOf(binding)], { env: { ...process.env, SYNTHETIC_REPORT_STATE: state, SYNTHETIC_REPORT_DAY: '2026-11-05', SYNTHETIC_REPORT_GATE: gate } })
      child.on('exit', code => done(code ?? -1))
    })))
    expect(launches).toEqual([0, 0, 0])
    writeFileSync(gate, '')
    await until(() => spool(binding).every((id: string) => existsSync(finalOf(binding, id))), 'all invocations completed')
    await idle()
    m.importer.importScriptReports()
    const rows = notices()
    expect(rows.filter(row => row.disposition === 'notified' && row.payload.outcome === 'output')).toHaveLength(1)
    expect(rows.filter(row => row.payload.event_id?.startsWith('launcher-dedupe:'))).toHaveLength(2)
    expect(readFileSync(join(state, 'compositions'), 'utf8')).toBe('2026-11-05\n')
  })
})

/** A reserved detached invocation, exactly as the wrapper leaves it after a clean launcher exit. */
function reserve(binding: any): string {
  const out = spawnSync(PYTHON, ['-c', [
    'import importlib.util, time, uuid',
    `spec = importlib.util.spec_from_file_location("w", ${JSON.stringify(wrapperOf(binding))})`,
    'w = importlib.util.module_from_spec(spec); spec.loader.exec_module(w)',
    'i = str(uuid.uuid4()); w.reserve_invocation(w.load_manifest(w.MANIFEST_PATH), i, time.time()); print(i)',
  ].join('\n')], { encoding: 'utf8' })
  return out.stdout.trim()
}

// Nonterminal notices on ONE reserved detached invocation: `append` adds bounded, distinct notices
// (start, body, success, failure) that Studio imports while the invocation runs; `complete` stays
// the terminal report and is imported only after every admitted notice is settled.
describe('appended script report notices', { timeout: 30_000 }, () => {
  const append = (binding: any, invocation: string, eventId: string, kind: string, body: string) =>
    helper(binding, ['append', '--event-id', eventId, '--event-kind', kind, '--content-file', '-'], body, { EKKO_SCRIPT_REPORT_INVOCATION: invocation })
  const complete = (binding: any, invocation: string, eventId: string, body: string, outcome = 'output') =>
    helper(binding, ['complete', '--event-id', eventId, '--outcome', outcome, '--content-file', '-'], body, { EKKO_SCRIPT_REPORT_INVOCATION: invocation })
  const eventReceipt = (binding: any, eventId: string) => {
    const path = join(m.paths.scriptReportReceiptsDir(binding.binding_id), 'events', `${createHash('sha256').update(eventId).digest('hex')}.json`)
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
  }
  const eventFiles = (binding: any, invocation: string) => {
    const dir = join(spoolDir(binding), invocation, 'events')
    return existsSync(dir) ? readdirSync(dir).filter((name: string) => !name.startsWith('.')).sort() : []
  }
  const sha = (text: string) => createHash('sha256').update(text).digest('hex')
  const shown = () => notices().filter(row => row.disposition === 'notified').map(row => [row.payload.event_kind ?? 'terminal', row.payload.content])

  it('one invocation delivers start, body and success as distinct notices; the terminal report follows them', () => {
    const binding = bind('launcher.sh')
    const invocation = reserve(binding)
    expect(append(binding, invocation, 'run-7:start', 'start', 'Job started')).toMatchObject({ status: 3,
      json: { status: 'queued', event_id: 'run-7:start', invocation_id: invocation, sequence: 1 } })
    // Imported while the invocation still runs: the start notice does not wait for the end.
    expect(m.importer.importScriptReports().accepted).toHaveLength(1)
    expect(append(binding, invocation, 'run-7:body', 'body', '| repo | state |\n|---|---|\n| a | ok |')).toMatchObject({ status: 3, json: { sequence: 2 } })
    expect(append(binding, invocation, 'run-7:success', 'success', 'Job succeeded')).toMatchObject({ status: 3, json: { sequence: 3 } })
    expect(complete(binding, invocation, 'run-7:final', '', 'silent')).toMatchObject({ status: 3 })
    m.importer.importScriptReports()
    expect(shown()).toEqual([['start', 'Job started'], ['body', '| repo | state |\n|---|---|\n| a | ok |'], ['success', 'Job succeeded']])
    const rows = notices()
    expect(rows.every(row => row.payload.invocation_id === invocation)).toBe(true)
    expect(rows.map(row => row.payload.sequence ?? null)).toEqual([1, 2, 3, null])
    expect(rows[3]).toMatchObject({ disposition: 'silent', payload: { event_id: 'run-7:final', outcome: 'silent' } })
    expect(eventReceipt(binding, 'run-7:body')).toEqual({ schema_version: 1, stream: 'append', binding_id: binding.binding_id, binding_revision: 1,
      job_id: binding.job_id, session_id: 'chat-1', session_generation: binding.session_generation, invocation_id: invocation,
      event_id: 'run-7:body', event_kind: 'body', sequence: 2, state: 'accepted', reason: null, notification_id: rows[1].id,
      submitted_sha256: sha('| repo | state |\n|---|---|\n| a | ok |'), accepted_sha256: sha('| repo | state |\n|---|---|\n| a | ok |'),
      exact: true, record_sha256: expect.stringMatching(/^[0-9a-f]{64}$/), settled_at: expect.any(Number) })
    expect(helper(binding, ['receipt', '--stream', 'append', '--event-id', 'run-7:start'])).toMatchObject({ status: 0,
      json: { status: 'accepted', invocation_id: invocation, receipt: { notification_id: rows[0].id, exact: true } } })
    // The terminal contract is unchanged: one invocation row and its own receipt.
    expect(receipt(binding, invocation)).toMatchObject({ event_id: 'run-7:final', state: 'silent', invocation_id: invocation })
    expect(m.reports.countScriptReportInvocations(binding.binding_id)).toEqual({ accepted: 0, silent: 1, rejected: 0, quarantined: 0 })
    expect(spool(binding)).toEqual([])
  })

  it('a failure terminal keeps every earlier notice; retries are idempotent and changed bytes conflict', () => {
    const binding = bind('launcher.sh')
    const invocation = reserve(binding)
    append(binding, invocation, 'run-8:start', 'start', 'Job started')
    append(binding, invocation, 'run-8:body', 'body', 'partial result')
    m.importer.importScriptReports()
    // Same event, same bytes (before and after import): the original record, sequence and notice.
    expect(append(binding, invocation, 'run-8:start', 'start', 'Job started')).toMatchObject({ status: 0, json: { status: 'accepted', sequence: 1 } })
    expect(append(binding, invocation, 'run-8:start', 'start', 'Job started (edited)')).toMatchObject({ status: 5, json: { status: 'conflict', sequence: 1 } })
    expect(append(binding, invocation, 'run-8:start', 'body', 'Job started')).toMatchObject({ status: 5 })
    // A distinct event with identical text is a distinct notice.
    expect(append(binding, invocation, 'run-8:again', 'body', 'partial result')).toMatchObject({ status: 3, json: { sequence: 3 } })
    // A retry through another invocation resolves the original event; it neither closes nor uses the other one.
    const other = reserve(binding)
    expect(append(binding, other, 'run-8:body', 'body', 'partial result')).toMatchObject({ status: 0, json: { invocation_id: invocation, sequence: 2 } })
    expect(existsSync(finalOf(binding, other))).toBe(false)
    expect(complete(binding, invocation, 'run-8:failure', 'Job failed: exit 3', 'failed')).toMatchObject({ status: 3 })
    // Closed: a new event is refused, a known one still answers with its receipt.
    expect(append(binding, invocation, 'run-8:late', 'body', 'late')).toMatchObject({ status: 2, json: { error: 'invocation_finalized' } })
    m.importer.importScriptReports()
    expect(append(binding, invocation, 'run-8:again', 'body', 'partial result')).toMatchObject({ status: 0, json: { status: 'accepted' } })
    expect(shown()).toEqual([['start', 'Job started'], ['body', 'partial result'], ['body', 'partial result'], ['terminal', 'Job failed: exit 3']])
    expect(notices().filter(row => row.payload.event_kind).length).toBe(3)
    expect(spool(binding)).toEqual([other])
  })

  it('admission is bounded per invocation; retries are free and the overflow is explicit', () => {
    const binding = bind('launcher.sh')
    const invocation = reserve(binding)
    for (let i = 1; i <= 8; i++) expect(append(binding, invocation, `run-9:${i}`, 'body', `part ${i}`)).toMatchObject({ status: 3, json: { sequence: i } })
    m.importer.importScriptReports()
    expect(append(binding, invocation, 'run-9:1', 'body', 'part 1')).toMatchObject({ status: 0 })
    expect(append(binding, invocation, 'run-9:9', 'body', 'part 9')).toMatchObject({ status: 4, json: { error: 'event_limit_reached' } })
    expect(shown()).toHaveLength(8)
    expect(complete(binding, invocation, 'run-9:final', 'done')).toMatchObject({ status: 3 })
    m.importer.importScriptReports()
    expect(shown().at(-1)).toEqual(['terminal', 'done'])
  })

  it('a lost spool copy neither blocks nor loses its notice: admissions are imported in slot order before the terminal report', () => {
    const binding = bind('launcher.sh')
    const invocation = reserve(binding)
    append(binding, invocation, 'run-10:start', 'start', 'Job started')
    append(binding, invocation, 'run-10:body', 'body', 'body text')
    rmSync(join(spoolDir(binding), invocation, 'events', '01.json'))
    expect(m.importer.importScriptReports().accepted).toHaveLength(2)
    expect(complete(binding, invocation, 'run-10:final', 'all done')).toMatchObject({ status: 3 })
    m.importer.importScriptReports()
    expect(shown()).toEqual([['start', 'Job started'], ['body', 'body text'], ['terminal', 'all done']])
    expect(notices().map(row => row.payload.sequence ?? null)).toEqual([1, 2, null])
  })


  it('an existing appended receipt is held until its directory sync succeeds', () => {
    const binding = bind('launcher.sh')
    const invocation = reserve(binding)
    expect(append(binding, invocation, 'a-1', 'start', 'starting').status).toBe(3)
    const copy = join(root, 'append-copy')
    cpSync(join(spoolDir(binding), invocation), copy, { recursive: true })
    m.importer.importScriptReports()
    const first = eventReceipt(binding, 'a-1')
    expect(first).toBeTruthy()
    // Crash state: receipt linked, nothing acknowledged; the directory sync now fails.
    rmSync(join(spoolDir(binding), invocation), { recursive: true, force: true })
    cpSync(copy, join(spoolDir(binding), invocation), { recursive: true })
    fsFaults.dirSyncs = 0
    fsFaults.failDirSync = Object.assign(new Error('directory sync failed'), { code: 'EIO' })
    m.importer.importScriptReports()
    expect(fsFaults.dirSyncs).toBeGreaterThan(0)
    expect(readdirSync(join(spoolDir(binding), invocation, 'events'))).not.toEqual([])
    fsFaults.failDirSync = null
    m.importer.importScriptReports()
    expect(eventReceipt(binding, 'a-1')).toEqual(first)
    expect(notices().filter((row: any) => JSON.stringify(row.payload).includes('starting'))).toHaveLength(1)
  })

  it('an append fails while its admission directories cannot be synced, then one retry admits it once', () => {
    const binding = bind('launcher.sh')
    const invocation = reserve(binding)
    const body = join(root, 'append-body.txt')
    writeFileSync(body, 'starting up')
    const faulty = () => spawnSync(PYTHON, ['-c', [
      'import importlib.util, os, stat, sys',
      `spec = importlib.util.spec_from_file_location("w", ${JSON.stringify(wrapperOf(binding))})`,
      'w = importlib.util.module_from_spec(spec); spec.loader.exec_module(w)',
      'real = os.fsync',
      'def failing(fd):',
      '    if stat.S_ISDIR(os.fstat(fd).st_mode): raise OSError(5, "EIO")',
      '    return real(fd)',
      'os.fsync = failing',
      `sys.exit(w.helper(["append", "--event-id", "a-2", "--event-kind", "start", "--content-file", ${JSON.stringify(body)}]))`,
    ].join('\n')], { encoding: 'utf8', env: { ...process.env, EKKO_SCRIPT_REPORT_INVOCATION: invocation } })
    // The fault persists across retries: every attempt fails, none reports queued.
    for (let attempt = 0; attempt < 2; attempt++) {
      const out = faulty()
      expect(out.stdout).not.toContain('"queued"')
      expect(out.status).not.toBe(3)
    }
    // Faults cleared: one retry admits the event exactly once.
    expect(append(binding, invocation, 'a-2', 'start', 'starting up').status).toBe(3)
    expect(append(binding, invocation, 'a-2', 'start', 'starting up').status).toBe(3)
    m.importer.importScriptReports()
    expect(notices().filter((row: any) => JSON.stringify(row.payload).includes('starting up'))).toHaveLength(1)
  })

  it('a committed notice is recovered once; a changed replay never acquires another acceptance', () => {
    const binding = bind('launcher.sh')
    const invocation = reserve(binding)
    append(binding, invocation, 'run-11:start', 'start', 'Job started')
    const file = join(spoolDir(binding), invocation, 'events', '01.json')
    const original = readFileSync(file)
    m.importer.importScriptReports()
    const [first] = notices()
    // Crash point: the inbox committed the notice, its event disposition and receipt were lost.
    m.db.prepare('DELETE FROM script_report_events WHERE binding_id=?').run(binding.binding_id)
    rmSync(join(m.paths.scriptReportReceiptsDir(binding.binding_id), 'events'), { recursive: true, force: true })
    writeFileSync(file, original, { mode: 0o600 })
    m.importer.importScriptReports()
    expect(notices()).toHaveLength(1)
    expect(eventReceipt(binding, 'run-11:start')).toMatchObject({ state: 'accepted', notification_id: first.id })
    // Changed metadata under the same event: quarantined, the original receipt stays.
    const tampered = JSON.parse(original.toString('utf8'))
    writeFileSync(file, JSON.stringify({ ...tampered, content: 'forged' }), { mode: 0o600 })
    m.importer.importScriptReports()
    expect(notices()).toHaveLength(1)
    expect(eventFiles(binding, invocation)).toEqual([])
    expect(eventReceipt(binding, 'run-11:start')).toMatchObject({ state: 'accepted', notification_id: first.id })
  })

  it('concurrent appends get distinct gapless slots; a concurrent duplicate takes one; a racing terminal call closes after them', async () => {
    const binding = bind('launcher.sh')
    const invocation = reserve(binding)
    const run = (args: string[], input: string) => new Promise<number>(done => {
      const child = spawn(PYTHON, [wrapperOf(binding), ...args], { env: { ...process.env, EKKO_SCRIPT_REPORT_INVOCATION: invocation } })
      child.stdin.end(input)
      child.on('exit', code => done(code ?? -1))
    })
    const add = (id: string, text: string) => run(['append', '--event-id', id, '--event-kind', 'body', '--content-file', '-'], text)
    const codes = await Promise.all([add('c:1', 'one'), add('c:2', 'two'), add('c:3', 'three'), add('c:1', 'one'), add('c:1', 'one'),
      run(['complete', '--event-id', 'c:final', '--content-file', '-'], 'end')])
    expect(codes.slice(0, 5).every(code => code === 3 || code === 2)).toBe(true)
    m.importer.importScriptReports()
    const rows = notices()
    const appended = rows.filter(row => row.payload.event_kind)
    expect(appended.map(row => row.payload.sequence)).toEqual(appended.map((_, index) => index + 1))
    expect(new Set(appended.map(row => row.payload.event_id)).size).toBe(appended.length)
    // Whatever was admitted before the terminal call is imported before the terminal report.
    expect(rows.at(-1)!.payload).toMatchObject({ event_id: 'c:final', content: 'end' })
    expect(spool(binding)).toEqual([])
  })

  it('a launcher that fails after appending is closed by the wrapper after its admitted notice', () => {
    writeFileSync(join(hermesHome, 'scripts', 'reports', 'failing.sh'), ['#!/bin/bash',
      'printf "Job started" | "$EKKO_SCRIPT_REPORT_PYTHON" "$EKKO_SCRIPT_REPORT_HELPER" append --event-id f:start --event-kind start --content-file - >/dev/null',
      'echo "boom" >&2', 'exit 3', ''].join('\n'))
    const binding = bind('failing.sh')
    expect(fire(binding).status).toBe(3)
    m.importer.importScriptReports()
    expect(shown()).toEqual([['start', 'Job started'], ['terminal', 'Script exited with code 3\nstderr:\nboom']])
    expect(notices().map(row => row.payload.outcome)).toEqual(['output', 'failed'])
  })

  it('each owner fence rejects a pending notice without rerouting; a mismatching receipt is ambiguous, never a delivery', () => {
    const job = (binding: any) => jobs.find(item => item.id === binding.job_id)
    const losses: Array<[string, (binding: any) => () => void]> = [
      ['account_forbidden', () => { m.users.updateUser({ userId: member.id, status: 'disabled' }); return () => m.users.updateUser({ userId: member.id, status: 'active' }) }],
      ['account_forbidden', () => { m.users.updateUser({ userId: member.id, profiles: ['other'] }); return () => m.users.updateUser({ userId: member.id, profiles: ['default'] }) }],
      ['target_changed', binding => { job(binding).deliver = 'slack:C1'; saveJobs(); return () => { job(binding).deliver = 'local'; saveJobs() } }],
      ['owner_missing', () => { m.store.clearSessionMessages('chat-1'); return () => {} }], // a reset rotates the frozen generation
    ]
    for (const [index, [reason, lose]] of losses.entries()) {
      const binding = bind('launcher.sh')
      append(binding, reserve(binding), `fence-${index}`, 'start', `notice ${index}`)
      const restore = lose(binding)
      m.importer.importScriptReports()
      restore()
      expect(eventReceipt(binding, `fence-${index}`), reason).toMatchObject({ state: 'rejected', reason, notification_id: null, accepted_sha256: null, exact: false })
      expect(helper(binding, ['receipt', '--stream', 'append', '--event-id', `fence-${index}`])).toMatchObject({ status: 4, json: { status: 'rejected' } })
    }
    expect(notices()).toHaveLength(0)
    // A receipt that does not match the event's own record (other bytes) says nothing about this delivery.
    const binding = m.reports.getScriptReportBinding(bind('launcher.sh').binding_id)
    append(binding, reserve(binding), 'ambiguous', 'start', 'original')
    m.importer.importScriptReports()
    const path = join(m.paths.scriptReportReceiptsDir(binding.binding_id), 'events', `${sha('ambiguous')}.json`)
    writeFileSync(path, JSON.stringify({ ...eventReceipt(binding, 'ambiguous'), submitted_sha256: sha('other') }))
    expect(helper(binding, ['receipt', '--stream', 'append', '--event-id', 'ambiguous'])).toMatchObject({ status: 6, json: { status: 'unknown' } })
    expect(helper(binding, ['receipt', '--stream', 'append', '--event-id', 'never-appended'])).toMatchObject({ status: 6, json: { status: 'unknown', receipt: null } })
  })

  it('a crash after a slot is taken, before its event index exists, blocks nothing: the slot keeps its record', () => {
    const binding = bind('launcher.sh')
    const invocation = reserve(binding)
    // Crash point: the first durable write of `append` succeeds, the second never happens.
    const crash = spawnSync(PYTHON, ['-c', [
      'import importlib.util, os, sys',
      `spec = importlib.util.spec_from_file_location("w", ${JSON.stringify(wrapperOf(binding))})`,
      'w = importlib.util.module_from_spec(spec); spec.loader.exec_module(w)',
      'original = w.publish_json',
      'def publish(*a, **k):',
      '    if a[0].endswith("/events") and "/outbox/" in a[0]: os._exit(9)',
      '    return original(*a, **k)',
      'w.publish_json = publish',
      'sys.exit(w.helper(["append", "--event-id", "x:start", "--event-kind", "start", "--content-file", "-"]))',
    ].join('\n')], { input: 'Job started', encoding: 'utf8', env: { ...process.env, EKKO_SCRIPT_REPORT_INVOCATION: invocation } })
    expect(crash.status).toBe(9)
    expect(append(binding, invocation, 'x:body', 'body', 'body text')).toMatchObject({ status: 3, json: { sequence: 2 } })
    expect(complete(binding, invocation, 'x:final', 'done')).toMatchObject({ status: 3 })
    m.importer.importScriptReports()
    m.importer.importScriptReports()
    expect(shown()).toEqual([['start', 'Job started'], ['body', 'body text'], ['terminal', 'done']])
    expect(spool(binding)).toEqual([])
    // The interrupted caller's retry finds its original record and receipt.
    expect(append(binding, invocation, 'x:start', 'start', 'Job started')).toMatchObject({ status: 0, json: { sequence: 1, status: 'accepted' } })
  })

  it('a retry through another invocation inside that crash window resolves the original record, consuming nothing', () => {
    const binding = bind('launcher.sh')
    const first = reserve(binding)
    const crash = spawnSync(PYTHON, ['-c', [
      'import importlib.util, os, sys',
      `spec = importlib.util.spec_from_file_location("w", ${JSON.stringify(wrapperOf(binding))})`,
      'w = importlib.util.module_from_spec(spec); spec.loader.exec_module(w)',
      'original = w.publish_json',
      'def publish(*a, **k):',
      '    if a[0].endswith("/events") and "/outbox/" in a[0]: os._exit(9)',
      '    return original(*a, **k)',
      'w.publish_json = publish',
      'sys.exit(w.helper(["append", "--event-id", "v:start", "--event-kind", "start", "--content-file", "-"]))',
    ].join('\n')], { input: 'Job started', encoding: 'utf8', env: { ...process.env, EKKO_SCRIPT_REPORT_INVOCATION: first } })
    expect(crash.status).toBe(9)
    const second = reserve(binding)
    expect(append(binding, second, 'v:start', 'start', 'Job started (other bytes)')).toMatchObject({ status: 5, json: { status: 'conflict', invocation_id: first, sequence: 1 } })
    expect(append(binding, second, 'v:start', 'body', 'Job started')).toMatchObject({ status: 5, json: { invocation_id: first } })
    expect(append(binding, second, 'v:start', 'start', 'Job started')).toMatchObject({ status: 3, json: { invocation_id: first, sequence: 1 } })
    expect(existsSync(join(m.paths.scriptReportOutboxDir(binding.binding_id), 'invocations', second))).toBe(false)
    m.importer.importScriptReports()
    expect(shown()).toEqual([['start', 'Job started']])
  })

  it('a replay that changes the event of a slot committed just before a crash never gets a second notice', () => {
    const binding = bind('launcher.sh')
    const invocation = reserve(binding)
    append(binding, invocation, 'y:start', 'start', 'Job started')
    const file = join(spoolDir(binding), invocation, 'events', '01.json')
    const original = JSON.parse(readFileSync(file, 'utf8'))
    m.importer.importScriptReports()
    const [first] = notices()
    // Crash point: the notice is committed; the event row and its receipt are not.
    m.db.prepare('DELETE FROM script_report_events WHERE binding_id=?').run(binding.binding_id)
    rmSync(join(m.paths.scriptReportReceiptsDir(binding.binding_id), 'events'), { recursive: true, force: true })
    writeFileSync(file, JSON.stringify({ ...original, event_id: 'y:other', content: 'forged' }), { mode: 0o600 })
    m.importer.importScriptReports()
    expect(notices()).toHaveLength(1)
    expect(eventReceipt(binding, 'y:start')).toMatchObject({ state: 'accepted', notification_id: first.id, sequence: 1, exact: true })
    expect(eventReceipt(binding, 'y:other')).toBeNull()
    // Same crash window, then a malformed replay and an existing terminal report: the receipt is still written first.
    m.db.prepare('DELETE FROM script_report_events WHERE binding_id=?').run(binding.binding_id)
    rmSync(join(m.paths.scriptReportReceiptsDir(binding.binding_id), 'events'), { recursive: true, force: true })
    writeFileSync(file, '{"not": "an event"', { mode: 0o600 })
    complete(binding, invocation, 'y:final', 'done')
    m.importer.importScriptReports()
    expect(eventReceipt(binding, 'y:start')).toMatchObject({ state: 'accepted', notification_id: first.id, sequence: 1 })
    expect(append(binding, invocation, 'y:start', 'start', 'Job started')).toMatchObject({ status: 0, json: { status: 'accepted' } })
  })

  it('an unreadable admissions directory holds the terminal report; an append racing the importer is never cleaned up unimported', () => {
    const binding = bind('launcher.sh')
    const invocation = reserve(binding)
    append(binding, invocation, 'z:start', 'start', 'Job started')
    complete(binding, invocation, 'z:final', 'done')
    const admissions = join(m.paths.scriptReportOutboxDir(binding.binding_id), 'invocations', invocation)
    chmodSync(admissions, 0o000)
    try {
      m.importer.importScriptReports()
    } finally {
      chmodSync(admissions, 0o700)
    }
    expect(notices()).toHaveLength(0)
    m.importer.importScriptReports()
    expect(shown()).toEqual([['start', 'Job started'], ['terminal', 'done']])
    // Deterministic interleaving: while the importer settles slot 1, the worker appends slot 2 and completes.
    const other = reserve(binding)
    append(binding, other, 'r:start', 'start', 'Run started')
    let raced = false
    m.importer.setScriptReportJobInspector((profile: string, jobId: string) => {
      if (!raced) {
        raced = true
        append(binding, other, 'r:body', 'body', 'Run body')
        complete(binding, other, 'r:final', 'Run done')
      }
      return m.jobs.readNativeJob(profile, jobId)
    })
    m.importer.importScriptReports()
    m.importer.setScriptReportJobInspector(m.jobs.readNativeJob)
    m.importer.importScriptReports()
    expect(shown().slice(2)).toEqual([['start', 'Run started'], ['body', 'Run body'], ['terminal', 'Run done']])
    expect(spool(binding)).toEqual([])
  })

  it('an event id the helper admits (200 characters, astral ones included) is the id the importer settles', () => {
    const binding = bind('launcher.sh')
    const invocation = reserve(binding)
    const id = '\u{1F4E6}'.repeat(101)
    expect(append(binding, invocation, id, 'start', 'Packed')).toMatchObject({ status: 3, json: { sequence: 1 } })
    m.importer.importScriptReports()
    expect(eventReceipt(binding, id)).toMatchObject({ state: 'accepted', event_id: id, exact: true })
    expect(shown()).toEqual([['start', 'Packed']])
  })

  it('the frozen admission record is the authority: a malformed or forged spool copy neither loses nor replaces a notice', () => {
    const binding = bind('launcher.sh')
    const first = reserve(binding)
    append(binding, first, 'a:start', 'start', 'original start')
    m.importer.importScriptReports()
    // Crash window of an older design: the notice is committed, the event row is gone.
    m.db.prepare('DELETE FROM script_report_events WHERE binding_id=?').run(binding.binding_id)
    const second = reserve(binding)
    append(binding, second, 'b:body', 'body', 'second body')
    const copy = join(spoolDir(binding), second, 'events', '01.json')
    writeFileSync(copy, JSON.stringify({ ...JSON.parse(readFileSync(copy, 'utf8')), event_id: 'a:start', content: 'forged' }), { mode: 0o600 })
    m.importer.importScriptReports()
    expect(shown()).toEqual([['start', 'original start'], ['body', 'second body']])
    // A malformed spool copy before any import: the admitted notice is still delivered, before its terminal report.
    const third = reserve(binding)
    append(binding, third, 'c:start', 'start', 'third start')
    writeFileSync(join(spoolDir(binding), third, 'events', '01.json'), '{"broken"', { mode: 0o600 })
    complete(binding, third, 'c:final', 'third done')
    m.importer.importScriptReports()
    expect(shown().slice(2)).toEqual([['start', 'third start'], ['terminal', 'third done']])
    expect(eventReceipt(binding, 'c:start')).toMatchObject({ state: 'accepted', sequence: 1, exact: true })
  })

  it('an unreadable admission record holds its slot and the terminal report instead of discarding the notice', () => {
    const binding = bind('launcher.sh')
    const invocation = reserve(binding)
    append(binding, invocation, 'd:start', 'start', 'held start')
    complete(binding, invocation, 'd:final', 'held done')
    const record = join(m.paths.scriptReportOutboxDir(binding.binding_id), 'invocations', invocation, '01.json')
    const original = readFileSync(record)
    writeFileSync(record, '{"broken"', { mode: 0o600 })
    m.importer.importScriptReports()
    expect(notices()).toHaveLength(0)
    expect(spool(binding)).toEqual([invocation])
    writeFileSync(record, original, { mode: 0o600 })
    m.importer.importScriptReports()
    expect(shown()).toEqual([['start', 'held start'], ['terminal', 'held done']])
  })

  it('a receipt of the same event, bytes and slot but another kind confirms nothing', () => {
    const binding = bind('launcher.sh')
    append(binding, reserve(binding), 'k:start', 'start', 'kind check')
    m.importer.importScriptReports()
    const path = join(m.paths.scriptReportReceiptsDir(binding.binding_id), 'events', `${sha('k:start')}.json`)
    writeFileSync(path, JSON.stringify({ ...eventReceipt(binding, 'k:start'), event_kind: 'failure' }))
    expect(helper(binding, ['receipt', '--stream', 'append', '--event-id', 'k:start'])).toMatchObject({ status: 6, json: { status: 'unknown' } })
  })

  it('a failing launcher that cannot take the admission lock leaves its invocation open instead of closing it unlocked', () => {
    writeFileSync(join(hermesHome, 'scripts', 'reports', 'locked.sh'), '#!/bin/bash\necho "boom" >&2\nexit 4\n')
    const binding = bind('locked.sh')
    const lock = join(m.paths.scriptReportOutboxDir(binding.binding_id), '.lock')
    writeFileSync(lock, '', { mode: 0o000 })
    try {
      expect(fire(binding).status).toBe(4) // the target's own exit status is preserved
    } finally {
      chmodSync(lock, 0o600)
    }
    const [invocation] = spool(binding)
    expect(existsSync(finalOf(binding, invocation))).toBe(false)
    expect(m.importer.incompleteScriptReports(binding)).toEqual([expect.objectContaining({ invocation_id: invocation })])
  })

  it('stray spool names are not admissions: they cost no import work and never hold the terminal report', () => {
    const binding = bind('launcher.sh')
    const invocation = reserve(binding)
    append(binding, invocation, 'n:start', 'start', 'budgeted')
    for (let i = 0; i < 5; i++) writeFileSync(join(spoolDir(binding), invocation, 'events', `junk-${i}`), 'x', { mode: 0o600 })
    expect(m.importer.importScriptReports({ limit: 1 }).processed).toBe(1)
    complete(binding, invocation, 'n:final', 'done')
    m.importer.importScriptReports()
    expect(shown()).toEqual([['start', 'budgeted'], ['terminal', 'done']])
    expect(spool(binding)).toEqual([])
  })


  it('admissions are enumerated from their frozen records: losing every spool copy after closure loses no notice', () => {
    const binding = bind('launcher.sh')
    const invocation = reserve(binding)
    append(binding, invocation, 'l:start', 'start', 'kept start')
    complete(binding, invocation, 'l:final', 'kept done')
    rmSync(join(spoolDir(binding), invocation, 'events'), { recursive: true, force: true })
    m.importer.importScriptReports()
    m.importer.importScriptReports()
    expect(shown()).toEqual([['start', 'kept start'], ['terminal', 'kept done']])
    expect(eventReceipt(binding, 'l:start')).toMatchObject({ state: 'accepted', sequence: 1 })
  })

  it('a receipt that does not match the committed disposition holds the invocation instead of being trusted', () => {
    const binding = bind('launcher.sh')
    const invocation = reserve(binding)
    append(binding, invocation, 'q:start', 'start', 'real start')
    const dir = join(m.paths.scriptReportReceiptsDir(binding.binding_id), 'events')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const path = join(dir, `${sha('q:start')}.json`)
    writeFileSync(path, JSON.stringify({ binding_id: binding.binding_id, event_id: 'q:start', state: 'accepted', notification_id: 999 }))
    complete(binding, invocation, 'q:final', 'real done')
    m.importer.importScriptReports()
    expect(spool(binding)).toEqual([invocation]) // the terminal report waits
    expect(helper(binding, ['receipt', '--stream', 'append', '--event-id', 'q:start'])).toMatchObject({ status: 6, json: { status: 'unknown' } })
    rmSync(path)
    m.importer.importScriptReports()
    m.importer.importScriptReports()
    expect(shown()).toEqual([['start', 'real start'], ['terminal', 'real done']])
    expect(helper(binding, ['receipt', '--stream', 'append', '--event-id', 'q:start'])).toMatchObject({ status: 0, json: { status: 'accepted' } })
  })

  it('an empty resubmission of an admitted event is a conflict; a terminal receipt closes admission even after cleanup', () => {
    const binding = bind('launcher.sh')
    const invocation = reserve(binding)
    append(binding, invocation, 'e:start', 'start', 'Job started')
    expect(append(binding, invocation, 'e:start', 'start', '  ')).toMatchObject({ status: 5, json: { status: 'conflict' } })
    expect(append(binding, reserve(binding), 'e:start', 'start', '')).toMatchObject({ status: 5, json: { status: 'conflict', invocation_id: invocation } })
    const started = readFileSync(join(spoolDir(binding), invocation, 'started.json'), 'utf8')
    complete(binding, invocation, 'e:final', 'done')
    m.importer.importScriptReports()
    expect(spool(binding)).not.toContain(invocation)
    // Race: an append that read the started record just before Studio's cleanup removed the invocation.
    const late = spawnSync(PYTHON, ['-c', [
      'import importlib.util, json, sys',
      `spec = importlib.util.spec_from_file_location("w", ${JSON.stringify(wrapperOf(binding))})`,
      'w = importlib.util.module_from_spec(spec); spec.loader.exec_module(w)',
      `saved = json.loads(${JSON.stringify(started)})`,
      'w._started = lambda manifest, invocation: saved',
      'sys.exit(w.helper(["append", "--event-id", "e:late", "--event-kind", "body", "--content-file", "-"]))',
    ].join('\n')], { input: 'too late', encoding: 'utf8', env: { ...process.env, EKKO_SCRIPT_REPORT_INVOCATION: invocation } })
    expect({ status: late.status, json: JSON.parse(late.stdout) }).toMatchObject({ status: 2, json: { error: 'invocation_finalized' } })
    expect(readdirSync(join(m.paths.scriptReportOutboxDir(binding.binding_id), 'invocations', invocation))).toEqual(['01.json'])
  })

  it('every field of an existing receipt must equal the committed one, or the invocation is held', () => {
    for (const change of [{ exact: false }, { accepted_sha256: sha('other') }, { job_id: 'other-job' }, { event_kind: 'failure' }]) {
      const binding = bind('launcher.sh')
      const invocation = reserve(binding)
      append(binding, invocation, 'f:start', 'start', 'field check')
      m.importer.importScriptReports()
      const path = join(m.paths.scriptReportReceiptsDir(binding.binding_id), 'events', `${sha('f:start')}.json`)
      writeFileSync(path, JSON.stringify({ ...eventReceipt(binding, 'f:start'), ...change }))
      complete(binding, invocation, 'f:final', 'field done')
      m.importer.importScriptReports()
      expect(spool(binding), JSON.stringify(change)).toEqual([invocation])
    }
    // An unreadable receipt in place before settlement is not a receipt either.
    const binding = bind('launcher.sh')
    const invocation = reserve(binding)
    append(binding, invocation, 'u:start', 'start', 'unreadable')
    mkdirSync(join(m.paths.scriptReportReceiptsDir(binding.binding_id), 'events', `${sha('u:start')}.json`), { recursive: true })
    complete(binding, invocation, 'u:final', 'done')
    m.importer.importScriptReports()
    expect(spool(binding)).toEqual([invocation])
  })

  it('a retry racing terminal cleanup never recreates the removed invocation', () => {
    const binding = bind('launcher.sh')
    const invocation = reserve(binding)
    append(binding, invocation, 'g:start', 'start', 'race')
    complete(binding, invocation, 'g:final', 'done')
    m.importer.importScriptReports()
    expect(spool(binding)).toEqual([])
    // The retry saw no receipt and an existing invocation just before Studio's cleanup removed it.
    const retry = spawnSync(PYTHON, ['-c', [
      'import importlib.util, os, sys',
      `spec = importlib.util.spec_from_file_location("w", ${JSON.stringify(wrapperOf(binding))})`,
      'w = importlib.util.module_from_spec(spec); spec.loader.exec_module(w)',
      'status, isdir = w._event_status, os.path.isdir',
      'calls = []',
      'def stale(manifest, envelope):',
      '    calls.append(1)',
      '    return ("queued", None) if len(calls) == 1 else status(manifest, envelope)',
      'w._event_status = stale',
      `os.path.isdir = lambda path: True if path.endswith(${JSON.stringify(invocation)}) else isdir(path)`,
      'sys.exit(w.helper(["append", "--event-id", "g:start", "--event-kind", "start", "--content-file", "-"]))',
    ].join('\n')], { input: 'race', encoding: 'utf8', env: { ...process.env, EKKO_SCRIPT_REPORT_INVOCATION: invocation } })
    expect(retry.status, retry.stdout + retry.stderr).toBe(0)
    expect(existsSync(join(spoolDir(binding), invocation))).toBe(false)
  })

  it('FAILURE INJECTION (no ordinary trigger known): a sanitizer exception refuses the append before any admission', () => {
    const binding = bind('launcher.sh')
    const invocation = reserve(binding)
    const injected = spawnSync(PYTHON, ['-c', [
      'import importlib.util, sys',
      `spec = importlib.util.spec_from_file_location("w", ${JSON.stringify(wrapperOf(binding))})`,
      'w = importlib.util.module_from_spec(spec); spec.loader.exec_module(w)',
      'def broken(text): raise RuntimeError("injected sanitizer fault")',
      'w.sanitize = broken',
      'sys.exit(w.helper(["append", "--event-id", "s:body", "--event-kind", "body", "--content-file", "-"]))',
    ].join('\n')], { input: 'secret body token=abcdef1234567890', encoding: 'utf8', env: { ...process.env, EKKO_SCRIPT_REPORT_INVOCATION: invocation } })
    expect({ status: injected.status, json: JSON.parse(injected.stdout) }).toEqual({ status: 2, json: { status: 'error', error: 'redaction_failed' } })
    const outbox = m.paths.scriptReportOutboxDir(binding.binding_id)
    expect(existsSync(join(outbox, 'invocations', invocation))).toBe(false)
    expect(existsSync(join(outbox, 'events', `${sha('s:body')}.json`))).toBe(false)
    expect(existsSync(join(outbox, 'admitting.json'))).toBe(false)
    // Nothing was consumed: the same event later admits normally and the invocation drains.
    expect(append(binding, invocation, 's:body', 'body', 'clean body')).toMatchObject({ status: 3, json: { sequence: 1 } })
    complete(binding, invocation, 's:final', 'done')
    m.importer.importScriptReports()
    expect(shown()).toEqual([['body', 'clean body'], ['terminal', 'done']])
    expect(spool(binding)).toEqual([])
  })

  it('fences: a revoked binding rejects pending notices; without the job reader nothing is imported; sync bindings cannot append', () => {
    const binding = bind('launcher.sh')
    const invocation = reserve(binding)
    append(binding, invocation, 'run-12:start', 'start', 'Job started')
    m.importer.setScriptReportJobInspector(null)
    expect(m.importer.importScriptReports().processed).toBe(0)
    expect(eventFiles(binding, invocation)).toEqual(['01.json'])
    m.importer.setScriptReportJobInspector(m.jobs.readNativeJob)
    m.reports.transitionScriptReportBinding(binding.binding_id, ['active'], 'revoked')
    m.importer.importScriptReports()
    expect(notices()).toHaveLength(0)
    expect(eventReceipt(binding, 'run-12:start')).toMatchObject({ state: 'rejected', reason: 'binding_revoked', notification_id: null, exact: false })
    expect(append(binding, invocation, 'run-12:start', 'start', 'Job started')).toMatchObject({ status: 4, json: { status: 'rejected' } })
    writeFileSync(join(hermesHome, 'scripts', 'reports', 'plain.sh'), '#!/bin/bash\necho hello\n')
    const sync = bind('plain.sh', 'sync')
    expect(helper(sync, ['append', '--event-id', 'x', '--event-kind', 'start', '--content-file', '-'], 'x')).toMatchObject({ status: 2,
      json: { error: 'completion_not_detached' } })
  })
})
