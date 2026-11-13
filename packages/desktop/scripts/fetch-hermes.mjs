#!/usr/bin/env node
// Prepare a clean, shallow Hermes Agent Git checkout as the runtime's python/
// root. The checkout stays intact in the published runtime so `hermes update`
// can fetch source changes and update python/venv in place.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs'
import { arch as osArch, platform as osPlatform } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { hermesSource } from './runtime-config.mjs'
import { needsHermesInstallStamp } from './hermes-version.mjs'
import { venvPythonPath } from './python-runtime-layout.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const TARGET_OS = process.env.TARGET_OS || osPlatform()
const TARGET_ARCH = process.env.TARGET_ARCH || osArch()
const OS_LABEL = TARGET_OS === 'win32' ? 'win' : TARGET_OS === 'darwin' ? 'mac' : TARGET_OS
const SOURCE_DIR = resolve(ROOT, 'resources', 'python', `${OS_LABEL}-${TARGET_ARCH}`)
const VENV_DIR = resolve(SOURCE_DIR, 'venv')
const pyBin = venvPythonPath(VENV_DIR, TARGET_OS)
const source = hermesSource()

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: SOURCE_DIR,
    stdio: 'inherit',
    ...options,
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
  return result
}

function output(command, args) {
  const result = spawnSync(command, args, {
    cwd: SOURCE_DIR,
    encoding: 'utf-8',
  })
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || '')
    process.exit(result.status ?? 1)
  }
  return result.stdout.trim()
}

if (!existsSync(pyBin)) {
  console.error(`Bundled Python not found at ${pyBin}. Run: npm run fetch:python`)
  process.exit(1)
}

mkdirSync(SOURCE_DIR, { recursive: true })

if (!existsSync(resolve(SOURCE_DIR, '.git'))) {
  console.log(`→ Initializing Hermes source checkout in ${SOURCE_DIR}`)
  run('git', ['init'])
  run('git', ['remote', 'add', 'origin', source.repository])
} else {
  const origin = output('git', ['remote', 'get-url', 'origin'])
  if (origin !== source.repository) {
    console.error(`Hermes source origin mismatch: expected ${source.repository}, found ${origin}`)
    process.exit(1)
  }
}

console.log(`→ Fetching Hermes ${source.ref} (${source.commit.slice(0, 12)})`)
run('git', ['fetch', '--depth', '1', 'origin', source.ref])
// Release refs may be annotated tag objects. Always compare and check out the
// peeled commit, while still fetching the configured ref by name.
const fetchedCommit = output('git', ['rev-parse', 'FETCH_HEAD^{commit}']).toLowerCase()
if (fetchedCommit !== source.commit) {
  console.error(
    `Hermes source commit mismatch for ${source.ref}: expected ${source.commit}, fetched ${fetchedCommit}`,
  )
  process.exit(1)
}

// Keep a real main branch because the upstream updater defaults to `main`.
// It will create/update origin/main on its first `git fetch origin main`.
run('git', ['checkout', '-B', 'main', fetchedCommit])

const installedCommit = output('git', ['rev-parse', 'HEAD']).toLowerCase()
if (installedCommit !== source.commit) {
  console.error(`Hermes checkout verification failed: expected ${source.commit}, found ${installedCommit}`)
  process.exit(1)
}

const versionResult = spawnSync(pyBin, [
  '-c',
  [
    'import pathlib, tomllib',
    'data = tomllib.loads(pathlib.Path("pyproject.toml").read_text(encoding="utf-8"))',
    'print(data["project"]["version"])',
  ].join('; '),
], {
  cwd: SOURCE_DIR,
  encoding: 'utf-8',
})
if (versionResult.status !== 0) {
  process.stderr.write(versionResult.stderr || versionResult.stdout || '')
  process.exit(versionResult.status ?? 1)
}
const sourceVersion = versionResult.stdout.trim()
const stampWriter = resolve(SOURCE_DIR, 'scripts', 'write_install_stamp.py')
const needsStamp = needsHermesInstallStamp(sourceVersion, source, existsSync(stampWriter))

// These runtime-owned directories live inside the source root but must never
// make the checkout dirty or get swept into the updater's include-untracked
// autostash.
const excludePath = resolve(SOURCE_DIR, '.git', 'info', 'exclude')
const exclude = existsSync(excludePath) ? readFileSync(excludePath, 'utf-8') : ''
const runtimeExcludes = ['/base/', '/node/', '/ms-playwright/', '/install-stamp.json']
const missingExcludes = runtimeExcludes.filter(pattern => !exclude.split(/\r?\n/).includes(pattern))
if (missingExcludes.length > 0) {
  appendFileSync(excludePath, `${exclude.endsWith('\n') || !exclude ? '' : '\n'}${missingExcludes.join('\n')}\n`)
}

if (needsStamp) {
  run(pyBin, [
    stampWriter,
    '--output', resolve(SOURCE_DIR, 'install-stamp.json'),
    '--base-version', source.version,
    '--commit', source.commit,
    '--branch', 'main',
    '--distance', '0',
    '--source', 'git',
    '--update-mechanism', 'self',
  ])
}

const dirty = output('git', ['status', '--porcelain'])
if (dirty) {
  console.error(`Hermes source checkout is dirty after preparation:\n${dirty}`)
  process.exit(1)
}

console.log(`✓ Hermes source ready at ${SOURCE_DIR} (${source.version}, ${installedCommit.slice(0, 12)})`)
