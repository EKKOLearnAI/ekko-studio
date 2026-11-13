import { request } from '../client'

export type AppRelayRoute = 'official' | 'cloudflare'

export interface AppRelayStatus {
  connected: boolean
  machineId: string
  pairingCode: string
  pairingExpiresAt: number
  expiresAt?: number
  route: AppRelayRoute
  relayUrl: string
}

interface AppRelayResponse {
  relay: AppRelayStatus
}

export async function fetchAppRelayStatus(): Promise<AppRelayStatus> {
  return (await request<AppRelayResponse>('/api/app-relay/status')).relay
}

export async function connectAppRelay(): Promise<AppRelayStatus> {
  return (await request<AppRelayResponse>('/api/app-relay/connect', { method: 'POST' })).relay
}

export async function updateAppRelayRoute(route: AppRelayRoute): Promise<AppRelayStatus> {
  return (await request<AppRelayResponse>('/api/app-relay/route', {
    method: 'PUT',
    body: JSON.stringify({ route }),
  })).relay
}

export async function refreshAppRelayPairingCode(): Promise<AppRelayStatus> {
  return (await request<AppRelayResponse>('/api/app-relay/pairing-code', { method: 'POST' })).relay
}

export async function disconnectAppRelay(): Promise<AppRelayStatus> {
  return (await request<AppRelayResponse>('/api/app-relay/disconnect', { method: 'POST' })).relay
}
