import { expect,it } from 'vitest'
import type { PersonFlowMessage } from '../../packages/client/src/api/person'
import { personFlowConversationMessages } from '../../packages/client/src/utils/person-flow-conversation'
import type { TaskPlanSnapshot } from '../../packages/client/src/utils/task-plan'

const entry=(id:number,session_id:string):PersonFlowMessage => ({id,session_id,session_title:session_id,bot_type:null,
  stage_id:'stage',round_number:1,role:'assistant',content:'回复',timestamp:id,run_marker:'shared-run'})
const plan=(session_id:string,revision=1):TaskPlanSnapshot => ({session_id,run_id:'shared-run',plan_id:'plan',revision,execution_state:'ended',
  created_at:1500,updated_at:2000,plan:[{id:'work',step:'阶段任务',status:'completed'}]})

it('places cards after the correct Bot turn, preserves receipts and deduplicates plan revisions',()=>{
  const first=entry(1,'bot-a'),second=entry(2,'bot-b')
  first.person_task_return={taskId:'task',executionId:'execution',assistantMessageId:'1',title:'任务',summary:'结果',agent:'codex',state:'finished'}
  const messages=personFlowConversationMessages([first,second],[plan('bot-a'),plan('bot-b'),plan('bot-a',2)])
  expect(messages.map(message=>message.id)).toEqual(['flow-chat:bot-a:1','task-plan:bot-a:plan','flow-chat:bot-b:2','task-plan:bot-b:plan'])
  expect(messages[0].personTaskReturn).toEqual(first.person_task_return)
  expect(messages[0].timestamp).toBe(1000)
  expect(messages[1].taskPlan?.revision).toBe(2)
})

it('supports plan-only content without inventing plans from text or invalid snapshots',()=>{
  expect(personFlowConversationMessages([],[])).toEqual([])
  expect(personFlowConversationMessages([entry(1,'bot')],[])).toHaveLength(1)
  expect(personFlowConversationMessages([],[plan('bot')])[0].taskPlan?.plan_id).toBe('plan')
  expect(personFlowConversationMessages([],[null,{}, {...plan('bot'),plan:[]}] as TaskPlanSnapshot[])).toEqual([])
})
