import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { config } from '../../../studio/public/config'
import { logger } from '../../../studio/public/logging'
import { updateConfigYamlForProfile } from '../../../studio/public/profile-config'
import { isPathWithin } from '../runtime/path'
import { listProfileNamesFromDisk } from '../profiles/profile'

const LEGACY_SERVER_NAME = 'hermes-studio'
const MANAGED_SERVERS: ReadonlyArray<{ name: string; toolset: string }> = [
  { name: 'ekko-studio-api', toolset: 'api' },
  { name: 'ekko-studio-browser', toolset: 'browser' },
  { name: 'ekko-studio-devices', toolset: 'devices' },
  { name: 'ekko-studio-use', toolset: 'use' },
  { name: 'ekko-studio-plan', toolset: 'plan' },
]
const MANAGED_SERVER_NAMES: Set<string> = new Set(MANAGED_SERVERS.map(server => server.name))
// Hermes Agent applies this per managed MCP server. Keep the long-running
// `use` toolset above Studio's 30-minute chat-run cap with bounded delivery
// headroom; unrelated API/browser/device calls retain the client default.
const MANAGED_USE_MCP_TIMEOUT_SECONDS = 30 * 60 + 60
const LEGACY_SERVER_NAMES = new Set([
  'hermes-studio-api',
  'hermes-studio-browser',
  'hermes-studio-devices',
  'hermes-studio-use',
  'hermes-studio-mcp',
  LEGACY_SERVER_NAME,
  'hermes-web-ui-mcp',
  'ekko-studio-mcp',
])
const MANAGED_ENV_KEY = 'HERMES_WEB_UI_MANAGED_MCP'
const LEGACY_COMMANDS = new Set([
  'hermes-lan-peer-mcp',
  'hermes-devices-mcp',
  'hermes-web-ui-mcp',
  'ekko-studio-mcp',
  'hermes-studio-mcp',
])

export type BundledMcpInjectionStatus = 'injected' | 'updated' | 'unchanged' | 'skipped'

export interface BundledMcpInjectionTargetResult {
  profile: string
  status: BundledMcpInjectionStatus
  reason?: string
}

export interface BundledMcpInjectionResult {
  serverNames: string[]
  command: string
  targets: BundledMcpInjectionTargetResult[]
}

function isEnabledEnv(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase())
}

function isDisabled(): boolean {
  return isEnabledEnv(process.env.HERMES_WEB_UI_DISABLE_MCP_AUTOINJECT)
}

function allowTransientAutoinject(): boolean {
  return isEnabledEnv(process.env.HERMES_WEB_UI_ALLOW_TRANSIENT_MCP_AUTOINJECT)
}

function canonicalPath(pathname: string): string {
  try {
    return realpathSync(pathname)
  } catch {
    return resolve(pathname)
  }
}

function isTransientPath(pathname: string): boolean {
  const candidate = canonicalPath(pathname)
  return [tmpdir(), '/tmp', '/private/tmp']
    .filter(Boolean)
    .some(root => isPathWithin(candidate, canonicalPath(root)))
}

function isLinkedGitWorktreeMarker(marker: string): boolean {
  try {
    const firstLine = readFileSync(marker, 'utf8').split(/\r?\n/, 1)[0]?.trim() || ''
    const match = /^gitdir:\s*(.+)$/i.exec(firstLine)
    if (!match) return false
    const gitDir = canonicalPath(resolve(dirname(marker), match[1].trim()))
    const commonDirText = readFileSync(join(gitDir, 'commondir'), 'utf8').trim()
    if (!commonDirText) return false
    const commonDir = canonicalPath(resolve(gitDir, commonDirText))
    // Linked worktrees declare their common dir and live at
    // <common-dir>/worktrees/<id>; a lookalike gitdir pathname is not enough.
    return canonicalPath(dirname(gitDir)) === canonicalPath(join(commonDir, 'worktrees'))
  } catch {
    return false
  }
}

function isLinkedGitWorktreePath(pathname: string): boolean {
  let current = dirname(canonicalPath(pathname))
  while (true) {
    const marker = join(current, '.git')
    if (existsSync(marker)) {
      try {
        const markerType = statSync(marker)
        if (markerType.isFile()) return isLinkedGitWorktreeMarker(marker)
        if (markerType.isDirectory()) return false
      } catch {
        return false
      }
    }
    const parent = dirname(current)
    if (parent === current) return false
    current = parent
  }
}

function shouldSkipTransientAutoinject(bundledScript: string | null): boolean {
  if (allowTransientAutoinject()) return false
  return isTransientPath(config.appHome) || (
    bundledScript !== null &&
    (isTransientPath(bundledScript) || isLinkedGitWorktreePath(bundledScript))
  )
}

function isDesktopRuntime(): boolean {
  return String(process.env.HERMES_DESKTOP || '').trim().toLowerCase() === 'true'
}

