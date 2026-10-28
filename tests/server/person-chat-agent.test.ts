import { describe, it, expect, vi } from 'vitest'
import { createPersonAgent } from '../../packages/server/src/bootstrap/person-chat-agent'
import type { ModelClient, ModelRequest, ModelEvent } from '../../packages/ekko-agent/src/model/types'

describe('Person agent in the shared chat runtime', () => {
  it('loads selected history once and reports the prepared request size, including tools', async () => {
    const { countTextTokens } = await import('../../packages/ekko-agent/src')
    const requests: ModelRequest[] = [], events: any[] = []
    const history = vi.fn(() => [{role:'user' as const,content:'Historical evidence: code LIME-42'}])
    const client: ModelClient = {
      provider:'test',capabilities:{streaming:true,tools:true,vision:false,jsonMode:false,systemPrompt:true},
      create:vi.fn(async()=>({content:'summary'})),
      async *stream(request) { requests.push(request); yield {type:'text-delta',text:'LIME-42'};yield {type:'done',response:{content:'LIME-42'}} },
    }
    const agent=createPersonAgent({workspace:'/tmp/person-test',selection:{runtime:'ekko',mode:'scoped',profile:'default',provider:'test',model:'m'},
      contextTokens:8000,maxSteps:3,systemPrompt:'You are Person',tools:[],loadHistory:history})
    const result=await agent.run({messages:[{role:'user',content:'What was the code?'}],modelClient:client,onEvent:e=>{events.push(e)}})
    expect(history).toHaveBeenCalledExactlyOnceWith('What was the code?')
    expect(JSON.stringify(requests[0].messages)).toContain('Historical evidence')
    expect(requests[0].messages.filter(m=>m.content==='What was the code?')).toHaveLength(1)
    const expected=Math.ceil(countTextTokens(JSON.stringify({messages:requests[0].messages,tools:requests[0].tools}))*1.15)
    expect(events.filter(e=>e.type==='context.estimated').at(-1).estimate.contextTokens).toBe(expected)
    expect(result.contextEstimate?.contextTokens).toBe(expected)
    expect(requests[0].context).toBeUndefined()
    const prompt = requests[0].messages.filter(message => message.role === 'system').map(message => message.content).join('\n')
    expect(prompt).not.toContain('Use terminal_exec')
    expect(prompt).not.toContain('## Command Environment')
    expect(prompt).not.toContain('use code_exec')
  })
  it('captures the initiating turn before task creation and forwards the runtime origin', async () => {
    const execute = vi.fn(async () => ({ execution: { state: 'queued' } }))
    let step = 0
    const client: ModelClient = {
      provider: 'test', capabilities: { streaming: true, tools: true, vision: false, jsonMode: false, systemPrompt: true },
      create: vi.fn(async () => ({ content: '' })),
      async *stream() {
        if (step++ === 0) yield { type: 'tool-call' as const, toolCall: { id: 'dispatch', name: 'bot_task_create', arguments: { title: 'Work', goal: 'Compute' } } }
        yield { type: 'done' as const, response: { content: 'Task queued' } }
      },
    }
    const agent = createPersonAgent({ workspace: '/tmp/person-test', selection: { runtime: 'ekko', mode: 'scoped', profile: 'default', provider: 'test', model: 'm' }, contextTokens: 8000, maxSteps: 3, systemPrompt: 'You are Person',
      tools: [{ name: 'bot_task_create', description: 'Start background work', parameters: { type: 'object', properties: {} }, execute }] })
    await agent.run({ messages: [{ role: 'user', content: 'Original request' }], modelClient: client, toolContext: { sessionId: 'person-main-1' } })
    expect(execute).toHaveBeenCalledWith({ title: 'Work', goal: 'Compute' }, { sessionId: 'person-main-1', runId: expect.any(String), messages: [{ role: 'user', content: 'Original request' }] })
  })
  it('preserves structured task failures as failed tool events and lets the model recover', async () => {
    const requests: ModelRequest[] = [], events: any[] = []
    const execute = vi.fn(async () => ({ ok: false, error: { code: 'STALE_TASK', recovery: 'Query the task again' } }))
    const client: ModelClient = {
      provider: 'test', capabilities: { streaming: true, tools: true, vision: false, jsonMode: false, systemPrompt: true },
      create: vi.fn(async () => ({ content: '' })),
      async *stream(request) {
        requests.push(request)
        if (requests.length === 1) yield { type: 'tool-call', toolCall: { id: 'stop', name: 'bot_task_control', arguments: { task_ref: 'old', action: 'stop' } } }
        yield { type: 'done', response: { content: requests.length === 1 ? '' : 'Task changed' } }
      },
    }
    const agent = createPersonAgent({ workspace: '/tmp/person-test', selection: { runtime: 'ekko', mode: 'scoped', profile: 'default', provider: 'test', model: 'm' }, contextTokens: 8000, maxSteps: 3, systemPrompt: 'You are Person',
      tools: [{ name: 'bot_task_control', parameters: { type: 'object', properties: {} }, execute }] })
    await agent.run({ messages: [{ role: 'user', content: 'Stop' }], modelClient: client, onEvent: event => events.push(event) })
    expect(events.find(event => event.type === 'tool.failed').result.ok).toBe(false)
    expect(JSON.stringify(requests[1].messages)).toContain('STALE_TASK')
  })
  it('streams reasoning and tools, waits for the single-chat clarification, and keeps its tool and memory scope', async () => {
    const requests: ModelRequest[] = []
    const events: any[] = []
    let release!: (value: string) => void
    const clarify = vi.fn(() => new Promise<string>(resolve => { release = resolve }))
    const client: ModelClient = {
      provider: 'test', capabilities: { streaming: true, tools: true, vision: false, jsonMode: false, systemPrompt: true },
      create: vi.fn(async () => ({ content: 'summary' })),
      async *stream(request): AsyncGenerator<ModelEvent> {
        requests.push(request)
        if (requests.length === 1) {
          yield { type: 'reasoning-delta', text: 'A user decision is missing.' }
          yield { type: 'tool-call', toolCall: { id: 'question', name: 'bot_decision_request', arguments: { question: 'Which report?', choices: ['Weekly','Monthly'] } } }
          yield { type: 'done', response: { content: '' } }
        } else { yield { type: 'text-delta', text: 'I will use the weekly report.' }; yield { type: 'done', response: { content: 'I will use the weekly report.' } } }
      },
    }
    const agent = createPersonAgent({ workspace: '/tmp/person-test', selection: { runtime: 'ekko', mode: 'scoped', profile: 'default', provider: 'test', model: 'm' },
      contextTokens: 8000, maxSteps: 4, systemPrompt: 'You are Person, an independent account agent.',
      tools: [{ name: 'bot_decision_request', description: 'Ask a question', parameters: { type: 'object', properties: { question: { type: 'string' }, choices: { type: 'array', items: { type: 'string' } } }, required: ['question'] }, execute: async () => { throw new Error('Must use the chat clarification callback') } }],
    })
    const running = agent.run({ messages: [{ role: 'user', content: 'Prepare a report' }], modelClient: client,
      reasoningEffort: 'high', memoryEnabled: true, toolContext: { sessionId: 'person-main-1', requestUserClarification: clarify }, onEvent: event => events.push(event) })
    await vi.waitFor(() => expect(clarify).toHaveBeenCalled())
    expect(agent.requestBoundaryInterrupt({ sessionId: 'person-main-1', expectedRunId: 'stale-run' }).status).toBe('run_mismatch')
    expect(requests).toHaveLength(1)
    expect(requests[0].reasoningEffort).toBe('high')
    expect(requests[0].tools?.map(t => t.name)).toEqual(['bot_decision_request'])
    expect(JSON.stringify(requests[0])).toContain('independent account agent')
    release('Weekly')
    const result = await running
    expect(result.output.content).toBe('I will use the weekly report.')
    expect(JSON.stringify(requests[1].messages)).toContain('Weekly')
    expect(events.map(e => e.type)).toContain('tool.completed')
    expect(events.some(e => e.type === 'model.reasoning.delta' || JSON.stringify(e).includes('A user decision is missing.'))).toBe(true)
    expect(result.memoryContext).toBeUndefined()
  })
})
