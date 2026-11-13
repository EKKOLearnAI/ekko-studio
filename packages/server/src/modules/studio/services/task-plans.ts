import { listTaskPlansForPage } from '../repositories/task-plan-store'

export function getSessionTaskPlans(
  sessionId: string,
  messages: Array<{ run_marker?: string | null; runMarker?: string | null }>,
  includeLatest = false,
  activeRunId?: string,
) {
  return listTaskPlansForPage(sessionId, messages, includeLatest, activeRunId)
}
