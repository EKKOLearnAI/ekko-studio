import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { renderWrapper } from '../../packages/server/src/modules/hermes/services/script-reports/wrapper'

// The generated wrapper runs as a real Python process, the way Hermes runs a no_agent script:
// cwd = the wrapper's folder, stdout/stderr captured, exit status observed.
const PYTHON = process.env.SCRIPT_REPORT_TEST_PYTHON || 'python3'
const SECRET = 'sk-test-ABCDEFGHIJKLMNOPQRSTUVWX123456'

let root: string
let scripts: string
let spool: string
let bindingDir: string

beforeEach(() => {
  // Enrollment pins the target's resolved path; /var/folders on macOS is a symlink.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'script-report-wrapper-')))
  scripts = join(root, 'hermes', 'scripts')
  spool = join(root, 'studio', 'spool', 'b-1')
  bindingDir = join(root, 'studio', 'bindings', 'b-1')
  for (const dir of [join(scripts, 'ekko-script-reports'), join(scripts, 'jobs'), spool, bindingDir]) mkdirSync(dir, { recursive: true })
  chmodSync(spool, 0o700)
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

function enroll(name: string, body: string, options: { workdir?: string; maxPending?: number } = {}) {
  const target = join(scripts, 'jobs', name)
  writeFileSync(target, body)
  const manifest = join(bindingDir, `manifest-${name}.json`)
  writeFileSync(manifest, JSON.stringify({
    schema_version: 1, binding_id: 'b-1', binding_revision: 1,
    target: { path: target, kind: /\.(sh|bash)$/.test(name) ? 'bash' : 'python', cwd: options.workdir || join(scripts, 'jobs') },
    target_sha256: createHash('sha256').update(body).digest('hex'),
    spool_dir: spool, revoked_marker: join(bindingDir, 'revoked'), max_pending: options.maxPending ?? 200,
  }), { mode: 0o600 })
  const wrapper = join(scripts, 'ekko-script-reports', `${name}.wrapper.py`)
  writeFileSync(wrapper, renderWrapper(manifest), { mode: 0o700 })
  return { target, wrapper }
}

function run(wrapper: string) {
  const result = spawnSync(PYTHON, [wrapper], { cwd: join(scripts, 'ekko-script-reports'), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  return { stdout: result.stdout, stderr: result.stderr, status: result.status, signal: result.signal }
}

function direct(target: string) {
  const bash = /\.(sh|bash)$/.test(target)
  const result = spawnSync(bash ? 'bash' : PYTHON, [target], { cwd: join(scripts, 'jobs'), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  return { stdout: result.stdout, stderr: result.stderr, status: result.status, signal: result.signal }
}

function reports(): any[] {
  return readdirSync(spool).filter(name => !name.startsWith('.')).map(id => {
    const dir = join(spool, id)
    const final = join(dir, 'final.json')
    return { id, started: JSON.parse(readFileSync(join(dir, 'started.json'), 'utf8')), final: existsSync(final) ? JSON.parse(readFileSync(final, 'utf8')) : null }
  })
}

function only() {
  const all = reports()
  expect(all).toHaveLength(1)
  return all[0]
}

function spoolBytes(): string {
  return readdirSync(spool).filter(id => !id.startsWith('.')).flatMap(id => readdirSync(join(spool, id)).map(file => readFileSync(join(spool, id, file), 'utf8'))).join('\n')
}

describe('generated script report wrapper', () => {
  it('relays a successful target exactly and records an invocation-bound output report', () => {
    const { target, wrapper } = enroll('ok.py', 'import sys\nprint("hello report")\nprint("diag", file=sys.stderr)\n')
    const native = direct(target)
    const wrapped = run(wrapper)
    expect(wrapped).toEqual(native)
    const { id, started, final } = only()
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(started).toMatchObject({ phase: 'started', identity_kind: 'wrapper_invocation', native_execution_id: null, invocation_id: id })
    expect(final).toMatchObject({ phase: 'final', outcome: 'output', exit_code: 0, content: 'hello report', native_execution_id: null,
      identity_kind: 'wrapper_invocation', invocation_id: id, binding_id: 'b-1', binding_revision: 1, child_launched: true })
    expect(statSync(join(spool, id)).mode & 0o777).toBe(0o700)
    expect(statSync(join(spool, id, 'final.json')).mode & 0o777).toBe(0o600)
  })

  it('applies the native wake gate, empty-output and silence-marker rules', () => {
    const cases: Array<[string, string, string]> = [
      ['empty.py', '', 'silent'],
      ['blank.py', 'print("   ")\nprint("")\n', 'silent'],
      ['gate.py', 'print("checked 3 things")\nprint(\'{"wakeAgent": false}\')\n', 'silent'],
      ['gate-string.py', 'print("x")\nprint(\'{"wakeAgent": "false"}\')\n', 'output'],
      ['gate-zero.py', 'print("x")\nprint(\'{"wakeAgent": 0}\')\n', 'output'],
      ['gate-bad.py', 'print("x")\nprint(\'{"wakeAgent": false\')\n', 'output'],
      ['silent-prefix.py', 'print("[SILENT] nothing new")\n', 'silent'],
      ['silent-last.py', 'print("checked")\nprint("NO_REPLY")\n', 'silent'],
      ['silent-zh.py', 'print("静默。")\n', 'silent'],
      ['silent-prose.py', 'print("we replied NO_REPLY to the bot yesterday")\n', 'output'],
      ['stderr-only.py', 'import sys\nprint("only diagnostics", file=sys.stderr)\n', 'silent'],
    ]
    for (const [name, body, outcome] of cases) {
      rmSync(spool, { recursive: true, force: true }); mkdirSync(spool, { mode: 0o700 })
      const { target, wrapper } = enroll(name, body)
      expect(run(wrapper), name).toEqual(direct(target))
      expect(only().final.outcome, name).toBe(outcome)
      if (outcome === 'silent') expect(only().final.content, name).toBeNull()
    }
  })

  it('lets failure take precedence over silence and keeps the native exit status', () => {
    const { target, wrapper } = enroll('fail.sh', 'echo "[SILENT]"\necho "boom" >&2\nexit 3\n')
    const wrapped = run(wrapper)
    expect(wrapped).toEqual(direct(target))
    expect(wrapped.status).toBe(3)
    const { final } = only()
    expect(final).toMatchObject({ outcome: 'failed', exit_code: 3, signal: null })
    expect(final.content).toBe('Script exited with code 3\nstderr:\nboom\nstdout:\n[SILENT]')
  })

  it('dies by an uncatchable signal (SIGKILL) like the target instead of exiting with a code', () => {
    const { wrapper } = enroll('kill.py', 'import os, signal\nos.kill(os.getpid(), signal.SIGKILL)\n')
    const wrapped = run(wrapper)
    expect(wrapped.status).toBeNull()
    expect(wrapped.signal).toBe('SIGKILL')
    expect(only().final).toMatchObject({ outcome: 'failed', signal: 9, exit_code: null })
  })

  it('reproduces a signal exit instead of a normalized code', () => {
    const { target, wrapper } = enroll('sig.sh', 'echo partial\nkill -TERM $$\n')
    const wrapped = run(wrapper)
    expect(wrapped).toEqual(direct(target))
    expect(wrapped.signal).toBe('SIGTERM')
    expect(only().final).toMatchObject({ outcome: 'failed', signal: 15, exit_code: null })
  })

  it('preserves native cwd and the bash/Python interpreter choice', () => {
    writeFileSync(join(scripts, 'jobs', 'data.txt'), 'relative-data\n')
    const workdir = join(root, 'work')
    mkdirSync(workdir)
    writeFileSync(join(workdir, 'data.txt'), 'workdir-data\n')
    let { wrapper } = enroll('cwd.sh', 'cat data.txt\n[ -n "$BASH_VERSION" ] && echo bash\n')
    expect(run(wrapper).stdout).toBe('relative-data\nbash\n')
    rmSync(spool, { recursive: true, force: true }); mkdirSync(spool, { mode: 0o700 })
    ;({ wrapper } = enroll('cwd.py', 'import sys\nprint(open("data.txt").read().strip(), sys.version_info[0])\n', { workdir }))
    expect(run(wrapper).stdout).toBe('workdir-data 3\n')
  })

  it('sanitizes before the first durable write and never stores the raw secret', () => {
    const body = [
      `print("token=${SECRET}")`,
      `print("Authorization: Bearer ${SECRET}")`,
      `print("https://user:${SECRET}@example.org/x")`,
      `print('{"api_key": "${SECRET}"}')`,
      'print("-----BEGIN RSA PRIVATE KEY-----\\nMIIEabc\\n-----END RSA PRIVATE KEY-----")',
      'print("all good")',
    ].join('\n')
    const { wrapper } = enroll('secret.py', `${body}\n`)
    const wrapped = run(wrapper)
    expect(wrapped.stdout).toContain(SECRET) // the target's own stream is relayed unchanged
    const { final } = only()
    expect(final.redaction_status).toBe('redacted')
    expect(final.content).toContain('all good')
    expect(final.content).toContain('[REDACTED')
    expect(spoolBytes()).not.toContain(SECRET)
    expect(spoolBytes()).not.toContain('MIIEabc')
  })

  it('bounds capture: oversized output keeps relaying but stores no body and never infers silence', () => {
    const { target, wrapper } = enroll('big.py', 'import sys\nsys.stdout.write("x" * (1024 * 1024 + 10))\nprint()\nprint("[SILENT]")\n')
    const wrapped = run(wrapper)
    expect(wrapped.stdout.length).toBe(direct(target).stdout.length)
    expect(only().final).toMatchObject({ outcome: 'output_unavailable', omitted_reason: 'capture_limit', content: null })
  })

  it('truncates a large but captured body to 32 KiB with a flag', () => {
    const { wrapper } = enroll('long.py', 'print("é" * 40000)\n')
    run(wrapper)
    const { final } = only()
    expect(final.truncated).toBe(true)
    expect(Buffer.byteLength(final.content, 'utf8')).toBeLessThanOrEqual(32 * 1024)
  })

  it('gives every concurrent invocation of the same job its own identity', async () => {
    const { wrapper } = enroll('same.py', 'import time\ntime.sleep(0.3)\nprint("same output")\n')
    await Promise.all(Array.from({ length: 6 }, () => new Promise(resolve => {
      spawn(PYTHON, [wrapper], { cwd: join(scripts, 'ekko-script-reports'), stdio: 'ignore' }).on('exit', resolve)
    })))
    const all = reports()
    expect(all).toHaveLength(6)
    expect(new Set(all.map(entry => entry.id)).size).toBe(6)
    expect(all.every(entry => entry.final?.content === 'same output')).toBe(true)
  })

  it('fails preflight without starting the target when the spool is full or not private', () => {
    const { wrapper } = enroll('marker.py', 'open("ran.txt", "w").write("ran")\n', { maxPending: 1 })
    mkdirSync(join(spool, 'occupied'))
    const full = run(wrapper)
    expect(full.status).toBe(2)
    expect(full.stderr).toContain('report spool is full; the target script was not started')
    expect(existsSync(join(scripts, 'jobs', 'ran.txt'))).toBe(false)
    rmSync(join(spool, 'occupied'), { recursive: true })
    chmodSync(spool, 0o755)
    expect(run(wrapper).status).toBe(2)
    expect(existsSync(join(scripts, 'jobs', 'ran.txt'))).toBe(false)
  })

  it('runs a revoked binding as a plain passthrough with nothing captured', () => {
    const { target, wrapper } = enroll('revoked.py', 'print("still runs")\n')
    writeFileSync(join(bindingDir, 'revoked'), 'x')
    expect(run(wrapper)).toEqual(direct(target))
    expect(readdirSync(spool)).toEqual([])
  })

  it('leaves a started report without a final record when the wrapper is killed', async () => {
    const { wrapper } = enroll('slow.py', 'import time\nprint("begin", flush=True)\ntime.sleep(30)\n')
    const child = spawn(PYTHON, [wrapper], { cwd: join(scripts, 'ekko-script-reports'), stdio: ['ignore', 'pipe', 'ignore'], detached: true })
    await new Promise(resolve => child.stdout!.once('data', resolve))
    process.kill(-child.pid!, 'SIGKILL')
    await new Promise(resolve => child.on('exit', resolve))
    const { started, final } = only()
    expect(started.phase).toBe('started')
    expect(final).toBeNull()
  })

  it('refuses a target edited after enrollment without running it', () => {
    const { target, wrapper } = enroll('edited.py', 'open("ran.txt", "w").write("ran")\n')
    writeFileSync(target, 'open("ran.txt", "w").write("edited")\n')
    const result = run(wrapper)
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('target script changed since enrollment')
    expect(existsSync(join(scripts, 'jobs', 'ran.txt'))).toBe(false)
    expect(readdirSync(spool)).toEqual([])
  })

  it('refuses a target whose folder was replaced by a symlink, also when revoked', () => {
    const { wrapper } = enroll('contained.py', 'print("inside")\n')
    const outside = join(root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'contained.py'), 'print("inside")\nopen(__file__ + ".ran", "w").write("x")\n')
    renameSync(join(scripts, 'jobs'), join(scripts, 'jobs-old'))
    symlinkSync(outside, join(scripts, 'jobs'))
    for (const revoked of [false, true]) {
      if (revoked) writeFileSync(join(bindingDir, 'revoked'), 'x')
      const result = spawnSync(PYTHON, [wrapper], { cwd: join(scripts, 'ekko-script-reports'), encoding: 'utf8' })
      expect(result.status, `revoked=${revoked}`).toBe(2)
      expect(result.stderr).toContain('moved or replaced since enrollment')
    }
    expect(existsSync(join(outside, 'contained.py.ran'))).toBe(false)
    expect(readdirSync(spool)).toEqual([])
  })

  it('omits the body when sanitization fails', () => {
    const { wrapper } = enroll('redact-fail.py', 'print("x")\n')
    const probe = spawnSync(PYTHON, ['-c', [
      'import importlib.util, json, sys',
      `spec = importlib.util.spec_from_file_location("w", ${JSON.stringify(wrapper)})`,
      'w = importlib.util.module_from_spec(spec); spec.loader.exec_module(w)',
      'def broken(text): raise RuntimeError("boom " + text)',
      'w.sanitize = broken',
      'final = w.build_final({"binding_id": "b", "binding_revision": 1}, "i", 0.0, 0.0, {"outcome": "output", "exit_code": 0, "detail": "secret detail"}, True)',
      'print(json.dumps(final))',
    ].join('\n')], { encoding: 'utf8' })
    const final = JSON.parse(probe.stdout)
    expect(final).toMatchObject({ content: null, omitted_reason: 'redaction_failed', redaction_status: 'failed' })
    expect(probe.stdout).not.toContain('secret detail')
  })
})

/** Run Python with the generated wrapper loaded as module `w` (its main() does not run). */
function probe(wrapper: string, code: string, cwd?: string, timeout = 60_000) {
  const result = spawnSync(PYTHON, ['-c', [
    'import importlib.util, json, os, signal, sys, threading, time',
    `spec = importlib.util.spec_from_file_location("w", ${JSON.stringify(wrapper)})`,
    'w = importlib.util.module_from_spec(spec); spec.loader.exec_module(w)',
    code,
  ].join('\n')], { encoding: 'utf8', cwd, timeout })
  if (result.status !== 0 && !result.signal) throw new Error(`probe failed: ${result.stderr}`)
  return result
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

describe('sanitizer, quota and record limits', () => {
  it('sanitizes adversarial 128 KiB inputs in linear time', () => {
    const { wrapper } = enroll('noop.py', 'print(1)\n')
    const result = probe(wrapper, [
      'worst = 0.0',
      'for unit in ["x", "a.", "a:", "a=", "k=k", "\\"a\\":", "token ", "eyJa.", "eyJ-", "a@", "://a", "\\n", "a \\n", " ", "{\\"password\\":{", "sk-"]:',
      '    text = (unit * (131072 // len(unit) + 1))[:131072]',
      '    start = time.perf_counter(); w.sanitize(text); worst = max(worst, time.perf_counter() - start)',
      'start = time.perf_counter(); w.sanitize("begin\\n" + "\\n" * 131072 + "end"); worst = max(worst, time.perf_counter() - start)',
      'print(worst)',
    ].join('\n'), undefined, 20_000)
    // A quadratic sanitizer does not finish within the probe's 20 s bound at all.
    expect(result.signal).toBeNull()
    expect(result.stdout.trim()).toMatch(/^\d/)
    expect(Number(result.stdout)).toBeLessThan(1.5)
  })

  it('redacts a whole escaped quoted value before the first durable write', () => {
    const body = 'import json\nprint(json.dumps({"password": "prefix\\"suffix-secret tail-secret"}))\nprint("visible")\n'
    const { wrapper } = enroll('escaped.py', body)
    run(wrapper)
    const { final } = only()
    expect(final.content).toContain('visible')
    expect(spoolBytes()).not.toMatch(/suffix-secret|tail-secret/)
  })

  it('redacts secret assignments nested in the value of another key', () => {
    const body = [
      'import json',
      'print(json.dumps({"result": {"password": "prefix\\"suffix-secret tail-secret"}}))',
      'print(json.dumps([{"name": "a", "api_key": "nested-key-value"}]))',
      'print(json.dumps({"credentials": {"password": "prefix\\"structured-secret tail"}}))',
      'print(json.dumps({"tokens": ["array-secret-one", "array-secret-two"]}))',
      'print("visible")',
    ].join('\n')
    const { wrapper } = enroll('nested.py', `${body}\n`)
    run(wrapper)
    expect(only().final).toMatchObject({ redaction_status: 'redacted' })
    expect(spoolBytes()).not.toMatch(/suffix-secret|tail-secret|nested-key-value|structured-secret|array-secret/)
  })

  it('shows NUL bytes visibly instead of publishing a report Studio must refuse', () => {
    const { wrapper } = enroll('nul.py', 'import sys\nsys.stdout.write("file-a\\0file-b\\0")\n')
    expect(run(wrapper).stdout).toBe('file-a\0file-b\0')
    const { final } = only()
    expect(final).toMatchObject({ outcome: 'output', content: 'file-a\u2400file-b\u2400' })
  })

  it('reserves quota under an exclusive lock, so a racing launch is refused', () => {
    const { wrapper } = enroll('quota.py', 'print(1)\n', { maxPending: 1 })
    const manifest = JSON.stringify(JSON.parse(readFileSync(join(bindingDir, 'manifest-quota.py.json'), 'utf8')))
    const result = probe(wrapper, [
      `manifest = json.loads(${JSON.stringify(manifest)})`,
      'errors = []',
      'def rival():',
      '    try: w.reserve_invocation(manifest, "00000000-0000-4000-8000-00000000000b", 0.0)',
      '    except w.PreflightError as exc: errors.append(str(exc))',
      'real_mkdir = os.mkdir',
      'def racing_mkdir(path, mode=0o777):',
      '    os.mkdir = real_mkdir',
      '    thread = threading.Thread(target=rival); thread.start(); thread.join(0.3)',
      '    real_mkdir(path, mode)',
      '    racing_mkdir.thread = thread',
      'os.mkdir = racing_mkdir',
      'w.reserve_invocation(manifest, "00000000-0000-4000-8000-00000000000a", 0.0)',
      'racing_mkdir.thread.join(5)',
      'print(json.dumps(errors))',
    ].join('\n'))
    expect(JSON.parse(result.stdout)).toEqual(['report spool is full'])
    expect(readdirSync(spool).filter(name => !name.startsWith('.'))).toEqual(['00000000-0000-4000-8000-00000000000a'])
  })

  it('concurrent launches never exceed the quota', async () => {
    const { wrapper } = enroll('busy.py', 'import time\ntime.sleep(0.5)\nprint("busy")\n', { maxPending: 2 })
    const codes = await Promise.all(Array.from({ length: 8 }, () => new Promise<number | null>(resolve => {
      spawn(PYTHON, [wrapper], { cwd: join(scripts, 'ekko-script-reports'), stdio: 'ignore' }).on('exit', code => resolve(code))
    })))
    expect(reports()).toHaveLength(2)
    expect(codes.filter(code => code === 0)).toHaveLength(2)
    expect(codes.filter(code => code === 2)).toHaveLength(6)
  })

  it('keeps the serialized record within the import limit by truncating escaped bodies', () => {
    const { wrapper } = enroll('controls.py', 'import sys\nsys.stdout.write("\\x01" * 32768 + "end")\n')
    run(wrapper)
    const { id, final } = only()
    expect(statSync(join(spool, id, 'final.json')).size).toBeLessThanOrEqual(92 * 1024)
    expect(final).toMatchObject({ outcome: 'output', truncated: true })
    expect(final.content.length).toBeGreaterThan(0)
  })
})

describe('process and storage failure boundaries', () => {
  function startGroup(wrapper: string) {
    // Hermes starts the script in its own session and signals the whole group.
    const child = spawn(PYTHON, [wrapper], { cwd: join(scripts, 'ekko-script-reports'), stdio: ['ignore', 'pipe', 'ignore'], detached: true })
    return child
  }
  const tree = 'import subprocess, time\nchild = subprocess.Popen(["sleep", "300"])\nopen("grandchild.pid", "w").write(str(child.pid))\nprint("ready", flush=True)\ntime.sleep(300)\n'

  it('SIGTERM to the group stops the target and its descendant and reports an interrupted invocation', async () => {
    const { wrapper } = enroll('tree-term.py', tree)
    const child = startGroup(wrapper)
    await new Promise(resolve => child.stdout!.once('data', resolve))
    const grandchild = Number(readFileSync(join(scripts, 'jobs', 'grandchild.pid'), 'utf8'))
    process.kill(-child.pid!, 'SIGTERM')
    const signal = await new Promise(resolve => child.on('exit', (_code, sig) => resolve(sig)))
    expect(signal).toBe('SIGTERM')
    await vi.waitFor(() => expect(alive(grandchild)).toBe(false), { timeout: 5000 })
    expect(only().final).toMatchObject({ outcome: 'interrupted', signal: 15, content: null })
  })

  it('SIGKILL to the group leaves no survivor and an incomplete (started-only) invocation', async () => {
    const { wrapper } = enroll('tree-kill.py', tree)
    const child = startGroup(wrapper)
    await new Promise(resolve => child.stdout!.once('data', resolve))
    const grandchild = Number(readFileSync(join(scripts, 'jobs', 'grandchild.pid'), 'utf8'))
    process.kill(-child.pid!, 'SIGKILL')
    await new Promise(resolve => child.on('exit', resolve))
    await vi.waitFor(() => expect(alive(grandchild)).toBe(false), { timeout: 5000 })
    const { started, final } = only()
    expect(started.phase).toBe('started')
    expect(final).toBeNull()
  })

  it('a report storage failure after the side effect keeps streams and exit status and never reruns', () => {
    // The target performs its side effect, then makes its own invocation folder read-only.
    const body = [
      'import os, sys',
      'open("side.txt", "a").write("effect\\n")',
      `spool = ${JSON.stringify(spool)}`,
      'for name in os.listdir(spool):',
      '    if not name.startswith("."): os.chmod(os.path.join(spool, name), 0o500)',
      'print("done")',
    ].join('\n')
    const { wrapper } = enroll('side.py', `${body}\n`)
    const result = run(wrapper)
    expect(result).toMatchObject({ status: 0, stdout: 'done\n' })
    expect(readFileSync(join(scripts, 'jobs', 'side.txt'), 'utf8')).toBe('effect\n')
    for (const name of readdirSync(spool).filter(name => !name.startsWith('.'))) chmodSync(join(spool, name), 0o700)
    const { started, final } = only()
    expect(started.phase).toBe('started')
    expect(final).toBeNull()
  })

  it('a process killed during final publication leaves no final record; killed after it, the record is durable', () => {
    const { wrapper } = enroll('publish.py', 'print("published")\n')
    for (const boundary of ['rename', 'fsync']) {
      rmSync(spool, { recursive: true, force: true }); mkdirSync(spool, { mode: 0o700 })
      // The real wrapper main() runs and SIGKILLs itself at the boundary: just before the atomic
      // no-replace link, or just after it (before the directory fsync and exit).
      const kill = boundary === 'rename'
        ? 'real = os.link\ndef dying(src, dst):\n    if dst.endswith("final.json"): os.kill(os.getpid(), signal.SIGKILL)\n    real(src, dst)\nos.link = dying'
        : 'real = w._fsync_dir\ncalls = []\ndef dying(path):\n    calls.append(path)\n    if len(calls) == 2: os.kill(os.getpid(), signal.SIGKILL)\n    real(path)\nw._fsync_dir = dying'
      const result = probe(wrapper, `${kill}\nw.main()`, join(scripts, 'ekko-script-reports'))
      expect(result.signal, boundary).toBe('SIGKILL')
      const [id] = readdirSync(spool).filter(name => !name.startsWith('.'))
      const files = readdirSync(join(spool, id))
      if (boundary === 'rename') {
        expect(files).toContain('started.json')
        expect(files).not.toContain('final.json')
        expect(files.some(name => name.startsWith('.final.json.') && name.endsWith('.tmp'))).toBe(true)
      } else {
        expect(JSON.parse(readFileSync(join(spool, id, 'final.json'), 'utf8'))).toMatchObject({ outcome: 'output', content: 'published' })
      }
    }
  })
})
