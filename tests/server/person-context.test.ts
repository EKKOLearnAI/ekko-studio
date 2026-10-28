import { describe, expect, it, vi } from 'vitest'
import { personBudgetedClient } from '../../packages/server/src/bootstrap/person-model-context'
import type { PersonModelCall } from '../../packages/server/src/modules/studio/public/person-runtime'
import type { ModelClient, ModelRequest } from '../../packages/ekko-agent/src/model/types'
import { estimatePersonContext, personContextText } from '../../packages/server/src/modules/studio/services/person/context-estimate'
const input = (): PersonModelCall => ({ selection: { runtime:'ekko',mode:'scoped',profile:'default',provider:'test',model:'model' }, messages:[],tools:[],systemPrompt:'Person',contextTokens:8000,maxSteps:8,signal:new AbortController().signal })
function client() {
  const sent: ModelRequest[] = []
  return { sent, port: { provider:'test',requestStyle:'chat_completions',capabilities:{maxInputTokens:8000,streaming:true,tools:true,vision:false},
    create:vi.fn(async (request: ModelRequest) => { sent.push(request); return {content:'Summary of established user goal; no authorization added'} }),
    stream: async function*(request: ModelRequest) { sent.push(request); yield {type:'done',response:{content:'done'}} },
  } as unknown as ModelClient }
}
describe('Person provider request budget', () => {
  it('uses the model-window percentage and replays checkpoints instead of summarizing completed steps again', async () => {
    const request = longTurn(), original = structuredClone(request)
    const budget = Math.ceil(estimatePersonContext(request).contextTokens / 0.6)
    const high = client(); high.port.capabilities.maxInputTokens = budget
    await personBudgetedClient(high.port, { ...input(), contextTokens: budget, compression: { enabled: true, threshold: 0.8 } }).create(request)
    expect(high.sent).toHaveLength(1)
    const c = client(); c.port.capabilities.maxInputTokens = budget
    const wrapped = personBudgetedClient(c.port, { ...input(), contextTokens: budget, compression: { enabled: true, threshold: 0.5 } })
    await wrapped.create(request)
    const summaryCalls = () => c.sent.filter(sent => sent.messages[0].content.startsWith('Summarize task'))
    const count = summaryCalls().length
    expect(count).toBeGreaterThan(0)
    const next: ModelRequest = { ...request, messages: [...request.messages,
      { role: 'assistant', content: '', toolCalls: [{ id: 'next', name: 'lookup', arguments: {} }] },
      { role: 'tool', toolCallId: 'next', content: 'A new short result' }] }
    for await (const _ of wrapped.stream(next)) { /* consume */ }
    expect(summaryCalls()).toHaveLength(count)
    expect(c.sent.at(-1)!.messages.some(message => message.content.startsWith('Earlier completed steps'))).toBe(true)
    expect(c.sent.at(-1)!.messages.slice(-2)).toEqual(next.messages.slice(-2))
    for (let i = 0; i < 15; i++) next.messages.push(
      { role: 'assistant', content: '', toolCalls: [{ id: `new${i}`, name: 'lookup', arguments: {} }] },
      { role: 'tool', toolCallId: `new${i}`, content: 'New evidence to retain. '.repeat(250) })
    await wrapped.create(next)
    expect(summaryCalls().length).toBeGreaterThan(count)
    expect(summaryCalls().slice(count).every(sent => !sent.messages[1].content.includes('Earlier completed steps'))).toBe(true)
    expect(request).toEqual(original)
  })

  it('respects disabled automatic compression while retaining the hard model-window guard', async () => {
    const request = longTurn(), budget = Math.ceil(estimatePersonContext(request).contextTokens / 0.6)
    const c = client(); c.port.capabilities.maxInputTokens = budget
    const wrapped = personBudgetedClient(c.port, { ...input(), contextTokens: budget, compression: { enabled: false, threshold: 0.1 } })
    await wrapped.create(request)
    expect(c.sent).toHaveLength(1)
    await expect(wrapped.create({ ...request, messages: [...request.messages, { role: 'user', content: 'Oversized current input. '.repeat(30000) }] })).rejects.toThrow('budget')
    expect(c.sent).toHaveLength(1)
  })

  it('accepts larger context with a 64k budget while respecting a smaller provider limit', async () => {
    const request: ModelRequest = { messages: [{ role: 'user', content: 'Context detail. '.repeat(6000) }], maxTokens: 2048 }
    const estimate = estimatePersonContext(request).contextTokens + 2048 + 1024
    expect(estimate).toBeGreaterThan(16000)
    expect(estimate).toBeLessThan(64000)
    const c = client(); c.port.capabilities.maxInputTokens = 128000
    await personBudgetedClient(c.port, { ...input(), contextTokens: 64000 }).create(request)
    expect(c.sent).toHaveLength(1)
    expect(c.sent[0].messages).toEqual(request.messages)
    c.port.capabilities.maxInputTokens = 16000
    await expect(personBudgetedClient(c.port, { ...input(), contextTokens: 64000 }).create(request)).rejects.toThrow('budget')
    expect(c.sent).toHaveLength(1)
  })

  it('does not count provider response envelopes as conversation or send them to checkpoints', async () => {
    const c = client(), request = longTurn()
    const envelope = { instructions: 'Provider instructions and diagnostics. '.repeat(1000), tools: request.tools }
    request.messages = request.messages.map(message => message.role === 'assistant'
      ? { ...message, raw: envelope, context: { responseId: 'previous-response' }, usage: { inputTokens: 5000 } }
      : message)
    const original = structuredClone(request)
    await personBudgetedClient(c.port, input()).create(request)
    expect(c.sent.length).toBeGreaterThan(1)
    expect(c.sent.slice(0, -1).every(sent => !JSON.stringify(sent.messages).includes('Provider instructions and diagnostics'))).toBe(true)
    expect(c.sent.at(-1)!.messages.slice(-2)).toEqual(request.messages.slice(-2))
    const clean = { ...request, messages: request.messages.map(({ role, content, toolCalls, toolCallId }) => ({ role, content, toolCalls, toolCallId })) }
    expect(estimatePersonContext(request)).toEqual(estimatePersonContext(clean))
    expect(request).toEqual(original)
  })

  it('counts reported reasoning tokens instead of ciphertext, preserving native replay on the provider request', async () => {
    const c = client()
    const native = { format: 'openai-responses-items' as const, replayScope: 'provider/model', data: [
      { type: 'reasoning', encrypted_content: 'opaque-ciphertext-'.repeat(3000) },
    ] }
    const messages: ModelRequest['messages'] = [
      { role: 'user', content: 'Check the task; do not change it.' },
      { role: 'assistant', content: '', reasoning: { native, estimatedTokens: 138 }, toolCalls: [{ id: 'query', name: 'lookup', arguments: {} }] },
      { role: 'tool', toolCallId: 'query', content: 'Task is still running.' },
    ]
    const withoutReasoning = messages.map(({ reasoning: _, ...message }) => message)
    const tokens = estimatePersonContext({ messages }).contextTokens
    expect(tokens - estimatePersonContext({ messages: withoutReasoning }).contextTokens).toBeGreaterThanOrEqual(138)
    expect(tokens).toBeLessThan(500)
    expect(JSON.stringify(personContextText(messages))).not.toContain('opaque-ciphertext')
    await personBudgetedClient(c.port, input()).create({ messages })
    for await (const _ of personBudgetedClient(c.port, input()).stream({ messages })) { /* consume */ }
    expect(c.sent.map(request => request.messages)).toEqual([messages, messages])
  })

  it.each(['reported', 'visible', 'unknown-native'] as const)('still rejects genuinely oversized %s reasoning', async kind => {
    const c = client()
    const reasoning = {
      native: { format: 'openai-responses-items' as const, data: kind === 'unknown-native' ? 'opaque ciphertext '.repeat(4000) : [] },
      ...(kind === 'reported' ? { estimatedTokens: 12000 } : {}),
      ...(kind === 'visible' ? { text: 'Long visible reasoning. '.repeat(4000), estimatedTokens: 10 } : {}),
    }
    await expect(personBudgetedClient(c.port, input()).create({ messages: [
      { role: 'user', content: 'Current request' }, { role: 'assistant', content: '', reasoning },
    ] })).rejects.toThrow('budget')
    expect(c.sent).toEqual([])
  })

  it('reserves image context without counting Base64 as text or changing the provider payload', async () => {
    const c = client(); c.port.capabilities.maxInputTokens = 16000
    const wrapped = personBudgetedClient(c.port, { ...input(), contextTokens: 16000 })
    const image = { type: 'image' as const, mimeType: 'image/jpeg', data: Buffer.alloc(400_000, 0xab).toString('base64') }
    const messages: ModelRequest['messages'] = [{ role: 'user', content: '这是一张什么图片', contentParts: [image] }]
    await wrapped.create({ messages })
    for await (const _ of wrapped.stream({ messages })) { /* consume */ }
    expect(c.sent.map(r => r.messages)).toEqual([messages, messages])
    await expect(wrapped.create({ messages: [{ ...messages[0], contentParts: Array(8).fill(image) }] })).rejects.toThrow('budget')
    expect(c.sent).toHaveLength(2)
  })

  it('summarizes older images as image parts, caches their exact sources and keeps the current request', async () => {
    const c = client(), cache = new Map<string, string>()
    const call = { ...input(), summaryCache: { get: (key: string) => cache.get(key), set: (key: string, value: string) => { cache.set(key, value) } } }
    const image = { type: 'image' as const, mimeType: 'image/png', data: Buffer.alloc(100_000, 0xab).toString('base64') }
    const messages: ModelRequest['messages'] = [
      { role: 'user', content: 'Earlier image', contentParts: [image] },
      { role: 'assistant', content: 'Earlier observations. '.repeat(80) },
      { role: 'user', content: 'Current request; do not send anything.' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'lookup', name: 'lookup', arguments: {} }] },
      { role: 'tool', toolCallId: 'lookup', content: 'Evidence detail '.repeat(80) },
    ]
    await personBudgetedClient(c.port, call).create({ messages })
    const summary = c.sent.find(request => request.messages.some(message => message.contentParts?.length))!
    expect(summary.messages[1].contentParts).toEqual([image])
    expect(summary.messages[1].content).not.toContain(image.data)
    expect(c.sent.at(-1)!.messages.slice(-3)).toEqual(messages.slice(-3))
    const reused = client()
    await personBudgetedClient(reused.port, call).create({ messages })
    expect(reused.sent).toHaveLength(1)
    const changed = client()
    await personBudgetedClient(changed.port, call).create({ messages: [{ ...messages[0], contentParts: [{ ...image, data: Buffer.alloc(100_000, 0xcd).toString('base64') }] }, ...messages.slice(1)] })
    expect(changed.sent.length).toBeGreaterThan(1)
  })

  function longTurn(): ModelRequest {
    const messages: ModelRequest['messages']=[{role:'system',content:'Person instructions'},{role:'user',content:'Do not send anything; investigate only.'}]
    for(let i=0;i<12;i++) messages.push({role:'assistant',content:'',toolCalls:[{id:`t${i}`,name:'lookup',arguments:{}}]},
      {role:'tool',toolCallId:`t${i}`,content:`result ${i}: `+'evidence constraint detail '.repeat(250)})
    return {messages,tools:[{name:'lookup',parameters:{type:'object'}}],maxTokens:2048}
  }
  it.each(['xhigh', undefined] as const)('keeps the chosen %s effort on summary requests as well as the final provider request', async reasoningEffort => {
    const { OpenAIResponsesModelClient } = await import('../../packages/ekko-agent/src/model/providers/openai-responses')
    const bodies: any[] = []
    const port = new OpenAIResponsesModelClient({
      id: 'test', type: 'openai', requestStyle: 'openai-responses',
      baseUrl: 'https://model.example.test/v1', defaultModel: 'gpt-6.1-sol',
      capabilities: { streaming: false, maxInputTokens: 8000 },
    }, { fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)); bodies.push(body)
      if (body.reasoning?.effort === 'none') throw new Error("Unsupported value: 'none' is not supported with the 'gpt-6.1-sol' model")
      return new Response(JSON.stringify({ output_text: 'Saved requirements and verified results.', status: 'completed' }))
    } })
    const wrapped = personBudgetedClient(port, { ...input(), selection: { ...input().selection, model: 'gpt-6.1-sol' } })
    await wrapped.create({ ...longTurn(), model: 'gpt-6.1-sol', reasoningEffort })
    expect(bodies.length).toBeGreaterThan(1)
    expect(bodies.every(body => body.reasoning?.effort === reasoningEffort)).toBe(true)
  })
  it('uses the call effort for streamed summaries and invalidates checkpoints after an effort change', async () => {
    const cache = new Map<string, string>()
    const call = { ...input(), reasoningEffort: 'xhigh' as const, summaryCache: { get: (key: string) => cache.get(key), set: (key: string, value: string) => { cache.set(key, value) } } }
    const first = client()
    for await (const _ of personBudgetedClient(first.port, call).stream(longTurn())) { /* consume */ }
    expect(first.sent.length).toBeGreaterThan(1)
    expect(first.sent.every(request => request.reasoningEffort === 'xhigh')).toBe(true)
    const changed = client()
    await personBudgetedClient(changed.port, call).create({ ...longTurn(), reasoningEffort: 'low' })
    expect(changed.sent.length).toBeGreaterThan(1)
    expect(changed.sent.every(request => request.reasoningEffort === 'low')).toBe(true)
  })
  it('reuses persisted checkpoints across wrappers without compressing on small turns', async () => {
    const cache=new Map<string,string>(); const call={...input(),summaryCache:{get:(k:string)=>cache.get(k),set:(k:string,s:string)=>{cache.set(k,s)}}}
    const first=client(); await personBudgetedClient(first.port,call).create(longTurn())
    expect(cache.size).toBeGreaterThan(0)
    const second=client(); await personBudgetedClient(second.port,call).create(longTurn())
    expect(second.sent).toHaveLength(1)
    expect(second.sent[0].messages).toEqual(first.sent.at(-1)!.messages)
    expect(second.sent[0].messages).toContainEqual(longTurn().messages[1])
    expect(second.sent[0].messages.slice(-2)).toEqual(longTurn().messages.slice(-2))
    const small=client(); await personBudgetedClient(small.port,call).create({messages:[{role:'user',content:'hello'}]})
    expect(small.sent).toHaveLength(1)
  })
  it('invalidates checkpoint keys when source content or selected model changes', async () => {
    const cache=new Map<string,string>(); const call={...input(),summaryCache:{get:(k:string)=>cache.get(k),set:(k:string,s:string)=>{cache.set(k,s)}}}
    await personBudgetedClient(client().port,call).create(longTurn())
    const changed=longTurn(); changed.messages[3].content+=' Revoked permission.'
    const c=client(); await personBudgetedClient(c.port,call).create(changed)
    expect(c.sent.length).toBeGreaterThan(1)
    const other=client(); await personBudgetedClient(other.port,{...call,selection:{...call.selection,model:'other'}}).create(longTurn())
    expect(other.sent.length).toBeGreaterThan(1)
  })
  it('does not cache late summaries after cancellation', async () => {
    const c=client(), abort=new AbortController(), set=vi.fn()
    c.port.create=vi.fn(async()=>{abort.abort(new Error('cancelled'));return {content:'late summary'}})
    await expect(personBudgetedClient(c.port,{...input(),signal:abort.signal,summaryCache:{get:()=>undefined,set}}).create(longTurn())).rejects.toThrow('cancelled')
    expect(set).not.toHaveBeenCalled()
  })
  it('rejects an oversized newest tool batch without silently losing the current request', async () => {
    const c=client(), request=longTurn()
    request.messages.at(-1)!.content='huge current evidence '.repeat(20000)
    await expect(personBudgetedClient(c.port,input()).create(request)).rejects.toThrow('budget')
    expect(c.sent.every(r=>r.messages[0].content.startsWith('Summarize task context'))).toBe(true)
  })
  it('checks every request, strips native continuation, and checks tools as well as messages', async () => {
    const c = client(); const call=input(); call.beforeRequest=vi.fn()
    const wrapped=personBudgetedClient(c.port,call)
    await wrapped.create({messages:[{role:'user',content:'hello'}],context:{native:'unbounded'} as any})
    for await (const _ of wrapped.stream({messages:[{role:'user',content:'next'}],context:{native:'again'} as any})) { /* consume */ }
    expect(c.sent).toHaveLength(2);expect(c.sent.every(r=>r.context===undefined)).toBe(true);expect(call.beforeRequest).toHaveBeenCalledTimes(2)
    await expect(wrapped.create({messages:[{role:'user',content:'hello'}],tools:[{name:'large',description:'many different tokens '.repeat(10000)}]})).rejects.toThrow('budget')
    expect(c.sent).toHaveLength(2)
  })
  it('compresses older history while preserving complete tool-call/result pairs', async () => {
    const c=client(); const wrapped=personBudgetedClient(c.port,input())
    const messages: ModelRequest['messages']=[{role:'system',content:'Person role'}]
    for(let i=0;i<20;i++) messages.push({role:'user',content:'prior user requirement detail '.repeat(70)},{role:'assistant',content:'prior assistant result evidence '.repeat(70)})
    messages.push({role:'user',content:'Current request'},{role:'assistant',content:'',toolCalls:[{id:'t1',name:'lookup',arguments:'{}'}]},{role:'tool',content:'bounded result',toolCallId:'t1'})
    await wrapped.create({messages})
    const last=c.sent.at(-1)!
    expect(c.sent.length).toBeGreaterThan(1)
    expect(last.messages.slice(-3)).toEqual(messages.slice(-3))
    expect(last.messages[0]).toEqual(messages[0])
    expect(last.messages.length).toBeLessThan(messages.length)
  })
  it('fails closed on cancellation and never sends an oversized current tool result', async () => {
    const c=client();const call=input();const abort=new AbortController();call.signal=abort.signal
    abort.abort(new Error('revoked'));await expect(personBudgetedClient(c.port,call).create({messages:[{role:'user',content:'hello'}]})).rejects.toThrow('revoked')
    expect(c.sent).toEqual([])
    await expect(personBudgetedClient(c.port,input()).create({messages:[{role:'user',content:'latest '.repeat(20000)}]})).rejects.toThrow('budget')
    expect(c.sent).toEqual([])
  })
})
