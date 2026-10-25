import { randomUUID } from 'node:crypto'
import { resolveModelExecutionIdentity } from '../../contracts/runs/model-execution-identity'
import { authenticateUserToken, inspectAppUserToken, isAuthEnabled } from '../../public/auth'
import { userCanAccessProfile } from '../../repositories/users-store'
import { authenticatedPushActor } from '../notifications/push-registration'
import { assertShareProfile, prepareSessionShareRun, refreshSessionShare, sessionShareExecutionUser, watchSessionShare, type SessionShareAccess } from '../session-shares/access'
import type { DirectChatRunPort, DirectChatRunOptions } from './direct'
import type { ChatRunStartRequest } from './start'
import { waitForChatRun, type ChatRunHttpResult } from './wait'

export async function runChatHttpRequest(
  request: Record<string, any>,
  scope: { token: string; profile: string; share?: SessionShareAccess },
  server: DirectChatRunPort | null,
): Promise<ChatRunHttpResult> {
  const body = structuredClone(request)
  const responseOptions = { timeoutMs: body.timeout_ms, includeEvents: body.include_events === true }
  if (scope.share) prepareSessionShareRun(scope.share, body)
  if (body.input == null) return { status: 400, body: { ok: false, error: 'input is required' } }
  const profile = String(body.profile || scope.profile || 'default').trim() || 'default'
  const { timeout_ms: _timeout, include_events: _events, onEvent: _onEvent, ...payload } = body
  payload.profile = profile
  if (body.source === 'builtin_agent' || body.source === 'coding_agent' || body.coding_agent_id != null || body.agent_id != null) {
    try {
      const identity = await resolveModelExecutionIdentity({ profile, provider: body.provider, model: body.model, apiMode: body.apiMode ?? body.api_mode })
      Object.assign(payload, { provider: identity.provider, model: identity.model, apiMode: identity.apiMode })
      for (const key of ['api_mode', 'apiKey', 'api_key', 'baseUrl', 'base_url']) delete payload[key]
    } catch (error: any) {
      return { status: Number(error?.status) || 400, body: { ok: false, error: error?.message || 'Invalid execution identity' } }
    }
  }
  if (typeof payload.session_id !== 'string' || !payload.session_id.trim()) payload.session_id = randomUUID()
  const unavailable = (error: string): ChatRunHttpResult => ({ status: 503, body: {
    ok: false, status: 'connect_error', error, session_id: payload.session_id, output: '',
    ...(responseOptions.includeEvents ? { events: [] } : {}),
  } })
  if (!server?.startDirectRun) return unavailable('Chat run service is unavailable')
  let user: DirectChatRunOptions['user']
  let mobileDeviceTarget: DirectChatRunOptions['mobileDeviceTarget']
  try {
    // Preserve the authentication enforced by the old loopback handshake, including
    // App device revocation when login is disabled and share execution ownership.
    if (scope.share) {
      assertShareProfile(scope.share, profile)
      await refreshSessionShare(scope.share, 'input', payload.session_id)
      user = sessionShareExecutionUser(scope.share)
    } else {
      const appToken = scope.token ? await inspectAppUserToken(scope.token) : null
      if (appToken) {
        if (appToken.status !== 'active' || !appToken.user) throw new Error('App device authentication failed')
        if (appToken.user.role !== 'super_admin' && !userCanAccessProfile(appToken.user.id, profile)) throw new Error('Profile access denied')
        mobileDeviceTarget = { deviceCode: appToken.deviceCode, userId: String(appToken.user.id), profile, platform: 'unknown' }
      }
      if (await isAuthEnabled()) {
        user = await authenticateUserToken(scope.token) || undefined
        if (!user) throw new Error('Authentication failed')
        if (user.role !== 'super_admin' && !userCanAccessProfile(user.id, profile)) throw new Error('Profile access denied')
      }
    }
  } catch (error) { return unavailable(error instanceof Error ? error.message : String(error)) }
  const numericTimeout = Number(responseOptions.timeoutMs)
  const timeoutMs = Number.isFinite(numericTimeout) && numericTimeout > 0 ? Math.min(Math.floor(numericTimeout), 1_800_000) : 300_000
  let revoked = false
  return waitForChatRun({
    sessionId: payload.session_id, timeoutMs, includeEvents: responseOptions.includeEvents,
    watch: scope.share ? invalidate => watchSessionShare(scope.share!, 'input', () => { revoked = true; invalidate() }) : undefined,
    start: onEvent => server.startDirectRun(payload as ChatRunStartRequest, {
      profile, user, mobileDeviceTarget, shared: Boolean(scope.share), onEvent,
      pushActor: () => authenticatedPushActor(scope.token),
      reauthorize: scope.share ? async () => {
        if (revoked) throw new Error('share_access_denied')
        await refreshSessionShare(scope.share!, 'input', payload.session_id)
        if (revoked) throw new Error('share_access_denied')
      } : undefined,
    }),
  })
}
