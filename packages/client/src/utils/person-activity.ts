import type { PersonFlow, PersonTask } from '@/api/person'
export const attentionStates = new Set(['waiting_user', 'waiting_approval', 'waiting_person', 'failed', 'interrupted'])
export function activityTasks(tasks: PersonTask[]) {
  return tasks.filter(task => task.status !== 'closed' && task.status !== 'completed' &&
    (Boolean(task.running) || ['starting', 'running', 'stopping', 'queued', 'pending', ...attentionStates].includes(task.execution_state)))
    .sort((a, b) => Number(attentionStates.has(b.execution_state)) - Number(attentionStates.has(a.execution_state)) || a.id.localeCompare(b.id))
}
export function activityFlows(flows: PersonFlow[], tasks: PersonTask[]) {
  const ids = new Set(tasks.map(task => task.id))
  return flows.filter(flow => flow.state === 'active' || flow.state === 'failed' || flow.stages.some(stage => stage.tasks.some(task => ids.has(task.id))))
}
export function standaloneActivityTasks(tasks: PersonTask[], flows: PersonFlow[]) {
  const grouped = new Set(flows.flatMap(flow => flow.stages.flatMap(stage => stage.tasks.map(task => task.id))))
  return tasks.filter(task => !grouped.has(task.id))
}
