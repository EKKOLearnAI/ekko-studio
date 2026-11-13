import Router from '@koa/router'
import * as ctrl from '../controllers/cron-consent'

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
