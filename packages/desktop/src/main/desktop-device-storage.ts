import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { session, type Session } from 'electron'
import { normalizeRemoteServerUrl } from './remote-server'

export function desktopDeviceStoragePaths(home: string, remoteServerUrl: string | null): {
  sessionPath: string | null
  browserRoot: string
} {
  // Keep the existing local login, browser profiles and cookies in place.
  if (remoteServerUrl === null) return { sessionPath: null, browserRoot: join(home, 'desktop-browser') }
  const normalized = normalizeRemoteServerUrl(remoteServerUrl)
  if (!normalized) throw new Error('Invalid remote device storage URL')
  // Include protocol, port and base path. Web origins alone cannot separate
  // same-origin deployments, and cookies can cross ports on the same host.
  const key = createHash('sha256').update(normalized).digest('hex')
  const root = join(home, 'desktop-remote-devices', key)
  return { sessionPath: join(root, 'session'), browserRoot: join(root, 'browser') }
}

export function desktopWindowSession(home: string, remoteServerUrl: string | null): Session {
  const { sessionPath } = desktopDeviceStoragePaths(home, remoteServerUrl)
  if (!sessionPath) return session.defaultSession
  mkdirSync(sessionPath, { recursive: true, mode: 0o700 })
  return session.fromPath(sessionPath, { cache: true })
}
