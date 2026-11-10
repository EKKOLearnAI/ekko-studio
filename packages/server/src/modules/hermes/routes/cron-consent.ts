import Router from '@koa/router'
import * as ctrl from '../controllers/cron-consent'
import * as trusted from '../controllers/trusted-cron'

export const cronConsentRoutes = new Router()

/** Login only. Open a model-free setup context for one session: body { profile, session_id } → { context_id, expires_at }. Issues the profile's ordinary MCP runtime credential. */
cronConsentRoutes.post('/api/hermes/cron/consent-contexts', ctrl.prepare)
/** Login only. List the caller's pending consent requests for a session: query profile, session_id. */
cronConsentRoutes.get('/api/hermes/cron/consent-requests', ctrl.list)
/** MCP runtime credential: ask the user to approve cron result delivery into a chat. Body { profile, context_id (current turn or prepared), kind: "cron_session_binding" + job_id | "script_report_enrollment" + mode "new" (name, schedule, script) or "existing" + job_id, optional target_session_id (another session of the same account and profile; the card stays in the context's session) }. No session_id. 202 pending; nothing runs until approved in Studio. */
cronConsentRoutes.post('/api/hermes/cron/consent-requests', ctrl.request)
/** Login only, same account. Execute the frozen request once: body { profile }. */
cronConsentRoutes.post('/api/hermes/cron/consent-requests/:id/approve', ctrl.approve)
/** Login only, same account. Discard the request: body { profile }. */
cronConsentRoutes.post('/api/hermes/cron/consent-requests/:id/deny', ctrl.deny)
/** Login only. The caller's trusted current-session Cron automation policy for a profile (default off): query profile. */
cronConsentRoutes.get('/api/hermes/cron/trusted-automation', trusted.getPolicy)
/** Login only. Enable or disable trusted current-session Cron automation: body { profile, enabled, expected_revision }. Every change rotates the policy epoch. */
cronConsentRoutes.put('/api/hermes/cron/trusted-automation', trusted.putPolicy)
/** Trusted admission credential only (Studio's managed MCP, never a JWT). Policy on: create, enroll or bind a Cron job with no approval card. Body { profile, kind: "cron_job" (name, schedule, prompt) | "cron_session_binding" + job_id | "script_report_enrollment" + mode "new" (name, schedule, script) or "existing" + job_id, optional target_session_id (another chat of the same account and profile) }. Default: the current chat. Policy off (403): use consent-requests. */
cronConsentRoutes.post('/api/hermes/cron/current-session', trusted.admit)
/** Login only. Model-free admission for a session the caller can use: body { profile, session_id, kind, ..., optional target_session_id } as for current-session; runs once through the Studio Bridge and the managed MCP. */
cronConsentRoutes.post('/api/hermes/cron/current-session/dispatch', trusted.dispatch)
