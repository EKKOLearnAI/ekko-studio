import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * Portable (green) mode: an `ekko-portable.json` file next to the executable
 * redirects every writable root onto the drive that holds the app, so the whole
 * install can live on removable media and stay self-contained.
 */
export const PORTABLE_MARKER = 'ekko-portable.json'

/** Set once portable mode is active; also read by the desktop guards. */
export const PORTABLE_ROOT_ENV = 'EKKO_STUDIO_PORTABLE_ROOT'

export interface PortableLayout {
  root: string
  dataRoot: string
  webUiHome: string
  hermesHome: string
  runtimeDir: string
  userData: string
}

export function resolvePortableLayout(
  execPath: string,
  exists: (path: string) => boolean = existsSync,
): PortableLayout | null {
  if (!execPath) return null
  const root = resolve(dirname(execPath))
  if (!exists(join(root, PORTABLE_MARKER))) return null

  const dataRoot = join(root, 'ekko-data')
  return {
    root,
    dataRoot,
    webUiHome: join(dataRoot, 'studio'),
    hermesHome: join(dataRoot, 'hermes'),
    runtimeDir: join(dataRoot, 'desktop-runtime'),
    userData: join(dataRoot, 'electron'),
  }
}

/**
 * Child processes (Studio server, Hermes bridge, MCP CLI) inherit `process.env`,
 * so setting these before anything spawns is enough to relocate them too.
 */
export function applyPortableEnv(layout: PortableLayout, env: NodeJS.ProcessEnv = process.env): void {
  env[PORTABLE_ROOT_ENV] = layout.root
  env.HERMES_WEB_UI_HOME = layout.webUiHome
  env.HERMES_WEBUI_STATE_DIR = layout.webUiHome
  env.HERMES_HOME = layout.hermesHome
  env.HERMES_DESKTOP_RUNTIME_DIR = layout.runtimeDir
}

export function isPortableMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[PORTABLE_ROOT_ENV]?.trim())
}
