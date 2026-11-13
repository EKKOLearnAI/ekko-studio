import { request } from '../client'

export type LanEndpointKind = 'web' | 'desktop' | 'custom'
export type DeviceInboundStatus = 'none' | 'pending' | 'approved' | 'rejected' | 'blocked'
export type DeviceOutboundStatus = 'none' | 'pending' | 'approved' | 'rejected' | 'blocked'

export interface LanDeviceInfo {
  id: string
  device_id: string
  inbound_status: DeviceInboundStatus
  outbound_status: DeviceOutboundStatus
  device_public_key: string
  online?: boolean
  ip: string
  http_port: number
  endpoint_kind: LanEndpointKind
  url: string
  computer_name: string
  os: {
    type: string
    platform: string
    release: string
    arch: string
  }
  hermes_agent_version: string
  hermes_web_ui_version: string
  response_ms: number
  requested_at: number
  decided_at: number | null
  outbound_requested_at: number
  outbound_decided_at: number | null
  inbound_history_deleted_at: number | null
  last_seen_at: number
  updated_at: number
}

export interface LanDiscoveryState {
  scanning: boolean
  last_scanned_at: string | null
  devices: LanDeviceInfo[]
  requests: LanDeviceInfo[]
}

export interface LanPeerConnectionInfo {
  id: string
  role: 'server' | 'client'
  device_id: string
  computer_name: string
  url: string
  connected_at: number
}

export interface DevicePairingLink {
  code: string
  link: string
}

export async function fetchLanDevices(): Promise<LanDiscoveryState> {
  return request<LanDiscoveryState>('/api/studio/devices')
}

export async function fetchDevicePairingLink(): Promise<DevicePairingLink> {
  return request<DevicePairingLink>('/api/studio/devices/pairing-link')
}

export async function scanLanDevices(): Promise<LanDiscoveryState> {
  return request<LanDiscoveryState>('/api/studio/devices/scan', { method: 'POST' })
}

export async function requestDevicePairing(id: string, pairingCode: string): Promise<LanDiscoveryState> {
  return request<LanDiscoveryState>(`/api/studio/devices/${encodeURIComponent(id)}/request`, {
    method: 'POST',
    body: JSON.stringify({ pairing_code: pairingCode }),
  })
}

export async function requestDevicePairingByUrl(url: string): Promise<LanDiscoveryState> {
  return request<LanDiscoveryState>('/api/studio/devices/manual-request', {
    method: 'POST',
    body: JSON.stringify({ url }),
  })
}

export async function approveDevice(id: string): Promise<LanDiscoveryState> {
  return request<LanDiscoveryState>(`/api/studio/devices/${encodeURIComponent(id)}/approve`, { method: 'POST' })
}

export async function rejectDevice(id: string): Promise<LanDiscoveryState> {
  return request<LanDiscoveryState>(`/api/studio/devices/${encodeURIComponent(id)}/reject`, { method: 'POST' })
}

export async function blockDevice(id: string): Promise<LanDiscoveryState> {
  return request<LanDiscoveryState>(`/api/studio/devices/${encodeURIComponent(id)}/block`, { method: 'POST' })
}

export async function unblockDevice(id: string): Promise<LanDiscoveryState> {
  return request<LanDiscoveryState>(`/api/studio/devices/${encodeURIComponent(id)}/unblock`, { method: 'POST' })
}

export async function deleteDeviceRequestHistory(id: string): Promise<LanDiscoveryState> {
  return request<LanDiscoveryState>(`/api/studio/devices/${encodeURIComponent(id)}/request-history`, { method: 'DELETE' })
}

export async function fetchLanPeerConnections(): Promise<{ connections: LanPeerConnectionInfo[] }> {
  return request<{ connections: LanPeerConnectionInfo[] }>('/api/studio/devices/peer-connections')
}

export async function connectLanPeerDevice(id: string): Promise<{ connection: LanPeerConnectionInfo }> {
  return request<{ connection: LanPeerConnectionInfo }>(`/api/studio/devices/${encodeURIComponent(id)}/connect`, { method: 'POST' })
}

export async function disconnectLanPeerDevice(connectionId: string): Promise<{ connections: LanPeerConnectionInfo[] }> {
  return request<{ connections: LanPeerConnectionInfo[] }>(
    `/api/studio/devices/peer-connections/${encodeURIComponent(connectionId)}/disconnect`,
    { method: 'POST' },
  )
}
