import { memoryKindForCanonicalKey } from './schema'
import type { MemoryKind, MemoryNode } from './types'

export const ALWAYS_RECALLED_MEMORY_KINDS: MemoryKind[] = [
  'interaction_contract',
  'language_preference',
  'accessibility_need',
  'communication_preference',
  'hard_constraint',
]

/** Weak keyword/kind matches may be filtered; standing instructions must survive. */
export function isProtectedMemoryNode(node: MemoryNode): boolean {
  const kind = memoryKindForCanonicalKey(node.key)?.kind
  return node.type === 'constraint' || node.type === 'correction'
    || Boolean(kind && ALWAYS_RECALLED_MEMORY_KINDS.includes(kind))
}
