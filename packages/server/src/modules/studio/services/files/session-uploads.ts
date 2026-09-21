import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { getSession } from '../../repositories/session-store'
import { sessionUploadsStore } from '../../repositories/session-uploads-store'
import { getProfileUploadDir } from './upload-paths'

function attachmentPaths(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  return input.flatMap(block => block && ['file', 'image'].includes(block.type)
    && typeof block.path === 'string' ? [block.path] : [])
}

async function uploadedFileRealPath(path: string, profile: string): Promise<string | null> {
  // Both upload transports generate flat random names. Never grant a directory,
  // partial upload, arbitrary profile file, or an alias into another session.
  const root = getProfileUploadDir(profile)
  if (!isAbsolute(path) || dirname(path) !== root || !/^(?:[a-f0-9]{16}|[a-f0-9]{24})(?:\.[a-zA-Z0-9]{1,20})?$/.test(basename(path))) return null
  const info = await lstat(path).catch(() => null)
  if (!info?.isFile() || info.isSymbolicLink()) return null
  const [actual, actualRoot] = await Promise.all([realpath(path).catch(() => ''), realpath(root).catch(() => '')])
  return actual && actualRoot && dirname(actual) === actualRoot ? actual : null
}

/** Call only for authenticated host input, never share-recipient packets. */
export async function recordSessionUploadAttachments(sessionId: string, profile: string, input: unknown): Promise<void> {
  const session = getSession(sessionId)
  if (!session || session.profile !== profile) return
  for (const path of new Set(attachmentPaths(input))) {
    const actual = await uploadedFileRealPath(path, profile)
    if (actual) sessionUploadsStore.record(sessionId, profile, resolve(path), actual)
  }
}

export async function isSessionUploadAttachment(sessionId: string, profile: string, path: string): Promise<boolean> {
  const actual = await uploadedFileRealPath(path, profile)
  if (!actual) return false
  const registered = sessionUploadsStore.find(sessionId, profile, path)
  if (registered) return registered === actual
  for (const content of sessionUploadsStore.legacyContents(sessionId)) {
    let blocks: unknown
    try { blocks = JSON.parse(content) } catch { continue }
    if (!attachmentPaths(blocks).includes(path)) continue
    sessionUploadsStore.record(sessionId, profile, path, actual)
    return true
  }
  return false
}
