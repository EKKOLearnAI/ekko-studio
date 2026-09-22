import { createReadStream, existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { basename, join } from 'path'
import { tmpdir } from 'os'
import { getWebUiHome } from '../../studio/public/config'
import * as hermesCli from '../services/runtime/cli'
import { SessionDeleter } from '../services/history/session-deleter'
import { AgentBridgeClient } from '../services/bridge'
import {
  getGatewayRuntimeStatusForProfile,
  prepareGatewayForProfileDelete,
  restartGatewayForProfile as restartGatewayRuntimeForProfile,
} from '../services/gateway/autostart'
import { logger } from '../../studio/public/logging'
import { smartCloneCleanup, copyModelProviderAuthForClone, copyProfileContentsForClone } from '../services/profiles/profile-credentials'
import { detectHermesRootHome } from '../services/runtime/path'
import { getActiveProfileName } from '../services/profiles/profile'
import {
  createProfileWithoutHermes,
  deleteProfileWithoutHermes,
  isReservedProfileName,
  normalizeProfileName,
  ProfileLifecycleError,
  validateProfileName,
} from '../services/profiles/lifecycle'
import { exportProfileWithoutHermes, importProfileWithoutHermes } from '../services/profiles/archive'
import { HermesSkillInjector } from '../services/skills/injector'
import type { HermesProfile } from '../services/runtime/cli'
import { listUserProfiles } from '../../studio/public/users'
import { isHermesAgentAvailable } from '../../studio/public/agent-status-registry'
import { readAppProfileAvatar } from '../services/profiles/app-profile-avatar'

const bridgeCleanupClient = () => new AgentBridgeClient({ connectRetryMs: 0, timeoutMs: 5000 })
const bridgeProfileRestartClient = () => new AgentBridgeClient({ connectRetryMs: 0 })

interface ProfileAvatarMeta {
  type: 'generated' | 'image'
  seed?: string
  file?: string
  mime?: string
  updatedAt?: number
}

interface ProfileAvatarResponse {
  type: 'generated' | 'image'
  seed?: string
  dataUrl?: string
  updatedAt?: number
}

type RuntimeStatus = Awaited<ReturnType<typeof buildRuntimeStatus>>

interface RuntimeStatusCacheEntry {
  status: RuntimeStatus
  updatedAt: number
}

const runtimeStatusCache = new Map<string, RuntimeStatusCacheEntry>()
let runtimeStatusRefreshPromise: Promise<void> | null = null
let runtimeStatusMinimumFreshAt = 0

function isForbiddenProfileName(name: string): boolean {
  const normalized = normalizeProfileName(name)
  if (!normalized || normalized === 'default') return false
  if (isReservedProfileName(normalized)) return true
  try {
    validateProfileName(normalized)
    return false
  } catch {
    return true
  }
}

function getActiveProfileFile(): string {
  return join(detectHermesRootHome(), 'active_profile')
}

function listProfilesFromDisk(activeProfileName: string): HermesProfile[] {
  const base = detectHermesRootHome()
  const profiles: HermesProfile[] = [{
    name: 'default',
    active: activeProfileName === 'default',
    model: '—',
    alias: '',
  }]
  const profilesDir = join(base, 'profiles')
  if (!existsSync(profilesDir)) return profiles
  for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const name = entry.name
    const dir = join(profilesDir, name)
    if (!existsSync(join(dir, 'config.yaml')) && !existsSync(dir)) continue
    profiles.push({
      name,
      active: name === activeProfileName,
      model: '—',
      alias: '',
    })
  }
  return profiles
}

function profileExistsForManualSwitch(name: string): boolean {
  const base = detectHermesRootHome()
  if (!name || name === 'default') return true
  return existsSync(join(base, 'profiles', name, 'config.yaml')) || existsSync(join(base, 'profiles', name))
}

async function injectBundledSkillsForProfile(name: string): Promise<void> {
  try {
    const targetDir = HermesSkillInjector.resolveTargetDirForProfile(name)
    const result = await new HermesSkillInjector(undefined, targetDir).injectMissingSkills()
    const target = result.targets[0]
    if (target && (target.injected.length > 0 || target.updated.length > 0)) {
      logger.info({
        profile: name,
        targetDir,
        injected: target.injected,
        updated: target.updated,
      }, '[profiles] synced bundled skills for profile')
    }
  } catch (err: any) {
    logger.warn(err, '[profiles] failed to sync bundled skills for profile "%s"', name)
  }
}

