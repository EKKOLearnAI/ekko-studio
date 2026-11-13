import {
  isAuthorizedRuntimeProvider,
  resolveAuthorizedProviderRuntimeCredentials,
} from '../modules/hermes/services/providers/authorized-provider-credentials'
import { configureAuthorizedProviderRuntime } from '../modules/studio/public/authorized-provider-runtime'

configureAuthorizedProviderRuntime({
  isAuthorizedRuntimeProvider,
  resolveAuthorizedProviderRuntimeCredentials,
})
