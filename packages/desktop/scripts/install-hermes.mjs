#!/usr/bin/env node
// Install the checked-out Hermes Agent source into python/venv and prepare its
// bundled browser and frontend assets. The Git checkout remains clean and is
// retained so the upstream `hermes update` command can update it in place.
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, resolve, dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { platform as osPlatform, arch as osArch, homedir as osHomedir, tmpdir } from 'node:os'
import { hermesSource } from './runtime-config.mjs'
import { venvPythonPath } from './python-runtime-layout.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const TARGET_OS = process.env.TARGET_OS || osPlatform()
const TARGET_ARCH = process.env.TARGET_ARCH || osArch()
const HERMES_VERSION = hermesSource().version
// Install the upstream-curated desktop set plus every messaging adapter exposed
// by Studio. Matrix is included from the lockfile, but python-olm is pruned:
// it has no portable Windows/macOS build and plaintext Matrix works without it.
const HERMES_EXTRAS = splitPackageList(
  process.env.HERMES_EXTRAS || [
    'all',
    'messaging',
    'slack',
    'matrix',
    'wecom',
    'dingtalk',
    'feishu',
  ].join(','),
)
const BROWSER_PACKAGES = splitPackageList(
  process.env.HERMES_BROWSER_PACKAGES || 'agent-browser@^0.26.0 @askjo/camofox-browser@^1.5.2',
)
const CHROME_FOR_TESTING_VERSION = (
  process.env.HERMES_CHROME_FOR_TESTING_VERSION
  || process.env.HERMES_WINDOWS_CHROME_FOR_TESTING_VERSION
  || '149.0.7827.55'
).trim()
const SKIP_BROWSER_RUNTIME = process.env.HERMES_SKIP_BROWSER_RUNTIME === '1'
  || process.env.HERMES_SKIP_BROWSER_RUNTIME?.toLowerCase() === 'true'
const SKIP_HERMES_FRONTENDS = process.env.HERMES_SKIP_FRONTEND_BUILD === '1'
  || process.env.HERMES_SKIP_FRONTEND_BUILD?.toLowerCase() === 'true'

const OS_LABEL = TARGET_OS === 'win32' ? 'win' : TARGET_OS === 'darwin' ? 'mac' : TARGET_OS
const PY_DIR = resolve(ROOT, 'resources', 'python', `${OS_LABEL}-${TARGET_ARCH}`)
const VENV_DIR = resolve(PY_DIR, 'venv')
const NODE_DIR = resolve(ROOT, 'resources', 'node', `${OS_LABEL}-${TARGET_ARCH}`)
const NODE_PREFIX = resolve(PY_DIR, 'node')
const AGENT_BROWSER_HOME = resolve(PY_DIR, 'agent-browser')
const PLAYWRIGHT_BROWSERS_PATH = resolve(PY_DIR, 'ms-playwright')

const pyBin = venvPythonPath(VENV_DIR, TARGET_OS)

if (!existsSync(pyBin)) {
  console.error(`Python not found at ${pyBin}. Run: npm run fetch:python`)
  process.exit(1)
}
if (!existsSync(resolve(PY_DIR, '.git')) || !existsSync(resolve(PY_DIR, 'pyproject.toml'))) {
  console.error(`Hermes source checkout not found at ${PY_DIR}. Run: npm run fetch:hermes`)
  process.exit(1)
}

function hasUv() {
  const r = spawnSync('uv', ['--version'], { stdio: 'ignore' })
  return r.status === 0
}

function splitPackageList(value) {
  return value
    .split(/[,\s]+/)
    .map(part => part.trim())
    .filter(Boolean)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.status !== 0) process.exit(result.status ?? 1)
  return result
}

function optionalRun(command, args, options = {}) {
  return spawnSync(command, args, { stdio: 'inherit', ...options })
}

