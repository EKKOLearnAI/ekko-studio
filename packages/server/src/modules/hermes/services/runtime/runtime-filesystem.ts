import { renameSync, rmSync } from 'fs'

const WINDOWS_FS_MAX_RETRIES = 8
const WINDOWS_FS_RETRY_DELAY_MS = 200

export function removeRuntimePath(target: string): void {
  // Runtime trees are large enough that Defender and indexers can briefly
  // retain handles after extraction or shutdown. Node only retries rm when
  // maxRetries is explicitly set, including for Windows permission_denied.
  rmSync(target, {
    recursive: true,
    force: true,
    maxRetries: process.platform === 'win32' ? WINDOWS_FS_MAX_RETRIES : 0,
    retryDelay: process.platform === 'win32' ? WINDOWS_FS_RETRY_DELAY_MS : 100,
  })
}

export function cleanupRuntimePath(target: string): void {
  try {
    removeRuntimePath(target)
  } catch (err) {
    // Cleanup must not replace the extraction or installation error that led
    // us here; a later run uses a unique temporary path and can proceed.
    console.warn(`[runtime] failed to clean up ${target}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function isRetryableWindowsFilesystemError(err: unknown): boolean {
  if (process.platform !== 'win32' || !err || typeof err !== 'object') return false
  const code = String((err as NodeJS.ErrnoException).code || '')
  return code === 'EACCES' || code === 'EBUSY' || code === 'ENOTEMPTY' || code === 'EPERM'
}

function waitForFilesystemRetry(attempt: number): Promise<void> {
  return new Promise(resolvePromise => {
    setTimeout(resolvePromise, attempt * WINDOWS_FS_RETRY_DELAY_MS)
  })
}

export async function renameRuntimePath(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(source, destination)
      return
    } catch (err) {
      if (attempt >= WINDOWS_FS_MAX_RETRIES || !isRetryableWindowsFilesystemError(err)) throw err
      await waitForFilesystemRetry(attempt + 1)
    }
  }
}
