import { acpCommandCatalog, createAcpRuntime } from '@ekko-studio/agent-drivers'
import { agentContextConfigurationProperties, type StudioPlugin } from '@ekko-studio/plugin-sdk'
import { management } from './management'
import { scopedCodeBuddy } from './scoped'

export const apply: StudioPlugin['apply'] = plugin => {
  plugin.agents.register({
    id: 'codebuddy', name: 'CodeBuddy', management,
    configSchema: { type: 'object', additionalProperties: false, required: ['cwd'], properties: {
      cwd: { type: 'string', minLength: 1, maxLength: 4096 }, command: { type: 'string', minLength: 1, maxLength: 4096 },
      args: { type: 'array', maxItems: 128, items: { type: 'string', maxLength: 16384 } },
      env: { type: 'object', maxProperties: 128, additionalProperties: { type: 'string', maxLength: 32768 } },
      model: { type: 'string', minLength: 1, maxLength: 256 },
      contextWindow: { type: 'integer', minimum: 8192, maximum: 10000000 }, outputLimit: { type: 'integer', minimum: 1, maximum: 1000000 },
      ...agentContextConfigurationProperties,
    } },
    capabilities: { text: true, images: true, streaming: true, reasoning: true, approvals: true, resume: true, nativeMcp: true, persistentSession: true,
      resumeConfigKeys: ['model', 'contextWindow', 'outputLimit', 'systemPrompt', 'mcpServers', 'studioMcp'], modes: ['scoped', 'global'] },
    async create(input, context) {
      return createAcpRuntime(input, context, { name: 'CodeBuddy', command: 'codebuddy', args: ['--acp'], completion: 'managed-stop',
        protocol: 'chat-completions', prepareScoped: scopedCodeBuddy,
        // The private native alias is selected by the launch, never by a Studio model ID in ACP.
        promptConfiguration: requested => input.mode === 'scoped' ? {} : requested,
        commands: acpCommandCatalog(context, { pluginId: 'studio.agent-codebuddy', agentTypeId: 'codebuddy', name: 'CodeBuddy' }) })
    },
  })
}
