import { randomUUID } from 'node:crypto'
import { StudioError, type ExecutionScope } from '../../contracts/plugins'
import type { DirectChatRunOptions } from './direct'
import type { ChatRunStartRequest } from './start'

/** Host-only bridge to ExecutionScope. Legacy entrypoint authorization still applies. */
export function createChatRunInvocation(request: ChatRunStartRequest, options: DirectChatRunOptions) {
  // Take the snapshot before scheduling admission or awaiting authorization.
  const data = structuredClone(request)
  const user = options.user ? Object.freeze(structuredClone(options.user)) : undefined
  const mobileDeviceTarget = options.mobileDeviceTarget ? Object.freeze(structuredClone(options.mobileDeviceTarget)) : undefined
  const profile = options.profile
  const sessionId = data.session_id || options.context?.scope.sessionId || randomUUID()
  const scope: ExecutionScope = structuredClone(options.context?.scope ?? {
    scopeId: randomUUID(), traceId: randomUUID(), surface: 'api',
    principal: user ? { kind: 'user', id: String(user.id) } : { kind: 'service', id: 'legacy-local-chat' },
    profileId: profile, sessionId,
  })
  if (scope.profileId !== profile || (data.profile && data.profile !== profile)
    || (scope.sessionId && scope.sessionId !== sessionId)
    || (user ? scope.principal.kind !== 'user' || scope.principal.id !== String(user.id) : scope.principal.kind !== 'service')) {
    throw new StudioError('FORBIDDEN', 'Chat request is outside the execution scope')
  }
  // These bindings need the unified coordinator's parent/runtime lease support.
  if (scope.runId !== undefined || scope.workspaceId !== undefined) {
    throw new StudioError('CAPABILITY_UNSUPPORTED', 'Bound run/workspace chat execution is not supported yet')
  }
  // Narrow an unbound host context to this invocation, without changing the parent.
  const boundScope: ExecutionScope = { ...scope, sessionId }
  Object.freeze(scope.principal)
  Object.freeze(boundScope)
  data.session_id = sessionId
  data.profile = profile
  const signal = options.context?.signal
  const authorize = options.reauthorize
  let admitted = false
  const checkCancellation = () => {
    if (!admitted && signal?.aborted) throw new StudioError('CANCELLED', 'Chat admission was cancelled')
  }
  return {
    data, scope: boundScope,
    options: {
      ...options, profile, user, mobileDeviceTarget,
      reauthorize: async () => {
        checkCancellation()
        await authorize?.()
        checkCancellation()
        // After this boundary legacy admission may write attachments or bind a
        // device. Ending the caller scope must not revoke that accepted work.
        // Queue dispatch still checks authorization, independently of the signal.
        admitted = true
      },
    },
  }
}
