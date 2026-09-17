#!/usr/bin/env node
import { spawn, execSync, execFileSync } from 'child_process'
import { resolve, dirname, join, delimiter } from 'path'
import { fileURLToPath } from 'url'
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, openSync, chmodSync, statSync, existsSync, realpathSync } from 'fs'
import { randomBytes, scryptSync } from 'crypto'
import { homedir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const __filename = fileURLToPath(import.meta.url)
const serverEntry = resolve(__dirname, '..', 'dist', 'server', 'index.js')
const pkgDir = resolve(__dirname, '..')
const pkg = JSON.parse(readFileSync(resolve(pkgDir, 'package.json'), 'utf-8'))
const VERSION = pkg.version
const PACKAGE_NAME = pkg.name
const CLI_NAME = PACKAGE_NAME === 'ekko-studio' ? 'ekko-studio-web' : 'hermes-web-ui'
const WEB_UI_HOME = process.env.HERMES_WEB_UI_HOME?.trim()
  ? resolve(process.env.HERMES_WEB_UI_HOME.trim())
  : resolve(homedir(), '.hermes-web-ui')
const PID_DIR = WEB_UI_HOME
const PID_FILE = join(PID_DIR, 'server.pid')
const LOG_FILE = join(PID_DIR, 'server.log')
const TOKEN_FILE = join(PID_DIR, '.token')
const LOGIN_LOCK_FILE = join(WEB_UI_HOME, '.login-lock.json')
const WEB_UI_DB_FILE = join(WEB_UI_HOME, 'hermes-web-ui.db')
const DEFAULT_PORT = 8648
const PREVIEW_BACKEND_PORT = 8650
const PREVIEW_FRONTEND_PORT = 8651
const PREVIEW_AGENT_BRIDGE_PORT = 18650
const DEFAULT_USERNAME = 'admin'
const DEFAULT_PASSWORD = '123456'
const DEFAULT_RESTART_GRACE_MS = 5000
const DEFAULT_STOP_GRACE_MS = 15000
const STOP_POLL_INTERVAL_MS = 500

function envPositiveInt(name) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : undefined
}

function shouldPreserveBridgeOnShutdown() {
  const raw = String(process.env.HERMES_AGENT_BRIDGE_STOP_ON_SHUTDOWN || '').trim().toLowerCase()
  return ['0', 'false', 'no', 'off'].includes(raw)
}

function getDaemonStopGraceMs(options = {}) {
  const { restart = false } = options
  if (restart && shouldPreserveBridgeOnShutdown()) {
    return envPositiveInt('HERMES_WEB_UI_RESTART_GRACE_MS') ?? DEFAULT_RESTART_GRACE_MS
  }
  if (restart) {
    return envPositiveInt('HERMES_WEB_UI_RESTART_GRACE_MS')
      ?? envPositiveInt('HERMES_WEB_UI_STOP_GRACE_MS')
      ?? DEFAULT_STOP_GRACE_MS
  }
  return envPositiveInt('HERMES_WEB_UI_STOP_GRACE_MS') ?? DEFAULT_STOP_GRACE_MS
}

// ─── Auto-fix node-pty native module ──────────────────────────
function ensureNativeModules() {
  const prebuildDir = join(pkgDir, 'node_modules', 'node-pty', 'prebuilds', `${process.platform}-${process.arch}`)
  const helper = join(prebuildDir, 'spawn-helper')
  try {
    chmodSync(helper, 0o755)
  } catch {}
}

function getToken() {
  try {
    return readFileSync(TOKEN_FILE, 'utf-8').trim()
  } catch {
    return null
  }
}

function ensureToken() {
  // If AUTH_TOKEN is set, let server handle it.
  if (process.env.AUTH_TOKEN) return process.env.AUTH_TOKEN

  let token = getToken()
  if (!token) {
    mkdirSync(dirname(TOKEN_FILE), { recursive: true })
    token = randomBytes(32).toString('hex')
    writeFileSync(TOKEN_FILE, token + '\n', { mode: 0o600 })
  }
  return token
}

