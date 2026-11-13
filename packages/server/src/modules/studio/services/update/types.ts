export type UpdateStrategy = 'npm-package' | 'source-deploy' | 'device-package'

export type UpdatePackageType = 'device-package' | 'npm-package' | 'source-deploy'

export interface UpdateConfig {
  enabled: boolean
  strategy: UpdateStrategy
  includeAgentUpgrade: boolean
  autoInstallDependencies: boolean
  packageName: string
  registry: string
  sourceLabel: string
  distTag: string
  cliBin: string
  script: string
  runnerService: string
  runnerRequestFile: string
  channel: string
  manifestUrl: string
  manifestUrls?: string[]
  manifestBaseUrl: string
  sourceRepoUrl?: string
  packageType: UpdatePackageType
  installerScript: string
  stagingDir: string
  backupDir: string
  healthcheckUrl: string
  stateFile: string
  logDir: string
  manifestTimeoutMs: number
  packageTimeoutMs: number
  downloadRetries: number
  downloadRetryDelayMs: number
  healthcheckTimeoutMs: number
  healthcheckIntervalMs: number
  healthcheckRetries: number
  healthcheckInitialDelayMs: number
  minFreeSpaceBytes: number
  taskHeartbeatTimeoutMs: number
}

export interface UpdateRuntimePaths {
  deployDir: string
  webUiHome: string
  uploadDir: string
  hermesHome: string
}

export type UpdateRiskLevel = 'low' | 'medium' | 'high'

export type UpdatePreflightIssueCode =
  | 'webui-home-in-deploy-dir'
  | 'upload-dir-in-deploy-dir'
  | 'hermes-home-in-deploy-dir'
  | 'agent-data-safety'
  | 'update-state-dir-not-writable'
  | 'update-staging-dir-not-writable'
  | 'update-log-dir-not-writable'
  | 'insufficient-disk-space'

export interface UpdatePreflightIssue {
  code: UpdatePreflightIssueCode
  level: UpdateRiskLevel
  path: string
  message: string
}

export interface UpdatePreflightResult {
  strategy: UpdateStrategy
  paths: UpdateRuntimePaths
  riskLevel: UpdateRiskLevel
  issues: UpdatePreflightIssue[]
  shouldBlock: boolean
  warningText: string
  blockingText: string
}

export interface UpdatePreflightOptions {
  stagingDir?: string
  logDir?: string
  stateFile?: string
  minFreeSpaceBytes?: number
  requiredFreeSpaceBytes?: number
}

export type UpdateTaskStatus = 'idle' | 'queued' | 'running' | 'succeeded' | 'failed'

export type UpdateTaskOwner = 'controller' | 'runtime'

export type UpdateTaskStage =
  | 'idle'
  | 'queued'
  | 'preflighting'
  | 'checking'
  | 'resolving_version'
  | 'downloading'
  | 'verifying'
  | 'backing_up'
  | 'reconciling_env'
  | 'starting'
  | 'installing_dependencies'
  | 'installing'
  | 'stopping_runtime'
  | 'restarting'
  | 'starting_runtime'
  | 'health_checking'
  | 'succeeded'
  | 'failed'
  | 'rolled_back'

export interface UpdateTaskRecord {
  id: string
  strategy: UpdateStrategy
  owner: UpdateTaskOwner
  status: UpdateTaskStatus
  stage: UpdateTaskStage
  message: string
  targetVersion: string
  warning: string
  error: string
  logPath: string
  rollbackMessage: string
  healthcheckUrl: string
  heartbeatAt: string
  startedAt: string
  finishedAt: string | null
}

export interface UpdateTaskStatusResponse {
  currentTask: UpdateTaskRecord | null
  lastTask: UpdateTaskRecord | null
  webui_version?: string
  webui_latest?: string
  webui_update_available?: boolean
}

export interface ManifestUpdateInfo {
  version: string
  channel: string
  sourceLabel: string
  packageType: UpdatePackageType
  manifestUrl: string
}

export type DeviceEnvironmentFileKind = 'present' | 'executable' | 'absent'

export interface DeviceEnvironmentFile {
  path: string
  kind: DeviceEnvironmentFileKind
}

