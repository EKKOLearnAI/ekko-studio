import { randomBytes } from 'crypto'
import { appendFile, mkdir, rename, rm, stat, writeFile } from 'fs/promises'
import { basename, extname, join } from 'path'
import { getProfileUploadDir } from './upload-paths'

export const APP_UPLOAD_MAX_BYTES = 50 * 1024 * 1024
export const APP_UPLOAD_CHUNK_BYTES = 256 * 1024
const APP_UPLOAD_SESSION_TTL_MS = 5 * 60 * 1000
const UPLOAD_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/

interface AppUploadSession {
  id: string
  owner: string
  profile: string
  name: string
  size: number
  receivedBytes: number
  partPath: string
  savedPath: string
  timer: ReturnType<typeof setTimeout>
  writing: boolean
}

export interface AppUploadResult {
  name: string
  path: string
}

export class AppUploadError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'AppUploadError'
    this.code = code
    this.status = status
  }
}

const sessions = new Map<string, AppUploadSession>()

export async function openAppUpload(input: {
  id: unknown
  owner: string
  profile: string
  name: unknown
  size: unknown
  /** Server-selected directory; never read from request body. */
  uploadDir?: string
}): Promise<{ id: string; nextOffset: number; maxChunkBytes: number }> {
  const id = String(input.id || '').trim()
  if (!UPLOAD_ID_PATTERN.test(id)) throw new AppUploadError('invalid_upload_id', 'Invalid upload id')
  if (sessions.has(id)) throw new AppUploadError('upload_exists', 'Upload id is already active', 409)
  const name = safeDisplayName(input.name)
  const size = Number(input.size)
  if (!Number.isSafeInteger(size) || size < 0) throw new AppUploadError('invalid_upload_size', 'Invalid upload size')
  if (size > APP_UPLOAD_MAX_BYTES) {
    throw new AppUploadError('upload_too_large', 'File is too large (max 50MB)', 413)
  }

  const uploadDir = input.uploadDir || getProfileUploadDir(input.profile)
  await mkdir(uploadDir, { recursive: true })
  const extension = safeExtension(name)
  const storageId = randomBytes(12).toString('hex')
  const partPath = join(uploadDir, `.${storageId}.app-upload-part`)
  const savedPath = join(uploadDir, `${storageId}${extension}`)
  await writeFile(partPath, new Uint8Array(), { flag: 'wx' })
  const session: AppUploadSession = {
    id,
    owner: input.owner,
    profile: input.profile,
    name,
    size,
    receivedBytes: 0,
    partPath,
    savedPath,
    timer: setTimeout(() => undefined, 1),
    writing: false,
  }
  clearTimeout(session.timer)
  session.timer = expiryTimer(session)
  sessions.set(id, session)
  return { id, nextOffset: 0, maxChunkBytes: APP_UPLOAD_CHUNK_BYTES }
}

export async function appendAppUploadChunk(input: {
  id: string
  owner: string
  profile: string
  offset: unknown
  bytes: Uint8Array
}): Promise<{ id: string; nextOffset: number; done: boolean }> {
  const session = ownedSession(input.id, input.owner, input.profile)
  const offset = Number(input.offset)
  if (!Number.isSafeInteger(offset) || offset !== session.receivedBytes) {
    throw new AppUploadError('invalid_upload_offset', `Expected upload offset ${session.receivedBytes}`, 409)
  }
  if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) {
    throw new AppUploadError('invalid_upload_chunk', 'Upload chunk is empty')
  }
  if (input.bytes.byteLength > APP_UPLOAD_CHUNK_BYTES) {
    throw new AppUploadError('upload_chunk_too_large', `Upload chunks are limited to ${APP_UPLOAD_CHUNK_BYTES} bytes`, 413)
  }
  if (session.receivedBytes + input.bytes.byteLength > session.size) {
    throw new AppUploadError('upload_size_mismatch', 'Upload exceeds its declared size', 409)
  }
  if (session.writing) throw new AppUploadError('upload_busy', 'Another upload chunk is still being written', 409)

  session.writing = true
  try {
    await appendFile(session.partPath, input.bytes)
    session.receivedBytes += input.bytes.byteLength
    refreshExpiry(session)
    return {
      id: session.id,
      nextOffset: session.receivedBytes,
      done: session.receivedBytes === session.size,
    }
  } finally {
    session.writing = false
  }
}

export async function completeAppUpload(input: {
  id: string
  owner: string
  profile: string
}): Promise<AppUploadResult> {
  const session = ownedSession(input.id, input.owner, input.profile)
  if (session.writing) throw new AppUploadError('upload_busy', 'An upload chunk is still being written', 409)
  if (session.receivedBytes !== session.size) {
    throw new AppUploadError('upload_incomplete', `Upload is incomplete (${session.receivedBytes}/${session.size})`, 409)
  }
  const info = await stat(session.partPath)
  if (!info.isFile() || info.size !== session.size) {
    await discardSession(session)
    throw new AppUploadError('upload_size_mismatch', 'Stored upload size does not match the declaration', 409)
  }
  await rename(session.partPath, session.savedPath)
  forgetSession(session)
  return { name: session.name, path: session.savedPath }
}

export async function abortAppUpload(input: { id: string; owner: string; profile: string }): Promise<void> {
  const session = ownedSession(input.id, input.owner, input.profile)
  await discardSession(session)
}

function ownedSession(idInput: unknown, owner: string, profile: string): AppUploadSession {
  const id = String(idInput || '').trim()
  const session = sessions.get(id)
  if (!session) throw new AppUploadError('upload_not_found', 'Upload session was not found', 404)
  if (session.owner !== owner || session.profile !== profile) {
    throw new AppUploadError('upload_forbidden', 'Upload session does not belong to this user and profile', 403)
  }
  return session
}

function safeDisplayName(value: unknown): string {
  const name = basename(String(value || '').replace(/\0/g, '')).trim().slice(0, 255)
  if (!name || name === '.' || name === '..') throw new AppUploadError('invalid_upload_name', 'Invalid upload name')
  return name
}

function safeExtension(name: string): string {
  const extension = extname(name).toLowerCase()
  return /^\.[a-z0-9]{1,16}$/.test(extension) ? extension : ''
}

function refreshExpiry(session: AppUploadSession): void {
  clearTimeout(session.timer)
  session.timer = expiryTimer(session)
}

function expiryTimer(session: AppUploadSession): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => {
    if (sessions.get(session.id) !== session) return
    void discardSession(session)
  }, APP_UPLOAD_SESSION_TTL_MS)
  timer.unref()
  return timer
}

function forgetSession(session: AppUploadSession): void {
  clearTimeout(session.timer)
  if (sessions.get(session.id) === session) sessions.delete(session.id)
}

async function discardSession(session: AppUploadSession): Promise<void> {
  forgetSession(session)
  await rm(session.partPath, { force: true }).catch(() => undefined)
}
