import type { LoginItemSettings } from 'electron'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getOpenAtLogin, refreshLinuxLoginItem, setOpenAtLogin } from '../../packages/desktop/src/main/login-item-settings'

const temporaryHomes: string[] = []

afterEach(() => {
  for (const home of temporaryHomes) rmSync(home, { recursive: true, force: true })
  temporaryHomes.length = 0
})

function fixture() {
  const homeDir = mkdtempSync(join(tmpdir(), 'ekko-login-item-'))
  temporaryHomes.push(homeDir)
  const path = join(homeDir, '.config', 'autostart', 'com.hermeswebui.studio.desktop')
  const options = { platform: 'linux' as const, homeDir, env: {}, executablePath: '/opt/Ekko Studio/hermes-studio' }
  const app = {
    isPackaged: true,
    getLoginItemSettings: vi.fn(() => { throw new Error('Unsupported Electron API on Linux') }),
    setLoginItemSettings: vi.fn(() => { throw new Error('Unsupported Electron API on Linux') }),
  }
  return { app, options, path }
}

describe('Linux login items', () => {
  it('persists enablement across application restarts and removes only its own entry on disable', () => {
    const { app, options, path } = fixture()
    expect(getOpenAtLogin(app, options)).toBe(false)
    setOpenAtLogin(app, true, options)
    expect(getOpenAtLogin(app, options)).toBe(true)
    expect(getOpenAtLogin(fixture().app, options)).toBe(true)
    const otherApp = join(dirname(path), 'other.desktop')
    writeFileSync(otherApp, 'other application')
    setOpenAtLogin(app, false, options)
    setOpenAtLogin(app, false, options)
    expect(getOpenAtLogin(app, options)).toBe(false)
    expect(existsSync(path)).toBe(false)
    expect(readFileSync(otherApp, 'utf8')).toBe('other application')
    expect(app.getLoginItemSettings).not.toHaveBeenCalled()
    expect(app.setLoginItemSettings).not.toHaveBeenCalled()
  })

  it('launches the installed deb executable with the existing hidden-start argument', () => {
    const { app, options, path } = fixture()
    setOpenAtLogin(app, true, options)
    const content = readFileSync(path, 'utf8')
    expect(content).toContain('Type=Application\nName=Ekko Studio\n')
    expect(content).toContain('Exec="/opt/Ekko Studio/hermes-studio" --hidden\n')
    expect(content).toContain('Terminal=false\n')
  })

  it('uses the original AppImage rather than its temporary mounted executable', () => {
    const { app, options, path } = fixture()
    options.env = { APPIMAGE: '/home/user/应用/Ekko Studio-0.7.31.AppImage' }
    options.executablePath = '/tmp/.mount_Ekko123/hermes-studio'
    setOpenAtLogin(app, true, options)
    const content = readFileSync(path, 'utf8')
    expect(content).toContain('Exec="/home/user/应用/Ekko Studio-0.7.31.AppImage" --hidden\n')
    expect(content).not.toContain('.mount_')
  })

  it('writes and reads the configured XDG directory and ignores relative XDG paths', () => {
    const { app, options, path } = fixture()
    const configHome = join(options.homeDir, 'custom configuration')
    options.env = { XDG_CONFIG_HOME: configHome }
    setOpenAtLogin(app, true, options)
    expect(getOpenAtLogin(app, options)).toBe(true)
    expect(existsSync(join(configHome, 'autostart', 'com.hermeswebui.studio.desktop'))).toBe(true)
    expect(existsSync(path)).toBe(false)
    setOpenAtLogin(app, false, options)
    expect(getOpenAtLogin(app, options)).toBe(false)
    options.env = { XDG_CONFIG_HOME: 'relative/config' }
    setOpenAtLogin(app, true, options)
    expect(existsSync(path)).toBe(true)
  })

  it.each(['Hidden=true', 'X-GNOME-Autostart-enabled=false'])('honors external disablement using %s', flag => {
    const { app, options, path } = fixture()
    setOpenAtLogin(app, true, options)
    const contents = readFileSync(path, 'utf8').replace('X-GNOME-Autostart-enabled=true\n', '')
    writeFileSync(path, `${contents}${flag}\n`)
    expect(getOpenAtLogin(app, options)).toBe(false)
    options.env = { APPIMAGE: '/home/user/new.AppImage' }
    expect(refreshLinuxLoginItem(app, options)).toBe(false)
    expect(readFileSync(path, 'utf8')).toContain(flag)
    setOpenAtLogin(app, true, options)
    expect(getOpenAtLogin(app, options)).toBe(true)
  })

  it('reads only desktop entry settings, including CRLF and comments', () => {
    const { app, options, path } = fixture()
    setOpenAtLogin(app, true, options)
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll('\n', '\r\n')
      + '# Hidden=true\r\n[Desktop Action Other]\r\nHidden=true\r\nExec=other\r\n')
    expect(getOpenAtLogin(app, options)).toBe(true)
  })

  it.each(['[Desktop Entry]\nHidden=false\n', '[Desktop Entry]\nType=Link\nExec=other\n'])('does not report incomplete or non-application entries as enabled', contents => {
    const { app, options, path } = fixture()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents)
    expect(getOpenAtLogin(app, options)).toBe(false)
  })

  it('escapes desktop entry field codes, quotes, dollars, backslashes and backticks in executable paths', () => {
    const { app, options, path } = fixture()
    options.env = { APPIMAGE: '/home/user/Ekko 100% "quoted" $cash \\ `tick`.AppImage' }
    setOpenAtLogin(app, true, options)
    expect(readFileSync(path, 'utf8')).toContain(String.raw`Exec="/home/user/Ekko 100%% \\"quoted\\" \\$cash \\\\ `
      + '\\\\`tick\\\\`.AppImage" --hidden\n')
  })

  it.skipIf(process.platform !== 'linux' || spawnSync('gio', ['version'], { stdio: 'ignore' }).status !== 0)(
    'launches the saved entry through the Linux desktop launcher with the exact executable and arguments', async () => {
      const { app, options, path } = fixture()
      const executable = join(options.homeDir, '应用 Ekko 100% %f "quoted" $cash \\ `tick`.AppImage')
      const outputPath = join(options.homeDir, 'launched-args')
      writeFileSync(executable, '#!/bin/sh\nprintf "%s\\n" "$@" > "$EKKO_AUTOSTART_TEST_OUTPUT"\n', { mode: 0o755 })
      options.env = { APPIMAGE: executable }
      setOpenAtLogin(app, true, options)
      execFileSync('gio', ['launch', path], {
        env: { ...process.env, EKKO_AUTOSTART_TEST_OUTPUT: outputPath },
        timeout: 5000,
      })
      await vi.waitFor(() => expect(readFileSync(outputPath, 'utf8')).toBe('--hidden\n'))
    },
  )

  it('surfaces filesystem failures instead of claiming the setting was saved', () => {
    const { app, options } = fixture()
    const configHome = join(options.homeDir, 'blocked')
    writeFileSync(configHome, 'a file, not a directory')
    options.env = { XDG_CONFIG_HOME: configHome }
    expect(() => setOpenAtLogin(app, true, options)).toThrow()
    expect(() => getOpenAtLogin(app, options)).toThrow()
    expect(readFileSync(configHome, 'utf8')).toBe('a file, not a directory')
  })

  it('does not register the development Electron executable', () => {
    const { app, options, path } = fixture()
    app.isPackaged = false
    expect(() => setOpenAtLogin(app, true, options)).toThrow('packaged')
    expect(refreshLinuxLoginItem(app, options)).toBe(false)
    expect(existsSync(path)).toBe(false)
  })

  it.each(['relative.AppImage', '/home/user/bad\nHidden=false.AppImage'])('rejects unsafe launch paths without replacing the existing entry: %j', executable => {
    const { app, options, path } = fixture()
    setOpenAtLogin(app, true, options)
    const saved = readFileSync(path, 'utf8')
    options.env = { APPIMAGE: executable }
    expect(() => setOpenAtLogin(app, true, options)).toThrow('absolute executable path')
    expect(readFileSync(path, 'utf8')).toBe(saved)
  })

  it('refreshes the enabled AppImage path after an update without altering other desktop settings', () => {
    const { app, options, path } = fixture()
    expect(refreshLinuxLoginItem(app, options)).toBe(false)
    setOpenAtLogin(app, true, options)
    expect(refreshLinuxLoginItem(app, options)).toBe(false)
    writeFileSync(path, readFileSync(path, 'utf8') + 'X-Custom-Setting=keep\n[Desktop Action Other]\nExec=other\n')
    options.env = { APPIMAGE: '/home/user/Ekko Studio-0.7.32.AppImage' }
    expect(refreshLinuxLoginItem(app, options)).toBe(true)
    const contents = readFileSync(path, 'utf8')
    expect(contents).toContain('Exec="/home/user/Ekko Studio-0.7.32.AppImage" --hidden\n')
    expect(contents).toContain('X-Custom-Setting=keep\n[Desktop Action Other]\nExec=other\n')
    expect(refreshLinuxLoginItem(app, options)).toBe(false)
  })

  it('does not replace an externally created entry on startup', () => {
    const { app, options, path } = fixture()
    setOpenAtLogin(app, true, options)
    const contents = readFileSync(path, 'utf8').replace('X-Ekko-Studio-Autostart=true\n', '')
    writeFileSync(path, contents)
    options.env = { APPIMAGE: '/home/user/new.AppImage' }
    expect(refreshLinuxLoginItem(app, options)).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(contents)
  })
})

