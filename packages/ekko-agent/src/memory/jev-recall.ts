import type { MemoryQuery, MemoryQueryResult, MemoryStore } from './types'
import { resolveMemoryQuery } from './retrieval'
import { memoryConflictKey, memoryKindForCanonicalKey } from './schema'
import { memoryJevEnabled, optionalMemoryJev } from './jev-policy'
import { judgeMemoryCandidates } from './jev-candidates'
import { isProtectedMemoryNode } from './recall-policy'
import { rerankMemoryNodes } from './jev-rerank'

export async function enhanceMemoryRecall(
  store: MemoryStore,
  query: MemoryQuery,
  text: string | undefined,
  baseline: MemoryQueryResult,
): Promise<MemoryQueryResult> {
  if (!text?.trim() || query.key || query.kinds?.length || query.valueJson !== undefined
    || (!memoryJevEnabled('memoryKindRoutingEnabled') && !memoryJevEnabled('memoryRerankEnabled')
      && !memoryJevEnabled('memoryRelevanceFilterEnabled'))) return baseline
  return optionalMemoryJev('recall', baseline, async policy => {
    // Preserve authorized scopes and discard inactive/conflicting cards before sending evidence.
    const pool = policy.settings.memoryKindRoutingEnabled
      ? await store.queryNodes({ ...query, queryText: undefined, limit: 500 }) : []
    policy.signal.throwIfAborted()
    const eligible = resolveMemoryQuery([], pool, undefined, 500).relevant
    const weakMatches = policy.settings.memoryRelevanceFilterEnabled
      ? [...baseline.exact, ...baseline.relevant].filter(node => !isProtectedMemoryNode(node)) : []
    const weakIds = new Set(weakMatches.map(node => node.id))
    // Check ordinary baseline matches first; unjudged cards outside the cap remain intact.
    const candidates = [...weakMatches, ...eligible.filter(node => !weakIds.has(node.id))].slice(0, policy.settings.memoryCandidateLimit)
    const { kinds, removedIds } = await judgeMemoryCandidates(policy, text, candidates, weakIds)
    const extra = candidates.filter(node => {
      const kind = memoryKindForCanonicalKey(node.key)?.kind
      return kind && kinds.includes(kind) && !removedIds.has(node.id)
    })
    policy.signal.throwIfAborted()
    const seen = new Set([...baseline.exact, ...baseline.relevant].map(node => memoryConflictKey(node)))
    const additional = extra.filter(node => !seen.has(memoryConflictKey(node)))
    const merged = additional.length
      ? resolveMemoryQuery(baseline.exact, [...baseline.relevant, ...additional], undefined, Number.MAX_SAFE_INTEGER)
      : baseline
    // Explicit queries bypass this enhancement; only weak automatic exact matches can be dropped.
    const exact = merged.exact.filter(node => !removedIds.has(node.id))
    let relevant = await rerankMemoryNodes(policy, text, merged.relevant.filter(node => !removedIds.has(node.id)))
    if (additional.length) {
      // JEV may have waited while a card was forgotten, edited, expired or superseded.
      const current = await store.queryNodes({ ...query, queryText: undefined, kinds, limit: 500 })
      policy.signal.throwIfAborted()
      const revisions = new Map(resolveMemoryQuery([], current, undefined, 500).relevant.map(node => [node.id, node.revision]))
      const addedIds = new Set(additional.map(node => node.id))
      relevant = relevant.filter(node => !addedIds.has(node.id) || revisions.get(node.id) === node.revision)
    }
    const limit = query.limit === undefined ? Number.MAX_SAFE_INTEGER
      : Number.isFinite(query.limit) ? Math.max(1, Math.floor(query.limit)) : 1
    const keptExact = exact.slice(0, limit)
    const keptRelevant = relevant.slice(0, limit - keptExact.length)
    const omitted = [...baseline.omitted, ...merged.omitted.filter(item => !baseline.omitted.some(old => old.nodeId === item.nodeId && old.reason === item.reason))]
    for (const node of [...exact.slice(keptExact.length), ...relevant.slice(keptRelevant.length)]) {
      if (!omitted.some(item => item.nodeId === node.id && item.reason === 'over_limit')) omitted.push({ nodeId: node.id, reason: 'over_limit' })
    }
    const keptIds = new Set([...keptExact, ...keptRelevant].map(node => node.id))
    return { exact: keptExact, relevant: keptRelevant, omitted: omitted.filter(item => !keptIds.has(item.nodeId)) }
  })
}
