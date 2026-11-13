import { config, getWebUiHome } from '../../public/config'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import {
  DEFAULT_UPDATE_CHANNEL,
  DEVICE_PACKAGE_ARTIFACT_FORMAT,
  normalizeChannelSegment,
  normalizeNodeVersionRange,
} from './device-package-contract'
import { UpdateError } from './errors'
import { describeUpdateNetworkError, fetchUpdateJson } from './network-client'
import { isRemoteVersionNewer, parseSemver } from './version-compare'
import type {
  DeviceEnvironment,
  DeviceEnvironmentFile,
  DevicePackageManifest,
  ManifestUpdateInfo,
  SourcePackageManifest,
  UpdateCheckResult,
  UpdateConfig,
  UpdatePackageType,
} from './types'

interface RawManifestPayload {
  version?: unknown
  channel?: unknown
  sourceLabel?: unknown
  packageType?: unknown
  artifactFormat?: unknown
  packageUrl?: unknown
  packageUrls?: unknown
  sha256?: unknown
  releasedAt?: unknown
  compatibleNodeMajor?: unknown
  compatibleNodeRange?: unknown
  minCurrentVersion?: unknown
  notesUrl?: unknown
  size?: unknown
  healthcheckUrl?: unknown
  sourceUrl?: unknown
  sourceUrls?: unknown
  sourceSha256?: unknown
  sourceRepoUrl?: unknown
  sourceSize?: unknown
  installerScriptPath?: unknown
  installerScriptSha256?: unknown
  environment?: unknown
}

// ---------------------------------------------------------------------------
// Manifest cache (phase a): the last successfully fetched channel manifest
// is persisted so an offline device keeps serving a (stale) manifest
// instead of losing update visibility entirely.
// Master spec: docs/harness/source-deploy-refactor.md (§ Manifest cache).
// ---------------------------------------------------------------------------

interface ManifestCacheEnvelope {
  schema: 1
  cachedAt: string
  channel: string
  payload: RawManifestPayload
  manifestUrl: string
}

export interface ResolvedManifest {
  manifestUrl: string
  payload: RawManifestPayload
  fromCache: boolean
  cachedAt: string | null
}

export function manifestCachePath(channel: string, env: Record<string, string | undefined> = process.env): string {
  return join(getWebUiHome(env), 'updates', 'cache', `manifest-${normalizeChannelSegment(channel)}.json`)
}

function writeManifestCache(channel: string, manifestUrl: string, payload: RawManifestPayload): void {
  try {
    const path = manifestCachePath(channel)
    mkdirSync(dirname(path), { recursive: true })
    const envelope: ManifestCacheEnvelope = {
      schema: 1,
      cachedAt: new Date().toISOString(),
      channel,
      payload,
      manifestUrl,
    }
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(envelope))
    renameSync(tmp, path)
  } catch {
    // Cache persistence is best-effort; a full disk must not fail the
    // manifest fetch itself.
  }
}

