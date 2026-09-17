import { isStudioPackageName, readStudioPackageInfo, type StudioPackageName } from '../package-info'
import { execFile, execFileSync, spawn, type ChildProcess } from 'child_process'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createServer } from 'net'
import { delimiter, dirname, extname, join, resolve } from 'path'

export interface UpdateRuntimeDependencies {
  getWebUiHome: () => string
  isDockerContainer: () => boolean
}

let runtimeDependencies: UpdateRuntimeDependencies | null = null

export function configureUpdateRuntime(dependencies: UpdateRuntimeDependencies): void {
  runtimeDependencies = dependencies
}

function getWebUiHome(): string {
  if (!runtimeDependencies) throw new Error('Studio update runtime has not been configured')
  return runtimeDependencies.getWebUiHome()
}

function isDockerContainer(): boolean {
  if (!runtimeDependencies) throw new Error('Studio update runtime has not been configured')
  return runtimeDependencies.isDockerContainer()
}

let updateInProgress = false
const NODE_ENVIRONMENT_MISSING_CODE = 'node_environment_missing'
const DOCKER_ENVIRONMENT_CODE = 'docker_environment'

const PREVIEW_DIR_NAME = 'hermes-web-ui-pereview'
const PREVIEW_HOME_DIR_NAME = 'hermes-web-ui-pereview-home'
const PREVIEW_BACKEND_PORT = 8650
const PREVIEW_FRONTEND_PORT = 8651
const PREVIEW_AGENT_BRIDGE_PORT = 18650
const PREVIEW_AGENT_BRIDGE_WORKER_PORT_BASE = 19650
const PREVIEW_AGENT_BRIDGE_ENDPOINT_ENV = 'HERMES_WEB_UI_PREVIEW_AGENT_BRIDGE_ENDPOINT'
const PREVIEW_AGENT_BRIDGE_TRANSPORT_ENV = 'HERMES_WEB_UI_PREVIEW_AGENT_BRIDGE_TRANSPORT'
const PREVIEW_FRONTEND_URL = `http://localhost:${PREVIEW_FRONTEND_PORT}`
const PREVIEW_TAG_REF_PATTERN = /^[A-Za-z0-9._/-]+$/
const PREVIEW_MAIN_REF = 'main'
const PREVIEW_VERSION_TAG_LIMIT = 8
const PREVIEW_TAGS_CACHE_MS = 5 * 60 * 1000

type PreviewTagRef = { name: string; sha: string }
type PreviewTagsCache = { expiresAt: number; tags: PreviewTagRef[] }
type PreviewActionResult = { success: boolean; message?: string; code?: string }

type ParsedPreviewVersion = {
  core: string
  prerelease: string
}

class PreviewRuntimeState {
  process: ChildProcess | null = null
  tagsCache: PreviewTagsCache | null = null
  activeAction: string | null = null
  activeActionStartedAt: string | null = null
  lastAction: string | null = null
  lastActionCompletedAt: string | null = null
  lastActionResult: PreviewActionResult | null = null

  getCachedTags(): PreviewTagRef[] | null {
    return this.tagsCache && this.tagsCache.expiresAt > Date.now()
      ? this.tagsCache.tags
      : null
  }

  setTags(tags: PreviewTagRef[]) {
    this.tagsCache = { tags, expiresAt: Date.now() + PREVIEW_TAGS_CACHE_MS }
  }

  beginAction(action: string): boolean {
    if (this.activeAction) return false
    this.activeAction = action
    this.activeActionStartedAt = new Date().toISOString()
    this.lastAction = null
    this.lastActionCompletedAt = null
    this.lastActionResult = null
    return true
  }

  endAction(action: string, result: PreviewActionResult) {
    if (this.activeAction !== action) return
    this.activeAction = null
    this.activeActionStartedAt = null
    this.lastAction = action
    this.lastActionCompletedAt = new Date().toISOString()
    this.lastActionResult = result
  }
}

const previewState = new PreviewRuntimeState()

function normalizeGithubRepoUrl(raw: string): string {
  return raw
    .trim()
    .replace(/^git\+/, '')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/\.git$/, '')
}

function getPreviewRepoBaseUrl(): string {
  const configured = process.env.HERMES_WEB_UI_PREVIEW_REPO?.trim()
  const repository = configured || readStudioPackageInfo()?.repositoryUrl || ''
  const normalized = normalizeGithubRepoUrl(repository)
  if (!normalized) throw new Error('Preview repository is not configured')
  return normalized
}

function getPreviewRepoGitUrl(): string {
  return `${getPreviewRepoBaseUrl()}.git`
}

function getPreviewRepoApiUrl(): string {
  const baseUrl = getPreviewRepoBaseUrl()
  const match = baseUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/)
  if (!match) throw new Error(`Preview zip fallback only supports GitHub repositories: ${baseUrl}`)
  return `https://api.github.com/repos/${match[1]}/${match[2]}`
}

function getPreviewGithubRepoParts(): { owner: string; repo: string } {
  const baseUrl = getPreviewRepoBaseUrl()
  const match = baseUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/)
  if (!match) throw new Error(`Preview zip fallback only supports GitHub repositories: ${baseUrl}`)
  return { owner: match[1], repo: match[2] }
}

function parsePreviewTagRefs(output: string): PreviewTagRef[] {
  return output
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [sha, ref] = line.split(/\s+/)
      return { sha: sha || '', name: (ref || '').replace(/^refs\/tags\//, '') }
    })
    .filter(tag => tag.name)
}

function parsePreviewVersion(name: string): ParsedPreviewVersion | null {
  const match = name.trim().match(/^v(\d+\.\d+\.\d+)(?:-((?:alpha|beta|rc)(?:[.-]\d+)?))?$/)
  if (!match) return null
  return { core: match[1], prerelease: match[2] || '' }
}

