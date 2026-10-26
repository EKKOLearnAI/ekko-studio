import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const DEVICE_INSTANCE_ENV = 'EKKO_STUDIO_DEVICE_INSTANCE'
/** An instance has its own single-instance lock, browser storage and Studio home. */
export function deviceInstanceLaunch(input: {
  home: string; userData: string; serverUrl: string | null; devices: unknown[];
  env: NodeJS.ProcessEnv; argv: string[]; packaged: boolean; id?: string;
}) {
  const root = input.env.EKKO_STUDIO_DEVICE_ROOT || input.home
  const browserRoot = input.env.EKKO_STUDIO_DEVICE_BROWSER_ROOT || input.userData
  const id = createHash('sha256').update(input.serverUrl || 'local').digest('hex').slice(0, 32)
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error('Invalid device instance ID')
  const home = join(root, 'device-instances', id)
  const userData = join(browserRoot, 'device-instances', id)
  const env: NodeJS.ProcessEnv = { ...input.env, EKKO_STUDIO_DEVICE_ROOT: root, EKKO_STUDIO_DEVICE_BROWSER_ROOT: browserRoot, [DEVICE_INSTANCE_ENV]: id,
    HERMES_WEB_UI_HOME: home, HERMES_WEBUI_STATE_DIR: home, HERMES_HOME: join(home, 'hermes'),
    EKKO_STUDIO_INSTANCE_USER_DATA: userData,
  }
  // Settings, not inherited environment, own the selected device after launch.
  for (const key of Object.keys(env)) {
    if (/(?:TOKEN|PASSWORD|SECRET|API_?KEY|AUTHORIZATION|COOKIE)/i.test(key)) delete env[key]
  }
  // Fixed device instances must always start on their identity target, even
  // if old instance settings were left pointing elsewhere.
  env.EKKO_STUDIO_DESKTOP_SERVER_URL = input.serverUrl || ''
  delete env.ELECTRON_RUN_AS_NODE
  delete env.HERMES_DESKTOP_PORT
  return { id, home, userData, env,
    args: input.packaged ? [] : [input.argv[1]!],
    settings: { serverUrl: input.serverUrl, devices: input.devices },
  }
}

export function prepareDeviceInstance(launch: ReturnType<typeof deviceInstanceLaunch>) {
  mkdirSync(launch.home, { recursive: true })
  mkdirSync(launch.userData, { recursive: true })
  const file = join(launch.home, 'desktop-remote-server.json')
  if (!existsSync(file)) {
    try { writeFileSync(file, JSON.stringify(launch.settings), { mode: 0o600, flag: 'wx' }) }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e }
  }
}
