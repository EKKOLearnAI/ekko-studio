import './fixtures/isolated-studio-state'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Script report import on real file storage: a SYNTHETIC file-contract producer (not the generated
// wrapper, which has its own tests) runs each target as a real child and writes the spool,
// the importer accepts into the passive inbox. Crash cases kill a real importer process.
const STUDIO = '../../packages/server/src/modules/studio'
const HERMES = '../../packages/server/src/modules/hermes'
const PYTHON = process.env.SCRIPT_REPORT_TEST_PYTHON || 'python3'
const PRODUCER = join(__dirname, 'fixtures', 'script-report-file-contract.py')
const SECRET = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

let root: string
let hermesHome: string
let m: any
let member: any

beforeEach(async () => {
  vi.resetModules()
  root = realpathSync(mkdtempSync(join(tmpdir(), 'script-report-import-')))
  hermesHome = join(root, 'hermes')
  mkdirSync(join(hermesHome, 'scripts', 'reports'), { recursive: true })
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
    presentation: await import(`${STUDIO}/services/session-notifications/presentation`),
    users: await import(`${STUDIO}/repositories/users-store`),
    paths: await import(`${STUDIO}/public/script-report-paths`),
    instance: (await import(`${STUDIO}/public/session-notifications`)).studioInstanceId,
    jobs: await import(`${HERMES}/services/script-reports/native-jobs`),
  }
  m.importer.setScriptReportJobInspector(m.jobs.readNativeJob)
  ;(await import(`${STUDIO}/repositories/session-notification-store`)).getSessionNotificationById(0) // creates the inbox tables
  member = m.users.createUser({ username: 'member', password: 'password-1', role: 'admin', status: 'active', profiles: ['default'] })
  m.store.createSession({ id: 'chat-1', profile: 'default', source: 'cli' })
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

const jobs: any[] = []
function saveJobs() { mkdirSync(join(hermesHome, 'cron'), { recursive: true }); writeFileSync(join(hermesHome, 'cron', 'jobs.json'), JSON.stringify({ jobs })) }

/** An active binding with its manifest, producer script and native job, as enrollment leaves it. */
/** Record every observation the registered start/interval callbacks run, so a test can drain them exactly. */
function drainedObservations(live: any, ChatRunSocket: any): Promise<void>[] {
  const runs: Promise<void>[] = []
  live.observeCronSessionResults = function () { const run = ChatRunSocket.prototype.observeCronSessionResults.call(this); runs.push(run); return run }
  return runs
}

function bind(script: string, body: string, frozen: Record<string, unknown> = {}) {
  const target = join(hermesHome, 'scripts', 'reports', script)
  writeFileSync(target, body)
  const bindingId = randomUUID()
  const wrapperScript = `ekko-script-reports/${bindingId}.py`
  for (const dir of [m.paths.scriptReportBindingDir(bindingId), m.paths.scriptReportSpoolDir(bindingId), join(hermesHome, 'scripts', 'ekko-script-reports')]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700)
  }
  const manifest = m.paths.scriptReportManifestPath(bindingId, 1)
  writeFileSync(manifest, JSON.stringify({ schema_version: 1, binding_id: bindingId, binding_revision: 1,
    target: { path: target, kind: script.endsWith('.sh') ? 'bash' : 'python', cwd: join(hermesHome, 'scripts', 'reports') },
    target_sha256: createHash('sha256').update(body).digest('hex'), spool_dir: m.paths.scriptReportSpoolDir(bindingId),
    revoked_marker: m.paths.scriptReportRevokedMarker(bindingId), max_pending: 200 }), { mode: 0o600 })
  // Synthetic file-contract producer in place of the generated wrapper (the wrapper has its own tests).
  writeFileSync(join(hermesHome, 'scripts', wrapperScript), `import runpy, sys\nsys.argv = [sys.argv[0], ${JSON.stringify(manifest)}]\nrunpy.run_path(${JSON.stringify(PRODUCER)}, run_name='__main__')\n`, { mode: 0o700 })
  m.reports.insertScriptReportBinding({ binding_id: bindingId, revision: 1, namespace: m.instance(), profile: 'default',
    session_id: 'chat-1', session_generation: m.store.getSessionGeneration('chat-1'), account_id: member.id,
    job_name: `Job ${script}`, target_script: `reports/${script}`, wrapper_script: wrapperScript, ...frozen })
  const jobId = `job-${bindingId.slice(0, 8)}`
  m.reports.transitionScriptReportBinding(bindingId, ['enrolling'], 'active', { job_id: jobId })
  jobs.push({ id: jobId, script: wrapperScript, no_agent: true, deliver: 'local', enabled: true })
  saveJobs()
  return m.reports.getScriptReportBinding(bindingId)
}

/** Run the producer script the way Hermes runs a no_agent script. */
function fire(binding: any, options: { startedOnly?: boolean } = {}) {
  return spawnSync(PYTHON, [join(hermesHome, 'scripts', binding.wrapper_script)], { cwd: join(hermesHome, 'scripts', 'ekko-script-reports'), encoding: 'utf8',
    env: { ...process.env, ...(options.startedOnly ? { SCRIPT_REPORT_FIXTURE_STARTED_ONLY: '1' } : {}) } })
}

const notices = () => m.db.prepare("SELECT * FROM session_notifications WHERE kind='script_report' ORDER BY id").all() as any[]
const attention = () => (m.db.prepare("SELECT COUNT(*) AS n FROM session_attention_events WHERE event_key LIKE 'session-notice:%'").get() as any).n
const spool = (binding: any) => readdirSync(m.paths.scriptReportSpoolDir(binding.binding_id)).filter((name: string) => !name.startsWith('.'))
const finalOf = (binding: any, id: string) => join(m.paths.scriptReportSpoolDir(binding.binding_id), id, 'final.json')

describe('script report import', () => {
  beforeEach(() => { jobs.length = 0 })

  it('imports a report as a passive notice with attention and no model history', () => {
    const binding = bind('digest.py', 'print("digest ready")\n')
    expect(fire(binding).stdout).toBe('digest ready\n')
    expect(m.importer.importScriptReports().accepted).toHaveLength(1)
    const [row] = notices()
    expect(row).toMatchObject({ disposition: 'notified', attention_pending: 1, session_id: 'chat-1' })
    expect(JSON.parse(row.payload)).toMatchObject({ content: 'digest ready', outcome: 'output', identity_kind: 'wrapper_invocation', native_execution_id: null })
    expect(m.presentation.noticeToMessage(row && { ...row, payload: JSON.parse(row.payload) }).studio_notice.kind).toBe('script_report')
    expect(m.db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 0 })
    expect(spool(binding)).toEqual([])
  })

  it('records silence without attention and a failure with its exit code', () => {
    const quiet = bind('quiet.sh', 'echo "checked" >&2\n')
    const broken = bind('broken.sh', 'echo "[SILENT]"\nexit 4\n')
    fire(quiet); fire(broken)
    m.importer.importScriptReports()
    const rows = notices().map(row => ({ ...row, payload: JSON.parse(row.payload) }))
    expect(rows.find(row => row.payload.job_name === 'Job quiet.sh')).toMatchObject({ disposition: 'silent', attention_pending: 0 })
    expect(rows.find(row => row.payload.job_name === 'Job broken.sh')).toMatchObject({ disposition: 'notified', payload: { outcome: 'failed', exit_code: 4 } })
    expect(attention()).toBe(1)
  })

  it('keeps repeated invocations distinct and quarantines a conflicting report without overwriting', () => {
    const binding = bind('digest.py', 'print("digest ready")\n')
    fire(binding)
    const [id] = spool(binding)
    const saved = join(root, 'saved')
    cpSync(join(m.paths.scriptReportSpoolDir(binding.binding_id), id), saved, { recursive: true })
    fire(binding); fire(binding)
    m.importer.importScriptReports()
    expect(new Set(notices().map(row => JSON.parse(row.payload).invocation_id)).size).toBe(3)
    const final = JSON.parse(readFileSync(join(saved, 'final.json'), 'utf8'))
    writeFileSync(join(saved, 'final.json'), JSON.stringify({ ...final, content: 'tampered' }), { mode: 0o600 })
    cpSync(saved, join(m.paths.scriptReportSpoolDir(binding.binding_id), id), { recursive: true })
    m.importer.importScriptReports()
    expect(notices().filter(row => JSON.parse(row.payload).invocation_id === id).map(row => JSON.parse(row.payload).content)).toEqual(['digest ready'])
    expect(m.reports.countScriptReportInvocations(binding.binding_id)).toMatchObject({ accepted: 3, quarantined: 0 })
    expect(readdirSync(m.paths.scriptReportQuarantineDir(binding.binding_id))).toHaveLength(1)
  })

  it('never stores the raw secret and sanitizes again at acceptance', () => {
    const binding = bind('leak.py', `print("token=${SECRET}")\nprint("visible")\n`)
    fire(binding)
    const [id] = spool(binding)
    // The synthetic producer does not sanitize: write-time redaction is the wrapper's guarantee
    // ("sanitizes before the first durable write and never stores the raw secret" in its tests).
    // Here an adversarial, unsanitized record must still be redacted at acceptance.
    const final = JSON.parse(readFileSync(finalOf(binding, id), 'utf8'))
    rmSync(finalOf(binding, id))
    writeFileSync(finalOf(binding, id), JSON.stringify({ ...final, content: `password="a\\"b ${SECRET}" end` }), { mode: 0o600 })
    m.importer.importScriptReports()
    const payload = JSON.parse(notices()[0].payload)
    expect(payload.content).toBe('password=[REDACTED] end')
    expect(payload.redaction_status).toBe('redacted')
    expect(JSON.stringify(notices())).not.toContain(SECRET)
  })

  it('the acceptance sanitizer is linear and understands escaped quotes', () => {
    const inputs = ['x', 'a.', 'a:', 'a=', 'k=k', '"a":', 'token ', 'eyJa.', 'eyJ-', 'a@', '://a', '\n', 'a \n', ' ', '{"password":{', 'sk-']
      .map(unit => unit.repeat(Math.ceil(131072 / unit.length)).slice(0, 131072))
    for (const text of [...inputs, `begin\n${'\n'.repeat(131072)}end`]) {
      const started = performance.now()
      m.importer.sanitizeScriptReportText(text)
      expect(performance.now() - started, JSON.stringify(text.slice(0, 6))).toBeLessThan(1000)
    }
    expect(m.importer.sanitizeScriptReportText('{"result":{"password":"prefix\\"suffix-secret tail"}} [{"api_key":"k1"}]'))
      .toBe('{"result":{"password":[REDACTED]}} [{"api_key":[REDACTED]}]')
    expect(m.importer.sanitizeScriptReportText('Authorization: Bearer abcdefghij\nnext')).toBe('Authorization: [REDACTED]\nnext')
    expect(m.importer.sanitizeScriptReportText('{"credentials": {"password": "prefix\\"x tail"}, "tokens": ["one secret", "two"], "keep": 1}'))
      .toBe('{"credentials": [REDACTED], "tokens": [REDACTED], "keep": 1}')
    expect(m.importer.sanitizeScriptReportText(JSON.stringify({ password: 'prefix"suffix-secret tail-secret' }))).toBe('{"password":[REDACTED]}')
  })

  it('uses the binding, never the report, to choose the destination, and refuses symlinked records', () => {
    const binding = bind('digest.py', 'print("digest ready")\n')
    fire(binding)
    const [id] = spool(binding)
    const final = JSON.parse(readFileSync(finalOf(binding, id), 'utf8'))
    for (const tampered of [{ binding_id: 'other' }, { binding_revision: 2 }, { invocation_id: 'x' }, { native_execution_id: 'native-1' },
      { identity_kind: 'native' }, { outcome: 'success' }]) {
      expect(m.importer.parseScriptReport(Buffer.from(JSON.stringify({ ...final, ...tampered })), binding, id), JSON.stringify(tampered)).toBeNull()
    }
    const outside = join(root, 'outside.json')
    cpSync(finalOf(binding, id), outside)
    rmSync(finalOf(binding, id))
    symlinkSync(outside, finalOf(binding, id))
    m.importer.importScriptReports()
    expect(notices()).toEqual([])
    expect(m.reports.countScriptReportInvocations(binding.binding_id).quarantined).toBe(1)
  })

  it('fails closed after a reset, account loss or revocation and never reroutes', () => {
    const reset = bind('a.py', 'print("a")\n')
    m.store.clearSessionMessages('chat-1')
    fire(reset)
    m.importer.importScriptReports()
    expect(m.reports.getScriptReportInvocation(reset.binding_id, m.db.prepare('SELECT invocation_id FROM script_report_invocations').get().invocation_id)?.detail).toBe('owner_missing')
    const disabled = bind('b.py', 'print("b")\n')
    m.users.updateUser({ userId: member.id, status: 'disabled' })
    fire(disabled)
    m.importer.importScriptReports()
    m.users.updateUser({ userId: member.id, status: 'active' })
    const revoked = bind('c.py', 'print("c")\n')
    fire(revoked)
    m.reports.transitionScriptReportBinding(revoked.binding_id, ['active'], 'revoked')
    m.importer.importScriptReports()
    expect(notices()).toEqual([])
    const details = (m.db.prepare('SELECT detail FROM script_report_invocations ORDER BY rowid').all() as any[]).map(row => row.detail)
    expect(details).toEqual(['owner_missing', 'account_forbidden', 'binding_revoked'])
  })

  it('stops importing when the native job is edited away from the enrolled wrapper or local delivery', () => {
    const binding = bind('digest.py', 'print("digest ready")\n')
    for (const edit of [{ deliver: 'slack:C1' }, { no_agent: false }, { script: 'reports/digest.py' }, null]) {
      jobs.splice(0, jobs.length, ...(edit ? [{ id: binding.job_id, script: binding.wrapper_script, no_agent: true, deliver: 'local', ...edit }] : []))
      saveJobs()
      fire(binding)
      m.importer.importScriptReports()
      expect(notices(), JSON.stringify(edit)).toEqual([])
    }
    expect(m.reports.countScriptReportInvocations(binding.binding_id).rejected).toBe(4)
    jobs.splice(0, jobs.length, { id: binding.job_id, script: binding.wrapper_script, no_agent: true, deliver: 'local' })
    saveJobs()
    fire(binding)
    m.importer.importScriptReports()
    expect(notices()).toHaveLength(1)
  })

  it('imports nothing without the native job reader and keeps the report for later', () => {
    const binding = bind('digest.py', 'print("digest ready")\n')
    fire(binding)
    m.importer.setScriptReportJobInspector(null)
    expect(m.importer.importScriptReports().processed).toBe(0)
    expect(spool(binding)).toHaveLength(1)
  })

  it('leaves started-only and partially published invocations incomplete and shows an interrupted one as unknown', () => {
    const binding = bind('digest.py', 'print("digest ready")\n')
    const started = join(m.paths.scriptReportSpoolDir(binding.binding_id), '00000000-0000-4000-8000-000000000001')
    mkdirSync(started, { mode: 0o700 })
    writeFileSync(join(started, 'started.json'), JSON.stringify({ started_at: 1_700_000_000 }), { mode: 0o600 })
    writeFileSync(join(started, '.final.json.abc.tmp'), '{"partial', { mode: 0o600 })
    fire(binding)
    const id = spool(binding).find((name: string) => !name.startsWith('00000000'))!
    const final = JSON.parse(readFileSync(finalOf(binding, id), 'utf8'))
    rmSync(finalOf(binding, id))
    writeFileSync(finalOf(binding, id), JSON.stringify({ ...final, outcome: 'interrupted', content: null, omitted_reason: 'wrapper_signalled', signal: 15, exit_code: null }), { mode: 0o600 })
    expect(m.importer.importScriptReports().processed).toBe(1)
    expect(notices()[0]).toMatchObject({ disposition: 'unknown', attention_pending: 1 })
    expect(m.importer.incompleteScriptReports(binding)).toEqual([{ invocation_id: '00000000-0000-4000-8000-000000000001', started_at: 1_700_000_000 }])
  })

  it('nested secret assignments arrive redacted, and visible NUL markers arrive unquarantined', () => {
    const nested = bind('nested.py', 'import json\nprint(json.dumps({"result": {"password": "prefix\\"suffix-secret tail-secret"}}))\n')
    // The wrapper turns NUL bytes into visible U+2400 (its own test); this input is already converted.
    const nul = bind('nul.py', 'import sys\nsys.stdout.write("file-a\\u2400file-b\\u2400")\n')
    fire(nested); fire(nul)
    m.importer.importScriptReports()
    const contents = notices().map(row => JSON.parse(row.payload).content)
    expect(contents).toHaveLength(2)
    expect(JSON.stringify(notices())).not.toMatch(/suffix-secret|tail-secret/)
    expect(contents).toContain('file-a\u2400file-b\u2400')
    expect(m.reports.countScriptReportInvocations(nul.binding_id).quarantined).toBe(0)
  })

  it('quarantines a final record with a raw NUL byte or one over the record size limit', () => {
    const raw = bind('raw.py', 'print("ok")\n')
    const big = bind('big.py', 'print("ok")\n')
    fire(raw); fire(big)
    const [rawId] = spool(raw)
    const rawFinal = JSON.parse(readFileSync(finalOf(raw, rawId), 'utf8'))
    rmSync(finalOf(raw, rawId))
    writeFileSync(finalOf(raw, rawId), JSON.stringify({ ...rawFinal, content: 'file-a\u0000file-b' }), { mode: 0o600 })
    const [bigId] = spool(big)
    const bigFinal = JSON.parse(readFileSync(finalOf(big, bigId), 'utf8'))
    rmSync(finalOf(big, bigId))
    writeFileSync(finalOf(big, bigId), JSON.stringify({ ...bigFinal, padding: 'x'.repeat(100 * 1024) }), { mode: 0o600 })
    m.importer.importScriptReports()
    expect(notices()).toEqual([])
    expect(m.reports.countScriptReportInvocations(raw.binding_id).quarantined).toBe(1)
    expect(m.reports.countScriptReportInvocations(big.binding_id).quarantined).toBe(1)
  })

  it('a body of control characters arrives truncated instead of being quarantined', () => {
    const binding = bind('controls.py', 'import sys\nsys.stdout.write("\\x01" * 32768 + "end")\n')
    fire(binding)
    m.importer.importScriptReports()
    expect(notices()).toHaveLength(1)
    expect(JSON.parse(notices()[0].payload)).toMatchObject({ outcome: 'output', truncated: true })
  })

  it('a storage failure after the side effect yields no notice and no second execution across import passes', () => {
    const binding = bind('side.py', [
      'open("side.txt", "a").write("effect\\n")',
      'print("done")',
    ].join('\n') + '\n')
    // The side effect ran once, but no final record was ever published (the wrapper's own write-failure
    // handling is covered by its tests); the importer must neither notify nor run anything again.
    expect(fire(binding, { startedOnly: true })).toMatchObject({ status: 0, stdout: 'done\n' })
    m.importer.importScriptReports(); m.importer.importScriptReports()
    expect(notices()).toEqual([])
    expect(readFileSync(join(hermesHome, 'scripts', 'reports', 'side.txt'), 'utf8')).toBe('effect\n')
    expect(m.importer.incompleteScriptReports(binding)).toHaveLength(1)
  })
})

