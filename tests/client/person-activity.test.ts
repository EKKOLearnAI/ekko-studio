import { describe, expect, it } from 'vitest'
import { activityTasks, activityFlows, standaloneActivityTasks } from '../../packages/client/src/utils/person-activity'
import type { PersonTask, PersonFlow } from '../../packages/client/src/api/person'
const task = (id: string, execution_state = 'running', status = 'open') => ({ id, execution_state, status, running: false } as PersonTask)
describe('person activity projection', () => {
 it('prioritizes attention without including completed history', () => {
  expect(activityTasks([task('a'), task('b', 'waiting_user'), task('c', 'finished', 'completed'), task('d','running','closed')]).map(t=>t.id)).toEqual(['b','a'])
 })
 it('preserves flow grouping and removes duplicate standalone tasks', () => {
  const tasks=[task('a'),task('b')]
  const flows=[{id:'f',state:'active',stages:[{tasks:[{id:'a'}]}]}] as PersonFlow[]
  expect(activityFlows(flows,tasks)).toEqual(flows)
  expect(standaloneActivityTasks(tasks,flows).map(t=>t.id)).toEqual(['b'])
 })
 it('keeps failed flows and hides completed history', () => {
  expect(activityFlows([{id:'a',state:'failed',stages:[]},{id:'b',state:'completed',stages:[]}] as unknown as PersonFlow[],[]).map(f=>f.id)).toEqual(['a'])
 })
})
