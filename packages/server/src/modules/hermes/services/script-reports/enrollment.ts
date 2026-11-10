import { createHash, randomUUID } from 'crypto'
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, rmSync, statSync, writeSync } from 'fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, extname, isAbsolute, join, relative, sep } from 'path'
import {
  activateScriptReportBinding,
  authorizeNoticeDestination,
  beginScriptReportBinding,
  failActivatedScriptReportBinding,
  failScriptReportBinding,
  findScriptReportBinding,
  listScriptReportBindingHealth,
  noteScriptReportBindingError,
  recordScriptReportJob,
  revokeScriptReportBinding,
  scriptReportBindingDir,
  scriptReportManifestPath,
  scriptReportRevokedMarker,
  scriptReportSpoolDir,
  scriptReportsRoot,
  type DestinationVerdict,
  type ScriptReportBinding,
} from '../../../studio/public/script-reports'
import { getHermesBaseDir, getProfileDir } from '../profiles/profile'
import { getHermesBin } from '../runtime/path'
import { execHermesWithBin } from '../runtime/process'
import { jobFingerprint, withCronJobCreation, withCronJobLock } from '../cron-jobs/job-lock'
import { readNativeJob } from './native-jobs'
import { defaultNativeLifecycleGuard, type NativeLifecycleGuard } from './native-guard'
import { renderWrapper, WRAPPER_DIR } from './wrapper'

const CLI_TIMEOUT_MS = 60_000
const MAX_PENDING = 200

export class EnrollmentError extends Error {
  /** `nativeState` is what Studio last observed of the native job after a failure, never assumed. */
  constructor(readonly status: number, readonly code: string, message?: string, readonly jobId?: string,
    readonly nativeState?: 'paused' | 'unknown') {
    super(message || code)
  }
}

export interface EnrollmentRequest {
  userId: number
  profile: string
  sessionId: string
  expectedGeneration: string
  name: string
  schedule: string
  script: string
  workdir?: string | null
  interpreter?: string | null
  paused?: boolean
}

export type HermesCronRunner = (profile: string, args: string[]) => Promise<{ stdout: string; stderr: string }>

const CONTROL = /[\u0000-\u001f\u007f]/

function profileHome(profile: string): string {
  const dir = getProfileDir(profile)
  // An unknown profile name resolves to the base home; never enroll into another profile.
  if (profile !== 'default' && dir === getHermesBaseDir()) throw new EnrollmentError(404, 'profile_not_found')
  return dir
}

export const defaultCronRunner: HermesCronRunner = async (profile, args) => {
  try {
    return await execHermesWithBin(getHermesBin(), ['cron', args[0], '--profile', profile, ...args.slice(1)], {
      cwd: process.cwd(),
      env: { ...process.env, HERMES_HOME: profileHome(profile) },
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    })
  } catch (error: any) {
    const stderr = String(error?.stderr || '').trim()
    const stdout = String(error?.stdout || '').trim()
    throw new Error(stderr || stdout || error?.message || 'Hermes cron command failed')
  }
}

function writeExclusive(path: string, content: string, mode: number): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), mode)
  try {
    writeSync(fd, content)
  } finally {
    closeSync(fd)
  }
  chmodSync(path, mode)
}

function privateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`not a private directory: ${path}`)
  chmodSync(path, 0o700)
}

