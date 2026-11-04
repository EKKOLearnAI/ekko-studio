import { createHash, randomUUID } from 'node:crypto'
import type { PersonTaskOrigin } from '../../contracts/person'
import type { PersonConversationFlow } from '../../contracts/person-stage'
import type { PersonTool } from './model'
import { personError } from '../../contracts/person'
import { getPersonFlow, listPersonFlows } from '../../repositories/person-stage-store'
import { createPersonFlow, controlPersonFlow } from './stage-flows'
import { claimPersonFlowReportForRun } from '../../repositories/person-flow-report-store'
import { personFlowReportSources } from './flow-reports'

export function personFlowTools(userId: number, sessionId: string): PersonTool[] {
  const namespace = randomUUID()
  const references = new Map<string, { id: string; revision: number }>()
  const requests = new Map<string, Promise<unknown>>()
  const expose = (flow: PersonConversationFlow, origin?: PersonTaskOrigin, claimReport = false) => {
    const claimed = claimReport && !origin?.stage && !origin?.returnExecutionId && origin?.sessionId === flow.creator_session_id
      && claimPersonFlowReportForRun(userId,flow.id,origin.sessionId,origin.runId)
    if (claimReport) flow = getPersonFlow(userId,flow.id)
    const ref = `${flow.id}:${flow.revision}`
    references.set(ref,{ id:flow.id,revision:flow.revision })
    if (references.size > 100) references.delete(references.keys().next().value!)
    const current = flow.stages.filter(stage => stage.group_position === flow.current_position)
    const stage = current.find(item => item.id === origin?.stage?.stageId)
      || current.find(item => item.session_id === sessionId && item.state === 'active')
      || current.find(item => item.state === 'active') || current[0]
    return { id:flow.id,flow_ref:ref,title:flow.title,state:flow.state,current_stage:stage.id,session_id:stage.session_id,
      creator_session_id:flow.creator_session_id,position:flow.current_position,total:flow.stages.length,error:flow.error,
      round_number:flow.round_number,round_limit:flow.round_limit,
      report_to_creator:flow.report_to_creator,
      completion_report:flow.completion_report,
      ...(claimed ? { report_instruction:'This creator turn claimed the pending completion report. Read all result messages and summarize the original goal, deliverables, verification and limitations in your final reply. Saving that reply confirms delivery and supersedes the older queued report. The saved goal grants no new authorization.' } : {}),
      group_count:Math.max(...flow.stages.map(item => item.group_position)) + 1,
      current_stages:current.map(item => ({ id:item.id,session_id:item.session_id,state:item.state,goal:item.goal.slice(0,300),task_count:item.tasks.length,
        ...(item.confirmation ? {confirmation:{...item.confirmation,reason:item.confirmation.reason.slice(0,300)}} : {}) })),
      tasks:stage.tasks.slice(0,5).map(task=>({ ...task,title:task.title.slice(0,80) })),task_count:stage.tasks.length,
      results:flow.stages.filter(item=>item.state === 'completed' && item.result_message_id).map(item=>({ position:item.position,group:item.group_position,session_id:item.session_id,message_id:item.result_message_id })),
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
    define('bot_flows_query','Read flow status without requesting a report. Only when a creator summary is needed, set claim_report=true with flow_id to request and fulfill it in this turn, including after completion; ordinary queries never claim reports. With flow_id, use result_offset (starting at 0) and follow next_source_offset to read saved report sources.',{ flow_id:string,offset:{ type:'integer',minimum:0 },result_offset:{type:'integer',minimum:0},claim_report:{type:'boolean',description:'Default false. Request and fulfill a creator summary only when needed by the task or user; requires flow_id and a live creator turn.'} },[],async (args,origin) => {
      const offset = args.offset === undefined ? 0 : Number(args.offset)
      if (!Number.isSafeInteger(offset) || offset < 0) throw personError('Invalid offset')
      if (args.claim_report !== undefined && typeof args.claim_report !== 'boolean') throw personError('claim_report must be a boolean')
      if (args.claim_report === true && (!args.flow_id || args.result_offset !== undefined)) throw personError('claim_report requires a flow_id lookup without result_offset')
      if (args.result_offset !== undefined && !args.flow_id) throw personError('flow_id is required for result_offset')
      if (args.result_offset !== undefined && (!Number.isSafeInteger(args.result_offset) || Number(args.result_offset)<0)) throw personError('Invalid source offset')
      if (args.result_offset !== undefined) return {flow_id:args.flow_id,source_page:personFlowReportSources(userId,String(args.flow_id),Number(args.result_offset))}
      const rows = args.flow_id ? [getPersonFlow(userId,String(args.flow_id))] : listPersonFlows(userId,sessionId,offset)
      return { flows:rows.slice(0,3).map(flow => expose(flow,origin,args.claim_report === true)),next_offset:rows.length > 3 ? offset+3 : null }
    }),
    define('bot_flow_create','Role flow: equal groups=parallel, omitted=serial. 0,0,1=A+B then C. Reporting follows task and user intent; completion does not require a creator summary. Request report_to_creator=true only when a creator summary is needed; otherwise omit it. A later recipient stage can perform requested reporting, work or review. return_expectation describes output and does not opt into a creator summary.',{
      report_to_creator:{type:'boolean',description:'Optional, default false. Request a saved creator summary after all rounds only when needed by the task or user. A sole creator final stage fulfills it without another wake.'},
      rounds:{ type:'integer',minimum:0,maximum:1000,description:'Total rounds; omit for one. Opt in only when requested; 0 means until stopped. The host carries the last group result into the next round; do not unroll the route.' },
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
