import { EkkoDirectoryManager } from '../../../ekko-agent/src/directories'
import { config } from '../modules/studio/public/config'

/** Use the same per-profile, per-session directory and retention as Ekko single chat. */
export function createPersonDefaultWorkspace(profile: string, sessionId: string): string {
  return new EkkoDirectoryManager(config.appHome).sessionWorkspaceDirectory(profile, sessionId)
}
