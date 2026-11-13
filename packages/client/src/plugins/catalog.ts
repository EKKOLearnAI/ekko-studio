import type { InstalledPlugin } from '@/api/studio/plugins'
import type { MarketPlugin } from '@/api/studio/plugin-market'
import { pluginRepository } from './updates'

export const pluginCategories = ['all', 'agents', 'pages', 'chat', 'tools', 'automation'] as const
export type PluginCategory = typeof pluginCategories[number]
const categoryCapabilities = { agents: 'agents', pages: 'ui', chat: 'commands', tools: 'tools', automation: 'automation' } as const
export function matchesPluginCategory(capabilities: readonly string[], category: PluginCategory): boolean {
  return category === 'all' || capabilities.includes(categoryCapabilities[category])
}
export function matchesPluginSearch(plugin: { name: string; description?: string; id?: string; manifestId?: string | null; repository?: string; author?: { name: string }; keywords?: string[] }, search: string) {
  const query = search.trim().toLocaleLowerCase()
  return !query || [plugin.name, plugin.description, plugin.id, plugin.manifestId, plugin.repository, plugin.author?.name, ...(plugin.keywords || [])]
    .some(value => value?.toLocaleLowerCase().includes(query))
}
export function installedMarketPlugin(entry: MarketPlugin, plugins: InstalledPlugin[]): InstalledPlugin | undefined {
  return plugins.find(plugin => plugin.manifest.id === entry.manifestId
    && pluginRepository(plugin) === entry.repository)
}
