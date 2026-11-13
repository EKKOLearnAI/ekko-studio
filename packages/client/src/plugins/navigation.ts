import type { InstalledPlugin } from '@/api/studio/plugins'

export const pluginPages = (plugin: InstalledPlugin) => (plugin.manifest.views || [])
  .slice().sort((a, b) => (a.order || 0) - (b.order || 0))

export const pluginPageLocation = (plugin: InstalledPlugin, viewId = pluginPages(plugin)[0]?.id) => ({
  name: pluginRouteName(pluginPages(plugin).find(view => view.id === viewId)?.slot),
  params: { pluginId: plugin.manifest.id, viewId },
})

export const pluginRouteName = (slot?: string) => slot === 'agent-settings' ? 'studio.pluginAgentSettings' : slot === 'settings' ? 'studio.pluginSettings' : 'studio.pluginPage'

export function pluginNavigation(plugin: InstalledPlugin, slot: 'main' | 'settings' = 'main') {
  const pages = pluginPages(plugin)
  return (plugin.manifest.navigation?.[slot] || []).flatMap(entry => {
    const view = pages.find(view => view.id === entry.viewId)
    return view ? [{ ...view, title: entry.title || view.title, icon: entry.icon, order: entry.order || 0 }] : []
  }).sort((a, b) => a.order - b.order)
}

export function pluginLinks(plugin: InstalledPlugin) {
  return (['repository', 'homepage', 'documentation', 'issues', 'changelog'] as const).flatMap(key => {
    const url = safePluginLink(plugin.manifest[key])
    return url ? [{ key, url }] : []
  })
}
export function safePluginLink(value: unknown): string | undefined {
  if (typeof value !== 'string') return
  try { const url = new URL(value); if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.href } catch { /* Do not render invalid links. */ }
}
export function pluginIcon(value: unknown): string | undefined {
  return typeof value === 'string' && /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : undefined
}
