import { request } from '../client'

/** A pending, server-frozen request to deliver scheduled cron results into one session. */
export interface CronConsentRequest {
  id: string
  kind: 'script_report_enrollment' | 'cron_session_binding'
  mode: 'new' | 'existing'
  action: 'create_job' | 'modify_job' | 'subscribe_job'
  profile: string
  session_id: string
  session_title: string | null
  context_kind: 'turn' | 'prepared'
  requested_via: 'model_run' | 'login'
  created_at: number
  expires_at: number
  job_id?: string
  name: string
  schedule: string
  script?: string
  script_kind?: 'bash' | 'python'
  script_sha256?: string
  workdir?: string | null
  interpreter?: string | null
  resume?: boolean
  prompt?: string
  prompt_truncated?: boolean
  prior_binding?: { session_id: string; session_title: string | null } | null
}

export interface CronConsentContext {
  context_id: string
  profile: string
  session_id: string
  expires_at: number
}

// Every call names its profile explicitly, so the selected session's profile always wins.
const profileHeaders = (profile: string) => ({ 'X-Hermes-Profile': profile })

export async function listCronConsents(profile: string, sessionId: string): Promise<CronConsentRequest[]> {
  const query = new URLSearchParams({ profile, session_id: sessionId })
  const result = await request<{ requests: CronConsentRequest[] }>(`/api/hermes/cron/consent-requests?${query}`, { headers: profileHeaders(profile) })
  return result.requests
}

export function decideCronConsent(profile: string, id: string, decision: 'approve' | 'deny'): Promise<Record<string, unknown>> {
  return request(`/api/hermes/cron/consent-requests/${encodeURIComponent(id)}/${decision}`, {
    method: 'POST', headers: profileHeaders(profile), body: JSON.stringify({ profile }),
  })
}

export function prepareCronConsentContext(profile: string, sessionId: string): Promise<CronConsentContext> {
  return request('/api/hermes/cron/consent-contexts', {
    method: 'POST', headers: profileHeaders(profile), body: JSON.stringify({ profile, session_id: sessionId }),
  })
}
