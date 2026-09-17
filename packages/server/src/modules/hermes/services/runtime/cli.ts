import { execFile, spawn } from 'child_process'
import { existsSync, readFileSync, unlinkSync } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { promisify } from 'util'
import YAML from 'js-yaml'
import { logger } from '../../../studio/public/logging'
import { isGatewayRunningForProfile } from '../gateway/autostart'
import { startGatewayRunManaged } from '../gateway/runner'
import { getActiveProfileDir, getActiveProfileName, getProfileDir, listProfileNamesFromDisk } from '../profiles/profile'
import { parseProfileListRuntimeInfo, type ProfileListRuntimeInfo } from '../profiles/profile-list-parser'
import { probeHermesCliVersion } from './discovery'
import { execHermesWithBin, spawnHermesWithBin } from './process'

const execFileAsync = promisify(execFile)

const execOpts = { windowsHide: true }
const isDocker = existsSync('/.dockerenv')
const isTermux = !!process.env.TERMUX_VERSION ||
  (process.env.PREFIX || '').includes('/com.termux/') ||
  existsSync('/data/data/com.termux/files/usr')

/**
 * 解析 Hermes CLI 二进制路径
 * 优先使用环境变量 HERMES_BIN，否则使用 PATH 中的 'hermes' 命令
 */
function resolveHermesBin(): string {
  return process.env.HERMES_BIN?.trim() || 'hermes'
}

async function waitForGatewayRunning(profileDir: string, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isGatewayRunningForProfile(resolveHermesBin(), profileDir)) return true
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return false
}

async function stopGatewayForActiveProfile(): Promise<void> {
  try {
    await execHermesWithBin(resolveHermesBin(), ['gateway', 'stop'], {
      timeout: 30000,
      ...activeGatewayExecOpts(),
    })
  } catch (err) {
    logger.warn(err, 'hermes gateway stop before restart failed; continuing with run --replace')
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err: any) {
    return err?.code === 'EPERM'
  }
}

function readJsonPid(path: string): number | null {
  if (!existsSync(path)) return null
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'))
    const pid = typeof data?.pid === 'number' ? data.pid : parseInt(String(data?.pid || ''), 10)
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function readGatewayLockPid(profileDir: string): number | null {
  return readJsonPid(join(profileDir, 'gateway.lock'))
}

function readGatewayStatePid(profileDir: string): number | null {
  const pid = readJsonPid(join(profileDir, 'gateway.pid'))
  if (pid) return pid
  const statePath = join(profileDir, 'gateway_state.json')
  if (!existsSync(statePath)) return null
  try {
    const data = JSON.parse(readFileSync(statePath, 'utf-8'))
    const state = data?.gateway_state
    const statePid = typeof data?.pid === 'number' ? data.pid : parseInt(String(data?.pid || ''), 10)
    return statePid && Number.isFinite(statePid) && statePid > 0 && (state === 'running' || state === 'starting')
      ? statePid
      : null
  } catch {
    return null
  }
}

async function killWindowsPid(pid: number): Promise<void> {
  if (!pid || process.platform !== 'win32') return
  try {
    await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      timeout: 5000,
      windowsHide: true,
    })
  } catch (err) {
    logger.warn(err, 'Failed to taskkill gateway PID %d; falling back to process.kill', pid)
    try { process.kill(pid) } catch {}
  }
}

function cleanupStaleGatewayLock(profileDir: string, allowMalformedDelete = false): boolean {
  const lockPath = join(profileDir, 'gateway.lock')
  if (!existsSync(lockPath)) return true
  try {
    const lockData = JSON.parse(readFileSync(lockPath, 'utf-8'))
    const pid = Number(lockData?.pid)
    if (Number.isFinite(pid) && pid > 0 && isProcessAlive(pid)) return false
    unlinkSync(lockPath)
    return true
  } catch {
    if (!allowMalformedDelete) return false
    try {
      unlinkSync(lockPath)
      return true
    } catch {
      return false
    }
  }
}

