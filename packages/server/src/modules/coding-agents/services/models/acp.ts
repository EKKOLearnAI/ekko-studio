import type { CodingAgentModel } from '../../contracts/models'
import { ModelDiscoveryError, positiveNumber, record, text, type DiscoveredModels, type ModelDiscoveryContext } from './types'

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

const ACP_EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

/** Order advertised levels first, then native metadata, keeping unknown extras last. */
function orderReasoningEfforts(efforts: string[]): string[] {
  return [...new Set(efforts)].sort((left, right) => {
    const leftRank = ACP_EFFORT_ORDER.indexOf(left), rightRank = ACP_EFFORT_ORDER.indexOf(right)
    if (leftRank === -1 && rightRank === -1) return 0
    if (leftRank === -1) return 1
    if (rightRank === -1) return -1
    return leftRank - rightRank
  })
}

/** Read only explicit public native metadata; never spread account objects. */
function acpModelMetadata(models: unknown) {
  const state = record(models)
  const available = Array.isArray(state.availableModels) ? state.availableModels : []
  const metadata = new Map<string, { contextWindow?: number; efforts: string[] }>()
  for (const value of available) {
    const item = record(value), id = text(item.modelId), meta = record(item._meta)
    if (!id) continue
    const efforts = Array.isArray(meta.effortOptions) ? meta.effortOptions
      .map((option: unknown) => text(record(option).value))
      .filter((entry): entry is string => typeof entry === 'string') : []
    metadata.set(id, { contextWindow: positiveNumber(meta.maxInputTokens), efforts })
  }
  return metadata
}

export function modelsFromAcpSession(value: unknown): DiscoveredModels {
  const session = record(value)
  const options = Array.isArray(session.configOptions) ? session.configOptions : []
  const selector = options.find(option => option?.category === 'model' || option?.id === 'model')
  const effortSelector = options.find(option => option?.category === 'thought_level' || option?.id === 'reasoning_effort')
  const reasoningEfforts = Array.isArray(effortSelector?.options) ? effortSelector.options
    .map((option: any) => text(option.value)).filter((value: unknown): value is string => typeof value === 'string') : []
  const nativeMetadata = acpModelMetadata(session.models)
  // ACP advertises thought levels per session, while each native model publishes
  // its own accepted levels. Union both so the effort selector stays editable
  // after switching away from the current model, and so the highest level a
  // model accepts (for example max) remains selectable.
  const reasoningMetadata = (id: string) => {
    const efforts = orderReasoningEfforts([...(nativeMetadata.get(id)?.efforts || []), ...reasoningEfforts])
    return efforts.length ? { reasoningEfforts: efforts } : {}
  }
  const contextMetadata = (id: string) => {
    const contextWindow = nativeMetadata.get(id)?.contextWindow
    return contextWindow ? { contextWindow } : {}
  }
  const models: CodingAgentModel[] = []
  function addOptions(entries: unknown) {
    if (!Array.isArray(entries)) return
    for (const value of entries) {
      const option = record(value)
      // ACP group labels are UI sections, not necessarily provider identifiers.
      if (Array.isArray(option.options)) addOptions(option.options)
      else {
        const id = text(option.value)
        if (id) models.push({ id, name: text(option.name) || id, isDefault: option.value === selector.currentValue,
          ...reasoningMetadata(id), ...contextMetadata(id) })
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
    return id ? [{ id, name: text(item.name) || id, isDefault: item.modelId === native.currentModelId,
      ...reasoningMetadata(id), ...contextMetadata(id) }] : []
  }) }
}
