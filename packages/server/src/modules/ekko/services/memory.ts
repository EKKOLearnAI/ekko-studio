import type {
  EkkoAgentSetup,
  MemoryNode,
  MemoryNodeStatus,
} from '../../../../../ekko-agent/src'
import { MEMORY_NODE_STATUSES } from '../../../../../ekko-agent/src'
import { setupGlobalEkkoAgent } from './manager'

export interface ListEkkoMemoryInput {
  profile: string
  query?: string
  status?: MemoryNodeStatus
  limit?: number
  offset?: number
}

export interface UpdateEkkoMemoryInput {
  expectedRevision: number
  title?: string
  content?: string
  tags?: string[]
}

function resolveSetup(setup?: EkkoAgentSetup): EkkoAgentSetup {
  return setup || setupGlobalEkkoAgent()
}

function normalizeProfile(profile: string): string {
  return String(profile || '').trim() || 'default'
}

export async function listEkkoMemory(
  input: ListEkkoMemoryInput,
  setup?: EkkoAgentSetup,
): Promise<MemoryNode[]> {
  const profile = normalizeProfile(input.profile)
  const limit = Math.min(Math.max(Number(input.limit) || 100, 1), 500)
  const offset = Math.max(Number(input.offset) || 0, 0)
  return resolveSetup(setup).memory.list({
    profileId: profile,
    queryText: String(input.query || '').trim() || undefined,
    statuses: input.status ? [input.status] : [...MEMORY_NODE_STATUSES],
    limit,
    offset,
  })
}

export async function updateEkkoMemory(
  profileInput: string,
  id: string,
  input: UpdateEkkoMemoryInput,
  setup?: EkkoAgentSetup,
): Promise<MemoryNode> {
  const profile = normalizeProfile(profileInput)
  const current = await resolveSetup(setup).memory.get(id, { profileId: profile })
  if (!current) throw new Error('Memory not found.')

  const result = await resolveSetup(setup).memory.update(id, {
    expectedRevision: input.expectedRevision,
    node: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.content !== undefined ? { content: input.content } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
    },
    reason: 'Updated from Ekko memory settings.',
    actor: 'studio-user',
    explicitUserIntent: true,
    identity: { profileId: profile },
  })
  if (!result.accepted || !result.node) {
    throw new Error(result.reason || 'Memory update failed.')
  }
  return result.node
}

export async function deleteEkkoMemory(
  profileInput: string,
  id: string,
  expectedRevision: number,
  setup?: EkkoAgentSetup,
): Promise<MemoryNode> {
  const profile = normalizeProfile(profileInput)
  const current = await resolveSetup(setup).memory.get(id, { profileId: profile })
  if (!current) throw new Error('Memory not found.')

  const result = await resolveSetup(setup).memory.delete(id, {
    expectedRevision,
    mode: 'soft',
    reason: 'Deleted from Ekko memory settings.',
    actor: 'studio-user',
    identity: { profileId: profile },
  })
  const deleted = result.deletedMemories?.[0]
  if (!deleted) throw new Error(result.reason || 'Memory delete failed.')
  return deleted
}