async function waitForGatewayLockReleased(profileDir: string, timeoutMs = 15000, allowMalformedDelete = false): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cleanupStaleGatewayLock(profileDir, allowMalformedDelete)) return true
    await sleep(500)
  }
  return cleanupStaleGatewayLock(profileDir, allowMalformedDelete)
}

async function forceReleaseWindowsGatewayLock(profileDir: string): Promise<void> {
  if (process.platform !== 'win32') return
  const pids = new Set<number>()
  const lockPid = readGatewayLockPid(profileDir)
  const statePid = readGatewayStatePid(profileDir)
  if (lockPid) pids.add(lockPid)
  if (statePid) pids.add(statePid)

  for (const pid of pids) {
    if (isProcessAlive(pid)) {
      logger.warn('Gateway lock is still held by PID %d; force killing Windows process tree', pid)
      await killWindowsPid(pid)
    }
  }
}

async function waitForGatewayLockReleasedAfterStop(profileDir: string, timeoutMs = 15000): Promise<boolean> {
  if (await waitForGatewayLockReleased(profileDir, timeoutMs)) return true
  await forceReleaseWindowsGatewayLock(profileDir)
  return waitForGatewayLockReleased(profileDir, 5000, true)
}

function activeGatewayExecOpts() {
  return {
    ...execOpts,
    env: {
      ...process.env,
      HERMES_HOME: getActiveProfileDir(),
    },
  }
}

export interface HermesSession {
  id: string
  source: string
  user_id: string | null
  model: string
  title: string | null
  started_at: number
  ended_at: number | null
  end_reason: string | null
  message_count: number
  tool_call_count: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  billing_provider: string | null
  estimated_cost_usd: number
  actual_cost_usd: number | null
  cost_status: string
  messages?: any[]
}

export interface HermesSessionFull {
  id: string
  source: string
  user_id: string | null
  model: string
  title: string | null
  started_at: number
  ended_at: number | null
  end_reason: string | null
  message_count: number
  tool_call_count: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens?: number
  cache_write_tokens?: number
  reasoning_tokens?: number
  billing_provider: string | null
  estimated_cost_usd: number
  actual_cost_usd?: number | null
  cost_status?: string
  messages?: any[]
  system_prompt?: string
  model_config?: string
  cost_source?: string
  pricing_version?: string | null
  [key: string]: any
}

function parseSessionExport(stdout: string): HermesSessionFull[] {
  const lines = stdout.trim().split('\n').filter(Boolean)
  const sessions: HermesSessionFull[] = []
  for (const line of lines) {
    try {
      const raw: HermesSessionFull = JSON.parse(line)
      sessions.push(raw)
    } catch {
      // Skip non-JSON lines such as "Session 'x' not found."
    }
  }
  return sessions
}

export async function exportSessionsRaw(source?: string): Promise<HermesSessionFull[]> {
  const args = ['sessions', 'export', '-']
  if (source) args.push('--source', source)

  try {
    const { stdout } = await execHermesWithBin(resolveHermesBin(), args, {
      maxBuffer: 50 * 1024 * 1024, // 50MB
      timeout: 30000,
      ...execOpts,
    })
    return parseSessionExport(stdout)
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: sessions export failed')
    throw new Error(`Failed to list sessions: ${err.message}`)
  }
}

/**
 * List sessions from Hermes CLI (without messages)
 */
