import { createHash } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import {
  cp as copyAsync,
  mkdir as mkdirAsync,
  rename as renameAsync,
  rm as removeAsync,
} from 'node:fs/promises'
import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { app } from 'electron'
import {
  desktopRuntimeDir,
  desktopRuntimeVersion,
  runtimePlatformKey,
  runtimeStorageRoot,
  targetDesktopRuntimeDir,
  webUiHome,
  webuiDir,
} from './paths'
import {
  compareHermesAgentVersions,
  hermesAgentVersionFromRuntimeTag,
  runtimeManifestMatchesHermesAgentVersion,
} from './runtime-version'
import { extractTarGzipArchive } from './runtime-archive'
import {
  repairMovedHermesRuntime,
  windowsRuntimeNeedsRelocationRepair,
} from './runtime-relocation'
import { t } from './desktop-i18n'

const DEFAULT_RUNTIME_BASE_URL = 'https://download.ekkolearnai.com'
const DEFAULT_RUNTIME_GITHUB_REPO = 'EKKOLearnAI/ekko-studio'
const RUNTIME_MANIFEST_NAME = 'runtime-manifest.json'
const PACKAGED_RUNTIME_RELEASE_NAME = 'runtime-release.json'
const ACTIVE_RUNTIME_VERSION_NAME = 'active-version.json'

export type RuntimeDownloadSource = 'cf' | 'github'

type RuntimeManifest = {
  schema: number
  platform: string
  hermesAgentVersion?: string
  hermesSource?: {
    repository?: string
    ref?: string
    commit?: string
    installMethod?: string
  }
  asset?: {
    name: string
    url?: string
    sha256?: string
    size?: number
  }
}

type RuntimeDescriptor = {
  name: string
  url: string
  sha256?: string
  hermesAgentVersion?: string
}

type PackagedRuntimeRelease = {
  tag?: string
  hermesAgentVersion?: string
}

type ActiveRuntimeVersion = {
  schema?: number
  desktopAppVersion?: string
  hermesRuntimeVersion?: string
  webUiVersion?: string
  runtimeDirectory?: string
  runtimeRootDirectory?: string
  pendingRuntimeRootDirectory?: string
  runtimeMigrationError?: string
  runtimeActivationError?: string
  runtimeValidationFailures?: Array<{
    version: string
    platform: string
    directory: string
    reason: string
    failedAt: string
  }>
  webUiDirectory?: string
  platform?: string
  updatedAt?: string
}

export type RuntimeProgress = {
  stage: 'resolve' | 'download' | 'verify' | 'extract' | 'ready'
  message: string
  detail?: string
  percent?: number
  receivedBytes?: number
  totalBytes?: number
}

type RuntimeProgressHandler = (progress: RuntimeProgress) => void

function runtimeDownloadSource(source?: RuntimeDownloadSource): RuntimeDownloadSource | null {
  if (source) return source
  const value = process.env.HERMES_DESKTOP_RUNTIME_SOURCE?.trim().toLowerCase()
  if (value === 'github' || value === 'cf') return value
  return null
}

function requiredRuntimeFiles(root: string): string[] {
  const pythonRoot = runtimePythonEnvironmentRoot(root)
  const pythonBin = runtimePythonExecutable(pythonRoot)
  const hermesBin = process.platform === 'win32'
    ? join(pythonRoot, 'Scripts', 'hermes.cmd')
    : join(pythonRoot, 'bin', 'hermes')
  const nodeBin = process.platform === 'win32'
    ? join(root, 'node', 'node.exe')
    : join(root, 'node', 'bin', 'node')
  const files = [
    pythonBin,
    hermesBin,
    join(root, 'python', 'run_agent.py'),
    join(root, 'python', 'cli.py'),
    nodeBin,
    join(root, RUNTIME_MANIFEST_NAME),
  ]
  if (process.platform === 'win32') files.push(join(root, 'git', 'cmd', 'git.exe'))
  return files
}

