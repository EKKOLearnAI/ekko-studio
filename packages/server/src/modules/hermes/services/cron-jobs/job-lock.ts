import { createHash } from 'crypto'

const jobLocks = new Map<string, Promise<unknown>>()
const creationFences = new Map<string, Promise<void>>()

function chainJobLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = jobLocks.get(key) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(task)
  const settled = current.catch(() => undefined)
  jobLocks.set(key, settled)
  void settled.then(() => { if (jobLocks.get(key) === settled) jobLocks.delete(key) })
  return current
}

/**
 * Serialize Studio-managed mutations of one native job (consent application, enrollment and the
 * jobs API). A managed mutation also waits for any job creation in flight in the profile, so it can
 * never reach a newly created job before its creator holds that job's lock. Native tools and other
 * same-UID processes are outside this per-process lock.
 */
export async function withCronJobLock<T>(profile: string, jobId: string, task: () => Promise<T>): Promise<T> {
  for (let fence = creationFences.get(profile); fence; fence = creationFences.get(profile)) await fence
  return chainJobLock(`${profile}\0${jobId}`, task)
}

/**
 * Create a native job and admit it under its lock. While `create` runs (and until the new job's lock
 * is taken) managed mutations in the profile wait, because the job is visible on disk before its id
 * is known. Creations in one profile run one at a time.
 */
export function withCronJobCreation<T>(profile: string, create: () => Promise<string>, admit: (jobId: string) => Promise<T>): Promise<T> {
  const previous = creationFences.get(profile) ?? Promise.resolve()
  let release!: () => void
  const fence = new Promise<void>(resolve => { release = resolve })
  creationFences.set(profile, fence)
  void fence.then(() => { if (creationFences.get(profile) === fence) creationFences.delete(profile) })
  return previous.then(async () => {
    let jobId: string
    try {
      jobId = await create()
    } catch (error) {
      release()
      throw error
    }
    // Take the new job's lock before any waiting managed mutation can.
    const admitted = chainJobLock(`${profile}\0${jobId}`, () => admit(jobId))
    release()
    return admitted
  })
}

/** Run-time bookkeeping Hermes rewrites on its own; everything else is consent-relevant. */
const VOLATILE_KEYS = new Set([
  'enabled', 'state', 'paused_at', 'paused_reason', 'next_run_at', 'failure_streak', 'monitor_state',
  'running', 'claimed_at', 'claim', 'updated_at',
])

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
      .map(key => [key, canonical((value as Record<string, unknown>)[key])]))
  }
  return value === undefined ? null : value
}

/** The job configuration a user approves: every stored field except run-time bookkeeping. */
export function jobConfiguration(job: Record<string, any>, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const config: Record<string, unknown> = {}
  for (const [key, value] of Object.entries({ ...job, ...overrides })) {
    if (VOLATILE_KEYS.has(key) || key.startsWith('last_')) continue
    // Only the repeat limit is configuration; its completion count advances on every fire.
    config[key] = key === 'repeat' && value && typeof value === 'object' ? { times: (value as any).times ?? null } : value
  }
  return canonical(config) as Record<string, unknown>
}

export function jobFingerprint(job: Record<string, any>, overrides: Record<string, unknown> = {}): string {
  return createHash('sha256').update(JSON.stringify(jobConfiguration(job, overrides))).digest('hex')
}
