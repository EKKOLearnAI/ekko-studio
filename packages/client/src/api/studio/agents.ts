import { request } from '@/api/client'

export type PluginAgentId = `plugin:${string}/${string}`
export interface StudioAgent {
  id: string; name: string; vendor: string; description: string; icon: string; origin: 'builtin' | 'plugin'; pluginId?: string
  modes: Array<'scoped' | 'global'>; surfaces: string[]
  actions: { settings: boolean; checkUpdate: boolean; upgrade: boolean; remove?: boolean; autoUpdate?: boolean }
  status: { installed: boolean; version: string; error?: string }
}
export interface AgentUpdate { currentVersion: string; latestVersion: string; updateAvailable: boolean; message?: string }
export const listStudioAgents = () => request<{ agents: StudioAgent[] }>('/api/studio/agents')
export function studioAgentAction<T>(id: string, action: 'settings' | 'check-update' | 'upgrade' | 'remove', input?: object) {
  return request<T>(`/api/studio/agents/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: JSON.stringify(input || {}) })
}
export type AgentUpdatePolicyState = import('@/api/coding-agents').AgentUpdatePolicyState
export const getStudioAgentUpdatePolicy = (id: string) => request<AgentUpdatePolicyState>(`/api/studio/agents/${encodeURIComponent(id)}/update-policy`)
export const setStudioAgentUpdatePolicy = (id: string, autoUpdate: boolean) => request<AgentUpdatePolicyState>(`/api/studio/agents/${encodeURIComponent(id)}/update-policy`, { method: 'PUT', body: JSON.stringify({ autoUpdate }) })
