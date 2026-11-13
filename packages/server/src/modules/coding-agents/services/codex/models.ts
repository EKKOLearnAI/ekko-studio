import { ModelDiscoveryError, record, text, type ModelDiscoveryAdapter } from '../models/types'

export const codexModels: ModelDiscoveryAdapter = {
  source: 'app-server', scope: 'available',
  discover: context => context.rpc(['app-server', '--stdio'], async rpc => {
    await rpc.request('initialize', { clientInfo: { name: 'ekko-studio-models', version: '1.0.0' }, capabilities: {} })
    rpc.notify('initialized')
    const models = []
    let cursor: string | undefined
    const cursors = new Set<string>()
    do {
      const result = record(await rpc.request('model/list', { limit: 100, includeHidden: true, ...(cursor ? { cursor } : {}) }))
      if (!Array.isArray(result.data)) throw new ModelDiscoveryError('error')
      for (const raw of result.data) {
        const item = record(raw), id = text(item.model) || text(item.id)
        if (id) models.push({ id, name: text(item.displayName) || id, isDefault: item.isDefault, hidden: item.hidden,
          reasoningEfforts: Array.isArray(item.supportedReasoningEfforts) ? item.supportedReasoningEfforts.map((effort: any) => effort?.reasoningEffort) : undefined,
          inputModalities: item.inputModalities })
      }
      cursor = text(result.nextCursor)
      if (cursor && (cursors.has(cursor) || models.length >= 5000)) throw new ModelDiscoveryError('error')
      if (cursor) cursors.add(cursor)
    } while (cursor)
    return { models }
  }),
}