describe('importer killed at a durability boundary (real process)', () => {
  beforeEach(() => { jobs.length = 0 })

  function crashImport(at: 'commit' | 'receipt' | 'ack' | 'sweep') {
    const result = spawnSync(join(process.cwd(), 'node_modules', '.bin', 'vite-node'), ['tests/server/fixtures/script-report-import-crash.ts'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 400_000,
      env: { ...process.env, SCRIPT_REPORT_CRASH_AT: at, HERMES_WEB_UI_HOME: join(root, 'studio'), HERMES_HOME: hermesHome,
        HERMES_WEB_UI_TEST_DB_DIR: join(root, 'db'), NODE_ENV: 'test', AUTH_JWT_SECRET: 'script-report-test-secret' },
    })
    return result
  }

  it('killed before the inbox commit: nothing was accepted, the report stays, the next pass accepts it once', { timeout: 600_000 }, () => {
    const binding = bind('digest.py', 'print("digest ready")\n')
    fire(binding)
    const killed = crashImport('commit')
    expect(killed.signal, `status ${killed.status}\n${killed.stdout}\n${killed.stderr?.slice(-2000)}`).toBe('SIGKILL')
    const fresh = new DatabaseSync(join(root, 'db', 'hermes-web-ui.db'), { readOnly: true })
    expect(fresh.prepare("SELECT COUNT(*) AS n FROM session_notifications").get()).toEqual({ n: 0 })
    fresh.close()
    expect(spool(binding)).toHaveLength(1)
    expect(m.importer.importScriptReports().accepted).toHaveLength(1)
    expect(notices()).toHaveLength(1)
    expect(attention()).toBe(1)
  })

  for (const loss of ['target_changed', 'account_forbidden'] as const) {
    it(`a durable rejection (${loss}) survives a kill before acknowledgement, even once the destination is valid again`, { timeout: 600_000 }, () => {
      const binding = bind('digest.py', 'print("digest ready")\n')
      fire(binding)
      const restore = loss === 'target_changed'
        ? (() => { jobs[0].deliver = 'slack:C1'; saveJobs(); return () => { jobs[0].deliver = 'local'; saveJobs() } })()
        : (() => { m.users.updateUser({ userId: member.id, status: 'disabled' }); return () => m.users.updateUser({ userId: member.id, status: 'active' }) })()
      const killed = crashImport('ack')
      expect(killed.signal, `status ${killed.status}\n${killed.stdout}\n${killed.stderr?.slice(-2000)}`).toBe('SIGKILL')
      expect(spool(binding)).toHaveLength(1)
      restore()
      m.importer.importScriptReports()
      expect(notices()).toEqual([])
      expect(attention()).toBe(0)
      expect(spool(binding)).toEqual([])
      expect(m.db.prepare('SELECT state, detail FROM script_report_invocations').all()).toEqual([{ state: 'rejected', detail: loss }])
    })
  }

  for (const change of ['native destination', 'session reset', 'session recreated'] as const) {
    it(`killed between the inbox commit and the invocation receipt: a replay after a ${change} records the acceptance, never a rejection`, { timeout: 600_000 }, () => {
      const binding = bind('digest.py', 'print("digest ready")\n')
      fire(binding)
      const killed = crashImport('receipt')
      expect(killed.signal, `status ${killed.status}\n${killed.stdout}\n${killed.stderr?.slice(-2000)}`).toBe('SIGKILL')
      expect(notices()).toHaveLength(1)
      expect(m.db.prepare('SELECT COUNT(*) AS n FROM script_report_invocations').get()).toEqual({ n: 0 })
      // The destination changes before the replay: the committed acceptance still wins.
      if (change === 'native destination') { jobs[0].deliver = 'slack:C1'; saveJobs() }
      if (change === 'session reset') m.store.clearSessionMessages('chat-1')
      if (change === 'session recreated') { m.store.deleteSession('chat-1'); m.store.createSession({ id: 'chat-1', profile: 'default', source: 'cli' }) }
      const attentionBefore = attention()
      m.importer.importScriptReports()
      expect(m.db.prepare('SELECT state, notification_id FROM script_report_invocations').all()).toEqual([{ state: 'accepted', notification_id: notices()[0].id }])
      expect(notices()).toHaveLength(1)
      expect(attention()).toBe(attentionBefore)
      expect(spool(binding)).toEqual([])
    })
  }

  it('killed while removing an acknowledged entry: nothing is left incomplete or holding quota, and the remnant is swept', { timeout: 600_000 }, () => {
    const binding = bind('digest.py', 'print("digest ready")\n')
    fire(binding)
    const killed = crashImport('sweep')
    expect(killed.signal, `status ${killed.status}\n${killed.stdout}\n${killed.stderr?.slice(-2000)}`).toBe('SIGKILL')
    const all = () => readdirSync(m.paths.scriptReportSpoolDir(binding.binding_id))
    expect(spool(binding)).toEqual([])
    expect(all().some((name: string) => name.startsWith('.ack-'))).toBe(true)
    expect(m.importer.incompleteScriptReports(binding)).toEqual([])
    m.importer.importScriptReports()
    expect(all().filter((name: string) => name.startsWith('.ack-'))).toEqual([])
    expect(notices()).toHaveLength(1)
  })

  it('killed after the commit, before acknowledgement: the next pass is a duplicate with no second notice or attention', { timeout: 600_000 }, () => {
    const binding = bind('digest.py', 'print("digest ready")\n')
    fire(binding)
    const killed = crashImport('ack')
    expect(killed.signal, `status ${killed.status}\n${killed.stdout}\n${killed.stderr?.slice(-2000)}`).toBe('SIGKILL')
    const fresh = new DatabaseSync(join(root, 'db', 'hermes-web-ui.db'), { readOnly: true })
    expect(fresh.prepare("SELECT COUNT(*) AS n FROM session_notifications").get()).toEqual({ n: 1 })
    fresh.close()
    expect(spool(binding)).toHaveLength(1)
    expect(m.importer.importScriptReports().accepted).toEqual([])
    expect(notices()).toHaveLength(1)
    expect(attention()).toBe(1)
    expect(spool(binding)).toEqual([])
  })

  it('the chat-run observation tick imports finished reports and publishes them live', async () => {
    const binding = bind('tick.py', 'print("tick report")\n')
    fire(binding)
    const { ChatRunSocket } = await import(`${STUDIO}/sockets/chat-run`)
    const tick = Object.create(ChatRunSocket.prototype)
    tick.closing = false
    tick.cronObserveInFlight = false
    const published: any[] = []
    tick.publishSessionNotice = (record: any) => published.push(record)
    await tick.observeCronSessionResults()
    expect(published.map(record => record.payload.content)).toEqual(['tick report'])
    expect(spool(binding)).toEqual([])
    expect(tick.cronObserveInFlight).toBe(false)
  })

  it('refuses at import a report whose frozen target owner or trusted policy epoch no longer holds', () => {
    const owned = bind('owned.py', 'print("owned")\n')
    m.db.prepare('UPDATE script_report_bindings SET target_owner=? WHERE binding_id=?').run(member.id + 1000, owned.binding_id)
    fire(owned)
    m.importer.importScriptReports()
    const trusted = bind('trusted.py', 'print("trusted")\n')
    m.db.prepare('UPDATE script_report_bindings SET trusted_epoch=? WHERE binding_id=?').run('stale-epoch', trusted.binding_id)
    fire(trusted)
    m.importer.importScriptReports()
    expect(notices()).toEqual([])
    const details = (m.db.prepare('SELECT detail FROM script_report_invocations ORDER BY rowid').all() as any[]).map(row => row.detail)
    expect(details).toEqual(['owner_missing', 'policy_revoked'])
  })

  it('never publishes an accepted trusted notice once its policy epoch no longer holds', async () => {
    const { ChatRunSocket } = await import(`${STUDIO}/sockets/chat-run`)
    const late = Object.create(ChatRunSocket.prototype) // no namespace: any live emit attempt would throw
    expect(() => late.publishSessionNotice({ id: 1, session_id: 'chat-1', profile: 'default', disposition: 'notified',
      session_generation: m.store.getSessionGeneration('chat-1'), payload: { trusted: { account_id: member.id, epoch: 'revoked-epoch' } } })).not.toThrow()
    expect(() => late.publishSessionNotice({ id: 2, session_id: 'chat-1', profile: 'default', disposition: 'notified',
      session_generation: m.store.getSessionGeneration('chat-1'), payload: { trusted: { account_id: member.id, epoch: 'e', owner: member.id + 1000 } } })).not.toThrow()
  })


  it('the server bootstrap registers the native job reader for the importer', () => {
    // The adapter module is the sole registration; the bootstrap must import it.
    const bootstrap = readFileSync(join(__dirname, '../../packages/server/src/bootstrap/http.ts'), 'utf8')
    expect(bootstrap).toMatch(/^import '\.\/script-report-adapter'$/m)
  })


  it('publishes a trusted notice only while its frozen owner still owns the session under a current enabled epoch', async () => {
    const trusted = await import(`${STUDIO}/public/trusted-cron`)
    trusted.updateTrustedCronPolicy(member.id, 'default', true, trusted.trustedCronPolicy(member.id, 'default').revision)
    const epoch = trusted.trustedCronPolicy(member.id, 'default').epoch
    expect(trusted.trustedCronPolicyCurrent(member.id, 'default', epoch)).toBe(true)
    m.store.createSession({ id: 'owned-1', profile: 'default', source: 'cli', studio_user_id: member.id })
    const { ChatRunSocket } = await import(`${STUDIO}/sockets/chat-run`)
    const late = Object.create(ChatRunSocket.prototype) // no namespace: reaching the live path throws
    const record = (owner: number) => ({ id: 3, session_id: 'owned-1', profile: 'default', disposition: 'notified',
      session_generation: m.store.getSessionGeneration('owned-1'), payload: { trusted: { account_id: member.id, epoch, owner } } })
    // Owner still holds: the guard passes and publication proceeds to the live path.
    expect(() => late.publishSessionNotice(record(member.id))).toThrow()
    // The session no longer belongs to the frozen owner: refused before any live emit.
    expect(() => late.publishSessionNotice(record(member.id + 1000))).not.toThrow()
  })


  it('stops publishing the same frozen trusted notice once the stored session owner changes', async () => {
    const trusted = await import(`${STUDIO}/public/trusted-cron`)
    trusted.updateTrustedCronPolicy(member.id, 'default', true, trusted.trustedCronPolicy(member.id, 'default').revision)
    const epoch = trusted.trustedCronPolicy(member.id, 'default').epoch
    m.store.createSession({ id: 'owned-2', profile: 'default', source: 'cli', studio_user_id: member.id })
    const { ChatRunSocket } = await import(`${STUDIO}/sockets/chat-run`)
    const late = Object.create(ChatRunSocket.prototype) // no namespace: reaching the live path throws
    const frozen = Object.freeze({ id: 4, session_id: 'owned-2', profile: 'default', disposition: 'notified',
      session_generation: m.store.getSessionGeneration('owned-2'), payload: { trusted: { account_id: member.id, epoch, owner: member.id } } })
    expect(trusted.trustedCronPolicyCurrent(member.id, 'default', epoch)).toBe(true)
    expect(() => late.publishSessionNotice(frozen)).toThrow()
    // The stored owner changes through the session repository; the frozen payload is unchanged.
    m.store.updateSession('owned-2', { studio_user_id: String(member.id + 1000) })
    expect(m.store.getSessionGeneration('owned-2')).toBe(frozen.session_generation)
    expect(() => late.publishSessionNotice(frozen)).not.toThrow()
  })


  it('the production adapter module registers the native job reader the importer needs', async () => {
    const binding = bind('adapter.py', 'print("adapter report")\n')
    fire(binding)
    m.importer.setScriptReportJobInspector(null)
    expect(m.importer.importScriptReports().processed).toBe(0)
    expect(spool(binding)).toHaveLength(1)
    // Loading the real registration module (as bootstrap/http.ts does) installs the native job reader.
    await import('../../packages/server/src/bootstrap/script-report-adapter')
    expect(m.importer.importScriptReports().accepted.map((record: any) => record.payload.content)).toEqual(['adapter report'])
    expect(spool(binding)).toEqual([])
  })


  it('the observation tick publishes an imported report as session.notice to the target session only', async () => {
    const binding = bind('live.py', 'print("live report")\n')
    fire(binding)
    const outsider = m.users.createUser({ username: 'outsider-live', password: 'password-1', role: 'admin', status: 'active', profiles: ['other'] })
    const emitted: Record<string, any[]> = { target: [], other: [], outsider: [] }
    const sock = (name: string, userId: number) => ({ data: { user: { id: userId } }, emit: (event: string, payload: any) => emitted[name].push({ event, payload }) })
    const { ChatRunSocket } = await import(`${STUDIO}/sockets/chat-run`)
    const tick = Object.create(ChatRunSocket.prototype)
    tick.closing = false
    tick.cronObserveInFlight = false
    const synced: string[] = []
    tick.sessionStateSync = { publish: (sessionId: string) => synced.push(sessionId) }
    tick.nsp = {
      adapter: { rooms: new Map([['session:chat-1', new Set(['t'])], ['session:other-chat', new Set(['o'])], ['studio-account', new Set(['x'])]]) },
      sockets: new Map([['t', sock('target', member.id)], ['o', sock('other', member.id)], ['x', sock('outsider', outsider.id)]]),
    }
    await tick.observeCronSessionResults()
    expect(emitted.target.map(entry => entry.event)).toEqual(['session.notice'])
    expect(emitted.target[0].payload).toMatchObject({ event: 'session.notice', session_id: 'chat-1', profile: 'default' })
    expect(JSON.stringify(emitted.target[0].payload.message)).toContain('live report')
    expect(emitted.other).toEqual([])
    expect(emitted.outsider).toEqual([])
    expect(synced).toEqual(['chat-1'])
  })

  it('the registered timer delivers a trusted frozen binding to its target, then refuses it after policy revocation and after an owner change', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const trusted = await import(`${STUDIO}/public/trusted-cron`)
    const enable = () => { trusted.updateTrustedCronPolicy(member.id, 'default', true, trusted.trustedCronPolicy(member.id, 'default').revision); return trusted.trustedCronPolicy(member.id, 'default').epoch }
    m.store.updateSession('chat-1', { studio_user_id: String(member.id) })
    const emitted: any[] = []
    const { ChatRunSocket } = await import(`${STUDIO}/sockets/chat-run`)
    const live = Object.create(ChatRunSocket.prototype)
    try {
      const policyBound = bind('trusted-1.py', 'print("trusted report")\n', { trusted_epoch: enable(), target_owner: member.id })
      fire(policyBound)
      live.pollBackgroundWork = async () => {} // the background-work poller is outside this test
      live.cronObserveInFlight = false
      live.sessionStateSync = { publish: () => {} }
      live.nsp = { use: () => {}, on: () => {}, adapter: { rooms: new Map([['session:chat-1', new Set(['t'])]]) },
        sockets: new Map([['t', { data: { user: { id: member.id } }, emit: (event: string, payload: any) => emitted.push({ event, payload }) }]]) }
      const runs = drainedObservations(live, ChatRunSocket)
      live.init()
      expect(runs.length).toBe(1)
      await Promise.all(runs)
      expect(emitted.map(entry => entry.payload.session_id)).toEqual(['chat-1'])
      expect(JSON.stringify(emitted[0].payload.message)).toContain('trusted report')
      // Policy revoked: the same frozen binding's next report is refused on the next registered tick.
      trusted.updateTrustedCronPolicy(member.id, 'default', false, trusted.trustedCronPolicy(member.id, 'default').revision)
      fire(policyBound)
      vi.advanceTimersByTime(15_000)
      expect(runs.length).toBe(2)
      await Promise.all(runs)
      expect(emitted).toHaveLength(1)
      // A current epoch, then the stored session owner changes: the frozen owner is refused.
      const ownerBound = bind('trusted-2.py', 'print("owner report")\n', { trusted_epoch: enable(), target_owner: member.id })
      m.store.updateSession('chat-1', { studio_user_id: String(member.id + 1000) })
      fire(ownerBound)
      vi.advanceTimersByTime(15_000)
      expect(runs.length).toBe(3)
      await Promise.all(runs)
      expect(emitted).toHaveLength(1)
      // Control within the test: with the owner restored the same binding is delivered by the next tick.
      m.store.updateSession('chat-1', { studio_user_id: String(member.id) })
      fire(ownerBound)
      vi.advanceTimersByTime(15_000)
      await Promise.all(runs)
      expect(emitted.map(entry => JSON.stringify(entry.payload.message)).slice(1)).toEqual([expect.stringContaining('owner report')])
    } finally {
      clearInterval(live.cronObserveTimer); clearInterval(live.backgroundPollTimer)
      vi.useRealTimers()
    }
  })

  it('the observation timer registered by init() publishes at start and on its interval to the target session only', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const emitted: Record<string, any[]> = { target: [], other: [] }
    const sock = (name: string) => ({ data: { user: { id: member.id } }, emit: (event: string, payload: any) => emitted[name].push({ event, payload }) })
    const { ChatRunSocket } = await import(`${STUDIO}/sockets/chat-run`)
    const live = Object.create(ChatRunSocket.prototype)
    try {
      const first = bind('timer-1.py', 'print("first timer report")\n')
      fire(first)
      live.pollBackgroundWork = async () => {} // the background-work poller is outside this test
      live.cronObserveInFlight = false
      live.sessionStateSync = { publish: () => {} }
      live.nsp = { use: () => {}, on: () => {},
        adapter: { rooms: new Map([['session:chat-1', new Set(['t'])], ['session:other-chat', new Set(['o'])]]) },
        sockets: new Map([['t', sock('target')], ['o', sock('other')]]) }
      const runs = drainedObservations(live, ChatRunSocket)
      live.init()
      expect(runs.length).toBe(1)
      await Promise.all(runs)
      expect(emitted.target.map(entry => JSON.stringify(entry.payload.message))).toEqual([expect.stringContaining('first timer report')])
      const second = bind('timer-2.py', 'print("second timer report")\n')
      fire(second)
      vi.advanceTimersByTime(15_000)
      expect(runs.length).toBe(2)
      await Promise.all(runs)
      expect(emitted.target).toHaveLength(2)
      expect(JSON.stringify(emitted.target[1].payload.message)).toContain('second timer report')
      expect(emitted.other).toEqual([])
    } finally {
      clearInterval(live.cronObserveTimer); clearInterval(live.backgroundPollTimer)
      vi.useRealTimers()
    }
  })

})