function runtimePythonEnvironmentRoot(runtimeRoot: string): string {
  const sourceRoot = join(runtimeRoot, 'python')
  const venvRoot = join(sourceRoot, 'venv')
  const venvPythons = process.platform === 'win32'
    ? [join(venvRoot, 'Scripts', 'python.exe'), join(venvRoot, 'python.exe')]
    : [join(venvRoot, 'bin', 'python3')]
  return venvPythons.some(existsSync) ? venvRoot : sourceRoot
}

function runtimePythonExecutable(environmentRoot: string): string {
  if (process.platform !== 'win32') return join(environmentRoot, 'bin', 'python3')
  const standardVenvPython = join(environmentRoot, 'Scripts', 'python.exe')
  return existsSync(standardVenvPython)
    ? standardVenvPython
    : join(environmentRoot, 'python.exe')
}

function missingRuntimeFiles(root: string): string[] {
  return requiredRuntimeFiles(root).filter(file => !existsSync(file))
}

function requiredWebUiFiles(root: string): string[] {
  return [
    join(root, 'package.json'),
    join(root, 'bin', 'hermes-web-ui.mjs'),
    join(root, 'dist', 'server', 'index.js'),
  ]
}

function validateWebUiVersion(root: string, version: string): void {
  const missing = requiredWebUiFiles(root).filter(file => !existsSync(file))
  if (missing.length > 0) {
    throw new Error(`Web UI ${version} is missing required files: ${missing.map(file => relative(root, file)).join(', ')}`)
  }
}

function webUiVersionReady(root: string): boolean {
  return requiredWebUiFiles(root).every(file => existsSync(file))
}

function validateWebUiVersions(root: string): void {
  if (!existsSync(root)) return
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const versionRoot = join(root, entry.name)
    validateWebUiVersion(versionRoot, entry.name)
  }
}

function validateRuntimeDirectory(root: string, label: string): void {
  const missing = missingRuntimeFiles(root)
  if (missing.length > 0) {
    throw new Error(`${label} is missing required files: ${missing.map(file => relative(root, file)).join(', ')}`)
  }
  const manifest = readCachedRuntimeManifest(root)
  if (!manifest) {
    throw new Error(`${label} has an invalid ${RUNTIME_MANIFEST_NAME}`)
  }
  if (manifest.platform && manifest.platform !== runtimePlatformKey()) {
    throw new Error(`Runtime platform mismatch: expected ${runtimePlatformKey()}, received ${manifest.platform}`)
  }
  if (manifest.schema >= 2) {
    const sourceFiles = [
      join(root, 'python', '.git', 'HEAD'),
      join(root, 'python', 'pyproject.toml'),
    ]
    const missingSourceFiles = sourceFiles.filter(file => !existsSync(file))
    if (missingSourceFiles.length > 0) {
      throw new Error(
        `${label} is missing updateable Hermes source files: `
        + missingSourceFiles.map(file => relative(root, file)).join(', '),
      )
    }
    if (manifest.hermesSource?.installMethod !== 'git'
      || !manifest.hermesSource.repository
      || !manifest.hermesSource.ref
      || !/^[0-9a-f]{40}$/i.test(manifest.hermesSource.commit || '')) {
      throw new Error(`${label} has invalid Hermes Git source metadata`)
    }
  }
}

function runtimeDirectoryReadyForMigration(root: string): boolean {
  try {
    validateRuntimeDirectory(root, 'Runtime')
    return true
  } catch {
    return false
  }
}

function runtimeReady(): boolean {
  return rootRuntimeReady(desktopRuntimeDir())
}

