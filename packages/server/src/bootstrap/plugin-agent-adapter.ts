import { configureBuiltinAgents } from '../modules/studio/services/agents/registry'
import { getCodingAgentDefinition, getCodingAgentDefinitions, getCodingAgentStatus, getCodingAgentModels, getPluginAgentManagedMcpServerConfigs, deleteCodingAgent } from '../modules/coding-agents/services'
import { checkAgentUpdateAndPublish, installAgentAndPublish, getAgentUpdateManager } from '../modules/coding-agents/services/update-manager'
import { registerCodexProxyTarget, revokeCodexProxyTarget } from '../modules/coding-agents/services/codex/proxy'
import { registerClaudeCodeProxyTarget, revokeClaudeCodeProxyTarget } from '../modules/coding-agents/services/claude-code/proxy'
import { resolveEkkoProviderRuntimeConfig } from '../modules/ekko/services/provider-runtime'
import { getModelRuntimeCapabilities } from '../modules/studio/public/provider-runtime'
import { PluginError } from '../modules/studio/services/plugins/errors'
import catalog from '../../../../config/agents.json'
import { normalizeTokenUsage, normalizeUsageCost, recordSessionUsage } from '../modules/studio/public/usage'

const metadata = (id: string) => catalog.agents.find(agent => agent.id === id)

configureBuiltinAgents({
  mcpServers: getPluginAgentManagedMcpServerConfigs,
  list: () => getCodingAgentDefinitions().map(agent => ({ id: agent.id, name: agent.name, vendor: agent.provider, description: '', icon: metadata(agent.id)?.icon || '', origin: 'builtin',
    modes: (metadata(agent.id)?.modes || ['scoped', 'global']) as Array<'scoped' | 'global'>, surfaces: ['chat', 'group-chat', 'workflow', 'api'],
    actions: { settings: Boolean(metadata(agent.id)?.config.settings || metadata(agent.id)?.config.mcp), checkUpdate: Boolean(metadata(agent.id)?.installation.updates), upgrade: Boolean(metadata(agent.id)?.installation.updates), remove: Boolean(metadata(agent.id)?.installation.remove), autoUpdate: Boolean(agent.packageName) } })),
  status: async id => { const agent = getCodingAgentDefinition(id); if (!agent) throw new Error('Unknown Agent'); return getCodingAgentStatus(agent) },
  settings: id => ({ name: 'codingAgent.config', params: { agentId: id, section: metadata(id)?.config.settings || metadata(id)?.config.memory ? 'settings' : 'mcp' } }),
  models: async (id, refresh) => (await getCodingAgentModels({ agent: id, refresh })).agents[0],
  checkUpdate: async id => {
    const result = await checkAgentUpdateAndPublish(id)
    if (!result.success) throw new Error(result.message || 'Agent update check failed')
    return { currentVersion: result.tool.version, latestVersion: result.latestVersion, updateAvailable: result.updateAvailable }
  },
  upgrade: async (id, input) => {
    if (!input?.version || typeof input.expectedVersion !== 'string') throw new PluginError('Target and expected versions are required')
    const agent = getCodingAgentDefinition(id)!
    const status = await getCodingAgentStatus(agent)
    if (status.version !== input.expectedVersion) throw new PluginError('Agent version changed; check updates again', 'AGENT_VERSION', 409)
    const result = await installAgentAndPublish(id, { version: input.version })
    if (!result.success) throw new Error(result.message || 'Agent upgrade failed')
    return { installedVersion: result.tool.version, message: result.message }
  },
  remove: async (id, input) => {
    const agent = getCodingAgentDefinition(id)!
    const status = await getCodingAgentStatus(agent)
    if (!input || typeof input.expectedVersion !== 'string' || status.version !== input.expectedVersion) throw new PluginError('Agent version changed; refresh before removing', 'AGENT_VERSION', 409)
    const result = await deleteCodingAgent(id)
    if (!result.success) throw new PluginError(result.message || 'Agent removal failed')
    return { removed: true }
  },
  updatePolicy: async id => (await getAgentUpdateManager()).snapshot()[id],
  setUpdatePolicy: async (id, enabled) => {
    const manager = await getAgentUpdateManager()
    try { await manager.set(id, enabled) }
    catch (error) { throw new PluginError(error instanceof Error ? error.message : 'Invalid update policy', 'AGENT_UPDATE_POLICY', 400) }
    return manager.snapshot()[id]
  },
  scopedModel: async input => {
    const runtime = await resolveEkkoProviderRuntimeConfig({ profile: input.identity.profile, provider: input.provider, model: input.model, apiMode: input.apiMode })
    input.signal.throwIfAborted()
    const protocol = input.protocols.includes(input.apiMode) ? input.apiMode : input.protocols[0]
    const targetInput = { profile: input.identity.profile, provider: input.provider, model: input.model, baseUrl: runtime.baseUrl || '', apiKey: runtime.apiKey || '', apiMode: runtime.apiMode as 'chat_completions',
      reasoningEffort: input.reasoningEffort, agentId: input.agentId, agentSessionId: input.identity.runId, chatSessionId: input.identity.sessionId,
      onUsageEvent: (event: { type: string; data: any }, apiDuration?: number, baseUrl?: string) => {
        if (input.signal.aborted || !['response.completed', 'response.failed', 'response.incomplete'].includes(event.type)) return
        const final = event.data?.response || event.data
        if (!final?.usage) return
        const usage = normalizeTokenUsage(final.usage, {}, { inputIncludesCache: runtime.apiMode !== 'anthropic_messages' })
        if (usage.isEstimated) return
        recordSessionUsage({ sessionId: input.identity.sessionId!, parentRunId: input.identity.runId, runId: final.id,
          source: 'coding_agent', agent: input.agentId as `plugin:${string}/${string}`, usageScope: 'model_call', apiCalls: 1,
          apiDuration, usage, profile: input.identity.profile, provider: input.provider, model: final.model || input.model,
          baseUrl, cost: normalizeUsageCost(final), isEstimated: false })
      } }
    const anthropic = protocol === 'anthropic_messages'
    const target = anthropic ? registerClaudeCodeProxyTarget(targetInput) : registerCodexProxyTarget(targetInput)
    const capabilities = getModelRuntimeCapabilities({ profile: input.identity.profile, provider: input.provider, model: input.model })
    const dispose = () => { input.signal.removeEventListener('abort', dispose); if (anthropic) revokeClaudeCodeProxyTarget(target.routeKey); else revokeCodexProxyTarget(target.routeKey) }
    input.signal.addEventListener('abort', dispose, { once: true })
    if (input.signal.aborted) { dispose(); input.signal.throwIfAborted() }
    return { model: { provider: input.provider, model: input.model, apiMode: protocol as 'chat_completions', baseUrl: target.baseUrl, token: target.token,
      reasoningEffort: input.reasoningEffort, contextWindow: capabilities.contextWindow || null, outputLimit: capabilities.outputLimit || null }, dispose }
  },
})
