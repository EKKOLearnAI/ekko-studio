/* Run with Electron on macOS; System Events must already have keyboard access. */
const { app, BrowserWindow, globalShortcut } = require('electron')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { ScreenshotShortcutManager } = require('../dist/main/screenshot-shortcut')

const run = promisify(execFile)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const output = process.argv.find(value => value.startsWith('--output='))?.slice('--output='.length)
const report = { date: new Date().toISOString(), platform: process.platform, arch: process.arch, electron: process.versions.electron, events: [], checks: [] }
let manager, window, root

function check(name, condition) {
  report.checks.push({ name, passed: !!condition })
  if (!condition) throw new Error(name)
}

async function press() {
  const expected = report.events.length + 1
  // Inject only after registration succeeds, so the key is consumed by this probe.
  await run('osascript', ['-e', 'tell application "System Events" to key code 1 using {control down, option down, shift down}'])
  const deadline = Date.now() + 3000
  while (report.events.length < expected && Date.now() < deadline) await pause(50)
}

app.whenReady().then(async () => {
  if (process.platform !== 'darwin') throw new Error('This automated shortcut probe requires macOS. Use the native acceptance checklist on Windows/Linux.')
  root = mkdtempSync(join(tmpdir(), 'studio-native-shortcut-'))
  const file = join(root, 'shortcut.json')
  const options = {
    file, shortcuts: globalShortcut,
    trigger: hideWindows => report.events.push({ hideWindows, focusedWindow: BrowserWindow.getFocusedWindow()?.id ?? null }),
    changed: () => {},
  }
  manager = new ScreenshotShortcutManager(options)
  manager.restore(true)
  check('default unset', !manager.getState().registered)
  check('register global binding', manager.save({ accelerator: 'Control+Alt+Shift+S', hideWindows: false }, true).registered)
  window = new BrowserWindow({ width: 320, height: 160, show: false })
  await window.loadURL('data:text/html,<title>Studio shortcut probe</title>')
  app.hide()
  await pause(300)
  check('probe app unfocused', BrowserWindow.getFocusedWindow() === null)
  await press()
  check('ordinary callback outside app', report.events.length === 1 && !report.events[0].hideWindows && report.events[0].focusedWindow === null)
  manager.setEditing('1:recorder', true)
  check('recorder releases owned binding', !globalShortcut.isRegistered('Control+Alt+Shift+S'))
  check('save hidden mode during recording', manager.save({ accelerator: 'Control+Alt+Shift+S', hideWindows: true }, true).error === '')
  check('save stays paused', !globalShortcut.isRegistered('Control+Alt+Shift+S'))
  manager.setEditing('1:recorder', false)
  check('close recorder restores binding', globalShortcut.isRegistered('Control+Alt+Shift+S'))
  await press()
  check('hidden callback outside app', report.events.length === 2 && report.events[1].hideWindows && report.events[1].focusedWindow === null)
  manager.dispose()
  manager = new ScreenshotShortcutManager(options)
  manager.restore(true)
  check('new manager restores saved binding', manager.getState().registered && manager.getState().hideWindows)
  await press()
  check('restored callback outside app', report.events.length === 3 && report.events[2].hideWindows)
  manager.save({ accelerator: '', hideWindows: false }, true)
  check('clear unregisters binding', !globalShortcut.isRegistered('Control+Alt+Shift+S'))
  check('clear persists', JSON.parse(readFileSync(file, 'utf8')).accelerator === '')
}).catch(error => {
  report.error = String(error.stack || error)
  process.exitCode = 1
}).finally(() => {
  manager?.dispose()
  window?.destroy()
  if (root) rmSync(root, { recursive: true, force: true })
  if (output) writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
  app.exit(process.exitCode || 0)
})
