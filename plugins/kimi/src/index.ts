import { acpCommandCatalog, createAcpRuntime } from '@ekko-studio/agent-drivers'
import { agentContextConfigurationProperties, type StudioPlugin } from '@ekko-studio/plugin-sdk'
import { management } from './management'
import { scopedKimi } from './scoped'
import { kimiEnvironment } from './environment'

export const apply: StudioPlugin['apply'] = plugin => {
  plugin.agents.register({
    id: 'kimi', name: 'Kimi Code', management,
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
      return createAcpRuntime(input, context, { name: 'Kimi', command: 'kimi', args: ['acp'], protocol: 'anthropic', prepareScoped: scopedKimi,
        environment: (config, runtime, signal) => kimiEnvironment(config, runtime, process.platform, signal),
        promptConfiguration(requested) {
          const env = input.config.env as Record<string, string> | undefined
          // KIMI_MODEL_NAME synthesizes an in-memory route. ACP's selector only accepts TOML model aliases.
          return input.mode === 'scoped' || (requested.model && env?.KIMI_MODEL_NAME === requested.model) ? {} : requested
        },
        commands: acpCommandCatalog(context, { pluginId: 'studio.agent-kimi', agentTypeId: 'kimi', name: 'Kimi' }) })
    },
  })
}
