import {
  isAuthorizedRuntimeProvider,
  resolveAuthorizedProviderRuntimeCredentials,
} from '../modules/hermes/services/providers/authorized-provider-credentials'
import { providerCredentialDir } from '../modules/studio/public/provider-account'
import { configureAuthorizedProviderRuntime } from '../modules/studio/public/authorized-provider-runtime'

import { resolveCopilotCredentials } from '../modules/studio/services/providers/copilot-credentials'

configureAuthorizedProviderRuntime({
  isAuthorizedRuntimeProvider: provider => String(provider).toLowerCase() === 'copilot' || isAuthorizedRuntimeProvider(provider),
  resolveAuthorizedProviderRuntimeCredentials: input => input.provider.toLowerCase() === 'copilot' ? resolveCopilotCredentials(input) : resolveAuthorizedProviderRuntimeCredentials(input, input.credentialScope ? { profileDir: () => providerCredentialDir(input.credentialScope), hermesBaseDir: () => providerCredentialDir(input.credentialScope) } : {}),
})
