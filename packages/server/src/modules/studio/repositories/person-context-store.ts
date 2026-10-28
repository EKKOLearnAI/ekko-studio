import type { DatabaseSync } from 'node:sqlite'
import { personDb } from './person-store'
import { ownsPersonSession } from '../contracts/person-session'
import { personError } from '../contracts/person'

const CHUNK_CHARS = 2000
const INDEX_CHUNKS_PER_READ = 64
type Progress = { history_revision: number; message_id: number; source_offset: number }
export interface PersonContextEvidence {
  id: number; role: string; content: string; created_at: number
  offset: number; next_offset: number | null; source_length: number
}

/** Bound the query before segmentation; Chinese bigrams also work without spaces. */
export function personSearchTerms(text: string): string[] {
  const terms = text.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) || []
  return [...new Set(terms.flatMap(term => {
    if (!/\p{Script=Han}/u.test(term)) return [term]
    const chars = Array.from(term)
    return chars.length === 1 ? chars : chars.slice(0, -1).map((char, i) => char + chars[i + 1])
  }))]
}

export function openPersonContextStore(userId: number, sessionId: string, db: DatabaseSync = personDb()) {
  const session = () => db.prepare('SELECT id,studio_user_id,history_revision FROM sessions WHERE id=?').get(sessionId) as
    { id: string; studio_user_id: string; history_revision: number } | undefined
  const original = session()
  if (!ownsPersonSession(userId, original)) throw personError('Person session not found', 404)
  const revision = original!.history_revision
  const throughId = Number(db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM messages WHERE session_id=?').get(sessionId)!.id)
  const scope = `person${userId}`
  function assertCurrent() {
    const current = session()
    if (!ownsPersonSession(userId, current) || current!.history_revision !== revision) throw personError('Person history changed; retry the turn', 409)
  }
  function resetIfChanged(): Progress {
    assertCurrent()
    let progress = db.prepare('SELECT * FROM person_context_progress WHERE session_id=?').get(sessionId) as Progress | undefined
    if (!progress || progress.history_revision !== revision) {
      db.exec('SAVEPOINT person_context_reset')
      try {
        db.prepare('DELETE FROM person_context_chunks WHERE session_id=?').run(sessionId)
        db.prepare('DELETE FROM person_context_summaries WHERE session_id=?').run(sessionId)
        db.prepare(`INSERT OR REPLACE INTO person_context_progress VALUES (?,?,?,0,0)`).run(sessionId, userId, revision)
        db.exec('RELEASE person_context_reset')
      } catch (error) { db.exec('ROLLBACK TO person_context_reset'); db.exec('RELEASE person_context_reset'); throw error }
      progress = { history_revision: revision, message_id: 0, source_offset: 0 }
    }
    return progress
  }
  function sync() {
    const progress = resetIfChanged()
    let id = progress.message_id, offset = progress.source_offset
    let blocked = false
    db.exec('SAVEPOINT person_context_index')
    try {
      // A large existing history is indexed incrementally, including long-message tails.
      // LIMIT is on source work, not just the number of final search hits.
      for (let i = 0; i < INDEX_CHUNKS_PER_READ; i++) {
        const row = db.prepare(`SELECT id,role,finish_reason,length(content) AS size,
          substr(content,?,?) AS content FROM messages WHERE session_id=? AND id ${offset ? '>=' : '>'} ? AND id<=? ORDER BY id LIMIT 1`)
          .get(offset + 1, CHUNK_CHARS, sessionId, id, throughId) as
          { id: number; role: string; finish_reason: string; size: number; content: string } | undefined
        if (!row) { id = throughId; offset = 0; break }
        if (row.finish_reason === 'streaming') { blocked = true; break }
        const start = row.id === id ? offset : 0
        // Offsets are SQLite Unicode character offsets, not UTF-16 byte positions.
        const content = start === offset ? row.content : String(db.prepare('SELECT substr(content,1,?) AS content FROM messages WHERE id=?').get(CHUNK_CHARS, row.id)!.content)
        if (['user','assistant'].includes(row.role) && content) {
          db.prepare('INSERT OR IGNORE INTO person_context_chunks(session_id,scope,message_id,source_offset,content,terms) VALUES(?,?,?,?,?,?)')
            .run(sessionId, scope, row.id, start, content, personSearchTerms(content).join(' '))
        }
        id = row.id
        offset = ['user','assistant'].includes(row.role) && start + CHUNK_CHARS < row.size ? start + CHUNK_CHARS - 64 : 0
      }
      db.prepare('UPDATE person_context_progress SET message_id=?,source_offset=? WHERE session_id=?').run(id, offset, sessionId)
      db.exec('RELEASE person_context_index')
    } catch (error) { db.exec('ROLLBACK TO person_context_index'); db.exec('RELEASE person_context_index'); throw error }
    return { through_message_id: throughId, indexed_through: id, complete: id >= throughId && offset === 0, blocked }
  }
  function read(messageId: number, offset = 0): PersonContextEvidence | undefined {
    assertCurrent()
    offset = Math.max(0, Math.floor(offset))
    const row = db.prepare(`SELECT id,role,substr(content,?,?) AS content,length(content) AS source_length,timestamp*1000 AS created_at
      FROM messages WHERE session_id=? AND id=? AND id<=? AND role IN ('user','assistant') AND COALESCE(finish_reason,'')!='streaming'`)
      .get(offset + 1, CHUNK_CHARS, sessionId, messageId, throughId) as Omit<PersonContextEvidence, 'offset' | 'next_offset'> | undefined
    return row ? { ...row, offset, next_offset: offset + CHUNK_CHARS < row.source_length ? offset + CHUNK_CHARS : null } : undefined
  }
  function recent() {
    assertCurrent()
    const ids = db.prepare(`SELECT id FROM messages WHERE session_id=? AND id<=? AND role IN ('user','assistant')
      AND COALESCE(finish_reason,'')!='streaming' AND content!='' ORDER BY id DESC LIMIT 8`).all(sessionId, throughId)
    return ids.map(row => read(Number(row.id))!).reverse()
  }
  function search(query: string, offset = 0) {
    const coverage = sync()
    const terms = personSearchTerms(query.slice(0, 400)).slice(0, 24)
    if (!terms.length) return { evidence: [], coverage, next_offset: null }
    offset = Math.max(0, Math.floor(offset))
    if (offset > 10000) throw personError('Narrow the Person search before requesting more results')
    const match = `scope : "${scope}" AND terms : (${terms.map(term => `"${term.replaceAll('"','""')}"`).join(' OR ')})`
    // FTS must drive the query. A session-index-first join repeats MATCH per history row.
    const candidates = db.prepare(`SELECT c.message_id,c.source_offset,c.content FROM person_context_search
      CROSS JOIN person_context_chunks c ON c.id=person_context_search.rowid
      WHERE person_context_search MATCH ? AND c.session_id=? AND c.message_id<=? ORDER BY rank LIMIT 7 OFFSET ?`)
      .all(match, sessionId, throughId, offset) as Array<{ message_id: number; source_offset: number; content: string }>
    // Verify retrieved data against current originals, including an out-of-band edit.
    const evidence = candidates.slice(0,6).flatMap(candidate => {
      const actual = read(candidate.message_id, candidate.source_offset)
      return actual?.content === candidate.content ? [actual] : []
    })
    return { evidence, coverage, next_offset: candidates.length > 6 ? offset + 6 : null }
  }
  return {
    assertCurrent, sync, recent, read, search, throughId,
    summaries: {
      get(key: string) {
        resetIfChanged()
        return (db.prepare('SELECT summary FROM person_context_summaries WHERE session_id=? AND history_revision=? AND cache_key=?')
          .get(sessionId, revision, key) as { summary: string } | undefined)?.summary
      },
      set(key: string, summary: string) {
        assertCurrent()
        db.prepare('INSERT OR REPLACE INTO person_context_summaries VALUES(?,?,?,?,?)').run(sessionId, revision, key, summary, Date.now())
        db.prepare(`DELETE FROM person_context_summaries WHERE session_id=? AND cache_key NOT IN
          (SELECT cache_key FROM person_context_summaries WHERE session_id=? ORDER BY created_at DESC,rowid DESC LIMIT 64)`).run(sessionId,sessionId)
      },
    },
  }
}
