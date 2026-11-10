import { createHash, randomUUID } from 'crypto'
import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeSync } from 'fs'
import { dirname, extname, isAbsolute, join, relative, sep } from 'path'
import {
  activateScriptReportBinding,
  authorizeNoticeDestination,
  beginScriptReportBinding,
  failScriptReportBinding,
  findScriptReportBinding,
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
import { readNativeJob } from './native-jobs'
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

/**
 * Opt-in enrollment of a NEW native `no_agent` job that reports each invocation to one session.
 * Order: authorize and freeze the destination, write the private manifest and spool, record the
 * binding, create the native job paused **with the original target** (so Hermes' create-time
 * lifecycle guard checks the real script), record its id, write the generated wrapper and point the
 * job at it with `hermes cron edit`, verify the stored configuration by id, activate the binding,
 * then resume. The destination is authorized again, as it is now, before activation and before
 * resume. A failure after creation leaves the native job paused, or reports that its state is
 * unknown when a pause could not be confirmed. Existing jobs are never
 * converted. Enrollment and revocation of one binding never interleave.
 */
export async function enrollScriptReport(request: EnrollmentRequest, runner: HermesCronRunner = defaultCronRunner): Promise<EnrollmentResult> {
  const bindingId = randomUUID()
  return withBindingLock(bindingId, () => enrollLocked(bindingId, request, runner))
}

async function enrollLocked(bindingId: string, request: EnrollmentRequest, runner: HermesCronRunner): Promise<EnrollmentResult> {
  const profile = text(request.profile, 128, 'invalid_profile')
  const name = text(request.name, 200, 'invalid_name')
  const schedule = text(request.schedule, 200, 'invalid_schedule')
  const home = profileHome(profile)
  const target = resolveTargetScript(join(home, 'scripts'), request.script)
  const workdir = optionalAbsolute(request.workdir, 'invalid_workdir', true)
  const interpreter = optionalAbsolute(request.interpreter, 'invalid_interpreter', false)
  if (interpreter && target.kind !== 'python') throw new EnrollmentError(400, 'invalid_interpreter')
  assertDestination(request.userId, profile, request.sessionId, request.expectedGeneration)

  const wrapperRelative = `${WRAPPER_DIR}/${bindingId}.py`
  const wrapperPath = join(home, 'scripts', WRAPPER_DIR, `${bindingId}.py`)
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
    target: { path: target.path, kind: target.kind, cwd: workdir || dirname(target.path) },
    target_sha256: createHash('sha256').update(readFileSync(target.path)).digest('hex'),
    spool_dir: scriptReportSpoolDir(bindingId),
    revoked_marker: scriptReportRevokedMarker(bindingId),
    max_pending: MAX_PENDING,
  }, null, 2)}\n`, 0o600)
  const binding = beginScriptReportBinding({
    bindingId, userId: request.userId, profile, sessionId: request.sessionId, expectedGeneration: request.expectedGeneration,
    jobName: name, targetScript: target.relative, wrapperScript: wrapperRelative,
  })
  const discard = () => {
    rmSync(wrapperPath, { force: true })
    rmSync(scriptReportBindingDir(bindingId), { recursive: true, force: true })
    rmSync(scriptReportSpoolDir(bindingId), { recursive: true, force: true })
  }

  let jobId: string | null = null
  try {
    // Hermes validates the script it is given at creation only: give it the real target first.
    const args = ['create', '--name', name, '--deliver', 'local', '--no-agent', '--script', target.relative,
      '--paused', '--paused-reason', 'Ekko script report enrollment']
    if (workdir) args.push('--workdir', workdir)
    if (interpreter) args.push('--interpreter', interpreter)
    args.push(schedule)
    const created = await runner(profile, args)
    jobId = parseCreatedJobId(`${created.stdout}\n${created.stderr}`)
    if (!jobId) throw new EnrollmentError(422, 'native_create_rejected', created.stderr.trim() || created.stdout.trim() || undefined)
  } catch (error: any) {
    failScriptReportBinding(bindingId, error?.code || 'native_create_failed')
    discard()
    if (error instanceof EnrollmentError) throw error
    // A refusal by Hermes (lifecycle guard, invalid schedule, …) surfaces as a failed command.
    throw new EnrollmentError(422, 'native_create_rejected', error?.message)
  }
  recordScriptReportJob(bindingId, jobId)

  const fail = (code: string, status = 502, message?: string): never => {
    // Leave the native job paused; the job id is reported for cleanup.
    failScriptReportBinding(bindingId, code)
    throw new EnrollmentError(status, code, message, jobId!)
  }
  try {
    privateDir(join(home, 'scripts', WRAPPER_DIR))
    writeExclusive(wrapperPath, renderWrapper(manifestPath), 0o700)
    await runner(profile, ['edit', jobId, '--script', wrapperRelative])
  } catch (error: any) {
    fail('native_edit_failed', 502, error?.message)
  }
  const job = readNativeJob(profile, jobId)
  if (!job || job.script !== wrapperRelative || job.no_agent !== true || job.deliver !== 'local' || job.enabled !== false) {
    fail('native_config_mismatch')
  }
  // The awaited CLI calls can outlast the destination: never activate or resume on stale authority.
  const reauthorize = () => authorizeNoticeDestination(request.userId, profile, request.sessionId, request.expectedGeneration)
  const beforeActivation = reauthorize()
  if (beforeActivation !== 'ok') fail('destination_changed', 409, beforeActivation)
  if (!activateScriptReportBinding(bindingId)) {
    // Revoked (or otherwise settled) meanwhile: never resume a job whose reports are refused.
    throw new EnrollmentError(409, 'binding_revoked', undefined, jobId)
  }
  if (request.paused) return { binding: findScriptReportBinding(bindingId)!, job, resumed: false }
  const beforeResume = reauthorize()
  if (beforeResume !== 'ok') {
    noteScriptReportBindingError(bindingId, 'destination_changed')
    throw new EnrollmentError(409, 'destination_changed', beforeResume, jobId, 'paused')
  }
  try {
    await runner(profile, ['resume', jobId])
  } catch (error: any) {
    noteScriptReportBindingError(bindingId, 'native_resume_failed')
    throw new EnrollmentError(502, 'native_resume_failed', error?.message, jobId, await ensurePaused(profile, jobId, runner))
  }
  // The resume succeeded; only the snapshot can fail to read. Keep the binding (with its job id) and
  // report the native state as unobserved instead of failing the request.
  let snapshot: Record<string, any> | null
  try {
    snapshot = readNativeJob(profile, jobId)
  } catch {
    return { binding: findScriptReportBinding(bindingId)!, job: null, resumed: true, nativeState: 'unknown' }
  }
  return { binding: findScriptReportBinding(bindingId)!, job: snapshot, resumed: true }
}

/**
 * A failed resume may still have enabled the job: pause it by id and report only what is observed.
 * Reading the job can fail as well (a missing or unreadable jobs file); that never skips the pause
 * and never loses the job id or the native state.
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