function rootRuntimeReady(root: string): boolean {
  const pythonRoot = runtimePythonEnvironmentRoot(root)
  const gitPath = process.platform === 'win32' ? join(root, 'git', 'cmd', 'git.exe') : null
  const hermesPath = process.platform === 'win32'
    ? [
        join(pythonRoot, 'Scripts', 'hermes.cmd'),
        join(pythonRoot, 'Scripts', 'hermes.exe'),
      ].find(existsSync)
    : join(pythonRoot, 'bin', 'hermes')
  return existsSync(runtimePythonExecutable(pythonRoot))
    && Boolean(hermesPath)
    && existsSync(process.platform === 'win32' ? join(root, 'node', 'node.exe') : join(root, 'node', 'bin', 'node'))
    && (!gitPath || existsSync(gitPath))
}

export function isDesktopRuntimeReady(): boolean {
  return runtimeReady()
}

export function repairUpdatedDesktopRuntimeLaunchers(): boolean {
  if (process.platform !== 'win32') return false

  const runtimeRoot = desktopRuntimeDir()
  if (!windowsRuntimeNeedsRelocationRepair(runtimeRoot)) return false

  try {
    const repair = repairMovedHermesRuntime(runtimeRoot, runtimeRoot, runtimeRoot)
    const repaired = !windowsRuntimeNeedsRelocationRepair(runtimeRoot)
      && (repair.editableFilesRewritten > 0 || repair.launchersRewritten > 0)
    if (repaired) {
      console.log(
        `[runtime] repaired cached Windows Runtime: `
        + `${repair.editableFilesRewritten} path reference(s), `
        + `${repair.launchersRewritten} launcher(s)`,
      )
    }
    return repaired
  } catch (err) {
    console.warn(
      `[runtime] failed to repair cached Windows Runtime: `
      + `${err instanceof Error ? err.message : String(err)}`,
    )
    return false
  }
}

function releaseTagCandidates(): string[] {
  const override = process.env.HERMES_DESKTOP_RUNTIME_RELEASE_TAG?.trim()
  if (override) return [override]

  const version = app.getVersion()
  const candidates = [packagedRuntimeReleaseTag(), version, `v${version}`, 'latest']
  return Array.from(new Set(candidates.filter((tag): tag is string => typeof tag === 'string' && tag.length > 0)))
}

function packagedRuntimeReleaseMetadata(): PackagedRuntimeRelease | null {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'build', PACKAGED_RUNTIME_RELEASE_NAME)]
    : [join(app.getAppPath(), 'build', PACKAGED_RUNTIME_RELEASE_NAME)]

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      const metadata = JSON.parse(readFileSync(candidate, 'utf-8')) as { tag?: unknown; hermesAgentVersion?: unknown }
      return {
        tag: typeof metadata.tag === 'string' && metadata.tag.trim() ? metadata.tag.trim() : undefined,
        hermesAgentVersion: typeof metadata.hermesAgentVersion === 'string' && metadata.hermesAgentVersion.trim()
          ? metadata.hermesAgentVersion.trim()
          : undefined,
      }
    } catch {}
  }

  return null
}

function packagedRuntimeReleaseTag(): string | null {
  const metadata = packagedRuntimeReleaseMetadata()
  if (metadata?.tag) return metadata.tag
  return null
}

export function cachedRuntimeNeedsPackagedReleaseUpdate(): boolean {
  const metadata = packagedRuntimeReleaseMetadata()
  const expectedVersion = process.env.HERMES_DESKTOP_RUNTIME_RELEASE_TAG
    ? hermesAgentVersionFromRuntimeTag(process.env.HERMES_DESKTOP_RUNTIME_RELEASE_TAG)
    : metadata?.hermesAgentVersion || hermesAgentVersionFromRuntimeTag(metadata?.tag)
  if (!expectedVersion) return false
  const manifest = readCachedRuntimeManifest(desktopRuntimeDir())
  const assetVersion = typeof manifest?.asset?.name === 'string'
    ? manifest.asset.name.match(/hermes-agent-([^-]+)-/)?.[1]
    : undefined
  const cachedVersion = manifest?.hermesAgentVersion || assetVersion
  const comparison = compareHermesAgentVersions(cachedVersion, expectedVersion)
  if (comparison !== null) return comparison < 0
  const match = runtimeManifestMatchesHermesAgentVersion(manifest, expectedVersion)
  return match === false
}

