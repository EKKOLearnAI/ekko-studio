import { personError } from '../contracts/person'
import { personDb } from './person-store'
import type { HermesMessageRow, HermesSessionRow } from './session-store'

export const PERSON_TIMELINE_PAGE_LIMIT = 150
export interface PersonTimelineItem { id: string; kind: 'message' | 'flow'; timestamp: number; cursor: string }
interface TimelineRow { id: string; kind: number; at: number; sort_key: string }
interface Cursor { at: number; kind: number; key: string; revision: number }
const cursorFor = (row: TimelineRow, revision: number) => Buffer.from(JSON.stringify({ at: row.at, kind: row.kind, key: row.sort_key, revision })).toString('base64url')

export function personTimelineFlowItem(flow: { id: string; timeline_at?: number | null; updated_at: number }, revision: number): PersonTimelineItem {
  const timestamp = flow.timeline_at ?? flow.updated_at
  return { id:flow.id,kind:'flow',timestamp,cursor:cursorFor({ id:flow.id,kind:1,at:timestamp,sort_key:flow.id },revision) }
}

/** One bounded page of display references. Cards never become model messages. */
export function readPersonTimeline(userId: number, session: HermesSessionRow, before?: string, limit = PERSON_TIMELINE_PAGE_LIMIT) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PERSON_TIMELINE_PAGE_LIMIT) throw personError('Invalid timeline limit')
  let cursor: Cursor | undefined
  if (before) {
    try {
      if (before.length > 512) throw new Error()
      cursor = JSON.parse(Buffer.from(before, 'base64url').toString('utf8'))
      if (!cursor || !Number.isFinite(cursor.at) || ![0, 1].includes(cursor.kind) || typeof cursor.key !== 'string'
        || !cursor.key.length || cursor.key.length > 100 || !Number.isSafeInteger(cursor.revision)) throw new Error()
    } catch { throw personError('Invalid timeline cursor') }
  }
  const revision = session.history_revision || 0
  const reset = !!cursor && cursor.revision !== revision
  if (reset) cursor = undefined
  const db = personDb()
  const boundary = cursor ? [cursor.at,cursor.kind,cursor.key] : []
  // Bound each indexed source before merging, including on deep history pages.
  const messageRows = db.prepare(`SELECT CAST(id AS TEXT) AS id,0 AS kind,timestamp*1000 AS at,printf('%020d',id) AS sort_key
    FROM messages WHERE session_id=? ${cursor ? "AND (timestamp*1000,0,printf('%020d',id))<(?,?,?)" : ''}
    ORDER BY timestamp*1000 DESC,printf('%020d',id) DESC LIMIT ?`).all(session.id,...boundary,limit+1) as unknown as TimelineRow[]
  const flowRows = db.prepare(`SELECT f.id,1 AS kind,f.timeline_at AS at,f.id AS sort_key FROM person_flows f
    WHERE f.owner_user_id=? AND f.creator_session_id=? AND f.state IN ('completed','stopped','failed')
      AND f.created_at>=? AND f.timeline_at IS NOT NULL ${cursor ? 'AND (f.timeline_at,1,f.id)<(?,?,?)' : ''}
      AND EXISTS(SELECT 1 FROM person_stages s WHERE s.flow_id=f.id AND s.session_id!=f.creator_session_id)
    ORDER BY f.timeline_at DESC,f.id DESC LIMIT ?`)
    .all(userId,session.id,session.history_cleared_at || 0,...boundary,limit+1) as unknown as TimelineRow[]
  const rows = [...messageRows,...flowRows].sort((a,b)=>b.at-a.at || b.kind-a.kind || (a.sort_key < b.sort_key ? 1 : a.sort_key > b.sort_key ? -1 : 0)).slice(0,limit+1)
  const selected = rows.slice(0,limit)
  const messageIds = selected.filter(row => row.kind === 0).map(row => row.id)
  const flowIds = selected.filter(row => row.kind === 1).map(row => row.id)
  const messages = messageIds.length ? db.prepare(`SELECT * FROM messages WHERE session_id=? AND id IN (${messageIds.map(() => '?').join(',')})`)
    .all(session.id,...messageIds) as unknown as HermesMessageRow[] : []
  const byId = new Map(messages.map(message => [String(message.id),message]))
  // Batch only the fields used by a card; full replies are fetched on opening it.
  const flows = flowIds.length ? db.prepare(`SELECT f.id,f.title,f.state,f.revision,f.creator_session_id,f.created_at,f.updated_at,f.timeline_at,
      f.current_position,f.round_number,f.round_limit,c.title AS creator_session_title,c.bot_type AS creator_bot_type
      FROM person_flows f LEFT JOIN sessions c ON c.id=f.creator_session_id WHERE f.owner_user_id=? AND f.id IN (${flowIds.map(() => '?').join(',')})`)
    .all(userId,...flowIds).map(row => ({ ...row,id:String(row.id),goal:'',error:'',stages:[] as Record<string,unknown>[] })) : []
  if (flowIds.length) {
    const stages = db.prepare(`SELECT s.id,s.flow_id,s.position,s.group_position,s.session_id,s.state,s.result_message_id,c.title AS session_title,c.bot_type
      FROM person_stages s LEFT JOIN sessions c ON c.id=s.session_id WHERE s.flow_id IN (${flowIds.map(() => '?').join(',')}) ORDER BY s.position`).all(...flowIds)
    const grouped = new Map(flows.map(flow => [flow.id,flow.stages]))
    for (const stage of stages) grouped.get(String(stage.flow_id))?.push({ ...stage,goal:'',tasks:[] })
  }
  const hasMore = rows.length > limit
  return {
    messages:selected.slice().reverse().filter(row => row.kind === 0).map(row => byId.get(row.id)!),cards:flows,
    timeline:{ items:selected.slice().reverse().map(row => ({ id:row.id,kind:row.kind === 0 ? 'message' : 'flow',timestamp:row.at,cursor:cursorFor(row,revision) } as PersonTimelineItem)),
      before:hasMore && selected.length ? cursorFor(selected.at(-1)!,revision) : null,has_more:hasMore,history_revision:revision,reset },
  }
}
