import type { Dispose, Json } from '../../contracts/plugins'
import { PluginError } from './errors'

/** Host adapters expose exclusive resources without exporting their implementation. */
export class PluginResources {
  private entries = new Map<string, { describe(): Json; owner?: string }>()
  register(name: string, describe: () => Json): Dispose {
    if (this.entries.has(name)) throw new PluginError(`Host resource already registered: ${name}`)
    const entry = { describe }
    this.entries.set(name, entry)
    return () => { if (this.entries.get(name) === entry) this.entries.delete(name) }
  }
  claimed(name: string): boolean { return Boolean(this.entries.get(name)?.owner) }
  claim(name: string, owner: string): { data: Json; release: Dispose } {
    const entry = this.entries.get(name)
    if (!entry) throw new PluginError(`Host resource unavailable: ${name}`, 'PLUGIN_UNAVAILABLE', 503)
    if (entry.owner) throw new PluginError(`Host resource is already owned: ${name}`, 'PLUGIN_RESOURCE_BUSY', 409)
    // Synchronous check + assignment prevents a built-in operation slipping between them.
    const data = structuredClone(entry.describe())
    entry.owner = owner
    return { data, release: () => { if (entry.owner === owner) delete entry.owner } }
  }
}
export const pluginResources = new PluginResources()
