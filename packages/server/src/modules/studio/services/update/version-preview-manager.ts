import { execFile, execFileSync, spawn, type ChildProcess } from 'child_process'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createServer } from 'net'
import { delimiter, dirname, extname, join, resolve } from 'path'
import { config, getDeployDir, getWebUiHome, hasConfiguredManifestCheck, hasConfiguredUpdateExecution } from '../../public/config'
import { UpdateError } from './errors'
import { getLocalWebUiVersion, readPackageInfo } from './package-info'
import { assertDevicePackageCompatibility, assertDevicePackageExecution, assertInstallerScriptCompatible, buildDevicePackageInstallEnv, buildDevicePackageReconcileCommand, buildDevicePackageReconcileEnv, downloadAndVerifyDevicePackage, getDevicePackageExecutionMessage, resolveDevicePackageManifest } from './strategies/device-package'
import { assertEnvironmentMatches, getLastEnvironmentCheck, readDeviceEnvState, runEnvironmentCheck } from './reconcile'
import { fetchDevicePackageManifest, fetchSourcePackageManifest, isPinnedManifestUrl, readManifestCache, resolveManifestCheckResult } from './manifest-client'
import { manifestCacheFreshness } from './manifest-cache-freshness'
import { stampIdentityFromDeploy } from './identity-stamp'
import { assertSourcePackageCompatibility } from './strategies/source-package'
import { runUpdatePreflight } from './preflight'
import { applyPreflightFailureResponse } from './preflight-error-response'
import { resolveUpdateRuntimePaths } from './runtime-paths'
import { getSnapshot } from './update-check-cache'
import {
  assertNpmPackageExecution,
  buildNpmPackageInstallArgs,
  cleanupStaleNpmPackageBackupDirs,
  getNpmPackageExecutionMessage,
  restoreTlsCertificatesAfterNpmUpdate,
  upgradeHermesAgentAfterNpmUpdate,
} from './strategies/npm-package'
import { assertSourceDeployExecution, buildSourceDeployEnv, getSourceDeployExecutionMessage } from './strategies/source-deploy'
import { summarizeTaskError, updateTaskStore } from './task-store'
import type { DevicePackageManifest, SourcePackageManifest, UpdateCapabilities, UpdateCheckResult, UpdatePreflightResult, UpdateRuntimePaths, UpdateStrategy } from './types'
import { isRemoteVersionNewer } from './version-compare'
import { isDockerContainer } from '../../public/runtime-environment'

let updateInProgress = false
let managedUpdateTaskId = ''

function syncUpdateTaskState() {
  const hadInMemoryLock = updateInProgress
  updateTaskStore.syncFromDisk()
  let currentTask = updateTaskStore.getCurrentTask()
  // A currentTask persisted with a terminal status (e.g. hand-written by a
  // manual recovery on 6.6.6.73) keeps `updateInProgress` true forever and
  // 409s every future start. Archive terminal records into lastTask.
  if (currentTask && (currentTask.status === 'succeeded' || currentTask.status === 'failed')) {
    updateTaskStore.completeCurrentTask(
      currentTask.status === 'succeeded' ? 'succeeded' : 'failed',
      currentTask.message || 'Archived terminal task loaded from state file.',
    )
    currentTask = updateTaskStore.getCurrentTask()
  }
  if (
    currentTask
    && currentTask.owner === 'controller'
    && currentTask.stage === 'restarting'
    && currentTask.targetVersion
    && getLocalWebUiVersion() === currentTask.targetVersion
  ) {
    updateTaskStore.completeCurrentTask('succeeded', `Updated Hermes Web UI to ${currentTask.targetVersion}.`)
    currentTask = updateTaskStore.getCurrentTask()
  }
  // Source-deploy and device-package orchestrators run as detached child
  // processes that hand off to 'runtime' ownership. When the orchestrator
  // exits successfully and the server restarts, the new process sees the
  // task still at 'starting' stage. Complete it if we're now running the
  // target version — the orchestrator's exit code 0 already verified the
  // deploy tree built and identity stamped correctly.
  if (
    currentTask
    && currentTask.owner === 'runtime'
    && currentTask.targetVersion
    && getLocalWebUiVersion() === currentTask.targetVersion
  ) {
    updateTaskStore.completeCurrentTask('succeeded', `Updated Hermes Web UI to ${currentTask.targetVersion}.`)
    currentTask = updateTaskStore.getCurrentTask()
  }
  const recoveredTask = currentTask && currentTask.id !== managedUpdateTaskId
    ? updateTaskStore.recoverInterruptedTaskIfStale()
    : null
  if (recoveredTask) {
    console.warn('[update] recovered interrupted update task %s (%s)', recoveredTask.id, recoveredTask.targetVersion || recoveredTask.strategy)
  }
  if (!updateTaskStore.getCurrentTask()) {
    managedUpdateTaskId = ''
  }
  // Keep the in-memory lock while an update request is still progressing
  // before it has persisted task state, otherwise a concurrent request can
  // clear the lock and start a second update in the same process.
  updateInProgress = hadInMemoryLock || Boolean(updateTaskStore.getCurrentTask())
}

