import { execFile } from 'child_process'
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'fs'
import YAML from 'js-yaml'
import { join } from 'path'
import { promisify } from 'util'
import { readAppConfig, type GatewayAutoStartConfig } from '../../../studio/public/app-config'
import { logger } from '../../../studio/public/logging'
import { getHermesBaseDir, getProfileDir, listProfileNamesFromDisk } from '../profiles/profile'
import { parseGatewayStatusesFromProfileList } from '../profiles/profile-list-parser'
import { execHermesWithBin } from '../runtime/process'
import { retireManagedGatewayForProfile, startGatewayRunManaged } from './runner'

const execFileAsync = promisify(execFile)
const GATEWAY_RUNTIME_FILES = ['gateway.pid', 'gateway.lock', 'gateway_state.json'] as const

export type GatewayManagementMode = 'auto' | 'per_profile' | 'unified'

export interface GatewayRuntimeTarget {
  requestedProfile: string
  targetProfile: string
  unified: boolean
}

export interface GatewayManagementTransitionResult {
  changed: boolean
  previousUnified: boolean
  nextUnified: boolean
  stoppedProfiles: string[]
  startedProfiles: string[]
}

const RESERVED_PROFILE_NAMES = new Set([
  'hermes', 'test', 'tmp', 'root', 'sudo',
])

const HERMES_SUBCOMMAND_PROFILE_NAMES = new Set([
  'chat', 'model', 'gateway', 'setup', 'whatsapp', 'login', 'logout',
  'status', 'cron', 'doctor', 'dump', 'config', 'pairing', 'skills', 'tools',
  'mcp', 'sessions', 'insights', 'version', 'update', 'uninstall',
  'profile', 'plugins', 'honcho', 'acp',
])

function resolveHermesBin(): string {
  return process.env.HERMES_BIN?.trim() || 'hermes'
}

function isReservedProfileName(profile: string): boolean {
  const normalized = String(profile || '').trim().toLowerCase()
  if (!normalized || normalized === 'default') return false
  return RESERVED_PROFILE_NAMES.has(normalized) || HERMES_SUBCOMMAND_PROFILE_NAMES.has(normalized)
}

function normalizedProfileList(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  const seen = new Set<string>()
  const names: string[] = []
  for (const value of values) {
    const name = String(value || '').trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  return names
}

export function selectProfilesForGatewayAutostart(
  profiles: string[],
  policy?: GatewayAutoStartConfig,
): string[] {
  const known = new Set(profiles)
  if (policy?.enabled !== true) return []

  const hasIncludePolicy = Array.isArray(policy?.include)
  const include = normalizedProfileList(policy?.include).filter(name => known.has(name))
  const exclude = new Set(normalizedProfileList(policy?.exclude))
  const candidates = hasIncludePolicy ? include : profiles

  return candidates.filter(name => !exclude.has(name))
}

function configTruthy(value: unknown): boolean {
  if (value === true) return true
  const normalized = String(value || '').trim().toLowerCase()
  return ['1', 'true', 'yes', 'on'].includes(normalized)
}

export function gatewayMultiplexConfigEnabledForDefaultProfile(defaultProfileDir = getProfileDir('default')): boolean {
  const configPath = join(defaultProfileDir, 'config.yaml')
  if (!existsSync(configPath)) return false

  try {
    const data = YAML.load(readFileSync(configPath, 'utf-8'), { json: true }) as Record<string, any> | null
    return configTruthy(data?.multiplex_profiles) || configTruthy(data?.gateway?.multiplex_profiles)
  } catch (err) {
    logger.warn(err, '[gateway-autostart] failed to read gateway multiplex config from %s', configPath)
    return false
  }
}

export function gatewayAutoStartManagementMode(policy?: GatewayAutoStartConfig): GatewayManagementMode {
  return policy?.management === 'per_profile' || policy?.management === 'unified' ? policy.management : 'auto'
}

export function shouldUseUnifiedGatewayManagement(
  policy?: GatewayAutoStartConfig,
  defaultProfileDir = getProfileDir('default'),
): boolean {
  const mode = gatewayAutoStartManagementMode(policy)
  if (mode === 'unified') return true
  if (mode === 'per_profile') return false
  return gatewayMultiplexConfigEnabledForDefaultProfile(defaultProfileDir)
}

export function resolveGatewayTargetProfile(profile: string, unified: boolean): GatewayRuntimeTarget {
  const requestedProfile = String(profile || '').trim() || 'default'
  return {
    requestedProfile,
    targetProfile: unified ? 'default' : requestedProfile,
    unified,
  }
}

export function selectGatewayProfilesForAutostart(
  profiles: string[],
  policy?: GatewayAutoStartConfig,
  unified = false,
): string[] {
  const selected = selectProfilesForGatewayAutostart(profiles, policy)
  if (!unified || selected.length === 0) return selected
  return profiles.includes('default') ? ['default'] : [selected[0]]
}

function envFlagDisabled(name: string): boolean {
  const normalized = String(process.env[name] || '').trim().toLowerCase()
  return ['0', 'false', 'no', 'off'].includes(normalized)
}

function envValueFlagEnabled(value: unknown): boolean {
  const normalized = String(value || '').trim().toLowerCase()
  return ['1', 'true', 'yes', 'on'].includes(normalized)
}

function envFlagEnabledIn(env: NodeJS.ProcessEnv, name: string): boolean {
  return envValueFlagEnabled(env[name])
}

export function gatewayAutostartDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlagEnabledIn(env, 'HERMES_WEB_UI_DISABLE_GATEWAY_AUTOSTART')
}

