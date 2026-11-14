import type { RouteLocationRaw } from 'vue-router'
import { isStoredSuperAdmin } from '@/api/client'
import { pluginCatalog, type InstalledPlugin } from '@/api/studio/plugins'
import { useNavigationStore } from '@/stores/navigation'
import { navigationCatalog, selectedNavigationEntries } from './navigation-entries'

const fallback: RouteLocationRaw = { name: 'hermes.settings' }

export async function resolveNavigationStartup(): Promise<RouteLocationRaw> {
  const navigation = useNavigationStore()
  await navigation.load()
  if (!navigation.loaded) return fallback

  const items = [...navigation.items], canManageAgents = isStoredSuperAdmin()
  const builtins = navigationCatalog([], canManageAgents)
  const firstBuiltin = selectedNavigationEntries(builtins, items)[0]
  const builtinIndex = firstBuiltin ? items.indexOf(firstBuiltin.id) : items.length
  // Built-in first entries do not wait for an unrelated plugin catalog request.
  if (!items.slice(0, builtinIndex).some(id => id.startsWith('plugin:'))) return firstBuiltin?.to || fallback

  let plugins: InstalledPlugin[] = []
  try {
    const snapshot = await pluginCatalog()
    if (Array.isArray(snapshot.plugins)) plugins = snapshot.plugins
  }
  catch { /* Unavailable plugin entries are skipped just as they are in the rail. */ }
  return selectedNavigationEntries(navigationCatalog(plugins, canManageAgents), items)[0]?.to || fallback
}