export function readManifestCache(channel: string, env: Record<string, string | undefined> = process.env): ManifestCacheEnvelope | null {
  try {
    const path = manifestCachePath(channel, env)
    if (!existsSync(path)) return null
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ManifestCacheEnvelope
    if (parsed?.schema !== 1 || !parsed.payload || typeof parsed.cachedAt !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

function toPackageType(value: unknown, fallback: UpdatePackageType): UpdatePackageType {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (normalized === 'npm-package') return 'npm-package'
  if (normalized === 'source-deploy') return 'source-deploy'
  if (normalized === 'device-package') return 'device-package'
  return fallback
}

export function buildManifestUrl(baseUrl: string, channel: string): string {
  const normalizedBaseUrl = (baseUrl || '').trim().replace(/\/+$/, '')
  const normalizedChannel = normalizeChannelSegment(channel || DEFAULT_UPDATE_CHANNEL)
  return `${normalizedBaseUrl}/${normalizedChannel}/latest.json`
}

export function resolveConfiguredManifestUrl(update: UpdateConfig = config.update): string {
  if (update.manifestUrl) return update.manifestUrl
  if (update.manifestBaseUrl) return buildManifestUrl(update.manifestBaseUrl, update.channel)
  return ''
}

export function resolveConfiguredManifestUrls(update: UpdateConfig = config.update): string[] {
  const configured = new Set<string>()
  for (const manifestUrl of update.manifestUrls || []) {
    const normalized = (manifestUrl || '').trim()
    if (normalized) configured.add(normalized)
  }
  if (update.manifestUrl) configured.add(update.manifestUrl)
  if (update.manifestBaseUrl) configured.add(buildManifestUrl(update.manifestBaseUrl, update.channel))
  return [...configured]
}

async function fetchRawManifest(update: UpdateConfig = config.update): Promise<ResolvedManifest> {
  const manifestUrls = resolveConfiguredManifestUrls(update)
  if (manifestUrls.length === 0) {
    throw new UpdateError('update_execution_misconfigured', 'Manifest update source is not configured')
  }

  const failures: Array<Record<string, unknown>> = []
  for (const manifestUrl of manifestUrls) {
    let response: Awaited<ReturnType<typeof fetchUpdateJson>>
    try {
      response = await fetchUpdateJson(manifestUrl, {
        timeoutMs: update.manifestTimeoutMs,
        retries: update.downloadRetries,
        retryDelayMs: update.downloadRetryDelayMs,
      })
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new UpdateError('update_manifest_invalid', `Manifest response is not valid JSON: ${manifestUrl}`)
      }
      failures.push({
        manifestUrl,
        ...describeUpdateNetworkError(err),
      })
      continue
    }

    if (!response.ok) {
      failures.push({
        manifestUrl,
        status: response.status,
        transport: response.transport,
        attempts: response.attempts,
      })
      continue
    }

    if (!response.data || typeof response.data !== 'object' || Array.isArray(response.data)) {
      throw new UpdateError('update_manifest_invalid', `Manifest response is not a JSON object: ${manifestUrl}`)
    }

    const payload = response.data as RawManifestPayload
    writeManifestCache(update.channel, manifestUrl, payload)
    return { manifestUrl, payload, fromCache: false, cachedAt: null }
  }

  // All URLs failed: fall back to the persisted cache so an offline
  // device keeps its last known manifest (staleness is surfaced through
  // /api/update/identity, not by silently treating it as fresh).
  const cached = readManifestCache(update.channel)
  if (cached?.payload) {
    return {
      manifestUrl: cached.manifestUrl || manifestUrls[0],
      payload: cached.payload,
      fromCache: true,
      cachedAt: cached.cachedAt,
    }
  }

  throw new UpdateError(
    'update_manifest_fetch_failed',
    `Failed to fetch update manifest from ${manifestUrls[0]}.`,
    502,
    {
      manifestUrls,
      failures,
    },
  )
}

function normalizeBaseManifestInfo(
  payload: RawManifestPayload,
  manifestUrl: string,
  update: UpdateConfig,
): ManifestUpdateInfo {
  const version = typeof payload.version === 'string' ? payload.version.trim() : ''
  if (!version) {
    throw new UpdateError('update_manifest_invalid', `Manifest is missing a valid version field: ${manifestUrl}`)
  }
  if (!parseSemver(version)) {
    throw new UpdateError('update_manifest_invalid', `Manifest version is not a valid semver: ${version}`)
  }

  const channel = typeof payload.channel === 'string' && payload.channel.trim()
    ? normalizeChannelSegment(payload.channel.trim())
    : normalizeChannelSegment(update.channel)
  const sourceLabel = typeof payload.sourceLabel === 'string' && payload.sourceLabel.trim()
    ? payload.sourceLabel.trim()
    : update.sourceLabel

  return {
    version,
    channel,
    sourceLabel,
    packageType: toPackageType(payload.packageType, update.packageType),
    manifestUrl,
  }
}

function requireStringField(value: unknown, fieldName: string, manifestUrl: string): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized) {
    throw new UpdateError('update_manifest_invalid', `Manifest field "${fieldName}" is required: ${manifestUrl}`)
  }
  return normalized
}

