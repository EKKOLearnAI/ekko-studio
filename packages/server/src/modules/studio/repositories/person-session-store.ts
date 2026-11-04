import { personError } from '../contracts/person'
import { ownsPersonSession } from '../contracts/person-session'
import { getSession } from './session-store'
import { personDb } from './person-store'
import { personBotNameKey } from '../../../../../shared/person-bots'

const deleting = new Set<string>()

export function assertPersonBotNameAvailable(userId: number, name: string) {
  const key = personBotNameKey(name)
  const names = personDb().prepare("SELECT title FROM sessions WHERE CAST(studio_user_id AS TEXT)=? AND id LIKE 'person-main-%'").all(String(userId))
  if (names.some(row => personBotNameKey(String(row.title || '')) === key)) {
    throw Object.assign(personError('A BOT with this name already exists', 409), { code: 'PERSON_BOT_NAME_EXISTS' })
  }
}

export function requirePersonSession(userId: number, sessionId: string) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw personError('Person conversation is required')
  const session = getSession(sessionId)
  if (!ownsPersonSession(userId, session)) throw personError('Person conversation not found', 404)
  if (deleting.has(sessionId)) throw personError('Person conversation is being deleted', 409)
  return session!
}

export function listPersonSessions(userId: number, search = '', offset = 0, limit = 50) {
  return personDb().prepare(`SELECT s.*, hit.id AS matched_message_id,
    substr(hit.content,max(1,instr(lower(hit.content),lower(?))-80),240) AS snippet
    FROM sessions s LEFT JOIN messages hit ON hit.id=(SELECT m.id FROM messages m
      WHERE m.session_id=s.id AND ?!='' AND instr(lower(m.content),lower(?))>0 ORDER BY m.id DESC LIMIT 1)
    WHERE CAST(s.studio_user_id AS TEXT)=? AND s.id LIKE 'person-main-%'
      AND (?='' OR instr(lower(s.title),lower(?))>0 OR hit.id IS NOT NULL)
    ORDER BY s.last_active DESC,s.id LIMIT ? OFFSET ?`)
    .all(search, search, search, String(userId), search, search, Math.min(100, Math.max(1, limit)), Math.max(0, offset))
    .filter(session => !deleting.has(String(session.id))) as unknown as Array<NonNullable<ReturnType<typeof getSession>> & { matched_message_id: number | null; snippet: string | null }>

}

export function beginPersonSessionDeletion(userId: number, sessionId: string) {
  requirePersonSession(userId, sessionId)
  deleting.add(sessionId)
  return () => deleting.delete(sessionId)
}

export function personSessionIds(userId: number): string[] {
  return personDb().prepare("SELECT id FROM sessions WHERE CAST(studio_user_id AS TEXT)=? AND id LIKE 'person-main-%'").all(String(userId)).map(row => String(row.id))
}

/** Full prompt directory, independent of search pagination and message history. */
export function personSessionDirectory(userId: number) {
  return personDb().prepare("SELECT id,title FROM sessions WHERE CAST(studio_user_id AS TEXT)=? AND id LIKE 'person-main-%' ORDER BY id")
    .all(String(userId)).filter(row => !deleting.has(String(row.id))) as Array<{ id: string; title: string | null }>
}