function profileDirectoryExists(name: string): boolean {
  if (!name || name === 'default') return true
  const base = detectHermesRootHome()
  return existsSync(join(base, 'profiles', name))
}

function filterVisibleProfiles(profiles: HermesProfile[]): HermesProfile[] {
  return profiles.filter(profile => !isForbiddenProfileName(profile.name))
}

function requestedProfileName(ctx: any): string {
  return ctx.state?.profile?.name || ctx.get?.('x-hermes-profile') || getActiveProfileName()
}

function filterProfilesForUser(ctx: any, profiles: HermesProfile[]): HermesProfile[] {
  const user = ctx.state?.user
  if (!user || user.role === 'super_admin') return profiles
  const allowed = new Set(listUserProfiles(user.id).map(profile => profile.profile_name))
  return profiles.filter(profile => allowed.has(profile.name))
}

function canAccessProfile(ctx: any, profileName: string): boolean {
  const user = ctx.state?.user
  if (!user || user.role === 'super_admin') return true
  return listUserProfiles(user.id).some(profile => profile.profile_name === profileName)
}

function denyProfile(ctx: any, profileName: string): boolean {
  if (canAccessProfile(ctx, profileName)) return false
  ctx.status = 403
  ctx.body = { error: `Profile "${profileName}" is not available for this user` }
  return true
}

function profileMetadataRoot(): string {
  return join(getWebUiHome(), 'profile-metadata')
}

function profileMetadataDir(name: string): string {
  const segment = Buffer.from(name || 'default', 'utf-8').toString('base64url')
  return join(profileMetadataRoot(), segment)
}

function profileAvatarMetaPath(name: string): string {
  return join(profileMetadataDir(name), 'avatar.json')
}

function profileAvatarImagePath(name: string, file = 'avatar.bin'): string {
  return join(profileMetadataDir(name), file)
}

function readProfileAvatar(name: string): ProfileAvatarResponse | null {
  const metaPath = profileAvatarMetaPath(name)
  if (!existsSync(metaPath)) return null
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as ProfileAvatarMeta
    if (meta.type === 'generated') {
      return {
        type: 'generated',
        seed: typeof meta.seed === 'string' ? meta.seed : name,
        updatedAt: meta.updatedAt,
      }
    }
    if (meta.type === 'image' && meta.file && meta.mime) {
      const imagePath = profileAvatarImagePath(name, meta.file)
      if (!existsSync(imagePath)) return null
      const data = readFileSync(imagePath).toString('base64')
      return {
        type: 'image',
        dataUrl: `data:${meta.mime};base64,${data}`,
        updatedAt: meta.updatedAt,
      }
    }
  } catch (err) {
    logger.warn(err, '[profiles] failed to read avatar metadata for profile "%s"', name)
  }
  return null
}

function attachProfileAvatars<T extends HermesProfile>(profiles: T[]): Array<T & { avatar: ProfileAvatarResponse | null }> {
  return profiles.map(profile => ({
    ...profile,
    avatar: readProfileAvatar(profile.name),
  }))
}

async function attachAppProfileAvatars<T extends HermesProfile>(
  profiles: T[],
): Promise<Array<T & { avatar: ProfileAvatarResponse | null }>> {
  return Promise.all(profiles.map(async profile => ({
    ...profile,
    avatar: await readAppProfileAvatar(profile.name),
  })))
}

function parseAvatarDataUrl(dataUrl: string): { mime: string; buffer: Buffer } {
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([a-zA-Z0-9+/=]+)$/)
  if (!match) throw new Error('Avatar image must be a PNG, JPEG, or WebP data URL')
  const buffer = Buffer.from(match[2], 'base64')
  if (buffer.length > 1024 * 1024) throw new Error('Avatar image must be 1MB or smaller')
  return { mime: match[1], buffer }
}

function removeProfileMetadata(name: string): void {
  rmSync(profileMetadataDir(name), { recursive: true, force: true })
}

function renameProfileMetadata(oldName: string, newName: string): void {
  const oldDir = profileMetadataDir(oldName)
  const newDir = profileMetadataDir(newName)
  if (!existsSync(oldDir) || oldDir === newDir) return
  rmSync(newDir, { recursive: true, force: true })
  renameSync(oldDir, newDir)
}

