import type { RouteLocationRaw } from 'vue-router'
import type { InstalledPlugin } from '@/api/studio/plugins'
import { pluginNavigation, pluginPageLocation } from '@/plugins/navigation'
import { pluginNavigationId } from '../../../shared/navigation-settings'

export interface NavigationEntry {
  id: string
  label?: string
  title?: string
  path?: string
  avatar?: string
  icon?: string
  to: RouteLocationRaw
  plugin?: InstalledPlugin
  viewId?: string
}

export const builtinNavigationEntries = (canManageAgents: boolean): NavigationEntry[] => ([
  { key: 'person', route: 'hermes.person', label: 'person.subtitle', avatar: '/person/idle.gif' },
  { key: 'chat', route: 'hermes.chat', label: 'sidebar.singleChat', path: 'M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' },
  { key: 'group', route: 'hermes.groupChat', label: 'sidebar.groupChat', path: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75' },
  { key: 'workflow', route: 'hermes.workflow', label: 'sidebar.workflow', path: 'M8 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0M22 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0M22 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0M8 12h3a4 4 0 0 0 4-4V6M8 12h3a4 4 0 0 1 4 4v2' },
  { key: 'history', route: 'hermes.history', label: 'sidebar.history', path: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M12 7v5l3 2' },
  { key: 'connections', route: 'hermes.connections', label: 'sidebar.connections', path: 'M3 4h14a1 1 0 0 1 1 1v4M3 4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h9M7 16v4M5 20h7M15 9h6a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1M17 18h2' },
  ...(canManageAgents ? [{ key: 'agents', route: 'hermes.agentManager', label: 'sidebar.agentManager', path: 'M12 8V4H8M7 8h10a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3M2 14h2M20 14h2M9 13v2M15 13v2' }] : []),
  { key: 'models', route: 'hermes.models', label: 'sidebar.models', path: 'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1' },
  { key: 'usage', route: 'hermes.usage', label: 'sidebar.usage', path: 'M3 12h4v9H3zM10 7h4v14h-4zM17 3h4v18h-4z' },
  { key: 'studioPlugins', route: 'studio.plugins', label: 'studioPlugins.title' },
  { key: 'apiRelay', route: 'hermes.apiRelay', label: 'sidebar.apiRelay', avatar: '/relay-logo.png' },
]).map(entry => ({ id: entry.key, label: entry.label, path: 'path' in entry ? entry.path : undefined,
  avatar: 'avatar' in entry ? entry.avatar : undefined, to: { name: entry.route } }))

export function navigationCatalog(plugins: InstalledPlugin[], canManageAgents: boolean): NavigationEntry[] {
  return [...builtinNavigationEntries(canManageAgents), ...plugins.filter(plugin => plugin.status === 'active').flatMap(plugin =>
    pluginNavigation(plugin).map(view => ({ id: pluginNavigationId(plugin.manifest.id, view.id), title: view.title, icon: view.icon,
      plugin, viewId: view.id, to: pluginPageLocation(plugin, view.id) }))) ]
}

export function selectedNavigationEntries(catalog: NavigationEntry[], items: string[]) {
  const entries = new Map(catalog.map(entry => [entry.id, entry]))
  return items.flatMap(id => { const entry = entries.get(id); return entry ? [entry] : [] })
}

/** Sort only displayed slots, preserving entries hidden by account permissions. */
export function reorderNavigationEntries(items: string[], visibleOrder: string[]) {
  const visible = new Set(visibleOrder)
  let index = 0
  return items.map(id => visible.has(id) ? visibleOrder[index++]! : id)
}
