import { reactive } from 'vue'
import type { ChatCodingAgentId } from '@/api/coding-agents'
import type { StudioAgent } from '@/api/studio/agents'
import { setPluginAgentMetadata } from './agent-catalog'
// Keep every Agent picker in the same order as single chat.
export const AGENT_OPTIONS = reactive<Array<{ label: string; value: 'hermes' | ChatCodingAgentId }>>([
  { label: 'Ekko', value: 'ekko-agent' },
  { label: 'Hermes', value: 'hermes' },
  { label: 'Claude', value: 'claude-code' },
  { label: 'Codex', value: 'codex' },
  { label: 'Pi', value: 'pi' },
  { label: 'Grok', value: 'grok' },
  { label: 'OpenCode', value: 'opencode' },
  { label: 'DeepSeek Harness', value: 'dsh' },
  { label: 'Cursor', value: 'cursor' },
  { label: 'Antigravity', value: 'antigravity' },
  { label: 'Qwen Code', value: 'qwen' },
  { label: 'Kimi Code', value: 'kimi' },
  { label: 'CodeBuddy', value: 'codebuddy' },
  { label: 'Qoder', value: 'qoder' },
  { label: 'GitHub Copilot', value: 'copilot' },
  { label: 'ZCode', value: 'zcode' },

])

export const GROUP_AGENT_OPTIONS = reactive(AGENT_OPTIONS.map(option => ({
  label: option.label,
  value: option.value === 'ekko-agent' ? 'ekko' as const
    : option.value === 'claude-code' ? 'claude' as const
      : option.value,
})))

export function syncPluginAgentOptions(agents: StudioAgent[]) {
  const plugins = agents.filter(agent => agent.origin === 'plugin' && agent.id.startsWith('plugin:'))
  const builtins = AGENT_OPTIONS.filter(option => !option.value.startsWith('plugin:'))
  AGENT_OPTIONS.splice(0, AGENT_OPTIONS.length, ...builtins, ...plugins.map(agent => ({ label: agent.name, value: agent.id as `plugin:${string}/${string}` })))
  GROUP_AGENT_OPTIONS.splice(0, GROUP_AGENT_OPTIONS.length, ...AGENT_OPTIONS.map(option => ({ label: option.label,
    value: option.value === 'ekko-agent' ? 'ekko' as const : option.value === 'claude-code' ? 'claude' as const : option.value })))
  setPluginAgentMetadata(plugins)
}