async function useProfileWithFallback(name: string): Promise<string> {
  if (isForbiddenProfileName(name)) {
    throw new Error(`Profile name '${name}' is reserved and cannot be activated`)
  }
  try {
    return await hermesCli.useProfile(name)
  } catch (err: any) {
    if (!profileExistsForManualSwitch(name)) throw err

    const base = detectHermesRootHome()
    writeFileSync(join(base, 'active_profile'), `${name}\n`, 'utf-8')
    logger.warn(err, '[switchProfile] hermes profile use failed; wrote active_profile directly for existing profile "%s"', name)
    return `Switched to profile ${name}`
  }
}

async function readBridgeWorkers(): Promise<{ reachable: boolean; workers: Record<string, boolean>; error?: string }> {
  try {
    const result = await new AgentBridgeClient({ timeoutMs: 5000 }).ping()
    return {
      reachable: true,
      workers: ((result as any).workers || {}) as Record<string, boolean>,
    }
  } catch (err: any) {
    return {
      reachable: false,
      workers: {},
      error: err?.message || 'Bridge broker is not reachable',
    }
  }
}

function gatewayStatusLooksRunning(status?: string): boolean {
  const normalized = String(status || '').trim().toLowerCase()
  if (!normalized || normalized === '—') return false
  if (normalized.includes('not running') || normalized === 'stopped' || normalized === 'stop') return false
  return normalized.includes('running') || normalized === 'active'
}

async function buildRuntimeStatus(profile: HermesProfile | string, bridgeState?: Awaited<ReturnType<typeof readBridgeWorkers>>) {
  const name = typeof profile === 'string' ? profile : profile.name
  const bridge = bridgeState || await readBridgeWorkers()
  let gateway: { running: boolean; profile: string; error?: string }
  if (typeof profile !== 'string' && profile.gatewayStatus !== undefined) {
    const profileListRunning = gatewayStatusLooksRunning(profile.gatewayStatus)
    if (profileListRunning) {
      gateway = {
        running: true,
        profile: name,
      }
    } else {
      try {
        gateway = await getGatewayRuntimeStatusForProfile(name)
      } catch (err: any) {
        gateway = {
          running: false,
          profile: name,
          error: err?.message || 'Gateway status check failed',
        }
      }
    }
  } else {
    try {
      gateway = await getGatewayRuntimeStatusForProfile(name)
    } catch (err: any) {
      gateway = {
        running: false,
        profile: name,
        error: err?.message || 'Gateway status check failed',
      }
    }
  }

  return {
    profile: name,
    bridge: {
      running: !!bridge.workers[name],
      profile: name,
      reachable: bridge.reachable,
      error: bridge.reachable ? undefined : bridge.error,
    },
    gateway,
  }
}

function setRuntimeStatusCache(status: RuntimeStatus, checkedAt = Date.now()): void {
  runtimeStatusCache.set(status.profile, {
    status,
    updatedAt: checkedAt,
  })
}

function listProfilesForStatusFast(): HermesProfile[] {
  return filterVisibleProfiles(listProfilesFromDisk(getActiveProfileName()))
}

async function refreshRuntimeStatusCache(checkedAt: number): Promise<void> {
  const profiles = await listProfilesForStatus()
  const bridge = await readBridgeWorkers()
  const statuses = await Promise.all(profiles.map(profile => buildRuntimeStatus(profile, bridge)))
  statuses.forEach(status => setRuntimeStatusCache(status, checkedAt))
}

function startRuntimeStatusRefresh(): void {
  const startedAt = Date.now()
  runtimeStatusRefreshPromise = refreshRuntimeStatusCache(startedAt)
    .catch((err) => {
      logger.warn(err, '[profiles] failed to refresh runtime status cache')
    })
    .finally(() => {
      runtimeStatusRefreshPromise = null
      if (runtimeStatusMinimumFreshAt > startedAt) {
        startRuntimeStatusRefresh()
      }
    })
}

function scheduleRuntimeStatusRefresh(): void {
  runtimeStatusMinimumFreshAt = Math.max(runtimeStatusMinimumFreshAt, Date.now())
  if (runtimeStatusRefreshPromise) return
  startRuntimeStatusRefresh()
}

