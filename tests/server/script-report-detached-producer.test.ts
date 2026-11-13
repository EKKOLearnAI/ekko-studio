import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { renderWrapper } from '../../packages/server/src/modules/hermes/services/script-reports/wrapper'

// Producer side of detached completion only: the real generated wrapper and its `complete` /
// `receipt` helper run as Python processes against a private spool. Studio's importer (which writes
// receipts) is not part of this test; receipts are written here as the importer would.
const PYTHON = process.env.SCRIPT_REPORT_TEST_PYTHON || 'python3'
const SECRET = 'sk-test-ABCDEFGHIJKLMNOPQRSTUVWX123456'

let root: string
let spool: string
let receipts: string
let wrapper: string
let handoff: string

const sha = (text: string) => createHash('sha256').update(text).digest('hex')

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'script-report-detached-')))
  const scripts = join(root, 'hermes', 'scripts')
  const binding = join(root, 'studio', 'bindings', 'b-1')
  spool = join(root, 'studio', 'spool', 'b-1')
  receipts = join(root, 'studio', 'receipts', 'b-1')
  handoff = join(root, 'handoff.json')
  // Enrollment creates the private spool and outbox; the helper refuses anything else.
  for (const dir of [join(scripts, 'ekko-script-reports'), join(scripts, 'jobs'), spool, join(binding, 'outbox'), receipts]) mkdirSync(dir, { recursive: true })
  for (const dir of [spool, join(binding, 'outbox')]) chmodSync(dir, 0o700)
  // A launcher that hands the reserved invocation to a "worker" (this test) and exits cleanly.
  const target = join(scripts, 'jobs', 'launch.py')
  const body = [
    'import json, os, sys',
    `json.dump({k: os.environ[k] for k in ("EKKO_SCRIPT_REPORT_INVOCATION", "EKKO_SCRIPT_REPORT_HELPER")}, open(${JSON.stringify(handoff)}, "w"))`,
    'print("launched")',
  ].join('\n')
  writeFileSync(target, body)
  const manifest = join(binding, 'manifest.json')
  writeFileSync(manifest, JSON.stringify({
    schema_version: 1, binding_id: 'b-1', binding_revision: 1,
    target: { path: target, kind: 'python', cwd: join(scripts, 'jobs') }, target_sha256: sha(body),
    spool_dir: spool, revoked_marker: join(binding, 'revoked'), max_pending: 200,
    completion: 'detached', outbox_dir: join(binding, 'outbox'), receipts_dir: receipts,
  }), { mode: 0o600 })
  wrapper = join(scripts, 'ekko-script-reports', 'launch.py.wrapper.py')
  writeFileSync(wrapper, renderWrapper(manifest), { mode: 0o700 })
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

function launch() {
  const result = spawnSync(PYTHON, [wrapper], { cwd: join(root, 'hermes', 'scripts', 'ekko-script-reports'), encoding: 'utf8' })
  expect(result.status).toBe(0)
  const env = JSON.parse(readFileSync(handoff, 'utf8'))
  return { stdout: result.stdout, invocation: env.EKKO_SCRIPT_REPORT_INVOCATION as string, helper: env.EKKO_SCRIPT_REPORT_HELPER as string }
}

function helper(args: string[], input = '') {
  const result = spawnSync(PYTHON, [wrapper, ...args], { input, encoding: 'utf8' })
  return { status: result.status, out: JSON.parse(result.stdout.trim().split('\n').pop() || '{}') }
}

const complete = (invocation: string | null, event: string, content: string, outcome = 'output') =>
  helper(['complete', '--event-id', event, '--content-file', '-', '--outcome', outcome, ...(invocation ? ['--invocation', invocation] : [])], content)

const final = (invocation: string) => {
  const path = join(spool, invocation, 'final.json')
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
}

