import { request } from '../client'

export interface HealthResponse {
  status: string
  platform?: string
  version?: string
  gateway?: string
  webui_version?: string
  webui_latest?: string
  webui_update_enabled?: boolean
  webui_update_available?: boolean
  webui_update_source_label?: string
  webui_update_channel?: string
  webui_update_strategy?: 'npm-package' | 'source-deploy' | 'device-package' | string
  webui_update_package_type?: 'npm-package' | 'source-deploy' | 'device-package' | string
  node_version?: string
  is_docker?: boolean
  agent_bridge?: {
    status: string
    reachable: boolean
    ready?: boolean
    running?: boolean
    attached?: boolean
    starting?: boolean
    stopping?: boolean
    restart_scheduled?: boolean
    restart_attempts?: number
    endpoint_kind?: 'ipc' | 'tcp' | 'unknown'
    pid?: number
    error?: string
  }
  environment?: {
    status: 'ok' | 'drift_detected' | 'unavailable'
    capturedAt?: string | null
    manifestVersion?: string | null
    actualVersion?: string | null
    nodeVersion?: string | null
    agentVersion?: string | null
    drift?: Array<{
      gate: 'requiredNodeRange' | 'requiredHermesAgentRange' | 'requiredSystemFiles' | 'installerScriptSha256'
      expected: string
      actual: string
      detail?: string
    }>
    reconcileSupported?: boolean
    checkedAt?: string | null
  }
}

export type UpdateTaskStatus = 'idle' | 'queued' | 'running' | 'succeeded' | 'failed'

export type UpdateTaskStage =
  | 'idle'
  | 'queued'
  | 'preflighting'
  | 'checking'
  | 'resolving_version'
  | 'downloading'
  | 'verifying'
  | 'backing_up'
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
  strategy: 'npm-package' | 'source-deploy' | 'device-package'
  owner?: 'controller' | 'runtime'
  status: UpdateTaskStatus
  stage: UpdateTaskStage
  message: string
  targetVersion: string
  warning: string
  error: string
  logPath?: string
  rollbackMessage?: string
  healthcheckUrl?: string
  heartbeatAt?: string
  startedAt: string
  finishedAt: string | null
}

export interface UpdateStatusResponse {
  currentTask: UpdateTaskRecord | null
  lastTask: UpdateTaskRecord | null
  webui_version?: string
  webui_latest?: string
  webui_update_available?: boolean
}

export type UpdateRiskLevel = 'low' | 'medium' | 'high'

export interface UpdatePreflightIssue {
  code: string
  level: UpdateRiskLevel
  path: string
  message: string
}

export interface UpdatePreflightResult {
  strategy: 'npm-package' | 'source-deploy' | 'device-package' | string
  riskLevel: UpdateRiskLevel
  issues: UpdatePreflightIssue[]
  shouldBlock: boolean
  warningText: string
  blockingText: string
}

export interface UpdateCapabilitiesResponse {
  enabled: boolean
  strategy: 'npm-package' | 'source-deploy' | 'device-package' | string
  packageType: 'npm-package' | 'source-deploy' | 'device-package' | string
  channel: string
  sourceLabel: string
  currentVersion: string
  latestVersion: string
  updateAvailable: boolean
  detectionSource: 'manifest' | 'npm-registry' | 'none'
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

export interface TriggerUpdateResponse {
  success: boolean
  message: string
  taskId?: string
  status?: UpdateTaskStatus
  stage?: UpdateTaskStage
  warning?: string
}

export interface ClearStaleUpdateStatusResponse extends UpdateStatusResponse {
  success: boolean
  message: string
  clearedTaskId?: string
  code?: string
}

export type ManifestCacheFreshness = 'green' | 'yellow' | 'orange' | 'red'

export interface UpdateIdentity {
  schema: number
  capturedAt: string
  version: string
  distSha256: string
  installerScriptSha256: string
  agentManifestSha: string
  commitSha?: string
}

export interface UpdateIdentityResponse {
  success: boolean
  installed: boolean
  identity: UpdateIdentity | null
  manifestCache: {
    freshness: ManifestCacheFreshness
    cachedAt: string | null
    version: string | null
  }
}

export interface RepairIdentityResponse {
  success: boolean
  identity?: UpdateIdentity
  code?: string
  message?: string
}

export async function repairUpdateIdentity(): Promise<RepairIdentityResponse> {
  return request<RepairIdentityResponse>('/api/studio/update/identity/repair', { method: 'POST' })
}
export async function fetchUpdateIdentity(): Promise<UpdateIdentityResponse> {
  return request<UpdateIdentityResponse>('/api/studio/update/identity')
}

export async function checkHealth(): Promise<HealthResponse> {
  return request<HealthResponse>('/health')
}

export async function triggerUpdate(): Promise<TriggerUpdateResponse> {
  return request<TriggerUpdateResponse>('/api/studio/update', { method: 'POST' })
}

export async function fetchUpdateStatus(): Promise<UpdateStatusResponse> {
  return request<UpdateStatusResponse>('/api/studio/update/status')
}

export async function fetchUpdateCapabilities(): Promise<UpdateCapabilitiesResponse> {
  return request<UpdateCapabilitiesResponse>('/api/studio/update/capabilities')
}

export async function clearStaleUpdateStatus(): Promise<ClearStaleUpdateStatusResponse> {
  return request<ClearStaleUpdateStatusResponse>('/api/studio/update/status/clear-stale', {
    method: 'POST',
  })
}

export type EnvironmentStatus = 'ok' | 'drift_detected' | 'unavailable'

export interface EnvironmentDriftEntry {
  gate: 'requiredNodeRange' | 'requiredHermesAgentRange' | 'requiredSystemFiles' | 'installerScriptSha256'
  expected: string
  actual: string
  detail?: string
}

export interface EnvironmentCheckResponse {
  success: boolean
  status: EnvironmentStatus
  lastCapturedAt: string | null
  manifestVersion: string | null
  actualVersion: string | null
  nodeVersion: string | null
  agentVersion: string | null
  drift: EnvironmentDriftEntry[]
  reconcileSupported: boolean
  checkedAt: string | null
}

export async function fetchUpdateEnvironment(): Promise<EnvironmentCheckResponse> {
  return request<EnvironmentCheckResponse>('/api/studio/update/environment', { method: 'GET' })
}

export async function reconcileUpdate(): Promise<{ success: boolean; status?: string; taskId?: string; message?: string }> {
  return request('/api/studio/update/reconcile', { method: 'POST' })
}