function getNodeBinDir() {
  return dirname(process.execPath)
}

function getNpmBin() {
  return join(getNodeBinDir(), process.platform === 'win32' ? 'npm.cmd' : 'npm')
}

function getCurrentNodeEnv() {
  return {
    ...process.env,
    PATH: [getNodeBinDir(), process.env.PATH].filter(Boolean).join(delimiter),
    npm_node_execpath: process.execPath,
  }
}

function getGlobalCliScript() {
  // .cmd files cannot be executed directly by execFileSync on Windows.
  const npmCli = join(getNodeBinDir(), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const command = process.platform === 'win32' ? process.execPath : getNpmBin()
  const args = process.platform === 'win32' ? [npmCli, 'root', '-g'] : ['root', '-g']
  const root = execFileSync(command, args, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: getCurrentNodeEnv(),
  }).trim()
  // Resolve inside this package; a global command shim may belong to the other name.
  return join(root, PACKAGE_NAME, 'bin', 'hermes-web-ui.mjs')
}

function getWindowsShell() {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const candidates = [
    process.env.ComSpec,
    join(systemRoot, 'System32', 'cmd.exe'),
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  return 'cmd.exe'
}

function quoteForWindowsCommand(value) {
  return `"${value.replace(/"/g, '""')}"`
}

function spawnCli(command, args, options) {
  if (process.platform === 'win32') {
    const lowerCommand = String(command).toLowerCase()
    if (!lowerCommand.endsWith('.cmd') && !lowerCommand.endsWith('.bat')) {
      return spawn(command, args, options)
    }

    const commandLine = `${quoteForWindowsCommand(command)} ${args.map(arg => String(arg)).join(' ')}`
    return spawn(getWindowsShell(), ['/d', '/s', '/c', commandLine], options)
  }

  return spawn(command, args, options)
}

function getPortFromArgs() {
  if (process.argv[3] && !isNaN(process.argv[3])) return parseInt(process.argv[3])
  if (process.argv.includes('--port')) return parseInt(process.argv[process.argv.indexOf('--port') + 1])
  return null
}

function getRunningPort() {
  const pid = getPid()
  if (!pid || !isRunning(pid)) return null

  try {
    if (process.platform === 'win32') {
      const out = execSync(`netstat -aon -p tcp | findstr LISTENING | findstr " ${pid}$"`, { encoding: 'utf-8' }).trim()
      const line = out.split('\n').find(Boolean)
      const address = line?.trim().split(/\s+/)[1]
      const port = address?.split(':').pop()
      return port ? parseInt(port, 10) : null
    }

    const out = execSync(`lsof -Pan -p ${pid} -iTCP -sTCP:LISTEN`, { encoding: 'utf-8' }).trim()
    const lines = out.split('\n').slice(1)
    for (const line of lines) {
      const match = line.match(/:(\d+)\s+\(LISTEN\)$/)
      if (match) return parseInt(match[1], 10)
    }
  } catch {}

  return null
}

function getUpdatePort() {
  const argPort = getPortFromArgs()
  if (argPort !== null) return argPort

  const runningPort = getRunningPort()
  if (runningPort !== null) return runningPort

  if (process.env.PORT && !isNaN(process.env.PORT)) return parseInt(process.env.PORT)
  return DEFAULT_PORT
}

function getPort() {
  const argPort = getPortFromArgs()
  return argPort ?? DEFAULT_PORT
}

function shouldOpenBrowser(argv = process.argv) {
  return !argv.includes('--no-open')
}

function getRestartArgs(port, argv = process.argv) {
  const args = ['restart', '--port', String(port)]
  if (!shouldOpenBrowser(argv)) args.push('--no-open')
  return args
}

function enableClientMode() {
  process.env.HERMES_WEB_UI_DISABLE_GATEWAY_AUTOSTART = '1'
  process.env.CORS_ORIGINS = '*'
}

function commandExists(command) {
  try {
    if (process.platform === 'win32') {
      execFileSync('where', [command], { stdio: 'ignore', windowsHide: true })
    } else {
      execFileSync('sh', ['-c', `command -v "$1" >/dev/null 2>&1`, 'sh', command], { stdio: 'ignore' })
    }
    return true
  } catch {
    return false
  }
}

function parseUnixNetstatListeningPids(out, port) {
  const pids = []
  for (const line of out.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 6) continue

    const proto = parts[0]?.toLowerCase()
    if (!proto?.startsWith('tcp')) continue

    const localAddress = parts[3]
    const state = parts.find(part => part.toUpperCase() === 'LISTEN' || part.toUpperCase() === 'LISTENING')
    if (!state || !localAddress?.endsWith(`:${port}`)) continue

    const pidPart = parts.find(part => /^\d+\//.test(part))
    const pid = pidPart ? parseInt(pidPart.split('/')[0], 10) : NaN
    if (Number.isFinite(pid)) pids.push(pid)
  }
  return pids
}

function getListeningPids(port) {
  if (!port || isNaN(port)) return []
  const uniquePids = (pids) => [...new Set(pids.filter(pid => Number.isFinite(pid)))]

  try {
    if (process.platform === 'win32') {
      const out = execSync('netstat -aon -p tcp', { encoding: 'utf-8' })
      return uniquePids(out.split('\n')
        .map(line => line.trim())
        .filter(line => line.includes('LISTENING'))
        .map(line => line.split(/\s+/))
        .filter(parts => {
          const address = parts[1] || ''
          const listenPort = parseInt(address.split(':').pop(), 10)
          return listenPort === port
        })
        .map(parts => parseInt(parts[parts.length - 1], 10)))
    }
  } catch {
    return []
  }

  if (commandExists('ss')) {
    try {
      const out = execFileSync('ss', ['-ltnp', `sport = :${port}`], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
      const pids = uniquePids(out.split(/\r?\n/)
        .map(line => line.match(/pid=(\d+)/)?.[1])
        .map(pid => parseInt(pid || '', 10)))
      if (pids.length) return pids
    } catch {}
  }

  if (commandExists('lsof')) {
    try {
      const out = execFileSync('lsof', [`-tiTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      const pids = uniquePids(out.split(/\r?\n/).map(pid => parseInt(pid, 10)))
      if (pids.length) return pids
    } catch {}
  }

  if (commandExists('netstat')) {
    try {
      const out = execFileSync('netstat', ['-anp', 'tcp'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
      const pids = uniquePids(parseUnixNetstatListeningPids(out, port))
      if (pids.length) return pids
    } catch {}
  }

  return []
}

function killListeningPids(port, pids = getListeningPids(port)) {
  if (pids.length === 0) return

  console.log(`  ⚠ Port ${port} is in use by PID(s): ${pids.join(' ')}, killing...`)
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /F /PID ${pids.join(' /PID ')}`, { encoding: 'utf-8' })
    } else {
      execSync(`kill -9 ${pids.join(' ')}`, { encoding: 'utf-8' })
    }
  } catch {}
}

function stopPreviewRuntimeFromCli() {
  const previewPorts = [
    PREVIEW_BACKEND_PORT,
    PREVIEW_FRONTEND_PORT,
    ...(process.platform === 'win32' ? [PREVIEW_AGENT_BRIDGE_PORT] : []),
  ]
  const pids = [...new Set(previewPorts.flatMap(port => getListeningPids(port)))]
  if (!pids.length) return 0

  console.log(`  ⏹ Stopping preview runtime (PID(s): ${pids.join(' ')})...`)
  for (const pid of pids) {
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      } else {
        execSync(`kill -TERM -${pid}`, { stdio: 'ignore' })
      }
    } catch {
      try {
        if (process.platform === 'win32') {
          execFileSync('taskkill.exe', ['/PID', String(pid), '/F'], { stdio: 'ignore', windowsHide: true })
        } else {
          execSync(`kill -9 ${pid}`, { stdio: 'ignore' })
        }
      } catch {}
    }
  }

  return pids.length
}

function recoverPidFromPort() {
  const port = getPortFromArgs() ?? DEFAULT_PORT
  for (const pid of getListeningPids(port)) {
    if (isRunning(pid)) {
      mkdirSync(PID_DIR, { recursive: true })
      writePid(pid)
      return pid
    }
  }
  return null
}

function readPidFile() {
  try {
    const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim())
    return Number.isFinite(pid) ? pid : null
  } catch {}

  return null
}

