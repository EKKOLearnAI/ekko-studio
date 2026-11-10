import { expect,it } from 'vitest'
import { personFlowMessageRows } from '../../packages/client/src/components/hermes/person/person-flow-message-rows'
import type { PersonFlow } from '../../packages/client/src/api/person'
import type { MessageSelectionRow } from '../../packages/client/src/components/hermes/chat/message-selection'
const rows:MessageSelectionRow[]=[100,300].map(timestamp=>({id:`message-${timestamp}`,messages:[{id:`message-${timestamp}`,role:'assistant',content:'原消息',timestamp}]}))
const flow=(id:string,created_at:number):PersonFlow=>({id,created_at,title:id,goal:'协作',state:'completed',revision:1,current_position:0,error:'',stages:[]})
it('inserts one persistent collaboration card in time order without changing or grouping original messages',() => {
  const result=personFlowMessageRows(rows,[flow('middle',200),flow('middle',200),flow('recent',400)],false)
  expect(result.map(row=>row.id)).toEqual(['message-100','person-flow:middle','message-300','person-flow:recent'])
  expect(result[0]).toBe(rows[0])
  expect(result[1].group).toBeUndefined()
  expect(result[1].messages).toEqual([])
  expect(rows).toHaveLength(2)
})
it('leaves older cards outside a partially loaded history window until its messages are loaded',() => {
  const flows=[flow('old',50),flow('current',200)]
  expect(personFlowMessageRows(rows,flows,true).map(row=>row.id)).not.toContain('person-flow:old')
  expect(personFlowMessageRows(rows,flows,false)[0].id).toBe('person-flow:old')
})
it('positions a completed card at its completion time, including flows started before the loaded history window',() => {
  const completed={...flow('finished',50),updated_at:400}
  expect(personFlowMessageRows(rows,[completed],true).map(row=>row.id)).toEqual(['message-100','message-300','person-flow:finished'])
})
