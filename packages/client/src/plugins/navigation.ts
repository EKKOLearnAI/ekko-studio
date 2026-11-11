import type { InstalledPlugin } from '@/api/studio/plugins'

/** Keep plugin navigation hidden until the feature is ready to ship. Direct routes remain available. */
export const PLUGIN_NAVIGATION_VISIBLE = false

export const pluginPages = (plugin: InstalledPlugin) => (plugin.manifest.views || [])
  .slice().sort((a, b) => (a.order || 0) - (b.order || 0))

export const pluginPageLocation = (plugin: InstalledPlugin, viewId = pluginPages(plugin)[0]?.id) => ({
  name: pluginPages(plugin).find(view => view.id === viewId)?.slot === 'settings' ? 'studio.pluginSettings' : 'studio.pluginPage',
  params: { pluginId: plugin.manifest.id, viewId },
})

export function pluginNavigation(plugin: InstalledPlugin) {
  const pages = pluginPages(plugin)
  const workspace = pages.find(view => view.slot === 'workspace')
  return pages.filter(view => view.slot === 'page' || view === workspace)
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