function getPid() {
  const pid = readPidFile()
  if (pid) {
    if (isRunning(pid)) return pid
    removePid()
  }

  return recoverPidFromPort()
}

function isRunning(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

function writePid(pid) {
  writeFileSync(PID_FILE, String(pid))
}

function removePid() {
  try { unlinkSync(PID_FILE) } catch {}
}

function startDaemon(port) {
  const existing = getPid()
  if (existing && isRunning(existing)) {
    console.log(`  ✗ hermes-web-ui is already running (PID: ${existing})`)
    console.log(`    Use "hermes-web-ui stop" to stop it first`)
    process.exit(1)
  }
  removePid()

  // Check if port is already in use
  const occupied = getListeningPids(port)
  if (occupied.length) {
    killListeningPids(port, occupied)
    // Brief wait for port to be released
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
  }

  mkdirSync(PID_DIR, { recursive: true })

  ensureNativeModules()
  const token = ensureToken()

  // Rotate log if over 3MB — keep last 2000 lines
  const MAX_LOG_SIZE = 3 * 1024 * 1024
  const MAX_LOG_LINES = 2000
  try {
    const stat = statSync(LOG_FILE)
    if (stat.size > MAX_LOG_SIZE) {
      const content = readFileSync(LOG_FILE, 'utf-8')
      const lines = content.split('\n')
      const kept = lines.slice(-MAX_LOG_LINES)
      writeFileSync(LOG_FILE, kept.join('\n'), 'utf-8')
      console.log(`  ↻ Log rotated (${(stat.size / 1024 / 1024).toFixed(1)}MB → ${kept.length} lines)`)
    }
  } catch { }

  const logStream = openSync(LOG_FILE, 'a')
  const windowsShell = process.platform === 'win32' ? getWindowsShell() : null
  const serverEnv = { ...process.env, NODE_ENV: 'production', PORT: String(port), AUTH_TOKEN: token }
  if (windowsShell) {
    serverEnv.SHELL = serverEnv.SHELL?.trim() || windowsShell
    serverEnv.ComSpec = serverEnv.ComSpec?.trim() || windowsShell
  }
  const child = spawn(process.execPath, [serverEntry], {
    cwd: pkgDir,
    detached: true,
    stdio: ['ignore', logStream, logStream],
    env: serverEnv,
    windowsHide: true,
  })

  child.on('error', (err) => {
    console.error(`  ✗ Failed to start: ${err.message}`)
    removePid()
    process.exit(1)
  })

  child.unref()
  writePid(child.pid)

  // Poll health endpoint until server is ready (setTimeout to avoid overlapping requests)
  const healthUrl = `http://127.0.0.1:${port}/health`
  const maxWait = 30000
  const interval = 500
  let waited = 0

  console.log(`  ⏳ Starting hermes-web-ui (PID: ${child.pid}, port: ${port})...`)

  function poll() {
    waited += interval
    if (!isRunning(child.pid)) {
      console.log('  ✗ Failed to start hermes-web-ui')
      console.log(`    Check log: ${LOG_FILE}`)
      removePid()
      process.exit(1)
      return
    }

    fetch(healthUrl).then(res => {
      if (res.ok) {
        const listeningPid = recoverPidFromPort()
        if (listeningPid) {
          writePid(listeningPid)
        }
        const url = `http://localhost:${port}`
        console.log(`  ✓ hermes-web-ui started`)
        console.log(`    ${url}`)
        console.log(`    Log: ${LOG_FILE}`)
        if (shouldOpenBrowser()) {
          const isWin = process.platform === 'win32'
          const cmd = isWin ? `start ${url}` : process.platform === 'darwin' ? `open ${url}` : `xdg-open ${url}`
          try { execSync(cmd, { stdio: 'ignore' }) } catch {}
        }
      } else if (waited < maxWait) {
        setTimeout(poll, interval)
      } else {
        console.log(`  ⚠ Server process is running but health check failed after ${maxWait / 1000}s`)
        console.log(`    Check log: ${LOG_FILE}`)
        const url = `http://localhost:${port}`
        console.log(`    ${url}`)
      }
    }).catch(() => {
      if (waited < maxWait) {
        setTimeout(poll, interval)
      } else {
        console.log(`  ⚠ Server process is running but health check failed after ${maxWait / 1000}s`)
        console.log(`    Check log: ${LOG_FILE}`)
        const url = `http://localhost:${port}`
        console.log(`    ${url}`)
      }
    })
  }

  setTimeout(poll, interval)
}

function stopDaemon(options = {}) {
  const { restart = false } = options
  const stoppedPreviewPids = stopPreviewRuntimeFromCli()
  let pidFromFile = readPidFile()
  let cleanedStalePid = false
  if (pidFromFile && !isRunning(pidFromFile)) {
    removePid()
    console.log(`  ✓ hermes-web-ui was not running (cleaned stale PID: ${pidFromFile})`)
    pidFromFile = null
    cleanedStalePid = true
  }

  const pid = pidFromFile ?? recoverPidFromPort()
  if (!pid) {
    if (cleanedStalePid) return
    if (stoppedPreviewPids) {
      console.log(`  ✓ hermes-web-ui preview stopped`)
      return
    }
    console.log('  ✗ hermes-web-ui is not running')
    process.exit(1)
  }

  if (!isRunning(pid)) {
    removePid()
    console.log(`  ✓ hermes-web-ui was not running (cleaned stale PID)`)
    return
  }

  try {
    try {
      process.kill(pid, restart ? 'SIGUSR2' : 'SIGTERM')
      // Restart uses a shorter grace window than stop. By default the server
      // still shuts down the bridge; set HERMES_AGENT_BRIDGE_STOP_ON_SHUTDOWN=0
      // to keep the bridge across restarts.
      const graceMs = getDaemonStopGraceMs({ restart })
      const attempts = Math.max(1, Math.ceil(graceMs / STOP_POLL_INTERVAL_MS))
      for (let i = 0; i < attempts; i++) {
        if (!isRunning(pid)) break
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, STOP_POLL_INTERVAL_MS)
      }
    } catch {}
    // Force kill if still alive
    if (isRunning(pid)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch (err) {
        if (err?.code !== 'ESRCH') throw err
      }
    }
    removePid()
    console.log(`  ✓ hermes-web-ui stopped (PID: ${pid})`)
  } catch (err) {
    console.log(`  ✗ Failed to stop: ${err.message}`)
    process.exit(1)
  }
}

