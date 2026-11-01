import { personSettings } from '../../repositories/person-store'
import { getPersonExecution } from '../../repositories/person-store'
import { assertPersonStage } from '../../repositories/person-stage-store'
import type { PersonTaskOrigin } from '../../contracts/person'
import { requireExistingWorkspaceDirectory } from '../workspace/directory'

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
