import { satisfies } from 'semver'
import { StudioError } from '../../contracts/plugins'
import type { PluginStore } from '../../repositories/plugin-store'

/** Resolve enabled providers in one profile before importing any plugin code. */
export function pluginActivationOrder(store: PluginStore, pluginId: string, profileId: string): string[] {
  const visiting = new Set<string>(), visited = new Set<string>(), ordered: string[] = []
  const visit = (id: string) => {
    if (visiting.has(id)) throw new StudioError('REGISTRATION_CONFLICT', 'Plugin service dependencies contain a cycle')
    if (visited.has(id)) return
    const installation = store.get(id), state = store.profile(id, profileId)
    if (!installation || !state?.enabled) throw new StudioError('PLUGIN_UNAVAILABLE', 'Required service provider is not enabled')
    visiting.add(id)
    for (const dependency of installation.manifest.requires.services || []) {
      const publisher = dependency.id.split('/')[0]
      const provider = store.get(publisher), enabled = store.profile(publisher, profileId)?.enabled
      const service = provider?.manifest.contributes.services?.find(value => value.id === dependency.id)
      if (!enabled || !service || !satisfies(service.version, dependency.version)) {
        if (dependency.optional) continue
        throw new StudioError(service && enabled ? 'PLUGIN_VERSION_INCOMPATIBLE' : 'PLUGIN_UNAVAILABLE', 'Required service is unavailable or incompatible')
      }
      visit(publisher)
    }
    visiting.delete(id)
    visited.add(id)
    ordered.push(id)
  }
  visit(pluginId)
  return ordered
}

export function requiredServiceDependents(store: PluginStore, pluginId: string, profileId?: string): Array<{ pluginId: string; profileId: string }> {
  return store.enabledProfiles().filter(state => (!profileId || state.profileId === profileId)
    && state.pluginId !== pluginId && store.get(state.pluginId)?.manifest.requires.services?.some(dependency =>
      !dependency.optional && dependency.id.split('/')[0] === pluginId))
    .map(({ pluginId, profileId }) => ({ pluginId, profileId }))
}