export async function listSessions(source?: string, limit?: number): Promise<HermesSession[]> {
  const raws = await exportSessionsRaw(source)
  const sessions: HermesSession[] = []

  for (const raw of raws) {
    let title = raw.title
    if (!title && raw.messages) {
      const firstUser = raw.messages.find((m: any) => m.role === 'user')
      if (firstUser?.content) {
        const t = String(firstUser.content).slice(0, 40)
        title = t + (String(firstUser.content).length > 40 ? '...' : '')
      }
    }
    sessions.push({
      id: raw.id,
      source: raw.source,
      user_id: raw.user_id,
      model: raw.model,
      title,
      started_at: raw.started_at,
      ended_at: raw.ended_at,
      end_reason: raw.end_reason,
      message_count: raw.message_count,
      tool_call_count: raw.tool_call_count,
      input_tokens: raw.input_tokens,
      output_tokens: raw.output_tokens,
      cache_read_tokens: raw.cache_read_tokens || 0,
      cache_write_tokens: raw.cache_write_tokens || 0,
      reasoning_tokens: raw.reasoning_tokens || 0,
      billing_provider: raw.billing_provider,
      estimated_cost_usd: raw.estimated_cost_usd,
      actual_cost_usd: raw.actual_cost_usd ?? null,
      cost_status: raw.cost_status || '',
    })
  }

  // Sort by started_at descending
  sessions.sort((a, b) => b.started_at - a.started_at)

  if (limit && limit > 0) {
    return sessions.slice(0, limit)
  }
  return sessions
}

/**
 * Get a single session with messages from Hermes CLI
 */
export async function getSession(id: string): Promise<HermesSession | null> {
  const args = ['sessions', 'export', '-', '--session-id', id]

  try {
    const { stdout } = await execHermesWithBin(resolveHermesBin(), args, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      ...execOpts,
    })

    const raws = parseSessionExport(stdout)
    if (raws.length === 0) return null

    const raw: HermesSessionFull = raws[0]
    return {
      id: raw.id,
      source: raw.source,
      user_id: raw.user_id,
      model: raw.model,
      title: raw.title,
      started_at: raw.started_at,
      ended_at: raw.ended_at,
      end_reason: raw.end_reason,
      message_count: raw.message_count,
      tool_call_count: raw.tool_call_count,
      input_tokens: raw.input_tokens,
      output_tokens: raw.output_tokens,
      cache_read_tokens: raw.cache_read_tokens || 0,
      cache_write_tokens: raw.cache_write_tokens || 0,
      reasoning_tokens: raw.reasoning_tokens || 0,
      billing_provider: raw.billing_provider,
      estimated_cost_usd: raw.estimated_cost_usd,
      actual_cost_usd: raw.actual_cost_usd ?? null,
      cost_status: raw.cost_status || '',
      messages: raw.messages,
    }
  } catch (err: any) {
    if (err.code === 1 || err.status === 1) return null
    logger.error(err, 'Hermes CLI: session export failed')
    throw new Error(`Failed to get session: ${err.message}`)
  }
}

/**
 * Delete a session from Hermes CLI
 */
export async function deleteSession(id: string): Promise<boolean> {
  try {
    await execHermesWithBin(resolveHermesBin(), ['sessions', 'delete', id, '--yes'], {
      timeout: 10000,
      ...execOpts,
    })
    return true
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: session delete failed')
    return false
  }
}

/**
 * Delete a session from a specific Hermes profile.
 */
export async function deleteSessionForProfile(id: string, profile: string): Promise<boolean> {
  try {
    await execHermesWithBin(resolveHermesBin(), ['sessions', 'delete', id, '--yes'], {
      timeout: 10000,
      ...execOpts,
      env: {
        ...process.env,
        HERMES_HOME: getProfileDir(profile),
      },
    })
    return true
  } catch (err: any) {
    logger.error({ err, sessionId: id, profile }, 'Hermes CLI: profile session delete failed')
    return false
  }
}

/**
 * Rename a session title via Hermes CLI
 */
export async function renameSession(id: string, title: string): Promise<boolean> {
  try {
    await execHermesWithBin(resolveHermesBin(), ['sessions', 'rename', id, title], {
      timeout: 10000,
      ...execOpts,
    })
    return true
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: session rename failed')
    return false
  }
}

export interface LogFileInfo {
  name: string
  size: string
  modified: string
}

