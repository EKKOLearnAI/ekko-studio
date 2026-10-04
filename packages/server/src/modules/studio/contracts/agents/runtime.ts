import type { AgentFamily } from './family'

export const AGENT_RUNTIMES = ['hermes', 'ekko', 'claude-code', 'codex', 'pi', 'grok', 'opencode', 'dsh', 'cursor', 'antigravity', 'qwen', 'kimi', 'codebuddy', 'qoder', 'copilot', 'zcode'] as const

export type AgentRuntime = typeof AGENT_RUNTIMES[number]
export type CodingAgentRuntime = Extract<AgentRuntime, 'claude-code' | 'codex' | 'pi' | 'grok' | 'opencode' | 'dsh' | 'cursor' | 'antigravity' | 'qwen' | 'kimi' | 'codebuddy' | 'qoder' | 'copilot' | 'zcode'>

const AGENT_RUNTIME_SET = new Set<string>(AGENT_RUNTIMES)

const RUNTIME_FAMILIES: Record<AgentRuntime, AgentFamily> = {
  hermes: 'hermes',
  ekko: 'ekko',
  'claude-code': 'coding',
  codex: 'coding',
  pi: 'coding',
  grok: 'coding',
  opencode: 'coding',
  dsh: 'coding',
  cursor: 'coding',
  antigravity: 'coding',
  qwen: 'coding',
  kimi: 'coding',
  codebuddy: 'coding',
  qoder: 'coding',
  copilot: 'coding',
  zcode: 'coding',

}

export function isAgentRuntime(value: unknown): value is AgentRuntime {
  return typeof value === 'string' && AGENT_RUNTIME_SET.has(value)
}

export function agentFamilyForRuntime(runtime: AgentRuntime): AgentFamily {
  return RUNTIME_FAMILIES[runtime]
}
