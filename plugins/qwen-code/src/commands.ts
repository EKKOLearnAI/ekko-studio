import { acpCommands, acpCommandCatalog } from '@ekko-studio/agent-drivers'
import type { AgentRuntimeContext } from '@ekko-studio/plugin-sdk'

const identity = { pluginId: 'studio.agent-qwen', agentTypeId: 'qwen', name: 'Qwen', staticIds: { compress: 'studio.agent-qwen/compress' } }
export const qwenCommands = (value: unknown) => acpCommands(value, identity)
export const compressCommand = qwenCommands([{ name: 'compress', description: 'Compress the current Qwen conversation' }])[0]!
export const qwenCommandCatalog = (runtime: AgentRuntimeContext) => acpCommandCatalog(runtime, identity)
