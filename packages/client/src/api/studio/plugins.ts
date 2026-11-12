import { getStoredUserId, request } from '../client'
import type { ApiRequest, Json, PluginEvent, PluginManifest, Schema } from '../../../../plugin-sdk/src'
export type { Json, PluginEvent, PluginManifest, Schema }
export interface InstalledPlugin {
  manifest: PluginManifest
  source: string
  developmentDirectory?: string
  installedAt: number
  enabled: boolean
  status: 'active' | 'disabled' | 'failed'
  error?: string
  previousVersion?: string
  config: Record<string, Json>
  tools: Array<{ name: string; description: string; inputSchema: Schema }>
  commands: Array<{ name: string; description: string }>
  actions: Array<{ name: string; description: string; inputSchema: Schema }>
}
export interface PluginSnapshot { revision: number; plugins: InstalledPlugin[] }
export interface PluginDevelopmentProject {
  id: string
  directory: string
  manifest?: PluginManifest
  createdAt?: number
  watching: boolean
  status: 'registered' | 'watching' | 'building' | 'error' | 'missing'
  error?: string
}
export function pluginRequest<T>(profile: string | undefined, path = '', body?: unknown, method = body === undefined ? 'GET' : 'POST', signal?: AbortSignal): Promise<T> {
  const context = profile ? `${path.includes('?') ? '&' : '?'}profile=${encodeURIComponent(profile)}` : ''
  return request(`/api/studio/plugins${path}${context}`, {
    method, signal, headers: { 'X-Hermes-Profile': profile || '' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}
export const pluginList = () => pluginRequest<PluginSnapshot>(undefined)
const catalogs = new Map<string, { at: number; promise: Promise<PluginSnapshot> }>()
export function pluginCatalog() {
  const key = String(getStoredUserId())
  let cached = catalogs.get(key)
  if (!cached || Date.now() - cached.at > 5000) {
    cached = { at: Date.now(), promise: pluginList() }; catalogs.set(key, cached)
  }
  return cached.promise
}
window.addEventListener('studio.plugins.changed', () => catalogs.clear())
export const pluginInvoke = (profile: string, id: string, kind: string, name: string, input: Json, sessionId?: string, signal?: AbortSignal) =>
  pluginRequest<{ result: Json }>(profile, `/${encodeURIComponent(id)}/invoke`, { kind, name, input, sessionId }, 'POST', signal).then(value => value.result)
export const pluginApi = (profile: string, id: string, path: string, options: ApiRequest, sessionId?: string, signal?: AbortSignal) =>
  pluginRequest<{ result: Json }>(profile, `/${encodeURIComponent(id)}/api`, { path, options, sessionId }, 'POST', signal).then(value => value.result)