/**
 * Get Hermes version
 */
export async function getVersion(): Promise<string> {
  const probe = await probeHermesCliVersion(resolveHermesBin(), process.env)
  return probe.version
}

/**
 * Start Hermes gateway (uses launchd/systemd)
 */
export async function startGateway(): Promise<string> {
  if (isDocker) {
    const pid = await startGatewayBackground()
    return pid ? `Gateway started (PID: ${pid})` : 'Gateway start triggered'
  }

  const { stdout, stderr } = await execHermesWithBin(resolveHermesBin(), ['gateway', 'start'], {
    timeout: 30000,
    ...activeGatewayExecOpts(),
  })
  return stdout || stderr
}

/**
 * Start Hermes gateway in background (for WSL where launchd/systemd is unavailable)
 * Uses "hermes gateway run" as a detached background process
 */
export async function startGatewayBackground(): Promise<number | null> {
  const child = spawnHermesWithBin(resolveHermesBin(), ['gateway', 'run'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      HERMES_HOME: getActiveProfileDir(),
    },
  })
  child.unref()
  return child.pid ?? null
}

/**
 * Restart Hermes gateway through Hermes CLI, falling back to detached
 * `gateway run` when the environment does not support `gateway restart`.
 */
export async function restartGateway(): Promise<string> {
  const profileDir = getActiveProfileDir()
  if (isDocker || isTermux || process.platform === 'win32') {
    await stopGatewayForActiveProfile()
    const lockReleased = await waitForGatewayLockReleasedAfterStop(profileDir)
    if (!lockReleased) throw new Error('Gateway stopped but runtime lock is still held by another process')
    const result = startGatewayRunManaged(resolveHermesBin(), { profileDir })
    const ready = await waitForGatewayRunning(profileDir)
    if (!ready) throw new Error(`Gateway run replace triggered but gateway did not report running within timeout${result.pid ? ` (PID: ${result.pid})` : ''}`)
    return result.pid ? `Gateway run replaced (PID: ${result.pid})` : 'Gateway run replaced'
  }
  try {
    const { stdout, stderr } = await execHermesWithBin(resolveHermesBin(), ['gateway', 'restart'], {
      timeout: 30000,
      ...activeGatewayExecOpts(),
    })
    const ready = await waitForGatewayRunning(profileDir)
    if (!ready) throw new Error('Hermes gateway restart completed but gateway did not report running within timeout')
    return stdout || stderr
  } catch (err: any) {
    logger.warn(err, 'hermes gateway restart failed; falling back to gateway run')
    await stopGatewayForActiveProfile()
    const lockReleased = await waitForGatewayLockReleasedAfterStop(profileDir)
    if (!lockReleased) throw new Error('Gateway restart failed and runtime lock is still held by another process')
    const result = startGatewayRunManaged(resolveHermesBin(), { profileDir })
    const ready = await waitForGatewayRunning(profileDir)
    if (!ready) throw new Error(`Gateway run fallback triggered but gateway did not report running within timeout${result.pid ? ` (PID: ${result.pid})` : ''}`)
    return result.pid ? `Gateway run started (PID: ${result.pid})` : 'Gateway run started'
  }
}

/**
 * Stop Hermes gateway
 */
export async function stopGateway(): Promise<string> {
  const { stdout, stderr } = await execHermesWithBin(resolveHermesBin(), ['gateway', 'stop'], {
    timeout: 30000,
    ...activeGatewayExecOpts(),
  })
  return stdout || stderr
}

/**
 * List available log files
 */