function candidateBundledMcpScripts(): string[] {
  return [
    process.env.HERMES_WEB_UI_MCP_BIN,
    join(process.cwd(), 'bin/ekko-studio-mcp.mjs'),
    join(__dirname, '../../bin/ekko-studio-mcp.mjs'),
    join(__dirname, '../../../../../../bin/ekko-studio-mcp.mjs'),
    join(process.cwd(), 'bin/hermes-web-ui-mcp.mjs'),
    join(__dirname, '../../bin/hermes-web-ui-mcp.mjs'),
    join(__dirname, '../../../../../../bin/hermes-web-ui-mcp.mjs'),
  ].filter((value): value is string => !!value)
}

function bundledMcpScriptPath(): string | null {
  return candidateBundledMcpScripts().find(candidate => existsSync(candidate)) || null
}

function runtimeNodePath(): string | null {
  const node = process.env.HERMES_AGENT_NODE?.trim()
  return node || null
}

function managedCommandConfig(
  toolset: string,
  bundledScript: string | null,
): Record<string, unknown> {
  // Prefer the bundled script with an absolute path over a bare command name.
  // On Windows (especially desktop builds), `ekko-studio-mcp` may not be in
  // PATH even though the bundled .mjs script exists on disk.  Desktop provides
  // HERMES_AGENT_NODE for the packaged runtime node; fall back to process.execPath.
  if (bundledScript) {
    return { command: runtimeNodePath() || process.execPath, args: [bundledScript, toolset] }
  }

  if (isDesktopRuntime()) {
    return { command: 'ekko-studio-mcp', args: [toolset] }
  }

  logger.warn({ candidates: candidateBundledMcpScripts() }, '[mcp-autoinject] bundled MCP script not found; falling back to PATH command')
  return { command: 'ekko-studio-mcp', args: [toolset] }
}

