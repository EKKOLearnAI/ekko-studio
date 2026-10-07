import { request } from '../client'

export type ContextManagerBackend = 'native' | 'bili'
export type ContextManagerName = 'hermes' | 'ekko'
export type ContextManagerLifecycleAction = 'install' | 'start' | 'stop' | 'upgrade'

export interface ContextManagerSettings {
  hermes: { manager: ContextManagerBackend }
  ekko: { manager: ContextManagerBackend }
  proxyUrl: string
  allowNativeFallback: boolean
}

export type ContextManagerSettingsUpdate = Partial<ContextManagerSettings>

export interface ContextManagerHealthObservation {
  endpoint: string
  available: boolean
  statusCode: number | null
  data?: unknown
  error?: string
  errorCode?: string
}

export interface ContextManagerHealth {
  profile: string
  settings: ContextManagerSettings
  observations: {
    manifest: ContextManagerHealthObservation
    status: ContextManagerHealthObservation
  }
  healthy: boolean
  runtimeVersion: string | null
  compatibility: 'compatible' | 'incompatible' | 'unverified'
  compatibilityIssues: string[]
  worker: ContextManagerWorkerState
  lifecycle: ContextManagerLifecycleState
}

export interface ContextManagerLifecycleState {
  supported: true
  installed: boolean
  version: string | null
  running: boolean
  management: 'studio' | 'external' | 'none'
  runtimeOrigin: string | null
  configFile: string
}

export interface ContextManagerWorkerState {
  status: 'running' | 'stopped' | 'unknown'
  profile: string
  pids: number[]
  activeSessions: number | null
  runningSessions: number | null
  error?: { code: string; message: string }
}
export function restartContextManagerWorker(profile: string) {
  return request<{ profile: string; status: 'restarted'; worker: ContextManagerWorkerState }>('/api/studio/context-manager/worker/restart', {
    method: 'POST', headers: profileHeaders(profile), body: JSON.stringify({ profile, confirm: true }),
  })
}

const errorReasons: Record<string, string> = {
  context_manager_failed: 'failed', context_manager_invalid_request: 'invalidSettings', context_manager_storage_invalid: 'invalidSettings',
  context_manager_profile_changed: 'profileChanged', context_manager_sessions_running: 'sessionsRunning',
  context_manager_confirmation_required: 'confirmationRequired', context_manager_worker_unavailable: 'workerUnavailable',
  context_manager_restart_failed: 'restartFailed', context_manager_busy: 'busy', context_manager_externally_managed: 'externallyManaged',
  context_manager_installation_invalid: 'installFailed', context_manager_install_failed: 'installFailed', context_manager_npm_unavailable: 'installFailed',
  context_manager_start_failed: 'startFailed', context_manager_stop_failed: 'stopFailed', context_manager_upgrade_running: 'stopFirst',
  context_manager_origin_changed: 'stopFirst', context_manager_not_installed: 'notInstalled', context_manager_https_external_only: 'httpOnly',
  context_manager_port_unknown: 'probeFailed', context_manager_probe_failed: 'probeFailed', context_manager_probe_http: 'probeHttp',
  context_manager_probe_timeout: 'probeTimeout', context_manager_probe_invalid: 'probeInvalid', context_manager_probe_large: 'probeInvalid',
}
export function contextManagerError(error: unknown): { code: string; reason: string } {
  const value = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown } : {}
  const code = typeof value.code === 'string' && Object.hasOwn(errorReasons, value.code) ? value.code : 'context_manager_failed'
  return { code, reason: errorReasons[code] }
}

export interface ContextManagerLifecycleResult {
  manager: ContextManagerName
  action: ContextManagerLifecycleAction
  status: 'installed' | 'started' | 'stopped' | 'upgraded'
  lifecycle: ContextManagerLifecycleState
}

function profileHeaders(profile: string): Record<string, string> {
  if (!profile.trim()) throw new Error('Profile is required')
  return { 'X-Hermes-Profile': profile }
}

export function getContextManagerSettings(profile: string) {
  return request<ContextManagerSettings>('/api/studio/context-manager/settings', { headers: profileHeaders(profile) })
}

export function saveContextManagerSettings(profile: string, settings: ContextManagerSettingsUpdate) {
  return request<ContextManagerSettings>('/api/studio/context-manager/settings', {
    method: 'PUT',
    headers: profileHeaders(profile),
    body: JSON.stringify(settings),
  })
}

export function getContextManagerHealth(profile: string) {
  return request<ContextManagerHealth>('/api/studio/context-manager/health', { headers: profileHeaders(profile) })
}

export function runContextManagerLifecycle(profile: string, manager: ContextManagerName, action: ContextManagerLifecycleAction) {
  return request<ContextManagerLifecycleResult>(`/api/studio/context-manager/lifecycle/${action}`, {
    method: 'POST',
    headers: profileHeaders(profile),
    body: JSON.stringify({ manager }),
  })
}
