import { closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, writeSync } from 'fs'
import { createHash, randomUUID } from 'crypto'
import { basename, dirname, join } from 'path'
import { isPrivatePersonSession } from '../../contracts/person-session'
import { studioInstanceId } from '../../public/session-notifications'
import { scriptReportOutboxDir, scriptReportQuarantineDir, scriptReportReceiptsDir, scriptReportSpoolDir } from '../../public/script-report-paths'
import {
  acceptFencedSessionNotification,
  getSessionNotificationByKey,
  getSessionNotificationById,
  type SessionNotificationDisposition,
  type SessionNotificationRecord,
} from '../../repositories/session-notification-store'
import {
  getScriptReportEvent,
  getScriptReportEventAt,
  getScriptReportInvocation,
  listImportableScriptReportBindings,
  recordScriptReportEvent,
  recordScriptReportInvocation,
  settleScriptReportEvent,
  type ScriptReportEvent,
  type ScriptReportBinding,
  type ScriptReportInvocationState,
} from '../../repositories/script-report-store'
import { getSession } from '../../repositories/session-store'
import { findUserById, userCanAccessProfile } from '../../repositories/users-store'
import { trustedCronPolicyCurrent } from '../../public/trusted-cron'
import { targetOwnerCurrent } from './cron-observer'

/** Bounds shared with the generated wrapper (assets/script-reports/ekko_script_report_wrapper.py). */
const TOMBSTONE_PREFIX = '.ack-'

export const SCRIPT_REPORT_LIMITS = { contentBytes: 32 * 1024, recordBytes: 96 * 1024, batch: 50 }

const OUTCOMES = new Set(['output', 'silent', 'failed', 'launch_failed', 'interrupted', 'output_unavailable'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const REDACTIONS = new Set(['not_applicable', 'clean', 'redacted', 'failed'])
const SHA256 = /^[0-9a-f]{64}$/
const EVENT_ID = /^[^\u0000-\u001f\u007f-\u009f]{1,200}$/
/** Appended notices per invocation; the wrapper admits no more (APPEND_LIMIT). */
const EVENT_KINDS = new Set(['start', 'body', 'success', 'failure'])
const EVENT_FILE = /^(0[1-8])\.json$/
/** The helper counts an event id in characters (code points), as Python does; so does this check. */
const APPENDED_EVENT_ID = new RegExp(EVENT_ID.source, 'u')

export interface ScriptReportRecord {
  binding_id: string
  binding_revision: number
  invocation_id: string
  outcome: string
  exit_code: number | null
  signal: number | null
  content: string | null
  truncated: boolean
  omitted_reason: string | null
  redaction_status: string
  child_launched: boolean
  started_at: number
  finished_at: number
  duration_ms: number
  wrapper_version: string
  policy_version: string
  sanitizer_version: string
  /** Detached completion only: the producer's business event, its submitted bytes and the original invocation a retry reuses. */
  completion?: 'detached'
  event_id?: string | null
  submitted_sha256?: string | null
  retry_of?: string | null
}

// Same rules as the wrapper's sanitizer, applied again at acceptance (defense in depth). Linear on
// any input: bounded runs; a key starts at a key boundary and only a secret-named key consumes its
// value (quoted values honour backslash escapes), so assignments nested in another value are visited.
const SECRET_NAME = /secret|token|passw(?:or)?d|passwd|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|session[_-]?id|cookie|auth/i
const KEY = /(?<![A-Za-z0-9_.-])(["']?)([A-Za-z0-9_.-]{1,128})\1[ \t]{0,16}[:=][ \t]{0,16}/g
const VALUE = /"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|[^\s,;&]+/y
const RULES: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$(?![\s\S]))/g, '[REDACTED PRIVATE KEY]'],
  [/^([ \t]*(?:proxy-)?authorization[ \t]*[:=][ \t]*).+$/gim, '$1[REDACTED]'],
  [/\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]'],
  [/\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^/\s:@]{1,256}:[^/\s@]{1,256}@/gi, '$1[REDACTED]@'],
  // A JWT starts at the beginning of a base64url run, so each run is scanned once.
  [/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED JWT]'],
  [/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}/g, '[REDACTED KEY]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED KEY]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '[REDACTED KEY]'],
  [/\bglpat-[A-Za-z0-9_-]{16,}|\bnpm_[A-Za-z0-9]{30,}/g, '[REDACTED KEY]'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED KEY]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED KEY]'],
]

