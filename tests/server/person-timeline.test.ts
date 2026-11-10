import { afterEach,beforeEach,expect,it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { acceptanceFixture,type AcceptanceFixture } from './fixtures/person-acceptance'

let f: AcceptanceFixture
let conversation: typeof import('../../packages/server/src/modules/studio/services/person/flow-conversation')
let sessions: typeof import('../../packages/server/src/modules/studio/repositories/session-store')
let flows: typeof import('../../packages/server/src/modules/studio/services/person/stage-flows')
const creator='person-main-1',peer='person-main-peer'
beforeEach(async () => {
  f=await acceptanceFixture()
  conversation=await import('../../packages/server/src/modules/studio/services/person/flow-conversation')
  sessions=await import('../../packages/server/src/modules/studio/repositories/session-store')
  flows=await import('../../packages/server/src/modules/studio/services/person/stage-flows')
  sessions.createSession({id:peer,studio_user_id:1,title:'Peer',source:'builtin_agent',agent:'ekko-agent',agent_preset:'person',workspace:f.workspace})
})
afterEach(async () => {await f.close('person-timeline')})
async function card(timestamp: number) {
  const flow=flows.createPersonFlow(1,{session_id:creator,title:`Card ${timestamp}`,goal:'Private full goal',idempotency_key:randomUUID(),
    stages:[{session_id:peer,goal:'Private stage goal',return_expectation:'Report'}]})
  await flows.controlPersonFlow(1,{action:'stop',flow_id:flow.id,expected_revision:flow.revision,idempotency_key:randomUUID()})
  f.db.prepare('UPDATE person_flows SET timeline_at=? WHERE id=?').run(timestamp,flow.id)
  return flow.id
}
function message(timestamp: number,role='assistant') {
  return String(sessions.addMessage({session_id:creator,role,content:role==='tool'?'Hidden tool':'Reply',timestamp:timestamp/1000}))
}
const page=(before?:string,limit=150) => conversation.personConversationTimeline(1,creator,{before,limit})

it('pages more than fifty cards with messages under one limit without losing old cards',async () => {
  const expected:string[]=[]
  for(let index=0;index<61;index++) {
    expected.push('flow:'+await card(index*2000+1000))
    expected.push('message:'+message(index*2000+1500))
  }
  const seen:string[]=[]
  let before:string|undefined
  do {
    const result=page(before,17)
    expect(result.messages.length+result.personFlows.cards.length).toBeLessThanOrEqual(17)
    seen.unshift(...result.personFlows.timeline.items.map(item=>item.kind+':'+item.id))
    before=result.personFlows.timeline.before || undefined
  } while(before)
  expect(seen).toEqual(expected)
  expect(new Set(seen).size).toBe(122)
  expect(JSON.stringify(page().personFlows.cards)).not.toContain('Private')
  expect(f.runtime.execute).not.toHaveBeenCalled()
})

it('advances through card-only and hidden-message pages even when the visible message list is empty',async () => {
  for(let index=0;index<6;index++) await card(index*1000)
  const first=page(undefined,2)
  expect(first.messages).toHaveLength(0)
  expect(first.personFlows.cards).toHaveLength(2)
  expect(first.personFlows.timeline.has_more).toBe(true)
  message(10000,'tool')
  const hidden=page(undefined,1)
  expect(hidden.personFlows.timeline.items).toHaveLength(1)
  expect(hidden.personFlows.timeline.before).toBeTruthy()
  expect(page(hidden.personFlows.timeline.before!,1).personFlows.cards).toHaveLength(1)
})

it('uses stable tie breakers and card positions while newer rows arrive or settled flow metadata changes',async () => {
  const ids=await Promise.all(Array.from({length:4},()=>card(2000)))
  const messageIds=Array.from({length:4},()=>message(2000))
  const first=page(undefined,3)
  const cursor=first.personFlows.timeline.before!
  f.db.prepare('UPDATE person_flows SET updated_at=?,revision=revision+1 WHERE id=?').run(999999,ids[0])
  expect(f.db.prepare('SELECT timeline_at FROM person_flows WHERE id=?').get(ids[0])!.timeline_at).toBe(2000)
  await card(5000);message(6000)
  const rest=page(cursor,150)
  const seen=[...rest.personFlows.timeline.items,...first.personFlows.timeline.items]
  expect(seen).toHaveLength(8)
  expect(new Set(seen.map(item=>item.kind+item.id)).size).toBe(8)
  expect(seen.filter(item=>item.kind==='message').map(item=>item.id)).toEqual(messageIds)
  expect(seen.filter(item=>item.kind==='flow').map(item=>item.id)).toEqual(ids.sort())
})

it('resets a stale cursor after clearing history and enforces account and input boundaries',async () => {
  await card(1000);message(2000);message(3000)
  const before=page(undefined,1).personFlows.timeline.before!
  const history=await import('../../packages/server/src/modules/studio/repositories/person-history-store')
  history.clearPersonHistory(1,creator,0)
  const fresh=message(Date.now()+1000)
  const result=page(before,10)
  expect(result.personFlows.timeline.reset).toBe(true)
  expect(result.personFlows.timeline.items.map(item=>item.id)).toEqual([fresh])
  expect(result.personFlows.cards).toEqual([])
  expect(()=>conversation.personConversationTimeline(2,creator)).toThrow('Person conversation not found')
  expect(()=>page('invalid')).toThrow('Invalid timeline cursor')
  for(const limit of [0,151,1.5]) expect(()=>page(undefined,limit)).toThrow('Invalid timeline limit')
})

it('keeps the raw offset protocol for released clients and limits a Studio page to 150 combined items',async () => {
  for(let index=0;index<151;index++) message(index*1000)
  await card(500)
  expect(page().personFlows.timeline.items).toHaveLength(150)
  expect(page().hasMoreBefore).toBe(true)
  expect(sessions.getSessionDetailPaginated(creator,150,150)!.messages).toHaveLength(1)
  expect(conversation.personConversationFlows(1,creator)).not.toHaveProperty('timeline')
})

it('conditionally caches App messages, cards and cursor as one projected snapshot',async () => {
  const {buildAppResumeMessagePage}=await import('../../packages/server/src/modules/studio/services/chat-run/resume-payload')
  const {personDisplayPage}=await import('../../packages/server/src/modules/studio/services/chat-run/person-display')
  const id=await card(1000)
  for(let index=0;index<151;index++) message(index*1000+500)
  const snapshot=()=>personDisplayPage(creator,page())
  const first=buildAppResumeMessagePage(snapshot(),'')
  expect(first.personFlows!.timeline.items).toHaveLength(150)
  expect(first.messages!.length+first.personFlows!.cards.length).toBe(150)
  const hit=buildAppResumeMessagePage(snapshot(),first.id)
  expect(hit).toMatchObject({id:first.id,messagesCached:true,hasMoreBefore:true})
  expect(hit).not.toHaveProperty('messages')
  expect(hit).not.toHaveProperty('personFlows')
  f.db.prepare('UPDATE person_flows SET title=?,revision=revision+1 WHERE id=?').run('Changed card',id)
  const changed=buildAppResumeMessagePage(snapshot(),first.id)
  expect(changed.id).not.toBe(first.id)
  expect(changed.messagesCached).toBe(false)
  expect(changed.personFlows!.flows.find(flow=>flow.id===id)!.title).toBe('Changed card')
})

it('invalidates App conditional snapshots when history is cleared, including card-only pages',async () => {
  const {buildAppResumeMessagePage}=await import('../../packages/server/src/modules/studio/services/chat-run/resume-payload')
  await card(1000)
  const first=buildAppResumeMessagePage(page(),'')
  expect(first.messages).toEqual([])
  expect(first.personFlows!.cards).toHaveLength(1)
  const history=await import('../../packages/server/src/modules/studio/repositories/person-history-store')
  history.clearPersonHistory(1,creator,0)
  const fresh=buildAppResumeMessagePage(page(),first.id)
  expect(fresh.messagesCached).toBe(false)
  expect(fresh.personFlows!.timeline.history_revision).toBe(1)
  expect(fresh.personFlows!.cards).toEqual([])
})
