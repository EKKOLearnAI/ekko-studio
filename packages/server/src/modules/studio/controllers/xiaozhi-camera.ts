import type { Context } from 'koa'
import { parseMultipartBoundary, splitMultipart } from '../http/multipart'
import { drainRejectedRequest, nonDestroyingRequestBody } from '../http/request-body'
import { analyzeCameraPhoto, authorizeCameraUpload, captureXiaozhiPhoto, readCameraPhoto, saveCameraPhoto } from '../services/xiaozhi-camera'

export async function analyzeCameraFrame(ctx: Context) {
  ctx.set('Cache-Control', 'no-store')
  const deviceId = ctx.get('device-id')
  if (!await authorizeCameraUpload(deviceId, ctx.get('authorization').replace(/^Bearer\s+/i, ''))) { ctx.status = 401; return }
  const body = ctx.request.body as Record<string, unknown> | undefined
  if (typeof body?.id !== 'string' || typeof body.question !== 'string' || !body.question.trim() || body.question.length > 1000) { ctx.status = 400; return }
  try { ctx.body = await analyzeCameraPhoto(body.id, deviceId, body.question) }
  catch (error) { ctx.status = 502; ctx.body = { error: error instanceof Error ? error.message : 'Camera vision failed' } }
}

export async function uploadCameraPhoto(ctx: Context) {
  ctx.set('Cache-Control', 'no-store')
  if (!await authorizeCameraUpload(ctx.get('device-id'), ctx.get('authorization').replace(/^Bearer\s+/i, ''))) { ctx.status = 401; return }
  const boundary = parseMultipartBoundary(ctx.get('content-type'))
  if (!ctx.get('content-type').startsWith('multipart/form-data') || !boundary) { ctx.status = 400; return }
  const chunks: Buffer[] = []; let bytes = 0
  for await (const chunk of nonDestroyingRequestBody(ctx.req)) {
    bytes += chunk.length
    if (bytes > 3 * 1024 * 1024) { await drainRejectedRequest(ctx.req); ctx.status = 413; return }
    chunks.push(chunk)
  }
  const parts = splitMultipart(Buffer.concat(chunks), boundary)
  for (const part of parts) {
    const end = part.indexOf('\r\n\r\n')
    if (end < 0 || !/name="file";\s*filename=/i.test(part.subarray(0, end).toString())) continue
    try { ctx.body = await saveCameraPhoto(part.subarray(end + 4, part.length - 2), ctx.get('device-id')); return }
    catch { ctx.status = 400; ctx.body = { error: 'Invalid camera JPEG' }; return }
  }
  ctx.status = 400; ctx.body = { error: 'Camera JPEG missing' }
}
export async function captureCameraPhoto(ctx: Context) {
  ctx.set('Cache-Control', 'no-store')
  try { ctx.body = await captureXiaozhiPhoto() }
  catch (error) { ctx.status = 503; ctx.body = { error: error instanceof Error ? error.message : 'Camera capture failed' } }
}
export async function getCameraPhoto(ctx: Context) {
  ctx.set('Cache-Control', 'no-store')
  const photo = await readCameraPhoto(String(ctx.params.id || ''))
  if (!photo) { ctx.status = 404; return }
  if (ctx.query.format === 'json') { ctx.body = { base64: photo.toString('base64') }; return }
  ctx.type = 'image/jpeg'; ctx.body = photo
}
