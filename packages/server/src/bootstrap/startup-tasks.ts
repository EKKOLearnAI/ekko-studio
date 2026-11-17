import { replaceHermesApiKeyDomains } from '../modules/hermes/services/profiles/apikey-domain-replacement'
import { getHermesBaseDir } from '../modules/hermes/services/profiles/profile'
import { runStartupTasks, type StartupTask } from '../modules/studio/services/startup-tasks'
import { config } from '../modules/studio/public/config'
import { listUsers } from '../modules/studio/public/users'
import { withProviderAccount } from '../modules/studio/public/provider-account'
import { migratePersistedPiRuntimeMcpConfigs, restorePersistedCodexProxyTargets, restorePersistedPiProxyTargets } from './coding-agents'

/** Ordered, append-only list of one-time startup operations. See docs/harness/startup-tasks.md. */
export function getStartupTasks(): StartupTask[] {
  return [
    {
      id: '2026-09-12-hermes-apikey-domain-v1',
      title: 'Replace apikey.fun domains with apikey.fan in Hermes configuration',
      scope: getHermesBaseDir(),
      async run() {
        const result = await replaceHermesApiKeyDomains()
        if (result.failedProfiles.length > 0) {
          throw new Error('Some Hermes profiles could not be updated')
        }
      },
    },
    {
      id: '2026-11-17-legacy-model-target-index-v1',
      title: 'Import legacy Coding Agent model credentials for on-demand lookup',
      scope: config.appHome,
      async run() {
        await migratePersistedPiRuntimeMcpConfigs()
        const users = listUsers()
        // Shared pre-account credentials have no unique owner. A normal
        // continuation prepares an account-scoped credential for those runs.
        for (const user of users.filter(user => user.status === 'active')) await withProviderAccount(user.id, async () => {
          const acceptProfile = (profile: string) => {
            const owners = users.filter(owner => owner.profiles.includes(profile))
            return owners.length === 1 && owners[0].id === user.id
          }
          if (!user.profiles.some(acceptProfile)) return
          await restorePersistedCodexProxyTargets({ acceptProfile, persistOnly: true })
          await restorePersistedPiProxyTargets({ acceptProfile, persistOnly: true })
        })
      },
    },
  ]
}

export function runRegisteredStartupTasks() {
  return runStartupTasks(getStartupTasks())
}
