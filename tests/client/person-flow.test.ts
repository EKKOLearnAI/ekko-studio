import { describe, expect, it } from 'vitest'
import type { PersonFlow } from '../../packages/client/src/api/person'
import { personFlowDependencies, personFlowGroups, personFlowStageStatus, personFlowState } from '../../packages/client/src/utils/person-flow'

function flow(): PersonFlow {
  return { id:'flow',title:'Research',goal:'Research and summarize',revision:0,state:'active',current_position:0,error:'',stages:[
    { id:'a',position:0,group_position:0,session_id:'a',session_title:'A',goal:'Competitors',state:'completed',result_message_id:1,tasks:[] },
    { id:'b',position:1,group_position:0,session_id:'b',session_title:'B',goal:'Needs',state:'active',result_message_id:null,tasks:[] },
    { id:'c',position:2,group_position:1,session_id:'c',session_title:'C',goal:'Summary',state:'pending',result_message_id:null,tasks:[] },
  ] }
}

describe('role collaboration display',() => {
  it('groups parallel roles and counts only saved completions',() => {
    const current = flow()
    expect(personFlowGroups(current).map(group => ({ position:group.position,roles:group.stages.map(stage => stage.id),completed:group.completed }))).toEqual([
      {position:0,roles:['a','b'],completed:1},{position:1,roles:['c'],completed:0},
    ])
    expect(personFlowDependencies(current,current.stages[2]).map(stage => stage.id)).toEqual(['b'])
    expect(personFlowStageStatus(current,current.stages[2])).toBe('waiting_dependencies')
    expect(personFlowDependencies(current,current.stages[1])).toEqual([])
  })

  it('keeps completed branches completed on stop, while preserving future dependency waits',() => {
    const current = flow();current.state='stopped'
    expect(current.stages.map(stage => personFlowStageStatus(current,stage))).toEqual(['completed','interrupted','waiting_dependencies'])
  })

  it.each(['waiting_user','waiting_person','waiting_approval','running','queued'] as const)('shows the worker’s actual %s state',state => {
    const current = flow(), stage = current.stages[1]
    stage.tasks=[{id:'worker',title:'Research',status:'open',execution_state:state}]
    expect(personFlowStageStatus(current,stage)).toBe(state)
  })

  it('shows failures and settled-but-unfinished replies without claiming they are running',() => {
    const current = flow(), stage = current.stages[1]
    stage.delivery_error='Missing source'
    expect(personFlowStageStatus(current,stage)).toBe('blocked')
    stage.delivery_error='';stage.delivery_state='delivered'
    expect(personFlowStageStatus(current,stage)).toBe('waiting_reply')
    stage.tasks=[{id:'worker',title:'Research',status:'open',execution_state:'failed'}]
    expect(personFlowStageStatus(current,stage)).toBe('blocked')
    stage.tasks[0].status='closed'
    expect(personFlowStageStatus(current,stage)).toBe('waiting_reply')
  })

  it('surfaces attention in collapsed rows and respects terminal flow states',() => {
    const current = flow()
    current.stages[1].tasks=[{id:'worker',title:'Research',status:'open',execution_state:'waiting_approval'}]
    expect(personFlowState(current)).toBe('waiting_user')
    current.stages[0].delivery_error='Stale error on a completed role'
    expect(personFlowState(current)).toBe('waiting_user')
    current.stages[1].delivery_error='Cannot deliver'
    expect(personFlowState(current)).toBe('blocked')
    current.state='stopped'
    expect(personFlowState(current)).toBe('interrupted')
    current.state='completed'
    expect(personFlowState(current)).toBe('completed')
  })

  it('removes resolved dependencies and finishes broadcasts without inventing a summary role',() => {
    const current = flow();current.stages[1].state='completed'
    expect(personFlowDependencies(current,current.stages[2])).toEqual([])
    current.stages.pop()
    expect(personFlowGroups(current)).toHaveLength(1)
    expect(personFlowGroups(current)[0].completed).toBe(2)
  })

  it('keeps failed roles blocked and later roles waiting while a parallel peer continues running',() => {
    const current = flow();current.state='failed';current.stages[0].state='failed'
    current.stages[1].tasks=[{id:'worker',title:'Research',status:'open',execution_state:'running'}]
    expect(current.stages.map(stage => personFlowStageStatus(current,stage))).toEqual(['blocked','running','waiting_dependencies'])
    expect(personFlowState(current)).toBe('blocked')
  })
})