function normalizeUrlListField(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map(entry => (typeof entry === 'string' ? entry.trim() : '')).filter(Boolean))]
}

function requirePositiveInteger(value: unknown, fieldName: string, manifestUrl: string): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : Number.NaN
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new UpdateError('update_manifest_invalid', `Manifest field "${fieldName}" must be a positive integer: ${manifestUrl}`)
  }
  return parsed
}

export async function fetchManifestUpdateInfo(update: UpdateConfig = config.update): Promise<ManifestUpdateInfo> {
  const { manifestUrl, payload } = await fetchRawManifest(update)
  return normalizeBaseManifestInfo(payload, manifestUrl, update)
}

export async function fetchDevicePackageManifest(update: UpdateConfig = config.update): Promise<DevicePackageManifest> {
  const { manifestUrl, payload } = await fetchRawManifest(update)
  const info = normalizeBaseManifestInfo(payload, manifestUrl, update)
  if (info.packageType !== 'device-package') {
    throw new UpdateError('update_manifest_invalid', `Manifest packageType must be "device-package": ${manifestUrl}`)
  }

  const artifactFormat = requireStringField(payload.artifactFormat, 'artifactFormat', manifestUrl)
  if (artifactFormat !== DEVICE_PACKAGE_ARTIFACT_FORMAT) {
    throw new UpdateError(
      'update_manifest_invalid',
      `Manifest artifactFormat must be "${DEVICE_PACKAGE_ARTIFACT_FORMAT}": ${manifestUrl}`,
    )
  }

  const packageUrls = normalizeUrlListField(payload.packageUrls)
  const packageUrl = packageUrls[0] || requireStringField(payload.packageUrl, 'packageUrl', manifestUrl)
  const sha256 = requireStringField(payload.sha256, 'sha256', manifestUrl).toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new UpdateError('update_manifest_invalid', `Manifest sha256 must be a 64 character hex string: ${manifestUrl}`)
  }

  const releasedAt = requireStringField(payload.releasedAt, 'releasedAt', manifestUrl)
  const minCurrentVersion = requireStringField(payload.minCurrentVersion, 'minCurrentVersion', manifestUrl)
  if (!parseSemver(minCurrentVersion)) {
    throw new UpdateError('update_manifest_invalid', `Manifest minCurrentVersion is not a valid semver: ${minCurrentVersion}`)
  }
  const compatibleNodeRange = typeof payload.compatibleNodeRange === 'string' && payload.compatibleNodeRange.trim()
    ? normalizeNodeVersionRange(payload.compatibleNodeRange)
    : normalizeLegacyNodeRange(payload.compatibleNodeMajor, manifestUrl)

  return {
    ...info,
    artifactFormat: DEVICE_PACKAGE_ARTIFACT_FORMAT,
    packageUrl,
    packageUrls: packageUrls.length > 0 ? packageUrls : undefined,
    sha256,
    releasedAt,
    compatibleNodeRange,
    minCurrentVersion,
    notesUrl: typeof payload.notesUrl === 'string' ? payload.notesUrl.trim() : '',
    size: typeof payload.size === 'number' && Number.isFinite(payload.size) ? payload.size : 0,
    healthcheckUrl: typeof payload.healthcheckUrl === 'string' && payload.healthcheckUrl.trim()
      ? payload.healthcheckUrl.trim()
      : update.healthcheckUrl,
    installerScriptPath: typeof payload.installerScriptPath === 'string' && payload.installerScriptPath.trim()
      ? normalizeInstallerScriptPath(payload.installerScriptPath)
      : undefined,
    installerScriptSha256: typeof payload.installerScriptSha256 === 'string' && payload.installerScriptSha256.trim()
      ? payload.installerScriptSha256.trim().toLowerCase()
      : undefined,
    environment: normalizeEnvironment(payload.environment),
  }
}