function managedConfig(
  profile: string,
  serverName: string,
  toolset: string,
  bundledScript: string | null,
): Record<string, unknown> {
  const env: Record<string, string> = {
    // process.execPath can be Electron. Persist Node mode for external MCP
    // clients (such as Gateway) that do not inherit the desktop server's env.
    ELECTRON_RUN_AS_NODE: '1',
    HERMES_WEB_UI_URL: `http://127.0.0.1:${config.port}`,
    HERMES_WEB_UI_HOME: config.appHome,
    HERMES_WEBUI_STATE_DIR: config.appHome,
    HERMES_WEB_UI_PROFILE: profile,
    HERMES_MCP_SERVER_NAME: serverName,
    HERMES_MCP_TOOLSET: toolset,
    [MANAGED_ENV_KEY]: '1',
  }

  return {
    ...managedCommandConfig(toolset, bundledScript),
    ...(toolset === 'use' ? { timeout: MANAGED_USE_MCP_TIMEOUT_SECONDS } : {}),
    env,
    enabled: true,
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isManagedServer(server: unknown): boolean {
  if (!isRecord(server)) return false
  if (isRecord(server.env) && server.env[MANAGED_ENV_KEY] === '1') return true
  return typeof server.command === 'string' && LEGACY_COMMANDS.has(server.command)
}

function sameArgs(existing: Record<string, any>, desired: Record<string, unknown>): boolean {
  const desiredArgs = Array.isArray(desired.args) ? desired.args : undefined
  const existingArgs = Array.isArray(existing.args) ? existing.args : undefined
  if (!desiredArgs && !existingArgs) return true
  if (!desiredArgs || !existingArgs) return false
  return desiredArgs.length === existingArgs.length && desiredArgs.every((arg, index) => existingArgs[index] === arg)
}

function sameConfig(existing: Record<string, any>, desired: Record<string, unknown>): boolean {
  const desiredEnv = desired.env as Record<string, string>
  return existing.command === desired.command &&
    sameArgs(existing, desired) &&
    (desired.timeout === undefined || existing.timeout === desired.timeout) &&
    existing.enabled !== false &&
    isRecord(existing.env) &&
    existing.env.ELECTRON_RUN_AS_NODE === desiredEnv.ELECTRON_RUN_AS_NODE &&
    existing.env.HERMES_WEB_UI_URL === desiredEnv.HERMES_WEB_UI_URL &&
    existing.env.HERMES_WEB_UI_HOME === desiredEnv.HERMES_WEB_UI_HOME &&
    existing.env.HERMES_WEBUI_STATE_DIR === desiredEnv.HERMES_WEBUI_STATE_DIR &&
    existing.env.HERMES_WEB_UI_PROFILE === desiredEnv.HERMES_WEB_UI_PROFILE &&
    existing.env.HERMES_MCP_SERVER_NAME === desiredEnv.HERMES_MCP_SERVER_NAME &&
    existing.env.HERMES_MCP_TOOLSET === desiredEnv.HERMES_MCP_TOOLSET &&
    existing.env.HERMES_WEB_UI_TOKEN === undefined &&
    existing.env[MANAGED_ENV_KEY] === desiredEnv[MANAGED_ENV_KEY]
}

async function injectIntoProfile(
  profile: string,
  bundledScript: string | null,
): Promise<BundledMcpInjectionTargetResult> {
  return await updateConfigYamlForProfile(profile, current => {
    const cfg = isRecord(current) ? current : {}
    if (!isRecord(cfg.mcp_servers)) cfg.mcp_servers = {}

    let changed = false
    let injected = false
    let hadManagedExisting = false

    for (const { name } of MANAGED_SERVERS) {
      const legacyName = name.replace(/^ekko-/, 'hermes-')
      const legacy = cfg.mcp_servers[legacyName]
      if (!cfg.mcp_servers[name] && isManagedServer(legacy)) {
        cfg.mcp_servers[name] = legacy
        delete cfg.mcp_servers[legacyName]
        changed = true
      }
    }

    for (const [name, server] of Object.entries(cfg.mcp_servers)) {
      if (MANAGED_SERVER_NAMES.has(name)) continue
      if (LEGACY_SERVER_NAMES.has(name) && !isManagedServer(server)) {
        return {
          data: cfg,
          write: false,
          result: {
            profile,
            status: 'skipped',
            reason: `existing ${name} MCP server is not managed by Hermes Web UI`,
          } satisfies BundledMcpInjectionTargetResult,
        }
      }
      if (isManagedServer(server)) {
        delete cfg.mcp_servers[name]
        changed = true
        hadManagedExisting = true
      }
    }

    for (const server of MANAGED_SERVERS) {
      const desired = managedConfig(profile, server.name, server.toolset, bundledScript)
      const existing = cfg.mcp_servers[server.name]
      if (!existing) {
        cfg.mcp_servers[server.name] = desired
        changed = true
        injected = true
        continue
      }
      hadManagedExisting = true

      if (!isManagedServer(existing)) {
        return {
          data: cfg,
          write: false,
          result: {
            profile,
            status: 'skipped',
            reason: `existing ${server.name} MCP server is not managed by Hermes Web UI`,
          } satisfies BundledMcpInjectionTargetResult,
        }
      }

      if (isRecord(existing) && existing.enabled === false) {
        return {
          data: cfg,
          write: false,
          result: {
            profile,
            status: 'skipped',
            reason: `existing ${server.name} MCP server is disabled by user`,
          } satisfies BundledMcpInjectionTargetResult,
        }
      }

      if (!sameConfig(existing, desired)) {
        cfg.mcp_servers[server.name] = desired.timeout === undefined && Object.hasOwn(existing, 'timeout')
          ? { ...desired, timeout: existing.timeout }
          : desired
        changed = true
      }
    }

    if (!changed) {
      return {
        data: cfg,
        write: false,
        result: { profile, status: 'unchanged' } satisfies BundledMcpInjectionTargetResult,
      }
    }

    return { data: cfg, result: { profile, status: injected && !hadManagedExisting ? 'injected' : 'updated' } satisfies BundledMcpInjectionTargetResult }
  }) as BundledMcpInjectionTargetResult
}

export async function injectBundledMcpServer(): Promise<BundledMcpInjectionResult> {
  const bundledScript = bundledMcpScriptPath()
  const commandInfo = managedConfig(
    'default',
    MANAGED_SERVERS[0].name,
    MANAGED_SERVERS[0].toolset,
    bundledScript,
  )
  const result: BundledMcpInjectionResult = {
    serverNames: MANAGED_SERVERS.map(server => server.name),
    command: String(commandInfo.command),
    targets: [],
  }

  if (isDisabled()) {
    logger.info('[mcp-autoinject] disabled by HERMES_WEB_UI_DISABLE_MCP_AUTOINJECT')
    return result
  }

  if (shouldSkipTransientAutoinject(bundledScript)) {
    logger.info(
      { appHome: config.appHome, bundledScript },
      '[mcp-autoinject] skipped for transient Web UI home or MCP launcher',
    )
    return result
  }

  for (const profile of listProfileNamesFromDisk()) {
    result.targets.push(await injectIntoProfile(profile, bundledScript))
  }

  const changed = result.targets.filter(target => target.status === 'injected' || target.status === 'updated')
  if (changed.length > 0) {
    logger.info({
      serverNames: result.serverNames,
      command: commandInfo.command,
      targets: changed,
    }, '[mcp-autoinject] synced bundled MCP server')
  }

  const skipped = result.targets.filter(target => target.status === 'skipped')
  if (skipped.length > 0) {
    logger.warn({ serverNames: result.serverNames, targets: skipped }, '[mcp-autoinject] skipped unmanaged MCP server entries')
  }

  return result
}