function commandInvocation(command) {
  if (TARGET_OS === 'win32' && command.toLowerCase().endsWith('.cmd')) {
    const cmdCommand = /[\s&()[\]{}^=;!'+,`~]/.test(command) ? `"${command}"` : command
    return { command: 'cmd.exe', argsPrefix: ['/d', '/s', '/c', cmdCommand] }
  }
  return { command, argsPrefix: [] }
}

function runInvocation(invocation, args, options = {}) {
  return run(invocation.command, [...invocation.argsPrefix, ...args], options)
}

function optionalRunInvocation(invocation, args, options = {}) {
  return optionalRun(invocation.command, [...invocation.argsPrefix, ...args], options)
}

function pythonBuildEnv() {
  if (TARGET_OS !== 'darwin') return process.env

  const env = { ...process.env }
  if (!env.AR && existsSync('/usr/bin/ar')) env.AR = '/usr/bin/ar'
  if (!env.RANLIB && existsSync('/usr/bin/ranlib')) env.RANLIB = '/usr/bin/ranlib'
  return env
}

function installHermesPythonRuntime() {
  if (!hasUv()) {
    console.error('uv is required to install the hash-locked Hermes source runtime')
    process.exit(1)
  }

  const tempRoot = mkdtempSync(join(tmpdir(), 'hermes-python-lock-'))
  const requirementsPath = join(tempRoot, 'requirements.txt')
  const env = pythonBuildEnv()

  try {
    console.log(`→ Exporting locked Hermes dependencies: ${HERMES_EXTRAS.join(', ')}`)
    const exportArgs = [
      'export',
      '--project', PY_DIR,
      '--locked',
      '--no-dev',
      '--no-emit-project',
      '--quiet',
      '--format', 'requirements.txt',
      '--prune', 'python-olm',
      '--output-file', requirementsPath,
    ]
    for (const extra of HERMES_EXTRAS) exportArgs.push('--extra', extra)
    run('uv', exportArgs, { cwd: PY_DIR, env })

    console.log('→ Installing hash-verified Hermes dependencies into bundled Python')
    run('uv', [
      'pip', 'install',
      '--python', pyBin,
      // The exported requirements already contain the locked versions and hashes.
      // Do not let uv rediscover upstream pyproject overrides and re-resolve them.
      '--no-config',
      '--require-hashes',
      '--no-deps',
      '--requirement', requirementsPath,
    ], { cwd: PY_DIR, env })

    console.log('→ Installing Hermes source as a relocatable editable project')
    run('uv', [
      'pip', 'install',
      '--python', pyBin,
      '--no-deps',
      '--editable', PY_DIR,
      '--config-setting', 'editable_mode=compat',
    ], { cwd: PY_DIR, env })
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }

  makeEditableInstallRelocatable()
}

function npmCommand() {
  const bundled = TARGET_OS === 'win32'
    ? resolve(NODE_DIR, 'npm.cmd')
    : resolve(NODE_DIR, 'bin', 'npm')
  const candidates = TARGET_OS === 'win32'
    ? [bundled, 'npm.cmd', 'npm.exe', 'npm']
    : [bundled, 'npm']
  for (const candidate of candidates) {
    if (candidate === bundled && !existsSync(candidate)) continue
    const invocation = commandInvocation(candidate)
    const result = optionalRunInvocation(invocation, ['--version'], { stdio: 'ignore', env: browserRuntimeEnv(false) })
    if (result.status === 0) return invocation
  }
  return null
}

function agentBrowserCommand() {
  if (TARGET_OS === 'win32') {
    return resolve(NODE_PREFIX, 'agent-browser.cmd')
  }
  return resolve(NODE_PREFIX, 'bin', 'agent-browser')
}

function browserRuntimeEnv(includeAgentBrowser = true) {
  const bundledNodeBin = TARGET_OS === 'win32'
    ? NODE_DIR
    : resolve(NODE_DIR, 'bin')
  const nodePath = TARGET_OS === 'win32'
    ? NODE_PREFIX
    : resolve(NODE_PREFIX, 'bin')
  const inheritedPath = process.env.PATH || process.env.Path || ''
  const pathKey = TARGET_OS === 'win32' ? 'Path' : 'PATH'
  const browserExecutable = includeAgentBrowser ? ensureBundledBrowserExecutable() : null
  const pathEntries = includeAgentBrowser
    ? [nodePath, bundledNodeBin, inheritedPath]
    : [bundledNodeBin, inheritedPath]
  const env = {
    ...process.env,
    [pathKey]: pathEntries.filter(Boolean).join(TARGET_OS === 'win32' ? ';' : ':'),
    HERMES_AGENT_NODE: TARGET_OS === 'win32' ? resolve(NODE_DIR, 'node.exe') : resolve(NODE_DIR, 'bin', 'node'),
    HERMES_AGENT_NODE_ROOT: NODE_DIR,
    AGENT_BROWSER_HOME,
    PLAYWRIGHT_BROWSERS_PATH,
  }
  if (browserExecutable) env.AGENT_BROWSER_EXECUTABLE_PATH = browserExecutable
  return env
}

function bundledBrowserExecutableNames() {
  if (TARGET_OS === 'win32') return new Set(['chrome.exe'])
  if (TARGET_OS === 'darwin') return new Set(['Google Chrome for Testing', 'Google Chrome', 'Chromium', 'chrome'])
  return new Set(['chrome', 'chromium', 'chromium-browser'])
}

function defaultAgentBrowserHomes() {
  const candidates = [
    process.env.USERPROFILE,
    process.env.UserProfile,
    process.env.HOME,
    process.env.HOMEDRIVE && process.env.HOMEPATH
      ? `${process.env.HOMEDRIVE}${process.env.HOMEPATH}`
      : null,
    osHomedir(),
  ]
  return Array.from(new Set(
    candidates
      .map(home => home?.trim())
      .filter(Boolean)
      .map(home => resolve(home, '.agent-browser')),
  ))
}

function findBrowserInstallInHome(home) {
  const names = bundledBrowserExecutableNames()
  const browsersDir = join(home, 'browsers')
  const bundleDirs = []

  if (existsSync(browsersDir)) {
    try {
      for (const entry of readdirSync(browsersDir, { withFileTypes: true })) {
        if (entry.isDirectory()) bundleDirs.push(join(browsersDir, entry.name))
      }
    } catch {}
  }

  for (const bundleDir of bundleDirs) {
    const executable = findBrowserExecutableUnder(bundleDir, names)
    if (executable) return { executable, bundleDir }
  }

  return null
}

function findBrowserExecutableUnder(root, names) {
  const stack = [root].filter(existsSync)
  const visited = new Set()

  while (stack.length > 0) {
    const dir = stack.pop()
    if (!dir || visited.has(dir)) continue
    visited.add(dir)

    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isFile() && names.has(entry.name)) return path
      if (entry.isDirectory()) stack.push(path)
    }
  }

  return null
}

