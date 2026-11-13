export const AGENT_FAMILIES = ['hermes', 'ekko', 'coding'] as const

export type AgentFamily = typeof AGENT_FAMILIES[number]

const AGENT_FAMILY_SET = new Set<string>(AGENT_FAMILIES)

export function isAgentFamily(value: unknown): value is AgentFamily {
  return typeof value === 'string' && AGENT_FAMILY_SET.has(value)
}
