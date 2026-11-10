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
