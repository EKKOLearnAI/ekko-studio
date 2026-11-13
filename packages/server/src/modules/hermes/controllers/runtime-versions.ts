import type { Context } from 'koa'
import {
  activateInstalledRuntimeVersion,
  activateDownloadedWebUiVersion,
  deleteDownloadedWebUiVersion,
  deleteInstalledRuntimeVersion,
  getVersionDownloadJob,
  getRuntimeVersionStatus,
  listVersionDownloadJobs,
  scheduleRuntimeRootMigration,
  startRuntimeVersionDownload,
  startWebUiVersionDownload,
  type VersionDownloadSource,
} from '../services/runtime/version-manager'
import { configurePreferredHermesRuntime } from '../services/runtime/selection'
import { scheduleWebUiRestart } from '../../studio/public/web-ui-restart'

function parseDownloadSource(value: unknown): VersionDownloadSource {
  return value === 'github' ? 'github' : 'cf'
}

export async function status(ctx: Context) {
  const probeRuntime = ctx.query.runtime !== 'false' && ctx.query.runtime !== '0'
  const includeRemote = ctx.query.remote !== 'false' && ctx.query.remote !== '0'
  if (probeRuntime) await configurePreferredHermesRuntime()
  ctx.body = await getRuntimeVersionStatus({ probeRuntime, includeRemote })
}

export async function activateRuntime(ctx: Context) {
  const body = ctx.request.body as { version?: unknown }
  const version = typeof body?.version === 'string' ? body.version : ''
  try {
    const active = activateInstalledRuntimeVersion(version)
    await configurePreferredHermesRuntime()
    await getRuntimeVersionStatus({ includeRemote: false })
    ctx.body = { success: true, active }
  } catch (err) {
    ctx.status = 400
    ctx.body = { error: err instanceof Error ? err.message : String(err) }
  }
}

export async function selectRuntimeRoot(ctx: Context) {
  const body = ctx.request.body as { directory?: unknown }
  const directory = typeof body?.directory === 'string' ? body.directory : ''
  try {
    const active = scheduleRuntimeRootMigration(directory)
    ctx.body = { success: true, active }
  } catch (err) {
    ctx.status = 400
    ctx.body = { error: err instanceof Error ? err.message : String(err) }
  }
}

export async function deleteRuntime(ctx: Context) {
  const version = String(ctx.params.version || '')
  try {
    const deleted = deleteInstalledRuntimeVersion(version)
    await configurePreferredHermesRuntime()
    await getRuntimeVersionStatus({ includeRemote: false })
    ctx.body = { success: true, deleted }
  } catch (err) {
    ctx.status = 400
    ctx.body = { error: err instanceof Error ? err.message : String(err) }
  }
}

export function restartWebUi(ctx: Context) {
  try {
    scheduleWebUiRestart()
    ctx.status = 202
    ctx.body = { success: true }
  } catch (err) {
    ctx.status = 400
    ctx.body = { error: err instanceof Error ? err.message : String(err) }
  }
}

export async function activateWebUi(ctx: Context) {
  const body = ctx.request.body as { version?: unknown }
  const version = typeof body?.version === 'string' ? body.version : ''
  try {
    const active = activateDownloadedWebUiVersion(version)
    ctx.body = { success: true, active }
  } catch (err) {
    ctx.status = 400
    ctx.body = { error: err instanceof Error ? err.message : String(err) }
  }
}

export async function deleteWebUi(ctx: Context) {
  const version = String(ctx.params.version || '')
  try {
    const deleted = deleteDownloadedWebUiVersion(version)
    ctx.body = { success: true, deleted }
  } catch (err) {
    ctx.status = 400
    ctx.body = { error: err instanceof Error ? err.message : String(err) }
  }
}

export async function downloadRuntime(ctx: Context) {
  const body = ctx.request.body as { version?: unknown; source?: unknown }
  const version = typeof body?.version === 'string' ? body.version : ''
  const source = parseDownloadSource(body?.source)
  try {
    const job = startRuntimeVersionDownload(version, source)
    ctx.status = 202
    ctx.body = { success: true, job }
  } catch (err) {
    ctx.status = 400
    ctx.body = { error: err instanceof Error ? err.message : String(err) }
  }
}

export async function downloadWebUi(ctx: Context) {
  const body = ctx.request.body as { version?: unknown; source?: unknown }
  const version = typeof body?.version === 'string' ? body.version : ''
  const source = parseDownloadSource(body?.source)
  try {
    const job = startWebUiVersionDownload(version, source)
    ctx.status = 202
    ctx.body = { success: true, job }
  } catch (err) {
    ctx.status = 400
    ctx.body = { error: err instanceof Error ? err.message : String(err) }
  }
}

export async function jobs(ctx: Context) {
  ctx.body = { jobs: listVersionDownloadJobs() }
}

export async function job(ctx: Context) {
  const id = String(ctx.params.id || '')
  const downloadJob = getVersionDownloadJob(id)
  if (!downloadJob) {
    ctx.status = 404
    ctx.body = { error: 'Version download job not found' }
    return
  }
  ctx.body = downloadJob
}
