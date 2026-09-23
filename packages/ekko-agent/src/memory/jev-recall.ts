import type { MemoryQuery, MemoryQueryResult, MemoryStore } from './types'
import { resolveMemoryQuery } from './retrieval'
import { memoryConflictKey } from './schema'
import { memoryJevEnabled, optionalMemoryJev } from './jev-policy'
import { routeMemoryKinds } from './jev-routing'
import { rerankMemoryNodes } from './jev-rerank'

export async function enhanceMemoryRecall(
  store: MemoryStore,
  query: MemoryQuery,
  text: string | undefined,
  baseline: MemoryQueryResult,
): Promise<MemoryQueryResult> {
  if (!text?.trim() || query.key || query.kinds?.length || query.valueJson !== undefined
    || (!memoryJevEnabled('memoryKindRoutingEnabled') && !memoryJevEnabled('memoryRerankEnabled'))) return baseline
  return optionalMemoryJev(baseline, async policy => {
    const kinds = await routeMemoryKinds(policy, text)
    const extra = kinds.length
      ? await store.queryNodes({ ...query, queryText: undefined, kinds, limit: 500 })
      : []
    policy.signal.throwIfAborted()
    const seen = new Set([...baseline.exact, ...baseline.relevant].map(node => memoryConflictKey(node)))
    const additional = extra.filter(node => !seen.has(memoryConflictKey(node)))
    const merged = additional.length
      ? resolveMemoryQuery(baseline.exact, [...baseline.relevant, ...additional], undefined, Number.MAX_SAFE_INTEGER)
      : baseline
    // Existing exact matches include always-recalled constraints/corrections and stay first.
    const relevant = await rerankMemoryNodes(policy, text, merged.relevant)
    const limit = query.limit === undefined ? Number.MAX_SAFE_INTEGER
      : Number.isFinite(query.limit) ? Math.max(1, Math.floor(query.limit)) : 1
    const keptExact = merged.exact.slice(0, limit)
    const keptRelevant = relevant.slice(0, limit - keptExact.length)
    const omitted = [...baseline.omitted, ...merged.omitted.filter(item => !baseline.omitted.some(old => old.nodeId === item.nodeId && old.reason === item.reason))]
    for (const node of [...merged.exact.slice(keptExact.length), ...relevant.slice(keptRelevant.length)]) {
      if (!omitted.some(item => item.nodeId === node.id && item.reason === 'over_limit')) omitted.push({ nodeId: node.id, reason: 'over_limit' })
    }
    const keptIds = new Set([...keptExact, ...keptRelevant].map(node => node.id))
    return { exact: keptExact, relevant: keptRelevant, omitted: omitted.filter(item => !keptIds.has(item.nodeId)) }
  })
}
