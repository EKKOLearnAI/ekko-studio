import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { getHermesBaseDir, getProfileDir } from '../profiles/profile'

/** The native job record as Hermes stores it in the profile's `cron/jobs.json`, or null. */
export function readNativeJob(profile: string, jobId: string): Record<string, any> | null {
  const home = getProfileDir(profile)
  // An unknown profile resolves to the base home; never read another profile's jobs.
  if (profile !== 'default' && home === getHermesBaseDir()) return null
  const path = join(home, 'cron', 'jobs.json')
  if (!existsSync(path)) return null
  const parsed = JSON.parse(readFileSync(path, 'utf-8'))
  const jobs = Array.isArray(parsed) ? parsed : parsed?.jobs
  return (Array.isArray(jobs) ? jobs : []).find((job: any) => job?.id === jobId || job?.job_id === jobId) ?? null
}
