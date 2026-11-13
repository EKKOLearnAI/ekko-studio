import { MCU_VOICE_SYSTEM_INSTRUCTIONS } from './mcu-voice-instructions'
import type { AgentRuntime } from '../../contracts/agents/runtime'

export type McuAgentRuntime = Extract<AgentRuntime, 'ekko' | 'hermes'>

export const DEFAULT_MCU_AGENT_RUNTIME: McuAgentRuntime = 'ekko'

export function normalizeMcuAgentRuntime(value: unknown): McuAgentRuntime {
  return typeof value === 'string' && value.trim().toLowerCase() === 'hermes'
    ? 'hermes'
    : DEFAULT_MCU_AGENT_RUNTIME
}

export function mcuChatRunFields(agentRuntime: McuAgentRuntime) {
  if (agentRuntime === 'hermes') {
    return {
      source: 'global_agent' as const,
      session_source: 'global_agent' as const,
      instructions: MCU_VOICE_SYSTEM_INSTRUCTIONS,
    }
  }

  return {
    source: 'coding_agent' as const,
    session_source: 'global_agent' as const,
    coding_agent_id: 'ekko-agent' as const,
    instructions: MCU_VOICE_SYSTEM_INSTRUCTIONS,
  }
}