export async function listLogFiles(): Promise<LogFileInfo[]> {
  try {
    const { stdout } = await execHermesWithBin(resolveHermesBin(), ['logs', 'list'], {
      timeout: 10000,
      ...execOpts,
    })
    const files: LogFileInfo[] = []
    // Windows 可能使用 \r\n 换行符，统一处理
    const normalized = stdout.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    const lines = normalized.trim().split('\n').filter(l => l.includes('.log'))
    for (const line of lines) {
      const match = line.match(/^\s+(\S+)\s+([\d.]+\w+)\s+(.+)$/)
      if (match) {
        const rawName = match[1]
        const name = rawName.replace(/\.log$/, '')
        // 支持更多日志类型：agent, errors, gateway, 以及其他可能的日志文件
        if (['agent', 'errors', 'gateway', 'error'].includes(name)) {
          files.push({ name, size: match[2], modified: match[3].trim() })
        }
      }
    }
    return files
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: logs list failed')
    return []
  }
}

/**
 * Read log lines
 */
export async function readLogs(
  logName: string = 'agent',
  lines: number = 100,
  level?: string,
  session?: string,
  since?: string,
): Promise<string> {
  const args = ['logs', logName, '-n', String(lines)]
  if (level) args.push('--level', level)
  if (session) args.push('--session', session)
  if (since) args.push('--since', since)

  try {
    const { stdout } = await execHermesWithBin(resolveHermesBin(), args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 15000,
      ...execOpts,
    })
    return stdout
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: logs read failed')
    throw new Error(`Failed to read logs: ${err.message}`)
  }
}

// ─── Profile management ──────────────────────────────────────

export interface HermesProfile {
  name: string
  active: boolean
  model: string
  gatewayStatus?: string
  alias: string
  /** From profile.yaml display_name (presentation only; routing uses `name`). */
  displayName?: string
}

export interface HermesProfileDetail {
  name: string
  path: string
  model: string
  provider: string
  skills: number
  hasEnv: boolean
  hasSoulMd: boolean
  displayName?: string
}

function readProfileDefaultModel(name: string): string {
  const configPath = join(getProfileDir(name), 'config.yaml')
  if (!existsSync(configPath)) return '—'
  try {
    const config = YAML.load(readFileSync(configPath, 'utf-8'), { json: true }) as Record<string, any> | null
    const model = config?.model
    if (typeof model === 'string') return model.trim() || '—'
    if (model && typeof model === 'object') {
      return String(model.default || '').trim() || '—'
    }
  } catch (err) {
    logger.warn(err, 'Hermes CLI: failed to read profile config model for %s', name)
  }
  return '—'
}

/** Read ``profile.yaml`` display_name (matches Hermes ``profiles.read_profile_meta``). */
export function readProfileDisplayName(name: string): string {
  const metaPath = join(getProfileDir(name), 'profile.yaml')
  if (!existsSync(metaPath)) return ''
  try {
    const data = YAML.load(readFileSync(metaPath, 'utf-8'), { json: true }) as Record<string, unknown> | null
    return String(data?.display_name ?? '').trim()
  } catch (err) {
    logger.warn(err, 'Hermes CLI: failed to read profile display_name for %s', name)
  }
  return ''
}

/**
 * List all profiles
 */
export async function listProfiles(): Promise<HermesProfile[]> {
  const profileNames = listProfileNamesFromDisk()
  const activeProfileName = getActiveProfileName()
  let runtimeInfo = new Map<string, ProfileListRuntimeInfo>()
  try {
    const { stdout } = await execHermesWithBin(resolveHermesBin(), ['profile', 'list'], {
      timeout: 10000,
      ...execOpts,
    })
    runtimeInfo = parseProfileListRuntimeInfo(stdout, profileNames)
  } catch (err: any) {
    logger.warn(err, 'Hermes CLI: profile list failed; falling back to disk profile list')
  }

  return profileNames.map(name => {
    const runtime = runtimeInfo.get(name)
    const gatewayStatus = runtime?.gatewayStatus
    return {
      name,
      active: runtime?.active ?? name === activeProfileName,
      model: readProfileDefaultModel(name),
      gatewayStatus: gatewayStatus && gatewayStatus !== '—' && gatewayStatus !== '-' ? gatewayStatus : undefined,
      alias: runtime?.alias || '',
      displayName: readProfileDisplayName(name) || undefined,
    }
  })
}

