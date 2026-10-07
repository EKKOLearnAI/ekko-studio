import type { App } from 'electron'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

type LoginItemApp = Pick<App, 'isPackaged' | 'getLoginItemSettings' | 'setLoginItemSettings'>

interface LoginItemOptions {
  platform?: NodeJS.Platform
  homeDir?: string
  env?: NodeJS.ProcessEnv
  executablePath?: string
}

const AUTOSTART_FILENAME = 'com.hermeswebui.studio.desktop'
const MANAGED_KEY = 'X-Ekko-Studio-Autostart'

function autostartPath(options: LoginItemOptions): string {
  const configHome = (options.env ?? process.env).XDG_CONFIG_HOME
  const configDir = configHome && isAbsolute(configHome)
    ? configHome
    : join(options.homeDir ?? homedir(), '.config')
  return join(configDir, 'autostart', AUTOSTART_FILENAME)
}

function readAutostartEntry(options: LoginItemOptions) {
  let contents: string
  try {
    contents = readFileSync(autostartPath(options), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }

  const lines = contents.split(/\r?\n/)
  const keys = new Map<string, string>()
  let inDesktopEntry = false
  let execLine = -1
  lines.forEach((rawLine, index) => {
    const line = rawLine.trim()
    if (line.startsWith('[')) {
      inDesktopEntry = line === '[Desktop Entry]'
    } else if (inDesktopEntry && !line.startsWith('#')) {
      const separator = line.indexOf('=')
      if (separator < 0) return
      const key = line.slice(0, separator).trim()
      keys.set(key, line.slice(separator + 1).trim())
      if (key === 'Exec') execLine = index
    }
  })
  return { lines, keys, execLine }
}

function isEnabled(entry: ReturnType<typeof readAutostartEntry>): boolean {
  return !!entry && entry.keys.get('Type') === 'Application'
    && !!entry.keys.get('Exec')
    && entry.keys.get('Hidden') !== 'true'
    && entry.keys.get('X-GNOME-Autostart-enabled') !== 'false'
}

function linuxExec(options: LoginItemOptions): string {
  const executable = (options.env ?? process.env).APPIMAGE || options.executablePath || process.execPath
  if (!isAbsolute(executable) || /[\0\r\n=]/.test(executable)) {
    throw new Error('The login item requires an absolute executable path without line breaks or an equals sign.')
  }
  // Exec quoting is followed by desktop-entry string escaping, not shell quoting.
  // https://specifications.freedesktop.org/desktop-entry/latest/exec-variables.html
  const quoted = executable.replace(/(["`$\\])/g, '\\$1').replace(/%/g, '%%')
  return `"${quoted.replace(/\\/g, '\\\\').replace(/\t/g, '\\t')}" --hidden`
}

function writeAutostartEntry(options: LoginItemOptions, contents: string): void {
  const path = autostartPath(options)
  mkdirSync(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(temporaryPath, contents, { mode: 0o644 })
    renameSync(temporaryPath, path)
  } finally {
    rmSync(temporaryPath, { force: true })
  }
}

function nativeOptions(options: LoginItemOptions) {
  return { path: options.executablePath ?? process.execPath, args: ['--hidden'] }
}

export function getOpenAtLogin(app: LoginItemApp, options: LoginItemOptions = {}): boolean {
  if ((options.platform ?? process.platform) === 'linux') {
    return isEnabled(readAutostartEntry(options))
  }
  return app.getLoginItemSettings(nativeOptions(options)).openAtLogin
}

export function setOpenAtLogin(app: LoginItemApp, openAtLogin: boolean, options: LoginItemOptions = {}): void {
  if ((options.platform ?? process.platform) !== 'linux') {
    app.setLoginItemSettings({ ...nativeOptions(options), openAtLogin, openAsHidden: true })
    return
  }
  if (!openAtLogin) {
    rmSync(autostartPath(options), { force: true })
    return
  }
  if (!app.isPackaged) throw new Error('Login items require a packaged Linux application.')
  const command = linuxExec(options)
  writeAutostartEntry(options, [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Ekko Studio',
    `Exec=${command}`,
    'Terminal=false',
    'StartupNotify=false',
    'X-GNOME-Autostart-enabled=true',
    `${MANAGED_KEY}=true`,
    '',
  ].join('\n'))
}

// AppImage updates may change the filename. Refresh only our enabled entry,
// preserving desktop settings and entries disabled outside the application.
export function refreshLinuxLoginItem(app: LoginItemApp, options: LoginItemOptions = {}): boolean {
  if ((options.platform ?? process.platform) !== 'linux' || !app.isPackaged) return false
  const entry = readAutostartEntry(options)
  if (!entry || !isEnabled(entry) || entry.keys.get(MANAGED_KEY) !== 'true') return false
  const command = linuxExec(options)
  if (entry.keys.get('Exec') === command) return false
  entry.lines[entry.execLine] = `Exec=${command}`
  writeAutostartEntry(options, entry.lines.join('\n'))
  return true
}
