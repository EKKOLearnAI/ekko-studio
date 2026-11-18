import type { PluginIdentity } from '../../contracts/plugins'
import { logger } from '../../public/logging'
import { ensureBuiltinPlugins } from '../plugins/host'
import { agentDescriptors, agentStatus, type AgentDescriptor } from './registry'

const PLUGIN_STATUS_TIMEOUT_MS = 5_000

export async function listAgentStatuses(identity: PluginIdentity, origin?: AgentDescriptor['origin']) {
  // Reconciliation also synchronizes MCP workers. Serve the registered inventory
  // while that work runs, including on the first login of a new installation.
  void ensureBuiltinPlugins().catch(error => logger.warn({ err: error }, 'Unable to reconcile bundled Studio plugins'))
  const signal = AbortSignal.timeout(PLUGIN_STATUS_TIMEOUT_MS)
  const descriptors = agentDescriptors().filter(agent => !origin || agent.origin === origin)
  return Promise.all(descriptors.map(async descriptor => {
    try {
      const { installed, version, source, error } = await agentStatus(descriptor.id, identity, signal)
      return { ...descriptor, status: { installed, version, source, error } }
    } catch (error) {
      return { ...descriptor, status: { installed: false, version: '', error: error instanceof Error ? error.message : String(error) } }
    }
  }))
}