syncUpdateTaskState()
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
const FATAL_DETACHED_CHILD_SIGNALS = new Set<NodeJS.Signals>([
  'SIGKILL',
  'SIGSEGV',
  'SIGABRT',
  'SIGBUS',
  'SIGILL',
])
const UPDATE_RUNNER_ENV_KEYS = [
  'DEPLOY_DIR',
  'APP_USER',
  'HERMES_HOME',
  'HERMES_HOME_DIR',
  'HERMES_WEB_UI_HOME',
  'HERMES_WEBUI_STATE_DIR',
  'UPLOAD_DIR',
  'HERMES_WEB_UI_UPDATE_AUTO_INSTALL_DEPENDENCIES',
  'HERMES_WEB_UI_UPDATE_INCLUDE_AGENT_UPGRADE',
  'HERMES_WEB_UI_UPDATE_VERSION',
  'HERMES_WEB_UI_UPDATE_PACKAGE',
  'HERMES_WEB_UI_UPDATE_REGISTRY',
  'HERMES_WEB_UI_UPDATE_DIST_TAG',
  'HERMES_WEB_UI_UPDATE_PACKAGE_ARCHIVE',
  'HERMES_WEB_UI_UPDATE_STAGING_DIR',
  'HERMES_WEB_UI_UPDATE_BACKUP_DIR',
  'HERMES_WEB_UI_UPDATE_STATE_FILE',
  'HERMES_WEB_UI_UPDATE_LOG_DIR',
  'HERMES_WEB_UI_UPDATE_TASK_ID',
  'HERMES_WEB_UI_UPDATE_HEALTHCHECK_URL',
  'HERMES_WEB_UI_UPDATE_HEALTHCHECK_TIMEOUT_MS',
  'HERMES_WEB_UI_UPDATE_HEALTHCHECK_INTERVAL_MS',
  'HERMES_WEB_UI_UPDATE_HEALTHCHECK_RETRIES',
  'HERMES_WEB_UI_UPDATE_HEALTHCHECK_INITIAL_DELAY_MS',
  'HERMES_WEB_UI_UPDATE_EXPECTED_SHA256',
  'HERMES_WEB_UI_UPDATE_INSTALLER_SCRIPT_PATH',
  'HERMES_WEB_UI_UPDATE_INSTALLER_SCRIPT_SHA256',
  'HERMES_WEB_UI_UPDATE_MANIFEST_ENV_JSON',
  'HERMES_WEB_UI_STATE_DIR',
  'HERMES_WEB_UI_UPDATE_SOURCE_PACKAGE_URL',
  'HERMES_WEB_UI_UPDATE_SOURCE_PACKAGE_URLS',
  'HERMES_WEB_UI_UPDATE_SOURCE_PACKAGE_SHA256',
  'HERMES_WEB_UI_UPDATE_SOURCE_REPO_URL',
] as const

type PreviewTagRef = { name: string; sha: string }
type PreviewTagsCache = { expiresAt: number; tags: PreviewTagRef[] }
type PreviewActionResult = { success: boolean; message?: string; code?: string }

function isDetachedChildFailure(code: number | null, signal: NodeJS.Signals | null): boolean {
  if (typeof code === 'number' && code !== 0) return true
  return typeof signal === 'string' && FATAL_DETACHED_CHILD_SIGNALS.has(signal)
}

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
  const repository = configured || readPackageInfo()?.repositoryUrl || ''
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

function getGlobalPackageDir(root: string, packageName: string) {
  return join(root, ...packageName.split('/').filter(Boolean))
}

function normalizeCliRelativePath(cliBin: string) {
  return cliBin.replace(/^[./\\]+/, '')
}

function getGlobalPackageBin(root: string, packageName: string, cliBin: string) {
  const packageDir = getGlobalPackageDir(root, packageName)
  const normalizedCli = normalizeCliRelativePath(cliBin)
  return [
    join(packageDir, 'bin', normalizedCli),
    join(packageDir, normalizedCli),
  ].find(existsSync) || join(packageDir, 'bin', normalizedCli)
}

