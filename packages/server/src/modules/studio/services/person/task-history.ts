import type { AgentMessage } from '../../../../../../ekko-agent/src/model/types'
import { personDb } from '../../repositories/person-store'
import { requirePersonSession } from '../../repositories/person-session-store'
import { createPersonContext } from './context'

/** Keep worker prompts useful without replaying an unbounded Bot transcript. */
const TASK_HISTORY_BUDGET = 3_000
const CONTEXT_BUDGET = Math.ceil(TASK_HISTORY_BUDGET / 0.3)

export function loadPersonTaskHistory(userId: number, sessionId: string, query: string): AgentMessage[] {
  requirePersonSession(userId, sessionId)
  const hasHistory = personDb().prepare(`SELECT 1 FROM messages
    WHERE session_id=? AND role IN ('user','assistant')
      AND COALESCE(finish_reason,'')!='streaming' AND content!='' LIMIT 1`).get(sessionId)
  if (!hasHistory) return []
  const context = createPersonContext(userId, sessionId, CONTEXT_BUDGET, { sessionOnly: true })
  const history = context.loadHistory(query)
  // The history snapshot is read-only evidence. Check the Bot revision again
  // after indexing/search so a concurrent clear cannot silently become a stale
  // worker prompt.
  context.assertCurrent()
  return history
}
