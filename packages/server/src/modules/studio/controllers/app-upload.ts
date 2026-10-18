import { authorizeShareUpload } from '../services/session-shares/access'
import { getActiveProfileName } from '../public/profile-config'
import {
  APP_UPLOAD_CHUNK_BYTES,
  AppUploadError,
  abortAppUpload,
  appendAppUploadChunk,
  completeAppUpload,
  openAppUpload,
} from '../services/files/app-upload'

function requestedProfile(ctx: any): string {
  return ctx.state?.profile?.name || getActiveProfileName() || 'default'
}

async function requestOwner(ctx: any): Promise<string> {
  if (ctx.state?.sessionShare) {
    await authorizeShareUpload(ctx.state.sessionShare)
    return `share:${ctx.state.sessionShare.share.id}`
  }
  return String(ctx.state?.user?.id || ctx.state?.user?.username || 'local')
}

function handleError(ctx: any, error: unknown): void {
  if (error instanceof AppUploadError) {
    ctx.status = error.status
    ctx.body = { error: error.message, code: error.code }
    return
  }
  throw error
}

export async function open(ctx: any): Promise<void> {
  try {
    const body = ctx.request.body && typeof ctx.request.body === 'object' && !Array.isArray(ctx.request.body)
      ? ctx.request.body as Record<string, unknown>
      : {}
    ctx.body = await openAppUpload({
      id: body.id,
      name: body.name,
      size: body.size,
      uploadDir: ctx.state?.sessionShare ? await authorizeShareUpload(ctx.state.sessionShare) : undefined,
      owner: await requestOwner(ctx),
      profile: requestedProfile(ctx),
    })
  } catch (error) {
    handleError(ctx, error)
  }
}

export async function appendChunk(ctx: any): Promise<void> {
  try {
    const chunks: Buffer[] = []
    let byteLength = 0
    for await (const rawChunk of ctx.req) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
      byteLength += chunk.byteLength
      if (byteLength > APP_UPLOAD_CHUNK_BYTES) {
        throw new AppUploadError('upload_chunk_too_large', `Upload chunks are limited to ${APP_UPLOAD_CHUNK_BYTES} bytes`, 413)
      }
      chunks.push(chunk)
    }
    ctx.body = await appendAppUploadChunk({
      id: ctx.params.id,
      offset: ctx.query.offset,
      bytes: Uint8Array.from(Buffer.concat(chunks)),
      owner: await requestOwner(ctx),
      profile: requestedProfile(ctx),
    })
  } catch (error) {
    handleError(ctx, error)
  }
}

export async function complete(ctx: any): Promise<void> {
  try {
    const file = await completeAppUpload({
      id: ctx.params.id,
      owner: await requestOwner(ctx),
      profile: requestedProfile(ctx),
    })
    ctx.body = { files: [file] }
  } catch (error) {
    handleError(ctx, error)
  }
}

export async function abort(ctx: any): Promise<void> {
  try {
    await abortAppUpload({
      id: ctx.params.id,
      owner: await requestOwner(ctx),
      profile: requestedProfile(ctx),
    })
    ctx.body = { ok: true }
  } catch (error) {
    handleError(ctx, error)
  }
}
