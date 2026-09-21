import { request } from '../client'

export interface MiniMaxStartResult {
  session_id: string
  user_code: string
  verification_url: string
  expires_in: number
}

export interface MiniMaxPollResult {
  status: 'pending' | 'approved' | 'expired' | 'error'
  error: string | null
}

export async function startMiniMaxLogin(region: 'global' | 'cn'): Promise<MiniMaxStartResult> {
  return request<MiniMaxStartResult>('/api/hermes/auth/minimax/start', {
    method: 'POST',
    body: JSON.stringify({ region }),
  })
}

export async function pollMiniMaxLogin(sessionId: string): Promise<MiniMaxPollResult> {
  return request<MiniMaxPollResult>(`/api/hermes/auth/minimax/poll/${sessionId}`)
}
