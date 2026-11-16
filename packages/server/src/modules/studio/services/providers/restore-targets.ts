import { savedModelTargets } from '../../repositories/model-target-store'
import { modelGatewayAdapters } from '../../public/model-gateway-adapters'
import { getSessionAvailableModelGroups } from '../../public/session-agent-runtime'
import { resolveProviderUpstream } from '../../public/provider-upstream'
import { listUsers, userCanAccessProfile } from '../../public/users'
import { importAccountProviders, withProviderAccount } from '../../public/provider-account'
import { logicalModelSelection } from './model-routes'

/** Rebuild native CLI bindings after restart using current account credentials. */
export async function restoreStudioModelTargets(): Promise<number> {
  let restored = 0
  for (const user of listUsers().filter(user => user.status === 'active')) await withProviderAccount(user.id, async () => {
    for (const saved of await savedModelTargets()) {
      try {
        if (user.role !== 'super_admin' && !userCanAccessProfile(user.id, saved.profile)) continue
        await importAccountProviders()
        const selection = logicalModelSelection(saved.profile, saved.provider, saved.model)
        const groups = await getSessionAvailableModelGroups(saved.profile)
        if (!groups.some(group => group.provider === selection.provider && group.models.includes(selection.model))) continue
        const runtime = await resolveProviderUpstream({ profile: saved.profile, ...selection, apiMode: saved.apiMode })
        if (!runtime.baseUrl) continue
        modelGatewayAdapters().register(saved.protocol, { ...saved, ...selection, userId: user.id,
          sessionId: saved.chatSessionId, runId: saved.agentSessionId,
          apiKey: runtime.apiKey || '', baseUrl: runtime.baseUrl, apiMode: runtime.apiMode }, { token: saved.token })
        restored++
      } catch { /* A revoked Profile or expired login does not block startup. */ }
    }
  })
  return restored
}