function envFlagDisabledIn(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = String(env[name] || '').trim().toLowerCase()
  return ['1', 'true', 'yes', 'on'].includes(value)
}

export function shouldRecoverWindowsDesktopGatewayOrphans(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (platform !== 'win32') return false
  if (!envFlagEnabledIn(env, 'HERMES_DESKTOP')) return false
  return !envFlagDisabledIn(env, 'HERMES_WEB_UI_DISABLE_GATEWAY_STARTUP_RECOVERY')
}

function listGatewayRuntimeProfileDirs(hermesHome?: string): string[] {
  const base = hermesHome || getProfileDir('default')
  const dirs = new Set<string>([base])
  const profilesRoot = join(base, 'profiles')
  try {
    for (const entry of readdirSync(profilesRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.trim()) {
        dirs.add(join(profilesRoot, entry.name))
      }
    }
  } catch {}
  return [...dirs]
}

function readGatewayRuntimePid(path: string, fileName: string): number | null {
  if (!existsSync(path)) return null
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'))
    if (fileName === 'gateway_state.json') {
      const state = String(data?.gateway_state || '').toLowerCase()
      if (state && state !== 'running' && state !== 'starting') return null
    }
    const pid = typeof data?.pid === 'number' ? data.pid : parseInt(String(data?.pid || ''), 10)
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

async function taskkillWindowsProcessTree(pid: number): Promise<void> {
  await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
    timeout: 5000,
    windowsHide: true,
  })
}

export interface GatewayStartupRecoveryResult {
  attempted: boolean
  profileDirs: string[]
  stoppedProfileDirs: string[]
  killedPids: number[]
  deletedFiles: string[]
  errors: number
}

