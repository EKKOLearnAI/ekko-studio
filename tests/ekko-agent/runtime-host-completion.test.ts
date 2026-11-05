import { expect, it, vi } from 'vitest'
import { AgentRuntime, AgentToolRegistry } from '../../packages/ekko-agent/src'
import type { ModelClient, ModelRequest, ModelResponse } from '../../packages/ekko-agent/src/model/types'

it('finishes a trusted host wait only after the entire tool batch has settled', async () => {
  const tools = new AgentToolRegistry(), settled: string[] = []
  for (const name of ['first','last']) tools.register({definition:{name},execute:async () => {
    settled.push(name)
    return {ok:true,content:name}
  }})
  const create = vi.fn(async () => ({content:'',toolCalls:['first','last'].map(name => ({id:name,name,arguments:{}}))}))
  const client: ModelClient = {provider:'fixture',requestStyle:'custom-runtime',
    capabilities:{streaming:false,tools:true,vision:false,jsonMode:false,systemPrompt:true},create,
    async *stream() { throw new Error('Unexpected stream') }}
  const complete = vi.fn(() => {
    expect(settled).toEqual(['first','last'])
    return {role:'assistant' as const,content:'',finishReason:'waiting_for_tasks'}
  })
  const result = await new AgentRuntime({tools,skillsEnabled:false}).run({messages:['Run the batch'],modelClient:client,
    memoryEnabled:false,onToolBatchComplete:complete})
  expect(create).toHaveBeenCalledTimes(1)
  expect(complete).toHaveBeenCalledTimes(1)
  expect(result.steps.filter(step => step.type === 'tool')).toHaveLength(2)
  expect(result.events.filter(event => event.type === 'run.completed')).toHaveLength(1)
  expect(result.output.finishReason).toBe('waiting_for_tasks')
})

it('keeps ordinary model completion unchanged when no host completion is requested', async () => {
  const tools = new AgentToolRegistry()
  tools.register({definition:{name:'read'},execute:async () => ({ok:true,content:'evidence'})})
  let requests = 0
  const create = vi.fn(async () => ++requests === 1
    ? {content:'',toolCalls:[{id:'read',name:'read',arguments:{}}]}
    : {content:'Verified result',finishReason:'stop'})
  const client: ModelClient = {provider:'fixture',requestStyle:'custom-runtime',
    capabilities:{streaming:false,tools:true,vision:false,jsonMode:false,systemPrompt:true},create,
    async *stream() { throw new Error('Unexpected stream') }}
  const result = await new AgentRuntime({tools,skillsEnabled:false}).run({messages:['Read and report'],modelClient:client,memoryEnabled:false})
  expect(result.output).toMatchObject({content:'Verified result',finishReason:'stop'})
  expect(create).toHaveBeenCalledTimes(2)
})

