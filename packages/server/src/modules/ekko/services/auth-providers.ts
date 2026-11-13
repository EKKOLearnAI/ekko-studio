import {
  isAuthorizedRuntimeProvider,
  resolveAuthorizedProviderRuntimeCredentials,
} from '../../studio/public/authorized-provider-runtime'

export interface EkkoAuthorizedProviderCredentials {
  apiKey?: string
  baseUrl?: string
  apiMode?: string
}

export async function resolveEkkoAuthorizedProviderCredentials(
  profile: string,
  provider: string,
  model?: string,
  forceRefresh = false,
): Promise<EkkoAuthorizedProviderCredentials> {
  if (!isAuthorizedRuntimeProvider(provider)) return {}

  const credentials = await resolveAuthorizedProviderRuntimeCredentials({
    profile,
    provider,
    model,
    ...(forceRefresh ? { forceRefresh: true } : {}),
  })
  return {
    apiKey: credentials.apiKey,
    baseUrl: credentials.baseUrl,
    apiMode: credentials.apiMode,
  }
}
