import { isNativeCodingAgent } from '../../contracts/agents/native-coding-agents'
import { isBuiltinEkkoAgent } from '../../contracts/history-source'
import type { ChatRunWebhookAgent } from '../webhooks'

export function isBridgeRunSource(source?: string): boolean {
  return source === 'cli' || source === 'global_agent' || source === 'workflow' || source === 'group_chat'
}

export function isProviderAgentExecution(source: string | undefined, data?: { coding_agent_id?: string; agent_id?: string }): boolean {
  return isEkkoAgentExecution(data) || source === 'builtin_agent' || source === 'coding_agent'
    || ((source === 'workflow' || source === 'group_chat') && Boolean(data?.coding_agent_id || data?.agent_id))
}

export function isEkkoAgentExecution(data?: { coding_agent_id?: string; agent_id?: string }): boolean {
  return isBuiltinEkkoAgent(data?.coding_agent_id) || isBuiltinEkkoAgent(data?.agent_id)
}

export function webhookAgentForRun(data?: { coding_agent_id?: string; agent_id?: string }): ChatRunWebhookAgent {
  const agent = data?.coding_agent_id || data?.agent_id
  if (agent === 'ekko-agent') return 'ekko'
  if (agent === 'codex') return 'codex'
  if (agent === 'pi') return 'pi'
  if (agent === 'grok') return 'grok'
  if ((agent === 'antigravity' || isNativeCodingAgent(agent))) return 'antigravity'
  if (agent === 'cursor') return 'cursor'
  if (agent === 'dsh') return 'dsh'
  if (agent === 'opencode') return 'opencode'
  if (agent === 'claude-code') return 'claude-code'
  return 'bridge'
}