/**
 * Get profile details
 */
export async function getProfile(name: string): Promise<HermesProfileDetail> {
  try {
    const { stdout } = await execHermesWithBin(resolveHermesBin(), ['profile', 'show', name], {
      timeout: 10000,
      ...execOpts,
    })

    const result: Record<string, string> = {}
    for (const line of stdout.trim().split('\n')) {
      const match = line.match(/^([^\s:]+):\s+(.+)$/)
      if (match) {
        result[match[1].trim().toLowerCase().replace(/\s+/g, '_')] = match[2].trim()
      }
    }

    const modelFull = result.model || ''
    const providerMatch = modelFull.match(/\((.+)\)/)
    const model = providerMatch ? modelFull.replace(/\s*\(.+\)/, '').trim() : modelFull

    return {
      name: result.profile || name,
      path: result.path || '',
      model,
      provider: providerMatch ? providerMatch[1] : '',
      skills: parseInt(result.skills || '0', 10),
      hasEnv: result['.env'] === 'exists',
      hasSoulMd: result['soul.md'] === 'exists',
      displayName: readProfileDisplayName(name) || undefined,
    }
  } catch (err: any) {
    if (err.code === 1 || err.status === 1) {
      throw new Error(`Profile "${name}" not found`)
    }
    logger.error(err, 'Hermes CLI: profile show failed')
    throw new Error(`Failed to get profile: ${err.message}`)
  }
}

/**
 * Create a new profile
 */
export async function createProfile(name: string, clone?: boolean): Promise<string> {
  const args = ['profile', 'create', name]
  if (clone) args.push('--clone')

  try {
    const { stdout, stderr } = await execHermesWithBin(resolveHermesBin(), args, {
      timeout: 15000,
      ...execOpts,
    })
    return stdout || stderr
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: profile create failed')
    throw new Error(`Failed to create profile: ${err.message}`)
  }
}

/**
 * Delete a profile
 */
export async function deleteProfile(name: string): Promise<boolean> {
  try {
    await execHermesWithBin(resolveHermesBin(), ['profile', 'delete', name, '--yes'], {
      timeout: 10000,
      ...execOpts,
    })
    return true
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: profile delete failed')
    return false
  }
}

/**
 * Rename a profile
 */
export async function renameProfile(oldName: string, newName: string): Promise<boolean> {
  try {
    await execHermesWithBin(resolveHermesBin(), ['profile', 'rename', oldName, newName], {
      timeout: 10000,
      ...execOpts,
    })
    return true
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: profile rename failed')
    return false
  }
}

/**
 * Switch active profile
 */
export async function useProfile(name: string): Promise<string> {
  try {
    const { stdout, stderr } = await execHermesWithBin(resolveHermesBin(), ['profile', 'use', name], {
      timeout: 10000,
      ...execOpts,
    })
    return stdout || stderr
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: profile use failed')
    throw new Error(`Failed to switch profile: ${err.message}`)
  }
}

/**
 * 打包 / 解包一个 profile 的耗时预算
 *
 * 归档的是整个 profile 目录，体积由用户决定：agent 在 workspace 里建的 .venv /
 * node_modules、以及 ~/.cache 下的包缓存都算在内，几百 MB 很常见。
 * 旧的 60 秒对这类 profile 不够，超时后 execFile 只留下一句没有 stderr 的
 * "Command failed"，用户看不出发生了什么。
 */
const PROFILE_ARCHIVE_TIMEOUT_MS = 10 * 60 * 1000

/** 超时被 SIGTERM 掉的归档会带上这个 code，供上层区分于真正的失败 */
export const ARCHIVE_TIMEOUT_CODE = 'archive_timeout'

