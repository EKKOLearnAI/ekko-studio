import { expect,it } from 'vitest'
import { applyPersonTimelinePage,applyPersonFlowUpdate,preservePersonTimelineWindow } from '../../packages/client/src/utils/person-timeline'
import type { PersonFlow,PersonFlowSnapshot,PersonTimelineItem } from '../../packages/client/src/api/person'
import type { Message,Session } from '../../packages/client/src/stores/hermes/chat'

const flow=(index:number):PersonFlow=>({id:`flow-${index}`,creator_session_id:'person-main-1',created_at:1,updated_at:index,timeline_at:index,
  title:`Card ${index}`,goal:'',state:'stopped',revision:1,current_position:0,error:'',stages:[]})
function page(start:number,end:number):PersonFlowSnapshot {
  const items:PersonTimelineItem[]=[],cards:PersonFlow[]=[]
  for(let index=start;index<end;index++) {
    const card=index%2===0
    items.push({id:card?flow(index).id:String(index),kind:card?'flow':'message',timestamp:index,cursor:`cursor-${index}`})
    if(card) cards.push(flow(index))
  }
  return {flows:[],active_flows:[],active_flow_count:0,history_cleared_at:0,cards,
    timeline:{items,before:start?`cursor-${start}`:null,has_more:start>0,history_revision:0}}
}
const messages=(snapshot:PersonFlowSnapshot):Message[]=>snapshot.timeline!.items.filter(item=>item.kind==='message')
  .map(item=>({id:item.id,role:'assistant',content:'Reply',timestamp:item.timestamp}))
const session=()=>({id:'person-main-1',messages:[]} as unknown as Session)

it('keeps a bounded combined window while loading backwards beyond 300 items, including card-only pages',()=>{
  const target=session()
  for(const [start,end] of [[300,450],[150,300],[0,150]]) {
    const incoming=page(start,end)
    applyPersonTimelinePage(target,incoming,messages(incoming),start!==300)
    expect(target.personFlows!.timeline!.items.length).toBeLessThanOrEqual(300)
  }
  expect(target.personFlows!.timeline!.items[0].id).toBe('flow-0')
  expect(target.personFlows!.timeline!.items.at(-1)!.id).toBe('299')
  expect(target.personFlows!.timeline).toMatchObject({before:null,has_more:false,has_newer:true})
  expect(target.personFlows!.cards!.length+target.messages.length).toBe(300)
  const latest=page(300,450)
  expect(preservePersonTimelineWindow(target,latest)).toBe(true)
  expect(target.personFlows!.timeline!.items[0].id).toBe('flow-0')
  applyPersonTimelinePage(target,latest,messages(latest))
  expect(target.personFlows!.timeline!.has_newer).toBe(false)
  expect(target.personFlows!.timeline!.items).toHaveLength(150)
})

it('merges recent pushes without dropping older cards, and removes a card when that collaboration resumes',()=>{
  const target=session(),latest=page(150,300),older=page(0,150)
  applyPersonTimelinePage(target,latest,messages(latest))
  applyPersonTimelinePage(target,older,messages(older),true)
  const existing=target.personFlows!.cards!.find(item=>item.id==='flow-0')!
  const incoming:PersonFlowSnapshot={flows:[flow(298)],active_flows:[],active_flow_count:0,history_cleared_at:0}
  applyPersonFlowUpdate(target,incoming)
  expect(target.personFlows!.cards).toContainEqual(existing)
  applyPersonFlowUpdate(target,{...incoming,flows:[{...existing,state:'active',revision:2}]})
  expect(target.personFlows!.cards!.some(item=>item.id===existing.id)).toBe(false)
  expect(target.personFlows!.timeline!.items.some(item=>item.id===existing.id)).toBe(false)
})

it('adds pushed cards only within the current window and preserves a usable cursor when evicting old rows',()=>{
  const target=session(),latest=page(150,300),older=page(0,150)
  applyPersonTimelinePage(target,latest,messages(latest))
  applyPersonTimelinePage(target,older,messages(older),true)
  const incoming:PersonFlowSnapshot={flows:[flow(450)],card_updates:[{id:'flow-450',kind:'flow',timestamp:450,cursor:'cursor-450'}],active_flows:[],active_flow_count:0,history_cleared_at:0}
  applyPersonFlowUpdate(target,incoming)
  expect(target.personFlows!.timeline!.items).toHaveLength(300)
  expect(target.personFlows!.timeline).toMatchObject({before:'cursor-1',has_more:true})
  target.personFlows!.timeline!.has_newer=true
  applyPersonFlowUpdate(target,{...incoming,flows:[flow(452)],card_updates:[{id:'flow-452',kind:'flow',timestamp:452,cursor:'cursor-452'}]})
  expect(target.personFlows!.cards!.some(item=>item.id==='flow-452')).toBe(false)
})

it('does not resurrect cleared cards or a newer pushed revision when an older page arrives',()=>{
  const target=session(),latest=page(150,300)
  applyPersonTimelinePage(target,latest,messages(latest))
  const updated={...flow(150),state:'active' as const,revision:2}
  applyPersonFlowUpdate(target,{flows:[updated],active_flows:[],active_flow_count:0,history_cleared_at:0})
  const older=page(0,151)
  applyPersonTimelinePage(target,older,messages(older),true)
  // The latest pushed revision must win even if its card has already been removed.
  expect(target.personFlows!.cards!.some(item=>item.id==='flow-150')).toBe(false)
  expect(target.personFlows!.timeline!.items.some(item=>item.id==='flow-150')).toBe(false)
  applyPersonFlowUpdate(target,{flows:[],active_flows:[],active_flow_count:0,history_cleared_at:1000})
  expect(target.personFlows!.cards).toEqual([])
  expect(target.personFlows!.timeline!.items).toEqual([])
  expect(target.messages).toEqual([])
})

it('bounds live replies as well as history and keeps task plans attached to retained turns',()=>{
  const target=session(),latest=page(150,300),older=page(0,150)
  const plan:Message={id:'task-plan:fixture',role:'system',content:'',timestamp:200,taskPlan:{session_id:target.id,run_id:'run',plan_id:'fixture',revision:1,execution_state:'ended',created_at:200,updated_at:201,plan:[{id:'step',step:'Check',status:'completed'}]}}
  applyPersonTimelinePage(target,latest,[...messages(latest),plan])
  expect(target.messages).toContainEqual(plan)
  applyPersonTimelinePage(target,older,messages(older),true)
  target.messages.push(...Array.from({length:180},(_,index):Message=>({id:`live-${index}`,role:'assistant',content:'Live reply',timestamp:500+index})))
  const needsRefresh=applyPersonFlowUpdate(target,{flows:[],active_flows:[],active_flow_count:0,history_cleared_at:0})
  expect(needsRefresh).toBe(true)
  expect(target.personFlows!.timeline!.items.length+target.messages.filter(message=>message.id.startsWith('live-')).length).toBe(300)
  expect(target.messages.filter(message=>!message.taskPlan).length+target.personFlows!.cards!.length).toBeLessThanOrEqual(300)
  expect(target.personFlows!.timeline!.before).toBe('cursor-150')
})
