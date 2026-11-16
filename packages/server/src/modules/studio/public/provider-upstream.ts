export interface UpstreamProviderInput { profile: string; provider: string; model?: string; baseUrl?: string; apiKey?: string; apiMode?: string; forceRefresh?: boolean }
export interface UpstreamProviderConfig { provider: string; baseUrl?: string; apiKey?: string; apiMode?: string }
let resolve: ((input: UpstreamProviderInput) => Promise<UpstreamProviderConfig>) | undefined
export const configureProviderUpstream = (next: NonNullable<typeof resolve>) => { resolve = next }
export function resolveProviderUpstream(input: UpstreamProviderInput): Promise<UpstreamProviderConfig> {
  if (!resolve) throw new Error('Provider upstream resolver is not configured')
  return resolve(input)
}
