import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { initPersonContextTables } from '../../packages/server/src/modules/studio/infrastructure/database/person-context-schema'
import { openPersonContextStore } from '../../packages/server/src/modules/studio/repositories/person-context-store'

let db: DatabaseSync
function add(session: string, content: string, role = 'user', finish = 'stop') {
  return Number(db.prepare('INSERT INTO messages(session_id,role,content,timestamp,finish_reason) VALUES(?,?,?,1,?)').run(session,role,content,finish).lastInsertRowid)
}
function open(user = 1) { return openPersonContextStore(user, `person-main-${user}`, db) }
beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,studio_user_id TEXT,history_revision INTEGER DEFAULT 0);
    CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,timestamp INTEGER,finish_reason TEXT);
    CREATE INDEX idx_messages_session_id ON messages(session_id);
    INSERT INTO sessions VALUES('person-main-1','1',0),('person-main-2','2',0),('ordinary','1',0);`)
  initPersonContextTables(db)
})
afterEach(() => db.close())

describe('Person derived context store', () => {
  it('adds only Person objects and never changes shared schema or original records', () => {
    add('ordinary','Original ordinary chat'); add('person-main-1','Original Person chat')
    const snapshot = () => JSON.stringify({ schema: db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'person_context_%' AND name NOT LIKE 'sqlite_autoindex_person_context_%' ORDER BY name").all(),
      sessions: db.prepare('SELECT * FROM sessions').all(), messages: db.prepare('SELECT * FROM messages').all() })
    const before = snapshot()
    initPersonContextTables(db); initPersonContextTables(db)
    const store = open(); store.sync(); store.search('Original'); store.summaries.set('k','summary'); store.summaries.get('k')
    expect(snapshot()).toBe(before)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('sessions','messages')").all()).toEqual([])
    expect(() => openPersonContextStore(1,'ordinary',db)).toThrow('not found')
  })
  it('isolates accounts, refuses foreign IDs and holds a fixed history boundary', () => {
    const own = add('person-main-1','report ALPHA')
    const foreign = add('person-main-2','report PRIVATE')
    add('ordinary','report ORDINARY')
    open(2).sync()
    const store = open()
    const future = add('person-main-1','report FUTURE')
    expect(store.search('report').evidence.map(e => e.id)).toEqual([own])
    expect(store.read(foreign)).toBeUndefined(); expect(store.read(future)).toBeUndefined()
    expect(() => openPersonContextStore(2,'person-main-1',db)).toThrow('not found')
  })
  it('indexes Chinese and the middle/tail of long Unicode originals with exact pagination', () => {
    const id = add('person-main-1','😀'.repeat(2000) + '验收凭证 DEEP-Z918 ' + '甲'.repeat(2100) + '撤回许可')
    const store = open()
    expect(store.search('验收凭证').evidence[0]).toMatchObject({id, offset:1936})
    expect(store.search('撤回许可').evidence[0].content).toContain('撤回许可')
    const parts: string[] = []; let offset: number | null = 0
    do { const page = store.read(id,offset)!; parts.push(page.content); offset=page.next_offset } while(offset !== null)
    expect(parts.join('')).toBe(db.prepare('SELECT content FROM messages WHERE id=?').get(id)!.content)
  })
  it('does not advance past unfinished streaming records', () => {
    const id=add('person-main-1','unfinished','assistant','streaming')
    add('person-main-1','later evidence')
    expect(open().sync()).toMatchObject({ complete: false, blocked: true })
    db.prepare("UPDATE messages SET content='final evidence',finish_reason='stop' WHERE id=?").run(id)
    const found=open().search('evidence')
    expect(found.coverage.complete).toBe(true)
    expect(found.evidence).toHaveLength(2)
  })
  it('finds identifiers crossing an index chunk boundary', () => {
    const id=add('person-main-1','x '.repeat(997)+'REFERENCE-Z918')
    expect(open().search('REFERENCE-Z918').evidence.some(e=>e.id===id && e.content.includes('REFERENCE-Z918'))).toBe(true)
  })
  it('can retrieve a thirteenth evidence record instead of silently stopping at top six', () => {
    const ids=Array.from({length:13},(_,i)=>add('person-main-1',`evidence reference ${i}`))
    const store=open(), found:number[]=[]
    let offset:number|null=0
    do { const page=store.search('evidence',offset); found.push(...page.evidence.map(e=>e.id)); offset=page.next_offset } while(offset!==null)
    expect([...new Set(found)].sort((a,b)=>a-b)).toEqual(ids)
    expect(()=>store.search('evidence',10001)).toThrow('Narrow the Person search')
  })
  it('bounds first-read work and resumes indexing rather than treating incomplete recall as absence', () => {
    db.exec('BEGIN')
    for(let i=0;i<2000;i++) add('person-main-1',`project ${i} ${i===1999?'needle':''}`)
    db.exec('COMMIT')
    const first=open().search('needle')
    expect(first.coverage.complete).toBe(false); expect(first.evidence).toEqual([])
    expect(Number(db.prepare('SELECT COUNT(*) AS n FROM person_context_chunks').get()!.n)).toBeLessThanOrEqual(64)
    let iterations=0
    while(!open().sync().complete) { if(++iterations>35) throw new Error('backfill failed to resume') }
    expect(open().search('needle').evidence[0].content).toContain('1999')
  })
  it('fences in-flight reads and summaries after deletion and rebuilds only derived data', () => {
    const id=add('person-main-1','permission granted')
    const store=open(); store.sync(); store.summaries.set('k','permission granted')
    db.prepare('DELETE FROM messages WHERE id=?').run(id)
    db.exec("UPDATE sessions SET history_revision=history_revision+1 WHERE id='person-main-1'")
    expect(()=>store.read(id)).toThrow('history changed')
    expect(()=>store.summaries.set('late','permission granted')).toThrow('history changed')
    const fresh=open()
    expect(fresh.summaries.get('k')).toBeUndefined()
    expect(fresh.search('permission').evidence).toEqual([])
    expect(db.prepare('SELECT * FROM person_context_chunks').all()).toEqual([])
  })
  it('rejects stale out-of-band edits and never follows derived deletion into original tables', () => {
    const id=add('person-main-1','permission granted')
    const store=open(); store.sync()
    db.prepare("UPDATE messages SET content='permission revoked' WHERE id=?").run(id)
    expect(store.search('granted').evidence).toEqual([])
    db.exec('DELETE FROM person_context_chunks; DELETE FROM person_context_progress; DELETE FROM person_context_summaries')
    expect(store.read(id)!.content).toBe('permission revoked')
  })
  it('keeps summary cache bounded, reusable and invalid when the session disappears', () => {
    const store=open(); store.sync()
    for(let i=0;i<80;i++) store.summaries.set(`key${i}`,`summary${i}`)
    expect(Number(db.prepare('SELECT COUNT(*) AS n FROM person_context_summaries').get()!.n)).toBe(64)
    expect(open().summaries.get('key79')).toBe('summary79')
    db.exec("DELETE FROM sessions WHERE id='person-main-1'")
    expect(()=>store.summaries.get('key79')).toThrow('history changed')
  })
  it('keeps reads bounded at one hundred thousand messages and finds old evidence', () => {
    const started=performance.now()
    const insert=db.prepare("INSERT INTO messages(session_id,role,content,timestamp,finish_reason) VALUES('person-main-1','user',?,1,'stop')")
    db.exec('BEGIN')
    for(let i=0;i<100000;i++) insert.run(`project record ${i} ${i===127?'unique_receipt_z918':'ordinary detail'}`)
    db.exec('COMMIT')
    const store=open()
    let batches=1
    while(!store.sync().complete) { if(++batches>1600) throw new Error('Indexing did not converge') }
    const indexedMs=performance.now()-started
    const elapsed:number[]=[]
    for(let i=0;i<20;i++) {
      const begin=performance.now()
      const found=store.search(i%2 ? 'unique_receipt_z918' : 'project')
      const recent=store.recent()
      elapsed.push(performance.now()-begin)
      expect(found.coverage.complete).toBe(true)
      expect(found.evidence.length).toBeLessThanOrEqual(6)
      expect(recent.length).toBeLessThanOrEqual(8)
      if(i%2) expect(found.evidence[0].content).toContain('record 127')
    }
    elapsed.sort((a,b)=>a-b)
    console.info(JSON.stringify({person_context_scale:{messages:100000,indexedMs,batches,p95SearchAndRecentMs:elapsed[18],maxEvidence:6,maxRecent:8}}))
  },30000)
})
