import catalog from '../../../../config/agents.json'
import type { CodingAgentId } from '@/api/coding-agents'

export const NATIVE_CODING_AGENT_IDS = ['qwen', 'kimi', 'codebuddy', 'qoder', 'copilot', 'zcode'] as const
export function isNativeCodingAgent(value: unknown): value is typeof NATIVE_CODING_AGENT_IDS[number] {
  return typeof value === 'string' && (NATIVE_CODING_AGENT_IDS as readonly string[]).includes(value)
}
export function agentMetadata(value: string) {
  return catalog.agents.find(agent => agent.id === value || agent.sessionId === value || agent.groupId === value)
}
export function isGlobalOnlyCodingAgent(value: unknown): boolean {
  const agent = agentMetadata(String(value || ''))
  return agent?.kind === 'coding-agent' && agent.modes.length === 1 && agent.modes[0] === 'global'
}
export function isCatalogCodingAgent(value: unknown): value is CodingAgentId {
  return agentMetadata(String(value || ''))?.kind === 'coding-agent'
}
