import { personSettings } from '../../repositories/person-store'
import { getPersonExecution } from '../../repositories/person-store'
import { assertPersonStage } from '../../repositories/person-stage-store'
import type { PersonTaskOrigin } from '../../contracts/person'
import { personError } from '../../contracts/person'
import { personRuntime } from '../../public/person-runtime'
import { isAbsolute } from 'node:path'
import { normalizeDirectoryTarget, requireExistingWorkspaceDirectory } from '../workspace/directory'

/** Provision defaults only for new Bots; existing bindings are never recreated or replaced. */
export function personCreationWorkspace(value: unknown, profile: string, sessionId: string): string {
  if (value != null && (typeof value !== 'string' || value.length > 4000)) throw personError('Invalid workspace')
  const selected = normalizeDirectoryTarget(typeof value === 'string' ? value.trim() : '')
  if (selected) {
    if (!isAbsolute(selected)) throw personError('Workspace must be an absolute path')
    return requireExistingWorkspaceDirectory(selected)
  }
  try {
    const create = personRuntime().createDefaultWorkspace
    if (!create) throw new Error('Default workspace provider is unavailable')
    return requireExistingWorkspaceDirectory(create(profile, sessionId))
  } catch (error) {
    throw Object.assign(personError(`Failed to create the default Bot workspace: ${error instanceof Error ? error.message : String(error)}`, 409), {
      code: 'WORKSPACE_UNAVAILABLE',
    })
  }
}

export function personWorkspace(userId: number, sessionId: string): string {
  return personSettings(userId, sessionId).settings.workspace
}

/** Only trusted host context can select a collaboration or task-result workspace. */
export function personTurnWorkspace(userId: number, sessionId: string, origin?: Pick<PersonTaskOrigin, 'stage' | 'returnExecutionId'>): string {
  const workspace = origin?.stage ? assertPersonStage(userId, origin.stage, sessionId).flow.workspace
    : origin?.returnExecutionId ? getPersonExecution(userId, origin.returnExecutionId).workspace
      : personWorkspace(userId, sessionId)
  return requireExistingWorkspaceDirectory(workspace)
}

export { requireExistingWorkspaceDirectory as requirePersonWorkspace }
