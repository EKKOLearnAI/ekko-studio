import { join, resolve } from 'path'
import { existsSync } from 'fs'
import { homedir } from 'os'
import type { UpdatePackageType, UpdateStrategy } from '../services/update/types'

/**
 * Web UI environment variables.
 *
 * Server/listen:
 * - PORT: Web UI listen port. Default: 6060.
 * - BIND_HOST: Web UI bind host. Default: 0.0.0.0.
 * - CORS_ORIGINS: Comma/space-separated cross-origin allowlist. Default: same host only.
 *
 * Web UI storage:
 * - HERMES_WEB_UI_HOME: Web UI data home for auth token, credentials, logs, DB, and default uploads.
 * - HERMES_WEBUI_STATE_DIR: Compatibility alias for HERMES_WEB_UI_HOME.
 *   Default: join(homedir(), '.hermes-web-ui').
 * - UPLOAD_DIR: Upload directory override. Default: join(HERMES_WEB_UI_HOME, 'upload').
 * - dataDir: Development-only internal Web UI runtime data directory.
 *
 * Auth:
 * - AUTH_TOKEN: Explicit bearer token. If unset, Web UI stores an auto-generated token under HERMES_WEB_UI_HOME.
 * - HERMES_WEB_UI_AUTH_JWT_EXPIRES_IN: Username/password session JWT lifetime. Supports seconds or s/m/h/d suffixes. Default: 30d.
 *
 * Runtime behavior:
 * - PROFILE: Initial Hermes profile name. Default: default.
 * - HERMES_REMOTE_RELAY_URL / REMOTE_RELAY_URL: Fixed remote relay base URL for official MCU remote login.
 *   Default: empty (no remote relay unless explicitly configured).
 * - HERMES_GATEWAY_URL / GATEWAY_URL: Explicit Hermes gateway upstream URL for proxy routes.
 * - GATEWAY_HOST: Default Hermes gateway upstream host. Default: 127.0.0.1.
 * - GATEWAY_PORT: Default Hermes gateway upstream port. Default: 8642.
 * - HERMES_WEB_UI_DISABLE_GATEWAY_AUTOSTART: Disable Web UI gateway autostart checks and config-driven gateway start/stop reconciliation.
 * - HERMES_WEB_UI_MANAGED_GATEWAY: Web UI-managed Hermes gateway handling. Enabled by default; set 0/false/off to use CLI start.
 * - HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN: Whether Web UI shutdown also stops managed gateways.
 * - HERMES_WEB_UI_DISABLE_MCP_AUTOINJECT: Disable Hermes Studio MCP config injection.
 * - HERMES_WEB_UI_ALLOW_TRANSIENT_MCP_AUTOINJECT: Allow MCP injection when HERMES_WEB_UI_HOME is under a temp dir.
 * - HERMES_LAN_DISCOVERY_ENABLED: Set false/0/off to disable UDP LAN discovery responder.
 * - HERMES_LAN_DISCOVERY_HTTP_PORTS: HTTP ports to probe during UDP discovery scans. Default: 6060,8748 plus current PORT.
 *   Discovery probes are sent to the fixed UDP port 48640 plus legacy mapped ports for compatibility.
 * - HERMES_LAN_ADVERTISE_URL: Publicly reachable Studio origin used in LAN QR codes, especially from Docker.
 * - HERMES_APP_ENTITLEMENT_REQUIRED: Require an RS256 cloud entitlement for App LAN relay connections.
 * - HERMES_APP_ENTITLEMENT_PUBLIC_KEY: Optional PEM public-key override for App entitlement verification.
 * - WORKSPACE_BASE: Base directory for workspace browsing. Default: current user's home directory.
 *
 * Limits/logging:
 * - MAX_DOWNLOAD_SIZE: Max file download size. Default: 200MB.
 * - MAX_EDIT_SIZE: Max editable file size. Default: 10MB.
 * - LOG_LEVEL: Server log level. Default: info.
 * - BRIDGE_LOG_LEVEL: Bridge log level. Default: LOG_LEVEL or info.
 *
 * Update networking:
 * - WEBUI_UPDATE_MANIFEST_TIMEOUT_MS: Timeout for manifest HTTP requests. Default: 30000.
 * - WEBUI_UPDATE_PACKAGE_TIMEOUT_MS: Timeout for device package downloads. Default: 300000.
 * - WEBUI_UPDATE_DOWNLOAD_RETRIES: Retries for transient update downloads. Default: 3.
 * - WEBUI_UPDATE_DOWNLOAD_RETRY_DELAY_MS: Base delay between retries. Default: 2000.
 * - WEBUI_UPDATE_AUTO_INSTALL_DEPENDENCIES: Whether runtime reconcile installs npm dependencies before restart. Default: true.
 * - WEBUI_UPDATE_MIN_FREE_SPACE_BYTES: Minimum free disk space required before updates proceed. Default: 1073741824 (1 GiB).
 * - WEBUI_UPDATE_TASK_HEARTBEAT_TIMEOUT_MS: How long a runtime-owned task can stay quiet before it is treated as interrupted. Default: 7200000 (2 hours).
 * - WEBUI_UPDATE_INCLUDE_AGENT_UPGRADE: Whether an in-app update may also upgrade Hermes Agent.
 *   Default: false. Keep Hermes Agent upgrades explicit unless the release plan requires them.
 */

