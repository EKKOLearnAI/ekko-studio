import { agentContextConfigurationProperties, type StudioPlugin } from '@ekko-studio/plugin-sdk'
import { createCursorRuntime } from './runtime'
import { management } from './management'

export const apply: StudioPlugin['apply'] = plugin => {
  plugin.agents.register({ id: 'cursor', name: 'Cursor', description: 'Native Cursor account CLI (global mode)', management,
    capabilities: { text: true, images: true, streaming: true, reasoning: false, approvals: false, clarifications: false, resume: true, persistentSession: true, nativeMcp: true,
      resumeConfigKeys: ['model', 'systemPrompt', 'mcpServers', 'studioMcp'], modes: ['global'] },
    configSchema: { type: 'object', additionalProperties: false, required: ['cwd'], properties: {
      cwd: { type: 'string', minLength: 1, maxLength: 4096 }, command: { type: 'string', minLength: 1, maxLength: 4096 },
      args: { type: 'array', maxItems: 128, items: { type: 'string', maxLength: 16384 } }, env: { type: 'object', maxProperties: 128, additionalProperties: { type: 'string', maxLength: 32768 } },
      model: { type: 'string', minLength: 1, maxLength: 256 }, ...agentContextConfigurationProperties,
    } }, create: async (input, context) => createCursorRuntime(input, context) })
}
