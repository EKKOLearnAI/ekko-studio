import { acpCommandCatalog, createAcpRuntime } from '@ekko-studio/agent-drivers'
import { agentContextConfigurationProperties, type StudioPlugin } from '@ekko-studio/plugin-sdk'
import { management } from './management'
import { copilotProtocol, scopedCopilot } from './scoped'
import { copilotEnvironment } from './environment'
import { prepareCopilotMcp } from './mcp'

export const apply: StudioPlugin['apply'] = plugin => {
  plugin.agents.register({
    id: 'copilot', name: 'GitHub Copilot', management,
    configSchema: { type: 'object', additionalProperties: false, required: ['cwd'], properties: {
      cwd: { type: 'string', minLength: 1, maxLength: 4096 }, command: { type: 'string', minLength: 1, maxLength: 4096 },
      args: { type: 'array', maxItems: 128, items: { type: 'string', maxLength: 16384 } },
      env: { type: 'object', maxProperties: 128, additionalProperties: { type: 'string', maxLength: 32768 } },
      model: { type: 'string', minLength: 1, maxLength: 256 }, reasoningEffort: { type: 'string', minLength: 1, maxLength: 64 },
      contextWindow: { type: 'integer', minimum: 8192, maximum: 10000000 }, outputLimit: { type: 'integer', minimum: 1, maximum: 1000000 },
      ...agentContextConfigurationProperties,
    } },
    capabilities: { text: true, images: true, streaming: true, reasoning: true, approvals: true, resume: true, nativeMcp: true, persistentSession: true,
      resumeConfigKeys: ['model', 'reasoningEffort', 'contextWindow', 'outputLimit', 'systemPrompt', 'mcpServers', 'studioMcp'], modes: ['scoped', 'global'] },
    async create(input, context) {
      return createAcpRuntime(input, context, { name: 'Copilot', command: 'copilot', args: ['--acp', '--no-auto-update'],
        protocol: copilotProtocol, prepareScoped: scopedCopilot,
        environment: (config, runtime, signal) => copilotEnvironment(config, runtime, process.platform, signal),
        sessionMcp: false, prepareLaunch: prepareCopilotMcp,
        promptConfiguration: requested => input.mode === 'scoped' ? { reasoningEffort: requested.reasoningEffort } : requested,
        commands: acpCommandCatalog(context, { pluginId: 'studio.agent-copilot', agentTypeId: 'copilot', name: 'Copilot' }) })
    },
  })
}