export async function recoverWindowsDesktopGatewayOrphans(opts: {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  hermesHome?: string
  isAlive?: (pid: number) => boolean
  stopGateway?: (profileDir: string) => Promise<void>
  execTaskkill?: (pid: number) => Promise<void>
  unlinkFile?: (path: string) => void
} = {}): Promise<GatewayStartupRecoveryResult> {
  const platform = opts.platform || process.platform
  const env = opts.env || process.env
  if (!shouldRecoverWindowsDesktopGatewayOrphans(platform, env)) {
    return { attempted: false, profileDirs: [], stoppedProfileDirs: [], killedPids: [], deletedFiles: [], errors: 0 }
  }

  const isAlive = opts.isAlive || isProcessAlive
  const stopGateway = opts.stopGateway || (async (profileDir: string) => {
    await execHermesWithBin(resolveHermesBin(), ['gateway', 'stop'], {
      timeout: 10000,
      windowsHide: true,
      env: {
        ...process.env,
        HERMES_HOME: profileDir,
      },
    })
  })
  const execTaskkill = opts.execTaskkill || taskkillWindowsProcessTree
  const unlinkFile = opts.unlinkFile || unlinkSync
  const profileDirs = listGatewayRuntimeProfileDirs(opts.hermesHome)
  const pids = new Set<number>()

  for (const profileDir of profileDirs) {
    for (const fileName of GATEWAY_RUNTIME_FILES) {
      const pid = readGatewayRuntimePid(join(profileDir, fileName), fileName)
      if (pid !== null) pids.add(pid)
    }
  }

  const stoppedProfileDirs: string[] = []
  const killedPids: number[] = []
  const deletedFiles: string[] = []
  let errors = 0

  for (const profileDir of profileDirs) {
    try {
      await stopGateway(profileDir)
      stoppedProfileDirs.push(profileDir)
    } catch (err) {
      errors += 1
      logger.warn(err, '[gateway-autostart] Hermes gateway stop failed during Windows desktop startup recovery profileDir=%s', profileDir)
    }
  }

  for (const pid of pids) {
    if (!isAlive(pid)) continue
    try {
      await execTaskkill(pid)
      killedPids.push(pid)
    } catch (err) {
      errors += 1
      logger.warn(err, '[gateway-autostart] failed to recover orphan Windows gateway PID %d', pid)
    }
  }

  for (const profileDir of profileDirs) {
    for (const fileName of GATEWAY_RUNTIME_FILES) {
      const filePath = join(profileDir, fileName)
      if (!existsSync(filePath)) continue
      try {
        unlinkFile(filePath)
        deletedFiles.push(filePath)
      } catch (err) {
        errors += 1
        logger.warn(err, '[gateway-autostart] failed to remove gateway runtime file %s', filePath)
      }
    }
  }

  if (killedPids.length || deletedFiles.length) {
    logger.warn(
      '[gateway-autostart] recovered Windows desktop gateway runtime before startup killedPids=%s deletedFiles=%s',
      killedPids.join(',') || 'none',
      deletedFiles.length,
    )
  }

  return { attempted: true, profileDirs, stoppedProfileDirs, killedPids, deletedFiles, errors }
}

let windowsDesktopGatewayRecoveryAttempted = false

async function recoverWindowsDesktopGatewayOrphansOnce(): Promise<void> {
  if (windowsDesktopGatewayRecoveryAttempted) return
  windowsDesktopGatewayRecoveryAttempted = true
  await recoverWindowsDesktopGatewayOrphans()
}

export function shouldUseManagedGatewayRun(): boolean {
  return !envFlagDisabled('HERMES_WEB_UI_MANAGED_GATEWAY')
}

export function shouldUseManagedGatewayRunForAutostart(platform: NodeJS.Platform = process.platform): boolean {
  void platform
  return !envFlagDisabled('HERMES_WEB_UI_MANAGED_GATEWAY')
}

export function gatewayStatusLooksRunning(output: string): boolean {
  const text = output.toLowerCase()
  if (text.includes('gateway is not running') || text.includes('not running')) return false
  return text.includes('gateway is running') || text.includes('running')
}

export function gatewayStatusLooksRuntimeLocked(output: string): boolean {
  const text = output.toLowerCase()
  return text.includes('runtime lock is already held')
    || text.includes('gateway runtime lock is already held')
    || text.includes('already held by another instance')
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
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

export function gatewayStateLooksRunningForProfile(profileDir: string): boolean {
  const statePath = join(profileDir, 'gateway_state.json')
  if (existsSync(statePath)) {
    try {
      const data = JSON.parse(readFileSync(statePath, 'utf-8'))
      const state = String(data?.gateway_state || '').toLowerCase()
      const pid = typeof data?.pid === 'number' ? data.pid : parseInt(String(data?.pid || ''), 10)
      if ((state === 'running' || state === 'starting') && isProcessAlive(pid)) return true
    } catch {}
  }

  const pid = readJsonPid(join(profileDir, 'gateway.pid'))
  return pid !== null && isProcessAlive(pid)
}

export function parseGatewayStatusesFromProfileListOutput(stdout: string, profileNames = listProfileNamesFromDisk()): Map<string, string> {
  return parseGatewayStatusesFromProfileList(stdout, profileNames)
}

async function listGatewayStatusesFromProfileList(hermesBin: string): Promise<Map<string, string>> {
  const { stdout } = await execHermesWithBin(hermesBin, ['profile', 'list'], {
    timeout: 10000,
    windowsHide: true,
  })
  return parseGatewayStatusesFromProfileListOutput(stdout)
}

async function isGatewayRunningInProfileList(hermesBin: string, profile: string): Promise<boolean> {
  const statuses = await listGatewayStatusesFromProfileList(hermesBin)
  const status = statuses.get(profile)
  return status !== undefined && gatewayStatusLooksRunning(status)
}

export async function isGatewayRunningForProfile(hermesBin: string, profileDir: string): Promise<boolean> {
  if (gatewayStateLooksRunningForProfile(profileDir)) return true

  try {
    const { stdout, stderr } = await execHermesWithBin(hermesBin, ['gateway', 'status'], {
      timeout: 10000,
      windowsHide: true,
      env: {
        ...process.env,
        HERMES_HOME: profileDir,
      },
    })
    return gatewayStatusLooksRunning(`${stdout}\n${stderr}`)
  } catch (err: any) {
    const output = `${err?.stdout || ''}\n${err?.stderr || ''}\n${err?.message || ''}`
    if (gatewayStatusLooksRuntimeLocked(output)) {
      logger.info({ profileDir }, 'Hermes gateway status reported runtime lock held; treating gateway as already running')
      return true
    }
    if (output.trim()) {
      logger.warn({ err, profileDir }, 'Hermes gateway status failed; treating as not running')
    }
    return false
  }
}

async function waitForGatewayRunning(hermesBin: string, profile: string, profileDir: string, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await isGatewayRunningInProfileList(hermesBin, profile)) return true
    } catch (err) {
      logger.warn(err, '[gateway-autostart] Hermes profile list check failed while waiting for gateway profile=%s', profile)
    }
    if (await isGatewayRunningForProfile(hermesBin, profileDir)) return true
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return false
}

