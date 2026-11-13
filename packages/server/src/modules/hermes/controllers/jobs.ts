import type { Context } from 'koa'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { readConfigYamlForProfile } from '../../studio/public/profile-config'
import { getActiveProfileName, getProfileDir } from '../services/profiles/profile'
import { getHermesBin } from '../services/runtime/path'
import { execHermesWithBin, spawnHermesWithBin } from '../services/runtime/process'

const TIMEOUT_MS = 60_000

type JobRecord = Record<string, any>

interface DeliveryTargetRecord {
  platform: string
  id: string
  name: string
  type: string | null
  thread_id: string | null
  value: string
}

function resolveProfile(ctx: Context): string {
  const requestedProfile = ctx.state?.profile?.name
  return requestedProfile || getActiveProfileName()
}

function resolveProfileDir(profile: string): string {
  return getProfileDir(profile || 'default')
}

function getJobsPath(profile: string): string {
  return join(resolveProfileDir(profile), 'cron', 'jobs.json')
}

function getChannelDirectoryPath(profile: string): string {
  return join(resolveProfileDir(profile), 'channel_directory.json')
}

function readDeliveryTargets(profile: string): { updated_at: string | null; targets: DeliveryTargetRecord[] } {
  const directoryPath = getChannelDirectoryPath(profile)
  if (!existsSync(directoryPath)) return { updated_at: null, targets: [] }

  try {
    const parsed = JSON.parse(readFileSync(directoryPath, 'utf-8'))
    const platforms = parsed?.platforms
    if (!platforms || typeof platforms !== 'object' || Array.isArray(platforms)) {
      return { updated_at: null, targets: [] }
    }

    const targets: DeliveryTargetRecord[] = []
    const seen = new Set<string>()
    for (const [rawPlatform, rawChannels] of Object.entries(platforms)) {
      const platform = String(rawPlatform || '').trim().toLowerCase()
      if (!platform || !Array.isArray(rawChannels)) continue

      for (const rawChannel of rawChannels) {
        if (!rawChannel || typeof rawChannel !== 'object') continue
        const channel = rawChannel as Record<string, unknown>
        const id = String(channel.id ?? channel.chat_id ?? '').trim()
        if (!id) continue

        const value = `${platform}:${id}`
        if (seen.has(value)) continue
        seen.add(value)

        const name = String(channel.name ?? id).trim() || id
        const type = channel.type == null ? null : String(channel.type).trim() || null
        const threadId = channel.thread_id == null ? null : String(channel.thread_id).trim() || null
        targets.push({ platform, id, name, type, thread_id: threadId, value })
      }
    }

    targets.sort((a, b) => {
      const platformOrder = a.platform.localeCompare(b.platform)
      return platformOrder || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
    })

    const updatedAt = typeof parsed.updated_at === 'string' && parsed.updated_at.trim()
      ? parsed.updated_at
      : null
    return { updated_at: updatedAt, targets }
  } catch {
    return { updated_at: null, targets: [] }
  }
}

function normalizeJob(job: JobRecord): JobRecord {
  const id = job.job_id || job.id
  const skills = Array.isArray(job.skills)
    ? job.skills
    : (job.skill ? [job.skill] : [])

  return {
    ...job,
    id,
    job_id: id,
    skills,
    skill: job.skill ?? skills[0] ?? null,
    model: job.model ?? null,
    provider: job.provider ?? null,
    base_url: job.base_url ?? null,
    script: job.script ?? null,
    schedule_display: job.schedule_display ?? job.schedule?.display ?? job.schedule?.expr ?? '',
    repeat: job.repeat ?? { times: null, completed: 0 },
    enabled: job.enabled ?? true,
    state: job.state ?? ((job.enabled ?? true) ? 'scheduled' : 'paused'),
    paused_at: job.paused_at ?? null,
    paused_reason: job.paused_reason ?? null,
    created_at: job.created_at ?? '',
    next_run_at: job.next_run_at ?? null,
    last_run_at: job.last_run_at ?? null,
    last_status: job.last_status ?? null,
    last_error: job.last_error ?? null,
    deliver: job.deliver ?? 'local',
    origin: job.origin ?? null,
    last_delivery_error: job.last_delivery_error ?? null,
  }
}