function comparePreviewVersions(left: PreviewTagRef, right: PreviewTagRef): number {
  const leftVersion = parsePreviewVersion(left.name)
  const rightVersion = parsePreviewVersion(right.name)

  if (!leftVersion || !rightVersion) {
    if (leftVersion) return -1
    if (rightVersion) return 1
    return right.name.localeCompare(left.name, undefined, { numeric: true })
  }

  const coreOrder = rightVersion.core.localeCompare(leftVersion.core, undefined, { numeric: true })
  if (coreOrder !== 0) return coreOrder
  if (!leftVersion.prerelease && rightVersion.prerelease) return -1
  if (leftVersion.prerelease && !rightVersion.prerelease) return 1
  return rightVersion.prerelease.localeCompare(leftVersion.prerelease, undefined, { numeric: true })
}

function withPreviewMain(tags: PreviewTagRef[]): PreviewTagRef[] {
  return [
    { name: PREVIEW_MAIN_REF, sha: '' },
    ...tags
      .filter(tag => parsePreviewVersion(tag.name))
      .sort(comparePreviewVersions)
      .slice(0, PREVIEW_VERSION_TAG_LIMIT),
  ]
}

function execFileText(
  command: string,
  args: string[],
  options: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv; maxBuffer?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      cwd: options.cwd,
      encoding: 'utf-8',
      timeout: options.timeout,
      env: options.env,
      windowsHide: true,
      maxBuffer: options.maxBuffer || 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        ;(error as any).stdout = stdout
        ;(error as any).stderr = stderr
        reject(error)
        return
      }
      resolve(String(stdout || '').trim())
    })
  })
}

async function listPreviewTagsWithGitAsync(): Promise<PreviewTagRef[]> {
  const output = await execFileText('git', ['ls-remote', '--tags', '--refs', getPreviewRepoGitUrl()], {
    timeout: 8_000,
  })
  return parsePreviewTagRefs(output)
}

function getNodeBinDir() {
  return dirname(process.execPath)
}

function getNodePrefix() {
  return process.platform === 'win32' ? getNodeBinDir() : dirname(getNodeBinDir())
}

function getHomebrewPrefix() {
  const match = process.execPath.match(/^(.*)\/Cellar\/[^/]+\/[^/]+\/bin\/node$/)
  return match?.[1] || null
}