function showStatus() {
  const pid = getPid()
  if (pid && isRunning(pid)) {
    console.log(`  ✓ hermes-web-ui is running (PID: ${pid})`)
    console.log(`    PID file: ${PID_FILE}`)
  } else {
    if (pid) removePid()
    console.log('  ✗ hermes-web-ui is not running')
  }
}

function clearLoginLocks(options = {}) {
  const { silent = false, checkRunning = true } = options
  const serverRunning = checkRunning ? !!getPid() : false
  let removed = false

  try {
    unlinkSync(LOGIN_LOCK_FILE)
    removed = true
    if (!silent) console.log(`  ✓ Removed login lock file: ${LOGIN_LOCK_FILE}`)
  } catch (err) {
    if (err?.code === 'ENOENT') {
      if (!silent) console.log(`  ✓ No login lock file found: ${LOGIN_LOCK_FILE}`)
    } else {
      if (!silent) console.log(`  ✗ Failed to remove login lock file: ${err.message}`)
      throw err
    }
  }

  if (!silent && serverRunning) {
    console.log('  ⚠ hermes-web-ui is running; restart it to clear in-memory login locks.')
    console.log('    Run: hermes-web-ui restart')
  }

  return { path: LOGIN_LOCK_FILE, removed, serverRunning }
}

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, 64).toString('hex')
  return `scrypt:${salt}:${hash}`
}

