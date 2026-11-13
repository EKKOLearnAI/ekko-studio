import type { PluginIdentity } from '../../contracts/plugins'
import type { PluginManager } from './manager'
import { builtinPluginDirectory, builtinPluginIds, builtinPluginRoot } from './builtin-directory'
import { readManifest } from './installer'

/** Reconcile current product plugin packages through the ordinary manager. */
export async function reconcileBuiltinPlugins(manager: PluginManager, identity: PluginIdentity, root = builtinPluginRoot()): Promise<void> {
  for (const id of builtinPluginIds(root)) {
    const manifest = await readManifest(builtinPluginDirectory(id, root))
    const state = manager.store.read(), record = state.records[id], source = `builtin:${id}`
    if (record && record.source !== source || !record && state.builtinVersions?.[id]) continue
    if (record?.manifest.version === manifest.version) continue
    await manager.install(identity, source, state.revision, record ? id : undefined)
    if (!record) await manager.update(identity, id, manager.store.read().revision, { enabled: true })
  }
}
