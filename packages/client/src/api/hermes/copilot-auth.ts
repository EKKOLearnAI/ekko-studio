import { request } from '../client'

export type CopilotTokenSource = 'env' | 'gh-cli' | 'apps-json' | null

export interface CopilotStartResult {
  session_id: string
  user_code: string
  verification_url: string
  expires_in: number
  interval: number
}

export interface CopilotPollResult {
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'error'
  error: string | null
}

export interface CopilotCheckTokenResult {
  has_token: boolean
  source: CopilotTokenSource
  enabled: boolean
}

export async function startCopilotLogin(): Promise<CopilotStartResult> {
  return request<CopilotStartResult>('/api/hermes/auth/copilot/start', { method: 'POST' })
}

export async function pollCopilotLogin(sessionId: string): Promise<CopilotPollResult> {
  return request<CopilotPollResult>(`/api/hermes/auth/copilot/poll/${sessionId}`)
}

export async function checkCopilotToken(): Promise<CopilotCheckTokenResult> {
  return request<CopilotCheckTokenResult>('/api/hermes/auth/copilot/check-token')
}

export async function enableCopilot(): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/api/hermes/auth/copilot/enable', { method: 'POST' })
}

export async function disableCopilot(): Promise<{ ok: boolean; cleared_env: boolean; cleared_default?: boolean }> {
  return request<{ ok: boolean; cleared_env: boolean; cleared_default?: boolean }>('/api/hermes/auth/copilot/disable', { method: 'POST' })
}
