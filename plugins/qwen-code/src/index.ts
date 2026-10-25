import { AcpRequestError, createAcpRuntime } from '@ekko-studio/agent-drivers'
import { StudioError, agentContextConfigurationProperties, type AgentOutputEvent, type JsonObject, type StudioPlugin } from '@ekko-studio/plugin-sdk'
import { scopedQwen } from './scoped'
import { management } from './management'
import { qwenCommandCatalog, compressCommand } from './commands'

const schema = {
  type: 'object', required: ['cwd'], additionalProperties: false,
  properties: {
    cwd: { type: 'string', minLength: 1, maxLength: 4096 },
    command: { type: 'string', minLength: 1, maxLength: 4096 },
    args: { type: 'array', maxItems: 128, items: { type: 'string', maxLength: 16384 } },
    env: { type: 'object', maxProperties: 128, additionalProperties: { type: 'string', maxLength: 32768 } },
    model: { type: 'string', minLength: 1, maxLength: 256 },
    reasoningEffort: { type: 'string', minLength: 1, maxLength: 64 },
    approvalRequired: agentContextConfigurationProperties.approvalRequired,
    systemPrompt: agentContextConfigurationProperties.systemPrompt,
    mcpServers: agentContextConfigurationProperties.mcpServers,
    studioMcp: agentContextConfigurationProperties.studioMcp,
  },
} as const

const plugin: StudioPlugin = {
  apply(plugin) {
    plugin.commands.register(compressCommand.definition, compressCommand.handler)
    plugin.agents.register({
      id: 'qwen', name: 'Qwen Code', configSchema: schema as unknown as JsonObject,
      management,
      capabilities: { text: true, images: true, streaming: true, reasoning: true, approvals: true, resume: true,
        resumeConfigKeys: ['model', 'reasoningEffort', 'systemPrompt', 'mcpServers', 'studioMcp'], nativeMcp: true, persistentSession: true, modes: ['scoped', 'global'] },
      async create(input, runtime) {
        return createAcpRuntime(input, runtime, {
          name: 'Qwen', command: 'qwen', args: ['--acp'], protocol: 'anthropic', prepareScoped: scopedQwen,
          commands: qwenCommandCatalog(runtime),
          handleError(error, emit) {
            if (error instanceof AcpRequestError && error.data && typeof error.data === 'object'
              && (error.data as { details?: unknown }).details === 'Compression was not beneficial for this history size.') {
              emit({ type: 'message.snapshot', messageId: 'answer', text: 'Qwen did not compact this conversation because compression would not reduce its size. The existing history was kept.' } as AgentOutputEvent)
              throw new StudioError('CAPABILITY_UNSUPPORTED', 'Qwen compression did not reduce the conversation')
            }
          },
        })
      },
    })
  },
}
export const apply = plugin.apply