function getUpdateExecutionMessage() {
  switch (config.update.strategy) {
    case 'device-package':
      return getDevicePackageExecutionMessage()
    case 'source-deploy':
      return getSourceDeployExecutionMessage()
    default:
      return getNpmPackageExecutionMessage()
  }
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
  if (pkg?.name !== 'hermes-web-ui') {
    throw new Error(`Preview directory is not hermes-web-ui: ${getPreviewDir()}`)
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

async function getGlobalCliScriptAsync() {
  const cli = getGlobalPackageBin(
    await getGlobalRoot(),
    config.update.packageName,
    config.update.cliBin,
  )
  if (!existsSync(cli)) {
    throw new Error(`Updated package CLI not found: ${cli}`)
  }
  return cli
}

async function resolveRegistryUpdateVersion() {
  if (!(config.update.packageName && config.update.registry)) {
    throw new UpdateError('update_execution_misconfigured', getNpmPackageExecutionMessage())
  }

  const packageName = config.update.packageName
  const registry = config.update.registry
  const distTag = config.update.distTag || 'latest'
  const registryName = encodeURIComponent(packageName)
  const url = `${registry}/${registryName}`
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) {
    throw new UpdateError(
      'update_registry_query_failed',
      `Failed to resolve the latest published version from ${registry}: HTTP ${res.status}`,
      502,
    )
  }

  const data = await res.json() as { version?: string; 'dist-tags'?: Record<string, string> }
  const version = data['dist-tags']?.[distTag] || data.version || data['dist-tags']?.latest || ''
  if (!version) {
    throw new UpdateError(
      'update_registry_invalid',
      `Could not resolve a published version for ${packageName} from ${registry}.`,
      502,
    )
  }

  return version
}

async function runUpdateInstall(versionOrTag: string) {
  try {
    runNpmSync(['cache', 'clean', '--force'], { timeout: 2 * 60 * 1000 })
  } catch (err) {
    console.warn('[update] failed to clean npm cache, continuing update:', err)
  }

  // npm install -g 会把现有包目录改名为 `.{name}-{random}` 备份再装新版；
  // 上次失败留下的非空备份目录会让下一次 rename 报 ENOTEMPTY，安装前先清掉。
  try {
    const globalRoot = getGlobalRoot().trim()
    if (globalRoot) {
      const removed = cleanupStaleNpmPackageBackupDirs(globalRoot, config.update.packageName, config.update.cliBin)
      if (removed > 0) {
        console.log(`[update] removed ${removed} stale npm backup dir(s) before global install`)
      }
    }
  } catch (err) {
    console.warn('[update] failed to clean stale npm backup dirs, continuing update:', err)
  }

  return runNpmAsync(buildNpmPackageInstallArgs(config.update, versionOrTag), { timeout: 10 * 60 * 1000 })
}

async function spawnRestart(port: string) {
  const cli = await getGlobalCliScriptAsync()

  return spawn(process.execPath, [cli, 'restart', '--port', port], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: getCurrentNodeEnv(),
  })
}

function spawnSourceDeployUpdate(
  version: string,
  runtimePaths: UpdateRuntimePaths,
  taskId: string,
  sourceManifest?: SourcePackageManifest,
) {
  if (!config.update.script || !config.update.runnerService || !config.update.runnerRequestFile) {
    throw new UpdateError('update_execution_misconfigured', getSourceDeployExecutionMessage())
  }

  const env = buildSourceDeployEnv(config.update, getCurrentNodeEnv(), version, runtimePaths, taskId, sourceManifest)
  writeUpdateRunnerRequest('source-deploy', env)
  return spawnManagedUpdateService()
}

function spawnDevicePackageUpdate(
  manifest: DevicePackageManifest,
  artifactPath: string,
  runtimePaths: UpdateRuntimePaths,
  taskId: string,
) {
  if (!config.update.installerScript || !config.update.runnerService || !config.update.runnerRequestFile) {
    throw new UpdateError('update_execution_misconfigured', getDevicePackageExecutionMessage())
  }

  const env = buildDevicePackageInstallEnv(config.update, getCurrentNodeEnv(), manifest, artifactPath, runtimePaths, taskId)
  writeUpdateRunnerRequest('device-package', env)
  return spawnManagedUpdateService()
}

function spawnDevicePackageReconcile(
  manifest: DevicePackageManifest,
  runtimePaths: UpdateRuntimePaths,
  taskId: string,
) {
  if (!config.update.installerScript || !config.update.runnerService || !config.update.runnerRequestFile) {
    throw new UpdateError('update_execution_misconfigured', getDevicePackageExecutionMessage())
  }
  const command = buildDevicePackageReconcileCommand(config.update.installerScript, manifest)
  const env = buildDevicePackageReconcileEnv(config.update, getCurrentNodeEnv(), manifest, runtimePaths, taskId)
  writeUpdateRunnerRequest('device-package', env)
  return spawnManagedUpdateService()
}

function buildUpdateRunnerRequest(strategy: Extract<UpdateStrategy, 'source-deploy' | 'device-package'>, env: NodeJS.ProcessEnv) {
  const requestEnv: Record<string, string> = {}
  for (const key of UPDATE_RUNNER_ENV_KEYS) {
    const value = env[key]
    if (typeof value === 'string' && value.length > 0) {
      requestEnv[key] = value
    }
  }

  return {
    strategy,
    env: requestEnv,
  }
}

function writeUpdateRunnerRequest(strategy: Extract<UpdateStrategy, 'source-deploy' | 'device-package'>, env: NodeJS.ProcessEnv) {
  const requestPath = config.update.runnerRequestFile
  mkdirSync(dirname(requestPath), { recursive: true })
  writeFileSync(requestPath, JSON.stringify(buildUpdateRunnerRequest(strategy, env), null, 2), 'utf-8')
}

function spawnManagedUpdateService() {
  return spawn('sudo', ['-n', 'systemctl', 'start', config.update.runnerService], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: getCurrentNodeEnv(),
  })
}

