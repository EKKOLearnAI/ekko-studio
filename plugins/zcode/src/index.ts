import { agentContextConfigurationProperties, type StudioPlugin } from '@ekko-studio/plugin-sdk'
import { createZcodeRuntime } from './runtime'
import { management } from './management'

export const apply: StudioPlugin['apply'] = plugin => {
  plugin.agents.register({ id: 'zcode', name: 'ZCode', management,
    capabilities: { text: true, images: true, streaming: true, reasoning: true, approvals: true, clarifications: true, resume: true, persistentSession: true, nativeMcp: true,
      resumeConfigKeys: ['model', 'reasoningEffort', 'contextWindow', 'outputLimit', 'systemPrompt', 'mcpServers', 'studioMcp'], modes: ['scoped', 'global'] },
    configSchema: { type: 'object', additionalProperties: false, required: ['cwd'], properties: {
      cwd: { type: 'string', minLength: 1, maxLength: 4096 }, command: { type: 'string', minLength: 1, maxLength: 4096 },
      args: { type: 'array', maxItems: 128, items: { type: 'string', maxLength: 16384 } },
      env: { type: 'object', maxProperties: 128, additionalProperties: { type: 'string', maxLength: 32768 } },
      model: { type: 'string', minLength: 1, maxLength: 256 }, reasoningEffort: { type: 'string', minLength: 1, maxLength: 128 }, approvalRequired: { type: 'boolean' },
      contextWindow: { type: 'integer', minimum: 8192, maximum: 10000000 }, outputLimit: { type: 'integer', minimum: 1, maximum: 1000000 },
      ...agentContextConfigurationProperties,
    } }, create: async (input, context) => createZcodeRuntime(input, context) })
}
