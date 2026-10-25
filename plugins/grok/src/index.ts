import { agentContextConfigurationProperties, StudioError, type StudioPlugin } from '@ekko-studio/plugin-sdk'
import { createGrokRuntime } from './runtime'
import { management } from './management'
export const apply: StudioPlugin['apply'] = plugin => {
  plugin.commands.register({ id: 'studio.agent-grok/compact', name: 'compact', description: 'Compact the current Grok conversation', agentTypeIds: ['grok'] }, async (input, ctx) => {
    if (!ctx.session.instanceId) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Grok compact requires an instance chat')
    await ctx.runs.start({ instanceId: ctx.session.instanceId, input: { content: [{ type: 'text', text: `/compact${input.rawArguments}` }] }, idempotencyKey: ctx.scope.scopeId })
    return { command: input.command, action: 'submitted', ok: true, message: '', terminal: false }
  })
  plugin.agents.register({ id: 'grok', name: 'Grok', management,
    capabilities: { text: true, images: true, streaming: true, reasoning: true, approvals: false, clarifications: false, resume: true, persistentSession: true, nativeMcp: true,
      resumeConfigKeys: ['model', 'reasoningEffort', 'contextWindow', 'outputLimit', 'systemPrompt', 'mcpServers', 'studioMcp'], modes: ['global', 'scoped'] },
    configSchema: { type: 'object', additionalProperties: false, required: ['cwd'], properties: {
      cwd: { type: 'string', minLength: 1, maxLength: 4096 }, command: { type: 'string', minLength: 1, maxLength: 4096 },
      args: { type: 'array', maxItems: 128, items: { type: 'string', maxLength: 16384 } }, env: { type: 'object', maxProperties: 128, additionalProperties: { type: 'string', maxLength: 32768 } },
      model: { type: 'string', minLength: 1, maxLength: 256 }, reasoningEffort: { type: 'string', enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
      contextWindow: { type: 'integer', minimum: 8192, maximum: 10000000 }, outputLimit: { type: 'integer', minimum: 1, maximum: 1000000 }, ...agentContextConfigurationProperties,
    } }, create: async (input, context) => createGrokRuntime(input, context) })
}
