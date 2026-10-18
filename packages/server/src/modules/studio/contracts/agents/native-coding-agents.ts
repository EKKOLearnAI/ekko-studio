// Native CLI identity is independent of its supported configuration modes.
export const NATIVE_CODING_AGENT_IDS = ['qwen', 'kimi', 'codebuddy', 'qoder', 'copilot', 'zcode'] as const
export type NativeCodingAgentId = typeof NATIVE_CODING_AGENT_IDS[number]

export function isNativeCodingAgent(value: unknown): value is NativeCodingAgentId {
  return typeof value === 'string' && (NATIVE_CODING_AGENT_IDS as readonly string[]).includes(value)
}

export function nativeCodingAgentSupportsScoped(value: unknown): value is Exclude<NativeCodingAgentId, 'qoder'> {
  return isNativeCodingAgent(value) && value !== 'qoder'
}

export function isGlobalOnlyCodingAgent(value: unknown): boolean {
  return value === 'cursor' || value === 'qoder'
}
