import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { identifier } from './schema'
import { PluginError } from './errors'

export function builtinPluginRoot(): string {
  const candidates = [resolve(__dirname, '../plugins/builtin'), resolve(__dirname, '../../../../../../../plugins/builtin')]
  const root = candidates.find(path => existsSync(path))
  if (!root) throw new PluginError('Bundled Studio plugins are missing', 'PLUGIN_BUILTIN_MISSING', 503)
  return root
}
export function builtinPluginDirectory(id: string, root = builtinPluginRoot()): string {
  const directory = join(root, identifier(id))
  if (existsSync(join(directory, 'plugin.json'))) return directory
  const packageName = builtinPackages(root)[id]
  if (!packageName) return directory
  try {
    return dirname(createRequire(join(root, 'package.json')).resolve(`${packageName}/plugin.json`))
  } catch {
    throw new PluginError(`Bundled plugin dependency ${packageName} is missing; install Studio dependencies before running from source`, 'PLUGIN_BUILTIN_MISSING', 503)
  }
}
export function builtinPluginIds(root = builtinPluginRoot()): string[] {
  const directories = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && existsSync(join(root, entry.name, 'plugin.json'))).map(entry => entry.name)
  return [...new Set([...directories, ...Object.keys(builtinPackages(root))])].map(id => identifier(id)).sort()
}
function builtinPackages(root: string): Record<string, string> {
  const file = join(root, 'packages.json')
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
}
