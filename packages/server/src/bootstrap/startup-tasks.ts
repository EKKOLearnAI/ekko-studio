import { replaceHermesApiKeyDomains } from '../modules/hermes/services/profiles/apikey-domain-replacement'
import { getHermesBaseDir } from '../modules/hermes/services/profiles/profile'
import { runStartupTasks, type StartupTask } from '../modules/studio/services/startup-tasks'

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
  ]
}

export function runRegisteredStartupTasks() {
  return runStartupTasks(getStartupTasks())
}