function observeDetachedUpdateProcess(
  updateChild: ChildProcess,
  label: string,
  callbacks: {
    onSuccess?: () => void
    onFailure?: (message: string) => void
  } = {},
) {
  updateChild.on('error', (err) => {
    updateInProgress = false
    console.error(`[update] ${label} failed:`, err)
    callbacks.onFailure?.(`${label} failed: ${err instanceof Error ? err.message : String(err)}`)
  })
  updateChild.on('exit', (code, signal) => {
    updateInProgress = false
    const failed = isDetachedChildFailure(code, signal)
    if (failed) {
      const message = `${label} exited before replacing server: code=${code} signal=${signal}`
      console.error(`[update] ${message}`)
      callbacks.onFailure?.(message)
      return
    }
    callbacks.onSuccess?.()
  })
  updateChild.unref()
}

function appendPreflightWarning(message: string, warningText: string): string {
  return warningText ? `${message} Warning: ${warningText}` : message
}

function buildPreflight(runtimePaths: UpdateRuntimePaths, requiredFreeSpaceBytes?: number): UpdatePreflightResult {
  return runUpdatePreflight(config.update.strategy, runtimePaths, {
    stagingDir: config.update.stagingDir,
    logDir: config.update.logDir,
    stateFile: config.update.stateFile,
    minFreeSpaceBytes: config.update.minFreeSpaceBytes,
    requiredFreeSpaceBytes: requiredFreeSpaceBytes
      ?? (config.update.packageType === 'device-package'
        ? config.update.minFreeSpaceBytes
        : Math.floor(config.update.minFreeSpaceBytes / 2)),
  })
}

async function resolveUpdateCheckSummary(): Promise<{ result: UpdateCheckResult | null; remoteError: string }> {
  if (!config.update.enabled || !hasConfiguredManifestCheck(config.update)) {
    return { result: null, remoteError: '' }
  }
  try {
    return {
      result: await resolveManifestCheckResult(config.update),
      remoteError: '',
    }
  } catch (error) {
    return {
      result: null,
      remoteError: error instanceof Error ? error.message : String(error),
    }
  }
}

async function buildUpdateCapabilitiesPayload(): Promise<UpdateCapabilities> {
  const runtimePaths = resolveUpdateRuntimePaths()
  const preflight = buildPreflight(runtimePaths)
  const currentVersion = getLocalWebUiVersion()
  const { result, remoteError } = await resolveUpdateCheckSummary()

  return {
    enabled: config.update.enabled,
    strategy: config.update.strategy,
    packageType: config.update.packageType,
    channel: result?.channel || config.update.channel,
    sourceLabel: result?.sourceLabel || config.update.sourceLabel,
    currentVersion,
    latestVersion: result?.latestVersion || '',
    updateAvailable: Boolean(result?.latestVersion && isRemoteVersionNewer(currentVersion, result.latestVersion)),
    detectionSource: result?.detectionSource || 'none',
    warnings: result?.warnings ?? [],
    pinnedManifestUrl: result?.pinnedManifestUrl || '',
    effectiveManifestUrl: result?.effectiveManifestUrl || '',
    remoteError,
    supports: {
      versionCheck: hasConfiguredManifestCheck(config.update),
      fullPackage: true,
      deltaPackage: false,
      resumableDownload: false,
      checksumVerification: config.update.packageType === 'device-package',
      rollback: config.update.packageType === 'device-package',
      healthcheck: true,
      silentInstall: true,
      promptedInstall: true,
      crossPlatformShell: process.platform === 'win32' || process.platform === 'linux',
    },
    runtime: {
      manifestConfigured: hasConfiguredManifestCheck(config.update),
      executionConfigured: hasConfiguredUpdateExecution(config.update),
      runnerManaged: config.update.strategy === 'source-deploy' || config.update.strategy === 'device-package',
      autoInstallDependencies: config.update.autoInstallDependencies,
      includeAgentUpgrade: config.update.includeAgentUpgrade,
      stateFile: config.update.stateFile,
      logDir: config.update.logDir,
      stagingDir: config.update.stagingDir,
      backupDir: config.update.backupDir,
      minFreeSpaceBytes: config.update.minFreeSpaceBytes,
    },
    preflight,
  }
}

function formatUpdateTaskError(message: string, details?: unknown): string {
  if (details == null) return message
  try {
    const serialized = JSON.stringify(details)
    if (!serialized || serialized === '{}' || serialized === 'null') {
      return message
    }
    return `${message} Details: ${serialized}`
  } catch {
    return message
  }
}

function failCurrentUpdateTask(message: string, error = message) {
  managedUpdateTaskId = ''
  const safeMessage = summarizeTaskError(message)
  const safeError = summarizeTaskError(error)
  updateTaskStore.completeCurrentTask('failed', safeMessage, safeError)
}

function currentTaskResponse() {
  return updateTaskStore.getCurrentTask()
}

function managedUpdateAcceptedResponse(message: string) {
  const task = currentTaskResponse()
  return {
    success: true,
    message,
    status: task?.status || 'running',
    stage: task?.stage || 'starting',
    taskId: task?.id || '',
    ...updateTaskStore.getStatus(),
  }
}

