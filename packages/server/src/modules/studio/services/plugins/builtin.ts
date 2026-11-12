import { resolve, dirname, basename } from 'node:path'
import type { PluginIdentity } from '../../contracts/plugins'
import type { PluginManager } from './manager'
import { builtinPluginDirectory, builtinPluginIds, builtinPluginRoot } from './builtin-directory'
import { readManifest } from './installer'

/** Only retire demonstration packages installed from this checkout's old examples directory. */
export async function reconcileBuiltinPlugins(manager: PluginManager, identity: PluginIdentity, root = builtinPluginRoot()): Promise<void> {
  const parent = dirname(dirname(root)), repository = basename(parent) === 'dist' ? dirname(parent) : parent
  const examples = new Set(['notebook', 'tool-demo', 'session-dashboard', 'activity-digest', 'custom-agent'])
  for (const record of Object.values(manager.store.read().records)) {
    const id = record.manifest.id
    if (examples.has(id) && record.source === resolve(repository, 'examples/plugins', id)) {
      await manager.update(identity, id, manager.store.read().revision, { action: 'uninstall' })
    }
  }
  for (const id of builtinPluginIds(root)) {
    const manifest = await readManifest(builtinPluginDirectory(id, root))
    const state = manager.store.read(), record = state.records[id], source = `builtin:${id}`
    if (record && record.source !== source || !record && state.builtinVersions?.[id]) continue
    if (record?.manifest.version === manifest.version) continue
    await manager.install(identity, source, state.revision, record ? id : undefined)
    if (!record) await manager.update(identity, id, manager.store.read().revision, { enabled: true })
  }
}