export interface DeviceEnvironment {
  /**
   * Semver range string describing the Node.js versions on which this
   * package is expected to run. Defaults to `compatibleNodeRange` (or
   * `minCurrentVersion` for source-deploy manifests) when omitted by
   * the publisher. Consumers may treat absence as "no constraint".
   */
  requiredNodeRange?: string
  /**
   * Semver range string describing the Hermes Agent versions on which
   * this package is expected to run. The install script reads the
   * running agent version and refuses to proceed when the version
   * does not satisfy the range. Optional: when absent, no agent check
   * is performed.
   */
  requiredHermesAgentRange?: string
  /**
   * Filesystem descriptors the package requires on the target host.
   * `path` is relative to the deploy root unless it starts with `/`.
   * The controller-side gates that act on this field are wired in a
   * later reconciliation phase; this phase only declares the schema.
   */
  requiredSystemFiles?: DeviceEnvironmentFile[]
}

export interface DevicePackageManifest extends ManifestUpdateInfo {
  artifactFormat: 'tar.gz'
  packageUrl: string
  packageUrls?: string[]
  sha256: string
  releasedAt: string
  compatibleNodeRange: string
  minCurrentVersion: string
  notesUrl: string
  size: number
  healthcheckUrl: string
  /**
   * Relative path inside the device package to the install script that runs
   * the device-package update. Devices compare this path's on-disk sha256
   * against `installerScriptSha256` to refuse updates with stale installers.
   * Optional for backward compatibility with manifests published before
   * this contract was introduced.
   */
  installerScriptPath?: string
  installerScriptSha256?: string
  /**
   * Optional host-state descriptor (Node range, Hermes Agent range,
   * system files). See `DeviceEnvironment`. Forward-compatible: missing
   * means "no extra constraint beyond `compatibleNodeRange`".
   */
  environment?: DeviceEnvironment
}

export interface SourcePackageManifest extends ManifestUpdateInfo {
  artifactFormat: 'tar.gz'
  sourceUrl: string
  sourceUrls?: string[]
  sourceSha256: string
  releasedAt: string
  minCurrentVersion: string
  notesUrl: string
  sourceRepoUrl?: string
  sourceSize: number
  healthcheckUrl: string
  /**
   * Optional host-state descriptor. Same shape and semantics as
   * `DevicePackageManifest.environment`. Source-deploy manifests reuse
   * the same `DeviceEnvironment` block so a single parser handles both.
   */
  environment?: DeviceEnvironment
}

export interface UpdateCheckResult {
  latestVersion: string
  sourceLabel: string
  channel: string
  packageType: UpdatePackageType
  strategy: UpdateStrategy
  detectionSource: 'manifest' | 'npm-registry'
  /**
   * Non-fatal update-source warnings. Today one value:
   * `manifest_pinned_stale` — an explicit pinned manifest URL (a
   * versioned `releases/vX.Y.Z/manifest.json` or a
   * `candidates/<channel>/<version>.json`) answered successfully but
   * froze on a version ≤ what the channel tip already knows (task-12
   * § Update-source hardening; the v0.8.6 candidate-pin incident).
   */
  warnings?: Array<'manifest_pinned_stale'>
  /** URL of the pinned manifest when `manifest_pinned_stale` fired. */
  pinnedManifestUrl?: string
  /** URL that actually won the update check. */
  effectiveManifestUrl?: string
}

export interface UpdateCapabilities {
  enabled: boolean
  strategy: UpdateStrategy
  packageType: UpdatePackageType
  channel: string
  sourceLabel: string
  currentVersion: string
  latestVersion: string
  updateAvailable: boolean
  detectionSource: UpdateCheckResult['detectionSource'] | 'none'
  warnings: UpdateCheckResult['warnings']
  pinnedManifestUrl: string
  effectiveManifestUrl: string
  remoteError: string
  supports: {
    versionCheck: boolean
    fullPackage: boolean
    deltaPackage: boolean
    resumableDownload: boolean
    checksumVerification: boolean
    rollback: boolean
    healthcheck: boolean
    silentInstall: boolean
    promptedInstall: boolean
    crossPlatformShell: boolean
  }
  runtime: {
    manifestConfigured: boolean
    executionConfigured: boolean
    runnerManaged: boolean
    autoInstallDependencies: boolean
    includeAgentUpgrade: boolean
    stateFile: string
    logDir: string
    stagingDir: string
    backupDir: string
    minFreeSpaceBytes: number
  }
  preflight: UpdatePreflightResult
}
