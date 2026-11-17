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

export async function checkHealth(): Promise<HealthResponse> {
  return request<HealthResponse>('/health')
}

export async function triggerUpdate(): Promise<{ success: boolean; message: string }> {
  return request<{ success: boolean; message: string }>('/api/studio/update', { method: 'POST' })
}
