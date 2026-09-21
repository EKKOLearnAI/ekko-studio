import { request as defaultRequest } from '../client'

export interface XaiStartResult {
  session_id: string
  authorization_url: string
  expires_in: number
}

export interface XaiPollResult {
  status: 'pending' | 'approved' | 'expired' | 'error'
  error: string | null
}

export interface XaiStatusResult {
  authenticated: boolean
  last_refresh?: string
}


export function createApi(request: typeof defaultRequest = (...args) => defaultRequest(...args)) {
  async function startXaiLogin(): Promise<XaiStartResult> {
    return request<XaiStartResult>('/api/hermes/auth/xai/start', { method: 'POST' })
  }

  async function pollXaiLogin(sessionId: string): Promise<XaiPollResult> {
    return request<XaiPollResult>(`/api/hermes/auth/xai/poll/${sessionId}`)
  }

  async function getXaiAuthStatus(): Promise<XaiStatusResult> {
    return request<XaiStatusResult>('/api/hermes/auth/xai/status')
  }

  return { startXaiLogin, pollXaiLogin, getXaiAuthStatus }
}

export const { startXaiLogin, pollXaiLogin, getXaiAuthStatus } = createApi()
