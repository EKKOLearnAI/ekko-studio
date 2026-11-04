import { createHash, randomUUID } from 'node:crypto'
import type { PersonTaskOrigin } from '../../contracts/person'
import type { PersonConversationFlow } from '../../contracts/person-stage'
import type { PersonTool } from './model'
import { personError } from '../../contracts/person'
import { getPersonFlow, listPersonFlows } from '../../repositories/person-stage-store'
import { createPersonFlow, controlPersonFlow } from './stage-flows'

export function personFlowTools(userId: number, sessionId: string): PersonTool[] {
  const namespace = randomUUID()
  const references = new Map<string, { id: string; revision: number }>()
  const requests = new Map<string, Promise<unknown>>()
  const expose = (flow: PersonConversationFlow, origin?: PersonTaskOrigin) => {
    const ref = `${flow.id}:${flow.revision}`
    references.set(ref,{ id:flow.id,revision:flow.revision })
    if (references.size > 100) references.delete(references.keys().next().value!)
    const current = flow.stages.filter(stage => stage.group_position === flow.current_position)
    const stage = current.find(item => item.id === origin?.stage?.stageId)
      || current.find(item => item.session_id === sessionId && item.state === 'active')
      || current.find(item => item.state === 'active') || current[0]
    return { id:flow.id,flow_ref:ref,title:flow.title,state:flow.state,current_stage:stage.id,session_id:stage.session_id,
      creator_session_id:flow.creator_session_id,position:flow.current_position,total:flow.stages.length,error:flow.error,
      group_count:Math.max(...flow.stages.map(item => item.group_position)) + 1,
      current_stages:current.map(item => ({ id:item.id,session_id:item.session_id,state:item.state,goal:item.goal.slice(0,300),task_count:item.tasks.length })),
      tasks:stage.tasks.slice(0,5).map(task=>({ ...task,title:task.title.slice(0,80) })),task_count:stage.tasks.length,
      results:flow.stages.filter(item=>item.result_message_id).map(item=>({ position:item.position,group:item.group_position,session_id:item.session_id,message_id:item.result_message_id })),
      goal:stage.goal.slice(0,600),return_expectation:stage.return_expectation.slice(0,600) }
  }
  const string = { type:'string' }
  const define = (name: string, description: string, properties: Record<string,unknown>, required: string[], work: PersonTool['execute']): PersonTool => ({
    name,description,parameters:{ type:'object',properties,required,additionalProperties:false },
    async execute(args, origin) {
      try {
        if (Object.keys(args).some(key => !Object.hasOwn(properties,key)) || required.some(key => args[key] === undefined)) throw personError('Invalid flow arguments')
        return await work(args,origin || { sessionId,runId:'',messages:[] })
      } catch (error) {
        if (!(error as { status?: number }).status) throw error
        if ((error as {code?:string}).code === 'SELF_HANDOFF') return {ok:false,error:{code:'SELF_HANDOFF',message:(error as Error).message,recovery:'The current role is you. Do your part here (choose one worker if needed), wait for its result, then create a flow starting with a different role. Do not merely remove yourself and dispatch a dependent review before the result exists.'}}
        if ((error as {code?:string}).code === 'WORK_PENDING') return {ok:false,error:{code:'WORK_PENDING',message:(error as Error).message,recovery:'End this turn and wait for the existing worker. On its result callback, pass the verified artifact to the next role. Do not create another worker or retry the handoff now.'}}
        return { ok:false,error:{ message:(error as Error).message,recovery:'Query the flow again; use its current flow_ref. Do not replace a stopped or blocked flow.' } }
      }
    },
  })
  const mutate = async (args: Record<string,unknown>, origin: PersonTaskOrigin, create = false) => {
    const normalized = Object.fromEntries(Object.entries(args).sort(([a],[b])=>a.localeCompare(b)))
    const key = createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
    if (requests.has(key)) return requests.get(key)!
    const pending = (async () => {
      const flow = create ? createPersonFlow(userId,{ ...args,idempotency_key:`${namespace}:${key}` },origin)
        : await controlPersonFlow(userId,{ ...args,idempotency_key:`${namespace}:${key}` },origin)
      return { ok:true,flow:expose(flow,origin),...(create ? {instruction:'Flow queued. The host wakes every role in the first group, including you if assigned, then waits for every saved result before the next group. Do not perform or launch assigned work now; acknowledge and end this turn.'} : {}),...(args.action === 'complete' ? { instruction:'Completion is prepared. Write your new stage result as the final reply now; successful persistence completes your branch. The host waits for its peers before the next group. Do not start more work.' } : {}) }
    })()
    requests.set(key,pending)
    try { return await pending } catch (error) { requests.delete(key); throw error }
  }
  return [
    define('bot_flows_query','Query flows; fresh flow_ref for control.',{ flow_id:string,offset:{ type:'integer',minimum:0 } },[],async (args,origin) => {
      const offset = args.offset === undefined ? 0 : Number(args.offset)
      if (!Number.isSafeInteger(offset) || offset < 0) throw personError('Invalid offset')
      const rows = args.flow_id ? [getPersonFlow(userId,String(args.flow_id))] : listPersonFlows(userId,sessionId,offset)
      return { flows:rows.slice(0,3).map(flow => expose(flow,origin)),next_offset:rows.length > 3 ? offset+3 : null }
    }),
    define('bot_flow_create','Role flow: equal groups=parallel, omitted=serial. 0,0,1=A+B then C.',{
      title:string,goal:string,stages:{ type:'array',minItems:1,maxItems:13,items:{ type:'object',additionalProperties:false,
        properties:{ session_id:string,goal:string,return_expectation:string,group:{ type:'integer',minimum:0 } },required:['session_id','goal','return_expectation'] } },
    },['title','goal','stages'],(args,origin)=>mutate(args,origin!,true)),
    define('bot_flow_control','complete branch then reply; stop all; creator resumes unfinished.',{
      action:{ type:'string',enum:['complete','stop','resume'] },flow_ref:string,
    },['action','flow_ref'],(args,origin)=>{
      const reference = references.get(String(args.flow_ref))
      if (!reference) throw personError('Query the flow first',409)
      return mutate({ action:args.action,flow_id:reference.id,expected_revision:reference.revision },origin!)
    }),
  ]
}