function runtimeAssetUrl(assetName: string, tag: string, source: RuntimeDownloadSource): string {
  if (source === 'github') {
    const repo = process.env.HERMES_DESKTOP_RUNTIME_REPO?.trim() || DEFAULT_RUNTIME_GITHUB_REPO
    if (tag === 'latest') {
      return `https://github.com/${repo}/releases/latest/download/${encodeURIComponent(assetName)}`
    }
    return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`
  }

  const template = process.env.HERMES_DESKTOP_RUNTIME_BASE_URL?.trim() || DEFAULT_RUNTIME_BASE_URL
  if (template.includes('{asset}') || template.includes('{tag}')) {
    return template
      .replace(/\{asset\}/g, encodeURIComponent(assetName))
      .replace(/\{tag\}/g, encodeURIComponent(tag))
  }
  return `${template.replace(/\/$/, '')}/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`
}

async function fetchJson<T>(url: string): Promise<T> {
  try {
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`GET ${url} returned ${response.status}`)
    }
    return await response.json() as T
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(`GET ${url}`)) throw err
    throw new Error(`GET ${url} failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function resolveRuntimeDescriptor(source?: RuntimeDownloadSource): Promise<RuntimeDescriptor> {
  const directUrl = process.env.HERMES_DESKTOP_RUNTIME_URL?.trim()
  if (directUrl) {
    return { name: basename(new URL(directUrl).pathname) || 'hermes-runtime.tar.gz', url: directUrl }
  }

  const downloadSource = runtimeDownloadSource(source)
  const platformManifestName = `hermes-runtime-${runtimePlatformKey()}.json`
  const manifestOverride = process.env.HERMES_DESKTOP_RUNTIME_MANIFEST_URL?.trim()
  if (!downloadSource && !manifestOverride) {
    throw new Error('Hermes runtime download source is not selected')
  }

  const candidates = manifestOverride
    ? [{ tag: '', url: manifestOverride }]
    : releaseTagCandidates().map(tag => ({ tag, url: runtimeAssetUrl(platformManifestName, tag, downloadSource!) }))

  let lastError: Error | null = null
  for (const candidate of candidates) {
    try {
      console.log(`[runtime] resolving Hermes runtime from ${downloadSource || 'custom'}: ${candidate.url}`)
      const manifest = await fetchJson<RuntimeManifest>(candidate.url)
      if (!manifest.asset?.name) {
        throw new Error(`runtime manifest is missing asset.name: ${candidate.url}`)
      }
      if (!manifest.asset.url && !downloadSource) {
        throw new Error(`runtime manifest is missing asset.url and no download source was selected: ${candidate.url}`)
      }
      return {
        name: manifest.asset.name,
        url: manifest.asset.url || runtimeAssetUrl(manifest.asset.name, candidate.tag, downloadSource!),
        sha256: manifest.asset.sha256,
        hermesAgentVersion: manifest.hermesAgentVersion,
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
    }
  }

  throw lastError || new Error('Unable to resolve Hermes desktop runtime package')
}

function readCachedRuntimeManifest(root: string): RuntimeManifest | null {
  const file = join(root, RUNTIME_MANIFEST_NAME)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as RuntimeManifest
  } catch {
    return null
  }
}

function webUiVersion(): string {
  const packageJson = join(webuiDir(), 'package.json')
  try {
    const metadata = JSON.parse(readFileSync(packageJson, 'utf-8')) as { version?: unknown }
    if (typeof metadata.version === 'string' && metadata.version.trim()) return metadata.version.trim()
  } catch {}
  return app.getVersion()
}

function activeVersionPath(): string {
  return join(webUiHome(), 'desktop-runtime', ACTIVE_RUNTIME_VERSION_NAME)
}

function readActiveRuntimeVersion(): ActiveRuntimeVersion | null {
  const file = activeVersionPath()
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as ActiveRuntimeVersion
  } catch {
    return null
  }
}

function writeActiveRuntimeManifest(active: ActiveRuntimeVersion): void {
  const file = activeVersionPath()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(active, null, 2) + '\n')
}

