import { readConfigYamlForProfile } from '../modules/studio/public/provider-config'
import { reasoningCodec } from '../modules/studio/public/model-reasoning-codec'
import { gatewayToken } from '../modules/studio/public/model-gateway-adapters'
import { getAvailableModelGroupsForProfile } from '../modules/hermes/controllers/models'
import { savedModelTargets } from '../modules/studio/public/model-target-store'
import { listUsers } from '../modules/studio/public/users'
import { importAccountProviders } from '../modules/studio/public/provider-account'
import { copilotRequestHeaders } from '../modules/studio/services/providers/copilot-credentials'
import { Readable } from 'node:stream'
import { configureProviderHttp, isCodexInferenceRequest, codexInferenceBody, withoutUnsupportedReasoning } from '../modules/studio/public/provider-http'
import { getModelRuntimeCapabilities } from '../modules/studio/public/provider-runtime'
import { withProviderAccount } from '../modules/studio/public/provider-account'
import { openCodeSessionHeaders } from '../modules/studio/public/opencode-session'
import { openRouterAttributionHeaders } from '../modules/studio/public/openrouter-attribution'
import { createEkkoAuthorizedProviderFetch } from '../modules/ekko/services/provider-runtime'
import { authorizedModelProviderPreset } from '../../../ekko-agent/src/model/authorized-providers'
import { configureProviderUpstream } from '../modules/studio/public/provider-upstream'
import { resolveEkkoProviderRuntimeConfig } from '../modules/ekko/services/provider-runtime'
import { configureModelGatewayAdapters } from '../modules/studio/public/model-gateway-adapters'
import { registerCodexProxyTarget, restoreCodexProxyTarget, revokeCodexProxyTarget, findCodexProxyByToken, findCodexGatewayTarget, codexProxyResponses, codingAgentProxyChatCompletions, antigravityProxyGenerate } from '../modules/coding-agents/services/codex/proxy'
import { registerClaudeCodeProxyTarget, revokeClaudeCodeProxyTarget, findClaudeProxyByToken, findClaudeGatewayTarget, claudeProxyMessages, claudeProxyCountTokens } from '../modules/coding-agents/services/claude-code/proxy'

configureModelGatewayAdapters({
  authenticate: token => {
    const target = findCodexProxyByToken(token) || findClaudeProxyByToken(token)
    return target?.ownerUserId ? { userId: target.ownerUserId, profile: target.profile || 'default', agentId: target.agentId, sessionId: target.chatSessionId, runId: target.agentSessionId, model: target.model, provider: target.provider } : null
  },
  handle: async (protocol, ctx) => {
    ctx.params ||= {}
    const binding = findCodexProxyByToken(gatewayToken(ctx)) || findClaudeProxyByToken(gatewayToken(ctx))
      || findCodexGatewayTarget(ctx.params.key || '') || findClaudeGatewayTarget(ctx.params.key || '')
    if (binding) (ctx.state as any).modelGatewayReasoningCodec = await reasoningCodec(JSON.stringify([binding.ownerUserId, binding.profile, binding.provider, binding.model, binding.baseUrl, binding.apiMode]))
    if (protocol === 'gemini_contents') ctx.params.operation = ctx.path.match(/\/v1beta\/models\/(.+)$/)?.[1] || ''
    const abort = new AbortController()
    const close = () => { if (!ctx.res.writableEnded) abort.abort() }
    ctx.res.once('close', close)
    ;(ctx.state as any).modelGatewaySignal = abort.signal
    try {
      if (protocol === 'anthropic_messages') await (ctx.path.endsWith('/count_tokens') ? claudeProxyCountTokens(ctx) : claudeProxyMessages(ctx))
      else if (protocol === 'chat_completions') await codingAgentProxyChatCompletions(ctx)
      else if (protocol === 'gemini_contents') await antigravityProxyGenerate(ctx)
      else await codexProxyResponses(ctx)
      if (ctx.body instanceof Readable) {
        const cleanup = () => { abort.abort(); ctx.res.off('close', close) }
        ctx.body.once('close', cleanup)
        ctx.body.once('error', cleanup)
      } else { abort.abort(); ctx.res.off('close', close) }
    } catch (error) { abort.abort(); ctx.res.off('close', close); throw error }
  },
  register: (protocol, input) => {
    const targetInput = { ...input, ownerUserId: input.userId, agentId: input.agentId, chatSessionId: input.sessionId, agentSessionId: input.runId, apiMode: input.apiMode as 'chat_completions' }
    const anthropic = protocol === 'anthropic_messages'
    const target = anthropic ? registerClaudeCodeProxyTarget(targetInput) : registerCodexProxyTarget(targetInput)
    return { routeKey: target.routeKey, dispose: () => { if (anthropic) revokeClaudeCodeProxyTarget(target.routeKey); else revokeCodexProxyTarget(target.routeKey) } }
  },
})