export async function updateStatus(ctx: any) {
  syncUpdateTaskState()
  const updateCheckDisabled = !hasConfiguredManifestCheck(config.update)
    || (() => {
      const raw = (process.env.HERMES_WEB_UI_DISABLE_UPDATE_CHECK || '').trim().toLowerCase()
      return raw === 'true' || raw === '1' || raw === 'on' || raw === 'yes'
    })()
  const { result: cachedResult } = getSnapshot()
  const cached = cachedResult || { latestVersion: '', sourceLabel: config.update.sourceLabel, channel: config.update.channel, packageType: config.update.packageType, detectionSource: 'manifest' as const }
  const localVersion = getLocalWebUiVersion()
  const latestVersion = updateCheckDisabled ? '' : cached.latestVersion
  const updateAvailable = Boolean(
    !updateCheckDisabled
    && latestVersion
    && localVersion
    && isRemoteVersionNewer(latestVersion, localVersion),
  )
  ctx.body = updateTaskStore.getStatus(localVersion, latestVersion, updateAvailable)
}

export async function updateCapabilities(ctx: any) {
  syncUpdateTaskState()
  ctx.body = await buildUpdateCapabilitiesPayload()
}

export async function clearStaleUpdateStatus(ctx: any) {
  syncUpdateTaskState()
  const currentTask = updateTaskStore.getCurrentTask()
  if (currentTask) {
    ctx.status = 409
    ctx.body = {
      success: false,
      code: 'update_task_still_running',
      message: 'Cannot clear update task state while an update is still running.',
      ...updateTaskStore.getStatus(),
    }
    return
  }

  const clearedInterruptedTask = updateTaskStore.clearRecoveredInterruptedTask()
  const clearedTask = clearedInterruptedTask || updateTaskStore.clearStaleFinishedTask()
  if (!clearedTask) {
    ctx.status = 409
    ctx.body = {
      success: false,
      code: 'update_task_clear_not_needed',
      message: 'No recovered interrupted update task is available to clear.',
      ...updateTaskStore.getStatus(),
    }
    return
  }

  ctx.body = {
    success: true,
    clearedTaskId: clearedTask.id,
    message: clearedInterruptedTask
      ? 'Recovered interrupted update task state was cleared.'
      : 'Finished update task state was cleared.',
    ...updateTaskStore.getStatus(),
  }
}

export async function getUpdateEnvironment(ctx: any) {
  syncUpdateTaskState()
  try {
    await runEnvironmentCheck()
  } catch (err) {
    console.warn('[update] environment check refresh failed:', err instanceof Error ? err.message : String(err))
  }
  const cached = getLastEnvironmentCheck()

  let state = null
  try {
    state = await readDeviceEnvState()
  } catch (err) {
    console.warn('[update] env-state.json read failed:', err instanceof Error ? err.message : String(err))
  }

  let manifest: DevicePackageManifest | null = null
  if (config.update.strategy === 'device-package') {
    try {
      manifest = await fetchDevicePackageManifest(config.update)
    } catch (err) {
      if (!(err instanceof UpdateError)) {
        console.warn('[update] manifest fetch failed for /environment:', err instanceof Error ? err.message : String(err))
      }
    }
  }

  const drift = state && manifest?.environment
    ? assertEnvironmentMatches(state, manifest.environment)
    : []

  ctx.body = {
    success: true,
    status: !state ? 'unavailable' : drift.length === 0 ? 'ok' : 'drift_detected',
    lastCapturedAt: state?.capturedAt ?? null,
    manifestVersion: manifest?.version ?? null,
    actualVersion: state?.version ?? null,
    nodeVersion: state?.nodeVersion ?? null,
    agentVersion: state?.agentVersion ?? null,
    drift,
    reconcileSupported: manifest?.environment !== undefined,
    checkedAt: cached.checkedAt || null,
  }
}

export async function reconcileUpdate(ctx: any) {
  syncUpdateTaskState()
  if (updateInProgress || managedUpdateTaskId) {
    ctx.status = 409
    ctx.body = {
      success: false,
      code: 'update_task_still_running',
      message: 'Cannot reconcile while an update is still running.',
      ...updateTaskStore.getStatus(),
    }
    return
  }
  if (!hasConfiguredUpdateExecution(config.update) || config.update.strategy !== 'device-package') {
    ctx.status = 400
    ctx.body = {
      success: false,
      code: 'update_strategy_unsupported',
      message: 'Environment reconciliation only supports the device-package strategy.',
    }
    return
  }
  assertDevicePackageExecution(config.update)

  const manifest = await fetchDevicePackageManifest(config.update)
  if (!manifest.environment) {
    ctx.body = {
      success: true,
      status: 'noop',
      message: 'Manifest has no environment block; nothing to reconcile.',
      latestVersion: manifest.version,
    }
    return
  }

  const task = updateTaskStore.createTask('device-package', `Reconciling device environment for ${manifest.version}.`)
  managedUpdateTaskId = task.id
  updateTaskStore.updateCurrentStage('reconciling_env', `Capturing device environment against manifest ${manifest.version}.`, {
    targetVersion: manifest.version,
    warning: '',
    healthcheckUrl: config.update.healthcheckUrl,
  })

  const runtimePaths = resolveUpdateRuntimePaths()
  let updateChild: ChildProcess
  try {
    updateChild = spawnDevicePackageReconcile(manifest, runtimePaths, task.id)
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    failCurrentUpdateTask(`Failed to start reconcile for ${manifest.version}.`, error)
    throw err
  }
  updateTaskStore.updateCurrentStage('reconciling_env', `Reconciling device environment for ${manifest.version}.`, {
    targetVersion: manifest.version,
    warning: '',
    healthcheckUrl: config.update.healthcheckUrl,
  })
  updateTaskStore.handoffCurrentTaskToRuntime({
    stage: 'reconciling_env',
    message: `Handed off reconcile for ${manifest.version} to runtime.`,
    targetVersion: manifest.version,
    warning: '',
    healthcheckUrl: config.update.healthcheckUrl,
  })
  observeDetachedUpdateProcess(updateChild, 'managed device package reconcile service', {
    onSuccess: () => {
      managedUpdateTaskId = ''
    },
    onFailure: message => failCurrentUpdateTask(`Reconcile failed for ${manifest.version}.`, message),
  })
  ctx.body = {
    success: true,
    status: 'running',
    message: `Starting device environment reconcile for ${manifest.version}.`,
    taskId: task.id,
    latestVersion: manifest.version,
  }
}