export function getListenHost(env: Record<string, string | undefined> = process.env): string {
  const host = env.BIND_HOST?.trim()
  return host || '0.0.0.0'
}

export function getWebUiHome(env: Record<string, string | undefined> = process.env): string {
  const configuredHome = env.HERMES_WEB_UI_HOME?.trim() || env.HERMES_WEBUI_STATE_DIR?.trim()
  return configuredHome ? resolve(configuredHome) : join(homedir(), '.hermes-web-ui')
}

export function getUploadDir(env: Record<string, string | undefined> = process.env): string {
  const configuredDir = env.UPLOAD_DIR?.trim()
  return configuredDir ? resolve(configuredDir) : join(getWebUiHome(env), 'upload')
}

export function getHermesHome(env: Record<string, string | undefined> = process.env): string {
  const configuredHome = env.HERMES_HOME?.trim() || env.HERMES_HOME_DIR?.trim()
  return configuredHome ? resolve(configuredHome) : ''
}

export function getDeployDir(
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
): string {
  const configuredDir = env.DEPLOY_DIR?.trim()
  return resolve(configuredDir || cwd)
}

function parseBoolean(value: string | undefined, fallback = false): boolean {
  if (value == null) return fallback
  const normalized = value.trim().toLowerCase()
  if (!normalized) return fallback
  return ['1', 'true', 'yes', 'on'].includes(normalized)
}

