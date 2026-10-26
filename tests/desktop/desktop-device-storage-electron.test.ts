import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildSync } from 'esbuild'
import { expect, it } from 'vitest'

const executable = process.env.EKKO_TEST_ELECTRON_EXECUTABLE || resolve('packages/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')

it.runIf(process.platform === 'darwin' && existsSync(executable))('isolates real Chromium storage per device and restores it after restarting Electron', async () => {
  const root = mkdtempSync(join(tmpdir(), 'studio-device-cache-'))
  try {
    const bundle = join(root, 'storage.cjs')
    buildSync({ entryPoints: ['packages/desktop/src/main/desktop-device-storage.ts'], outfile: bundle,
      bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
    buildSync({ entryPoints: ['packages/desktop/src/main/browser/browser-profile-store.ts'], outfile: join(root, 'browser-profiles.cjs'),
      bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
    for (const phase of ['write', 'restore']) {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('HERMES_')
        && !key.startsWith('EKKO_') && !key.startsWith('ELECTRON_') && !['AUTH_TOKEN', 'PORT', 'NODE_OPTIONS'].includes(key)))
      const child = spawn(executable, [resolve('tests/fixtures/desktop-device-storage.cjs'), root, bundle, phase], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      child.stdout.on('data', data => { output += data })
      child.stderr.on('data', data => { output += data })
      const timer = setTimeout(() => child.kill('SIGKILL'), 20000)
      try {
        const code = await new Promise<number | null>((resolveExit, reject) => {
          child.once('error', reject)
          child.once('close', resolveExit)
        })
        const evidence = join(root, 'result.json')
        expect(code, existsSync(evidence) ? readFileSync(evidence, 'utf8') : output).toBe(0)
      } finally {
        clearTimeout(timer)
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }
    }
    expect(JSON.parse(readFileSync(join(root, 'result.json'), 'utf8'))).toMatchObject({
      ok: true, sameOriginPaths: true, sameHostPorts: true, sharedDeviceWindows: true,
      localPreserved: true, httpCacheIsolated: true,
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 45000)