async function copyTreeForMigration(source: string, destination: string): Promise<void> {
  // Hermes/uv can add directory symlinks after an update. Recreating them
  // requires elevated Windows privileges, so make the migrated copy self-contained.
  const materializeLinks = process.platform === 'win32'
  await copyAsync(source, destination, {
    recursive: true,
    force: true,
    dereference: materializeLinks,
    verbatimSymlinks: !materializeLinks,
  })
}

export async function migratePendingRuntimeRoot(
  onProgress?: RuntimeProgressHandler,
): Promise<{ migrated: boolean; error: string }> {
  const active = readActiveRuntimeVersion()
  const pendingRoot = active?.pendingRuntimeRootDirectory?.trim()
  if (!active || !pendingRoot) return { migrated: false, error: '' }

  const sourceRuntime = desktopRuntimeDir()
  const sourceRoot = runtimeStorageRoot()
  const sourceWebUiRoot = join(sourceRoot, 'webui')
  const targetRoot = resolve(pendingRoot)
  const manifest = readCachedRuntimeManifest(sourceRuntime)
  const version = manifest?.hermesAgentVersion || active.hermesRuntimeVersion || desktopRuntimeVersion()
  const targetRuntime = join(targetRoot, 'hermes', version, runtimePlatformKey())
  const targetWebUiRoot = join(targetRoot, 'webui')
  const tempRuntime = join(dirname(targetRuntime), `.runtime-migration-${process.pid}-${Date.now()}`)
  const tempWebUiRoot = join(targetRoot, `.webui-migration-${process.pid}-${Date.now()}`)

  try {
    const relativeTarget = relative(resolve(sourceRuntime), targetRoot)
    if (relativeTarget === ''
      || (relativeTarget !== '..' && !relativeTarget.startsWith(`..${sep}`) && !isAbsolute(relativeTarget))) {
      throw new Error('Runtime migration destination cannot be inside the current Runtime directory')
    }

    if (resolve(sourceRuntime) === resolve(targetRuntime)) {
      const next: ActiveRuntimeVersion = {
        ...active,
        runtimeRootDirectory: targetRoot,
        runtimeMigrationError: '',
        updatedAt: new Date().toISOString(),
      }
      delete next.pendingRuntimeRootDirectory
      delete next.webUiDirectory
      writeActiveRuntimeManifest(next)
      return { migrated: true, error: '' }
    }

    const shouldCopyRuntime = !runtimeDirectoryReadyForMigration(targetRuntime)
    if (shouldCopyRuntime && !rootRuntimeReady(sourceRuntime)) {
      throw new Error(`Current Runtime is incomplete: ${sourceRuntime}`)
    }

    const shouldMergeWebUi = existsSync(sourceWebUiRoot)
      && resolve(sourceWebUiRoot) !== resolve(targetWebUiRoot)
    const webUiVersionsToCopy: string[] = []
    if (shouldMergeWebUi) {
      const sourceVersions = readdirSync(sourceWebUiRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
      const sourceVersionSet = new Set(sourceVersions)

      if (existsSync(targetWebUiRoot)) {
        for (const entry of readdirSync(targetWebUiRoot, { withFileTypes: true })) {
          if (entry.isDirectory() && !sourceVersionSet.has(entry.name)) {
            validateWebUiVersion(join(targetWebUiRoot, entry.name), entry.name)
          }
        }
      }

      for (const webUiVersion of sourceVersions) {
        const targetVersion = join(targetWebUiRoot, webUiVersion)
        if (webUiVersionReady(targetVersion)) continue
        validateWebUiVersion(join(sourceWebUiRoot, webUiVersion), webUiVersion)
        webUiVersionsToCopy.push(webUiVersion)
      }
    }

    if (shouldCopyRuntime || webUiVersionsToCopy.length > 0) {
      onProgress?.({
        stage: 'extract',
        message: t('runtime.migrating'),
        detail: targetRoot,
      })
    }

    if (shouldCopyRuntime) {
      await mkdirAsync(dirname(targetRuntime), { recursive: true })
      await removeAsync(tempRuntime, { recursive: true, force: true })
      await copyTreeForMigration(sourceRuntime, tempRuntime)
      const relocation = repairMovedHermesRuntime(tempRuntime, sourceRuntime, targetRuntime)
      if (relocation.editableFilesRewritten || relocation.launchersRewritten) {
        console.log(
          `[runtime] repaired migrated Hermes runtime: `
          + `${relocation.editableFilesRewritten} editable reference(s), `
          + `${relocation.launchersRewritten} launcher(s)`,
        )
      }
      validateRuntimeDirectory(tempRuntime, 'Migrated Runtime')
    }

    if (webUiVersionsToCopy.length > 0) {
      await removeAsync(tempWebUiRoot, { recursive: true, force: true })
      await mkdirAsync(tempWebUiRoot, { recursive: true })
      for (const webUiVersion of webUiVersionsToCopy) {
        const stagedVersion = join(tempWebUiRoot, webUiVersion)
        await copyTreeForMigration(join(sourceWebUiRoot, webUiVersion), stagedVersion)
        validateWebUiVersion(stagedVersion, webUiVersion)
      }
      validateWebUiVersions(tempWebUiRoot)
    }

    if (shouldCopyRuntime) {
      await removeAsync(targetRuntime, { recursive: true, force: true })
      await renameAsync(tempRuntime, targetRuntime)
    }
    if (webUiVersionsToCopy.length > 0) {
      await mkdirAsync(targetWebUiRoot, { recursive: true })
      for (const webUiVersion of webUiVersionsToCopy) {
        const targetVersion = join(targetWebUiRoot, webUiVersion)
        await removeAsync(targetVersion, { recursive: true, force: true })
        await renameAsync(join(tempWebUiRoot, webUiVersion), targetVersion)
      }
      await removeAsync(tempWebUiRoot, { recursive: true, force: true })
    }

    const next: ActiveRuntimeVersion = {
      ...active,
      schema: 1,
      hermesRuntimeVersion: version,
      runtimeDirectory: targetRuntime,
      runtimeRootDirectory: targetRoot,
      runtimeMigrationError: '',
      platform: runtimePlatformKey(),
      updatedAt: new Date().toISOString(),
    }
    delete next.pendingRuntimeRootDirectory
    delete next.webUiDirectory
    writeActiveRuntimeManifest(next)
    console.log(
      `[runtime] switched desktop runtime storage to ${targetRoot}; `
      + `${shouldCopyRuntime ? 'copied' : 'reused'} Runtime, copied ${webUiVersionsToCopy.length} Web UI version(s); `
      + `previous storage retained at ${sourceRoot}`,
    )
    return { migrated: true, error: '' }
  } catch (err) {
    await Promise.allSettled([
      removeAsync(tempRuntime, { recursive: true, force: true }),
      removeAsync(tempWebUiRoot, { recursive: true, force: true }),
    ])
    const error = err instanceof Error ? err.message : String(err)
    const next: ActiveRuntimeVersion = {
      ...active,
      runtimeMigrationError: error,
      updatedAt: new Date().toISOString(),
    }
    delete next.pendingRuntimeRootDirectory
    delete next.webUiDirectory
    try {
      writeActiveRuntimeManifest(next)
    } catch (writeErr) {
      console.warn(`[runtime] failed to persist desktop runtime storage migration error: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`)
    }
    console.warn(`[runtime] failed to migrate desktop runtime storage: ${error}`)
    return { migrated: false, error }
  }
}

export function writeActiveRuntimeVersion(
  runtimeRoot = desktopRuntimeDir(),
  options: { clearRuntimeActivationError?: boolean } = {},
): void {
  const manifest = readCachedRuntimeManifest(runtimeRoot)
  const hermesRuntimeVersion = manifest?.hermesAgentVersion || desktopRuntimeVersion()
  const selectedWebUiDirectory = webuiDir()
  const active = readActiveRuntimeVersion()
  const desktopAppVersion = app.getVersion().trim()
  const previousDesktopAppVersion = active?.desktopAppVersion?.trim() || ''
  const desktopAppVersionChanged = Boolean(
    active
    && desktopAppVersion
    && previousDesktopAppVersion !== desktopAppVersion,
  )
  const activeWebUiVersion = active?.webUiVersion?.trim().replace(/^v/, '') || ''
  const expectedWebUiDirectory = activeWebUiVersion
    ? join(runtimeStorageRoot(), 'webui', activeWebUiVersion)
    : ''
  const hasWebUiOverride = !!process.env.HERMES_WEB_UI_DIR?.trim()
  const usingDownloadedWebUi = !!expectedWebUiDirectory
    && resolve(selectedWebUiDirectory) === resolve(expectedWebUiDirectory)
  const next: ActiveRuntimeVersion = {
    ...(active || {}),
    schema: 1,
    desktopAppVersion,
    hermesRuntimeVersion,
    runtimeDirectory: runtimeRoot,
    platform: runtimePlatformKey(),
    updatedAt: new Date().toISOString(),
  }
  next.runtimeValidationFailures = (active?.runtimeValidationFailures || [])
    .filter(failure => resolve(failure.directory) !== resolve(runtimeRoot))
  if (desktopAppVersionChanged) {
    delete next.webUiVersion
    if (activeWebUiVersion) {
      console.log(
        `[runtime] desktop updated from ${previousDesktopAppVersion || 'a legacy version'} `
        + `to ${desktopAppVersion}; using bundled Web UI`,
      )
    }
  } else if (hasWebUiOverride) {
    // Development overrides are temporary and must not replace the persisted downloaded version.
  } else if (usingDownloadedWebUi) {
    next.webUiVersion = webUiVersion()
  } else {
    delete next.webUiVersion
  }
  delete next.webUiDirectory
  if (options.clearRuntimeActivationError) delete next.runtimeActivationError
  writeActiveRuntimeManifest(next)
}

function cachedRuntimeMatches(root: string, descriptor: RuntimeDescriptor): boolean {
  if (!rootRuntimeReady(root)) return false
  const manifest = readCachedRuntimeManifest(root)
  if (!manifest?.asset?.name) return true
  return manifest.asset.name === descriptor.name
}

function downloadFile(
  url: string,
  target: string,
  onProgress?: RuntimeProgressHandler,
  redirects = 5,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const getter = parsed.protocol === 'http:' ? httpGet : httpsGet
    const req = getter(parsed, response => {
      const status = response.statusCode || 0
      const location = response.headers.location
      if (status >= 300 && status < 400 && location && redirects > 0) {
        response.resume()
        downloadFile(new URL(location, url).toString(), target, onProgress, redirects - 1).then(resolve, reject)
        return
      }
      if (status < 200 || status >= 300) {
        response.resume()
        reject(new Error(`GET ${url} returned ${status}`))
        return
      }

      const totalBytes = Number(response.headers['content-length']) || undefined
      let receivedBytes = 0
      response.on('data', chunk => {
        receivedBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk)
        onProgress?.({
          stage: 'download',
          message: t('runtime.downloading'),
          percent: totalBytes ? Math.min(100, (receivedBytes / totalBytes) * 100) : undefined,
          receivedBytes,
          totalBytes,
        })
      })

      const file = createWriteStream(target)
      response.pipe(file)
      file.on('finish', () => file.close(() => resolve()))
      file.on('error', reject)
    })
    req.on('error', err => {
      reject(new Error(`GET ${url} failed: ${err instanceof Error ? err.message : String(err)}`))
    })
  })
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('end', resolve)
    stream.on('error', reject)
  })
  return hash.digest('hex')
}

