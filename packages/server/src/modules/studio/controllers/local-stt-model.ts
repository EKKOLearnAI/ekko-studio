import type { Context } from 'koa'
import {
  getLocalSttModelStatus,
  startLocalSttModelDownload,
  type LocalSttModelDownloadSource,
} from '../services/voice/stt/local-model-manager'

function parseSource(value: unknown): LocalSttModelDownloadSource {
  return value === 'github' ? 'github' : 'cf'
}

export function status(ctx: Context) {
  ctx.body = getLocalSttModelStatus()
}

export function download(ctx: Context) {
  const body = ctx.request.body as { source?: unknown } | undefined
  try {
    const job = startLocalSttModelDownload(parseSource(body?.source))
    ctx.status = 202
    ctx.body = { success: true, job }
  } catch (error) {
    ctx.status = 400
    ctx.body = { error: error instanceof Error ? error.message : String(error) }
  }
}
