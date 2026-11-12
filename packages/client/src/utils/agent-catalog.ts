import catalog from '../../../../config/agents.json'
import type { CodingAgentId } from '@/api/coding-agents'
import { shallowRef } from 'vue'
import type { StudioAgent } from '@/api/studio/agents'

const pluginMetadata = shallowRef<typeof catalog.agents>([])
const pluginDescriptors = shallowRef<StudioAgent[]>([])
export function setPluginAgentMetadata(agents: StudioAgent[]) {
  pluginDescriptors.value = agents
  const base = catalog.agents.find(agent => agent.kind === 'coding-agent')!
  pluginMetadata.value = agents.map(agent => ({ ...base, id: agent.id, sessionId: agent.id, groupId: agent.id,
    name: agent.name, aliases: [], icon: agent.icon || '/logo.png', modes: agent.modes,
    installation: { ...base.installation, method: 'plugin', updates: agent.actions.checkUpdate, remove: Boolean(agent.actions.remove) },
    config: { ...base.config, mcp: false, settings: agent.actions.settings ? 'settings' : '', memory: '', skillsTarget: '', skillsWritable: false },
    capabilities: { ...base.capabilities, compact: false, serverManagedAuth: true } } as typeof catalog.agents[number]))
}
export function agentSupportsSurface(id: string, surface: string) {
  return !id.startsWith('plugin:') || Boolean(pluginDescriptors.value.find(agent => agent.id === id)?.surfaces.includes(surface))
}

export const NATIVE_CODING_AGENT_IDS = ['qwen', 'kimi', 'codebuddy', 'qoder', 'copilot', 'zcode'] as const
export function isNativeCodingAgent(value: unknown): value is typeof NATIVE_CODING_AGENT_IDS[number] {
  return typeof value === 'string' && (NATIVE_CODING_AGENT_IDS as readonly string[]).includes(value)
}
export function agentMetadata(value: string) {
  return [...catalog.agents, ...pluginMetadata.value].find(agent => agent.id === value || agent.sessionId === value || agent.groupId === value)
}
export function isGlobalOnlyCodingAgent(value: unknown): boolean {
  const agent = agentMetadata(String(value || ''))
  return agent?.kind === 'coding-agent' && agent.modes.length === 1 && agent.modes[0] === 'global'
}
export function isCatalogCodingAgent(value: unknown): value is CodingAgentId {
  return agentMetadata(String(value || ''))?.kind === 'coding-agent'
}

export function isPluginAgentId(value: unknown): value is `plugin:${string}/${string}` {
  return typeof value === 'string' && /^plugin:[a-z][a-z0-9._-]*\/[a-z][a-z0-9._-]*$/.test(value)
}