export function sanitizeConfigValue(value: string | undefined): string {
  return (value || '')
    .trim()
    .replace(/^[`"']+/, '')
    .replace(/[`"']+$/, '')
    .trim()
}

function normalizeUrl(value: string | undefined): string {
  return sanitizeConfigValue(value).replace(/\/+$/, '')
}

function normalizeOptionalUrl(value: string | undefined): string {
  return sanitizeConfigValue(value)
}

function parseUrlList(value: string | undefined): string[] {
  return (value || '')
    .split(/[\r\n,]+/)
    .map(entry => normalizeOptionalUrl(entry))
    .filter(Boolean)
}

function normalizePackageName(value: string | undefined): string {
  return (value || '').trim()
}

function normalizeUpdateStrategy(value: string | undefined): UpdateStrategy {
  const normalized = (value || '').trim().toLowerCase()
  if (normalized === 'device-package') return 'device-package'
  return normalized === 'source-deploy' ? 'source-deploy' : 'npm-package'
}

function normalizeUpdatePackageType(value: string | undefined): UpdatePackageType {
  const normalized = (value || '').trim().toLowerCase()
  if (normalized === 'npm-package') return 'npm-package'
  if (normalized === 'source-deploy') return 'source-deploy'
  return 'device-package'
}

function getDefaultUpdateCliBin(packageName: string): string {
  const packageBasename = packageName.split('/').filter(Boolean).pop() || packageName
  return `${packageBasename}.mjs`
}

function getDefaultUpdateSourceLabel(packageName: string, registry: string): string {
  if (!packageName || !registry) return ''
  try {
    const host = new URL(registry).host
    return `${packageName} @ ${host}`
  } catch {
    return `${packageName} @ ${registry}`
  }
}

function getDefaultManifestSourceLabel(manifestUrl: string, manifestBaseUrl: string): string {
  const candidate = manifestUrl || manifestBaseUrl
  if (!candidate) return ''
  try {
    return `Manifest @ ${new URL(candidate).host}`
  } catch {
    return 'Manifest'
  }
}

function getDefaultInstallerScript(): string {
  return resolve('scripts', 'install-device-package.sh')
}

function getDefaultUpdateRunnerService(): string {
  return 'hermes-web-ui-update.service'
}

function getDefaultUpdateRunnerRequestFile(appHomePath: string): string {
  return resolve(appHomePath, 'updates', 'update-runner-request.json')
}

/** Find the active certificate pair in deployed or development layouts. */
export function getServerCertDir(env: Record<string, string | undefined> = process.env): string {
  const sourceRoot = __dirname.includes(join('modules', 'studio', 'public'))
    ? resolve(__dirname, '../../../../../..')
    : resolve(__dirname, '../..')
  const root = env.DEPLOY_DIR?.trim() ? resolve(env.DEPLOY_DIR.trim()) : sourceRoot
  const candidates = [join(root, 'certs'), join(root, 'packages/certs'), join(root, 'packages/server/certs')]
  return candidates.find(candidate => existsSync(join(candidate, 'server.crt')) && existsSync(join(candidate, 'server.key')))
    || candidates[0]
}

/**
 * Internal loopback port used by on-device processes (Node sub-processes,
 * Python agents, shell/curl scripts) to reach the Web UI without having to
 * negotiate self-signed TLS:
 *   - HTTP mode: the plain HTTP listen port (same server, no extra process).
 *   - HTTPS mode: a dedicated plain-HTTP loopback server bound to 127.0.0.1
 *     on `HTTPS_PORT + 1`, override with LOOPBACK_PORT.
 */
const LOOPBACK_PORT: number = (() => {
  const configured = process.env.LOOPBACK_PORT?.trim()
  if (configured) {
    const parsed = Number.parseInt(configured, 10)
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) return parsed
  }
  const listenPort = parseInt(process.env.PORT || '6060', 10)
  const httpsPort = parseInt(process.env.HTTPS_PORT || String(listenPort), 10)
  const certDir = getServerCertDir()
  const hasTls = existsSync(join(certDir, 'server.crt')) && existsSync(join(certDir, 'server.key'))
  return hasTls ? httpsPort + 1 : listenPort
})()

export function getLoopbackPort(): number {
  return LOOPBACK_PORT
}

export function getLoopbackBaseUrl(port: number | string = LOOPBACK_PORT): string {
  const value = typeof port === 'number' || typeof port === 'string' ? Number(port) : NaN
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new TypeError('Loopback port must be an integer between 1 and 65535')
  }
  return `http://127.0.0.1:${value}`
}

