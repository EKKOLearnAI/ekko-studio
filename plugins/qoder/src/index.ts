import { acpCommandCatalog, createAcpRuntime } from '@ekko-studio/agent-drivers'
import { agentContextConfigurationProperties, type StudioPlugin } from '@ekko-studio/plugin-sdk'
import { management } from './management'
import { checkQoderPlatform } from './environment'

export const apply: StudioPlugin['apply'] = plugin => {
  plugin.agents.register({
    id: 'qoder', name: 'Qoder', management,
    configSchema: { type: 'object', additionalProperties: false, required: ['cwd'], properties: {
      cwd: { type: 'string', minLength: 1, maxLength: 4096 }, command: { type: 'string', minLength: 1, maxLength: 4096 },
      args: { type: 'array', maxItems: 128, items: { type: 'string', maxLength: 16384 } },
      env: { type: 'object', maxProperties: 128, additionalProperties: { type: 'string', maxLength: 32768 } },
      model: { type: 'string', minLength: 1, maxLength: 256 },
      ...agentContextConfigurationProperties,
    } },
    capabilities: { text: true, images: true, streaming: true, reasoning: true, approvals: true, resume: true, nativeMcp: true, persistentSession: true,
      resumeConfigKeys: ['model', 'systemPrompt', 'mcpServers', 'studioMcp'], modes: ['global'] },
    async create(input, context) {
      checkQoderPlatform()
      return createAcpRuntime(input, context, { name: 'Qoder', command: 'qoder', args: ['--acp'],
        commands: acpCommandCatalog(context, { pluginId: 'studio.agent-qoder', agentTypeId: 'qoder', name: 'Qoder' }) })
    },
  })
}
