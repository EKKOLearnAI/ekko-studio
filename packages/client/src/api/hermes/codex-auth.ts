import { request } from '../client'

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

export async function startCodexLogin(): Promise<CodexStartResult> {
  return request<CodexStartResult>('/api/hermes/auth/codex/start', { method: 'POST' })
}

export async function pollCodexLogin(sessionId: string): Promise<CodexPollResult> {
  return request<CodexPollResult>(`/api/hermes/auth/codex/poll/${sessionId}`)
}

export async function getCodexAuthStatus(): Promise<CodexStatusResult> {
  return request<CodexStatusResult>('/api/hermes/auth/codex/status')
}