function writeReceipt(invocation: string, event: string, content: string, state: string) {
  writeFileSync(join(receipts, `${invocation}.json`), JSON.stringify({ binding_id: 'b-1', invocation_id: invocation, event_id: event, submitted_sha256: sha(content), state }))
}

describe('detached script report producer', () => {
  it('records a clean launcher exit as a handoff that reserves the invocation, never as a final report', () => {
    const { stdout, invocation, helper: path } = launch()

    expect(stdout).toBe('launched\n')
    expect(path).toBe(realpathSync(wrapper))
    expect(JSON.parse(readFileSync(join(spool, invocation, 'started.json'), 'utf8')).invocation_id).toBe(invocation)
    expect(final(invocation)).toBeNull()
  })

  it('completes the reserved invocation with one durable, sanitized detached report', () => {
    const { invocation } = launch()
    const content = `digest ready\napi_key=${SECRET}\n`

    const done = complete(invocation, 'daily:2026-11-10', content)

    expect(done.status).toBe(3)
    expect(done.out).toMatchObject({ status: 'queued', event_id: 'daily:2026-11-10', invocation_id: invocation })
    const report = final(invocation)
    expect(report).toMatchObject({ phase: 'final', completion: 'detached', outcome: 'output', event_id: 'daily:2026-11-10', submitted_sha256: sha(content), retry_of: null })
    expect(JSON.stringify(report)).toContain('digest ready')
    expect(JSON.stringify(report)).not.toContain(SECRET)
  })

  it('keeps the first submission: a retry with the same event and bytes changes nothing', () => {
    const { invocation } = launch()
    complete(invocation, 'evt-1', 'first body')
    const before = readFileSync(join(spool, invocation, 'final.json'), 'utf8')

    const again = complete(invocation, 'evt-1', 'first body')

    expect(again.out).toMatchObject({ status: 'queued', invocation_id: invocation })
    expect(readFileSync(join(spool, invocation, 'final.json'), 'utf8')).toBe(before)
    expect(readdirSync(spool).filter(name => !name.startsWith('.'))).toEqual([invocation])
  })

  it('refuses different bytes for an existing event as a conflict and keeps the original report', () => {
    const { invocation } = launch()
    complete(invocation, 'evt-1', 'first body')
    const before = readFileSync(join(spool, invocation, 'final.json'), 'utf8')

    const changed = complete(invocation, 'evt-1', 'other body')

    expect(changed.status).toBe(5)
    expect(changed.out).toMatchObject({ status: 'conflict', invocation_id: invocation })
    expect(readFileSync(join(spool, invocation, 'final.json'), 'utf8')).toBe(before)
  })

  it('needs a reserved invocation to complete', () => {
    expect(complete(null, 'evt-1', 'body').out).toEqual({ status: 'error', error: 'invocation_required' })
    expect(complete('00000000-0000-4000-8000-000000000001', 'evt-1', 'body').out).toEqual({ status: 'error', error: 'invocation_not_reserved' })
  })

  it('reports pending until a receipt for the same event and bytes settles the delivery', () => {
    const { invocation } = launch()
    expect(helper(['receipt', '--event-id', 'evt-1']).out).toMatchObject({ status: 'unknown', invocation_id: null })
    complete(invocation, 'evt-1', 'body')
    expect(helper(['receipt', '--event-id', 'evt-1']).out).toMatchObject({ status: 'queued', invocation_id: invocation, receipt: null })

    // A receipt of other bytes for that invocation never confirms this delivery.
    writeReceipt(invocation, 'evt-1', 'different body', 'accepted')
    expect(helper(['receipt', '--event-id', 'evt-1']).out).toMatchObject({ status: 'unknown' })

    writeReceipt(invocation, 'evt-1', 'body', 'accepted')
    const settled = helper(['receipt', '--event-id', 'evt-1'])
    expect(settled.status).toBe(0)
    expect(settled.out).toMatchObject({ status: 'accepted', invocation_id: invocation, receipt: { state: 'accepted' } })
  })
})