async function stopGatewayForProfile(
  hermesBin: string,
  profile: string,
  profileDir: string,
  opts: { retireManaged?: boolean } = {},
): Promise<void> {
  if (opts.retireManaged) {
    writeGatewayDesiredStopped(profileDir)
    try {
      await retireManagedGatewayForProfile(profileDir, { timeoutMs: 2000 })
    } catch (err) {
      logger.warn(err, '[gateway-autostart] failed to retire managed gateway before stop profile=%s home=%s', profile, profileDir)
    }
  }

  try {
    await execHermesWithBin(hermesBin, ['gateway', 'stop'], {
      timeout: 30000,
      windowsHide: true,
      env: {
        ...process.env,
        HERMES_HOME: profileDir,
      },
    })
    logger.info('[gateway-autostart] gateway stopped profile=%s home=%s', profile, profileDir)
  } catch (err) {
    logger.warn(err, '[gateway-autostart] Hermes CLI gateway stop failed before restart profile=%s home=%s', profile, profileDir)
  }
}

function uniqueProfiles(profiles: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const profile of profiles) {
    const name = String(profile || '').trim() || 'default'
    if (seen.has(name)) continue
    seen.add(name)
    result.push(name)
  }
  return result
}

export async function reconcileGatewayManagementTransition(
  previousPolicy: GatewayAutoStartConfig | undefined,
  nextPolicy: GatewayAutoStartConfig | undefined,
  opts: {
    hermesBin?: string
    profiles?: string[]
    stopGateway?: (profile: string, profileDir: string) => Promise<void>
    startGateway?: (profile: string, profileDir: string) => Promise<void>
    waitForGateway?: (profile: string, profileDir: string) => Promise<boolean>
  } = {},
): Promise<GatewayManagementTransitionResult> {
  const previousUnified = shouldUseUnifiedGatewayManagement(previousPolicy)
  const nextUnified = shouldUseUnifiedGatewayManagement(nextPolicy)
  const result: GatewayManagementTransitionResult = {
    changed: previousUnified !== nextUnified,
    previousUnified,
    nextUnified,
    stoppedProfiles: [],
    startedProfiles: [],
  }
  if (!result.changed) return result

  const hermesBin = opts.hermesBin || resolveHermesBin()
  const profiles = opts.profiles || listProfileNamesFromDisk()
  const stopProfiles = uniqueProfiles(previousUnified ? ['default'] : profiles)
  const startProfiles = uniqueProfiles(nextUnified
    ? selectGatewayProfilesForAutostart(profiles, nextPolicy, true)
    : selectProfilesForGatewayAutostart(profiles, nextPolicy))
  const stopGateway = opts.stopGateway || ((profile: string, profileDir: string) =>
    stopGatewayForProfile(hermesBin, profile, profileDir, { retireManaged: true }))
  const startGateway = opts.startGateway || ((profile: string, profileDir: string) =>
    startGatewayForProfile(hermesBin, profile, profileDir, { managedRun: shouldUseManagedGatewayRunForAutostart() }))
  const waitForGateway = opts.waitForGateway || ((profile: string, profileDir: string) =>
    waitForGatewayRunning(hermesBin, profile, profileDir))

  logger.info(
    '[gateway-autostart] reconciling gateway management previousUnified=%s nextUnified=%s stopProfiles=%s startProfiles=%s',
    previousUnified,
    nextUnified,
    stopProfiles.join(',') || 'none',
    startProfiles.join(',') || 'none',
  )

  for (const profile of stopProfiles) {
    const profileDir = getProfileDir(profile)
    await stopGateway(profile, profileDir)
    result.stoppedProfiles.push(profile)
  }

  for (const profile of startProfiles) {
    if (isReservedProfileName(profile)) {
      logger.warn('[gateway-autostart] skipping reserved profile name during gateway management reconcile profile=%s', profile)
      continue
    }

    const profileDir = getProfileDir(profile)
    await startGateway(profile, profileDir)
    const ready = await waitForGateway(profile, profileDir)
    if (!ready) {
      logger.warn('[gateway-autostart] gateway start completed but did not report running during management reconcile profile=%s home=%s', profile, profileDir)
    }
    result.startedProfiles.push(profile)
  }

  return result
}

