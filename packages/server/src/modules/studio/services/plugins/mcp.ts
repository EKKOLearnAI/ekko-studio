import { join } from 'node:path'
import { config } from '../../public/config'
import { logger } from '../../public/logging'
import { PluginStore } from './store'

function managedEnv(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {}
  const server = value as { env?: Record<string, unknown>; environment?: Record<string, unknown> }
  return server.env || server.environment || {}
}

/** Refresh managed plugin entries without shadowing a user's unrelated, same-name MCP. */
export function mergePluginMcpServers<T>(existing: Record<string, T>, desired: Record<string, T>): Record<string, T> {
  const dedicated = (name: string, value: unknown) => name !== 'ekko-studio-plugins'
    && managedEnv(value).HERMES_WEB_UI_MANAGED_MCP === '1' && managedEnv(value).HERMES_MCP_TOOLSET === 'plugins'
  const merged = Object.fromEntries(Object.entries(existing).filter(([name, value]) => !dedicated(name, value)))
  for (const [name, value] of Object.entries(desired)) {
    if (dedicated(name, value) && Object.hasOwn(merged, name) && managedEnv(merged[name]).HERMES_WEB_UI_MANAGED_MCP !== '1') continue
    merged[name] = value
  }
  return merged
}

/** Installed plugins retain their MCP definition while disabled, preserving per-Agent switches. */
export function pluginMcpServers(): Array<{ name: string; toolset: string }> {
  const state = new PluginStore(join(config.appHome, 'plugins')).read()
  return Object.values(state.records).flatMap(({ manifest }) => {
    const name = manifest.mcp?.name
    return name && name !== 'ekko-studio-plugins' && manifest.permissions.includes('tools') ? [{ name, toolset: 'plugins' }] : []
  })
}

export function isPluginMcpServerName(name: string): boolean {
  return pluginMcpServers().some(server => server.name === name)
}

let synchronize: (() => Promise<void>) | undefined
let synchronization = Promise.resolve()
export function configurePluginMcpSync(sync: () => Promise<void>): () => void {
  synchronize = sync
  return () => { if (synchronize === sync) synchronize = undefined }
}

export async function synchronizePluginMcpServers(): Promise<void> {
  // Package changes are already committed. A config sync failure must not report a rolled-back install.
  const sync = synchronize
  const next = synchronization.catch(() => {}).then(async () => { if (sync && synchronize === sync) await sync() })
  synchronization = next
  try { await next }
  catch (error) { logger.warn(error, 'Failed to synchronize plugin MCP servers') }
}