function resolveJobDefaults(jobs: JobRecord[], config: Record<string, any>): JobRecord[] {
  const modelSection = config.model
  let defaultModel = ''
  let defaultProvider = ''
  if (typeof modelSection === 'object' && modelSection !== null) {
    defaultModel = String(modelSection.default || '').trim()
    defaultProvider = String(modelSection.provider || '').trim()
    // Resolve 'custom' provider from custom_providers matching base_url+model
    if (defaultProvider === 'custom' && defaultModel) {
      const cps = Array.isArray(config.custom_providers) ? config.custom_providers : []
      const match = cps.find((cp: any) =>
        String(cp.base_url || '').replace(/\/$/, '') === String(modelSection.base_url || '').replace(/\/$/, '')
        && String(cp.model || '') === defaultModel
      ) || cps.find((cp: any) =>
        String(cp.base_url || '').replace(/\/$/, '') === String(modelSection.base_url || '').replace(/\/$/, '')
      )
      if (match) defaultProvider = 'custom:' + String(match.name || '').trim()
    }
  } else if (typeof modelSection === 'string') {
    defaultModel = modelSection.trim()
  }
  if (!defaultModel && !defaultProvider) return jobs
  return jobs.map(job => ({
    ...job,
    provider: job.provider || defaultProvider || null,
    model: job.model || defaultModel || null,
  }))
}

function writeJobs(profile: string, jobs: JobRecord[], asArray = false): void {
  const jobsPath = getJobsPath(profile)
  const payload = asArray ? jobs : { jobs }
  writeFileSync(jobsPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8')
}

function readJobs(profile: string, includeDisabled = true): JobRecord[] {
  const jobsPath = getJobsPath(profile)
  if (!existsSync(jobsPath)) return []

  const parsed = JSON.parse(readFileSync(jobsPath, 'utf-8'))
  const rawJobs = Array.isArray(parsed) ? parsed : parsed?.jobs
  const jobs = Array.isArray(rawJobs) ? rawJobs.map(normalizeJob) : []

  if (includeDisabled) return jobs
  return jobs.filter((job) => job.enabled !== false)
}

function findJob(profile: string, jobId: string): JobRecord | null {
  return readJobs(profile, true).find((job) => job.job_id === jobId || job.id === jobId) ?? null
}

function boolQuery(value: unknown, defaultValue: boolean): boolean {
  if (value == null) return defaultValue
  const text = String(value).toLowerCase()
  return text === '1' || text === 'true' || text === 'yes'
}

function getBody(ctx: Context): Record<string, any> {
  return (ctx.request.body && typeof ctx.request.body === 'object')
    ? ctx.request.body as Record<string, any>
    : {}
}

function getRepeatValue(repeat: unknown): number | null {
  if (repeat == null || repeat === '') return null
  if (typeof repeat === 'number' && Number.isFinite(repeat)) return repeat
  if (typeof repeat === 'object') {
    const times = (repeat as any).times
    if (typeof times === 'number' && Number.isFinite(times)) return times
    if (typeof times === 'string' && times.trim()) {
      const parsed = Number(times)
      return Number.isFinite(parsed) ? parsed : null
    }
    return null
  }
  const parsed = Number(repeat)
  return Number.isFinite(parsed) ? parsed : null
}

function hasRepeatField(body: Record<string, any>): boolean {
  return Object.prototype.hasOwnProperty.call(body, 'repeat')
}

function normalizeOptionalText(value: unknown): string | null {
  if (value == null) return null
  const text = String(value).trim()
  return text ? text : null
}

function hasOwn(body: Record<string, any>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, field)
}

function buildInferenceUpdates(body: Record<string, any>): Record<string, string | null> {
  const updates: Record<string, string | null> = {}
  if (hasOwn(body, 'provider')) updates.provider = normalizeOptionalText(body.provider)
  if (hasOwn(body, 'model')) updates.model = normalizeOptionalText(body.model)
  if (hasOwn(body, 'base_url')) updates.base_url = normalizeOptionalText(body.base_url)
  return updates
}

function patchJobFields(profile: string, jobId: string, fields: Record<string, any>): JobRecord | null {
  const updates = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))
  if (Object.keys(updates).length === 0) return findJob(profile, jobId)

  const jobsPath = getJobsPath(profile)
  if (!existsSync(jobsPath)) return null
  const parsed = JSON.parse(readFileSync(jobsPath, 'utf-8'))
  const parsedAsArray = Array.isArray(parsed)
  const rawJobs = parsedAsArray ? parsed : parsed?.jobs
  if (!Array.isArray(rawJobs)) return null

  const index = rawJobs.findIndex((job: JobRecord) => (job.job_id || job.id) === jobId || job.id === jobId)
  if (index === -1) return null
  rawJobs[index] = {
    ...rawJobs[index],
    ...updates,
  }
  writeJobs(profile, rawJobs, parsedAsArray)
  return normalizeJob(rawJobs[index])
}

