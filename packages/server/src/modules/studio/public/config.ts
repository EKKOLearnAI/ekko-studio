import { join, resolve } from 'path'
import { homedir } from 'os'

/**
 * Web UI environment variables.
 *
 * Server/listen:
 * - PORT: Web UI listen port. Default: 8648.
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
 * - HERMES_GATEWAY_URL / GATEWAY_URL: Explicit Hermes gateway upstream URL for proxy routes.
 * - GATEWAY_HOST: Default Hermes gateway upstream host. Default: 127.0.0.1.
 * - GATEWAY_PORT: Default Hermes gateway upstream port. Default: 8642.
 * - HERMES_WEB_UI_DISABLE_GATEWAY_AUTOSTART: Disable Web UI gateway autostart checks and config-driven gateway start/stop reconciliation.
 * - HERMES_WEB_UI_MANAGED_GATEWAY: Web UI-managed Hermes gateway handling. Enabled by default; set 0/false/off to use CLI start.
 * - HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN: Whether Web UI shutdown also stops managed gateways.
 * - HERMES_WEB_UI_DISABLE_MCP_AUTOINJECT: Disable Ekko Studio MCP config injection.
 * - HERMES_WEB_UI_ALLOW_TRANSIENT_MCP_AUTOINJECT: Allow MCP injection when HERMES_WEB_UI_HOME is under a temp dir.
 * - HERMES_LAN_DISCOVERY_ENABLED: Set false/0/off to disable UDP LAN discovery responder.
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
 */

export function getListenHost(env: Record<string, string | undefined> = process.env): string {
  const host = env.BIND_HOST?.trim()
  return host || '0.0.0.0'
}

export function getWebUiHome(env: Record<string, string | undefined> = process.env): string {
  const appHome = env.HERMES_WEB_UI_HOME?.trim() || env.HERMES_WEBUI_STATE_DIR?.trim()
  return appHome ? resolve(appHome) : join(homedir(), '.hermes-web-ui')
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
const remoteRelay = {
  url: process.env.HERMES_REMOTE_RELAY_URL?.trim() || 'https://api.ekkostudio.xyz',
}
const appRelay = {
  url: process.env.HERMES_APP_RELAY_URL?.trim() || 'https://api.ekkostudio.xyz',
  entitlementRequired: isAppEntitlementRequired(),
}

export const config = {
  port: parseInt(process.env.PORT || '8648', 10),
  // Default to IPv4 for stable WSL/Windows browser access. Use BIND_HOST=:: explicitly for IPv6.
  host: getListenHost(),
  appHome,
  uploadDir: process.env.UPLOAD_DIR || join(appHome, 'upload'),
  dataDir: __dirname.includes(`${join('modules', 'studio', 'public')}`)
    ? resolve(__dirname, '../../../../data')
    : resolve(__dirname, '..', 'data'),
  corsOrigins: getCorsOrigins(),
  lanAdvertiseUrl: getLanAdvertiseUrl(),
  remoteRelay,
  appRelay,
}