function getDefaultUpdateHealthcheckUrl(port: number | string = LOOPBACK_PORT): string {
  return `${getLoopbackBaseUrl(port)}/health`
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt((value || '').trim(), 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

export function shouldCreateWebUiDataDir(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV !== 'production'
}

export function getCorsOrigins(env: Record<string, string | undefined> = process.env): string {
  return env.CORS_ORIGINS?.trim() || ''
}

export function getLanAdvertiseUrl(env: Record<string, string | undefined> = process.env): string {
  const value = env.HERMES_LAN_ADVERTISE_URL?.trim()
  if (!value) return ''
  try {
    const url = new URL(value.includes('://') ? value : `http://${value}`)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    if (!url.hostname || url.username || url.password) return ''
    return url.origin
  } catch {
    return ''
  }
}

export function isAppEntitlementRequired(env: Record<string, string | undefined> = process.env): boolean {
  const value = String(env.HERMES_APP_ENTITLEMENT_REQUIRED || '').trim().toLowerCase()
  return !['0', 'false', 'no', 'off'].includes(value)
}

const appHome = getWebUiHome()
const DEFAULT_MANIFEST_BASE_URL = 'https://tangledup-ai-staging.oss-cn-shanghai.aliyuncs.com/quanthermes_pj/quanthermes_web_ui/releases'
const updatePackageName = normalizePackageName(process.env.WEBUI_UPDATE_PACKAGE)
const updateRegistry = normalizeUrl(process.env.WEBUI_UPDATE_REGISTRY)
const updateManifestUrl = normalizeOptionalUrl(process.env.WEBUI_UPDATE_MANIFEST_URL)
const updateManifestBaseUrl = normalizeUrl(process.env.WEBUI_UPDATE_MANIFEST_BASE_URL) || DEFAULT_MANIFEST_BASE_URL
const updateManifestUrls = parseUrlList(process.env.WEBUI_UPDATE_MANIFEST_URLS)
const updateManifestBaseUrls = parseUrlList(process.env.WEBUI_UPDATE_MANIFEST_BASE_URLS)
const remoteRelay = {
  url: normalizeUrl(process.env.HERMES_REMOTE_RELAY_URL || process.env.REMOTE_RELAY_URL || ''),
}
// Cloud App relay is not offered by default. Point HERMES_APP_RELAY_URL at an
// operator-owned relay to enable it; LAN connections never read this value.
const appRelay = {
  url: process.env.HERMES_APP_RELAY_URL?.trim() || '',
  entitlementRequired: isAppEntitlementRequired(),
}

export const config = {
  port: parseInt(process.env.PORT || '6060', 10),
  // Default to IPv4 for stable WSL/Windows browser access. Use BIND_HOST=:: explicitly for IPv6.
  host: getListenHost(),
  appHome,
  uploadDir: getUploadDir(),
  dataDir: join(appHome, 'data'),
  corsOrigins: getCorsOrigins(),
  lanAdvertiseUrl: getLanAdvertiseUrl(),
  remoteRelay,
  appRelay,
  update: {
    enabled: parseBoolean(process.env.WEBUI_UPDATE_ENABLED),
    strategy: normalizeUpdateStrategy(process.env.WEBUI_UPDATE_STRATEGY),
    includeAgentUpgrade: parseBoolean(process.env.WEBUI_UPDATE_INCLUDE_AGENT_UPGRADE, false),
    autoInstallDependencies: parseBoolean(process.env.WEBUI_UPDATE_AUTO_INSTALL_DEPENDENCIES, true),
    packageName: updatePackageName,
    registry: updateRegistry,
    sourceLabel: (process.env.WEBUI_UPDATE_SOURCE_LABEL || '').trim()
      || getDefaultManifestSourceLabel(updateManifestUrl, updateManifestBaseUrl)
      || getDefaultUpdateSourceLabel(updatePackageName, updateRegistry),
    distTag: (process.env.WEBUI_UPDATE_DIST_TAG || 'latest').trim() || 'latest',
    cliBin: (process.env.WEBUI_UPDATE_CLI_BIN || '').trim() || getDefaultUpdateCliBin(updatePackageName || 'hermes-web-ui'),
    script: (process.env.WEBUI_UPDATE_SCRIPT || '').trim(),
    runnerService: (process.env.WEBUI_UPDATE_RUNNER_SERVICE || '').trim() || getDefaultUpdateRunnerService(),
    runnerRequestFile: resolve((process.env.WEBUI_UPDATE_RUNNER_REQUEST_FILE || getDefaultUpdateRunnerRequestFile(appHome)).trim()),
    channel: (process.env.WEBUI_UPDATE_CHANNEL || 'stable').trim() || 'stable',
    manifestUrl: updateManifestUrl,
    manifestUrls: [
      ...updateManifestUrls,
      ...updateManifestBaseUrls.map(baseUrl => `${baseUrl}/${(process.env.WEBUI_UPDATE_CHANNEL || 'stable').trim() || 'stable'}/latest.json`),
    ],
    manifestBaseUrl: updateManifestBaseUrl,
    packageType: normalizeUpdatePackageType(process.env.WEBUI_UPDATE_PACKAGE_TYPE),
    installerScript: (process.env.WEBUI_UPDATE_INSTALLER_SCRIPT || '').trim() || getDefaultInstallerScript(),
    stagingDir: resolve((process.env.WEBUI_UPDATE_STAGING_DIR || join(appHome, 'updates', 'staging')).trim()),
    backupDir: resolve((process.env.WEBUI_UPDATE_BACKUP_DIR || join(appHome, 'updates', 'backups')).trim()),
    healthcheckUrl: (process.env.WEBUI_UPDATE_HEALTHCHECK_URL || '').trim() || getDefaultUpdateHealthcheckUrl(LOOPBACK_PORT),
    stateFile: resolve((process.env.WEBUI_UPDATE_STATE_FILE || join(appHome, 'updates', 'update-task-state.json')).trim()),
    logDir: resolve((process.env.WEBUI_UPDATE_LOG_DIR || join(appHome, 'updates', 'logs')).trim()),
    manifestTimeoutMs: parsePositiveInteger(process.env.WEBUI_UPDATE_MANIFEST_TIMEOUT_MS, 30_000),
    packageTimeoutMs: parsePositiveInteger(process.env.WEBUI_UPDATE_PACKAGE_TIMEOUT_MS, 300_000),
    downloadRetries: parsePositiveInteger(process.env.WEBUI_UPDATE_DOWNLOAD_RETRIES, 3),
    downloadRetryDelayMs: parsePositiveInteger(process.env.WEBUI_UPDATE_DOWNLOAD_RETRY_DELAY_MS, 2_000),
    healthcheckTimeoutMs: parsePositiveInteger(process.env.WEBUI_UPDATE_HEALTHCHECK_TIMEOUT_MS, 15_000),
    healthcheckIntervalMs: parsePositiveInteger(process.env.WEBUI_UPDATE_HEALTHCHECK_INTERVAL_MS, 2_000),
    healthcheckRetries: parsePositiveInteger(process.env.WEBUI_UPDATE_HEALTHCHECK_RETRIES, 15),
    healthcheckInitialDelayMs: parsePositiveInteger(process.env.WEBUI_UPDATE_HEALTHCHECK_INITIAL_DELAY_MS, 5_000),
    minFreeSpaceBytes: parsePositiveInteger(process.env.WEBUI_UPDATE_MIN_FREE_SPACE_BYTES, 1_073_741_824),
    taskHeartbeatTimeoutMs: parsePositiveInteger(process.env.WEBUI_UPDATE_TASK_HEARTBEAT_TIMEOUT_MS, 7_200_000),
  },
}

export function hasConfiguredManifestCheck(
  envUpdate: typeof config.update = config.update,
): boolean {
  return Boolean(envUpdate.enabled && (envUpdate.manifestUrl || envUpdate.manifestBaseUrl || envUpdate.manifestUrls?.length))
}

export function hasConfiguredUpdateCheck(
  envUpdate: typeof config.update = config.update,
): boolean {
  return Boolean(
    envUpdate.enabled
    && ((envUpdate.manifestUrl || envUpdate.manifestBaseUrl || envUpdate.manifestUrls?.length) || (envUpdate.packageName && envUpdate.registry)),
  )
}

export function hasConfiguredUpdateExecution(
  envUpdate: typeof config.update = config.update,
): boolean {
  if (!hasConfiguredUpdateCheck(envUpdate))
    return false
  if (envUpdate.strategy === 'device-package')
    return Boolean(
      (envUpdate.manifestUrl || envUpdate.manifestBaseUrl || envUpdate.manifestUrls?.length)
      && envUpdate.installerScript
      && envUpdate.runnerService
      && envUpdate.runnerRequestFile,
    )
  if (envUpdate.strategy === 'source-deploy')
    return Boolean(envUpdate.script && envUpdate.runnerService && envUpdate.runnerRequestFile)
  return Boolean(envUpdate.cliBin)
}