/** A relative target inside the profile's `scripts/`, resolved without following an escape. */
export function resolveTargetScript(scriptsDir: string, script: string): { path: string; relative: string; kind: 'bash' | 'python' } {
  const value = String(script || '').trim()
  if (!value || value.length > 512 || CONTROL.test(value) || isAbsolute(value) || value.startsWith('~')) {
    throw new EnrollmentError(400, 'invalid_script')
  }
  if (value.split(/[\\/]/).some(part => part === '..' || part === '')) throw new EnrollmentError(400, 'invalid_script')
  const kindOf = (file: string) => {
    const extension = extname(file).toLowerCase()
    return extension === '.sh' || extension === '.bash' ? 'bash' : extension === '.py' ? 'python' : null
  }
  if (!kindOf(value)) throw new EnrollmentError(400, 'unsupported_script_type')
  let root: string
  let path: string
  try {
    root = realpathSync(scriptsDir)
    path = realpathSync(join(scriptsDir, value))
  } catch {
    throw new EnrollmentError(404, 'script_not_found')
  }
  const inside = relative(root, path)
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new EnrollmentError(400, 'script_outside_scripts_dir')
  if (inside.split(sep)[0] === WRAPPER_DIR) throw new EnrollmentError(400, 'invalid_script')
  if (!statSync(path).isFile()) throw new EnrollmentError(400, 'invalid_script')
  // Hermes picks the interpreter from the resolved file it is given, so the wrapper must too.
  const kind = kindOf(path)
  if (!kind) throw new EnrollmentError(400, 'unsupported_script_type')
  return { path, relative: inside.split(sep).join('/'), kind }
}

function text(value: unknown, max: number, code: string): string {
  const result = typeof value === 'string' ? value.trim() : ''
  if (!result || result.length > max || CONTROL.test(result)) throw new EnrollmentError(400, code)
  return result
}

function optionalAbsolute(value: unknown, code: string, directory: boolean): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || CONTROL.test(value) || !isAbsolute(value)) throw new EnrollmentError(400, code)
  try {
    const info = statSync(value)
    if (directory ? !info.isDirectory() : !info.isFile()) throw new Error('wrong type')
  } catch {
    throw new EnrollmentError(400, code)
  }
  return value
}

const VERDICT_STATUS: Record<Exclude<DestinationVerdict, 'ok'>, [number, string]> = {
  forbidden: [403, 'profile_access_denied'],
  not_found: [404, 'session_not_found'],
  unsupported: [422, 'unsupported_notification_target'],
  generation_mismatch: [409, 'session_generation_mismatch'],
}

export function assertDestination(userId: number, profile: string, sessionId: string, generation: string): void {
  const verdict = authorizeNoticeDestination(userId, profile, sessionId, generation)
  if (verdict !== 'ok') throw new EnrollmentError(...VERDICT_STATUS[verdict])
}