function normalizeInstallerScriptPath(raw: string): string | undefined {
  const trimmed = raw.trim().replace(/\\/g, '/').replace(/^\/+/, '')
  if (!trimmed || trimmed.includes('..') || trimmed.includes('\0')) return undefined
  return trimmed
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeEnvironment(value: unknown): DeviceEnvironment | undefined {
  if (!isPlainObject(value)) return undefined
  const requiredNodeRange = typeof value.requiredNodeRange === 'string' && value.requiredNodeRange.trim()
    ? value.requiredNodeRange.trim()
    : undefined
  const requiredHermesAgentRange = typeof value.requiredHermesAgentRange === 'string' && value.requiredHermesAgentRange.trim()
    ? value.requiredHermesAgentRange.trim()
    : undefined
  let requiredSystemFiles: DeviceEnvironmentFile[] | undefined
  if (Array.isArray(value.requiredSystemFiles)) {
    const normalised: DeviceEnvironmentFile[] = []
    for (const entry of value.requiredSystemFiles) {
      if (!isPlainObject(entry) || typeof entry.path !== 'string' || !entry.path.trim()) continue
      const kind: DeviceEnvironmentFile['kind'] = entry.kind === 'executable' || entry.kind === 'absent'
        ? entry.kind
        : 'present'
      normalised.push({ path: entry.path.trim(), kind })
    }
    if (normalised.length > 0) requiredSystemFiles = normalised
  }

  const environment: DeviceEnvironment = {}
  if (requiredNodeRange) environment.requiredNodeRange = requiredNodeRange
  if (requiredHermesAgentRange) environment.requiredHermesAgentRange = requiredHermesAgentRange
  if (requiredSystemFiles) environment.requiredSystemFiles = requiredSystemFiles
  if (Object.keys(environment).length === 0) return undefined
  return environment
}

export async function fetchSourcePackageManifest(update: UpdateConfig = config.update): Promise<SourcePackageManifest> {
  const { manifestUrl, payload } = await fetchRawManifest(update)
  const info = normalizeBaseManifestInfo(payload, manifestUrl, update)
  if (info.packageType !== 'source-deploy') {
    throw new UpdateError('update_manifest_invalid', `Manifest packageType must be "source-deploy": ${manifestUrl}`)
  }

  const artifactFormat = requireStringField(payload.artifactFormat, 'artifactFormat', manifestUrl)
  if (artifactFormat !== DEVICE_PACKAGE_ARTIFACT_FORMAT) {
    throw new UpdateError(
      'update_manifest_invalid',
      `Manifest artifactFormat must be "${DEVICE_PACKAGE_ARTIFACT_FORMAT}": ${manifestUrl}`,
    )
  }

  const sourceUrls = normalizeUrlListField(payload.sourceUrls)
  const sourceUrl = sourceUrls[0] || requireStringField(payload.sourceUrl, 'sourceUrl', manifestUrl)
  const sourceSha256 = requireStringField(payload.sourceSha256, 'sourceSha256', manifestUrl).toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(sourceSha256)) {
    throw new UpdateError('update_manifest_invalid', `Manifest sourceSha256 must be a 64 character hex string: ${manifestUrl}`)
  }

  const releasedAt = requireStringField(payload.releasedAt, 'releasedAt', manifestUrl)
  const minCurrentVersion = requireStringField(payload.minCurrentVersion, 'minCurrentVersion', manifestUrl)
  if (!parseSemver(minCurrentVersion)) {
    throw new UpdateError('update_manifest_invalid', `Manifest minCurrentVersion is not a valid semver: ${minCurrentVersion}`)
  }
  const sourceRepoUrl = typeof payload.sourceRepoUrl === 'string' ? payload.sourceRepoUrl.trim() : ''
  const sourceSize = typeof payload.sourceSize === 'number' && Number.isFinite(payload.sourceSize) ? payload.sourceSize : 0

  return {
    ...info,
    artifactFormat: DEVICE_PACKAGE_ARTIFACT_FORMAT,
    sourceUrl,
    sourceUrls: sourceUrls.length > 0 ? sourceUrls : undefined,
    sourceSha256,
    releasedAt,
    minCurrentVersion,
    notesUrl: typeof payload.notesUrl === 'string' ? payload.notesUrl.trim() : '',
    sourceRepoUrl: sourceRepoUrl || undefined,
    sourceSize,
    healthcheckUrl: typeof payload.healthcheckUrl === 'string' && payload.healthcheckUrl.trim()
      ? payload.healthcheckUrl.trim()
      : update.healthcheckUrl,
    environment: normalizeEnvironment(payload.environment),
  }
}

