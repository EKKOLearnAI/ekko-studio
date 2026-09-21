import { request } from '../client'

export interface NousStartResult {
  session_id: string
  user_code: string
  verification_url: string
  expires_in: number
}

export interface NousPollResult {
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'error'
  error: string | null
}

export interface NousStatusResult {
  authenticated: boolean
}

export async function startNousLogin(): Promise<NousStartResult> {
  return request<NousStartResult>('/api/hermes/auth/nous/start', { method: 'POST' })
}

export async function pollNousLogin(sessionId: string): Promise<NousPollResult> {
  return request<NousPollResult>(`/api/hermes/auth/nous/poll/${sessionId}`)
}

export async function getNousAuthStatus(): Promise<NousStatusResult> {
  return request<NousStatusResult>('/api/hermes/auth/nous/status')
}