function respondWithProfileLifecycleError(ctx: any, err: unknown): boolean {
  if (!(err instanceof ProfileLifecycleError)) return false
  ctx.status = err.status
  ctx.body = { error: err.message, code: err.code }
  return true
}

export async function list(ctx: any) {
  try {
    let profiles: HermesProfile[]
    if (!isHermesAgentAvailable()) {
      profiles = listProfilesFromDisk(getActiveProfileName())
    } else {
      try {
        profiles = await hermesCli.listProfiles()
      } catch (err: any) {
        const activeProfileName = getActiveProfileName()
        if (!isForbiddenProfileName(activeProfileName)) throw err

        logger.warn(err, '[listProfiles] active_profile "%s" is invalid/reserved; resetting to default and listing profiles from disk', activeProfileName)
        writeFileSync(getActiveProfileFile(), 'default\n', 'utf-8')
        profiles = listProfilesFromDisk('default')
      }
    }

    const activeProfileName = requestedProfileName(ctx)

    profiles = filterVisibleProfiles(profiles)
    profiles = filterProfilesForUser(ctx, profiles)

    // Web UI active profile is request-scoped and comes from X-Hermes-Profile.
    profiles.forEach(p => {
      p.active = (p.name === activeProfileName)
    })

    ctx.body = { profiles: attachProfileAvatars(profiles) }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function listForApp(ctx: any) {
  try {
    let profiles: HermesProfile[]
    if (!isHermesAgentAvailable()) {
      profiles = listProfilesFromDisk(getActiveProfileName())
    } else {
      try {
        profiles = await hermesCli.listProfiles()
      } catch (err: any) {
        const activeProfileName = getActiveProfileName()
        if (!isForbiddenProfileName(activeProfileName)) throw err

        logger.warn(err, '[listAppProfiles] active_profile "%s" is invalid/reserved; resetting to default and listing profiles from disk', activeProfileName)
        writeFileSync(getActiveProfileFile(), 'default\n', 'utf-8')
        profiles = listProfilesFromDisk('default')
      }
    }

    const activeProfileName = requestedProfileName(ctx)
    profiles = filterProfilesForUser(ctx, filterVisibleProfiles(profiles))
    profiles.forEach(profile => {
      profile.active = profile.name === activeProfileName
    })

    ctx.body = { profiles: await attachAppProfileAvatars(profiles) }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function create(ctx: any) {
  const { name: requestedName, clone, cloneFrom } = ctx.request.body as {
    name?: string
    clone?: boolean
    cloneFrom?: string
  }
  try {
    const name = validateProfileName(requestedName)

    // An explicit source wins; otherwise preserve the existing active-profile clone behaviour.
    const activeName = normalizeProfileName(getActiveProfileName()) || 'default'
    let cloneSource = ''
    if (clone || cloneFrom) {
      cloneSource = validateProfileName(cloneFrom || activeName, { allowDefault: true })
      if (!profileDirectoryExists(cloneSource)) {
        ctx.status = 400
        ctx.body = { error: `Clone source profile '${cloneSource}' not found` }
        return
      }
      if (!canAccessProfile(ctx, cloneSource)) {
        ctx.status = 403
        ctx.body = { error: `No access to profile '${cloneSource}'` }
        return
      }
    }

    // Both native paths clone only the active profile. For another source, create
    // an empty profile first and copy the same user-owned files explicitly.
    const cloneViaActiveProfile = !!cloneSource && cloneSource === activeName
    const useHermes = isHermesAgentAvailable()
    const output = useHermes
      ? await hermesCli.createProfile(name, cloneViaActiveProfile)
      : `Profile '${(await createProfileWithoutHermes(name, cloneViaActiveProfile)).name}' created by Studio`
    if (cloneSource && !cloneViaActiveProfile) {
      const copied = copyProfileContentsForClone(cloneSource, name)
      logger.info('Cloned profile "%s" from "%s": copied %s', name, cloneSource, copied.join(',') || 'nothing')
    }

    // 克隆时执行智能清理：
    //   - 删除 .env 中的独占平台凭据（Weixin / Telegram / Slack / ...）
    //   - 禁用 config.yaml 中对应的平台节点
    // 避免新 profile 与源 profile 共享同一个 bot token 导致互斥冲突。
    let strippedCredentials: string[] = []
    let disabledPlatforms: string[] = []
    let strippedConfigCredentials: string[] = []
    let copiedAuthProviders: string[] = []
    if (cloneSource) {
      try {
        copiedAuthProviders = copyModelProviderAuthForClone(name, cloneSource)
        const cleanup = smartCloneCleanup(name)
        strippedCredentials = cleanup.strippedCredentials
        disabledPlatforms = cleanup.disabledPlatforms
        strippedConfigCredentials = cleanup.strippedConfigCredentials
        if (
          strippedCredentials.length > 0 ||
          disabledPlatforms.length > 0 ||
          strippedConfigCredentials.length > 0 ||
          copiedAuthProviders.length > 0
        ) {
          logger.info(
            'Smart clone cleanup for "%s": copied auth for %d model providers (%s), stripped %d env credentials (%s), disabled %d platforms (%s), stripped %d config credentials (%s)',
            name,
            copiedAuthProviders.length, copiedAuthProviders.join(','),
            strippedCredentials.length, strippedCredentials.join(','),
            disabledPlatforms.length, disabledPlatforms.join(','),
            strippedConfigCredentials.length, strippedConfigCredentials.join(','),
          )
        }
      } catch (err: any) {
        // 清理失败不应阻断 profile 创建，仅记日志
        logger.error(err, 'Smart clone cleanup failed for "%s"', name)
      }
    }

    await injectBundledSkillsForProfile(name)
    setRuntimeStatusCache({
      profile: name,
      bridge: { running: false, profile: name, reachable: false, error: undefined },
      gateway: { running: false, profile: name },
    })

    ctx.body = {
      success: true,
      message: output.trim(),
      clonedFrom: cloneSource || undefined,
      strippedCredentials,
      disabledPlatforms,
      strippedConfigCredentials,
      copiedAuthProviders,
    }
  } catch (err: any) {
    if (respondWithProfileLifecycleError(ctx, err)) return
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function get(ctx: any) {
  const name = String(ctx.params.name || '').trim() || 'default'
  if (denyProfile(ctx, name)) return
  try {
    const profile = await hermesCli.getProfile(name)
    ctx.body = { profile: { ...profile, avatar: readProfileAvatar(profile.name) } }
  } catch (err: any) {
    ctx.status = err.message.includes('not found') ? 404 : 500
    ctx.body = { error: err.message }
  }
}

export async function updateAvatar(ctx: any) {
  const name = String(ctx.params.name || '').trim() || 'default'
  if (denyProfile(ctx, name)) return
  if (isForbiddenProfileName(name)) {
    ctx.status = 400
    ctx.body = { error: `Profile name '${name}' is reserved` }
    return
  }
  const body = ctx.request.body as { type?: string; seed?: string; dataUrl?: string }
  try {
    const dir = profileMetadataDir(name)
    await mkdir(dir, { recursive: true })
    const updatedAt = Date.now()

    if (body.type === 'generated') {
      const seed = String(body.seed || name).trim() || name
      const meta: ProfileAvatarMeta = { type: 'generated', seed, updatedAt }
      rmSync(profileAvatarImagePath(name), { force: true })
      await writeFile(profileAvatarMetaPath(name), JSON.stringify(meta, null, 2) + '\n', { mode: 0o600 })
      ctx.body = { avatar: readProfileAvatar(name) }
      return
    }

    if (body.type === 'image' && typeof body.dataUrl === 'string') {
      const { mime, buffer } = parseAvatarDataUrl(body.dataUrl)
      const meta: ProfileAvatarMeta = { type: 'image', file: 'avatar.bin', mime, updatedAt }
      await writeFile(profileAvatarImagePath(name), buffer, { mode: 0o600 })
      await writeFile(profileAvatarMetaPath(name), JSON.stringify(meta, null, 2) + '\n', { mode: 0o600 })
      ctx.body = { avatar: readProfileAvatar(name) }
      return
    }

    ctx.status = 400
    ctx.body = { error: 'Invalid avatar payload' }
  } catch (err: any) {
    ctx.status = 400
    ctx.body = { error: err.message }
  }
}

export async function deleteAvatar(ctx: any) {
  const name = String(ctx.params.name || '').trim() || 'default'
  if (denyProfile(ctx, name)) return
  try {
    removeProfileMetadata(name)
    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function runtimeStatus(ctx: any) {
  const name = String(ctx.params.name || '').trim() || 'default'
  if (denyProfile(ctx, name)) return
  if (isForbiddenProfileName(name)) {
    ctx.status = 400
    ctx.body = { error: `Profile name '${name}' is reserved` }
    return
  }
  try {
    const profiles = await listProfilesForStatus()
    const profile = profiles.find(item => item.name === name)
    const status = await buildRuntimeStatus(profile || name)
    setRuntimeStatusCache(status)
    ctx.body = status
  } catch {
    const status = await buildRuntimeStatus(name)
    setRuntimeStatusCache(status)
    ctx.body = status
  }
}

export async function runtimeStatuses(ctx: any) {
  try {
    const refreshParam = ctx.query?.refresh
    const refreshRequested = refreshParam === undefined || (refreshParam !== '0' && refreshParam !== 'false')
    if (refreshRequested) scheduleRuntimeStatusRefresh()

    const profiles = filterProfilesForUser(ctx, listProfilesForStatusFast())
    const statuses: RuntimeStatus[] = []
    profiles.forEach(profile => {
      const cached = runtimeStatusCache.get(profile.name)
      if (cached && cached.updatedAt >= runtimeStatusMinimumFreshAt) {
        statuses.push(cached.status)
      }
    })

    ctx.body = {
      profiles: statuses,
      refreshing: !!runtimeStatusRefreshPromise,
    }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

async function listProfilesForStatus(): Promise<HermesProfile[]> {
  let profiles: HermesProfile[]
  if (!isHermesAgentAvailable()) {
    profiles = listProfilesFromDisk(getActiveProfileName())
  } else {
    try {
      profiles = await hermesCli.listProfiles()
    } catch {
      profiles = listProfilesFromDisk(getActiveProfileName())
    }
  }
  return filterVisibleProfiles(profiles)
}

export async function restartGatewayForProfile(ctx: any) {
  const name = String(ctx.params.name || '').trim() || 'default'
  if (denyProfile(ctx, name)) return
  if (isForbiddenProfileName(name)) {
    ctx.status = 400
    ctx.body = { error: `Profile name '${name}' is reserved` }
    return
  }
  try {
    const gateway = await restartGatewayRuntimeForProfile(name)
    try {
      const result = await bridgeCleanupClient().destroyProfile(name)
      logger.info('[profiles] destroyed bridge sessions after gateway restart profile=%s destroyed=%s', name, result.destroyed)
      const cached = runtimeStatusCache.get(name)?.status
      if (cached) {
        setRuntimeStatusCache({
          ...cached,
          bridge: {
            ...cached.bridge,
            running: false,
          },
          gateway,
        })
      }
    } catch (err) {
      logger.warn(err, '[profiles] failed to destroy bridge sessions after gateway restart profile=%s', name)
    }
    ctx.body = { success: true, gateway }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function restartProfileRuntime(ctx: any) {
  const name = String(ctx.params.name || '').trim() || 'default'
  if (denyProfile(ctx, name)) return
  if (isForbiddenProfileName(name)) {
    ctx.status = 400
    ctx.body = { error: `Profile name '${name}' is reserved` }
    return
  }
  try {
    const result = await bridgeProfileRestartClient().destroyProfile(name)
    logger.info('[profiles] destroyed bridge sessions after profile restart profile=%s destroyed=%s', name, result.destroyed)
    const profiles = await listProfilesForStatus()
    const profile = profiles.find(item => item.name === name)
    const status = await buildRuntimeStatus(profile || name)
    setRuntimeStatusCache(status)
    ctx.body = {
      success: true,
      destroyed: result.destroyed,
      status,
    }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function remove(ctx: any) {
  const requestedName = ctx.params.name
  const normalizedName = normalizeProfileName(requestedName)
  if (normalizedName === 'default') {
    ctx.status = 400
    ctx.body = { error: 'Cannot delete the default profile' }
    return
  }
  let name: string
  try {
    name = validateProfileName(requestedName, { allowReserved: true })
  } catch (err) {
    if (respondWithProfileLifecycleError(ctx, err)) return
    throw err
  }
  if (denyProfile(ctx, name)) return
  try {
    const useHermes = isHermesAgentAvailable()
    if (useHermes) {
      try {
        const result = await bridgeCleanupClient().destroyProfile(name)
        logger.info('[profiles] destroyed bridge sessions for deleted profile "%s" destroyed=%s', name, result.destroyed)
      } catch (err) {
        logger.warn(err, '[profiles] failed to destroy bridge sessions for deleted profile "%s"', name)
      }
    }

    await prepareGatewayForProfileDelete(name, { useHermesCli: useHermes })

    const ok = useHermes
      ? await hermesCli.deleteProfile(name)
      : await deleteProfileWithoutHermes(name)
    if (ok && !profileDirectoryExists(name)) {
      removeProfileMetadata(name)
      runtimeStatusCache.delete(name)
      ctx.body = { success: true }
    } else if (ok) {
      ctx.status = 500
      ctx.body = { error: 'Failed to delete profile: profile directory still exists' }
    } else {
      ctx.status = useHermes ? 500 : 404
      ctx.body = { error: useHermes ? 'Failed to delete profile' : `Profile '${name}' not found` }
    }
  } catch (err: any) {
    if (respondWithProfileLifecycleError(ctx, err)) return
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function rename(ctx: any) {
  if (denyProfile(ctx, ctx.params.name)) return
  const { new_name } = ctx.request.body as { new_name?: string }
  if (!new_name) {
    ctx.status = 400
    ctx.body = { error: 'Missing new_name' }
    return
  }
  if (isForbiddenProfileName(new_name)) {
    ctx.status = 400
    ctx.body = { error: `Profile name '${new_name}' is reserved and cannot be used` }
    return
  }
  try {
    const ok = await hermesCli.renameProfile(ctx.params.name, new_name)
    if (ok) {
      renameProfileMetadata(ctx.params.name, new_name)
      ctx.body = { success: true }
    } else {
      ctx.status = 500
      ctx.body = { error: 'Failed to rename profile' }
    }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function switchProfile(ctx: any) {
  const { name } = ctx.request.body as { name?: string }
  if (!name) {
    ctx.status = 400
    ctx.body = { error: 'Missing profile name' }
    return
  }
  if (isForbiddenProfileName(name)) {
    ctx.status = 400
    ctx.body = { error: `Profile name '${name}' is reserved and cannot be activated` }
    return
  }
  try {
    if (denyProfile(ctx, name)) return

    const output = await useProfileWithFallback(name)

    const actualActive = getActiveProfileName()
    if (actualActive !== name) {
      ctx.status = 500
      ctx.body = { error: `Profile switch verification failed - active profile is ${actualActive}` }
      return
    }

    try {
      const result = await bridgeCleanupClient().destroyProfile(name)
      logger.info('[switchProfile] destroyed bridge sessions for Hermes profile "%s" destroyed=%s', name, result.destroyed)
    } catch (err: any) {
      logger.warn(err, '[switchProfile] failed to destroy bridge sessions for profile "%s"', name)
    }

    try {
      const detail = await hermesCli.getProfile(name)
      logger.debug('Profile detail.path = %s', detail.path)

      const profileConfig = join(detail.path, 'config.yaml')
      if (!existsSync(profileConfig)) {
        writeFileSync(profileConfig, '# Hermes Agent Configuration\n', 'utf-8')
        logger.info('Created config.yaml for: %s', detail.path)
      }

      const profileEnv = join(detail.path, '.env')
      if (!existsSync(profileEnv)) {
        writeFileSync(profileEnv, '# Hermes Agent Environment Configuration\n', 'utf-8')
        logger.info('Created .env for: %s', detail.path)
      }
    } catch (err: any) {
      logger.error(err, 'Ensure config failed')
    }

    await injectBundledSkillsForProfile(name)
    SessionDeleter.getInstance().switchProfile(name)
    logger.info('[switchProfile] switched session deleter to Hermes profile "%s"', name)

    ctx.body = {
      success: true,
      message: output.trim(),
      active: name,
    }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function exportProfile(ctx: any) {
  const { name } = ctx.params
  if (denyProfile(ctx, name)) return
  const exportDir = await mkdtemp(join(tmpdir(), 'hermes-profile-export-'))
  const safeName = String(name || 'profile')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'profile'
  const filename = `hermes-profile-${safeName}.tar.gz`
  const outputPath = join(exportDir, filename)
  let cleanupAfterResponse = false
  try {
    if (isHermesAgentAvailable()) {
      await hermesCli.exportProfile(name, outputPath)
    } else {
      await exportProfileWithoutHermes(name, outputPath)
    }
    if (!existsSync(outputPath)) {
      ctx.status = 500
      ctx.body = { error: 'Export file not found' }
      return
    }
    ctx.set('Content-Disposition', `attachment; filename="${filename}"`)
    ctx.set('Content-Type', 'application/gzip')
    const stream = createReadStream(outputPath)
    let cleanupStarted = false
    const cleanup = () => {
      if (cleanupStarted) return
      cleanupStarted = true
      void removeProfileArchiveTempDirectory(exportDir)
    }
    stream.on('error', cleanup)
    stream.on('close', cleanup)
    ctx.res.on('finish', cleanup)
    ctx.res.on('close', () => {
      stream.destroy()
      cleanup()
    })
    ctx.body = stream
    cleanupAfterResponse = true
  } catch (err: any) {
    if (respondWithProfileLifecycleError(ctx, err)) return
    // 超时和"导出真的失败了"是两回事，前端要能分开提示
    const timedOut = err?.code === hermesCli.ARCHIVE_TIMEOUT_CODE
    ctx.status = timedOut ? 504 : 500
    ctx.body = timedOut ? { error: err.message, code: err.code } : { error: err.message }
  } finally {
    if (!cleanupAfterResponse) await removeProfileArchiveTempDirectory(exportDir)
  }
}

export async function importProfile(ctx: any) {
  const contentType = ctx.get('content-type') || ''
  if (!contentType.startsWith('multipart/form-data')) {
    ctx.status = 400
    ctx.body = { error: 'Expected multipart/form-data' }
    return
  }
  const boundary = '--' + contentType.split('boundary=')[1]
  if (!boundary || boundary === '--undefined') {
    ctx.status = 400
    ctx.body = { error: 'Missing boundary' }
    return
  }
  const importDir = await mkdtemp(join(tmpdir(), 'hermes-profile-import-'))
  try {
    const chunks: Buffer[] = []
    for await (const chunk of ctx.req) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString('latin1')
    const parts = body.split(boundary).slice(1, -1)
    let archivePath = ''
    for (const part of parts) {
      const headerEnd = part.indexOf('\r\n\r\n')
      if (headerEnd === -1) continue
      const header = part.substring(0, headerEnd)
      const data = part.substring(headerEnd + 4, part.length - 2)
      const filenameMatch = header.match(/filename="([^"]+)"/)
      if (!filenameMatch) continue
      const filename = basename(filenameMatch[1].replace(/\\/g, '/'))
      const ext = filename.includes('.') ? '.' + filename.split('.').pop() : ''
      if (!filename || !['.gz', '.tar.gz', '.zip', '.tgz'].includes(ext)) continue
      archivePath = join(importDir, filename)
      await writeFile(archivePath, Buffer.from(data, 'binary'))
      break
    }
    if (!archivePath) {
      ctx.status = 400
      ctx.body = { error: 'No archive file found (.gz, .zip, .tgz)' }
      return
    }
    try {
      if (isHermesAgentAvailable()) {
        const result = await hermesCli.importProfile(archivePath)
        ctx.body = { success: true, message: result.trim() }
      } else {
        const result = await importProfileWithoutHermes(archivePath)
        await injectBundledSkillsForProfile(result.name)
        setRuntimeStatusCache({
          profile: result.name,
          bridge: { running: false, profile: result.name, reachable: false, error: undefined },
          gateway: { running: false, profile: result.name },
        })
        ctx.body = { success: true, message: result.message }
      }
    } catch (err: any) {
      if (respondWithProfileLifecycleError(ctx, err)) return
      const timedOut = err?.code === hermesCli.ARCHIVE_TIMEOUT_CODE
      ctx.status = timedOut ? 504 : 500
      ctx.body = timedOut ? { error: err.message, code: err.code } : { error: err.message }
    }
  } finally {
    await removeProfileArchiveTempDirectory(importDir)
  }
}

async function removeProfileArchiveTempDirectory(directory: string): Promise<void> {
  try {
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    })
  } catch (err) {
    logger.warn(err, '[profiles] failed to remove archive temp directory "%s"', directory)
  }
}