async function extractRuntimeArchive(archive: string, targetRoot: string): Promise<void> {
  const parent = dirname(targetRoot)
  const tempRoot = join(parent, `.runtime-${process.pid}-${Date.now()}`)
  rmSync(tempRoot, { recursive: true, force: true })
  mkdirSync(tempRoot, { recursive: true })

  try {
    await extractTarGzipArchive(archive, tempRoot)
    repairMovedHermesRuntime(tempRoot, tempRoot, targetRoot)
    validateRuntimeDirectory(tempRoot, 'Runtime archive')
    rmSync(targetRoot, { recursive: true, force: true })
    mkdirSync(parent, { recursive: true })
    renameSync(tempRoot, targetRoot)
  } catch (err) {
    rmSync(tempRoot, { recursive: true, force: true })
    throw err
  }
}

export async function ensureDesktopRuntime(
  onProgress?: RuntimeProgressHandler,
  source?: RuntimeDownloadSource,
): Promise<void> {
  const runtimeRoot = targetDesktopRuntimeDir()
  mkdirSync(runtimeRoot, { recursive: true })

  let descriptor: RuntimeDescriptor
  try {
    onProgress?.({ stage: 'resolve', message: t('runtime.checking') })
    descriptor = await resolveRuntimeDescriptor(source)
  } catch (err) {
    if (runtimeReady() && !process.env.HERMES_DESKTOP_RUNTIME_FORCE_UPDATE) {
      console.warn(`[runtime] using cached Hermes runtime because update check failed: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    throw err
  }

  if (cachedRuntimeMatches(runtimeRoot, descriptor) && !process.env.HERMES_DESKTOP_RUNTIME_FORCE_UPDATE) return

  const downloadTempDir = mkdtempSync(join(tmpdir(), 'hermes-runtime-download-'))
  const archive = join(downloadTempDir, `${descriptor.name}.download`)
  console.log(`[runtime] downloading Hermes runtime ${descriptor.name}`)
  onProgress?.({ stage: 'download', message: t('runtime.downloadingPackage', { name: descriptor.name }) })
  let archiveSize = 0
  try {
    await downloadFile(descriptor.url, archive, onProgress)
    archiveSize = statSync(archive).size
    if (descriptor.sha256) {
      onProgress?.({ stage: 'verify', message: t('runtime.verifying') })
      const actual = await sha256File(archive)
      if (actual !== descriptor.sha256) {
        throw new Error(`Runtime checksum mismatch for ${descriptor.name}`)
      }
    }

    onProgress?.({ stage: 'extract', message: t('runtime.extracting') })
    await extractRuntimeArchive(archive, runtimeRoot)
  } finally {
    rmSync(archive, { force: true })
    rmSync(downloadTempDir, { recursive: true, force: true })
  }

  const manifestPath = join(runtimeRoot, RUNTIME_MANIFEST_NAME)
  if (!existsSync(manifestPath)) {
    writeFileSync(manifestPath, JSON.stringify({
      schema: 1,
      platform: runtimePlatformKey(),
      hermesAgentVersion: descriptor.hermesAgentVersion,
      asset: {
        name: descriptor.name,
        sha256: descriptor.sha256,
        size: archiveSize,
      },
    }, null, 2))
  }
  onProgress?.({ stage: 'ready', message: t('runtime.ready') })
  writeActiveRuntimeVersion(runtimeRoot, { clearRuntimeActivationError: true })
  console.log(`[runtime] Hermes runtime ready at ${runtimeRoot}`)
}