async function resetDefaultLogin(options = {}) {
  const { silent = false } = options
  mkdirSync(WEB_UI_HOME, { recursive: true })
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(WEB_UI_DB_FILE)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'admin',
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_login_at INTEGER
      )
    `)

    const now = Date.now()
    const passwordHash = hashPassword(DEFAULT_PASSWORD)
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(DEFAULT_USERNAME)
    if (existing?.id) {
      db.prepare(
        `UPDATE users
         SET password_hash = ?, role = 'super_admin', status = 'active', updated_at = ?
         WHERE id = ?`
      ).run(passwordHash, now, existing.id)
      if (!silent) {
        console.log(`  ✓ Reset default login: ${DEFAULT_USERNAME} / ${DEFAULT_PASSWORD}`)
        console.log(`    Database: ${WEB_UI_DB_FILE}`)
      }
      return { path: WEB_UI_DB_FILE, username: DEFAULT_USERNAME, password: DEFAULT_PASSWORD, action: 'updated' }
    }

    db.prepare(
      `INSERT INTO users (username, password_hash, role, status, created_at, updated_at)
       VALUES (?, ?, 'super_admin', 'active', ?, ?)`
    ).run(DEFAULT_USERNAME, passwordHash, now, now)
    if (!silent) {
      console.log(`  ✓ Created default login: ${DEFAULT_USERNAME} / ${DEFAULT_PASSWORD}`)
      console.log(`    Database: ${WEB_UI_DB_FILE}`)
    }
    return { path: WEB_UI_DB_FILE, username: DEFAULT_USERNAME, password: DEFAULT_PASSWORD, action: 'created' }
  } finally {
    db.close()
  }
}

async function main() {
  const command = process.argv[2] || 'start'

  if (['-v', '--version', 'version'].includes(command)) {
    console.log(`${CLI_NAME} v${VERSION}`)
    process.exit(0)
  }

  if (['-h', '--help', 'help'].includes(command)) {
    console.log(`