export function sanitizeScriptReportText(text: string): string {
  let result = text
  for (const [pattern, replacement] of RULES) result = result.replace(pattern, replacement)
  return redactAssignments(result)
}

/** End of the balanced object or array at `start` (quotes and escapes honoured); the end of the text when it never closes. */
function structuredEnd(text: string, start: number): number {
  let depth = 0
  let quote = ''
  let escaped = false
  for (let index = start; index < text.length; index++) {
    const ch = text[index]
    if (quote) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '[' || ch === '{') depth++
    else if ((ch === ']' || ch === '}') && --depth === 0) return index + 1
  }
  return text.length
}

function redactAssignments(text: string): string {
  let out = ''
  let copied = 0
  KEY.lastIndex = 0
  for (let key = KEY.exec(text); key; key = KEY.exec(text)) {
    if (!SECRET_NAME.test(key[2])) continue
    let end: number
    if (text[KEY.lastIndex] === '{' || text[KEY.lastIndex] === '[') {
      end = structuredEnd(text, KEY.lastIndex)
    } else {
      VALUE.lastIndex = KEY.lastIndex
      if (!VALUE.exec(text)) continue
      end = VALUE.lastIndex
    }
    out += `${text.slice(copied, KEY.lastIndex)}[REDACTED]`
    copied = KEY.lastIndex = end
  }
  return out + text.slice(copied)
}

/** Bounded read of a private regular file owned by this user; never follows a symlink. */
function readPrivateFile(path: string, limit: number): Buffer | null {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch {
    return null
  }
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || (process.getuid && info.uid !== process.getuid()) || info.size > limit) return null
    const buffer = Buffer.alloc(info.size)
    let offset = 0
    while (offset < info.size) {
      const read = readSync(fd, buffer, offset, info.size - offset, null)
      if (!read) break
      offset += read
    }
    return buffer.subarray(0, offset)
  } finally {
    closeSync(fd)
  }
}

const int = (value: unknown) => typeof value === 'number' && Number.isInteger(value)
const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value)

