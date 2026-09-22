import { request } from '../client'

/**
 * OrcaRouter OAuth 2.0 + PKCE connect flow.
 *
 * The verifier and the state live only on the server process; the browser
 * receives an authorization URL and, for the out-of-band flow, a code to paste
 * back. Nothing here ever sees an `sk-orca-` key in plain text beyond the
 * server-rendered preview.
 */

export type OrcaRouterCallbackMode = 'loopback' | 'oob'

export type OrcaRouterLoginStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'error'

export interface OrcaRouterStartResult {
  session_id: string
  authorization_url: string
  callback_mode: OrcaRouterCallbackMode
  expires_in: number
  scope: string
  key_dashboard_url: string
}

export interface OrcaRouterPollResult {
  status: OrcaRouterLoginStatus
  error: string | null
  error_code: string | null
  callback_mode: OrcaRouterCallbackMode
}

export interface OrcaRouterStatusResult {
  authenticated: boolean
  relogin_required?: boolean
  source?: string
  scope?: string | null
  key_preview?: string
}

export async function startOrcaRouterLogin(
  callbackMode: OrcaRouterCallbackMode = 'loopback',
): Promise<OrcaRouterStartResult> {
  return request<OrcaRouterStartResult>('/api/hermes/auth/orcarouter/start', {
    method: 'POST',
    body: JSON.stringify({ callback_mode: callbackMode }),
  })
}

export async function pollOrcaRouterLogin(sessionId: string): Promise<OrcaRouterPollResult> {
  return request<OrcaRouterPollResult>(`/api/hermes/auth/orcarouter/poll/${encodeURIComponent(sessionId)}`)
}

export async function submitOrcaRouterCode(sessionId: string, code: string): Promise<OrcaRouterPollResult> {
  return request<OrcaRouterPollResult>(`/api/hermes/auth/orcarouter/submit/${encodeURIComponent(sessionId)}`, {
    method: 'POST',
    body: JSON.stringify({ code }),
  })
}

export async function getOrcaRouterAuthStatus(): Promise<OrcaRouterStatusResult> {
  return request<OrcaRouterStatusResult>('/api/hermes/auth/orcarouter/status')
}

/**
 * Release the server-side login lock. `keepalive` lets the request survive a
 * page being torn down for the back-forward cache, so a restored page is not
 * left holding a lock nobody will release.
 */
export async function cancelOrcaRouterLogin(
  sessionId: string,
  options: { keepalive?: boolean } = {},
): Promise<void> {
  if (!sessionId) return
  try {
    await request<{ status: string }>(
      `/api/hermes/auth/orcarouter/cancel/${encodeURIComponent(sessionId)}`,
      { method: 'POST', ...(options.keepalive ? { keepalive: true } : {}) },
    )
  } catch {
    // Cancellation is best-effort: the session also expires server-side.
  }
}
