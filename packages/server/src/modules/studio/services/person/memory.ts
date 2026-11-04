import { join } from 'node:path'
import { EkkoDatabaseManager } from '../../../../../../ekko-agent/src/database'
import { MemoryService } from '../../../../../../ekko-agent/src/memory/service'
import { SqliteMemoryStore } from '../../../../../../ekko-agent/src/memory/store'
import { createMemoryTools } from '../../../../../../ekko-agent/src/memory/tools'
import type { MemoryRuntimeIdentity } from '../../../../../../ekko-agent/src/memory/types'
import { getWebUiHome } from '../../public/config'
import { personError } from '../../contracts/person'
import { personUser } from './catalog'
import { personUpdated } from '../../repositories/person-updates'

const stores = new Map<string, { service: MemoryService; store: SqliteMemoryStore }>()

/** One physical store per account; model Profiles never select the memory owner. */
export function personMemory(userId: number, sessionId = `person-memory-${userId}`) {
  if (!Number.isSafeInteger(userId) || userId < 1) throw personError('Invalid account', 403)
  personUser(userId)
  const path = join(getWebUiHome(), 'person', String(userId), 'memory.db')
  let memory = stores.get(path)
  if (!memory) {
    const store = new SqliteMemoryStore(new EkkoDatabaseManager({ databasePath: path }))
    memory = { store, service: new MemoryService({ store, automaticRecallTokenBudget: 1000 }) }
    stores.set(path, memory)
  }
  const identity: MemoryRuntimeIdentity = {
    sessionId, profileId: `person:${userId}`,
    origin: { host: 'ekko-studio', namespace: 'person', contextId: String(userId) },
    recallScopes: [{ type: 'profile' }], writeScopes: [{ type: 'profile' }], defaultWriteScope: { type: 'profile' },
  }
  return { service: memory.service, identity }
}

export async function personMemories(userId: number) {
  const { service, identity } = personMemory(userId)
  return service.list({ profileId: identity.profileId, scopes: identity.recallScopes, limit: 500 })
}

export async function forgetPersonMemory(userId: number, id: string, revision: number) {
  const { service, identity } = personMemory(userId)
  const result = await service.forget({ id, expectedRevision: revision, identity, mode: 'hard', actor: 'user', reason: 'User deleted this Person memory.' })
  if (!result.deletedIds.length) throw personError(result.reason || 'Memory not found or changed', 409)
  personUpdated(userId)
  return result
}

/** Background coordinators can read the account memory, but cannot write it. */
export function personMemoryReadTools(userId: number) {
  const { service, identity } = personMemory(userId)
  return createMemoryTools(service, { writable: false }).map(tool => ({ ...tool.definition,
    async execute(args: Record<string, unknown>) {
      personUser(userId)
      const result = await tool.execute(args, { sessionId: identity.sessionId, profileId: identity.profileId, memoryRecallScopes: identity.recallScopes })
      if (!result.ok) throw personError(result.error || result.content)
      return result.data ?? result.content
    },
  }))
}

export function closePersonMemoryStores() {
  for (const { store } of stores.values()) store.close()
  stores.clear()
}