/** Strict schema check of a final wrapper report; anything else is quarantined. */
export function parseScriptReport(raw: Buffer, binding: ScriptReportBinding, invocationId: string): ScriptReportRecord | null {
  let value: any
  try {
    value = JSON.parse(raw.toString('utf8'))
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (value.schema_version !== 1 || value.phase !== 'final' || value.identity_kind !== 'wrapper_invocation') return null
  if (value.native_execution_id !== null) return null
  if (value.binding_id !== binding.binding_id || value.binding_revision !== binding.revision || value.invocation_id !== invocationId) return null
  if (!OUTCOMES.has(value.outcome) || !REDACTIONS.has(value.redaction_status)) return null
  if (!(value.exit_code === null || int(value.exit_code)) || !(value.signal === null || int(value.signal))) return null
  if (!(value.content === null || (typeof value.content === 'string'
    && Buffer.byteLength(value.content, 'utf8') <= SCRIPT_REPORT_LIMITS.contentBytes && !value.content.includes('\u0000')))) return null
  if (!(value.omitted_reason === null || (typeof value.omitted_reason === 'string' && /^[a-z_]{1,40}$/.test(value.omitted_reason)))) return null
  if (typeof value.truncated !== 'boolean' || typeof value.child_launched !== 'boolean') return null
  if (!num(value.started_at) || !num(value.finished_at) || !int(value.duration_ms)) return null
  for (const key of ['wrapper_version', 'policy_version', 'sanitizer_version']) {
    if (typeof value[key] !== 'string' || value[key].length > 64) return null
  }
  // The binding's frozen completion mode decides the shape; a report never switches it.
  if (binding.completion === 'detached') {
    if (value.completion !== 'detached') return null
    if (!(value.event_id === null || (typeof value.event_id === 'string' && EVENT_ID.test(value.event_id)))) return null
    if (!(value.submitted_sha256 === null || (typeof value.submitted_sha256 === 'string' && SHA256.test(value.submitted_sha256)))) return null
    if (!(value.retry_of === null || (typeof value.retry_of === 'string' && UUID.test(value.retry_of)))) return null
  } else if (value.completion !== undefined) return null
  return value as ScriptReportRecord
}

/** An appended notice of a reserved detached invocation, as the wrapper's `append` froze it. */
export interface ScriptReportEventRecord {
  binding_id: string
  binding_revision: number
  invocation_id: string
  event_id: string
  event_kind: string
  sequence: number
  submitted_sha256: string
  created_at: number
  content: string
  truncated: boolean
  omitted_reason: string | null
  redaction_status: string
}

/** Strict schema check of an appended notice in slot `sequence` of `invocationId`; anything else is quarantined. */
export function parseScriptReportEvent(raw: Buffer, binding: ScriptReportBinding, invocationId: string, sequence: number): ScriptReportEventRecord | null {
  let value: any
  try {
    value = JSON.parse(raw.toString('utf8'))
  } catch {
    return null
  }
  if (binding.completion !== 'detached' || !value || typeof value !== 'object' || Array.isArray(value)) return null
  if (value.schema_version !== 1 || value.phase !== 'event') return null
  if (value.binding_id !== binding.binding_id || value.binding_revision !== binding.revision || value.invocation_id !== invocationId) return null
  if (value.sequence !== sequence || !EVENT_KINDS.has(value.event_kind) || typeof value.event_id !== 'string' || !APPENDED_EVENT_ID.test(value.event_id)) return null
  if (typeof value.submitted_sha256 !== 'string' || !SHA256.test(value.submitted_sha256) || !num(value.created_at)) return null
  if (typeof value.content !== 'string' || !value.content || Buffer.byteLength(value.content, 'utf8') > SCRIPT_REPORT_LIMITS.contentBytes
    || value.content.includes('\u0000') || value.omitted_reason !== null) return null
  if (typeof value.truncated !== 'boolean' || !REDACTIONS.has(value.redaction_status)) return null
  return value as ScriptReportEventRecord
}

/** Passive notice disposition of a wrapper outcome; silence is recorded but never shown. */
function dispositionFor(outcome: string): { disposition: SessionNotificationDisposition; visible: boolean } {
  switch (outcome) {
    case 'silent': return { disposition: 'silent', visible: false }
    case 'interrupted': return { disposition: 'unknown', visible: true }
    case 'output_unavailable': return { disposition: 'status_only', visible: true }
    default: return { disposition: 'notified', visible: true }
  }
}

export function scriptReportProducerKey(binding: ScriptReportBinding, invocationId: string): string {
  return `script-report:${JSON.stringify([binding.binding_id, binding.revision, invocationId])}`
}

/** One inbox key per admitted slot: any replay of a slot, whatever event it claims, meets the committed notice. */
export function scriptReportEventProducerKey(binding: ScriptReportBinding, invocationId: string, sequence: number): string {
  return `script-report-event:${JSON.stringify([binding.binding_id, binding.revision, invocationId, sequence])}`
}

/**
 * Reports go to ordinary, locally stored Hermes bridge chats only. Ekko, coding-agent, workflow,
 * group chat, global agent and person sessions are refused.
 */
export function isScriptReportTarget(session: { id: string; source?: string | null; agent?: string | null; agent_session_id?: string | null }): boolean {
  return !isPrivatePersonSession(session.id)
    && ['', 'cli', 'api_server'].includes(session.source || '')
    && ['', 'hermes'].includes(session.agent || '')
    && !session.agent_session_id
}

/** The native job as Hermes stores it now; null when it no longer exists. */
export interface NativeScriptJob { script?: unknown; no_agent?: unknown; deliver?: unknown }
export type ScriptReportJobInspector = (profile: string, jobId: string) => NativeScriptJob | null

let jobInspector: ScriptReportJobInspector | null = null

/** Bootstrap registers the Hermes reader of native job configuration. */
export function setScriptReportJobInspector(inspector: ScriptReportJobInspector | null): void {
  jobInspector = inspector
}

/** Why a binding's reports may no longer reach its session, or null when they may. */
function ownerVerdict(binding: ScriptReportBinding): string | null {
  if (binding.state !== 'active') return 'binding_revoked'
  // An out-of-band edit of the native job (another script, agent mode, an explicit delivery
  // target) stops this lane: its reports are never imported into the old conversation.
  const job = binding.job_id ? jobInspector!(binding.profile, binding.job_id) : null
  if (!job || job.script !== binding.wrapper_script || job.no_agent !== true || job.deliver !== 'local') return 'target_changed'
  const user = findUserById(binding.account_id)
  if (!user || user.status !== 'active' || (user.role !== 'super_admin' && !userCanAccessProfile(user.id, binding.profile))) {
    return 'account_forbidden'
  }
  // A policy-created binding imports only under its own, still enabled policy epoch.
  if (binding.trusted_epoch !== null && !trustedCronPolicyCurrent(binding.account_id, binding.profile, binding.trusted_epoch)) return 'policy_revoked'
  const session = getSession(binding.session_id)
  if (!session || (session.profile || 'default') !== binding.profile || !isScriptReportTarget(session)) return 'owner_missing'
  if (!targetOwnerCurrent(binding.target_owner, binding.session_id)) return 'owner_missing'
  return null
}

export interface ScriptReportImportResult {
  accepted: SessionNotificationRecord[]
  processed: number
}

/** Acknowledge atomically: the entry leaves the spool in one rename; the tombstone is swept later if removal is cut short. */
function finish(dir: string): void {
  const tombstone = join(dirname(dir), `${TOMBSTONE_PREFIX}${basename(dir)}-${randomUUID()}`)
  try {
    renameSync(dir, tombstone)
  } catch {
    return
  }
  rmSync(tombstone, { recursive: true, force: true })
}

function quarantine(binding: ScriptReportBinding, invocation: string, dir: string): void {
  const target = scriptReportQuarantineDir(binding.binding_id)
  mkdirSync(target, { recursive: true, mode: 0o700 })
  try {
    renameSync(dir, join(target, `${invocation}-${Date.now()}`))
  } catch {
    finish(dir)
  }
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

/**
 * Detached completion: the producer-readable receipt of an invocation's durable disposition, written
 * (first one wins, fsynced) before its spool entry is acknowledged, so a crash in between rewrites
 * the same receipt on replay. A spool entry's disappearance is never the delivery proof.
 */
function writeReceipt(binding: ScriptReportBinding, invocation: string, report: ScriptReportRecord | null): void {
  if (binding.completion !== 'detached' || !UUID.test(invocation)) return
  const entry = getScriptReportInvocation(binding.binding_id, invocation)
  const dir = scriptReportReceiptsDir(binding.binding_id)
  const path = join(dir, `${invocation}.json`)
  if (!entry) return
  // A receipt linked before a crash still needs its directory entry to be durable before the spool
  // entry is acknowledged.
  if (existsSync(path)) return syncDirectory(dir)
  const notice = entry.notification_id === null ? null : getSessionNotificationById(entry.notification_id)
  const stored = entry.state === 'accepted' && typeof notice?.payload.content === 'string' ? notice.payload.content : null
  // An accepted or silent disposition carries the identity it was committed with: a replayed spool
  // entry may since have been rewritten with another event, and must never be certified as it.
  const identity: Partial<ScriptReportRecord> = notice ? notice.payload as Partial<ScriptReportRecord> : report ?? {}
  const submitted = identity.submitted_sha256 ?? null
  const accepted = stored === null ? null : sha256(stored)
  const receipt = {
    schema_version: 1, binding_id: binding.binding_id, binding_revision: binding.revision, job_id: binding.job_id,
    session_id: binding.session_id, session_generation: notice?.session_generation ?? binding.session_generation,
    invocation_id: invocation, event_id: identity.event_id ?? null, retry_of: identity.retry_of ?? null,
    state: entry.state, outcome: entry.outcome, reason: entry.detail, notification_id: entry.notification_id,
    submitted_sha256: submitted, accepted_sha256: accepted, exact: submitted !== null && accepted === submitted,
    settled_at: entry.updated_at,
  }
  publishReceipt(dir, `${invocation}.json`, receipt)
}

/** First receipt wins: exclusive temp file, fsync, no-replace link, directory fsync. */
function publishReceipt(dir: string, name: string, receipt: Record<string, unknown>): void {
  const path = join(dir, name)
  // Every publish re-syncs the parent: an earlier pass may have created the directory and then failed
  // its parent sync, so existence is no proof that the directory entry is durable.
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  syncDirectory(dirname(dir))
  const temp = join(dir, `.${name}.${randomUUID()}.tmp`)
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
  try {
    writeSync(fd, `${JSON.stringify(receipt)}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    linkSync(temp, path) // never replaces an existing receipt
  } catch (error: any) {
    if (error?.code !== 'EEXIST') throw error
  } finally {
    rmSync(temp, { force: true })
  }
  syncDirectory(dir)
}

/** Durable directory entry; a failure propagates so the spool entry stays for a later pass. */
function syncDirectory(dir: string): void {
  const dirFd = openSync(dir, constants.O_RDONLY)
  try {
    fsyncSync(dirFd)
  } finally {
    closeSync(dirFd)
  }
}

/** Receipt (detached completion), then acknowledgement of the spool entry. */
function acknowledge(binding: ScriptReportBinding, invocation: string, dir: string, report: ScriptReportRecord | null, quarantined: boolean): void {
  try {
    writeReceipt(binding, invocation, report)
  } catch {
    return // the disposition is durable: the entry stays and a later pass writes the same receipt
  }
  if (quarantined) quarantine(binding, invocation, dir)
  else finish(dir)
}

function settle(binding: ScriptReportBinding, invocation: string, dir: string, state: ScriptReportInvocationState,
  outcome: string | null, detail: string | null, notificationId: number | null = null, report: ScriptReportRecord | null = null): void {
  recordScriptReportInvocation({ binding_id: binding.binding_id, invocation_id: invocation, state, outcome, notification_id: notificationId, detail })
  acknowledge(binding, invocation, dir, report, state === 'quarantined')
}

/**
 * Reject a report, unless the inbox already committed its notice just before a crash, ahead of this
 * invocation's receipt (the destination may have changed or been reset since): then the historical
 * acceptance is recorded. Nothing is published again and no attention is added.
 */
function rejectUnlessCommitted(namespace: string, binding: ScriptReportBinding, invocation: string, dir: string,
  report: ScriptReportRecord, reason: string): void {
  const committed = getSessionNotificationByKey(namespace, binding.profile, scriptReportProducerKey(binding, invocation))
  if (committed) settle(binding, invocation, dir, committed.disposition === 'silent' ? 'silent' : 'accepted', report.outcome, null, committed.id, report)
  else settle(binding, invocation, dir, 'rejected', report.outcome, reason, null, report)
}

const eventReceiptName = (eventId: string) => `${sha256(eventId)}.json`

/**
 * The producer-readable receipt of one appended notice, built from its committed event row and the
 * stored notice only, written before its spool copy is removed. An existing receipt that does not
 * describe this row is never trusted: the invocation is held (false) instead.
 */
function acknowledgeEvent(binding: ScriptReportBinding, entry: ScriptReportEvent, file: string): boolean {
  try {
    const dir = join(scriptReportReceiptsDir(binding.binding_id), 'events')
    const path = join(dir, eventReceiptName(entry.event_id))
    const notice = entry.notification_id === null ? null : getSessionNotificationById(entry.notification_id)
    const stored = entry.state === 'accepted' && typeof notice?.payload.content === 'string' ? notice.payload.content : null
    const accepted = stored === null ? null : sha256(stored)
    const expected: Record<string, unknown> = {
      schema_version: 1, stream: 'append', binding_id: binding.binding_id, binding_revision: entry.binding_revision, job_id: binding.job_id,
      session_id: binding.session_id, session_generation: notice?.session_generation ?? binding.session_generation,
      invocation_id: entry.invocation_id, event_id: entry.event_id, event_kind: entry.event_kind, sequence: entry.sequence,
      state: entry.state, reason: entry.detail, notification_id: entry.notification_id, submitted_sha256: entry.submitted_sha256,
      accepted_sha256: accepted, exact: accepted !== null && accepted === entry.submitted_sha256, record_sha256: entry.record_sha256,
      settled_at: entry.updated_at,
    }
    let present = true
    try { lstatSync(path) } catch { present = false }
    // A receipt linked before a crash still needs its directory synced before acknowledgement.
    if (!present) publishReceipt(dir, eventReceiptName(entry.event_id), expected)
    else syncDirectory(dir)
    // Whatever file won (ours, an earlier pass's, or another writer's) must be exactly the committed receipt.
    const raw = readPrivateFile(path, 64 * 1024)
    let found: any = null
    try { found = raw ? JSON.parse(raw.toString('utf8')) : null } catch { /* unreadable: not the receipt */ }
    if (!found || typeof found !== 'object' || Object.keys(found).length !== Object.keys(expected).length
      || Object.entries(expected).some(([key, value]) => found[key] !== value)) return false
  } catch {
    return false // the disposition is durable: a later pass writes the same receipt
  }
  finish(file) // the spool copy only signalled the slot
  return true
}

/**
 * Import the appended notices of one invocation in slot order, under the same owner fences and
 * generation-fenced inbox acceptance as its terminal report. Admissions are enumerated from the frozen
 * records the helper wrote under its lock (`outbox/invocations/<I>/<NN>.json`), never from spool copies,
 * so a lost or forged copy neither hides nor changes one. Returns whether any admission is unsettled or
 * unacknowledged: the terminal report and its cleanup wait until none is.
 */
function importEvents(namespace: string, binding: ScriptReportBinding, invocation: string, dir: string,
  accepted: SessionNotificationRecord[], budget: { left: number }): boolean {
  let names: string[]
  try {
    names = readdirSync(join(scriptReportOutboxDir(binding.binding_id), 'invocations', invocation))
  } catch (error: any) {
    return error?.code !== 'ENOENT' // unreadable admissions: the terminal report waits
  }
  for (const name of names.filter(name => !name.startsWith('.')).sort()) {
    const slot = EVENT_FILE.exec(name)
    if (!slot) continue // only NN.json records are admissions
    const sequence = Number(slot[1])
    const file = join(dir, 'events', name)
    let entry = getScriptReportEventAt(binding.binding_id, invocation, sequence)
    if (!entry || entry.state === 'pending') {
      if (budget.left <= 0) return true
      const previous = sequence > 1 ? getScriptReportEventAt(binding.binding_id, invocation, sequence - 1) : null
      if (sequence > 1 && (!previous || previous.state === 'pending')) return true
      budget.left -= 1
      if (!settleEvent(namespace, binding, invocation, sequence, accepted)) return true
      entry = getScriptReportEventAt(binding.binding_id, invocation, sequence)!
    }
    if (!acknowledgeEvent(binding, entry, file)) return true
  }
  return false
}

/**
 * Settle one admitted slot; false while it cannot be settled yet (it and the terminal report wait).
 * The spool copy only signals the slot: the authority is the frozen record the helper admitted under
 * its lock (`outbox/invocations/<I>/<NN>.json`). The event identity is reserved (`pending`) before the
 * inbox sees it, so neither a crash nor a replay can attach the event to another slot or accept it twice.
 */
function settleEvent(namespace: string, binding: ScriptReportBinding, invocation: string, sequence: number,
  accepted: SessionNotificationRecord[]): boolean {
  let row = getScriptReportEventAt(binding.binding_id, invocation, sequence)
  if (row && row.state !== 'pending') return true
  const raw = readPrivateFile(join(scriptReportOutboxDir(binding.binding_id), 'invocations', invocation,
    `${String(sequence).padStart(2, '0')}.json`), SCRIPT_REPORT_LIMITS.recordBytes)
  if (!raw) return false
  const event = parseScriptReportEvent(raw, binding, invocation, sequence)
  const recordSha = createHash('sha256').update(raw).digest('hex')
  const settle = (state: ScriptReportInvocationState, detail: string | null, notificationId: number | null) => {
    settleScriptReportEvent(binding.binding_id, invocation, sequence, state, notificationId, detail)
    return true
  }
  if (!row) {
    if (!event) return false
    const reserve = (eventId: string, state: ScriptReportEvent['state'], detail: string | null) => recordScriptReportEvent({
      binding_id: binding.binding_id, binding_revision: binding.revision, event_id: eventId, invocation_id: invocation, sequence,
      event_kind: event.event_kind, state, notification_id: null, detail, submitted_sha256: event.submitted_sha256, record_sha256: recordSha })
    // A slot claiming an event admitted elsewhere gets an explicit disposition, never a second acceptance.
    if (getScriptReportEvent(binding.binding_id, binding.revision, event.event_id)) { reserve(`duplicate:${invocation}:${sequence}`, 'quarantined', 'duplicate_event'); return true }
    reserve(event.event_id, 'pending', null)
    row = getScriptReportEventAt(binding.binding_id, invocation, sequence)!
  }
  // A notice the inbox committed just before a crash settles its own reserved record, never another one.
  const key = scriptReportEventProducerKey(binding, invocation, sequence)
  const committed = getSessionNotificationByKey(namespace, binding.profile, key)
  if (committed) return committed.payload.record_sha256 === row.record_sha256 ? settle('accepted', null, committed.id) : settle('quarantined', 'notification_conflict', null)
  if (!event || recordSha !== row.record_sha256) return settle('quarantined', 'record_changed', null)
  const verdict = ownerVerdict(binding)
  if (verdict) return settle('rejected', verdict, null)
  const content = sanitizeScriptReportText(event.content)
  const result = acceptFencedSessionNotification({
    namespace,
    profile: binding.profile,
    producerKey: key,
    sessionId: binding.session_id,
    expectedGeneration: binding.session_generation,
    kind: 'script_report',
    disposition: 'notified',
    payload: {
      source: 'script-report', identity_kind: 'wrapper_invocation', native_execution_id: null,
      binding_id: binding.binding_id, binding_revision: binding.revision, invocation_id: invocation,
      job_id: binding.job_id, job_name: binding.job_name, outcome: event.event_kind === 'failure' ? 'failed' : 'output',
      exit_code: null, signal: null, reason: null, truncated: event.truncated,
      redaction_status: content !== event.content ? 'redacted' : event.redaction_status,
      started_at: event.created_at, finished_at: event.created_at, content,
      completion: 'detached', phase: 'event', event_id: event.event_id, event_kind: event.event_kind, sequence,
      submitted_sha256: event.submitted_sha256, record_sha256: recordSha,
      // Same frozen trusted authority as the terminal report, re-fenced again before any live publish.
      ...(binding.trusted_epoch !== null ? { trusted: { account_id: binding.account_id, epoch: binding.trusted_epoch,
        ...(binding.target_owner !== null ? { owner: binding.target_owner } : {}) } } : {}),
    },
  })
  if (!('record' in result)) return settle(result.status === 'conflict' ? 'quarantined' : 'rejected', result.status === 'conflict' ? 'notification_conflict' : 'owner_missing', null)
  if (result.status === 'accepted') accepted.push(result.record)
  return settle('accepted', null, result.record.id)
}

/**
 * Import finished wrapper reports into their bound sessions. The binding, not the report, decides
 * the destination. Acceptance is generation-fenced and idempotent; a spool entry is removed only
 * after its disposition is durable, so a crash replays the same report and key. Reports started
 * without a final record are left alone: their outcome is unknown and never inferred from time.
 * This never launches, retries or re-runs a script.
 */
export function importScriptReports(options: { namespace?: string; limit?: number } = {}): ScriptReportImportResult {
  const namespace = options.namespace ?? studioInstanceId()
  const limit = options.limit ?? SCRIPT_REPORT_LIMITS.batch
  const accepted: SessionNotificationRecord[] = []
  let processed = 0
  // Without the native job reader nothing is imported; finished reports wait in the spool.
  if (!jobInspector) return { accepted, processed }
  for (const binding of listImportableScriptReportBindings(namespace)) {
    if (processed >= limit) break
    const spool = scriptReportSpoolDir(binding.binding_id)
    let entries: string[]
    try {
      const info = lstatSync(spool)
      if (!info.isDirectory() || info.isSymbolicLink()) continue
      entries = readdirSync(spool)
      for (const name of entries.filter(name => name.startsWith(TOMBSTONE_PREFIX))) rmSync(join(spool, name), { recursive: true, force: true })
      entries = entries.filter(name => !name.startsWith('.')).sort()
    } catch {
      continue
    }
    for (const invocation of entries) {
      if (processed >= limit) break
      const dir = join(spool, invocation)
      let info
      try { info = lstatSync(dir) } catch { continue }
      if (!UUID.test(invocation) || !info.isDirectory() || (process.getuid && info.uid !== process.getuid())) {
        processed += 1
        quarantine(binding, invocation.replace(/[^A-Za-z0-9-]/g, '_').slice(0, 64), dir)
        continue
      }
      // The final report is observed BEFORE its notices are scanned: the helper restores every admitted
      // notice before it publishes the final report, so all of them are visible to this scan. A final report
      // that appears during the scan waits for the next pass (a notice may have been appended meanwhile).
      let finalStat
      try { finalStat = lstatSync(join(dir, 'final.json')) } catch { finalStat = null } // started, not finished
      // Appended notices first, also while the invocation still runs; the terminal report waits for them.
      const budget = { left: limit - processed }
      const waiting = importEvents(namespace, binding, invocation, dir, accepted, budget)
      processed = limit - budget.left
      if (waiting || processed >= limit || !finalStat) continue
      processed += 1
      if (!finalStat.isFile()) { settle(binding, invocation, dir, 'quarantined', null, 'invalid_report'); continue }
      const raw = readPrivateFile(join(dir, 'final.json'), SCRIPT_REPORT_LIMITS.recordBytes)
      const report = raw ? parseScriptReport(raw, binding, invocation) : null
      if (!report) { settle(binding, invocation, dir, 'quarantined', null, 'invalid_report'); continue }
      const prior = getScriptReportInvocation(binding.binding_id, invocation)
      // A durable rejection or quarantine is final: a replay (crash before acknowledgement) only
      // completes the acknowledgement, even if the destination became valid again meanwhile.
      if (prior?.state === 'rejected' || prior?.state === 'quarantined') { acknowledge(binding, invocation, dir, report, prior.state === 'quarantined'); continue }
      const verdict = ownerVerdict(binding)
      if (verdict) {
        // A late report of a revoked binding or a lost destination is dropped, never rerouted.
        if (prior) acknowledge(binding, invocation, dir, report, false)
        else rejectUnlessCommitted(namespace, binding, invocation, dir, report, verdict)
        continue
      }
      const content = report.content === null ? null : sanitizeScriptReportText(report.content)
      const { disposition, visible } = dispositionFor(report.outcome)
      const result = acceptFencedSessionNotification({
        namespace,
        profile: binding.profile,
        producerKey: scriptReportProducerKey(binding, invocation),
        sessionId: binding.session_id,
        expectedGeneration: binding.session_generation,
        kind: 'script_report',
        disposition,
        payload: {
          source: 'script-report',
          identity_kind: 'wrapper_invocation',
          native_execution_id: null,
          binding_id: binding.binding_id,
          binding_revision: binding.revision,
          invocation_id: invocation,
          job_id: binding.job_id,
          job_name: binding.job_name,
          outcome: report.outcome,
          exit_code: report.exit_code,
          signal: report.signal,
          reason: report.omitted_reason,
          truncated: report.truncated,
          redaction_status: content !== null && content !== report.content ? 'redacted' : report.redaction_status,
          started_at: report.started_at,
          finished_at: report.finished_at,
          content: content ?? '',
          ...(binding.trusted_epoch !== null ? { trusted: { account_id: binding.account_id, epoch: binding.trusted_epoch,
            ...(binding.target_owner !== null ? { owner: binding.target_owner } : {}) } } : {}),
          ...(binding.completion === 'detached' ? { completion: 'detached', event_id: report.event_id ?? null,
            retry_of: report.retry_of ?? null, submitted_sha256: report.submitted_sha256 ?? null } : {}),
        },
      })
      if (!('record' in result)) {
        if (result.status === 'conflict') settle(binding, invocation, dir, 'quarantined', report.outcome, 'notification_conflict', null, report)
        else rejectUnlessCommitted(namespace, binding, invocation, dir, report, 'owner_missing')
      } else {
        settle(binding, invocation, dir, visible ? 'accepted' : 'silent', report.outcome, null, result.record.id, report)
        if (result.status === 'accepted' && visible) accepted.push(result.record)
      }
    }
  }
  return { accepted, processed }
}

/** Spool entries of a binding that started but have no final report (running, or killed). */
export function incompleteScriptReports(binding: ScriptReportBinding): Array<{ invocation_id: string; started_at: number | null; handed_off?: boolean }> {
  const spool = scriptReportSpoolDir(binding.binding_id)
  let entries: string[]
  try { entries = readdirSync(spool).filter(name => UUID.test(name)) } catch { return [] }
  const pending: Array<{ invocation_id: string; started_at: number | null; handed_off?: boolean }> = []
  for (const invocation of entries) {
    const dir = join(spool, invocation)
    try { lstatSync(join(dir, 'final.json')); continue } catch { /* no final report */ }
    const raw = readPrivateFile(join(dir, 'started.json'), 4096)
    let startedAt: number | null = null
    try { const parsed = raw ? JSON.parse(raw.toString('utf8')) : null; startedAt = num(parsed?.started_at) ? parsed.started_at : null } catch { /* unreadable */ }
    // Detached completion: the launcher exited cleanly and a worker owns the invocation now.
    const handedOff = binding.completion === 'detached' ? { handed_off: existsSync(join(dir, 'handoff.json')) } : {}
    pending.push({ invocation_id: invocation, started_at: startedAt, ...handedOff })
  }
  return pending.sort((a, b) => (a.started_at ?? 0) - (b.started_at ?? 0))
}
