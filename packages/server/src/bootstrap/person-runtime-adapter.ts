import { createPersonAgent } from './person-chat-agent'
import { AgentRuntime, AgentToolRegistry } from '../../../ekko-agent/src'
import { personBudgetedClient } from './person-model-context'
import { configurePersonRuntime } from '../modules/studio/public/person-runtime'
import { getChatRunServer } from '../modules/studio/public/chat-run'
import { createEkkoAuthorizedProviderFetch, resolveEkkoProviderRuntimeConfig } from '../modules/ekko/services/provider-runtime'
import { createModelClient, resolveModelProviderConfigs } from '../../../ekko-agent/src'
import { getCodingAgentModels } from '../modules/coding-agents/services'
import { executePersonTask, stopPersonTask } from './person-task-runtime'
import { getAvailableModelConfigForProfile } from '../modules/hermes/controllers/models'

configurePersonRuntime({
  modelConfig: getAvailableModelConfigForProfile,
  chatAgent: createPersonAgent,
  async model(input) {
    const selection = input.selection
    const config = await resolveEkkoProviderRuntimeConfig({ profile: selection.profile, provider: selection.provider, model: selection.model, apiMode: selection.apiMode })
    const { providerConfig } = resolveModelProviderConfigs({ ...config, provider: selection.provider, model: selection.model })
    const client = createModelClient(providerConfig, { fetch: createEkkoAuthorizedProviderFetch({ profile: selection.profile, provider: selection.provider, model: selection.model, accessToken: config.apiKey }) })
    const guarded = personBudgetedClient(client, input)
    const registry = new AgentToolRegistry()
    for (const tool of input.tools) registry.register({ definition: { name: tool.name, description: tool.description, parameters: tool.parameters }, async execute(args) {
      input.beforeRequest?.()
      if (input.signal.aborted) throw input.signal.reason || new Error('Cancelled')
      const value = await tool.execute(args)
      const content = JSON.stringify(value)
      if (content.length > 18000) throw new Error('Tool result too large; request a smaller page')
      return { ok: true, content }
    } })
    const runtime = new AgentRuntime({ modelClient: guarded, tools: registry, skillsEnabled: false, backgroundDelegationEnabled: false,
      systemPrompt: input.systemPrompt, maxSteps: input.maxSteps, maxModelRetries: 1, modelDefaults: { maxTokens: 2048 } })
    const result = await runtime.run({ messages: input.messages, signal: input.signal, memoryEnabled: false, skillReviewEnabled: false,
      ephemeralContext: true, reasoningEffort: input.reasoningEffort, onEvent: input.onEvent })
    return result.output.content
  },
  async nativeModels(runtime) {
    const result = await getCodingAgentModels({ agent: runtime })
    const catalog = result.agents[0]
    return { status: catalog?.status || 'unsupported', models: catalog?.models.filter(m => !m.hidden).map(m => ({ id: m.id, name: m.name, isDefault: m.isDefault, reasoningEffort: m.reasoningEffort, reasoningEfforts: m.reasoningEfforts })) || [] }
  },
  execute: executePersonTask,
  async deliver(input) {
    const server = getChatRunServer()
    if (!server) throw new Error('Chat runtime unavailable')
    await server.deliverPersonResult(input)
  },
  async answer(sessionId, id, response, approval) {
    return await getChatRunServer()?.respondPersonInteraction(sessionId, id, response, approval) || false
  },
  stop: stopPersonTask,
})
