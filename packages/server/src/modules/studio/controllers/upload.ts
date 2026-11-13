import { authorizeShareUpload, authorizeSessionShare } from '../services/session-shares/access'
import { randomBytes } from 'crypto'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { getActiveProfileName } from '../public/profile-config'
import { getProfileUploadDir } from '../services/files/upload-paths'
import { MultipartParseError, parseMultipartBoundary, parseMultipartFilename, splitMultipart } from '../http/multipart'
import { drainRejectedRequest, nonDestroyingRequestBody } from '../http/request-body'

const DEFAULT_MAX_UPLOAD_SIZE = 50 * 1024 * 1024 // 50MB

// Operators can raise the limit for large-file workflows (e.g. media uploads)
// via HERMES_MAX_UPLOAD_SIZE (bytes) without patching the bundle. The value is
// read per request so tests can override it with vi.stubEnv.
function getMaxUploadSize(): number {
  const override = Number(process.env.HERMES_MAX_UPLOAD_SIZE)
  if (Number.isFinite(override) && override > 0) return override
  return DEFAULT_MAX_UPLOAD_SIZE
}

function requestedProfile(ctx: any): string {
  return ctx.state?.profile?.name || getActiveProfileName() || 'default'
}

export async function handleUpload(ctx: any) {
  const contentType = ctx.get('content-type') || ''
  if (!contentType.startsWith('multipart/form-data')) {
    ctx.status = 400; ctx.body = { error: 'Expected multipart/form-data' }; return
  }
  const boundaryBuf = parseMultipartBoundary(contentType)
  if (!boundaryBuf) {
    ctx.status = 400; ctx.body = { error: 'Missing boundary' }; return
  }
  let chunks: Buffer[] = []
  let totalSize = 0
  let oversize = false
  const maxUploadSize = getMaxUploadSize()
  // Leave the stream alive when the loop ends early; the iterator would
  // otherwise destroy it and take the unsent response down with it.
  const body = nonDestroyingRequestBody(ctx.req)
  for await (const chunk of body) {
    totalSize += chunk.length
    if (totalSize > maxUploadSize) {
      oversize = true
      break
    }
    chunks.push(chunk)
  }
  if (oversize) {
    chunks = []
    await drainRejectedRequest(ctx.req)
    ctx.status = 413
    ctx.body = { error: `File too large (max ${Math.round(maxUploadSize / 1024 / 1024)}MB)` }
    return
  }
  const raw = Buffer.concat(chunks)
  const parts = splitMultipart(raw, boundaryBuf)
  const results: { name: string; path: string }[] = []
  const uploadDir = ctx.state?.sessionShare ? await authorizeShareUpload(ctx.state.sessionShare) : getProfileUploadDir(requestedProfile(ctx))
  await mkdir(uploadDir, { recursive: true })
  for (const part of parts) {
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'))
    if (headerEnd === -1) continue
    const headerBuf = part.subarray(0, headerEnd)
    const header = headerBuf.toString('utf-8')
    const data = part.subarray(headerEnd + 4, part.length - 2)
    let filename: string | null
    try {
      filename = parseMultipartFilename(header)
    } catch (error) {
      if (error instanceof MultipartParseError) {
        ctx.status = 400; ctx.body = { error: error.message }; return
      }
      throw error
    }
    if (!filename) continue
    const ext = filename.includes('.') ? '.' + filename.split('.').pop() : ''
    const safeExt = ctx.state?.sessionShare && !/^\.[A-Za-z0-9]{1,20}$/.test(ext) ? '' : ext
    const savedName = randomBytes(8).toString('hex') + safeExt
    const savedPath = join(uploadDir, savedName)
    if (ctx.state?.sessionShare) authorizeSessionShare(ctx.state.sessionShare, 'upload')
    await writeFile(savedPath, data)
    results.push({ name: filename, path: savedPath })
  }
  ctx.body = { files: results }
}
