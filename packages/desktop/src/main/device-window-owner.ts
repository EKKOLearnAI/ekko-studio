import { createHash } from 'node:crypto'
import { createConnection, createServer } from 'node:net'
import { chmodSync, mkdirSync, lstatSync, unlinkSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export function deviceWindowEndpoint(root: string, url: string | null): string {
  const key = createHash('sha256').update(JSON.stringify([root, url])).digest('hex').slice(0, 40)
  return process.platform === 'win32' ? `\\\\.\\pipe\\ekko-device-${key}` : join(process.platform === 'darwin' ? '/tmp' : tmpdir(), `ekko-device-${key}.sock`)
}
export async function focusDeviceWindow(endpoint: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection(endpoint)
    const timer = setTimeout(() => { socket.destroy();resolve(false) }, 1500)
    socket.on('error', () => { clearTimeout(timer);resolve(false) })
    socket.on('connect', () => socket.write('focus\n'))
    socket.on('data', data => { clearTimeout(timer);socket.destroy();resolve(String(data).trim() === 'ok') })
  })
}
/** Hold an OS-backed SQLite transaction for the owner lifetime. Every binder
 * uses the same guard, so recovery cannot unlink a newly bound live socket.
 * Crash/kill rolls back the transaction automatically, without stale directories.
 */
export async function ownDeviceWindow(endpoint: string, focus: () => void): Promise<null | (() => void)> {
  const locks = join(homedir(), '.ekko-desktop-owners')
  mkdirSync(locks, { recursive: true, mode: 0o700 })
  const lockPath = join(locks, createHash('sha256').update(endpoint).digest('hex') + '.sqlite')
  const db = new DatabaseSync(lockPath)
  db.exec('PRAGMA busy_timeout=100')
  let acquired = false
  try { db.exec('BEGIN EXCLUSIVE'); acquired = true } catch (error) {
    db.close()
    if (!/locked|busy/i.test(String(error))) throw error
    if (await focusDeviceWindow(endpoint)) return null
    // Owner may be between acquiring its lock and binding its endpoint.
    for (let retry = 0; retry < 10; retry++) {
      await new Promise(resolve => setTimeout(resolve, 100))
      if (await focusDeviceWindow(endpoint)) return null
    }
    throw new Error('Device window owner is starting or unavailable; retry')
  }
  let released = false
  const releaseLock = () => {
    if (released) return
    released = true
    if (acquired) db.exec('ROLLBACK')
    db.close()
  }
  const server = createServer(socket => {
    socket.setTimeout(1500, () => socket.destroy())
    socket.once('data', data => {
      if (String(data).trim() === 'focus') { focus();socket.end('ok\n') } else socket.destroy()
    })
  })
  try {
    if (process.platform !== 'win32') {
      let old
      try { old = lstatSync(endpoint) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
      if (old) {
        if (!old.isSocket() || (process.getuid && old.uid !== process.getuid())) throw new Error('Unexpected device socket owner')
        // This supports upgrading a previous candidate that had no SQLite guard.
        if (await focusDeviceWindow(endpoint)) { releaseLock(); return null }
        const refused = await new Promise<boolean>(resolve => {
          const probe = createConnection(endpoint)
          probe.once('connect', () => { probe.destroy();resolve(false) })
          probe.once('error', (e: NodeJS.ErrnoException) => resolve(e.code === 'ECONNREFUSED'))
          probe.setTimeout(1500, () => { probe.destroy();resolve(false) })
        })
        if (!refused) throw new Error('Existing device socket is unavailable')
        const current = lstatSync(endpoint)
        if (current.dev !== old.dev || current.ino !== old.ino) throw new Error('Device socket changed during recovery')
        unlinkSync(endpoint)
      }
    }
    await new Promise<void>((resolve, reject) => { server.once('error', reject);server.listen(endpoint, resolve) })
    if (process.platform !== 'win32') chmodSync(endpoint, 0o600)
    server.on('error', () => {})
    let closing = false
    return () => {
      if (closing) return
      closing = true
      server.close(releaseLock)
    }
  } catch (error) { server.close();releaseLock();throw error }
}
