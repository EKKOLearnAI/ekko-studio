import { randomUUID } from 'node:crypto'
import { personError, personRevision, personText, PERSON_DEFAULT_TEAM_ID } from '../../contracts/person'
import type { PersonTeam } from '../../contracts/person'
import {
  deletePersonTeamRowInTransaction, ensureDefaultPersonTeam, insertPersonTeam, listPersonTeams, personOperation,
  personTeamUsage, renamePersonTeam, requirePersonTeam, savePersonTeamAgents,
} from '../../repositories/person-store'
import { validatePersonAgents } from './agents'
import { archivePersonTeamMemory } from './memory'

export function personTeams(userId: number): PersonTeam[] {
  // A team is the only container an Agent preset can live in, so an account
  // without one could never add its first Agent. The default team is created on
  // first read instead of on signup so every existing account migrates lazily.
  ensureDefaultPersonTeam(userId)
  return listPersonTeams(userId)
}

export function personTeamUsageView(userId: number, id: string) {
  requirePersonTeam(userId, id)
  return { team_id: id, default: id === PERSON_DEFAULT_TEAM_ID, ...personTeamUsage(userId, id) }
}

/** Team names are user-visible identifiers, so they are trimmed and unique per account. */
function teamName(value: unknown): string {
  return personText(value, 'team name', 100)
}

function uniqueTeamName(userId: number, name: string, exceptId?: string) {
  const clash = listPersonTeams(userId).find(team => team.id !== exceptId
    && team.name.toLocaleLowerCase() === name.toLocaleLowerCase())
  if (clash) throw Object.assign(personError('A team with this name already exists', 409), { code: 'PERSON_TEAM_NAME_EXISTS' })
  return name
}

export type PersonTeamAction = 'create' | 'rename' | 'delete' | 'save'

/**
 * One entry point for every team mutation so the HTTP controller stays thin and
 * the idempotency key covers double-submits from the settings sidebar.
 */
export async function applyPersonTeam(userId: number, input: Record<string, unknown>) {
  const action = personText(input.action, 'action', 20) as PersonTeamAction
  if (!['create', 'rename', 'delete', 'save'].includes(action)) throw personError('Unsupported team action')
  const key = personText(input.idempotency_key, 'idempotency_key', 200)
  const replayInput = { ...input, action }
  // Agent validation is async and the idempotency wrapper is synchronous, so it
  // runs once before the transaction.
  const agents = action === 'save' ? await validatePersonAgents(userId, input.agents) : undefined
  return personOperation(userId, `team:${key}`, replayInput, () => {
    if (action === 'create') {
      const name = uniqueTeamName(userId, teamName(input.name))
      const team = insertPersonTeam(userId, randomUUID(), name)
      return { team, teams: personTeams(userId) }
    }
    const id = personText(input.team_id, 'team_id', 100)
    const team = requirePersonTeam(userId, id)
    if (action === 'rename') {
      const renamed = renamePersonTeam(userId, id, uniqueTeamName(userId, teamName(input.name), id), personRevision(input.expected_revision))
      return { team: renamed, teams: personTeams(userId) }
    }
    if (action === 'save') return { team: savePersonTeamAgents(userId, team.id, agents || []), teams: personTeams(userId) }
    const revision = personRevision(input.expected_revision)
    const { moved } = deletePersonTeamRowInTransaction(userId, id, revision)
    const archived = archivePersonTeamMemory(userId, id)
    return { deleted: id, conversations_moved: moved, memory_archived: archived, teams: personTeams(userId) }
  })
}
