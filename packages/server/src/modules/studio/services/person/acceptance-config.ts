import { personDb } from '../../repositories/person-store'
import type { PersonAcceptanceConfig } from '../../contracts/person-acceptance'
import { personError, personText } from '../../contracts/person'
import { selectPersonExecutionAgent } from './agents'
import { requirePersonSession } from '../../repositories/person-session-store'

export async function parsePersonAcceptance(userId: number, value: unknown, initialGoal: string): Promise<PersonAcceptanceConfig | undefined> {
  if (value === undefined) return
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw personError('Invalid acceptance configuration')
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).some(key => !['enabled','criteria','verifier_agent_id','reviewer_session_id','max_attempts','timeout_minutes'].includes(key)) || typeof raw.enabled !== 'boolean') throw personError('Invalid acceptance configuration')
  if (!raw.enabled) return
  if (!Array.isArray(raw.criteria) || !raw.criteria.length || raw.criteria.length > 20) throw personError('Acceptance requires 1–20 explicit criteria')
  const criteria = raw.criteria.map((text, i) => ({ id: `c${i+1}`, text: personText(text,'acceptance criterion',2000) }))
  const verifier_agent_id = personText(raw.verifier_agent_id,'verifier_agent_id',100)
  const reviewer_session_id=raw.reviewer_session_id===undefined?undefined:requirePersonSession(userId,personText(raw.reviewer_session_id,'reviewer_session_id',100)).id
  const max_attempts = raw.max_attempts ?? 3, timeout_minutes = raw.timeout_minutes ?? 30
  if (!Number.isSafeInteger(max_attempts) || Number(max_attempts) < 1 || Number(max_attempts) > 5) throw personError('Acceptance max_attempts must be 1–5')
  if (!Number.isSafeInteger(timeout_minutes) || Number(timeout_minutes) < 1 || Number(timeout_minutes) > 120) throw personError('Acceptance timeout_minutes must be 1–120')
  return { enabled: true, orchestration: 'bot_tasks', progression: 'automatic', initial_goal: initialGoal, criteria, verifier_agent_id,reviewer_session_id,
    verifier_selection: await selectPersonExecutionAgent(userId, verifier_agent_id), max_attempts: Number(max_attempts), timeout_minutes: Number(timeout_minutes) }
}

/** Host-owned transcript anchor; never accept an agent-supplied claim of the original user request. */
export function initialPersonAcceptanceRequest(sessionId: string) {
  const message = personDb().prepare("SELECT id,content FROM messages WHERE session_id=? AND role='user' AND COALESCE(display_role,role)='user' AND content NOT LIKE '/%' ORDER BY id DESC LIMIT 1").get(sessionId)
  if (!message) return undefined // Account API-created tasks may have no preceding chat request; goal remains authoritative.
  const content = String(message.content || '')
  if (content.length > 200_000) throw personError('Original request exceeds the acceptance snapshot limit; consolidate it explicitly before enabling acceptance')
  return { session_id: sessionId, message_id: Number(message.id), content }
}
