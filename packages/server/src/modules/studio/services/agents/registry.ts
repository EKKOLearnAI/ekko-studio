import type { AgentMode, AgentScopedModel, AgentStatus, PluginIdentity } from '../../contracts/plugins'
import type { PluginAgentRuntime } from '../plugins/agent-runtime'
import { isPluginAgentId } from '../plugins/agent-runtime'
import { PluginError } from '../plugins/errors'

export { isPluginAgentId } from '../plugins/agent-runtime'
export interface AgentDescriptor {
  id: string; name: string; vendor: string; description: string; icon: string; origin: 'builtin' | 'plugin'; pluginId?: string
  modes: AgentMode[]; surfaces: string[]; actions: { settings: boolean; checkUpdate: boolean; upgrade: boolean; remove?: boolean; autoUpdate?: boolean }
}
export interface BuiltinAgentServices {
  list(): AgentDescriptor[]
  status(id: string): Promise<AgentStatus>
  settings(id: string): unknown
  models(id: string, refresh: boolean): Promise<unknown>
  checkUpdate(id: string): Promise<unknown>
  upgrade(id: string, input: { version: string; expectedVersion: string }): Promise<unknown>
  remove?(id: string, input: { expectedVersion: string }): Promise<unknown>
  updatePolicy?(id: string): Promise<unknown>
  setUpdatePolicy?(id: string, enabled: unknown): Promise<unknown>
  scopedModel(input: { identity: PluginIdentity; agentId: string; provider: string; model: string; apiMode: string; protocols: string[]; reasoningEffort?: string; signal: AbortSignal }): Promise<{ model: AgentScopedModel; dispose(): void }>
  mcpServers?(profile: string, tokenFile: string): Record<string, Record<string, unknown>>
}
let builtin: BuiltinAgentServices | undefined
let plugins: () => PluginAgentRuntime[] = () => []
export function configureBuiltinAgents(services: BuiltinAgentServices) { builtin = services }
export function configurePluginAgents(provider: () => PluginAgentRuntime[]) { plugins = provider }
export function pluginAgentRuntimes() { return plugins() }
export function pluginAgent(id: string) {
  if (!isPluginAgentId(id)) throw new PluginError('Invalid plugin Agent id')
  const agent = plugins().find(value => value.id === id)
  if (!agent) throw new PluginError('Agent plugin is disabled or unavailable', 'AGENT_UNAVAILABLE', 409)
  return agent
}
export function agentDescriptors(): AgentDescriptor[] {
  return [...(builtin?.list() || []), ...plugins().map(agent => agent.descriptor())]
}
export function agentDescriptor(id: string) { return agentDescriptors().find(agent => agent.id === id) }
function core(id: string) {
  if (!builtin || !builtin.list().some(agent => agent.id === id)) throw new PluginError('Unknown Agent', 'AGENT_NOT_FOUND', 404)
  return builtin
}
export async function agentStatus(id: string, identity: PluginIdentity): Promise<AgentStatus> {
  return isPluginAgentId(id) ? pluginAgent(id).status(identity) : core(id).status(id)
}
export async function agentModels(id: string, identity: PluginIdentity, refresh = false) {
  return isPluginAgentId(id) ? pluginAgent(id).models(identity, refresh) : core(id).models(id, refresh)
}
export async function agentSettings(id: string, identity: PluginIdentity) {
  return isPluginAgentId(id) ? pluginAgent(id).settings(identity) : core(id).settings(id)
}
export async function agentCheckUpdate(id: string, identity: PluginIdentity) {
  return isPluginAgentId(id) ? pluginAgent(id).checkUpdate(identity) : core(id).checkUpdate(id)
}
export async function agentUpgrade(id: string, identity: PluginIdentity, input: { version: string; expectedVersion: string }) {
  return isPluginAgentId(id) ? pluginAgent(id).upgrade(identity, input) : core(id).upgrade(id, input)
}
export async function agentRemove(id: string, identity: PluginIdentity, input: { expectedVersion: string }) {
  if (isPluginAgentId(id)) return pluginAgent(id).remove(identity, input)
  const services = core(id)
  if (!services.remove) throw new PluginError('Agent removal is unavailable', 'AGENT_UNSUPPORTED', 400)
  return services.remove(id, input)
}
export async function builtinAgentUpdatePolicy(id: string, enabled?: unknown, write = false) {
  const services = core(id)
  const operation = write ? services.setUpdatePolicy : services.updatePolicy
  if (!operation) throw new PluginError('Agent update policy is unavailable', 'AGENT_UNSUPPORTED', 400)
  return write ? services.setUpdatePolicy!(id, enabled) : services.updatePolicy!(id)
}
export function scopedAgentModel(input: Parameters<BuiltinAgentServices['scopedModel']>[0]) {
  if (!builtin) throw new PluginError('Studio model transport is unavailable', 'AGENT_UNAVAILABLE', 503)
  return builtin.scopedModel(input)
}

export function pluginAgentMode(id: string, mode: AgentMode): boolean { return !!agentDescriptor(id)?.modes.includes(mode) }
export function pluginAgentIsGlobalOnly(id: unknown): boolean { return isPluginAgentId(id) && pluginAgentMode(id, 'global') && !pluginAgentMode(id, 'scoped') }
export async function closePluginAgentSession(sessionId: string) { await Promise.allSettled(plugins().map(agent => agent.closeSession(sessionId))) }
export function pluginAgentMcpServers(profile: string, tokenFile: string) { return builtin?.mcpServers?.(profile, tokenFile) || {} }