function findBundledBrowserExecutable() {
  return findBrowserInstallInHome(AGENT_BROWSER_HOME)?.executable ?? null
}

function shouldPinChromeForTesting() {
  if (!CHROME_FOR_TESTING_VERSION) return false
  return !['0', 'false', 'off', 'auto'].includes(CHROME_FOR_TESTING_VERSION.toLowerCase())
}

function chromeForTestingPlatform() {
  if (TARGET_OS === 'win32' && TARGET_ARCH === 'x64') return 'win64'
  if (TARGET_OS === 'darwin' && TARGET_ARCH === 'arm64') return 'mac-arm64'
  if (TARGET_OS === 'darwin' && TARGET_ARCH === 'x64') return 'mac-x64'
  if (TARGET_OS === 'linux' && TARGET_ARCH === 'x64') return 'linux64'
  throw new Error(`Pinned Chrome for Testing is not configured for ${TARGET_OS}-${TARGET_ARCH}`)
}

function chromeForTestingUrl() {
  if (process.env.HERMES_CHROME_FOR_TESTING_URL?.trim()) {
    return process.env.HERMES_CHROME_FOR_TESTING_URL.trim()
  }
  if (process.env.HERMES_WINDOWS_CHROME_FOR_TESTING_URL?.trim()) {
    return process.env.HERMES_WINDOWS_CHROME_FOR_TESTING_URL.trim()
  }
  const platform = chromeForTestingPlatform()
  return `https://storage.googleapis.com/chrome-for-testing-public/${CHROME_FOR_TESTING_VERSION}/${platform}/chrome-${platform}.zip`
}

function removeChromeBundles() {
  const browsersDir = join(AGENT_BROWSER_HOME, 'browsers')
  if (!existsSync(browsersDir)) return

  for (const entry of readdirSync(browsersDir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith('chrome-')) {
      rmSync(join(browsersDir, entry.name), { recursive: true, force: true })
    }
  }
}

