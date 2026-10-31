import { describe, expect, it } from 'vitest'
import type { PersonFlow } from '../../packages/client/src/api/person'
import { personFlowAnimation, personFlowDependencies, personFlowGroups, personFlowStageStatus, personFlowState, personFlowVisibleInActivity } from '../../packages/client/src/utils/person-flow'

function flow(): PersonFlow {
  return { id:'flow',title:'Research',goal:'Research and summarize',revision:0,state:'active',current_position:0,error:'',stages:[
    { id:'a',position:0,group_position:0,session_id:'a',session_title:'A',goal:'Competitors',state:'completed',result_message_id:1,tasks:[] },
    { id:'b',position:1,group_position:0,session_id:'b',session_title:'B',goal:'Needs',state:'active',result_message_id:null,tasks:[] },
    { id:'c',position:2,group_position:1,session_id:'c',session_title:'C',goal:'Summary',state:'pending',result_message_id:null,tasks:[] },
  ] }
}

describe('role collaboration display',() => {
  it('shows only the creator’s healthy activity and hides unresolved collaboration errors', () => {
    const current = { ...flow(), creator_session_id: 'creator' }
    expect(personFlowVisibleInActivity(current,'creator')).toBe(true)
    expect(personFlowVisibleInActivity(current,'b')).toBe(false)
    expect(personFlowVisibleInActivity(current,'')).toBe(false)
    expect(personFlowVisibleInActivity({...current,creator_session_id:undefined},'creator')).toBe(false)
    for (const state of ['failed','stopped','completed'] as const) expect(personFlowVisibleInActivity({...current,state},'creator')).toBe(false)
    current.error='Provider unavailable'
    expect(personFlowVisibleInActivity(current,'creator')).toBe(false)
    current.error='';current.stages[1].state='failed'
    expect(personFlowVisibleInActivity(current,'creator')).toBe(false)
    current.stages[1].state='active';current.stages[1].delivery_error='Delivery failed'
    expect(personFlowVisibleInActivity(current,'creator')).toBe(false)
    current.stages[1].delivery_error=''
    for (const execution_state of ['failed','interrupted']) {
      current.stages[1].tasks=[{id:'worker',title:'Research',status:'open',execution_state}]
      expect(personFlowVisibleInActivity(current,'creator')).toBe(false)
    }
    current.stages[1].tasks[0].execution_state='running'
    expect(personFlowVisibleInActivity(current,'creator')).toBe(true)
    current.stages[1].tasks[0].execution_state='failed';current.stages[1].tasks[0].status='closed'
    expect(personFlowVisibleInActivity(current,'creator')).toBe(true)
  })
  it('uses the four avatar states without presenting waits as running work', () => {
    expect(personFlowAnimation('completed')).toBe('done')
    expect(personFlowAnimation('blocked')).toBe('error')
    for (const status of ['active','running'] as const) expect(personFlowAnimation(status)).toBe('searching')
    for (const status of ['queued','waiting_dependencies','waiting_user','waiting_approval','waiting_person','waiting_reply','interrupted'] as const)
      expect(personFlowAnimation(status)).toBe('sleeping')
  })
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