function archiveTempEnvironment(directory: string): NodeJS.ProcessEnv {
  const env = { ...process.env }
  // Windows environment keys are case-insensitive. Remove every casing before
  // setting the three names Python's tempfile module checks.
  for (const key of Object.keys(env)) {
    if (['tmpdir', 'tmp', 'temp'].includes(key.toLowerCase())) delete env[key]
  }
  return {
    ...env,
    TMPDIR: directory,
    TMP: directory,
    TEMP: directory,
  }
}

async function removeArchiveTempDirectory(directory: string): Promise<void> {
  if (!directory) return
  try {
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    })
  } catch (err) {
    logger.warn(err, 'Failed to remove Hermes profile archive temp directory "%s"', directory)
  }
}

function archiveTimeoutError(action: 'Export' | 'Import', name: string): Error {
  const minutes = Math.round(PROFILE_ARCHIVE_TIMEOUT_MS / 60000)
  return Object.assign(
    new Error(`${action} of profile '${name}' timed out after ${minutes} minutes — the archive is too large`),
    { code: ARCHIVE_TIMEOUT_CODE },
  )
}

/**
 * Export profile to archive
 */
export async function exportProfile(name: string, outputPath?: string): Promise<string> {
  const args = ['profile', 'export', name]
  if (outputPath) args.push('--output', outputPath)

  let archiveTempDirectory = ''
  try {
    archiveTempDirectory = await mkdtemp(join(tmpdir(), 'hermes-profile-archive-'))
    const { stdout, stderr } = await execHermesWithBin(resolveHermesBin(), args, {
      timeout: PROFILE_ARCHIVE_TIMEOUT_MS,
      env: archiveTempEnvironment(archiveTempDirectory),
      ...execOpts,
    })
    return stdout || stderr
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: profile export failed')
    if (err?.killed) throw archiveTimeoutError('Export', name)
    throw new Error(`Failed to export profile: ${err.message}`)
  } finally {
    await removeArchiveTempDirectory(archiveTempDirectory)
  }
}

/**
 * Run hermes setup --non-interactive --reset to generate default config for current profile
 */
export async function setupReset(): Promise<string> {
  try {
    const { stdout, stderr } = await execHermesWithBin(resolveHermesBin(), ['setup', '--non-interactive', '--reset'], {
      timeout: 30000,
      ...execOpts,
    })
    return stdout || stderr
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: setup reset failed')
    throw new Error(`Failed to reset config: ${err.message}`)
  }
}

/**
 * Import profile from archive
 */
export async function importProfile(archivePath: string, name?: string): Promise<string> {
  const args = ['profile', 'import', archivePath]
  if (name) args.push('--name', name)

  let archiveTempDirectory = ''
  try {
    archiveTempDirectory = await mkdtemp(join(tmpdir(), 'hermes-profile-archive-'))
    const { stdout, stderr } = await execHermesWithBin(resolveHermesBin(), args, {
      timeout: PROFILE_ARCHIVE_TIMEOUT_MS,
      env: archiveTempEnvironment(archiveTempDirectory),
      ...execOpts,
    })
    return stdout || stderr
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: profile import failed')
    if (err?.killed) throw archiveTimeoutError('Import', name || basename(archivePath))
    throw new Error(`Failed to import profile: ${err.message}`)
  } finally {
    await removeArchiveTempDirectory(archiveTempDirectory)
  }
}

/**
 * Pin or unpin a skill via hermes curator
 */
export async function pinSkill(name: string, pinned: boolean): Promise<string> {
  const subcmd = pinned ? 'pin' : 'unpin'
  try {
    const { stdout, stderr } = await execHermesWithBin(resolveHermesBin(), ['curator', subcmd, name], {
      timeout: 15000,
      ...execOpts,
    })
    return stdout || stderr
  } catch (err: any) {
    logger.error(err, `Hermes CLI: curator ${subcmd} failed`)
    throw new Error(`Failed to ${subcmd} skill: ${err.message}`)
  }
}
