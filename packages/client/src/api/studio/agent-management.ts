import { request } from '../client'
import type { AgentSetup, AgentInspection, AgentTypeSummary, JsonObject, AgentManagementOperation, AgentManagementOutput } from '../../../../studio-plugin-sdk/src/types'

export type { AgentSetup, AgentInspection, AgentTypeSummary, JsonObject, AgentManagementOperation }
export interface ManagedAgentInstance { id: string; agentTypeId: string; revision: number; mode: 'scoped' | 'global'; config: JsonObject }
export interface ManagedAgentChat { sessionId: string; instanceId: string; profileId: string; configurationRevision: number; createdAt: number }
export function createOrdinaryAgentChat(profile: string, selection: { sessionId: string; agentTypeId: string; mode: 'scoped' | 'global'; workspace?: string; model?: string; provider?: string; reasoningEffort?: string; agentPreset?: string; categoryId?: number | null; pushEnabled?: boolean; baseUrl?: string; apiKey?: string; apiMode?: string }) {
  return data<ManagedAgentChat>('agent-chats', profile, 'POST', selection)
}
export interface BundledAgentPlugin { id: string; name: string; pluginId: string; installed: boolean; enabled: boolean; revision: number; state: string; requiredCapabilities: string[] }
const query = (profile: string) => `?${new URLSearchParams({ profile })}`
async function data<T>(path: string, profile: string, method = 'GET', body?: unknown): Promise<T> {
  return (await request<{ data: T }>(`/api/studio/${path}${query(profile)}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })).data
}
export async function fetchAgentTypes(profile: string) { return (await data<{ agents: AgentTypeSummary[] }>('agent-types', profile)).agents }
export function fetchManagedAgentInstances(profile: string) { return data<ManagedAgentInstance[]>('agent-instances', profile) }
export function createManagedAgentChat(profile: string, instance: ManagedAgentInstance, idempotencyKey: string) {
  return data<ManagedAgentChat>(`agent-instances/${encodeURIComponent(instance.id)}/chats`, profile, 'POST', { revision: instance.revision, idempotencyKey })
}
export async function uploadManagedAgentImage(profile: string, bytes: Blob) {
  return (await request<{ data: { id: string; mediaType: string; byteLength: number } }>(`/api/studio/agent-images${query(profile)}`,
    { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes })).data
}
export function removeManagedAgentImage(profile: string, id: string) { return data(`agent-images/${encodeURIComponent(id)}`, profile, 'DELETE') }
export function saveManagedAgentInstance(profile: string, agentTypeId: string, config: JsonObject, mode: 'scoped' | 'global', existing?: ManagedAgentInstance) {
  return existing ? data<ManagedAgentInstance>(`agent-instances/${encodeURIComponent(existing.id)}`, profile, 'PUT', { config, mode, revision: existing.revision })
    : data<ManagedAgentInstance>('agent-instances', profile, 'POST', { agentTypeId, config, mode })
}
export function fetchBundledAgentPlugins(profile: string) { return data<BundledAgentPlugin[]>('bundled-agent-plugins', profile) }
export function enableBundledAgentPlugin(profile: string, plugin: BundledAgentPlugin) { return data(`bundled-agent-plugins/${encodeURIComponent(plugin.id)}/enable`, profile, 'POST', { revision: plugin.revision, grants: plugin.requiredCapabilities }) }
export function fetchAgentSetup(profile: string, instance: ManagedAgentInstance) { return data<AgentSetup>(`agent-instances/${encodeURIComponent(instance.id)}/setup`, profile, 'POST', { revision: instance.revision }) }
export function inspectManagedAgent(profile: string, instance: ManagedAgentInstance) { return data<AgentInspection>(`agent-instances/${encodeURIComponent(instance.id)}/inspect`, profile, 'POST', {}) }
export function startAgentLogin(profile: string, instance: ManagedAgentInstance, idempotencyKey: string) { return data<AgentManagementOperation>(`agent-instances/${encodeURIComponent(instance.id)}/login`, profile, 'POST', { revision: instance.revision, idempotencyKey }) }
export function startAgentInstall(profile: string, instance: ManagedAgentInstance, idempotencyKey: string) { return data<AgentManagementOperation>(`agent-instances/${encodeURIComponent(instance.id)}/install`, profile, 'POST', { revision: instance.revision, idempotencyKey }) }
export function fetchAgentManagementOperations(profile: string, instanceId: string) { return data<AgentManagementOperation[]>(`agent-instances/${encodeURIComponent(instanceId)}/operations`, profile) }
export function fetchAgentManagementOperation(profile: string, id: string) { return data<AgentManagementOperation>(`agent-management-operations/${encodeURIComponent(id)}`, profile) }
export async function fetchAgentManagementOutput(profile: string, id: string, after: number) {
  return (await request<{ data: AgentManagementOutput }>(`/api/studio/agent-management-operations/${encodeURIComponent(id)}/output?${new URLSearchParams({ profile, after: String(after) })}`)).data
}
export function sendAgentManagementInput(profile: string, id: string, sequence: number, text: string) { return data(`agent-management-operations/${encodeURIComponent(id)}/input`, profile, 'POST', { sequence, text }) }
export function resizeAgentManagementTerminal(profile: string, id: string, cols: number, rows: number) { return data(`agent-management-operations/${encodeURIComponent(id)}/resize`, profile, 'POST', { cols, rows }) }
export function cancelAgentManagementOperation(profile: string, id: string) { return data<AgentManagementOperation>(`agent-management-operations/${encodeURIComponent(id)}/cancel`, profile, 'POST', {}) }
export function respondManagedAgent(profile: string, runId: string, response: import('../../../../studio-plugin-sdk/src/types').AgentInteractionResponse) {
  return data<import('../../../../studio-plugin-sdk/src/types').AgentInteractionReceipt>(`agent-runs/${encodeURIComponent(runId)}/respond`, profile, 'POST', response)
}
