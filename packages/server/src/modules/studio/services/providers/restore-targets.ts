import { savedModelTarget } from '../../repositories/model-target-store'
import { modelGatewayAdapters, type ModelGatewayBinding } from '../../public/model-gateway-adapters'
import { getSessionAvailableModelGroups } from '../../public/session-agent-runtime'
import { resolveProviderUpstream } from '../../public/provider-upstream'
import { listUsers, userCanAccessProfile } from '../../public/users'
import { importAccountProviders, withProviderAccount } from '../../public/provider-account'
import { logicalModelSelection } from './model-routes'

const MAX_RESTORED_TARGETS = 128
const restoredTargets = new Map<string, () => void>()
const restoring = new Map<string, Promise<ModelGatewayBinding | null>>()

/** Restore only a credential actually used after restart, with a bounded cache. */
export async function restoreStudioModelTarget(token: string): Promise<ModelGatewayBinding | null> {
  if (!/^hwui_[A-Za-z0-9_-]{1,128}$/.test(token)) return null
  const adapters = modelGatewayAdapters()
  const binding = adapters.authenticate(token)
  if (binding) {
    const dispose = restoredTargets.get(token)
    if (dispose) {
      restoredTargets.delete(token)
      restoredTargets.set(token, dispose)
    }
    return binding
  }
  const pending = restoring.get(token)
  if (pending) return pending
  const operation = (async () => {
    // Account count bounds these point reads; historical session count does not.
    for (const user of listUsers().filter(user => user.status === 'active')) {
      const saved = await savedModelTarget(user.id, token)
      if (!saved) continue
      if (user.role !== 'super_admin' && !userCanAccessProfile(user.id, saved.profile)) return null
      return withProviderAccount(user.id, async () => {
        try {
          await importAccountProviders()
          const selection = logicalModelSelection(saved.profile, saved.provider, saved.model)
          const groups = await getSessionAvailableModelGroups(saved.profile)
          if (!groups.some(group => group.provider === selection.provider && group.models.includes(selection.model))) return null
          const runtime = await resolveProviderUpstream({ profile: saved.profile, ...selection, apiMode: saved.apiMode })
          if (!runtime.baseUrl) return null
          const target = adapters.register(saved.protocol, { ...saved, ...selection, userId: user.id,
            sessionId: saved.chatSessionId, runId: saved.agentSessionId,
            apiKey: runtime.apiKey || '', baseUrl: runtime.baseUrl, apiMode: runtime.apiMode }, { token })
          restoredTargets.delete(token)
          restoredTargets.set(token, target.dispose)
          while (restoredTargets.size > MAX_RESTORED_TARGETS) {
            const oldest = restoredTargets.keys().next().value!
            const dispose = restoredTargets.get(oldest)!
            restoredTargets.delete(oldest)
            dispose()
          }
          return adapters.authenticate(token)
        } catch { return null /* A revoked model or expired login must fail authentication. */ }
      })
    }
    return null
  })()
  restoring.set(token, operation)
  try { return await operation } finally { if (restoring.get(token) === operation) restoring.delete(token) }
}