${CLI_NAME} v${VERSION}

Usage: ${CLI_NAME} <command> [options]

Commands:
  start [port]       Start the server (default port: ${DEFAULT_PORT})
  client [port]      Start server for a remote client (disable gateway autostart, allow all CORS)
  stop               Stop the server
  restart [port]     Restart the server
  status             Show server status
  clear-login-locks  Delete the login IP lock file
  reset-default-login Create or reset the default login (${DEFAULT_USERNAME} / ${DEFAULT_PASSWORD})
  update             Update to latest version and restart
  upgrade            Alias for update
  version            Show version number

Options:
  -v, --version      Show version number
  -h, --help         Show this help message
  --no-open          Do not open a browser after startup
  --port <port>      Specify port (used with start/client/restart)
  --restart          Restart after clear-login-locks
`)
    process.exit(0)
  }

  switch (command) {
    case 'start':
      startDaemon(getPort())
      break
    case 'client':
      enableClientMode()
      startDaemon(getPort())
      break
    case 'stop':
      stopDaemon()
      break
    case 'restart':
      stopDaemon({ restart: true })
      setTimeout(() => startDaemon(getPort()), 500)
      break
    case 'status':
      showStatus()
      break
    case 'clear-login-locks': {
      const restartAfterClear = process.argv.includes('--restart')
      const result = clearLoginLocks()
      if (restartAfterClear && result.serverRunning) {
        const port = getRunningPort() ?? getPort()
        stopDaemon({ restart: true })
        setTimeout(() => startDaemon(port), 500)
      }
      break
    }
    case 'reset-default-login':
      await resetDefaultLogin()
      break
    case 'update':
    case 'upgrade':
      doUpdate()
      break
    default:
      ensureNativeModules()
      const port = !isNaN(command) ? parseInt(command) : DEFAULT_PORT
      const windowsShell = process.platform === 'win32' ? getWindowsShell() : null
      const serverEnv = {
        ...process.env,
        NODE_ENV: 'production',
        PORT: String(port),
      }
      if (windowsShell) {
        serverEnv.SHELL = serverEnv.SHELL?.trim() || windowsShell
        serverEnv.ComSpec = serverEnv.ComSpec?.trim() || windowsShell
      }
      const child = spawn(process.execPath, [serverEntry], {
        cwd: pkgDir,
        stdio: 'inherit',
        env: serverEnv,
        windowsHide: true,
      })
      child.on('exit', (code) => process.exit(code ?? 1))
      process.on('SIGTERM', () => child.kill('SIGTERM'))
      process.on('SIGINT', () => child.kill('SIGINT'))
  }
}

function doUpdate() {
  if (!['ekko-studio', 'hermes-web-ui'].includes(PACKAGE_NAME)) {
    throw new Error(`Unsupported Studio npm package: ${PACKAGE_NAME}`)
  }
  console.log(`  ⬆ Updating ${PACKAGE_NAME}...`)

  const npm = getNpmBin()
  try {
    console.log('  🧹 Cleaning npm cache...')
    execFileSync(npm, ['cache', 'clean', '--force'], {
      stdio: 'inherit',
      env: getCurrentNodeEnv(),
    })
  } catch (err) {
    console.log(`  ⚠ Failed to clean npm cache, continuing update: ${err?.message || err}`)
  }

  runUpdateInstall(npm)
}

function runUpdateInstall(npm) {
  const child = spawnCli(npm, ['install', '-g', `${PACKAGE_NAME}@latest`], {
    stdio: 'inherit',
    windowsHide: true,
    env: getCurrentNodeEnv(),
  })

  child.on('error', (err) => {
    console.log(`  ✗ Update failed: ${err.message}`)
    process.exit(1)
  })

  child.on('exit', (code) => {
    if (code === 0) {
      console.log('  ✓ Update complete, restarting...')
      const cli = getGlobalCliScript()
      if (!existsSync(cli)) {
        console.log(`  ✗ Updated CLI not found: ${cli}`)
        process.exit(1)
      }

      const restart = spawn(process.execPath, [cli, ...getRestartArgs(getUpdatePort())], {
        stdio: 'inherit',
        windowsHide: true,
        env: getCurrentNodeEnv(),
      })
      restart.on('error', (err) => {
        console.log(`  ✗ Restart failed: ${err.message}`)
        process.exit(1)
      })
      restart.on('exit', (restartCode) => process.exit(restartCode ?? 1))
    } else {
      console.log('  ✗ Update failed')
      process.exit(code ?? 1)
    }
  })
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === __filename) {
  main().catch(err => {
    console.error(`  ✗ ${err?.message || err}`)
    process.exit(1)
  })
}

export {
  doUpdate,
  clearLoginLocks,
  commandExists,
  getDaemonStopGraceMs,
  getListeningPids,
  getRestartArgs,
  parseUnixNetstatListeningPids,
  resetDefaultLogin,
  shouldOpenBrowser,
  stopDaemon,
}