function writeGatewayDesiredStopped(profileDir: string): void {
  if (!existsSync(profileDir)) return
  const statePath = join(profileDir, 'gateway_state.json')
  try {
    writeFileSync(
      statePath,
      JSON.stringify({
        gateway_state: 'stopped',
        desired_state: 'stopped',
        updated_at: new Date().toISOString(),
      }, null, 2),
      'utf-8',
    )
  } catch (err) {
    logger.warn(err, '[gateway-autostart] failed to mark gateway desired stopped before profile delete profileDir=%s', profileDir)
  }
}

function getProfileDirForDelete(profile: string): string {
  if (!profile || profile === 'default') return getProfileDir(profile)
  return join(getHermesBaseDir(), 'profiles', profile)
}

export async function prepareGatewayForProfileDelete(
  profile: string,
  options: { useHermesCli?: boolean } = {},
): Promise<void> {
  const hermesBin = resolveHermesBin()
  const profileDir = getProfileDirForDelete(profile)

  if (!existsSync(profileDir)) {
    logger.info('[gateway-autostart] skipping profile delete gateway prep for missing profile profile=%s home=%s', profile, profileDir)
    return
  }

  writeGatewayDesiredStopped(profileDir)

  try {
    await retireManagedGatewayForProfile(profileDir, { timeoutMs: 2000 })
  } catch (err) {
    logger.warn(err, '[gateway-autostart] failed to retire managed gateway before profile delete profile=%s home=%s', profile, profileDir)
  }

  if (options.useHermesCli === false) return

  try {
    await execHermesWithBin(hermesBin, ['gateway', 'stop'], {
      timeout: 10000,
      windowsHide: true,
      env: {
        ...process.env,
        HERMES_HOME: profileDir,
      },
    })
    logger.info('[gateway-autostart] gateway stopped before profile delete profile=%s home=%s', profile, profileDir)
  } catch (err) {
    logger.warn(err, '[gateway-autostart] Hermes gateway stop failed before profile delete profile=%s home=%s', profile, profileDir)
  }
}

export async function startGatewayForProfile(
  hermesBin: string,
  profile: string,
  profileDir: string,
  opts: { managedRun?: boolean } = {},
): Promise<void> {
  if (opts.managedRun ?? shouldUseManagedGatewayRun()) {
    const result = startGatewayRunManaged(hermesBin, { profileDir })
    logger.info(
      '[gateway-autostart] gateway started via background run profile=%s home=%s pid=%s',
      profile,
      profileDir,
      result.pid || 'unknown',
    )
    return
  }

  try {
    await execHermesWithBin(hermesBin, ['gateway', 'start'], {
      timeout: 30000,
      windowsHide: true,
      env: {
        ...process.env,
        HERMES_HOME: profileDir,
      },
    })
    logger.info('[gateway-autostart] gateway started via Hermes CLI service profile=%s home=%s', profile, profileDir)
  } catch (err) {
    logger.warn(err, '[gateway-autostart] Hermes CLI gateway start failed; falling back to background run profile=%s home=%s', profile, profileDir)
    const result = startGatewayRunManaged(hermesBin, { profileDir })
    logger.info(
      '[gateway-autostart] gateway started via fallback background run profile=%s home=%s pid=%s',
      profile,
      profileDir,
      result.pid || 'unknown',
    )
  }
}

