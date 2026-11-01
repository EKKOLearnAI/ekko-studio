import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { requireExistingWorkspaceDirectory } from '../../../studio/public/workspace-manager'

/** Person tasks have an admitted binding; a missing directory must never become HOME. */
export function codingAgentWorkingDirectory(launch: { sessionId: string; workspaceDir: string }): string {
  if (launch.sessionId.startsWith('person-task-')) return requireExistingWorkspaceDirectory(launch.workspaceDir)
  return existsSync(launch.workspaceDir) ? launch.workspaceDir : homedir()
}
