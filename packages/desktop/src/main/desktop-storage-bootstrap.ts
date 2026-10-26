// Must be the first main-entry import: modules such as electron-updater may
// initialize Electron networking during evaluation. Changing sessionData later
// does not expand the already-created macOS network process sandbox grant.
import { app } from 'electron'
import { mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

export function configureEarlyDesktopStorage(
  host: Pick<typeof app, 'setPath'>,
  env: NodeJS.ProcessEnv,
  userHome: string,
): void {
  if (env.EKKO_STUDIO_DEVICE_INSTANCE && env.EKKO_STUDIO_INSTANCE_USER_DATA) {
    mkdirSync(env.EKKO_STUDIO_INSTANCE_USER_DATA, { recursive: true, mode: 0o700 })
    host.setPath('userData', env.EKKO_STUDIO_INSTANCE_USER_DATA)
  }
  // Match webUiHome without importing paths/remote-server (those import other
  // Desktop modules). Preserve the legacy local default Session for normal users.
  const root = resolve(env.HERMES_WEB_UI_HOME?.trim() || resolve(userHome, '.hermes-web-ui'))
  let savedRemote = false
  try {
    const value = JSON.parse(readFileSync(resolve(root, 'desktop-remote-server.json'), 'utf8')).serverUrl
    savedRemote = typeof value === 'string' && /^https?:\/\//i.test(value)
  } catch { /* no saved remote selection */ }
  if (env.EKKO_STUDIO_DEVICE_INSTANCE || env.EKKO_STUDIO_DESKTOP_SERVER_URL?.trim() || savedRemote) {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    host.setPath('sessionData', root)
  }
}

configureEarlyDesktopStorage(app, process.env, homedir())
