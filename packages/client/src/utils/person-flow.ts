import type { PersonFlow } from '@/api/person'

export type PersonFlowStage = PersonFlow['stages'][number]
export type PersonFlowStatus = 'completed' | 'active' | 'running' | 'queued' | 'waiting_dependencies' | 'waiting_user' | 'waiting_person' | 'waiting_approval' | 'waiting_reply' | 'interrupted' | 'blocked'

export function personFlowGroups(flow: PersonFlow) {
  const groups = new Map<number, PersonFlowStage[]>()
  flow.stages.forEach((stage,index) => {
    const position = stage.group_position ?? stage.position ?? index
    if (!groups.has(position)) groups.set(position,[])
    groups.get(position)!.push(stage)
  })
  return [...groups].map(([position,stages]) => ({ position,stages,completed:stages.filter(stage => stage.state === 'completed').length }))
}

export function personFlowStageStatus(flow: PersonFlow, stage: PersonFlowStage): PersonFlowStatus {
  if (stage.state === 'completed') return 'completed'
  if (stage.state === 'pending') return 'waiting_dependencies'
  if (flow.state === 'stopped') return 'interrupted'
  if (stage.state === 'failed' || stage.delivery_error) return 'blocked'
  const tasks = stage.tasks.filter(task => task.status !== 'closed')
  for (const state of ['waiting_user','waiting_approval','waiting_person'] as const) {
    if (tasks.some(task => task.execution_state === state)) return state
  }
  if (tasks.some(task => ['starting','running','stopping'].includes(task.execution_state || ''))) return 'running'
  if (tasks.some(task => task.status === 'open' && ['failed','interrupted'].includes(task.execution_state || ''))) return 'blocked'
  if (tasks.some(task => ['pending','queued'].includes(task.execution_state || '')) || stage.delivery_state === 'pending') return 'queued'
  if (stage.delivery_state === 'delivered') return 'waiting_reply'
  return 'active'
}

export function personFlowDependencies(flow: PersonFlow, stage: PersonFlowStage) {
  const groups = personFlowGroups(flow)
  const index = groups.findIndex(group => group.stages.some(item => item.id === stage.id))
  return index > 0 ? groups[index-1].stages.filter(item => item.state !== 'completed') : []
}

export function personFlowState(flow: PersonFlow): PersonFlowStatus {
  if (flow.state === 'completed') return 'completed'
  if (flow.state === 'stopped') return 'interrupted'
  if (flow.state === 'failed') return 'blocked'
  const current = personFlowGroups(flow).find(group => group.position === flow.current_position)
  if (flow.error || current?.stages.some(stage => personFlowStageStatus(flow,stage) === 'blocked')) return 'blocked'
  if (current?.stages.some(stage => ['waiting_user','waiting_approval'].includes(personFlowStageStatus(flow,stage)))) return 'waiting_user'
  return 'active'
}

export function personFlowStatusKey(status: PersonFlowStatus) {
  return ({ active:'person.flowInProgress',waiting_dependencies:'person.flowWaitingDependencies',waiting_reply:'person.flowWaitingReply',blocked:'person.flowBlocked' })[status as 'active' | 'waiting_dependencies' | 'waiting_reply' | 'blocked'] || `person.states.${status}`
}