function normalizeLegacyNodeRange(compatibleNodeMajor: unknown, manifestUrl: string): string {
  const major = requirePositiveInteger(compatibleNodeMajor, 'compatibleNodeMajor', manifestUrl)
  return `>=${major}.0.0 <${major + 1}.0.0`
}

export async function resolveManifestCheckResult(update: UpdateConfig = config.update): Promise<UpdateCheckResult> {
  const manifest = await fetchManifestUpdateInfo(update)
  return {
    latestVersion: manifest.version,
    sourceLabel: manifest.sourceLabel || update.sourceLabel,
    channel: manifest.channel || update.channel,
    packageType: manifest.packageType || update.packageType,
    strategy: update.strategy,
    detectionSource: 'manifest',
  }
}

/** A URL that points at a frozen manifest (version dir or candidate). */
export function isPinnedManifestUrl(url: string): boolean {
  return /\/releases\/v\d[^/]*\//.test(url) || /\/candidates\//.test(url)
}

async function fetchManifestInfoWithUrl(
  update: UpdateConfig,
): Promise<{ info: ReturnType<typeof normalizeBaseManifestInfo>; manifestUrl: string }> {
  const { manifestUrl, payload } = await fetchRawManifest(update)
  return { info: normalizeBaseManifestInfo(payload, manifestUrl, update), manifestUrl }
}

/**
 * resolveManifestCheckResult + the pinned-stale guard (task-12
 * § Update-source hardening).
 *
 * The device's env ranks an explicit manifest URL ahead of the
 * `manifestBaseUrl + channel` fallback, so a stale version/candidate pin
 * wins every fetch and the device freezes on it forever — the exact
 * failure that made 6.6.6.73 miss every release after 0.8.1. When the
 * winning URL is such a pin AND a channel tip is configured AND the
 * channel tip is strictly newer, prefer the channel tip and record
 * `manifest_pinned_stale`.
 *
 * Offline safety: if the channel tip is unreachable, the pinned result
 * stands and NO warning is emitted (a pin is legitimate offline behavior;
 * we never block an update on a network miss).
 */
export async function resolveManifestCheckResultGuarded(
  update: UpdateConfig = config.update,
): Promise<UpdateCheckResult> {
  const primary = await fetchManifestInfoWithUrl(update)
  const result: UpdateCheckResult = {
    latestVersion: primary.info.version,
    sourceLabel: primary.info.sourceLabel || update.sourceLabel,
    channel: primary.info.channel || update.channel,
    packageType: primary.info.packageType || update.packageType,
    strategy: update.strategy,
    detectionSource: 'manifest',
    effectiveManifestUrl: primary.manifestUrl,
  }

  if (
    update.manifestBaseUrl &&
    isPinnedManifestUrl(primary.manifestUrl) &&
    primary.manifestUrl !== buildManifestUrl(update.manifestBaseUrl, update.channel)
  ) {
    try {
      // Channel-only resolution: strip the explicit pins so
      // fetchRawManifest falls back to manifestBaseUrl + channel.
      const channelOnly: UpdateConfig = { ...update, manifestUrl: '', manifestUrls: [] }
      const chan = await fetchManifestInfoWithUrl(channelOnly)
      if (isRemoteVersionNewer(primary.info.version, chan.info.version)) {
        result.latestVersion = chan.info.version
        result.sourceLabel = chan.info.sourceLabel || result.sourceLabel
        result.channel = chan.info.channel || result.channel
        result.packageType = chan.info.packageType || result.packageType
        result.pinnedManifestUrl = primary.manifestUrl
        result.effectiveManifestUrl = chan.manifestUrl
        result.warnings = ['manifest_pinned_stale']
      }
    } catch {
      // Channel unreachable — pinned result stands, no warning.
    }
  }

  return result
}
