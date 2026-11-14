import { BUILTIN_NAVIGATION_IDS, pluginNavigationId, validateNavigationSettings } from '../../../../../shared/navigation-settings'
import { getUserNavigation, saveUserNavigation } from '../repositories/user-navigation-store'
import { getPluginManager } from './plugins/host'

export { getUserNavigation }

export class NavigationValidationError extends Error {}

export function updateUserNavigation(userId: number, input: unknown) {
  let settings
  try { settings = validateNavigationSettings(input) }
  catch (error) { throw new NavigationValidationError((error as Error).message) }
  const previous = new Set(getUserNavigation(userId).items)
  const registered = new Set<string>(BUILTIN_NAVIGATION_IDS)
  for (const plugin of getPluginManager().snapshot().plugins) {
    if (plugin.status !== 'active') continue
    const views = new Set(plugin.manifest.views?.map(view => view.id))
    for (const entry of plugin.manifest.navigation?.main || []) {
      if (views.has(entry.viewId)) registered.add(pluginNavigationId(plugin.manifest.id, entry.viewId))
    }
  }
  // Keep unavailable selections so disabling a plugin does not erase the user's order.
  if (settings.items.some(id => !registered.has(id) && !previous.has(id))) throw new NavigationValidationError('Plugin has no active registered main navigation entry')
  return saveUserNavigation(userId, settings)
}