export async function handleUpdate(ctx: any) {
  syncUpdateTaskState()
  if (!config.update.enabled) {
    ctx.status = 403
    ctx.body = {
      success: false,
      message: 'In-app update is disabled for this customized build',
    }
    return
  }

  if (!hasConfiguredUpdateExecution(config.update)) {
    ctx.status = 500
    ctx.body = {
      success: false,
      message: getUpdateExecutionMessage(),
    }
    return
  }

  if (updateInProgress) {
    ctx.status = 409
    ctx.body = {
      success: false,
      code: 'update_already_in_progress',
      message: `${config.update.packageName || 'Hermes Web UI'} update is already in progress`,
      ...updateTaskStore.getStatus(),
    }
    return
  }

  const runtimePaths = resolveUpdateRuntimePaths()
  const preflight = buildPreflight(runtimePaths)
  if (preflight.shouldBlock) {
    const agentDataSafetyIssue = preflight.issues.find(issue => issue.code === 'agent-data-safety')
    ctx.status = 409
    ctx.body = {
      success: false,
      code: agentDataSafetyIssue ? 'update_data_preservation_unavailable' : 'update_dangerous_layout',
      message: preflight.blockingText || 'Update blocked because protected data would be at risk.',
      issues: preflight.issues,
    }
    return
  }

  // Docker 环境中 npm 全局安装方式不可用，引导用户使用 docker pull 升级
  if (isDockerContainer()) {
    ctx.status = 400
    ctx.body = {
      success: false,
      code: DOCKER_ENVIRONMENT_CODE,
      message: 'hermes-web-ui update is not available inside Docker. '
        + 'Please pull a new image and recreate the container:\n\n'
        + '  docker compose pull\n'
        + '  docker compose up -d --force-recreate',
    }
    return
  }

  updateInProgress = true
  let keepUpdateLockForRestart = false

  try {
    if (config.update.strategy === 'device-package') {
      assertDevicePackageExecution(config.update)
      const task = updateTaskStore.createTask('device-package', 'Checking device package update.')
      managedUpdateTaskId = task.id
      updateTaskStore.updateCurrentStage('preflighting', 'Running update preflight checks.', {
        warning: preflight.warningText,
      })
      updateTaskStore.updateCurrentStage('checking', 'Checking device package update.', {
        warning: preflight.warningText,
      })

      const manifest = await resolveDevicePackageManifest(config.update)
      const manifestPreflight = buildPreflight(
        runtimePaths,
        Math.max(config.update.minFreeSpaceBytes, (manifest.size || 0) * 2),
      )
      if (manifestPreflight.shouldBlock) {
        throw new UpdateError(
          manifestPreflight.issues.some(issue => issue.code === 'insufficient-disk-space')
            ? 'update_preflight_space'
            : manifestPreflight.issues.some(issue => issue.code === 'agent-data-safety')
              ? 'update_data_preservation_unavailable'
              : 'update_preflight_permissions',
          manifestPreflight.blockingText || 'Update blocked by device package preflight checks.',
          409,
          {
            issues: manifestPreflight.issues,
          },
        )
      }
      updateTaskStore.updateCurrentStage('resolving_version', `Resolved device package ${manifest.version}.`, {
        targetVersion: manifest.version,
        warning: manifestPreflight.warningText || preflight.warningText,
        healthcheckUrl: manifest.healthcheckUrl || config.update.healthcheckUrl,
      })

      assertDevicePackageCompatibility(manifest, getLocalWebUiVersion())

      // Refuse the update if the device's on-disk install script does not
      // match the manifest's fingerprint. This prevents a class of failures
      // where the install script on the device is older than the manifest
      // expects, and would silently time out the post-update healthcheck.
      assertInstallerScriptCompatible(runtimePaths.deployDir, manifest)

      updateTaskStore.updateCurrentStage('downloading', `Downloading device package ${manifest.version}.`, {
        targetVersion: manifest.version,
        warning: manifestPreflight.warningText || preflight.warningText,
        healthcheckUrl: manifest.healthcheckUrl || config.update.healthcheckUrl,
      })
      const { artifactPath } = await downloadAndVerifyDevicePackage(config.update, manifest)
      updateTaskStore.updateCurrentStage('verifying', `Verified device package ${manifest.version}.`, {
        targetVersion: manifest.version,
        warning: manifestPreflight.warningText || preflight.warningText,
        healthcheckUrl: manifest.healthcheckUrl || config.update.healthcheckUrl,
      })

      let updateChild: ChildProcess
      try {
        updateChild = spawnDevicePackageUpdate(manifest, artifactPath, runtimePaths, task.id)
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        failCurrentUpdateTask(`Failed to start device package update ${manifest.version}.`, error)
        throw err
      }
      updateTaskStore.updateCurrentStage('starting', `Starting device package update ${manifest.version}.`, {
        targetVersion: manifest.version,
        warning: manifestPreflight.warningText || preflight.warningText,
        healthcheckUrl: manifest.healthcheckUrl || config.update.healthcheckUrl,
      })
      updateTaskStore.handoffCurrentTaskToRuntime({
        stage: 'starting',
        message: `Handed off device package update ${manifest.version} to runtime.`,
        targetVersion: manifest.version,
        warning: manifestPreflight.warningText || preflight.warningText,
        healthcheckUrl: manifest.healthcheckUrl || config.update.healthcheckUrl,
      })
      observeDetachedUpdateProcess(updateChild, 'managed device package update service', {
        onSuccess: () => {
          managedUpdateTaskId = ''
        },
        onFailure: message => failCurrentUpdateTask(`Failed to start device package update ${manifest.version}.`, message),
      })
      ctx.body = managedUpdateAcceptedResponse(`Starting device package update ${manifest.version}.`)
      return
    }

    if (config.update.strategy === 'source-deploy') {
      assertSourceDeployExecution(config.update)
      let sourceManifest: SourcePackageManifest | null = null
      let version = ''
      let detectionSource: 'manifest' | 'npm-registry' = 'npm-registry'
      if (hasConfiguredManifestCheck(config.update)) {
        try {
          // Assign only after every gate passes. Assigning before the
          // compatibility check leaves sourceManifest non-null when the check
          // throws, which makes the `!sourceManifest` fallback below
          // unreachable and starts the update with an empty target version.
          const manifest = await fetchSourcePackageManifest(config.update)
          assertSourcePackageCompatibility(manifest, getLocalWebUiVersion())
          sourceManifest = manifest
          version = manifest.version
          detectionSource = 'manifest'
        } catch (err) {
          console.warn('[update] source-deploy manifest lookup failed, falling back to npm registry:', err instanceof Error ? err.message : String(err))
        }
      }
      if (!sourceManifest) {
        version = await resolveRegistryUpdateVersion()
      }
      const task = updateTaskStore.createTask('source-deploy', `Preparing source deployment update ${version}.`)
      managedUpdateTaskId = task.id
      updateTaskStore.updateCurrentStage('preflighting', 'Running update preflight checks.', {
        warning: preflight.warningText,
        targetVersion: version,
        healthcheckUrl: sourceManifest?.healthcheckUrl || config.update.healthcheckUrl,
      })
      updateTaskStore.updateCurrentStage('starting', `Starting source deployment update ${version} (${detectionSource}).`, {
        targetVersion: version,
        warning: preflight.warningText,
        healthcheckUrl: sourceManifest?.healthcheckUrl || config.update.healthcheckUrl,
      })

      let updateChild: ChildProcess
      try {
        updateChild = spawnSourceDeployUpdate(version, runtimePaths, task.id, sourceManifest || undefined)
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        failCurrentUpdateTask(`Failed to start source deployment update ${version}.`, error)
        throw err
      }
      updateTaskStore.handoffCurrentTaskToRuntime({
        stage: 'starting',
        message: `Handed off source deployment update ${version} to runtime.`,
        targetVersion: version,
        warning: preflight.warningText,
        healthcheckUrl: sourceManifest?.healthcheckUrl || config.update.healthcheckUrl,
      })
      observeDetachedUpdateProcess(updateChild, 'managed source deployment update service', {
        onSuccess: () => {
          managedUpdateTaskId = ''
        },
        onFailure: message => failCurrentUpdateTask(`Failed to start source deployment update ${version}.`, message),
      })
      ctx.body = managedUpdateAcceptedResponse(`Starting source deployment update ${version}.`)
      return
    }

    assertNpmPackageExecution(config.update)
    const version = await resolveRegistryUpdateVersion()
    const task = updateTaskStore.createTask('npm-package', `Installing ${config.update.packageName}@${version}.`)
    managedUpdateTaskId = task.id
    updateTaskStore.updateCurrentStage('preflighting', 'Running update preflight checks.', {
      targetVersion: version,
      warning: preflight.warningText,
    })
    updateTaskStore.updateCurrentStage('installing_dependencies', `Installing dependencies for ${config.update.packageName}@${version}.`, {
      targetVersion: version,
      warning: preflight.warningText,
    })
    const output = await runUpdateInstall(version)
    restoreTlsCertificatesAfterNpmUpdate()

    // Best-effort Hermes Agent upgrade: Web UI is already updated in place.
    // Never blocks the Web UI update when the agent upgrade fails.
    if (config.update.includeAgentUpgrade) {
      await upgradeHermesAgentAfterNpmUpdate()
    }

    updateTaskStore.updateCurrentStage('restarting', `Restarting Hermes Web UI after updating to ${version}.`, {
      targetVersion: version,
      warning: preflight.warningText,
    })
    ctx.body = {
      success: true,
      message: output.trim() || 'hermes-web-ui updated successfully',
      status: 'running',
      stage: 'restarting',
      taskId: task.id,
    }

    keepUpdateLockForRestart = true
    setTimeout(() => {
      void (async () => {
        let restart
        try {
          restart = await spawnRestart(process.env.PORT || '6060')
        } catch (err) {
          updateInProgress = false
          failCurrentUpdateTask(`Failed to restart Hermes Web UI after updating to ${version}.`, err instanceof Error ? err.message : String(err))
          console.error('[update] failed to spawn restart:', err)
          return
        }

        restart.on('error', (err) => {
          updateInProgress = false
          console.error('[update] restart process failed:', err)
        })
        restart.on('exit', (code, signal) => {
          updateInProgress = false
          const failed = isDetachedChildFailure(code, signal)
          if (failed) {
            console.error(`[update] restart process exited before replacing server: code=${code} signal=${signal}`)
          }
        })
        restart.unref()
      })()
    }, 3000)
  } catch (err: any) {
    const responseError = err.stderr?.toString() || err.message || String(err)
    const taskError = err instanceof UpdateError
      ? formatUpdateTaskError(responseError, err.details)
      : responseError
    if (err instanceof UpdateError && err.status) {
      ctx.status = err.status
    } else {
      ctx.status = 500
    }
    if (managedUpdateTaskId) {
      failCurrentUpdateTask(err.message || 'Update failed', taskError)
    }
    ctx.body = {
      success: false,
      message: responseError,
      code: err instanceof UpdateError ? err.code : undefined,
    }
    // Phase (a) preflight semantics (master spec § Preflight → HTTP
    // Status): recoverable failures become 503 + retry_after_seconds,
    // structural failures 409 — so the UI stops offering retries that
    // cannot succeed.
    applyPreflightFailureResponse(err, ctx)
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

// ---------------------------------------------------------------------------
// Identity (phase a): what this device actually runs vs what the manifest
// claims. Master spec: docs/harness/source-deploy-refactor.md
// (§ Identity Schema, § Manifest cache). state/identity.json is written by
// update-orchestrator.sh after a successful swap; a missing or corrupt
// file means "identity unknown" (installed: false), never a 500.
// ---------------------------------------------------------------------------

interface UpdateIdentityFile {
  schema: number
  capturedAt: string
  version: string
  distSha256: string
  installerScriptSha256: string
  agentManifestSha: string
  commitSha?: string
}

// Repair (phase a): re-stamp identity.json from the CURRENT deploy tree.
// Settled decision: repair is always "record what actually runs" — never
// "force reinstall". The UI offers it only when /health is passing; a
// stamp failure here leaves the file untouched.
export async function repairUpdateIdentity(ctx: any) {
  const deployDir = getDeployDir()
  const record = stampIdentityFromDeploy(deployDir)
  if (!record) {
    ctx.status = 409
    ctx.body = {
      success: false,
      code: 'update_identity_unstampable',
      message: 'Current deploy tree has no readable package.json version or dist/; identity not re-stamped.',
    }
    return
  }
  ctx.body = { success: true, identity: record }
}

export async function getUpdateIdentity(ctx: any) {
  let identity: UpdateIdentityFile | null = null
  const identityPath = join(getWebUiHome(), 'state', 'identity.json')
  try {
    if (existsSync(identityPath)) {
      const parsed = JSON.parse(readFileSync(identityPath, 'utf8')) as UpdateIdentityFile
      if (parsed && typeof parsed === 'object' && typeof parsed.version === 'string') {
        identity = parsed
      } else {
        console.warn('[update] WARN update_identity_invalid: %s is missing required fields', identityPath)
      }
    }
  } catch (err) {
    console.warn('[update] WARN update_identity_invalid: failed to read %s: %s',
      identityPath, err instanceof Error ? err.message : String(err))
  }

  const cached = readManifestCache(config.update.channel)
  const cachedPayloadVersion = cached?.payload && typeof (cached.payload as any).version === 'string'
    ? (cached.payload as any).version as string
    : null

  ctx.body = {
    success: true,
    installed: identity !== null,
    identity,
    manifestCache: {
      freshness: manifestCacheFreshness(cached?.cachedAt ?? null),
      cachedAt: cached?.cachedAt ?? null,
      version: cachedPayloadVersion,
      pinned: isPinnedManifestUrl(cached?.manifestUrl ?? ''),
      stale: getSnapshot().result?.warnings?.includes('manifest_pinned_stale') ?? false,
    },
  }
}