it('allows one streamed tool-free reply after the complete batch, including at maxSteps', async () => {
  const tools = new AgentToolRegistry(), settled: string[] = [], requests: ModelRequest[] = []
  for (const name of ['first','last']) tools.register({ definition:{name}, execute:async()=>{
    settled.push(name)
    return {ok:true,content:`Saved ${name}`}
  } })
  const reply = '已安排两项研究，收到结果后会汇总给你。'
  const client: ModelClient = {provider:'fixture',requestStyle:'custom-runtime',
    capabilities:{streaming:true,tools:true,vision:false,jsonMode:false,systemPrompt:true},
    create:vi.fn(async()=>{throw new Error('Unexpected non-streaming request')}),
    async *stream(request) {
      requests.push(request)
      if (requests.length === 1) {
        yield {type:'done',response:{content:'',toolCalls:['first','last'].map(name=>({id:name,name,arguments:{}}))}}
      } else {
        expect(settled).toEqual(['first','last'])
        expect(request).toMatchObject({tools:[],toolChoice:'none'})
        expect(request.messages.filter(message=>message.role==='tool').map(message=>message.content)).toEqual(['Saved first','Saved last'])
        expect(request.messages.at(-1)).toMatchObject({role:'system',content:'Acknowledge the dispatched work.'})
        yield {type:'text-delta',text:reply}
        yield {type:'done',response:{content:reply,finishReason:'stop'}}
      }
    },
  }
  const complete = vi.fn(()=>({finalReply:'Acknowledge the dispatched work.',finishReason:'waiting_for_tasks'}))
  const result = await new AgentRuntime({tools,skillsEnabled:false,maxSteps:1}).run({messages:['Research both topics'],modelClient:client,memoryEnabled:false,onToolBatchComplete:complete})
  expect(requests).toHaveLength(2)
  expect(complete).toHaveBeenCalledTimes(1)
  expect(result.output).toMatchObject({content:reply,finishReason:'waiting_for_tasks'})
  expect(result.steps.filter(step=>step.type==='tool')).toHaveLength(2)
  expect(result.events.filter(event=>event.type==='run.started')).toHaveLength(1)
  expect(result.events.filter(event=>event.type==='run.completed')).toHaveLength(1)
  expect(result.events.some(event=>event.type==='run.max_steps')).toBe(false)
  expect(result.events.filter(event=>event.type==='model.delta').map(event=>event.text).join('')).toBe(reply)
})

it.each([
  {name:'unexpected tools',response:{content:'',toolCalls:[{id:'again',name:'read',arguments:{}}]},error:'tool calls during a tool-free final reply'},
  {name:'empty reply',response:{content:''},error:'empty final reply'},
])('fails a provider returning $name without executing or looping again', async ({response,error})=>{
  const tools = new AgentToolRegistry(), execute=vi.fn(async()=>({ok:true,content:'saved'}))
  tools.register({definition:{name:'read'},execute})
  let requests=0
  const create=vi.fn(async():Promise<ModelResponse>=>++requests===1
    ? {content:'',toolCalls:[{id:'first',name:'read',arguments:{}}]} : response)
  const client:ModelClient={provider:'fixture',requestStyle:'custom-runtime',capabilities:{streaming:false,tools:true,vision:false,jsonMode:false,systemPrompt:true},create,
    async *stream(){throw new Error('Unexpected stream')}}
  await expect(new AgentRuntime({tools,skillsEnabled:false}).run({messages:['Read and report'],modelClient:client,memoryEnabled:false,
    onToolBatchComplete:()=>({finalReply:'Acknowledge the work.',finishReason:'waiting_for_tasks'})})).rejects.toThrow(error)
  expect(create).toHaveBeenCalledTimes(2)
  expect(execute).toHaveBeenCalledTimes(1)
})

it('honors cancellation during the closing reply without publishing a late completion',async()=>{
  const tools=new AgentToolRegistry(),abort=new AbortController(),events:string[]=[]
  tools.register({definition:{name:'dispatch'},execute:async()=>({ok:true,content:'queued'})})
  let requests=0
  const client:ModelClient={provider:'fixture',requestStyle:'custom-runtime',capabilities:{streaming:false,tools:true,vision:false,jsonMode:false,systemPrompt:true},
    create:async()=>{
      if(++requests===1)return {content:'',toolCalls:[{id:'dispatch',name:'dispatch',arguments:{}}]}
      abort.abort(new Error('User stopped the turn'))
      return {content:'Late acknowledgement',finishReason:'stop'}
    },async *stream(){throw new Error('Unexpected stream')}}
  await expect(new AgentRuntime({tools,skillsEnabled:false}).run({messages:['Dispatch'],modelClient:client,memoryEnabled:false,signal:abort.signal,
    onToolBatchComplete:()=>({finalReply:'Acknowledge.',finishReason:'waiting_for_tasks'}),onEvent:event=>events.push(event.type)})).rejects.toMatchObject({name:'AbortError'})
  expect(requests).toBe(2)
  expect(events).not.toContain('run.completed')
})
