import type { CodingAgentModel } from '../../contracts/models'
import { ModelDiscoveryError, record, text, type DiscoveredModels, type ModelDiscoveryContext } from './types'

/** Initialize native selectors without sending a prompt or starting a Studio run. */
export async function discoverAcpModels(context: ModelDiscoveryContext, args: string[]): Promise<DiscoveredModels> {
  return context.rpc(args, async rpc => {
    const initialized = await rpc.request('initialize', {
      protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'ekko-studio-models', version: '1.0.0' },
    })
    if (initialized?.protocolVersion !== 1) throw new ModelDiscoveryError('unsupported')
    const session = await rpc.request('session/new', { cwd: context.cwd, mcpServers: [] })
    try {
      return modelsFromAcpSession(session)
    } finally {
      if (initialized.agentCapabilities?.sessionCapabilities?.close && session?.sessionId) {
        await rpc.request('session/close', { sessionId: session.sessionId }).catch(() => {})
      }
    }
  })
}

export function modelsFromAcpSession(value: unknown): DiscoveredModels {
  const session = record(value)
  const options = Array.isArray(session.configOptions) ? session.configOptions : []
  const selector = options.find(option => option?.category === 'model' || option?.id === 'model')
  const models: CodingAgentModel[] = []
  function addOptions(entries: unknown) {
    if (!Array.isArray(entries)) return
    for (const value of entries) {
      const option = record(value)
      // ACP group labels are UI sections, not necessarily provider identifiers.
      if (Array.isArray(option.options)) addOptions(option.options)
      else {
        const id = text(option.value)
        if (id) models.push({ id, name: text(option.name) || id, isDefault: option.value === selector.currentValue })
      }
    }
  }
  if (selector && Array.isArray(selector.options)) {
    addOptions(selector.options)
    return { models }
  }
  const native = record(session.models)
  if (!Array.isArray(native.availableModels)) throw new ModelDiscoveryError('unsupported')
  return { models: native.availableModels.flatMap((value: unknown) => {
    const item = record(value), id = text(item.modelId)
    return id ? [{ id, name: text(item.name) || id, isDefault: item.modelId === native.currentModelId }] : []
  }) }
}