describe('native login items', () => {
  it.each(['darwin', 'win32'] as const)('preserves the existing Electron API behavior on %s', platform => {
    const { options, path } = fixture()
    const settings = { openAtLogin: false } as LoginItemSettings
    const app = {
      isPackaged: true,
      getLoginItemSettings: vi.fn(() => settings),
      setLoginItemSettings: vi.fn((next: { openAtLogin?: boolean }) => { settings.openAtLogin = !!next.openAtLogin }),
    }
    const native = { ...options, platform, executablePath: '/installed/Ekko Studio' }
    expect(getOpenAtLogin(app, native)).toBe(false)
    setOpenAtLogin(app, true, native)
    expect(getOpenAtLogin(app, native)).toBe(true)
    expect(app.getLoginItemSettings).toHaveBeenLastCalledWith({ path: native.executablePath, args: ['--hidden'] })
    expect(app.setLoginItemSettings).toHaveBeenLastCalledWith({ path: native.executablePath, args: ['--hidden'], openAtLogin: true, openAsHidden: true })
    setOpenAtLogin(app, false, native)
    expect(getOpenAtLogin(app, native)).toBe(false)
    expect(refreshLinuxLoginItem(app, native)).toBe(false)
    expect(existsSync(path)).toBe(false)
  })
})