function extractChromeForTestingArchive(url, zipPath, extractDir) {
  run(pyBin, [
    '-c',
    [
      'import sys',
      'import urllib.request',
      'import zipfile',
      'url, zip_path, extract_dir = sys.argv[1:4]',
      'urllib.request.urlretrieve(url, zip_path)',
      'if sys.platform == "win32":',
      '    with zipfile.ZipFile(zip_path) as archive:',
      '        archive.extractall(extract_dir)',
    ].join('\n'),
    url,
    zipPath,
    extractDir,
  ])
  if (TARGET_OS !== 'win32') {
    // zipfile.extractall drops Unix executable modes and symbolic links.
    // Chrome's executable and framework layout must survive relocation.
    run('unzip', ['-q', zipPath, '-d', extractDir])
  }
}

function extractedChromeBundleDir(extractDir) {
  const entries = readdirSync(extractDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('chrome-'))
    .map(entry => join(extractDir, entry.name))
  if (entries.length === 0) return null
  return entries[0]
}

function pinChromeForTestingBundle() {
  if (!shouldPinChromeForTesting()) return

  const targetBrowsersDir = join(AGENT_BROWSER_HOME, 'browsers')
  const targetBundleDir = join(targetBrowsersDir, `chrome-${CHROME_FOR_TESTING_VERSION}`)
  const tmpRoot = mkdtempSync(join(tmpdir(), 'hermes-cft-'))
  const zipPath = join(tmpRoot, 'chrome.zip')
  const extractDir = join(tmpRoot, 'extract')
  const url = chromeForTestingUrl()

  try {
    console.log(`→ Pinning Chrome for Testing ${CHROME_FOR_TESTING_VERSION} for ${TARGET_OS}-${TARGET_ARCH}`)
    mkdirSync(extractDir, { recursive: true })
    extractChromeForTestingArchive(url, zipPath, extractDir)

    const bundleDir = extractedChromeBundleDir(extractDir)
    const executable = bundleDir ? findBrowserExecutableUnder(bundleDir, bundledBrowserExecutableNames()) : null
    if (!executable) {
      console.error(`Pinned Chrome for Testing archive did not contain a browser executable: ${url}`)
      process.exit(1)
    }

    removeChromeBundles()
    mkdirSync(targetBrowsersDir, { recursive: true })
    cpSync(bundleDir, targetBundleDir, { recursive: true, force: true, verbatimSymlinks: true })
    console.log(`✓ pinned Chrome for Testing at ${targetBundleDir}`)
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
}

function ensureBundledBrowserExecutable() {
  const bundled = findBrowserInstallInHome(AGENT_BROWSER_HOME)
  if (bundled) return bundled.executable

  const searchedHomes = []
  for (const fallbackHome of defaultAgentBrowserHomes()) {
    if (fallbackHome === AGENT_BROWSER_HOME) continue
    searchedHomes.push(fallbackHome)

    const fallback = findBrowserInstallInHome(fallbackHome)
    if (!fallback) continue

    const targetBrowsersDir = join(AGENT_BROWSER_HOME, 'browsers')
    const targetBundleDir = join(targetBrowsersDir, basename(fallback.bundleDir))
    mkdirSync(targetBrowsersDir, { recursive: true })
    cpSync(fallback.bundleDir, targetBundleDir, { recursive: true, force: true, verbatimSymlinks: true })
    console.log(`✓ copied Chrome bundle into ${targetBundleDir}`)

    return findBundledBrowserExecutable()
  }

  if (searchedHomes.length > 0) {
    console.warn(`! no Chrome bundle found in fallback agent-browser homes: ${searchedHomes.join(', ')}`)
  }
  return null
}

function sitePackagesDir() {
  if (TARGET_OS === 'win32') {
    return resolve(VENV_DIR, 'Lib', 'site-packages')
  }
  const libDir = resolve(VENV_DIR, 'lib')
  const py = readdirSync(libDir).find(n => /^python\d+\.\d+$/.test(n))
  if (!py) throw new Error(`Could not locate pythonX.Y under ${libDir}`)
  return resolve(libDir, py, 'site-packages')
}

function makeEditableInstallRelocatable() {
  const sitePkgs = sitePackagesDir()
  const editablePths = readdirSync(sitePkgs)
    .filter(name => /^__editable__\.hermes_agent-.*\.pth$/.test(name))
  if (editablePths.length !== 1) {
    console.error(`Expected one Hermes compat editable .pth in ${sitePkgs}, found ${editablePths.length}`)
    process.exit(1)
  }

  const relativeSource = relative(sitePkgs, PY_DIR).split(sep).join('/')
  writeFileSync(join(sitePkgs, editablePths[0]), `${relativeSource}\n`)

  for (const name of readdirSync(sitePkgs)) {
    if (!/^hermes_agent-.*\.dist-info$/.test(name)) continue
    rmSync(join(sitePkgs, name, 'direct_url.json'), { force: true })
  }
  console.log(`✓ editable Hermes path is relocatable (${relativeSource})`)
}

function installBrowserRuntime() {
  if (SKIP_BROWSER_RUNTIME) {
    console.warn('! Skipping bundled browser runtime because HERMES_SKIP_BROWSER_RUNTIME is set')
    return
  }
  if (BROWSER_PACKAGES.length === 0) {
    console.warn('! Skipping bundled browser runtime because HERMES_BROWSER_PACKAGES is empty')
    return
  }

  const npm = npmCommand()
  if (!npm) {
    console.error('npm not found; bundled browser runtime requires Node.js/npm')
    process.exit(1)
  }

  console.log(`→ Installing browser runtime via npm prefix ${NODE_PREFIX}`)
  runInvocation(npm, [
    'install',
    '-g',
    '--prefix',
    NODE_PREFIX,
    '--silent',
    '--ignore-scripts',
    ...BROWSER_PACKAGES,
  ])

  const ab = agentBrowserCommand()
  if (!existsSync(ab)) {
    console.error(`agent-browser binary not found at ${ab} after npm install`)
    process.exit(1)
  }

  console.log(`→ Installing Chromium for bundled agent-browser at ${AGENT_BROWSER_HOME}`)
  runInvocation(commandInvocation(ab), ['install'], { env: browserRuntimeEnv() })
  pinChromeForTestingBundle()

  const browserExecutable = ensureBundledBrowserExecutable()
  if (!browserExecutable) {
    console.error(`Bundled Chrome executable not found under ${AGENT_BROWSER_HOME} after agent-browser install`)
    process.exit(1)
  }
  console.log(`✓ bundled Chrome executable available at ${browserExecutable}`)
  if (TARGET_OS !== 'win32') {
    // File-existence checks alone also accept a non-executable Chrome binary.
    run(browserExecutable, ['--version'])
  }
}

function buildHermesFrontends() {
  if (SKIP_HERMES_FRONTENDS) {
    console.warn('! Skipping Hermes TUI/dashboard build because HERMES_SKIP_FRONTEND_BUILD is set')
    return
  }

  const npm = npmCommand()
  if (!npm) {
    console.error('npm not found; Hermes TUI/dashboard build requires bundled Node.js/npm')
    process.exit(1)
  }
  const env = browserRuntimeEnv(false)
  console.log('→ Installing Hermes TUI/dashboard workspace dependencies')
  runInvocation(npm, [
    'ci',
    '--no-audit',
    '--no-fund',
    '--progress=false',
    '--workspace', 'ui-tui',
    '--workspace', 'web',
  ], { cwd: PY_DIR, env })
  console.log('→ Building Hermes TUI')
  runInvocation(npm, ['run', 'build', '--workspace', 'ui-tui'], { cwd: PY_DIR, env })
  console.log('→ Building Hermes dashboard')
  runInvocation(npm, ['run', 'build', '--workspace', 'web'], { cwd: PY_DIR, env })

  for (const required of [
    resolve(PY_DIR, 'ui-tui', 'dist', 'entry.js'),
    resolve(PY_DIR, 'hermes_cli', 'web_dist', 'index.html'),
  ]) {
    if (!existsSync(required)) {
      console.error(`Hermes frontend build output not found: ${required}`)
      process.exit(1)
    }
  }
}

installHermesPythonRuntime()
installBrowserRuntime()
buildHermesFrontends()

run(pyBin, [
  '-c',
  [
    'import importlib.metadata as metadata',
    'import importlib.util',
    'import mcp',
    'import tools.mcp_tool as t',
    `assert metadata.version("hermes-agent") == ${JSON.stringify(HERMES_VERSION)}`,
    'assert t._MCP_AVAILABLE',
    'assert importlib.util.find_spec("websockets") is not None',
  ].join('; '),
])

const hermesBin = TARGET_OS === 'win32'
  ? resolve(VENV_DIR, 'Scripts', 'hermes.cmd')
  : resolve(VENV_DIR, 'bin', 'hermes')
const hermesCheckCommand = TARGET_OS === 'win32' ? pyBin : hermesBin
const hermesCheckArgs = TARGET_OS === 'win32' ? ['-m', 'hermes_cli.main', '--version'] : ['--version']

// Relocate: replace the pip-generated launcher (which embeds an absolute
// shebang to the build-time Python path) with a relative wrapper so the
// bundled venv works after being moved into the .app/.exe payload.
if (TARGET_OS === 'win32') {
  // Windows: uv/pip .exe launchers can embed build-machine paths. Replace the
  // Hermes entry points with relocatable .cmd wrappers and remove the .exe
  // trampolines so PATHEXT lookups cannot pick a stale launcher first.
  const wrappers = [
    ['hermes', 'hermes_cli.main'],
    ['hermes-agent', 'run_agent'],
    ['hermes-acp', 'acp_adapter.entry'],
  ]
  for (const [name, mod] of wrappers) {
    const cmdPath = resolve(VENV_DIR, 'Scripts', `${name}.cmd`)
    writeFileSync(
      cmdPath,
      [
        '@echo off',
        'set "PY=%~dp0python.exe"',
        'set "VIRTUAL_ENV=%~dp0.."',
        'set "UV_PROJECT_ENVIRONMENT=%VIRTUAL_ENV%"',
        'set "UV_PYTHON=%PY%"',
        `"%PY%" -m ${mod} %*`,
      ].join('\r\n'),
    )
    rmSync(resolve(VENV_DIR, 'Scripts', `${name}.exe`), { force: true })
  }
} else {
  const launcher = [
    '#!/bin/sh',
    'DIR="$(cd "$(dirname "$0")" && pwd)"',
    'VIRTUAL_ENV="$(cd "$DIR/.." && pwd)"',
    'export VIRTUAL_ENV',
    'export UV_PROJECT_ENVIRONMENT="$VIRTUAL_ENV"',
    'export UV_PYTHON="$DIR/python3"',
    'export UV_SYSTEM_PYTHON=1',
    'exec "$DIR/python3" -m hermes_cli.main "$@"',
    '',
  ].join('\n')
  writeFileSync(hermesBin, launcher, { mode: 0o755 })
  chmodSync(hermesBin, 0o755)
  // Same for hermes-agent / hermes-acp (they all just dispatch into modules)
  for (const [name, mod] of [
    ['hermes-agent', 'run_agent'],
    ['hermes-acp', 'acp_adapter.entry'],
  ]) {
    const p = resolve(VENV_DIR, 'bin', name)
    if (existsSync(p)) {
      writeFileSync(p, launcher.replace('hermes_cli.main', mod), { mode: 0o755 })
      chmodSync(p, 0o755)
    }
  }
}

console.log(`✓ hermes installed at ${hermesBin} (relocatable launcher)`)

if (!existsSync(hermesBin)) {
  console.error(`hermes binary not found at ${hermesBin} after install`)
  process.exit(1)
}

run(hermesCheckCommand, hermesCheckArgs)

{
  const status = spawnSync('git', ['status', '--porcelain'], {
    cwd: PY_DIR,
    encoding: 'utf-8',
  })
  if (status.status !== 0 || status.stdout.trim()) {
    process.stderr.write(status.stderr || '')
    console.error(`Hermes source checkout is dirty after runtime preparation:\n${status.stdout.trim()}`)
    process.exit(status.status || 1)
  }
}

if (!SKIP_BROWSER_RUNTIME) {
  run(pyBin, [
    '-c',
    [
      'import importlib, importlib.util, os, shutil',
      `os.environ["PLAYWRIGHT_BROWSERS_PATH"] = ${JSON.stringify(PLAYWRIGHT_BROWSERS_PATH)}`,
      // Hermes 0.21.3 moved browser installation checks into a separate module.
      'module = "tools.browser_tool_install" if importlib.util.find_spec("tools.browser_tool_install") else "tools.browser_tool"',
      '_chromium_installed = importlib.import_module(module)._chromium_installed',
      'assert shutil.which("agent-browser") is not None',
      'assert _chromium_installed()',
    ].join('; '),
  ], { env: browserRuntimeEnv() })
}

if (SKIP_BROWSER_RUNTIME) {
  console.log('✓ hermes Python, MCP, and websockets checks passed; browser runtime skipped')
} else {
  console.log('✓ hermes Python, MCP, websockets, agent-browser, and Chromium checks passed')
}
