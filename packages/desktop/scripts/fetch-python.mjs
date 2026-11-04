#!/usr/bin/env node
// Download python-build-standalone for the current (or target) platform/arch.
// Windows wraps the standalone interpreter in a real PEP 405 venv so upstream
// `hermes update` can target it through VIRTUAL_ENV without Studio-only flags.
// The base interpreter stays embedded at python/base. Windows requires an
// absolute pyvenv.cfg home, so packaging and extraction rebase it whenever the
// complete environment moves.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { tmpdir, platform as osPlatform, arch as osArch } from 'node:os'
import {
  bundledBaseHomePath,
  bundledBasePythonPath,
  configWithPythonHome,
  venvPythonPath,
} from './python-runtime-layout.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

// Pin a known-good python-build-standalone release. Bump intentionally.
const PBS_TAG = process.env.PBS_TAG || '20260510'
const PYTHON_VERSION = process.env.PBS_PY || '3.12.13'

const TARGET_OS = process.env.TARGET_OS || osPlatform() // darwin | win32 | linux
const TARGET_ARCH = process.env.TARGET_ARCH || osArch() // arm64 | x64

const TRIPLE_MAP = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
}

const key = `${TARGET_OS}-${TARGET_ARCH}`
const triple = TRIPLE_MAP[key]
if (!triple) {
  console.error(`Unsupported target: ${key}`)
  process.exit(1)
}

// electron-builder uses `mac`/`win`/`linux` for `${os}` — match that
const OS_LABEL = TARGET_OS === 'win32' ? 'win' : TARGET_OS === 'darwin' ? 'mac' : TARGET_OS
const OUT_DIR = resolve(ROOT, 'resources', 'python', `${OS_LABEL}-${TARGET_ARCH}`)
const VENV_DIR = resolve(OUT_DIR, 'venv')
const WINDOWS_BASE_STAGING_DIR = resolve(OUT_DIR, '.python-base-staging')
const FLAVOR = 'install_only_stripped'
const FILE = `cpython-${PYTHON_VERSION}+${PBS_TAG}-${triple}-${FLAVOR}.tar.gz`
const PBS_BASE_URL = (process.env.PBS_BASE_URL || 'https://github.com/astral-sh/python-build-standalone/releases/download').replace(/\/$/, '')
const URL = `${PBS_BASE_URL}/${PBS_TAG}/${FILE}`

const preparedPython = venvPythonPath(VENV_DIR, TARGET_OS)
const preparedBasePython = bundledBasePythonPath(OUT_DIR, TARGET_OS)
if (existsSync(preparedPython) && (TARGET_OS !== 'win32' || existsSync(preparedBasePython))) {
  console.log(`✓ Python already present at ${VENV_DIR}, skipping`)
  process.exit(0)
}

mkdirSync(OUT_DIR, { recursive: true })

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.status !== 0) process.exit(result.status ?? 1)
  return result
}

function createRelocatableWindowsVenv(baseStagingDir) {
  const basePython = resolve(baseStagingDir, 'python.exe')
  if (!existsSync(basePython)) {
    console.error(`Windows Python base interpreter not found at ${basePython}`)
    process.exit(1)
  }

  run('uv', [
    'venv',
    VENV_DIR,
    '--python', basePython,
    '--relocatable',
    '--no-project',
  ])

  const bundledBaseDir = resolve(OUT_DIR, 'base')
  rmSync(bundledBaseDir, { recursive: true, force: true })
  renameSync(baseStagingDir, bundledBaseDir)

  const pyvenvConfig = resolve(VENV_DIR, 'pyvenv.cfg')
  writeFileSync(
    pyvenvConfig,
    configWithPythonHome(
      readFileSync(pyvenvConfig, 'utf-8'),
      bundledBaseHomePath(OUT_DIR, TARGET_OS),
    ),
  )

  const python = venvPythonPath(VENV_DIR, TARGET_OS)
  const expectedBase = bundledBasePythonPath(OUT_DIR, TARGET_OS)
  run(python, [
    '-c',
    [
      'from pathlib import Path',
      'import sys',
      `expected = Path(${JSON.stringify(expectedBase)}).resolve().parent`,
      'actual = Path(sys.base_prefix).resolve()',
      'assert sys.prefix != sys.base_prefix, (sys.prefix, sys.base_prefix)',
      'assert actual == expected, (actual, expected)',
    ].join('; '),
  ])
}

if (TARGET_OS === 'win32' && existsSync(resolve(VENV_DIR, 'python.exe'))) {
  console.log('→ Rebuilding the legacy standalone Windows Python directory as a standard venv')
  rmSync(VENV_DIR, { recursive: true, force: true })
}

// Migrate the previous runtime layout in place. Generated Python contents move
// under venv/, while browser assets stay at the source root.
if (existsSync(resolve(OUT_DIR, 'python.exe')) || existsSync(resolve(OUT_DIR, 'bin', 'python3'))) {
  const migrationTarget = TARGET_OS === 'win32' ? WINDOWS_BASE_STAGING_DIR : VENV_DIR
  console.log(`→ Migrating legacy Python layout into ${migrationTarget}`)
  rmSync(migrationTarget, { recursive: true, force: true })
  mkdirSync(migrationTarget, { recursive: true })
  const keepAtSourceRoot = new Set(['base', 'venv', '.git', 'agent-browser', 'node', 'ms-playwright'])
  for (const entry of readdirSync(OUT_DIR, { withFileTypes: true })) {
    if (keepAtSourceRoot.has(entry.name) || entry.name === '.python-base-staging') continue
    renameSync(join(OUT_DIR, entry.name), join(migrationTarget, entry.name))
  }
  if (TARGET_OS === 'win32') {
    createRelocatableWindowsVenv(migrationTarget)
  }
  console.log(`✓ Python ready at ${VENV_DIR}`)
  process.exit(0)
}

const extractionDir = TARGET_OS === 'win32' ? WINDOWS_BASE_STAGING_DIR : VENV_DIR
rmSync(extractionDir, { recursive: true, force: true })
mkdirSync(extractionDir, { recursive: true })
const tarPath = resolve(tmpdir(), FILE)

console.log(`→ Fetching ${URL}`)
const curl = spawnSync('curl', ['-fL', '--retry', '3', '-o', tarPath, URL], { stdio: 'inherit' })
if (curl.status !== 0) {
  console.error('curl failed')
  process.exit(curl.status ?? 1)
}

console.log(`→ Extracting into ${extractionDir}`)
// PBS tarballs unpack to a top-level "python/" directory; --strip-components=1 flattens it
const tar = spawnSync('tar', ['-xzf', tarPath, '-C', extractionDir, '--strip-components=1'], { stdio: 'inherit' })
if (tar.status !== 0) {
  console.error('tar failed')
  process.exit(tar.status ?? 1)
}

rmSync(tarPath, { force: true })
if (TARGET_OS === 'win32') {
  createRelocatableWindowsVenv(extractionDir)
}
console.log(`✓ Python ready at ${VENV_DIR}`)
