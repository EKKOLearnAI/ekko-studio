import { expect, it, vi } from 'vitest'
import { AgentRuntime, AgentToolRegistry } from '../../packages/ekko-agent/src'
import type { ModelClient } from '../../packages/ekko-agent/src/model/types'

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
