import type { PersonFlow, PersonFlowSnapshot, PersonTimelineItem } from '@/api/person'
import type { Message, Session } from '@/stores/hermes/chat'

export const PERSON_TIMELINE_WINDOW_LIMIT = 300
const key = (item: PersonTimelineItem) => `${item.kind}:${item.id}`
const compare = (a: PersonTimelineItem, b: PersonTimelineItem) => a.timestamp-b.timestamp
  || Number(a.kind === 'flow')-Number(b.kind === 'flow')
  || (a.kind === 'message' ? Number(a.id)-Number(b.id) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
function mergeFlows(current: PersonFlow[], incoming: PersonFlow[]) {
  const byId = new Map(current.map(flow => [flow.id,flow]))
  for (const flow of incoming) {
    if ((byId.get(flow.id)?.revision ?? -1) <= flow.revision) byId.set(flow.id,flow)
  }
  return [...byId.values()]
}

/** Apply messages and their card references atomically, with one bounded window. */
export function applyPersonTimelinePage(target: Session, snapshot: PersonFlowSnapshot | undefined, messages: Message[], older = false): boolean {
  if (!snapshot?.timeline) return false
  const previous = target.personFlows
  const page = snapshot.timeline
  if (previous?.timeline && previous.timeline.history_revision > page.history_revision) return true
  const append = older && !page.reset && previous?.timeline?.history_revision === page.history_revision
  const settled = mergeFlows(append ? [...(previous?.cards || []),...(previous?.flows || [])] : [],snapshot.cards || []).filter(flow => flow.state !== 'active')
  const settledIds = new Set(settled.map(flow => flow.id))
  const all = [...new Map([...(append ? previous!.timeline!.items : []),...page.items].map(item => [key(item),item])).values()]
    .filter(item => item.kind !== 'flow' || settledIds.has(item.id)).sort(compare)
  // Reading backwards discards the distant tail; returning to the tail reloads it.
  const items = all.slice(0,PERSON_TIMELINE_WINDOW_LIMIT)
  const flowIds = new Set(items.filter(item => item.kind === 'flow').map(item => item.id))
  const messageIds = new Set(items.filter(item => item.kind === 'message').map(item => item.id))
  const cards = settled.filter(flow => flowIds.has(flow.id))
  const byId = new Map([...(append ? target.messages : []),...messages].map(message => [message.id,message]))
  const droppedTail = append && target.messages.some(message => !messageIds.has(message.id) && !message.taskPlan && !message.isStreaming)
  const runs = new Set([...byId.values()].filter(message => messageIds.has(message.id)).map(message => message.runMarker).filter(Boolean))
  target.messages = [...byId.values()].filter(message => messageIds.has(message.id) || message.isStreaming
    || message.taskPlan && (runs.has(message.runMarker) || message.timestamp >= (items[0]?.timestamp ?? Infinity) && message.timestamp <= (items.at(-1)?.timestamp ?? -Infinity)))
    .sort((a,b) => a.timestamp-b.timestamp || Number(a.id)-Number(b.id))
  const flows = append ? mergeFlows(snapshot.flows,previous?.flows || []).sort((a,b)=>(b.updated_at || 0)-(a.updated_at || 0)).slice(0,50) : snapshot.flows
  target.personFlows = { ...snapshot,flows,cards,timeline:{ ...page,items,has_newer:append && (!!previous?.timeline?.has_newer || all.length > items.length || droppedTail) } }
  target.loadedMessageCount = items.length
  target.hasMoreBefore = page.has_more
  return true
}

/** A pushed recent snapshot updates matching cards without replacing older pages. */
export function applyPersonFlowUpdate(target: Session, snapshot: PersonFlowSnapshot) {
  const previous = target.personFlows
  if (!previous?.timeline) { target.personFlows=snapshot;return }
  const timeline = previous.timeline
  if (snapshot.history_cleared_at > previous.history_cleared_at) {
    target.personFlows={ ...snapshot,cards:[],timeline:{ ...timeline,items:[],before:null,has_more:false,history_revision:timeline.history_revision+1 } }
    target.messages=[]
    target.hasMoreBefore=false
    return
  }
  const updated = new Map(snapshot.flows.map(flow => [flow.id,flow]))
  const cards = mergeFlows(previous.cards || [],snapshot.flows).filter(flow => flow.creator_session_id === target.id
    && flow.state !== 'active' && (flow.created_at ?? 0) >= snapshot.history_cleared_at)
  let items = timeline.items.filter(item => item.kind !== 'flow' || updated.get(item.id)?.state !== 'active')
  const known = new Set(items.filter(item => item.kind === 'flow').map(item => item.id))
  if (!timeline.has_newer) {
    for (const item of snapshot.card_updates || []) {
      if (!known.has(item.id) && (!timeline.has_more || !items.length || compare(item,items[0]) >= 0)) items.push(item)
    }
  }
  items.sort(compare)
  // Live replies have not joined a paged snapshot yet. Reserve bounded space
  // for them too, and periodically reconcile their persisted identities.
  const tracked = new Set(items.filter(item => item.kind === 'message').map(item => item.id))
  const live = timeline.has_newer ? [] : target.messages.filter(message => !tracked.has(message.id) && !message.taskPlan && !message.isStreaming)
  const retainedLive = live.slice(-150)
  const budget = PERSON_TIMELINE_WINDOW_LIMIT-retainedLive.length
  const trimmed = items.length > budget
  if (trimmed) items = items.slice(-budget)
  const flowIds = new Set(items.filter(item => item.kind === 'flow').map(item => item.id))
  const messageIds = new Set(items.filter(item => item.kind === 'message').map(item => item.id))
  target.personFlows={ ...snapshot,cards:cards.filter(flow => flowIds.has(flow.id)),timeline:{ ...timeline,items,
    before:trimmed ? items[0]?.cursor || null : timeline.before,has_more:timeline.has_more || trimmed } }
  const liveIds = new Set(retainedLive.map(message => message.id))
  target.messages=target.messages.filter(message => messageIds.has(message.id) || liveIds.has(message.id) || message.isStreaming
    || message.taskPlan && message.timestamp >= (items[0]?.timestamp ?? Infinity) && message.timestamp <= (items.at(-1)?.timestamp ?? -Infinity))
  target.loadedMessageCount=items.length
  target.hasMoreBefore=target.personFlows.timeline!.has_more
  return live.length >= 150
}

/** A reconnect must not replace a cached older window with the newest page. */
export function preservePersonTimelineWindow(target: Session, snapshot: PersonFlowSnapshot | undefined): boolean {
  if (!target.personFlows?.timeline?.has_newer || !snapshot?.timeline
    || target.personFlows.timeline.history_revision !== snapshot.timeline.history_revision) return false
  applyPersonFlowUpdate(target,snapshot)
  return true
}
