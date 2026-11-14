import { copyFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { EkkoDatabaseManager } from '../../../../../../ekko-agent/src/database'
import { MemoryService } from '../../../../../../ekko-agent/src/memory/service'
import { SqliteMemoryStore } from '../../../../../../ekko-agent/src/memory/store'
import { createMemoryTools } from '../../../../../../ekko-agent/src/memory/tools'
import type { MemoryRuntimeIdentity } from '../../../../../../ekko-agent/src/memory/types'
import { getWebUiHome } from '../../public/config'
import { PERSON_DEFAULT_TEAM_ID, personError } from '../../contracts/person'
import { personUser } from './catalog'
import { personUpdated } from '../../repositories/person-updates'
import { requirePersonTeam } from '../../repositories/person-store'

const stores = new Map<string, { service: MemoryService; store: SqliteMemoryStore }>()

/** Pre-team builds kept one shared store per account; it seeds the default team once. */
function legacyMemoryPath(userId: number) {
  return join(getWebUiHome(), 'person', String(userId), 'memory.db')
}

function copyLegacyMemory(userId: number, target: string) {
  const source = legacyMemoryPath(userId)
  if (!existsSync(source)) return
  mkdirSync(dirname(target), { recursive: true })
  // Copy the WAL sidecars too: a store closed mid-checkpoint keeps rows there.
  for (const suffix of ['', '-wal', '-shm']) {
    const from = `${source}${suffix}`
    if (existsSync(from)) copyFileSync(from, `${target}${suffix}`)
  }
}

function teamMemoryPath(userId: number, teamId: string) {
  const path = join(getWebUiHome(), 'person', String(userId), 'teams', teamId, 'memory.db')
  if (teamId === PERSON_DEFAULT_TEAM_ID && !existsSync(path)) copyLegacyMemory(userId, path)
  return path
}

/** One physical store per account and team; a team's bots never see another team's memory. */
export function personMemory(userId: number, sessionId = `person-memory-${userId}`, teamId?: string) {
  if (!Number.isSafeInteger(userId) || userId < 1) throw personError('Invalid account', 403)
  personUser(userId)
  const team = requirePersonTeam(userId, teamId)
  const profileId = `person:${userId}:${team.id}`
  const path = teamMemoryPath(userId, team.id)
  let memory = stores.get(path)
  if (!memory) {
    mkdirSync(dirname(path), { recursive: true })
    const store = new SqliteMemoryStore(new EkkoDatabaseManager({ databasePath: path }))
    memory = { store, service: new MemoryService({ store, automaticRecallTokenBudget: 1000 }) }
    stores.set(path, memory)
  }
  const identity: MemoryRuntimeIdentity = {
    sessionId, profileId,
    origin: { host: 'ekko-studio', namespace: 'person', contextId: `${userId}:${team.id}` },
    recallScopes: [{ type: 'profile' }], writeScopes: [{ type: 'profile' }], defaultWriteScope: { type: 'profile' },
  }
  return { service: memory.service, identity }
}

export async function personMemories(userId: number, teamId?: string) {
  const { service, identity } = personMemory(userId, `person-memory-${userId}`, teamId)
  return service.list({ profileId: identity.profileId, scopes: identity.recallScopes, limit: 500 })
}

export async function forgetPersonMemory(userId: number, id: string, revision: number, teamId?: string) {
  const { service, identity } = personMemory(userId, `person-memory-${userId}`, teamId)
  const result = await service.forget({ id, expectedRevision: revision, identity, mode: 'hard', actor: 'user', reason: 'User deleted this Person memory.' })
  if (!result.deletedIds.length) throw personError(result.reason || 'Memory not found or changed', 409)
  personUpdated(userId)
  return result
}

/** Background coordinators can read the account memory, but cannot write it. */
export function personMemoryReadTools(userId: number, teamId?: string) {
  const { service, identity } = personMemory(userId, `person-memory-${userId}`, teamId)
  return createMemoryTools(service, { writable: false }).map(tool => ({ ...tool.definition,
    async execute(args: Record<string, unknown>) {
      personUser(userId)
      const result = await tool.execute(args, { sessionId: identity.sessionId, profileId: identity.profileId, memoryRecallScopes: identity.recallScopes })
      if (!result.ok) throw personError(result.error || result.content)
      return result.data ?? result.content
    },
  }))
}

/**
 * Deleting a team never destroys its memory: the store is closed and the whole
 * directory is moved aside so an operator can still recover it.
 */
export function archivePersonTeamMemory(userId: number, teamId: string): string | null {
  if (teamId === PERSON_DEFAULT_TEAM_ID) return null
  const dir = join(getWebUiHome(), 'person', String(userId), 'teams', teamId)
  if (!existsSync(dir)) return null
  const cached = stores.get(join(dir, 'memory.db'))
  if (cached) { cached.store.close(); stores.delete(join(dir, 'memory.db')) }
  const target = join(getWebUiHome(), 'person', String(userId), 'teams', '.archive', `${teamId}-${Date.now()}`)
  mkdirSync(join(target, '..'), { recursive: true })
  renameSync(dir, target)
  return target
}

export function closePersonMemoryStores() {
  for (const { store } of stores.values()) store.close()
  stores.clear()
}
