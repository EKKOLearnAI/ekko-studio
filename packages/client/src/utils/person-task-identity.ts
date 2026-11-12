import type { PersonAgentPreset, PersonTask } from '@/api/person'
import { chatSessionAgentAvatar } from './chat-agent-avatar'

const knownRuntimes = new Set(['hermes', 'ekko', 'ekko-agent', 'ekko_agent', 'claude', 'claude-code', 'codex', 'pi', 'grok', 'opencode', 'dsh', 'cursor', 'qwen', 'kimi', 'codebuddy', 'qoder', 'copilot', 'zcode', 'antigravity'])

export function personTaskIdentity(task: Pick<PersonTask, 'selection_json' | 'execution_selection_json'>, agents: PersonAgentPreset[] = []) {
  let selection: Record<string, unknown> = {}
  try { selection = JSON.parse(task.execution_selection_json || task.selection_json || '{}') || {} } catch { /* Historical selections may be unavailable. */ }
  const runtime = typeof selection.runtime === 'string' ? selection.runtime.trim() : ''
  const avatar = (knownRuntimes.has(runtime.toLowerCase()) || runtime.startsWith('plugin:')) ? chatSessionAgentAvatar({ agent: runtime }) : null
  const snapshotName = typeof selection.agentName === 'string' ? selection.agentName.trim() : ''
  // Old tasks have no preset identity. Only a unique complete match is safe.
  const keys = ['runtime', 'mode', 'profile', 'provider', 'model', 'apiMode', 'reasoningEffort'] as const
  const matches = agents.filter(agent => selection.agentId
    ? agent.id === selection.agentId
    : keys.every(key => (agent.selection[key] || '') === (selection[key] || '')))
  return { avatar, name: snapshotName || (matches.length === 1 ? matches[0].name : '') || avatar?.label || runtime }
}
