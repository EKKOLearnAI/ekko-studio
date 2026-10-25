/** Reserved distribution identities; these are packaging policy, never execution dispatch. */
export const SYSTEM_CODING_PLUGINS = [
  { agentTypeId: 'claude-code', pluginId: 'studio.agent-claude-code' },
  { agentTypeId: 'codex', pluginId: 'studio.agent-codex' },
  { agentTypeId: 'pi', pluginId: 'studio.agent-pi' },
  { agentTypeId: 'grok', pluginId: 'studio.agent-grok' },
  { agentTypeId: 'opencode', pluginId: 'studio.agent-opencode' },
  { agentTypeId: 'dsh', pluginId: 'studio.agent-dsh' },
  { agentTypeId: 'cursor', pluginId: 'studio.agent-cursor' },
  { agentTypeId: 'antigravity', pluginId: 'studio.agent-antigravity' },
  { agentTypeId: 'qwen', pluginId: 'studio.agent-qwen' },
  { agentTypeId: 'kimi', pluginId: 'studio.agent-kimi' },
  { agentTypeId: 'codebuddy', pluginId: 'studio.agent-codebuddy' },
  { agentTypeId: 'qoder', pluginId: 'studio.agent-qoder' },
  { agentTypeId: 'copilot', pluginId: 'studio.agent-copilot' },
  { agentTypeId: 'zcode', pluginId: 'studio.agent-zcode' },
] as const

const reservedPluginIds = new Set<string>(SYSTEM_CODING_PLUGINS.map(plugin => plugin.pluginId))
export function isSystemPluginId(id: string): boolean { return reservedPluginIds.has(id) }
