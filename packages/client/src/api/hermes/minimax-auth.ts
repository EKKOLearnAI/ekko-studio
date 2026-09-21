import { request as defaultRequest } from '../client'

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


export function createApi(request: typeof defaultRequest = (...args) => defaultRequest(...args)) {
  async function startMiniMaxLogin(region: 'global' | 'cn'): Promise<MiniMaxStartResult> {
    return request<MiniMaxStartResult>('/api/hermes/auth/minimax/start', {
      method: 'POST',
      body: JSON.stringify({ region }),
    })
  }

  async function pollMiniMaxLogin(sessionId: string): Promise<MiniMaxPollResult> {
    return request<MiniMaxPollResult>(`/api/hermes/auth/minimax/poll/${sessionId}`)
  }

  return { startMiniMaxLogin, pollMiniMaxLogin }
}

export const { startMiniMaxLogin, pollMiniMaxLogin } = createApi()
