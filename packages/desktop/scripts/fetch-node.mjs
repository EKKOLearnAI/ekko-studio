#!/usr/bin/env node
// Download a portable Node.js runtime for the current (or target) platform/arch
// and extract into resources/node/<os>-<arch>/.
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { arch as osArch, platform as osPlatform, tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { desktopNodeVersion } from './node-runtime-config.mjs'
import { checkPreparedRuntime } from './check-prepared-runtime.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const TARGET_OS = process.env.TARGET_OS || osPlatform()
const TARGET_ARCH = process.env.TARGET_ARCH || osArch()
const NODE_VERSION = desktopNodeVersion()

const OS_LABEL = TARGET_OS === 'win32' ? 'win' : TARGET_OS === 'darwin' ? 'mac' : TARGET_OS
const OUT_DIR = resolve(ROOT, 'resources', 'node', `${OS_LABEL}-${TARGET_ARCH}`)

const DIST_PLATFORM = TARGET_OS === 'win32' ? 'win' : TARGET_OS === 'darwin' ? 'darwin' : TARGET_OS
const DIST_ARCH = TARGET_ARCH === 'x64' ? 'x64' : TARGET_ARCH === 'arm64' ? 'arm64' : ''
if (!DIST_ARCH || !['win', 'darwin', 'linux'].includes(DIST_PLATFORM)) {
  console.error(`Unsupported target: ${TARGET_OS}-${TARGET_ARCH}`)
  process.exit(1)
}

const ext = TARGET_OS === 'win32' ? 'zip' : 'tar.gz'
const file = `node-v${NODE_VERSION}-${DIST_PLATFORM}-${DIST_ARCH}.${ext}`
const baseUrl = (process.env.NODE_DIST_BASE_URL || 'https://nodejs.org/dist').replace(/\/$/, '')
const url = `${baseUrl}/v${NODE_VERSION}/${file}`
const marker = TARGET_OS === 'win32' ? 'node.exe' : join('bin', 'node')

if (existsSync(resolve(OUT_DIR, marker))) {
  checkPreparedRuntime(resolve(OUT_DIR, marker), ['--version'], NODE_VERSION, 'Node.js')
  console.log(`Node.js already present at ${OUT_DIR}, skipping`)
  process.exit(0)
}

mkdirSync(OUT_DIR, { recursive: true })
const archivePath = resolve(tmpdir(), file)

console.log(`Fetching ${url}`)
const curl = spawnSync('curl', ['-fL', '--retry', '3', '-o', archivePath, url], { stdio: 'inherit' })
if (curl.status !== 0) {
  console.error('curl failed')
  process.exit(curl.status ?? 1)
}

console.log(`Extracting into ${OUT_DIR}`)
let extract
if (TARGET_OS === 'win32') {
  extract = spawnSync('tar', ['-xf', archivePath, '-C', OUT_DIR, '--strip-components=1'], { stdio: 'inherit' })
} else {
  extract = spawnSync('tar', ['-xzf', archivePath, '-C', OUT_DIR, '--strip-components=1'], { stdio: 'inherit' })
}
if (extract.status !== 0) {
  console.error('extract failed')
  process.exit(extract.status ?? 1)
}

rmSync(archivePath, { force: true })
console.log(`Node.js ready at ${OUT_DIR}`)
