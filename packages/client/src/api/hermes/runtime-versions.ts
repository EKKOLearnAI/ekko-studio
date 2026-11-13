import { request } from '@/api/client'

export interface ActiveVersionManifest {
  schema: number
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

export interface InstalledRuntimeVersion {
  version: string
  platform: string
  directory: string
  active: boolean
  manifestHermesRuntimeVersion?: string
}

export interface InstalledWebUiVersion {
  version: string
  directory: string
  active: boolean
}

export interface HermesCliInstallation {
  path: string
  version: string
  source: 'managed-runtime' | 'user-cli'
  selected: boolean
  managedRuntimeVersion?: string
}

export type VersionDownloadKind = 'runtime' | 'webui'
export type VersionDownloadSource = 'cf' | 'github'
export type VersionDownloadJobStatus = 'queued' | 'running' | 'completed' | 'failed'
export type VersionDownloadStage = 'queued' | 'resolve' | 'download' | 'verify' | 'extract' | 'install' | 'completed' | 'failed'

export interface VersionDownloadJob {
  id: string
  kind: VersionDownloadKind
  source: VersionDownloadSource
  version: string
  status: VersionDownloadJobStatus
  stage: VersionDownloadStage
  message: string
  error: string
  percent?: number
  receivedBytes?: number
  totalBytes?: number
  createdAt: string
  updatedAt: string
  result?: InstalledRuntimeVersion | InstalledWebUiVersion
}

export interface RuntimeVersionStatus {
  active: ActiveVersionManifest | null
  platform: string
  activeVersionPath: string
  remoteManifestUrl: string
  remoteError: string
  hermes: {
    activeVersion: string
    agentVersion: string
    activeDirectory: string
    pythonPath: string
    agentRoot: string
    source?: 'user-cli' | 'managed-runtime' | 'none'
    dataDirectory: string
    storageDirectory: string
    defaultStorageDirectory: string
    pendingStorageDirectory: string
    migrationError: string
    activationError: string
    cliInstallations: HermesCliInstallation[]
    installed: InstalledRuntimeVersion[]
    remoteVersions: string[]
  }
  webui: {
    currentVersion: string
    activeVersion: string
    activeDirectory: string
    installed: InstalledWebUiVersion[]
    remoteVersions: string[]
  }
}

export async function fetchRuntimeVersionStatus(options: { probeRuntime?: boolean; includeRemote?: boolean } = {}): Promise<RuntimeVersionStatus> {
  const params = new URLSearchParams()
  if (options.probeRuntime === false) params.set('runtime', 'false')
  if (options.includeRemote === false) params.set('remote', 'false')
  const query = params.size ? `?${params.toString()}` : ''
  return request<RuntimeVersionStatus>(`/api/hermes/runtime-versions${query}`)
}

export async function activateRuntimeVersion(version: string): Promise<{ success: boolean; active: ActiveVersionManifest }> {
  return request<{ success: boolean; active: ActiveVersionManifest }>('/api/hermes/runtime-versions/active-runtime', {
    method: 'POST',
    body: JSON.stringify({ version }),
  })
}

export async function selectRuntimeRoot(directory: string): Promise<{ success: boolean; active: ActiveVersionManifest }> {
  return request<{ success: boolean; active: ActiveVersionManifest }>('/api/hermes/runtime-versions/runtime-root', {
    method: 'POST',
    body: JSON.stringify({ directory }),
  })
}

export async function activateWebUiVersion(version: string): Promise<{ success: boolean; active: ActiveVersionManifest }> {
  return request<{ success: boolean; active: ActiveVersionManifest }>('/api/hermes/runtime-versions/active-webui', {
    method: 'POST',
    body: JSON.stringify({ version }),
  })
}

export async function downloadRuntimeVersion(version: string, source: VersionDownloadSource): Promise<{ success: boolean; job: VersionDownloadJob }> {
  return request<{ success: boolean; job: VersionDownloadJob }>('/api/hermes/runtime-versions/runtime/download', {
    method: 'POST',
    body: JSON.stringify({ version, source }),
  })
}

export async function deleteRuntimeVersion(version: string): Promise<{ success: boolean; deleted: InstalledRuntimeVersion }> {
  return request<{ success: boolean; deleted: InstalledRuntimeVersion }>(`/api/hermes/runtime-versions/runtime/${encodeURIComponent(version)}`, {
    method: 'DELETE',
  })
}

export async function restartWebUiAfterRuntimeChange(): Promise<{ success: boolean }> {
  return request<{ success: boolean }>('/api/hermes/runtime-versions/restart-webui', {
    method: 'POST',
  })
}

export async function downloadWebUiVersion(version: string, source: VersionDownloadSource): Promise<{ success: boolean; job: VersionDownloadJob }> {
  return request<{ success: boolean; job: VersionDownloadJob }>('/api/hermes/runtime-versions/webui/download', {
    method: 'POST',
    body: JSON.stringify({ version, source }),
  })
}

export async function deleteWebUiVersion(version: string): Promise<{ success: boolean; deleted: InstalledWebUiVersion }> {
  return request<{ success: boolean; deleted: InstalledWebUiVersion }>(`/api/hermes/runtime-versions/webui/${encodeURIComponent(version)}`, {
    method: 'DELETE',
  })
}

export async function fetchVersionDownloadJobs(): Promise<{ jobs: VersionDownloadJob[] }> {
  return request<{ jobs: VersionDownloadJob[] }>('/api/hermes/runtime-versions/jobs')
}

export async function fetchVersionDownloadJob(id: string): Promise<VersionDownloadJob> {
  return request<VersionDownloadJob>(`/api/hermes/runtime-versions/jobs/${encodeURIComponent(id)}`)
}
