import type { ProviderHttpRequest } from '../../public/provider-http'
import { readConfigYamlForProfile } from '../../public/provider-config'
import { getModelRuntimeCapabilities } from '../../public/provider-runtime'
import { openCodeSessionHeaders } from '../../public/opencode-session'
import { openRouterAttributionHeaders } from '../../public/openrouter-attribution'
import { translatedPromptCacheBody } from './prompt-cache'
import { withProviderAccount } from './account-store'
import { copilotRequestHeaders } from './copilot-credentials'
import { applyCodexAffinity, isOfficialCodexResponses, isCodexInferenceRequest, codexInferenceBody, withoutUnsupportedReasoning } from './codex-requests'

interface ProviderHttpAuthorization {
  createFetch(input: { profile: string; provider: string; model?: string; accessToken?: string; credentialScope?: string }): typeof fetch
  headers(provider: string, apiKey: string): Record<string, string> | undefined
}

/** Account configuration and outbound request policy belong to Studio. */
export function createProviderHttpTransport(authorization: ProviderHttpAuthorization) {
  return (input: ProviderHttpRequest): Promise<Response> => withProviderAccount(input.ownerUserId!, async () => {
    const configuration = await readConfigYamlForProfile(input.profile || 'default')
    const normalize = (value: unknown) => String(value || '').replace(/^custom[:_]/, '').toLowerCase().replace(/ /g, '-')
    const configured = [...Object.entries(configuration.providers || {}).map(([name, entry]) => ({ name, ...(entry as any) })), ...(configuration.custom_providers || [])]
      .find(entry => normalize(entry.catalog_provider || entry.name) === normalize(input.provider))
    const authProvider = configured?.auth_provider || input.provider || ''
    const fetcher = authorization.createFetch({ profile: input.profile || 'default', provider: authProvider, model: input.model,
      accessToken: input.apiKey, credentialScope: configured?.auth_scope })
    const modelSettings = configured?.models?.[input.model || '']
    const extraHeaders = { ...configured?.extra_headers, ...modelSettings?.extra_headers }
    const officialCodex = isOfficialCodexResponses(input.url)
    const promptCacheKey = officialCodex ? input.affinity?.promptCacheKey : undefined
    const defaults = { ...configured?.extra_body, ...modelSettings?.extra_body }
    const requestBody = input.translatedTo
      ? translatedPromptCacheBody(input, {
        authProvider, defaults, ttl: configuration.prompt_caching?.cache_ttl,
        capability: modelSettings?.prompt_caching ?? configured?.prompt_caching,
      })
      : input.body as object
    const mergedBody = { ...defaults,
      ...(promptCacheKey !== undefined ? { prompt_cache_key: promptCacheKey } : {}), ...requestBody }
    const capabilities = input.model && input.provider ? getModelRuntimeCapabilities({ profile: input.profile || 'default', provider: input.provider, model: input.model }) : undefined
    const compatibleBody = withoutUnsupportedReasoning(mergedBody, capabilities?.reasoning !== false)
    const body = isCodexInferenceRequest(input) ? codexInferenceBody(compatibleBody) : compatibleBody
    const session = input.affinity?.sessionId
    const upstreamSession = session && JSON.stringify([input.ownerUserId, input.profile, input.affinity?.scope, session])
    const headers = {
      ...openCodeSessionHeaders(input.url, upstreamSession, input.provider),
      ...openRouterAttributionHeaders(input.url, input.provider),
      ...(authProvider === 'copilot' ? copilotRequestHeaders : {}),
      ...(input.apiKey ? { authorization: `Bearer ${input.apiKey}` } : {}),
      'content-type': 'application/json', ...extraHeaders, ...input.headers,
      ...authorization.headers(authProvider, input.apiKey),
    }
    if (officialCodex) applyCodexAffinity(input, body, headers)
    return fetcher(input.url, { method: 'POST', headers, body: JSON.stringify(body), signal: input.signal })
  }, input.profile)
}
