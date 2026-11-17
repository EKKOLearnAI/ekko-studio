import { resolveModelProviderConfigs } from '../../../ekko-agent/src'
import type { ResolveModelProviderConfigInput } from '../../../ekko-agent/src/model/provider-config'
import { internalModelCredential, importAccountProviders, providerAccountId, withProviderAccount } from '../modules/studio/public/provider-account'
import { studioModelGatewayUrl } from '../modules/studio/public/provider-projection'

export async function resolveAgentGatewayRuntime(input: { profile: string; provider: string; model?: string; apiMode?: string }) {
  return withProviderAccount(providerAccountId(input.profile), async () => {
    await importAccountProviders()
    const credential = await internalModelCredential(input.profile)
    return { provider: input.provider, baseUrl: studioModelGatewayUrl(), apiKey: credential.token, apiMode: 'codex_responses' }
  }, input.profile)
}

/** Ekko retains logical model IDs; only its transport targets the gateway. */
export function resolveAgentGatewayModelConfigs(input: ResolveModelProviderConfigInput) {
  const original = resolveModelProviderConfigs({ ...input, apiMode: 'codex_responses' })
  return { ...original, fallbackProviderConfig: undefined,
    providerConfig: { ...original.providerConfig, id: 'ekkostudio', type: 'openai-compatible' as const,
      apiMode: 'codex_responses' as const, requestStyle: 'openai-responses' as const,
      headers: { 'x-studio-provider': encodeURIComponent(input.provider), 'x-studio-provider-encoding': 'uri' } } }
}