function parseCreatedJobId(output: string): string | null {
  // `hermes cron create` prints the id returned by its own create API; never infer it from a job list diff.
  const plain = output.replace(/\u001b\[[0-9;]*m/g, '')
  const match = /^Created job: (\S+)\s*$/m.exec(plain)
  return match ? match[1] : null
}

const bindingLocks = new Map<string, Promise<unknown>>()

/** Run `task` after any earlier enrollment or revocation of the same binding has finished. */
function withBindingLock<T>(bindingId: string, task: () => Promise<T>): Promise<T> {
  const previous = bindingLocks.get(bindingId) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(task)
  const settled = current.catch(() => undefined)
  bindingLocks.set(bindingId, settled)
  void settled.then(() => { if (bindingLocks.get(bindingId) === settled) bindingLocks.delete(bindingId) })
  return current
}

export interface EnrollmentResult {
  binding: ScriptReportBinding
  job: Record<string, any> | null
  resumed: boolean
  /** Set when the job could not be read back after a successful resume: its state was not observed. */
  nativeState?: 'unknown'
}

/** Bytes Studio reads to fingerprint a target; a larger script is refused, not partially hashed. */
const MAX_TARGET_BYTES = 8 * 1024 * 1024

/** Bounded read of the resolved regular file (no symlink at the final component). */
function readTargetBytes(path: string): Buffer {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch {
    throw new EnrollmentError(409, 'target_changed')
  }
  try {
    const info = fstatSync(fd)
    if (!info.isFile()) throw new EnrollmentError(409, 'target_changed')
    if (info.size > MAX_TARGET_BYTES) throw new EnrollmentError(413, 'script_too_large')
    const buffer = Buffer.alloc(info.size)
    let offset = 0
    while (offset < info.size) {
      const read = readSync(fd, buffer, offset, info.size - offset, offset)
      if (read === 0) break
      offset += read
    }
    if (offset !== info.size) throw new EnrollmentError(409, 'target_changed')
    return buffer
  } finally {
    closeSync(fd)
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export interface TargetPlan {
  path: string
  relative: string
  kind: 'bash' | 'python'
  sha256: string
}

/** Resolve and fingerprint a target inside the profile's `scripts/`. */
export function planTarget(scriptsDir: string, script: string): TargetPlan {
  const target = resolveTargetScript(scriptsDir, script)
  return { ...target, sha256: sha256(readTargetBytes(target.path)) }
}

/**
 * The current file is still the approved one: same resolution, kind and bytes. Never re-hashes new
 * bytes as approved.
 */
export function verifyTargetPlan(scriptsDir: string, plan: TargetPlan): void {
  let current: ReturnType<typeof resolveTargetScript>
  try {
    current = resolveTargetScript(scriptsDir, plan.relative)
  } catch {
    throw new EnrollmentError(409, 'target_changed')
  }
  if (current.path !== plan.path || current.kind !== plan.kind || current.relative !== plan.relative) {
    throw new EnrollmentError(409, 'target_changed')
  }
  if (sha256(readTargetBytes(current.path)) !== plan.sha256) throw new EnrollmentError(409, 'target_changed')
}

/** A frozen, executable plan for a NEW reporting job. Approval executes exactly this. */
export interface NewEnrollmentPlan {
  mode: 'new'
  profile: string
  name: string
  schedule: string
  target: TargetPlan
  workdir: string | null
  interpreter: string | null
  paused: boolean
}

/** Where reports go. `recheck` adds caller policy (e.g. consent account) to the destination fence. */
export interface EnrollmentDestination {
  /** Direct login enrollment reports any destination change after the native calls as destination_changed. */
  reportChangeAs?: 'destination_changed'
  userId: number
  profile: string
  sessionId: string
  expectedGeneration: string
  recheck?: () => void
}

export function prepareNewEnrollment(request: Omit<EnrollmentRequest, 'userId' | 'sessionId' | 'expectedGeneration'>): NewEnrollmentPlan {
  const profile = text(request.profile, 128, 'invalid_profile')
  const name = text(request.name, 200, 'invalid_name')
  const schedule = text(request.schedule, 200, 'invalid_schedule')
  const home = profileHome(profile)
  const target = planTarget(join(home, 'scripts'), request.script)
  const workdir = optionalAbsolute(request.workdir, 'invalid_workdir', true)
  const interpreter = optionalAbsolute(request.interpreter, 'invalid_interpreter', false)
  if (interpreter && target.kind !== 'python') throw new EnrollmentError(400, 'invalid_interpreter')
  return { mode: 'new', profile, name, schedule, target, workdir, interpreter, paused: request.paused === true }
}

function recheckDestination(destination: EnrollmentDestination, profile: string): void {
  if (destination.profile !== profile) throw new EnrollmentError(400, 'profile_mismatch')
  assertDestination(destination.userId, profile, destination.sessionId, destination.expectedGeneration)
  destination.recheck?.()
}

function writePrivateBindingFiles(bindingId: string, target: TargetPlan, cwd: string): string {
  const manifestPath = scriptReportManifestPath(bindingId, 1)
  privateDir(scriptReportsRoot())
  privateDir(dirname(scriptReportBindingDir(bindingId)))
  privateDir(scriptReportBindingDir(bindingId))
  privateDir(dirname(scriptReportSpoolDir(bindingId)))
  privateDir(scriptReportSpoolDir(bindingId))
  writeExclusive(manifestPath, `${JSON.stringify({
    schema_version: 1,
    binding_id: bindingId,
    binding_revision: 1,
    target: { path: target.path, kind: target.kind, cwd },
    // The approved digest, never a fresh hash of whatever the file holds now.
    target_sha256: target.sha256,
    spool_dir: scriptReportSpoolDir(bindingId),
    revoked_marker: scriptReportRevokedMarker(bindingId),
    max_pending: MAX_PENDING,
  }, null, 2)}\n`, 0o600)
  return manifestPath
}

/**
 * Opt-in enrollment of a NEW native `no_agent` job that reports each invocation to one session.
 * Order: authorize and freeze the destination, write the private manifest and spool, record the
 * binding, create the native job paused **with the original target** (so Hermes' create-time
 * lifecycle guard checks the real script), record its id, write the generated wrapper and point the
 * job at it with `hermes cron edit`, verify the stored configuration by id, recheck destination and
 * plan, activate the binding, then resume. A failure after creation leaves the native job paused.
 * Enrollment and revocation of one binding never interleave.
 */
export async function enrollScriptReport(request: EnrollmentRequest, runner: HermesCronRunner = defaultCronRunner): Promise<EnrollmentResult> {
  const plan = prepareNewEnrollment(request)
  return executeNewEnrollment(plan, {
    userId: request.userId, profile: plan.profile, sessionId: request.sessionId, expectedGeneration: request.expectedGeneration,
    reportChangeAs: 'destination_changed',
  }, runner)
}

export async function executeNewEnrollment(plan: NewEnrollmentPlan, destination: EnrollmentDestination,
  runner: HermesCronRunner = defaultCronRunner): Promise<EnrollmentResult> {
  const bindingId = randomUUID()
  return withBindingLock(bindingId, () => executeNewLocked(bindingId, plan, destination, runner))
}

async function executeNewLocked(bindingId: string, plan: NewEnrollmentPlan, destination: EnrollmentDestination,
  runner: HermesCronRunner): Promise<EnrollmentResult> {
  const { profile, target } = plan
  const home = profileHome(profile)
  const scriptsDir = join(home, 'scripts')
  recheckDestination(destination, profile)
  verifyTargetPlan(scriptsDir, target)

  const wrapperRelative = `${WRAPPER_DIR}/${bindingId}.py`
  const wrapperPath = join(home, 'scripts', WRAPPER_DIR, `${bindingId}.py`)
  const manifestPath = writePrivateBindingFiles(bindingId, target, plan.workdir || dirname(target.path))
  const binding = beginScriptReportBinding({
    bindingId, userId: destination.userId, profile, sessionId: destination.sessionId, expectedGeneration: destination.expectedGeneration,
    jobName: plan.name, targetScript: target.relative, wrapperScript: wrapperRelative,
  })
  const discard = () => {
    rmSync(wrapperPath, { force: true })
    rmSync(scriptReportBindingDir(bindingId), { recursive: true, force: true })
    rmSync(scriptReportSpoolDir(bindingId), { recursive: true, force: true })
  }

  // The job Hermes created from the approved plan, read before any managed mutation can reach it.
  let created: Record<string, any> | null = null
  const create = async (): Promise<string> => {
    let jobId: string | null
    try {
      // Hermes validates the script it is given at creation only: give it the real target first.
      const args = ['create', '--name', plan.name, '--deliver', 'local', '--no-agent', '--script', target.relative,
        '--paused', '--paused-reason', 'Ekko script report enrollment']
      if (plan.workdir) args.push('--workdir', plan.workdir)
      if (plan.interpreter) args.push('--interpreter', plan.interpreter)
      args.push(plan.schedule)
      const output = await runner(profile, args)
      jobId = parseCreatedJobId(`${output.stdout}\n${output.stderr}`)
      if (!jobId) throw new EnrollmentError(422, 'native_create_rejected', output.stderr.trim() || output.stdout.trim() || undefined)
    } catch (error: any) {
      failScriptReportBinding(bindingId, error?.code || 'native_create_failed')
      discard()
      if (error instanceof EnrollmentError) throw error
      // A refusal by Hermes (lifecycle guard, invalid schedule, …) surfaces as a failed command.
      throw new EnrollmentError(422, 'native_create_rejected', error?.message)
    }
    // The native job exists from here on: record its id before anything else can fail, and never
    // discard the binding that identifies it.
    recordScriptReportJob(bindingId, jobId)
    try {
      created = readNativeJob(profile, jobId)
    } catch (error: any) {
      failScriptReportBinding(bindingId, 'native_config_mismatch')
      throw new EnrollmentError(502, 'native_config_mismatch', error?.message, jobId)
    }
    return jobId
  }
  void binding

  return withCronJobCreation(profile, create, async createdJobId => {
    recordScriptReportJob(bindingId, createdJobId)
    const fail = (code: string, status = 502, message?: string): never => {
      // Leave the native job paused; the job id is reported for cleanup.
      failScriptReportBinding(bindingId, code)
      throw new EnrollmentError(status, code, message, createdJobId)
    }
    const current = () => {
      recheckDestination(destination, profile)
      verifyTargetPlan(scriptsDir, target)
    }
    const recheck = () => {
      try {
        current()
      } catch (error: any) {
        if (error instanceof EnrollmentError) {
          if (destination.reportChangeAs) fail(destination.reportChangeAs, 409, error.code)
          fail(error.code, error.status)
        }
        throw error
      }
    }
    const approved = created
    if (!approved || approved.script !== target.relative || approved.no_agent !== true || approved.deliver !== 'local'
      || approved.enabled !== false || approved.name !== plan.name || (approved.workdir ?? null) !== plan.workdir
      || (approved.interpreter ?? null) !== plan.interpreter) {
      fail('native_config_mismatch')
    }
    // Every stored field except run-time bookkeeping, with the wrapper in place of the target.
    const expected = jobFingerprint(approved!, { script: wrapperRelative })
    // Authorization or the target may have changed while the native create ran.
    recheck()
    try {
      privateDir(join(home, 'scripts', WRAPPER_DIR))
      writeExclusive(wrapperPath, renderWrapper(manifestPath), 0o700)
      await runner(profile, ['edit', createdJobId, '--script', wrapperRelative])
    } catch (error: any) {
      fail('native_edit_failed', 502, error?.message)
    }
    let job: Record<string, any> | null = null
    try {
      job = readNativeJob(profile, createdJobId)
    } catch {
      // An unreadable jobs file verifies nothing: fail below with the job id, never resume.
    }
    if (!job || job.script !== wrapperRelative || job.enabled !== false || jobFingerprint(job) !== expected) {
      fail('native_config_mismatch')
    }
    recheck()
    if (!activateScriptReportBinding(bindingId)) {
      // Revoked (or otherwise settled) meanwhile: never resume a job whose reports are refused.
      throw new EnrollmentError(409, 'binding_revoked', undefined, createdJobId)
    }
    if (plan.paused) return { binding: findScriptReportBinding(bindingId)!, job, resumed: false }
    return resumeVerified(bindingId, profile, createdJobId, wrapperRelative, expected, current, runner)
  })
}

/**
 * Resume and verify. The destination, target and approved configuration are checked again once the
 * native resume returns: if anything was invalidated meanwhile the binding fails (reports stop and
 * the wrapper becomes a passthrough) and the job is paused again, verified, with its id reported.
 */
async function resumeVerified(bindingId: string, profile: string, jobId: string, wrapperRelative: string,
  expected: string, current: () => void, runner: HermesCronRunner): Promise<EnrollmentResult> {
  try {
    await runner(profile, ['resume', jobId])
  } catch (error: any) {
    noteScriptReportBindingError(bindingId, 'native_resume_failed')
    throw new EnrollmentError(502, 'native_resume_failed', error?.message, jobId, await ensurePaused(profile, jobId, runner))
  }
  let invalid: EnrollmentError | null = null
  try {
    current()
  } catch (error) {
    if (!(error instanceof EnrollmentError)) throw error
    invalid = error
  }
  let resumed: Record<string, any> | null
  try {
    resumed = readNativeJob(profile, jobId)
  } catch {
    // The resume succeeded; only the snapshot is unreadable: keep the binding and its job id.
    if (!invalid) return { binding: findScriptReportBinding(bindingId)!, job: null, resumed: true, nativeState: 'unknown' }
    resumed = null
  }
  if (!invalid && resumed && resumed.enabled === true && resumed.script === wrapperRelative && jobFingerprint(resumed) !== expected) {
    invalid = new EnrollmentError(409, 'job_changed')
  }
  if (invalid) {
    failActivatedScriptReportBinding(bindingId, invalid.code)
    const marker = scriptReportRevokedMarker(bindingId)
    privateDir(scriptReportBindingDir(bindingId))
    if (!existsSync(marker)) writeExclusive(marker, `${new Date().toISOString()}\n`, 0o600)
    let paused = false
    try {
      await runner(profile, ['pause', jobId])
      paused = readNativeJob(profile, jobId)?.enabled === false
    } catch { /* reported below */ }
    if (!paused) noteScriptReportBindingError(bindingId, `${invalid.code};native_pause_failed`)
    throw new EnrollmentError(invalid.status, invalid.code, paused ? undefined : 'native pause unverified', jobId)
  }
  if (!resumed || resumed.enabled !== true || resumed.script !== wrapperRelative) {
    noteScriptReportBindingError(bindingId, 'native_resume_unverified')
    throw new EnrollmentError(502, 'native_resume_unverified', undefined, jobId)
  }
  return { binding: findScriptReportBinding(bindingId)!, job: resumed, resumed: true }
}

/**
 * A failed resume may still have enabled the job: pause it by id and report only what is observed.
 * Reading the job can fail as well; that never skips the pause and never loses the job id.
 */
async function ensurePaused(profile: string, jobId: string, runner: HermesCronRunner): Promise<'paused' | 'unknown'> {
  let observedPaused = false
  try {
    observedPaused = readNativeJob(profile, jobId)?.enabled === false
  } catch {
    // Unobservable: still pause below.
  }
  if (observedPaused) return 'paused'
  try {
    await runner(profile, ['pause', jobId])
  } catch {
    // Reported as unknown below.
  }
  try {
    return readNativeJob(profile, jobId)?.enabled === false ? 'paused' : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** A frozen plan to start reporting future invocations of an EXISTING `no_agent` job. */
export interface AdoptionPlan {
  mode: 'existing'
  profile: string
  jobId: string
  name: string
  schedule: string
  target: TargetPlan
  workdir: string | null
  interpreter: string | null
  /** The job's script exactly as configured (may be an in-profile alias of `target`). */
  configuredScript: string
  /** Approved configuration of the job (run-time bookkeeping excluded). */
  jobFingerprint: string
  /** The approved scheduling intent: enabled at consent time. Resumed only if so, and only if unchanged. */
  resume: boolean
}

function activeBindingForJob(profile: string, jobId: string): ScriptReportBinding | undefined {
  return listScriptReportBindingHealth(profile)
    .find(binding => binding.job_id === jobId && (binding.state === 'enrolling' || binding.state === 'active'))
}

export function prepareAdoption(profileInput: string, jobIdInput: string): AdoptionPlan {
  const profile = text(profileInput, 128, 'invalid_profile')
  const jobId = text(jobIdInput, 200, 'invalid_job')
  const home = profileHome(profile)
  const job = readNativeJob(profile, jobId)
  if (!job) throw new EnrollmentError(404, 'job_not_found')
  if (job.no_agent !== true) throw new EnrollmentError(422, 'agent_job_requires_session_binding')
  if (String(job.deliver || '') !== 'local') throw new EnrollmentError(422, 'explicit_delivery_target')
  const script = typeof job.script === 'string' ? job.script : ''
  if (script.split(/[\\/]/)[0] === WRAPPER_DIR || activeBindingForJob(profile, jobId)) {
    throw new EnrollmentError(409, 'already_enrolled')
  }
  const target = planTarget(join(home, 'scripts'), script)
  const interpreter = typeof job.interpreter === 'string' && job.interpreter ? job.interpreter : null
  if (interpreter && target.kind !== 'python') throw new EnrollmentError(400, 'invalid_interpreter')
  return {
    mode: 'existing', profile, jobId, name: String(job.name || jobId),
    schedule: String(job.schedule_display || job.schedule?.display || ''),
    target, workdir: typeof job.workdir === 'string' && job.workdir ? job.workdir : null, interpreter,
    configuredScript: script, jobFingerprint: jobFingerprint(job), resume: job.enabled !== false,
  }
}

/** Claimed or running executions of the job in its native ledger; unreadable counts as busy. */
export type JobBusyProbe = (hermesHome: string, jobId: string) => boolean

export const defaultJobBusyProbe: JobBusyProbe = (hermesHome, jobId) => {
  const path = join(hermesHome, 'cron', 'executions.db')
  if (!existsSync(path)) return false
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(path, { open: true, readOnly: true })
    db.exec('PRAGMA busy_timeout=2000')
    const row = db.prepare("SELECT COUNT(*) AS n FROM executions WHERE job_id=? AND status IN ('claimed','running')")
      .get(jobId) as { n: number } | undefined
    return Number(row?.n || 0) > 0
  } catch {
    return true
  } finally {
    db?.close()
  }
}

export interface AdoptionDeps {
  runner?: HermesCronRunner
  guard?: NativeLifecycleGuard
  busy?: JobBusyProbe
}

/**
 * Prospective adoption of an EXISTING `no_agent` job: future invocations report to the session.
 * Under the job lock: re-verify the approved configuration and target, run Hermes' own create-time
 * lifecycle guard on the target (native `update_job` never re-runs it), refuse a busy job, pause it,
 * point it at a generated wrapper, verify everything else is unchanged, recheck the destination,
 * activate, and resume only if it was scheduled at consent time. Failures leave the job paused and
 * the binding identifiable. No duplicate job, no historical backfill.
 */
export async function executeAdoption(plan: AdoptionPlan, destination: EnrollmentDestination, deps: AdoptionDeps = {}): Promise<EnrollmentResult> {
  const runner = deps.runner || defaultCronRunner
  const guard = deps.guard || defaultNativeLifecycleGuard
  const busy = deps.busy || defaultJobBusyProbe
  const { profile, jobId, target } = plan
  const home = profileHome(profile)
  const scriptsDir = join(home, 'scripts')
  const bindingId = randomUUID()
  // The configured spelling must still resolve to the approved target.
  const verifyConfiguredScript = () => {
    let resolved: string
    try {
      resolved = resolveTargetScript(scriptsDir, plan.configuredScript).path
    } catch {
      throw new EnrollmentError(409, 'target_changed')
    }
    if (resolved !== target.path) throw new EnrollmentError(409, 'target_changed')
  }
  return withCronJobLock(profile, jobId, () => withBindingLock(bindingId, async () => {
    const unchanged = () => {
      recheckDestination(destination, profile)
      const job = readNativeJob(profile, jobId)
      // Configuration and the configured paused/scheduled intent are both part of the approval.
      if (!job || jobFingerprint(job) !== plan.jobFingerprint || (job.enabled !== false) !== plan.resume) {
        throw new EnrollmentError(409, 'job_changed')
      }
      if (activeBindingForJob(profile, jobId)) throw new EnrollmentError(409, 'already_enrolled')
      verifyTargetPlan(scriptsDir, target)
      verifyConfiguredScript()
      return job
    }
    unchanged()
    const verdict = await guard(home, target.relative)
    if (!verdict.ok) {
      throw new EnrollmentError(verdict.refused ? 422 : 503, verdict.refused ? 'native_guard_rejected' : 'native_guard_unavailable', verdict.reason)
    }
    const before = unchanged()
    if (busy(home, jobId)) throw new EnrollmentError(409, 'job_busy')

    const wrapperRelative = `${WRAPPER_DIR}/${bindingId}.py`
    const wrapperPath = join(scriptsDir, WRAPPER_DIR, `${bindingId}.py`)
    const manifestPath = writePrivateBindingFiles(bindingId, target, plan.workdir || dirname(target.path))
    beginScriptReportBinding({
      bindingId, userId: destination.userId, profile, sessionId: destination.sessionId, expectedGeneration: destination.expectedGeneration,
      jobName: plan.name, targetScript: target.relative, wrapperScript: wrapperRelative,
    })
    recordScriptReportJob(bindingId, jobId)
    const fail = (code: string, status = 502, message?: string): never => {
      failScriptReportBinding(bindingId, code)
      throw new EnrollmentError(status, code, message, jobId)
    }
    if (before.enabled !== false) {
      try {
        await runner(profile, ['pause', jobId])
      } catch (error: any) {
        fail('native_pause_failed', 502, error?.message)
      }
    }
    const paused = readNativeJob(profile, jobId)
    if (!paused || paused.enabled !== false || jobFingerprint(paused) !== plan.jobFingerprint) fail('job_changed', 409)
    if (busy(home, jobId)) fail('job_busy', 409)
    try {
      privateDir(join(scriptsDir, WRAPPER_DIR))
      writeExclusive(wrapperPath, renderWrapper(manifestPath), 0o700)
      await runner(profile, ['edit', jobId, '--script', wrapperRelative])
    } catch (error: any) {
      fail('native_edit_failed', 502, error?.message)
    }
    const edited = readNativeJob(profile, jobId)
    // Only the script may differ from the approved configuration.
    if (!edited || edited.script !== wrapperRelative || edited.enabled !== false
      || jobFingerprint(edited, { script: plan.configuredScript }) !== plan.jobFingerprint) {
      fail('native_config_mismatch')
    }
    const current = () => {
      recheckDestination(destination, profile)
      verifyTargetPlan(scriptsDir, target)
    }
    try {
      current()
    } catch (error: any) {
      if (error instanceof EnrollmentError) fail(error.code, error.status)
      throw error
    }
    if (!activateScriptReportBinding(bindingId)) throw new EnrollmentError(409, 'binding_revoked', undefined, jobId)
    if (!plan.resume) return { binding: findScriptReportBinding(bindingId)!, job: edited, resumed: false }
    return resumeVerified(bindingId, profile, jobId, wrapperRelative, jobFingerprint(edited!), current, runner)
  }))
}

/**
 * Final revocation: the marker stops capture in the wrapper before the binding stops importing,
 * then the native job is paused. Its configuration and wrapper are left for the user to remove.
 */
export function revokeScriptReport(binding: ScriptReportBinding, runner: HermesCronRunner = defaultCronRunner): Promise<{ paused: boolean }> {
  return withBindingLock(binding.binding_id, () => revokeLocked(binding.binding_id, runner))
}

async function revokeLocked(bindingId: string, runner: HermesCronRunner): Promise<{ paused: boolean }> {
  // Re-read after any enrollment of this binding finished: it may have recorded the job id.
  const binding = findScriptReportBinding(bindingId)!
  const marker = scriptReportRevokedMarker(binding.binding_id)
  privateDir(scriptReportBindingDir(binding.binding_id))
  if (!existsSync(marker)) writeExclusive(marker, `${new Date().toISOString()}\n`, 0o600)
  revokeScriptReportBinding(binding.binding_id)
  if (!binding.job_id) return { paused: false }
  try {
    await runner(binding.profile, ['pause', binding.job_id])
    return { paused: true }
  } catch {
    noteScriptReportBindingError(binding.binding_id, 'native_pause_failed')
    return { paused: false }
  }
}
