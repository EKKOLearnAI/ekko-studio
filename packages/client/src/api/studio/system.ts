import { request } from '../client'

export interface HealthResponse {
  status: string
  platform?: string
  version?: string
  gateway?: string
  webui_version?: string
  webui_latest?: string
  webui_update_available?: boolean
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
}

export interface PreviewTag {
  name: string
  sha: string
}

export interface PreviewStatus {
  preview_dir: string
  exists: boolean
  has_package: boolean
  installed: boolean
  running: boolean
  pid: number | null
  current_tag: string
  frontend_url: string
  agent_bridge_endpoint: string
  log_path: string
  webui_home: string
  action_log_path: string
  dev_log_path: string
  active_action: string | null
  active_action_started_at: string | null
  last_action: string | null
  last_action_completed_at: string | null
  last_action_success: boolean | null
  last_action_message: string
  last_action_code: string
  action_log: string
  dev_log: string
}

export interface PreviewActionResponse extends PreviewStatus {
  success: boolean
  accepted?: boolean
  message?: string
  code?: string
}

export async function checkHealth(): Promise<HealthResponse> {
  return request<HealthResponse>('/health')
}

export async function triggerUpdate(): Promise<{ success: boolean; message: string }> {
  return request<{ success: boolean; message: string }>('/api/studio/update', { method: 'POST' })
}

export async function fetchPreviewStatus(): Promise<PreviewStatus> {
  return request<PreviewStatus>('/api/studio/update/preview')
}

export async function fetchPreviewTags(): Promise<{ tags: PreviewTag[] }> {
  return request<{ tags: PreviewTag[] }>('/api/studio/update/preview/tags')
}

export async function preparePreview(tag: string): Promise<PreviewActionResponse> {
  return request<PreviewActionResponse>('/api/studio/update/preview/prepare', {
    method: 'POST',
    body: JSON.stringify({ tag }),
  })
}

export async function installPreview(): Promise<PreviewActionResponse> {
  return request<PreviewActionResponse>('/api/studio/update/preview/install', { method: 'POST' })
}

export async function startPreview(tag?: string): Promise<PreviewActionResponse> {
  return request<PreviewActionResponse>('/api/studio/update/preview/start', {
    method: 'POST',
    body: JSON.stringify({ tag }),
  })
}

export async function stopPreview(): Promise<PreviewActionResponse> {
  return request<PreviewActionResponse>('/api/studio/update/preview/stop', { method: 'POST' })
}
