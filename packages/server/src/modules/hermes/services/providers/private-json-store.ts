import { chmod, mkdir, open, readFile, rename, rm } from 'fs/promises'
import { dirname } from 'path'
import { randomUUID } from 'crypto'

/**
 * Atomic, private (0600) JSON writes for credential stores. Extracted from the
 * authorized-provider credential resolver so every OrcaRouter credential write
 * reuses the same tmp-write → fsync → rename → chmod sequence instead of
 * inventing a second store.
 */
export async function atomicWritePrivateJson(path: string, value: Record<string, any>): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.tmp.${process.pid}.${randomUUID()}`
  const handle = await open(temporaryPath, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf-8')
    await handle.sync()
    await handle.close()
    await rename(temporaryPath, path)
    await chmod(path, 0o600)
  } catch (err) {
    await handle.close().catch(() => undefined)
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw err
  }
}

export async function readPrivateJson(path: string): Promise<Record<string, any>> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (err: any) {
    if (err?.code === 'ENOENT') return {}
    throw err
  }
}
