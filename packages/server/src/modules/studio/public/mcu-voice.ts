import type { AgentRuntime } from '../contracts/agents/runtime'

export type McuAgentRuntime = Extract<AgentRuntime, 'ekko' | 'hermes'>

export interface McuVoiceChatTurnInput {
  userToken: string
  profile: string
  interactionId: string
  transcript: string
  clientId?: string
  agentRuntime?: McuAgentRuntime
}

export interface McuVoiceDependencies {
  emitEvent(payload: Record<string, unknown>, options?: { clientId?: string }): boolean
  startChatTurn(input: McuVoiceChatTurnInput): void
}

let dependencies: McuVoiceDependencies | null = null

export function configureMcuVoice(next: McuVoiceDependencies): void {
  dependencies = next
}

export function emitMcuVoiceEvent(
  payload: Record<string, unknown>,
  options: { clientId?: string } = {},
): boolean {
  return dependencies?.emitEvent(payload, options) ?? false
}

export function startMcuVoiceChatTurn(input: McuVoiceChatTurnInput): void {
  dependencies?.startChatTurn(input)
}
