import type { MemoryNode } from './types'
import { memoryKindForCanonicalKey } from './schema'
import { evaluateMemory, type MemoryJevPolicy } from './jev-policy'
import { memoryKindQuestions, readMemoryKinds } from './jev-routing'
import { memoryFilterQuestions, readMemoryFilter } from './jev-filter'

/** Share evidence and a single provider call; enabling filtering adds no network stage. */
export async function judgeMemoryCandidates(policy: MemoryJevPolicy, query: string, candidates: MemoryNode[], baselineIds: ReadonlySet<string>) {
  const questions = { ...memoryKindQuestions(policy, candidates), ...memoryFilterQuestions(policy, candidates) }
  if (!Object.keys(questions).length) return { kinds: [], removedIds: new Set<string>() }
  const startedAt = Date.now()
  const result = await evaluateMemory(policy, { state: JSON.stringify({ request: query,
    cards: candidates.map(node => ({ kind: memoryKindForCanonicalKey(node.key)?.kind,
      title: node.title, content: node.content, value: node.valueJson })) }), questions })
  const durationMs = Date.now() - startedAt
  const kinds = readMemoryKinds(policy, candidates, result, durationMs)
  const admittedIds = new Set(candidates.filter(node => {
    const kind = memoryKindForCanonicalKey(node.key)?.kind
    return baselineIds.has(node.id) || kind && kinds.includes(kind)
  }).map(node => node.id))
  // An uncertain answer for a category that will not be recalled must not undo useful recall.
  return { kinds, removedIds: readMemoryFilter(policy, candidates, result, durationMs, admittedIds) }
}
