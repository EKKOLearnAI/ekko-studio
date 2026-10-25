import { agentContextConfigurationProperties, type StudioPlugin } from '@ekko-studio/plugin-sdk'
import { management } from './management'
import { createNativeRuntime } from './runtime'
export const apply: StudioPlugin['apply'] = (plugin) => {
  plugin.agents.register({
    id: 'antigravity',
    name: 'Antigravity',
    management,
    configSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['cwd'],
      properties: {
        cwd: { type: 'string', minLength: 1, maxLength: 4096 },
        command: { type: 'string', minLength: 1, maxLength: 4096 },
        args: { type: 'array', maxItems: 128, items: { type: 'string', maxLength: 16384 } },
        env: { type: 'object', maxProperties: 128, additionalProperties: { type: 'string', maxLength: 32768 } },
        model: { type: 'string', minLength: 1, maxLength: 256 },
        ...agentContextConfigurationProperties,
      },
    },
    capabilities: {
      text: true,
      images: true,
      streaming: true,
      resume: true,
      nativeMcp: true,
      persistentSession: true,
      resumeConfigKeys: ['model', 'systemPrompt', 'mcpServers', 'studioMcp'],
      modes: ['global', 'scoped'],
    },
    create: async (input, context) => createNativeRuntime(input, context),
  })
}
