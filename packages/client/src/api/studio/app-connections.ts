import { request } from '../client'

export type AppConnectionType = 'lan' | 'cloud'
export type AppRelayRoute = 'official' | 'cloudflare'

export interface AppConnection {
  id: number
  device_code: string
  device_name: string
  device_brand: string
  device_model: string
  connection_type: AppConnectionType
  user_id: number
  push_enabled?: boolean
  can_manage_push?: boolean
  cloud_user_id: number
  username: string
  token_expires_at: number
  last_connected_at: number
  active: boolean
  online: boolean | null
  created_at: number
  updated_at: number
}

export interface AppConnectionListResponse {
  connections: AppConnection[]
  access_failure: AppConnectionAccessFailure | null
}

export interface AppConnectionAccessFailure {
  code: string
  deviceCode: string
  deviceName: string
  cloudUserId: number
  plan: string
  tokenTtlSeconds?: number
  occurredAt: number
}

export interface LanAppAuthorizationResponse {
  type: 'hermes-studio.app-connection'
  version: 1
  connection_type: 'lan'
  backend_url: string
  machine_id: string
  authorization_code: string
  expires_at: number
  qr_payload: string
}

export interface CloudAppAuthorizationResponse {
  type: 'hermes-studio.app-connection'
  version: 1
  connection_type: 'cloud'
  machine_id: string
  preconnect_id: string
  matching_code: string
  expires_at: number
  hard_expires_at: number
  refresh_remaining: number
  relay_route: AppRelayRoute
  qr_payload: string
}

export async function fetchAppConnections(): Promise<AppConnectionListResponse> {
  return request<AppConnectionListResponse>('/api/app-connections')
}

export async function createLanAppAuthorization(): Promise<LanAppAuthorizationResponse> {
  return request<LanAppAuthorizationResponse>('/api/app-connections/authorization-codes/lan', {
    method: 'POST',
  })
}

export async function createCloudAppAuthorization(
  refresh = false,
  route: AppRelayRoute = 'official',
): Promise<CloudAppAuthorizationResponse> {
  return request<CloudAppAuthorizationResponse>('/api/app-connections/authorization-codes/cloud', {
    method: 'POST',
    body: JSON.stringify({ refresh, route }),
  })
}

export async function deleteAppConnection(id: number): Promise<{ success: boolean; notified: number }> {
  return request<{ success: boolean; notified: number }>(`/api/app-connections/${id}`, {
    method: 'DELETE',
  })
}

export async function updateAppConnectionPush(id: number, enabled: boolean): Promise<{ success: boolean; push_enabled: boolean }> {
  return request(`/api/studio/app-connections/${id}/push`, {
    method: 'PATCH', body: JSON.stringify({ push_enabled: enabled }),
  })
}
