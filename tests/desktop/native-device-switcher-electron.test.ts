import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildSync } from 'esbuild'
import { expect, it } from 'vitest'

const executable = process.env.EKKO_TEST_ELECTRON_EXECUTABLE || resolve(process.platform === 'win32' ? 'packages/desktop/node_modules/electron/dist/electron.exe' : 'packages/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
it.runIf(['darwin', 'win32'].includes(process.platform) && existsSync(executable))('keeps real native device controls usable with an old, offline or crashed remote page', async () => {
  const root = mkdtempSync(join(tmpdir(), 'studio-native-device-switcher-'))
  try {
    const entry = join(root, 'entry.ts')
    writeFileSync(entry, `export { NativeDeviceSwitcher } from ${JSON.stringify(resolve('packages/desktop/src/main/native-device-switcher.ts'))};export { DesktopRemoteDevices } from ${JSON.stringify(resolve('packages/desktop/src/main/remote-devices.ts'))};`)
    const bundle = join(root, 'main', 'native.cjs')
    buildSync({ entryPoints: [entry], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
    buildSync({ entryPoints: ['packages/desktop/src/preload/native-devices.ts'], outfile: join(root, 'preload', 'native-devices.js'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('HERMES_') && !key.startsWith('EKKO_') && !key.startsWith('ELECTRON_') && !['AUTH_TOKEN', 'PORT', 'NODE_OPTIONS'].includes(key)))
    const child = spawn(executable, [resolve('tests/fixtures/native-device-switcher.cjs'), root, bundle], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', data => { output += data });child.stderr.on('data', data => { output += data })
    const timer = setTimeout(() => child.kill('SIGKILL'), 55000)
    try {
      const code = await new Promise<number | null>((resolveExit, reject) => { child.once('error', reject);child.once('close', resolveExit) })
      const result = join(root, 'result.json')
      expect(code, existsSync(result) ? readFileSync(result, 'utf8') : output).toBe(0)
      expect(JSON.parse(readFileSync(result, 'utf8'))).toMatchObject({ ok: true, oldPage: true, offline: true, crash: true, localManager: true, deniedForeignIpc: true, layoutGap: 8, returnedLocal: true, clickedToolbar: true, liveTheme: true, hiddenSplash: true, compactMenu: true, themedConfirmation: true, progressFeedback: true, retryAndCancel: true, liveLocale: true, allTwelveLanguages: true, rtlLayout: true, offlineLocale: true })
    } finally { clearTimeout(timer);if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }
  } finally { rmSync(root, { recursive: true, force: true }) }
}, 60000)