function getSkills(body: Record<string, any>): string[] | null {
  if (Array.isArray(body.skills)) {
    return body.skills.map((skill) => String(skill || '').trim()).filter(Boolean)
  }
  if (typeof body.skill === 'string') {
    const skill = body.skill.trim()
    return skill ? [skill] : []
  }
  return null
}

async function runHermesCron(profile: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const profileDir = resolveProfileDir(profile)
  try {
    return await execHermesWithBin(getHermesBin(), args, {
      cwd: process.cwd(),
      env: { ...process.env, HERMES_HOME: profileDir },
      timeout: TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    })
  } catch (error: any) {
    const stderr = String(error?.stderr || '').trim()
    const stdout = String(error?.stdout || '').trim()
    throw new Error(stderr || stdout || error?.message || 'Hermes cron command failed')
  }
}

function reportedCommandFailure(result: { stdout: string; stderr: string }): string | null {
  for (const output of [result.stderr, result.stdout]) {
    const message = String(output || '').trim()
    if (/^(?:failed|error)\b/im.test(message)) return message
  }
  return null
}

async function startHermesCronInBackground(profile: string, args: string[]): Promise<void> {
  const profileDir = resolveProfileDir(profile)
  const child = spawnHermesWithBin(getHermesBin(), args, {
    cwd: process.cwd(),
    env: { ...process.env, HERMES_HOME: profileDir },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })

  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

function getCronArgs(profile: string, command: string, ...args: string[]): string[] {
  return ['cron', command, '--profile', profile, ...args]
}

function sendJobNotFound(ctx: Context): void {
  ctx.status = 404
  ctx.body = { error: { message: 'Job not found' } }
}

function sendCommandError(ctx: Context, error: any): void {
  ctx.status = 500
  ctx.body = { error: { message: error?.message || 'Hermes cron command failed' } }
}

function findCreatedJob(beforeJobs: JobRecord[], afterJobs: JobRecord[]): JobRecord | null {
  const beforeIds = new Set(beforeJobs.map((job) => job.job_id || job.id))
  return afterJobs.find((job) => !beforeIds.has(job.job_id || job.id)) ?? null
}

export async function list(ctx: Context) {
  const profile = resolveProfile(ctx)
  const includeDisabled = boolQuery(ctx.query.include_disabled, false)
  const jobs = readJobs(profile, includeDisabled)
  const config = await readConfigYamlForProfile(profile)
  ctx.body = { jobs: resolveJobDefaults(jobs, config) }
}

export function deliveryTargets(ctx: Context) {
  ctx.body = readDeliveryTargets(resolveProfile(ctx))
}

export async function get(ctx: Context) {
  const profile = resolveProfile(ctx)
  const job = findJob(profile, ctx.params.id)
  if (!job) return sendJobNotFound(ctx)
  ctx.body = { job }
}

export async function create(ctx: Context) {
  const profile = resolveProfile(ctx)
  const body = getBody(ctx)
  const name = String(body.name || '').trim()
  const schedule = String(body.schedule || body.schedule_display || '').trim()
  const prompt = String(body.prompt || '').trim()
  const skills = getSkills(body)
  const script = String(body.script || '').trim()

  if (!name) {
    ctx.status = 400
    ctx.body = { error: { message: 'Name is required' } }
    return
  }
  if (!schedule) {
    ctx.status = 400
    ctx.body = { error: { message: 'Schedule is required' } }
    return
  }
  if (!prompt && !skills?.length && !script) {
    ctx.status = 400
    ctx.body = { error: { message: 'Prompt, skill, or script is required' } }
    return
  }

  const beforeJobs = readJobs(profile, true)
  const args = getCronArgs(profile, 'create')
  args.push('--name', name)
  if (body.deliver != null && String(body.deliver).trim()) args.push('--deliver', String(body.deliver).trim())

  const repeat = getRepeatValue(body.repeat)
  if (repeat != null) {
    args.push('--repeat', String(repeat))
  } else if (hasRepeatField(body)) {
    // Hermes CLI normalizes repeat <= 0 to an unbounded/null repeat.
    args.push('--repeat', '0')
  }

  for (const skill of skills || []) args.push('--skill', skill)

  if (script) args.push('--script', script)
  if (body.workdir != null) args.push('--workdir', String(body.workdir))
  if (body.no_agent === true) args.push('--no-agent')

  args.push(schedule)
  if (prompt) args.push(prompt)

  try {
    const result = await runHermesCron(profile, args)
    const job = findCreatedJob(beforeJobs, readJobs(profile, true))
    if (!job) {
      const reportedFailure = reportedCommandFailure(result)
      if (reportedFailure) {
        ctx.status = 400
        ctx.body = { error: { message: reportedFailure } }
        return
      }
      throw new Error('Hermes cron command completed without creating a job')
    }
    const inferenceUpdates = buildInferenceUpdates(body)
    const patchedJob = patchJobFields(profile, job.job_id || job.id, inferenceUpdates)
    ctx.body = { job: patchedJob || job }
  } catch (error: any) {
    sendCommandError(ctx, error)
  }
}

export async function update(ctx: Context) {
  const profile = resolveProfile(ctx)
  const body = getBody(ctx)
  if (!findJob(profile, ctx.params.id)) return sendJobNotFound(ctx)

  const args = getCronArgs(profile, 'edit', ctx.params.id)
  if (body.schedule != null || body.schedule_display != null) {
    args.push('--schedule', String(body.schedule ?? body.schedule_display))
  }
  if (body.prompt != null) args.push('--prompt', String(body.prompt))
  if (body.name != null) args.push('--name', String(body.name))
  if (body.deliver != null) args.push('--deliver', String(body.deliver))

  const repeat = getRepeatValue(body.repeat)
  if (repeat != null) {
    args.push('--repeat', String(repeat))
  } else if (hasRepeatField(body)) {
    // Hermes CLI normalizes repeat <= 0 to an unbounded/null repeat.
    args.push('--repeat', '0')
  }

  const skills = getSkills(body)
  if (skills) {
    if (skills.length === 0) {
      args.push('--clear-skills')
    } else {
      for (const skill of skills) args.push('--skill', skill)
    }
  }

  if (body.script != null) args.push('--script', String(body.script))
  if (body.workdir != null) args.push('--workdir', String(body.workdir))
  if (body.no_agent === true) args.push('--no-agent')
  if (body.no_agent === false) args.push('--agent')

  try {
    const inferenceUpdates = buildInferenceUpdates(body)
    const hasCliUpdates = args.length > 5
    if (hasCliUpdates) {
      await runHermesCron(profile, args)
    }
    const patchedJob = patchJobFields(profile, ctx.params.id, inferenceUpdates)
    const job = patchedJob || findJob(profile, ctx.params.id)
    if (!job) return sendJobNotFound(ctx)
    ctx.body = { job }
  } catch (error: any) {
    sendCommandError(ctx, error)
  }
}

export async function remove(ctx: Context) {
  const profile = resolveProfile(ctx)
  if (!findJob(profile, ctx.params.id)) return sendJobNotFound(ctx)

  try {
    await runHermesCron(profile, getCronArgs(profile, 'remove', ctx.params.id))
    ctx.body = { ok: true }
  } catch (error: any) {
    sendCommandError(ctx, error)
  }
}

export async function pause(ctx: Context) {
  const profile = resolveProfile(ctx)
  if (!findJob(profile, ctx.params.id)) return sendJobNotFound(ctx)

  try {
    await runHermesCron(profile, getCronArgs(profile, 'pause', ctx.params.id))
    const job = findJob(profile, ctx.params.id)
    ctx.body = { job }
  } catch (error: any) {
    sendCommandError(ctx, error)
  }
}

export async function resume(ctx: Context) {
  const profile = resolveProfile(ctx)
  if (!findJob(profile, ctx.params.id)) return sendJobNotFound(ctx)

  try {
    await runHermesCron(profile, getCronArgs(profile, 'resume', ctx.params.id))
    const job = findJob(profile, ctx.params.id)
    ctx.body = { job }
  } catch (error: any) {
    sendCommandError(ctx, error)
  }
}

export async function run(ctx: Context) {
  const profile = resolveProfile(ctx)
  if (!findJob(profile, ctx.params.id)) return sendJobNotFound(ctx)

  try {
    await startHermesCronInBackground(profile, getCronArgs(profile, 'run', ctx.params.id))
    const job = findJob(profile, ctx.params.id)
    ctx.status = 202
    ctx.body = { job }
  } catch (error: any) {
    sendCommandError(ctx, error)
  }
}
