import { request } from '../client'

export interface DshNativePluginInventory {
  source: 'native-presets'; sourceHome: string; packageVersion: string; defaultPreset: string
  web?: DshWebPackages
  runtimeConnected: false; discovery: 'shipped-and-user-roots' | 'bundle-declarations'
  presets: Array<{ id: string; name: string; description: string; trust: 'system' | 'user'; sourcePath: string; isDefault: boolean; error?: string
    entries: Array<{ entryId: string; title?: string; description?: string; moduleName: string; configuredEnabled: boolean | 'conditional'; runtimePhase: null; groupPath: string[] }>
  }>
}
export const readNativeDshPlugins = () => request<DshNativePluginInventory>('/api/coding-agents/dsh/plugin-inventory')

export interface DshWebPackages {
  profile: 'web'; sourcePath: string; revision: string
  packages: Array<{ name: string; title?: string; description?: string; requested: string; version: string; bundle: boolean; containsBrowserPart: boolean; sourcePath: string; error: string }>
}
export const changeWebPlugins = (body: { action: 'install'; packageSpec: string } | { action: 'remove'; packageName: string }, revision: string) =>
  request<DshNativePluginInventory>('/api/coding-agents/dsh/web-plugins', { method: 'POST', headers: { 'If-Match': `"${revision}"` }, body: JSON.stringify(body) })
export const openDshPluginUi = () => request<{ id: string; path: string }>('/api/coding-agents/dsh/ui-session', { method: 'POST' })
export const closeDshPluginUi = (id: string) => request<void>(`/api/coding-agents/dsh/ui-session/${id}`, { method: 'DELETE' })

export interface DshAgentPreset { id: string; name?: string; description?: string; trust?: 'system' | 'user'; isDefault: boolean; broken?: string }
export interface DshAgentPresets { presets: DshAgentPreset[]; authorable: boolean }
const presetPath = (id: string) => `/api/coding-agents/dsh/agent-presets/${encodeURIComponent(id)}`
export const listDshAgentPresets = () => request<DshAgentPresets>('/api/coding-agents/dsh/agent-presets')
export const readDshAgentPreset = (id: string) => request<{ agentPreset: string; content: string }>(presetPath(id))
export const copyDshAgentPreset = (body: { from: string; id: string; name?: string }) => request<DshAgentPresets>('/api/coding-agents/dsh/agent-presets', { method: 'POST', body: JSON.stringify(body) })
export const deleteDshAgentPreset = (id: string) => request<DshAgentPresets>(presetPath(id), { method: 'DELETE' })
export const defaultDshAgentPreset = (id: string) => request<DshAgentPresets>(presetPath(id) + '/default', { method: 'PUT' })
export const locateDshAgentPreset = (id: string) => request<{ path?: string; opened: boolean }>(presetPath(id) + '/location', { method: 'POST' })

export type DshSessionPreset = Pick<DshAgentPreset, 'id' | 'name' | 'description' | 'isDefault'> & { unavailable?: boolean }
export const listDshSessionPresets = () => request<{ presets: DshSessionPreset[] }>('/api/coding-agents/dsh/session-presets')
