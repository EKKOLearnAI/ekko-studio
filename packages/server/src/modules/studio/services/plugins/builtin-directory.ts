import { existsSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { identifier } from './schema'
import { PluginError } from './errors'

export function builtinPluginRoot(): string {
  const candidates = [resolve(__dirname, '../plugins/builtin'), resolve(__dirname, '../../../../../../../plugins/builtin')]
  const root = candidates.find(path => existsSync(path))
  if (!root) throw new PluginError('Bundled Studio plugins are missing', 'PLUGIN_BUILTIN_MISSING', 503)
  return root
}
export function builtinPluginDirectory(id: string, root = builtinPluginRoot()): string {
  return join(root, identifier(id))
}
export function builtinPluginIds(root = builtinPluginRoot()): string[] {
  return readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && existsSync(join(root, entry.name, 'plugin.json')))
    .map(entry => identifier(entry.name)).sort()
}
