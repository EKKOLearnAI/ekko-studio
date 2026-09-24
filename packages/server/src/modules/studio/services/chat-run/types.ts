import type { ChatCodingAgentId } from '../../contracts/runs/session'
export * from '../../contracts/runs/session'

export function codingAgentId(data: { coding_agent_id?: ChatCodingAgentId; agent_id?: ChatCodingAgentId }): Exclude<ChatCodingAgentId, 'ekko-agent'> {
  const value = data.coding_agent_id || data.agent_id || 'claude-code'
  if (value === 'codex' || value === 'pi' || value === 'grok' || (value === 'opencode' || value === 'dsh')) return value
  return 'claude-code'
}