export async function getGatewayRuntimeStatusForProfile(profile: string): Promise<{
  running: boolean
  profile: string
  targetProfile?: string
  unified?: boolean
}> {
  const hermesBin = resolveHermesBin()
  const { gatewayAutoStart } = await readAppConfig()
  const target = resolveGatewayTargetProfile(profile, shouldUseUnifiedGatewayManagement(gatewayAutoStart))
  const profileDir = getProfileDir(target.targetProfile)
  const running = await isGatewayRunningForProfile(hermesBin, profileDir)
  return {
    running,
    profile: target.requestedProfile,
    targetProfile: target.targetProfile,
    unified: target.unified,
  }
}

export async function restartGatewayForProfile(profile: string): Promise<{
  running: boolean
  profile: string
  targetProfile?: string
  unified?: boolean
}> {
  const hermesBin = resolveHermesBin()
  const { gatewayAutoStart } = await readAppConfig()
  const target = resolveGatewayTargetProfile(profile, shouldUseUnifiedGatewayManagement(gatewayAutoStart))
  const profileDir = getProfileDir(target.targetProfile)
  await stopGatewayForProfile(hermesBin, target.targetProfile, profileDir)

  try {
    await startGatewayForProfile(hermesBin, target.targetProfile, profileDir, { managedRun: shouldUseManagedGatewayRun() })
  } catch (err) {
    logger.error(
      err,
      '[gateway-autostart] Hermes gateway restart failed requestedProfile=%s targetProfile=%s home=%s',
      target.requestedProfile,
      target.targetProfile,
      profileDir,
    )
    throw err
  }

  const running = await waitForGatewayRunning(hermesBin, target.targetProfile, profileDir)
  if (!running) throw new Error('Hermes gateway start completed but gateway did not report running within timeout')
  return {
    running,
    profile: target.requestedProfile,
    targetProfile: target.targetProfile,
    unified: target.unified,
  }
}

export async function ensureProfileGatewaysRunning(): Promise<void> {
  const { gatewayAutoStart } = await readAppConfig()
  if (gatewayAutoStart?.enabled !== true) return

  await recoverWindowsDesktopGatewayOrphansOnce()

  const hermesBin = resolveHermesBin()
  const discoveredProfiles = listProfileNamesFromDisk()
  const unified = shouldUseUnifiedGatewayManagement(gatewayAutoStart)
  const profiles = selectGatewayProfilesForAutostart(discoveredProfiles, gatewayAutoStart, unified)
  const skippedProfiles = discoveredProfiles.filter(profile => !profiles.includes(profile))
  if (skippedProfiles.length > 0) {
    logger.info(
      '[gateway-autostart] skipping profiles excluded by gatewayAutoStart policy profiles=%s unified=%s',
      skippedProfiles.join(','),
      unified,
    )
  }
  if (profiles.length === 0) return
  let gatewayStatuses: Map<string, string> | undefined
  try {
    gatewayStatuses = await listGatewayStatusesFromProfileList(hermesBin)
  } catch (err) {
    logger.warn(err, '[gateway-autostart] Hermes profile list failed; falling back to per-profile gateway status checks')
  }

  for (const profile of profiles) {
    if (isReservedProfileName(profile)) {
      logger.warn('[gateway-autostart] skipping reserved profile name during gateway autostart profile=%s', profile)
      continue
    }

    const profileDir = getProfileDir(profile)
    const status = gatewayStatuses?.get(profile)
    const running = status !== undefined && gatewayStatusLooksRunning(status)
      ? true
      : await isGatewayRunningForProfile(hermesBin, profileDir)
    if (running) {
      logger.info('[gateway-autostart] gateway already running profile=%s home=%s status=%s', profile, profileDir, status || 'status-check')
      continue
    }

    await startGatewayForProfile(hermesBin, profile, profileDir, { managedRun: shouldUseManagedGatewayRunForAutostart() })
    const ready = await waitForGatewayRunning(hermesBin, profile, profileDir)
    if (!ready) {
      logger.warn('[gateway-autostart] gateway start completed but did not report running within timeout profile=%s home=%s', profile, profileDir)
    }
  }
}
