import { describe, expect, it } from 'vitest'
import {
  responseMcpToolRoutes, responsesToOpenAiChat, responsesToAnthropicMessages,
  normalizeResponseFunctionCall, openAiChatToResponses, anthropicMessageToResponses,
} from '../../packages/server/src/modules/coding-agents/protocol/adapters/responses'
import {
  normalizeResponsesSseEvents, openAiChatSseToResponsesEvents,
} from '../../packages/server/src/modules/coding-agents/protocol/adapters/responses-stream'

const fn = (name: string, namespace?: string) => ({type:'function',name,parameters:{type:'object',properties:{}},...(namespace?{namespace}:{})})
const ns = (name: string, names: string[]) => ({type:'namespace',name,tools:names.map(n=>fn(n))})
const target = {model:'test',annotateMcpToolNamespaces:true}
const body = {tools:[ns('multi_agent_v1',['spawn_agent','wait_agent']),ns('mcp__demo',['lookup']),fn('plain')],input:[]}
const names = (b: any) => responsesToOpenAiChat(b,target).tools.map((t: any)=>t.function.name)

describe('Responses namespace identity across compatible providers',()=>{
  it('restores native namespace and name from provider-safe alias',()=>{
    const alias=names(body)[0]
    expect(alias).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
    expect(normalizeResponseFunctionCall(alias,'{}',responseMcpToolRoutes(body))).toEqual({name:'spawn_agent',namespace:'multi_agent_v1',arguments:'{}'})
    expect(names(body)[3]).toBe('plain')
  })
  it('separates identical function names and preserves equal namespace/name',()=>{
    const b={tools:[ns('a',['same']),ns('b',['same']),fn('same'),fn('equal','equal')]}
    expect(new Set(names(b)).size).toBe(4)
    expect(normalizeResponseFunctionCall(names(b)[3],'',responseMcpToolRoutes(b))).toEqual({namespace:'equal',name:'equal',arguments:''})
  })
  it('uses the identical alias in historical calls and deferred tools',()=>{
    const b={tools:[],input:[{type:'tool_search_output',call_id:'s',tools:[body.tools[0]]},{type:'function_call',namespace:'multi_agent_v1',name:'spawn_agent',call_id:'c',arguments:'{}'},{type:'function_call_output',call_id:'c',output:'ok'}]}
    const chat=responsesToOpenAiChat(b,target)
    expect(chat.tools[0].function.name).toBe(names(body)[0])
    expect(chat.messages.find((m:any)=>m.tool_calls).tool_calls[0].function.name).toBe(names(body)[0])
    expect(responseMcpToolRoutes(b)[names(body)[0]].namespace).toBe('multi_agent_v1')
  })
  it('routes additional tools without mutating ordinary or generic MCP calls',()=>{
    expect(responseMcpToolRoutes({additional_tools:[body.tools[0]]})[names(body)[0]].name).toBe('spawn_agent')
    expect(normalizeResponseFunctionCall('plain','{}',{})).toEqual({name:'plain',arguments:'{}'})
    expect(normalizeResponseFunctionCall('mcp__generic','{"tool":"lookup","arguments":{"q":1}}',{})).toEqual({namespace:'mcp__generic',name:'lookup',arguments:'{"q":1}'})
  })
  it('restores Chat and Anthropic nonstream calls',()=>{
    const alias=names(body)[0], mcpToolRoutes=responseMcpToolRoutes(body)
    const chat=openAiChatToResponses({choices:[{message:{tool_calls:[{id:'c',type:'function',function:{name:alias,arguments:'{}'}}]}}]},{...target,mcpToolRoutes})
    expect(chat.output[0]).toMatchObject({name:'spawn_agent',namespace:'multi_agent_v1'})
    expect(responsesToAnthropicMessages(body,target).tools[0].name).toBe(alias)
    const anthropic=anthropicMessageToResponses({content:[{type:'tool_use',id:'c',name:alias,input:{}}]},{...target,mcpToolRoutes})
    expect(anthropic.output[0]).toMatchObject({name:'spawn_agent',namespace:'multi_agent_v1'})
  })
  it('preserves streamed arguments and namespaces across fragmented frames',async()=>{
    const alias=names(body)[0]
    const packets=[{choices:[{delta:{tool_calls:[{index:0,id:'c',function:{name:alias,arguments:''}}]}}]},{choices:[{delta:{tool_calls:[{index:0,function:{arguments:'{"message":'}}]}}]},{choices:[{delta:{tool_calls:[{index:0,function:{arguments:'"ok"}'}}]},finish_reason:'tool_calls'}]}]
    const bytes=Buffer.from(packets.map(x=>'data: '+JSON.stringify(x)+'\n\n').join('')+'data: [DONE]\n\n')
    async function* chunks(){for(let i=0;i<bytes.length;i+=7)yield bytes.subarray(i,i+7)}
    const events=[]
    for await(const event of normalizeResponsesSseEvents(openAiChatSseToResponsesEvents(chunks(),{...target,mcpToolRoutes:responseMcpToolRoutes(body)})))events.push(event)
    const added=events.find(e=>e.type==='response.output_item.added'&&e.data.item.type==='function_call')!
    const done=events.find(e=>e.type==='response.output_item.done'&&e.data.item.type==='function_call')!
    expect(added.data.item.arguments).toBe('')
    expect(done.data.item).toMatchObject({name:'spawn_agent',namespace:'multi_agent_v1',arguments:'{"message":"ok"}'})
    expect(events.filter(e=>e.type==='response.function_call_arguments.delta').map(e=>e.data.delta).join('')).toBe(done.data.item.arguments)
  })
})
