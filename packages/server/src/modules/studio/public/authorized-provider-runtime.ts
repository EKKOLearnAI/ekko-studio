export interface AuthorizedProviderRuntimeCredentials {
  provider: string
  apiKey: string
  baseUrl?: string
  apiMode?: string
  source?: string
  lastRefresh?: string
  expiresAt?: string
  expiresAtMs?: number
}

export interface AuthorizedProviderRuntimeDependencies {
  isAuthorizedRuntimeProvider: (provider: unknown) => boolean
  resolveAuthorizedProviderRuntimeCredentials: (input: {
    profile: string
    provider: string
    model?: string
    forceRefresh?: boolean
  }) => Promise<AuthorizedProviderRuntimeCredentials>
}

let authorizedProviderRuntimeDependencies: AuthorizedProviderRuntimeDependencies | null = null

export function configureAuthorizedProviderRuntime(
  dependencies: AuthorizedProviderRuntimeDependencies,
): void {
  authorizedProviderRuntimeDependencies = dependencies
}

function configured(): AuthorizedProviderRuntimeDependencies {
  if (!authorizedProviderRuntimeDependencies) {
    throw new Error('Studio authorized provider runtime has not been configured')
  }
  return authorizedProviderRuntimeDependencies
}

export function isAuthorizedRuntimeProvider(provider: unknown): boolean {
  return configured().isAuthorizedRuntimeProvider(provider)
}

export function resolveAuthorizedProviderRuntimeCredentials(input: {
  profile: string
  provider: string
  model?: string
  forceRefresh?: boolean
}): Promise<AuthorizedProviderRuntimeCredentials> {
  return configured().resolveAuthorizedProviderRuntimeCredentials(input)
}
