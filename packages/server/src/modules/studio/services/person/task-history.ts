import type { AgentMessage } from '../../../../../../ekko-agent/src/model/types'
import { createPersonContext } from './context'

/** Keep worker prompts useful without replaying an unbounded Bot transcript. */
const TASK_HISTORY_BUDGET = 3_000
const CONTEXT_BUDGET = Math.ceil(TASK_HISTORY_BUDGET / 0.3)

export function loadPersonTaskHistory(userId: number, sessionId: string, query: string): AgentMessage[] {
  const context = createPersonContext(userId, sessionId, CONTEXT_BUDGET, { sessionOnly: true })
  const history = context.loadHistory(query)
  // The history snapshot is read-only evidence. Check the Bot revision again
  // after indexing/search so a concurrent clear cannot silently become a stale
  // worker prompt.
  context.assertCurrent()
  return history
}