configureProviderUpstream(resolveEkkoProviderRuntimeConfig)

configureProviderHttp(input => withProviderAccount(input.ownerUserId!, async () => {
  const configuration = await readConfigYamlForProfile(input.profile || 'default')
  const normalize = (value: unknown) => String(value || '').replace(/^custom[:_]/, '').toLowerCase().replace(/ /g, '-')
  const configured = [...Object.entries(configuration.providers || {}).map(([name, entry]) => ({ name, ...(entry as any) })), ...(configuration.custom_providers || [])]
    .find(entry => normalize(entry.catalog_provider || entry.name) === normalize(input.provider))
  const authProvider = configured?.auth_provider || input.provider || ''
  const fetcher = createEkkoAuthorizedProviderFetch({ profile: input.profile || 'default', provider: authProvider, model: input.model, accessToken: input.apiKey, credentialScope: configured?.auth_scope })
  const modelSettings = configured?.models?.[input.model || '']
  const extraHeaders = { ...configured?.extra_headers, ...modelSettings?.extra_headers }
  const mergedBody = { ...configured?.extra_body, ...modelSettings?.extra_body, ...(input.body as object) }
  const capabilities = input.model && input.provider ? getModelRuntimeCapabilities({ profile: input.profile || 'default', provider: input.provider, model: input.model }) : undefined
  const compatibleBody = withoutUnsupportedReasoning(mergedBody, capabilities?.reasoning !== false)
  const body = isCodexInferenceRequest(input) ? codexInferenceBody(compatibleBody) : compatibleBody
  return fetcher(input.url, { method: 'POST', headers: {
    ...openCodeSessionHeaders(input.url, input.sessionId, input.provider),
    ...openRouterAttributionHeaders(input.url, input.provider),
    ...(authProvider === 'copilot' ? copilotRequestHeaders : {}),
    ...(input.apiKey ? { authorization: `Bearer ${input.apiKey}` } : {}),
    'content-type': 'application/json', ...extraHeaders, ...input.headers,
    ...authorizedModelProviderPreset(authProvider, input.apiKey)?.headers,
  }, body: JSON.stringify(body), signal: input.signal })
}, input.profile))

/** Rebuild native CLI bindings after restart using current account credentials. */
export async function restoreStudioModelTargets(): Promise<number> {
  let restored = 0
  for (const user of listUsers().filter(user => user.status === 'active')) await withProviderAccount(user.id, async () => {
    for (const saved of await savedModelTargets()) {
      try {
        await importAccountProviders()
        const groups = await getAvailableModelGroupsForProfile(saved.profile)
        if (!groups.some(group => group.provider === saved.provider && group.models.includes(saved.model))) continue
        const runtime = await resolveEkkoProviderRuntimeConfig({ profile: saved.profile, provider: saved.provider, model: saved.model, apiMode: saved.apiMode })
        const input = { ...saved, apiKey: runtime.apiKey || '', baseUrl: runtime.baseUrl || '', apiMode: runtime.apiMode as 'chat_completions' }
        if (!input.baseUrl) continue
        if (saved.protocol === 'anthropic_messages') registerClaudeCodeProxyTarget(input, { token: saved.token })
        else restoreCodexProxyTarget(input, saved.token)
        restored++
      } catch { /* A revoked Profile or expired login does not block startup. */ }
    }
  })
  return restored
}