function getNpmCliCandidates() {
  const prefix = getNodePrefix()
  const homebrewPrefix = getHomebrewPrefix()

  return process.platform === 'win32'
    ? [
        join(prefix, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        join(getNodeBinDir(), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      ]
    : [
        join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        ...(homebrewPrefix ? [join(homebrewPrefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')] : []),
      ]
}

function getNpmCliPath() {
  const candidates = getNpmCliCandidates()
  const npmCli = candidates.find(existsSync)

  return npmCli || null
}

function getNpmBin() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function windowsCommandNeedsShell(command: string): boolean {
  const extension = extname(command).toLowerCase()
  return extension === '.cmd' || extension === '.bat'
}

function commandExecution(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform === 'win32' && windowsCommandNeedsShell(command)) {
    const commandArg = / /.test(command) ? `"${command}"` : command
    const argsString = args.map(arg => / /.test(arg) ? `"${arg}"` : arg).join(' ')
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', `${commandArg} ${argsString}`],
    }
  }
  return { command, args }
}

function nodeEnvironmentMissingError(): Error {
  const err = new Error('Node/npm environment was not detected. Please install Node.js and try again.')
  ;(err as any).code = NODE_ENVIRONMENT_MISSING_CODE
  return err
}

function isNodeEnvironmentMissingError(err: any): boolean {
  const text = [
    err?.code,
    err?.message,
    err?.stderr?.toString?.(),
    err?.stdout?.toString?.(),
  ].filter(Boolean).join('\n').toLowerCase()
  return text.includes('enoent') ||
    text.includes('spawn npm') ||
    text.includes('npm: command not found') ||
    text.includes('npm not found') ||
    text.includes('node: command not found') ||
    text.includes('node not found')
}

function normalizeNodeToolError(err: any): { message: string; code?: string } {
  if (isNodeEnvironmentMissingError(err)) {
    return { message: nodeEnvironmentMissingError().message, code: NODE_ENVIRONMENT_MISSING_CODE }
  }
  return { message: err?.stderr?.toString() || err?.message || String(err) }
}

function findCommandPath(command: string, env: NodeJS.ProcessEnv): string | null {
  try {
    const lookupCommand = process.platform === 'win32' ? 'where' : 'which'
    const stdout = execFileSync(lookupCommand, [command], {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      windowsHide: true,
    })
    return stdout.split(/\r?\n/).map((line: string) => line.trim()).find(Boolean) || null
  } catch {
    return null
  }
}

function npmCliFromNpmBin(npmBin: string): { node: string; npmCli: string } | null {
  const binDir = dirname(npmBin)
  if (process.platform === 'win32') {
    const node = join(binDir, 'node.exe')
    const npmCli = join(binDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    return existsSync(node) && existsSync(npmCli) ? { node, npmCli } : null
  }

  const node = join(binDir, 'node')
  const npmCli = join(dirname(binDir), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  return existsSync(node) && existsSync(npmCli) ? { node, npmCli } : null
}

function npmExecution(args: string[], env: NodeJS.ProcessEnv): { command: string; args: string[] } {
  const bundledNpmCli = getNpmCliPath()
  if (bundledNpmCli) return { command: process.execPath, args: [bundledNpmCli, ...args] }

  const npmBin = findCommandPath(getNpmBin(), env) || findCommandPath('npm', env)
  if (!npmBin) throw nodeEnvironmentMissingError()

  const npmCli = npmCliFromNpmBin(npmBin)
  if (npmCli) return { command: npmCli.node, args: [npmCli.npmCli, ...args] }

  const nodeBin = findCommandPath(process.platform === 'win32' ? 'node.exe' : 'node', env) || findCommandPath('node', env)
  if (!nodeBin) throw nodeEnvironmentMissingError()

  return commandExecution(npmBin, args)
}

function isTermuxRuntime() {
  const prefix = process.env.PREFIX || ''
  return prefix.includes('/com.termux/') ||
    existsSync('/data/data/com.termux/files/usr')
}

function getPreviewViteHostArg() {
  return isTermuxRuntime() ? '127.0.0.1' : ''
}

function getGlobalPackageBin(root: string, packageName: StudioPackageName) {
  return join(root, packageName, 'bin', 'hermes-web-ui.mjs')
}

function getCurrentNodeEnv() {
  return {
    ...process.env,
    PATH: [getNodeBinDir(), process.env.PATH].filter(Boolean).join(delimiter),
    npm_node_execpath: process.execPath,
  }
}

function getUpdateCommandCwd() {
  const cwd = getWebUiHome()
  mkdirSync(cwd, { recursive: true })
  return cwd
}

function runNpmSync(args: string[], options: { timeout?: number; env?: NodeJS.ProcessEnv } = {}) {
  const env = {
    ...getCurrentNodeEnv(),
    ...options.env,
  }
  const execution = npmExecution(args, env)
  return execFileSync(execution.command, execution.args, {
    cwd: getUpdateCommandCwd(),
    encoding: 'utf-8',
    timeout: options.timeout,
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
    windowsHide: true,
  }).trim()
}

async function runNpmAsync(args: string[], options: { timeout?: number; cwd?: string; logLabel?: string; env?: NodeJS.ProcessEnv } = {}) {
  const env = {
    ...getCurrentNodeEnv(),
    ...options.env,
  }
  const execution = npmExecution(args, env)
  const label = options.logLabel || ''

  if (label) appendPreviewActionLog(`${label}: ${execution.command} ${execution.args.join(' ')}${options.cwd ? `\ncwd: ${options.cwd}` : ''}`)
  try {
    const output = await execFileText(execution.command, execution.args, {
      cwd: options.cwd,
      timeout: options.timeout,
      env,
      maxBuffer: 16 * 1024 * 1024,
    })
    if (label) {
      if (output) appendPreviewActionLog(`${label} output:\n${output}`)
      appendPreviewActionLog(`${label} completed`)
    }
    return output
  } catch (err: any) {
    if (label) {
      const stderr = err.stderr?.toString() || ''
      const stdout = err.stdout?.toString() || ''
      appendPreviewActionLog(`${label} failed`)
      if (stdout) appendPreviewActionLog(`${label} stdout:\n${stdout}`)
      if (stderr) appendPreviewActionLog(`${label} stderr:\n${stderr}`)
    }
    throw err
  }
}

function getPreviewDir() {
  return join(getWebUiHome(), PREVIEW_DIR_NAME)
}

function getPreviewHomeDir() {
  return join(getWebUiHome(), PREVIEW_HOME_DIR_NAME)
}

function normalizePreviewAgentBridgeTransport(value: string | undefined) {
  const transport = value?.trim().toLowerCase()
  return transport && ['tcp', 'ipc', 'unix'].includes(transport) ? transport : ''
}

function getPreviewAgentBridgeEndpoint() {
  const configured = process.env[PREVIEW_AGENT_BRIDGE_ENDPOINT_ENV]?.trim()
  if (configured) return configured

  const transport = normalizePreviewAgentBridgeTransport(process.env[PREVIEW_AGENT_BRIDGE_TRANSPORT_ENV])
    || normalizePreviewAgentBridgeTransport(process.env.HERMES_AGENT_BRIDGE_WORKER_TRANSPORT)
  const useTcp = transport ? transport === 'tcp' : process.platform === 'win32'
  return useTcp
    ? `tcp://127.0.0.1:${PREVIEW_AGENT_BRIDGE_PORT}`
    : `ipc://${join(getPreviewHomeDir(), 'agent-bridge.sock')}`
}

function getTcpEndpointPort(endpoint: string): number | null {
  try {
    const url = new URL(endpoint)
    if (url.protocol !== 'tcp:') return null
    const port = Number(url.port)
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null
  } catch {
    return null
  }
}

function getPreviewListeningPorts() {
  const agentBridgePort = getTcpEndpointPort(getPreviewAgentBridgeEndpoint())
  return [
    PREVIEW_BACKEND_PORT,
    PREVIEW_FRONTEND_PORT,
    ...(agentBridgePort ? [agentBridgePort] : []),
  ]
}

function getPreviewPackagePath() {
  return join(getPreviewDir(), 'package.json')
}

function getPreviewLogPath() {
  return join(getPreviewDir(), 'preview-dev.log')
}

function getPreviewActionLogPath() {
  return join(getPreviewDir(), 'preview-action.log')
}

function getPreviewInstallEnv() {
  return {
    NODE_ENV: 'development',
    npm_config_production: 'false',
    npm_config_omit: '',
    NPM_CONFIG_PRODUCTION: 'false',
    NPM_CONFIG_OMIT: '',
  }
}

function readLogTail(path: string, maxChars = 24_000): string {
  if (!existsSync(path)) return ''
  const raw = readFileSync(path, 'utf-8')
  return raw.length > maxChars ? raw.slice(raw.length - maxChars) : raw
}

function getCurrentPreviewTag() {
  const tagPath = join(getPreviewDir(), '.preview-tag')
  if (!existsSync(tagPath)) return ''
  try {
    return readFileSync(tagPath, 'utf-8').trim()
  } catch {
    return ''
  }
}

function appendPreviewActionLog(message: string) {
  mkdirSync(getPreviewDir(), { recursive: true })
  appendFileSync(getPreviewActionLogPath(), `[${new Date().toISOString()}] ${message}\n`, 'utf-8')
}

function previewPayload(extra: Record<string, any> = {}) {
  return {
    ...extra,
    ...getPreviewStatus(),
    active_action: previewState.activeAction,
    active_action_started_at: previewState.activeActionStartedAt,
    last_action: previewState.lastAction,
    last_action_completed_at: previewState.lastActionCompletedAt,
    last_action_success: previewState.lastActionResult?.success ?? null,
    last_action_message: previewState.lastActionResult?.message || '',
    last_action_code: previewState.lastActionResult?.code || '',
    action_log: readLogTail(getPreviewActionLogPath()),
    dev_log: readLogTail(getPreviewLogPath()),
  }
}

function getPreviewStatus() {
  const previewDir = getPreviewDir()
  const packagePath = getPreviewPackagePath()
  const exists = existsSync(previewDir)
  const hasPackage = existsSync(packagePath)
  const installed = hasPackage && getMissingPreviewDependencyBins().length === 0
  const runtimePids = getPreviewListeningPids()
  const running = Boolean(previewState.process?.pid && !previewState.process.killed) || runtimePids.length > 0
  const currentTag = getCurrentPreviewTag()

  return {
    preview_dir: previewDir,
    exists,
    has_package: hasPackage,
    installed,
    running,
    pid: running ? previewState.process?.pid || runtimePids[0] || null : null,
    current_tag: currentTag,
    frontend_url: PREVIEW_FRONTEND_URL,
    agent_bridge_endpoint: getPreviewAgentBridgeEndpoint(),
    log_path: getPreviewLogPath(),
    action_log_path: getPreviewActionLogPath(),
    dev_log_path: getPreviewLogPath(),
    webui_home: getPreviewHomeDir(),
  }
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    server.listen(port, '127.0.0.1')
  })
}

function parsePidLines(output: string): number[] {
  return [...new Set(output
    .split(/\r?\n/)
    .map(line => Number(line.trim()))
    .filter(pid => Number.isFinite(pid) && pid > 0))]
}

function getPreviewListeningPids(): number[] {
  const ports = getPreviewListeningPorts()
  const pids = new Set<number>()

  if (process.platform === 'win32') {
    try {
      const output = execFileSync('netstat.exe', ['-ano', '-p', 'tcp'], { encoding: 'utf-8', windowsHide: true })
      for (const line of output.split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/)
        if (parts.length < 5) continue
        const [proto, localAddress, , state, pidRaw] = parts
        if (proto.toUpperCase() !== 'TCP' || state.toUpperCase() !== 'LISTENING') continue
        const listenPort = Number(localAddress.split(':').pop())
        if (!ports.includes(listenPort)) continue
        const pid = Number(pidRaw)
        if (Number.isFinite(pid) && pid > 0) pids.add(pid)
      }
    } catch {}
    return [...pids]
  }

  for (const port of ports) {
    try {
      for (const pid of parsePidLines(execFileSync('lsof', [`-tiTCP:${port}`, '-sTCP:LISTEN'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }))) {
        pids.add(pid)
      }
    } catch {}
  }

  return [...pids]
}

function getUnixProcessGroupId(pid: number): number | null {
  try {
    const output = execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const pgid = Number(output)
    return Number.isFinite(pgid) && pgid > 0 ? pgid : null
  } catch {
    return null
  }
}

async function assertPreviewPortsAvailable() {
  const ports = getPreviewListeningPorts()
  const checks = await Promise.all(ports.map(port => isPortAvailable(port)))
  const busy = ports.filter((_, index) => !checks[index])

  if (busy.length) {
    throw new Error(`Preview port(s) already in use: ${busy.join(', ')}. Stop the existing dev server and try again.`)
  }
}

async function waitForPreviewReady(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let lastError = ''

  while (Date.now() < deadline) {
    if (!previewState.process || previewState.process.killed) {
      throw new Error(`Preview process exited before it became ready. Check log: ${getPreviewLogPath()}`)
    }

    try {
      const res = await fetch(`http://127.0.0.1:${PREVIEW_FRONTEND_PORT}/`, {
        signal: AbortSignal.timeout(1500),
      })
      if (res.ok) return
      lastError = `HTTP ${res.status}`
    } catch (err: any) {
      lastError = err.message || String(err)
    }

    await sleep(1000)
  }

  throw new Error(`Preview did not become ready on port ${PREVIEW_FRONTEND_PORT}. Last error: ${lastError}. Check log: ${getPreviewLogPath()}`)
}

function openPreviewLogFile() {
  mkdirSync(getPreviewDir(), { recursive: true })
  writeFileSync(getPreviewLogPath(), `[preview] starting ${new Date().toISOString()}\n`, 'utf-8')
  return openSync(getPreviewLogPath(), 'a')
}

async function stopPreviewProcess() {
  const child = previewState.process
  const pids = new Set<number>()
  if (child?.pid && !child.killed) pids.add(child.pid)
  for (const pid of getPreviewListeningPids()) pids.add(pid)

  if (!pids.size) {
    previewState.process = null
    return
  }

  appendPreviewActionLog(`stopping preview process pid(s)=${[...pids].join(', ')}`)
  if (process.platform === 'win32') {
    for (const pid of pids) {
      try {
        execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      } catch {}
    }
  } else {
    const pgids = new Set<number>()
    for (const pid of pids) {
      const pgid = getUnixProcessGroupId(pid)
      if (pgid) pgids.add(pgid)
      else pgids.add(pid)
    }
    for (const pgid of pgids) {
      try {
        process.kill(-pgid, 'SIGTERM')
      } catch {
        try { process.kill(pgid, 'SIGTERM') } catch {}
      }
    }
    await sleep(800)
    const remainingPids = getPreviewListeningPids()
    const remainingPgids = new Set(remainingPids.map(getUnixProcessGroupId).filter((pgid): pgid is number => Boolean(pgid)))
    for (const pgid of remainingPgids) {
      try { process.kill(-pgid, 'SIGKILL') } catch {}
    }
  }

  previewState.process = null
  await sleep(800)
}

export async function stopPreviewRuntime(): Promise<void> {
  await stopPreviewProcess()
}

function assertPreviewPackage() {
  const packagePath = getPreviewPackagePath()
  if (!existsSync(packagePath)) {
    throw new Error(`Preview package.json not found: ${packagePath}`)
  }

  const pkg = JSON.parse(readFileSync(packagePath, 'utf-8'))
  if (!isStudioPackageName(pkg?.name)) {
    throw new Error(`Preview directory is not a Studio package: ${getPreviewDir()}`)
  }
}

function getPreviewBinPath(name: string) {
  return join(getPreviewDir(), 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name)
}

async function getPreviewNodePtyErrorAsync() {
  if (!existsSync(join(getPreviewDir(), 'node_modules', 'node-pty'))) {
    return 'node-pty'
  }

  try {
    await execFileText(process.execPath, ['-e', "require('node-pty')"], {
      cwd: getPreviewDir(),
      timeout: 30_000,
    })
    return ''
  } catch (err: any) {
    return `node-pty (${err.stderr?.toString().trim() || err.message || String(err)})`
  }
}

function getMissingPreviewDependencyBins() {
  if (!existsSync(join(getPreviewDir(), 'node_modules'))) {
    return ['node_modules']
  }

  const missing = ['concurrently', 'vite', 'nodemon'].filter(name => !existsSync(getPreviewBinPath(name)))
  if (!existsSync(join(getPreviewDir(), 'node_modules', 'node-pty'))) missing.push('node-pty')
  return missing
}

async function getMissingPreviewDependencyBinsAsync() {
  const missing = getMissingPreviewDependencyBins()
  if (missing.includes('node_modules') || missing.includes('node-pty')) return missing

  const nodePtyError = await getPreviewNodePtyErrorAsync()
  if (nodePtyError) missing.push(nodePtyError)
  return missing
}

function patchFileIfExists(path: string, patcher: (source: string) => string) {
  if (!existsSync(path)) return
  const source = readFileSync(path, 'utf-8')
  const next = patcher(source)
  if (next !== source) writeFileSync(path, next, 'utf-8')
}

function patchPreviewWebSocketClient(source: string) {
  return source.replace(
    /const host = import\.meta\.env\.DEV\s*\?\s*formatHostForPort\(location\.hostname,\s*\d+\)\s*:\s*location\.host/g,
    [
      'const directDevPort = import.meta.env.VITE_HERMES_DIRECT_WS_PORT',
      '  const host = import.meta.env.DEV && directDevPort',
      '    ? formatHostForPort(location.hostname, Number(directDevPort))',
      '    : location.host',
    ].join('\n'),
  )
}

function patchPreviewApiClient(source: string) {
  return source.replace(
    /return localStorage\.getItem\(['"]hermes_server_url['"]\) \|\| DEFAULT_BASE_URL/,
    "return import.meta.env.VITE_HERMES_PREVIEW === '1' ? DEFAULT_BASE_URL : localStorage.getItem('hermes_server_url') || DEFAULT_BASE_URL",
  )
}

function patchPreviewViteConfig(source: string) {
  let next = source.replace(
    /const BACKEND = ['"]http:\/\/127\.0\.0\.1:\d+['"]/,
    [
      `const BACKEND_PORT = process.env.HERMES_WEB_UI_BACKEND_PORT || '${PREVIEW_BACKEND_PORT}'`,
      'const BACKEND = `http://127.0.0.1:${BACKEND_PORT}`',
    ].join('\n'),
  )
  if (!next.includes('HERMES_WEB_UI_FRONTEND_PORT')) {
    next = next.replace(
      /server:\s*\{/,
      `server: {\n    port: Number(process.env.HERMES_WEB_UI_FRONTEND_PORT || ${PREVIEW_FRONTEND_PORT}),\n    strictPort: true,`,
    )
  }
  next = next.replace(
    /(changeOrigin:\s*true,)(?!\s*\n\s*ws:\s*true,)/,
    '$1\n    ws: true,',
  )
  return next
}

function patchPreviewSidebar(source: string) {
  let next = source
  if (!next.includes('VITE_HERMES_PREVIEW')) {
    next = next.replace(
      /const isSuperAdmin = computed\(\(\) => isStoredSuperAdmin\(\)\);/,
      "const isSuperAdmin = computed(() => isStoredSuperAdmin());\nconst isVersionPreview = import.meta.env.VITE_HERMES_PREVIEW === '1';",
    )
  }
  next = next.replace(
    /<RouteLinkItem v-if="isSuperAdmin" class="nav-item" :to="\{ name: 'hermes\.versionPreview' \}"/,
    '<RouteLinkItem v-if="isSuperAdmin && !isVersionPreview" class="nav-item" :to="{ name: \'hermes.versionPreview\' }"',
  )
  return next
}

function applyPreviewRuntimePatch() {
  const previewDir = getPreviewDir()
  const packagePath = getPreviewPackagePath()
  const viteConfigPath = join(previewDir, 'vite.config.ts')

  if (existsSync(packagePath)) {
    const pkg = JSON.parse(readFileSync(packagePath, 'utf-8'))
    const hostArg = getPreviewViteHostArg()
    pkg.scripts = {
      ...pkg.scripts,
      'dev:client': hostArg
        ? `vite --host ${hostArg} --port ${PREVIEW_FRONTEND_PORT} --strictPort`
        : `vite --host --port ${PREVIEW_FRONTEND_PORT} --strictPort`,
    }
    writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8')
  }

  if (existsSync(viteConfigPath)) {
    patchFileIfExists(viteConfigPath, patchPreviewViteConfig)
  }

  patchFileIfExists(join(previewDir, 'packages/client/src/components/hermes/chat/TerminalPanel.vue'), patchPreviewWebSocketClient)
  patchFileIfExists(join(previewDir, 'packages/client/src/views/hermes/TerminalView.vue'), patchPreviewWebSocketClient)
  patchFileIfExists(join(previewDir, 'packages/client/src/api/hermes/kanban.ts'), patchPreviewWebSocketClient)
  patchFileIfExists(join(previewDir, 'packages/client/src/api/client.ts'), patchPreviewApiClient)
  patchFileIfExists(join(previewDir, 'packages/client/src/components/layout/AppSidebar.vue'), patchPreviewSidebar)
}

function assertTagRef(tag: unknown): string {
  const value = typeof tag === 'string' ? tag.trim() : ''
  if (!value) throw new Error('Tag is required')
  if (!PREVIEW_TAG_REF_PATTERN.test(value) || value.includes('..')) {
    throw new Error('Invalid tag')
  }
  return value
}

async function runGitAsync(args: string[], cwd?: string) {
  return execFileText('git', args, {
    cwd,
    timeout: 5 * 60 * 1000,
  })
}

function networkErrorMessage(err: any): string {
  const detail = err.stderr?.toString() || err.message || String(err)
  return `Unable to connect to GitHub. Please check your network or proxy settings. ${detail}`
}

function errorMessage(err: any): string {
  return err.stderr?.toString() || err.message || String(err)
}

function queuePreviewAction(
  action: string,
  work: () => Promise<PreviewActionResult | void>,
  normalizeError: (err: any) => { message: string; code?: string } = err => ({ message: errorMessage(err) }),
  onError?: (err: any) => Promise<void>,
): boolean {
  if (!previewState.beginAction(action)) return false

  void (async () => {
    try {
      const result = await work()
      const normalized = result || { success: true }
      previewState.endAction(action, normalized)
      appendPreviewActionLog(`${action} completed${normalized.success === false ? ': failed' : ''}`)
    } catch (err: any) {
      if (onError) {
        try { await onError(err) } catch {}
      }
      const normalized = normalizeError(err)
      appendPreviewActionLog(`${action} failed: ${normalized.message}`)
      previewState.endAction(action, {
        success: false,
        message: normalized.message,
        code: normalized.code,
      })
    }
  })()

  return true
}

function previewActionAlreadyRunning(ctx: any) {
  ctx.status = 409
  ctx.body = previewPayload({ success: false, message: `Preview action already running: ${previewState.activeAction}` })
}

function previewActionAccepted(ctx: any) {
  ctx.status = 202
  ctx.body = previewPayload({ success: true, accepted: true })
}

async function downloadGithubZip(ref: string, targetDir: string, type: 'tag' | 'branch' = 'tag') {
  const { owner, repo } = getPreviewGithubRepoParts()
  const refKind = type === 'branch' ? 'heads' : 'tags'
  const archiveKind = process.platform === 'win32' ? 'zip' : 'tar.gz'
  const url = `https://codeload.github.com/${owner}/${repo}/${archiveKind}/refs/${refKind}/${encodeURIComponent(ref)}`
  appendPreviewActionLog(`download archive: ${url}`)
  const res = await fetch(url, {
    headers: { 'User-Agent': 'hermes-web-ui-preview' },
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) throw new Error(`Failed to download GitHub archive: HTTP ${res.status}`)

  const tmpRoot = `${targetDir}.download`
  const archivePath = `${tmpRoot}.${archiveKind === 'zip' ? 'zip' : 'tar.gz'}`
  rmSync(tmpRoot, { recursive: true, force: true })
  rmSync(archivePath, { force: true })
  mkdirSync(tmpRoot, { recursive: true })
  const archiveBuffer = Buffer.from(await res.arrayBuffer())
  writeFileSync(archivePath, archiveBuffer)
  appendPreviewActionLog(`downloaded archive: ${archiveBuffer.length} bytes`)

  try {
    appendPreviewActionLog(`extract archive: ${archivePath}`)
    if (process.platform === 'win32') {
      await execFileText('powershell.exe', [
        '-NoProfile',
        '-Command',
        `Expand-Archive -LiteralPath ${JSON.stringify(archivePath)} -DestinationPath ${JSON.stringify(tmpRoot)} -Force`,
      ], { timeout: 5 * 60 * 1000 })
    } else {
      await execFileText('tar', ['-xzf', archivePath, '-C', tmpRoot], { timeout: 5 * 60 * 1000 })
    }

    const entries = (await execFileText(process.platform === 'win32' ? 'cmd.exe' : 'ls', process.platform === 'win32' ? ['/c', 'dir', '/b', tmpRoot] : [tmpRoot], {
      timeout: 30_000,
    })).trim().split(/\r?\n/).filter(Boolean)
    const extracted = entries.length === 1 ? join(tmpRoot, entries[0]) : tmpRoot
    appendPreviewActionLog(`replace preview directory: ${targetDir}`)
    rmSync(targetDir, { recursive: true, force: true })
    mkdirSync(dirname(targetDir), { recursive: true })
    if (process.platform !== 'win32') mkdirSync(targetDir, { recursive: true })
    await execFileText(process.platform === 'win32' ? 'cmd.exe' : 'cp', process.platform === 'win32'
      ? ['/c', 'move', extracted, targetDir]
      : ['-R', `${extracted}/.`, targetDir], {
      timeout: 5 * 60 * 1000,
    })
    appendPreviewActionLog('archive preview code ready')
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true })
    rmSync(archivePath, { force: true })
  }
}

async function clonePreview(ref: string) {
  const previewDir = getPreviewDir()
  appendPreviewActionLog(`prepare preview clone for tag: ${ref}`)
  rmSync(previewDir, { recursive: true, force: true })
  mkdirSync(dirname(previewDir), { recursive: true })

  try {
    appendPreviewActionLog(`git clone --branch ${ref} --depth 1 ${getPreviewRepoGitUrl()} ${previewDir}`)
    await runGitAsync(['clone', '--branch', ref, '--depth', '1', getPreviewRepoGitUrl(), previewDir])
    appendPreviewActionLog('git clone completed')
  } catch {
    appendPreviewActionLog('git clone unavailable or failed, falling back to GitHub zip')
    rmSync(previewDir, { recursive: true, force: true })
    await downloadGithubZip(ref, previewDir, ref === PREVIEW_MAIN_REF ? 'branch' : 'tag')
  }
}

async function checkoutPreview(ref: string) {
  const previewDir = getPreviewDir()
  appendPreviewActionLog(`checkout preview tag: ${ref}`)
  if (!existsSync(previewDir)) {
    await clonePreview(ref)
  } else if (existsSync(join(previewDir, '.git'))) {
    try {
      appendPreviewActionLog('git fetch --tags --force')
      await runGitAsync(['fetch', '--tags', '--force'], previewDir)
      appendPreviewActionLog(`git checkout --force ${ref}`)
      await runGitAsync(['checkout', '--force', ref], previewDir)
    } catch (err: any) {
      appendPreviewActionLog(`git checkout failed, replacing with GitHub zip: ${err.stderr?.toString() || err.message || String(err)}`)
      rmSync(previewDir, { recursive: true, force: true })
      await downloadGithubZip(ref, previewDir, ref === PREVIEW_MAIN_REF ? 'branch' : 'tag')
    }
  } else {
    appendPreviewActionLog('preview directory is missing git metadata or package.json, replacing with GitHub zip')
    rmSync(previewDir, { recursive: true, force: true })
    await downloadGithubZip(ref, previewDir, ref === PREVIEW_MAIN_REF ? 'branch' : 'tag')
  }

  assertPreviewPackage()
  appendPreviewActionLog('apply preview runtime port patch')
  applyPreviewRuntimePatch()
  writeFileSync(join(previewDir, '.preview-tag'), `${ref}\n`)
  appendPreviewActionLog(`preview tag ready: ${ref}`)
}

function getGlobalRoot() {
  return runNpmSync(['root', '-g'])
}

function getGlobalCliScript(packageName: StudioPackageName) {
  const cli = getGlobalPackageBin(getGlobalRoot(), packageName)
  if (!existsSync(cli)) {
    throw new Error(`Updated ${packageName} CLI not found: ${cli}`)
  }
  return cli
}

function runUpdateInstall(packageName: StudioPackageName) {
  try {
    runNpmSync(['cache', 'clean', '--force'], { timeout: 2 * 60 * 1000 })
  } catch (err) {
    console.warn('[update] failed to clean npm cache, continuing update:', err)
  }

  return runNpmSync(['install', '-g', `${packageName}@latest`], { timeout: 10 * 60 * 1000 })
}

function spawnRestart(port: string, packageName: StudioPackageName) {
  const cli = getGlobalCliScript(packageName)

  return spawn(process.execPath, [cli, 'restart', '--port', port], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: getCurrentNodeEnv(),
  })
}

export async function handleUpdate(ctx: any) {
  if (updateInProgress) {
    ctx.status = 409
    ctx.body = {
      success: false,
      message: 'Ekko Studio update is already in progress',
    }
    return
  }

  // Docker 环境中 npm 全局安装方式不可用，引导用户使用 docker pull 升级
  if (isDockerContainer()) {
    ctx.status = 400
    ctx.body = {
      success: false,
      code: DOCKER_ENVIRONMENT_CODE,
      message: 'Ekko Studio update is not available inside Docker. '
        + 'Please pull a new image and recreate the container:\n\n'
        + '  docker compose pull\n'
        + '  docker compose up -d --force-recreate',
    }
    return
  }

  updateInProgress = true
  let keepUpdateLockForRestart = false

  try {
    const packageName = readStudioPackageInfo()?.name
    if (!packageName) throw new Error('Cannot identify the installed Studio npm package')
    const output = runUpdateInstall(packageName)

    ctx.body = {
      success: true,
      message: output.trim() || `${packageName} updated successfully`,
    }

    keepUpdateLockForRestart = true
    setTimeout(() => {
      let restart
      try {
        restart = spawnRestart(process.env.PORT || '8648', packageName)
      } catch (err) {
        updateInProgress = false
        console.error('[update] failed to spawn restart:', err)
        return
      }

      restart.on('error', (err) => {
        updateInProgress = false
        console.error('[update] restart process failed:', err)
      })
      restart.on('exit', (code, signal) => {
        updateInProgress = false
        const failed = (typeof code === 'number' && code !== 0) || Boolean(signal)
        if (failed) {
          console.error(`[update] restart process exited before replacing server: code=${code} signal=${signal}`)
        }
      })
      restart.unref()
    }, 3000)
  } catch (err: any) {
    ctx.status = 500
    ctx.body = {
      success: false,
      message: err.stderr?.toString() || err.message || String(err),
    }
  } finally {
    if (!keepUpdateLockForRestart) {
      updateInProgress = false
    }
  }
}

export async function previewStatus(ctx: any) {
  ctx.body = previewPayload()
}

export async function previewTags(ctx: any) {
  const cachedTags = previewState.getCachedTags()
  if (cachedTags) {
    ctx.body = { tags: cachedTags }
    return
  }

  try {
    appendPreviewActionLog('load tags with git ls-remote')
    const tags = withPreviewMain(await listPreviewTagsWithGitAsync())
    previewState.setTags(tags)
    ctx.body = { tags }
    return
  } catch (gitErr: any) {
    appendPreviewActionLog(`load tags with git failed: ${gitErr.message || String(gitErr)}`)
  }

  try {
    appendPreviewActionLog('load tags with GitHub API')
    const res = await fetch(`${getPreviewRepoApiUrl()}/tags?per_page=100`, {
      headers: { 'User-Agent': 'hermes-web-ui-preview' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      throw new Error(`GitHub API HTTP ${res.status}`)
    }

    const tags = await res.json() as Array<{ name?: string; commit?: { sha?: string } }>
    const parsedTags = withPreviewMain(tags
      .filter((tag): tag is { name: string; commit?: { sha?: string } } => typeof tag.name === 'string' && Boolean(tag.name.trim()))
      .map(tag => ({ name: tag.name, sha: tag.commit?.sha || '' })))
    previewState.setTags(parsedTags)
    ctx.body = { tags: parsedTags }
  } catch (apiErr: any) {
    appendPreviewActionLog(`load tags failed: ${apiErr.message || String(apiErr)}`)
    ctx.status = 502
    ctx.body = previewPayload({ error: networkErrorMessage(apiErr) })
  }
}

export async function preparePreview(ctx: any) {
  try {
    const tag = assertTagRef((ctx.request.body as any)?.tag)
    const queued = queuePreviewAction('prepare', async () => {
      appendPreviewActionLog(`prepare requested: ${tag}`)
      await stopPreviewProcess()
      await checkoutPreview(tag)
      return { success: true }
    })
    if (!queued) {
      previewActionAlreadyRunning(ctx)
      return
    }
    previewActionAccepted(ctx)
  } catch (err: any) {
    appendPreviewActionLog(`prepare failed: ${errorMessage(err)}`)
    ctx.status = 500
    ctx.body = previewPayload({ success: false, message: errorMessage(err) })
  }
}

export async function installPreview(ctx: any) {
  const queued = queuePreviewAction('install', async () => {
    appendPreviewActionLog('npm install requested')
    await stopPreviewProcess()
    assertPreviewPackage()
    const output = await runNpmAsync(['install', '--include=dev', '--ignore-scripts'], {
      cwd: getPreviewDir(),
      timeout: 15 * 60 * 1000,
      logLabel: 'npm install --include=dev --ignore-scripts',
      env: getPreviewInstallEnv(),
    })
    if (existsSync(join(getPreviewDir(), 'node_modules', 'node-pty'))) {
      await runNpmAsync(['rebuild', 'node-pty'], {
        cwd: getPreviewDir(),
        timeout: 5 * 60 * 1000,
        logLabel: 'npm rebuild node-pty',
        env: getPreviewInstallEnv(),
      })
    }
    appendPreviewActionLog(`verify preview dependencies in: ${getPreviewDir()}`)
    const missing = await getMissingPreviewDependencyBinsAsync()
    if (missing.length) {
      const message = `npm install completed but preview dependencies are still missing: ${missing.join(', ')}`
      appendPreviewActionLog(message)
      return { success: false, message }
    }
    return { success: true, message: output }
  }, normalizeNodeToolError)
  if (!queued) {
    previewActionAlreadyRunning(ctx)
    return
  }
  previewActionAccepted(ctx)
}

export async function startPreview(ctx: any) {
  try {
    const tag = (ctx.request.body as any)?.tag
    const requestedTag = typeof tag === 'string' && tag.trim() ? assertTagRef(tag) : ''
    const queued = queuePreviewAction('start', async () => {
      appendPreviewActionLog(`npm run dev requested${requestedTag ? ` for ${requestedTag}` : ''}`)
      if (requestedTag && requestedTag !== getCurrentPreviewTag() && previewState.process?.pid && !previewState.process.killed) {
        await stopPreviewProcess()
      }

      if (requestedTag) {
        const currentTag = getCurrentPreviewTag()
        if (requestedTag === currentTag && existsSync(getPreviewPackagePath())) {
          appendPreviewActionLog(`skip checkout, preview tag already prepared: ${requestedTag}`)
          appendPreviewActionLog('apply preview runtime port patch')
          applyPreviewRuntimePatch()
        } else {
          await checkoutPreview(requestedTag)
        }
      }
      assertPreviewPackage()
      const missingDependencies = await getMissingPreviewDependencyBinsAsync()
      if (missingDependencies.length) {
        const message = `Preview dependencies are not installed. Missing: ${missingDependencies.join(', ')}. Run npm install first.`
        appendPreviewActionLog(`start blocked: ${message}`)
        return { success: false, message }
      }

      if (previewState.process?.pid && !previewState.process.killed) {
        appendPreviewActionLog('preview is already running')
        return { success: true, message: 'Preview is already running' }
      }

      await assertPreviewPortsAvailable()

      const env = {
        ...getCurrentNodeEnv(),
        NODE_ENV: 'development',
        PORT: String(PREVIEW_BACKEND_PORT),
        HERMES_WEB_UI_HOME: getPreviewHomeDir(),
        HERMES_WEBUI_STATE_DIR: getPreviewHomeDir(),
        HERMES_AGENT_BRIDGE_ENDPOINT: getPreviewAgentBridgeEndpoint(),
        HERMES_AGENT_BRIDGE_WORKER_PORT_BASE: String(PREVIEW_AGENT_BRIDGE_WORKER_PORT_BASE),
        AUTH_TOKEN: '',
        HERMES_WEB_UI_BACKEND_PORT: String(PREVIEW_BACKEND_PORT),
        HERMES_WEB_UI_FRONTEND_PORT: String(PREVIEW_FRONTEND_PORT),
        VITE_HERMES_PREVIEW: '1',
      }
      const execution = npmExecution(['run', 'dev'], env)
      const logFd = openPreviewLogFile()
      appendPreviewActionLog(`spawn preview process: ${execution.command} ${execution.args.join(' ')}`)
      previewState.process = spawn(execution.command, execution.args, {
        cwd: getPreviewDir(),
        detached: true,
        stdio: ['ignore', logFd, logFd],
        windowsHide: true,
        env,
      })
      closeSync(logFd)
      previewState.process.on('exit', () => {
        appendPreviewActionLog('preview process exited')
        previewState.process = null
      })
      previewState.process.on('error', (err) => {
        console.error('[preview] failed:', err)
        previewState.process = null
      })
      previewState.process.unref()

      await waitForPreviewReady()

      appendPreviewActionLog(`preview ready: ${PREVIEW_FRONTEND_URL}`)
      return { success: true, message: 'Preview started' }
    }, normalizeNodeToolError, async () => {
      await stopPreviewProcess()
    })
    if (!queued) {
      previewActionAlreadyRunning(ctx)
      return
    }
    previewActionAccepted(ctx)
  } catch (err: any) {
    const normalized = normalizeNodeToolError(err)
    appendPreviewActionLog(`npm run dev failed: ${normalized.message}`)
    ctx.status = 500
    ctx.body = previewPayload({ success: false, message: normalized.message, code: normalized.code })
  }
}

export async function stopPreview(ctx: any) {
  appendPreviewActionLog('stop preview requested')
  await stopPreviewProcess()
  ctx.body = previewPayload({ success: true })
}
