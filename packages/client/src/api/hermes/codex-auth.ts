import { request as defaultRequest } from '../client'

export interface CodexStartResult {
  session_id: string
  user_code: string
  verification_url: string
  expires_in: number
}

export interface CodexPollResult {
  status: 'pending' | 'approved' | 'expired' | 'error'
  error: string | null
}

export interface CodexStatusResult {
  authenticated: boolean
  last_refresh?: string
}


export function createApi(request: typeof defaultRequest = (...args) => defaultRequest(...args)) {
  async function startCodexLogin(): Promise<CodexStartResult> {
    return request<CodexStartResult>('/api/hermes/auth/codex/start', { method: 'POST' })
  }

  async function pollCodexLogin(sessionId: string): Promise<CodexPollResult> {
    return request<CodexPollResult>(`/api/hermes/auth/codex/poll/${sessionId}`)
  }

  async function getCodexAuthStatus(): Promise<CodexStatusResult> {
    return request<CodexStatusResult>('/api/hermes/auth/codex/status')
  }

  return { startCodexLogin, pollCodexLogin, getCodexAuthStatus }
}

export const { startCodexLogin, pollCodexLogin, getCodexAuthStatus } = createApi()
