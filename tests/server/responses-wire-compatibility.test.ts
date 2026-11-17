import { expect, it } from 'vitest'
import { normalizeResponsesSseEvents, openAiChatSseToResponsesEvents } from '../../packages/server/src/modules/coding-agents/protocol/adapters/responses-stream'
import { geminiToResponses, responsesToGemini, responsesEventsToGemini } from '../../packages/server/src/modules/coding-agents/services/antigravity/gemini-adapter'
import { withoutUnsupportedReasoning } from '../../packages/server/src/modules/studio/services/providers/codex-requests'

it('omits subscription transport metadata while preserving inference events and usage for typed clients', async () => {
  async function* upstream() {
    yield { type: 'response.created', data: { type: 'response.created', response: { id: 'r1', output: [] } } }
    yield { type: 'response.metadata', data: { type: 'response.metadata', private: 'transport-only' } }
    yield { type: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: 'OK' } }
    yield { type: 'response.completed', data: { type: 'response.completed', response: { id: 'r1', output: [], usage: { input_tokens: 2, output_tokens: 1 } } } }
  }
  const events = []
  for await (const event of normalizeResponsesSseEvents(upstream())) events.push(event)
  expect(events.map(event => event.type)).toEqual(['response.created', 'response.output_text.delta', 'response.completed'])
  expect(events[1].data.delta).toBe('OK')
  expect((events[2].data.response as any).usage).toEqual({ input_tokens: 2, output_tokens: 1 })
})

it('carries URL-safe reasoning signatures as Gemini bytes and recovers them unchanged on replay', async () => {
  const signature = 'gAAAA_probe-with-url_safe.characters=='
  const response = { output: [{ type: 'reasoning', encrypted_content: signature }] }
  const json = responsesToGemini(response)
  const part = json.candidates[0].content.parts[0]
  expect(part.thoughtSignature).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
  expect(geminiToResponses({ contents: [json.candidates[0].content] }).input).toEqual([{ type: 'reasoning', encrypted_content: signature }])
  async function* upstream() {
    yield { type: 'response.output_item.done', data: { item: response.output[0] } }
    yield { type: 'response.completed', data: { response: { output: [], usage: {} } } }
  }
  const chunks = []
  for await (const chunk of responsesEventsToGemini(upstream())) chunks.push(chunk)
  expect(JSON.parse(chunks[0].slice(6)).candidates[0].content.parts[0]).toEqual(part)
})

it('removes reasoning controls only for a known non-reasoning model', () => {
  const body = { input: 'hi', reasoning: { effort: 'low' }, reasoning_effort: 'low', thinking: { type: 'enabled' } }
  expect(withoutUnsupportedReasoning(body, false)).toEqual({ input: 'hi' })
  expect(withoutUnsupportedReasoning(body, true)).toBe(body)
  expect(body.reasoning).toEqual({ effort: 'low' })
})

it('ignores native Gemini sentinel signatures instead of passing them to another Provider for decryption', () => {
  expect(geminiToResponses({ contents: [{ role: 'model', parts: [{ thoughtSignature: 'skip_thought_signature_validator', functionCall: { name: 'read', args: {} } }] }] }).input)
    .toEqual([expect.objectContaining({ type: 'function_call', name: 'read' })])
})

it('relays upstream keep-alive comments as Responses activity before model output arrives', async () => {
  let modelOutputRead = false
  async function* upstream() {
    yield Buffer.from(': keep-alive\n\n')
    modelOutputRead = true
    yield Buffer.from('data: {"choices":[{"delta":{"content":"OK"}}]}\n\n')
    yield Buffer.from('data: [DONE]\n\n')
  }
  const events = openAiChatSseToResponsesEvents(upstream(), { model: 'deepseek-v4-pro' })
  expect((await events.next()).value?.type).toBe('response.created')
  const heartbeat = (await events.next()).value
  expect(heartbeat).toMatchObject({ type: 'response.in_progress', data: { response: { status: 'in_progress', output: [] } } })
  expect(modelOutputRead).toBe(false)
  const remaining = []
  for await (const event of events) remaining.push(event)
  expect(remaining.find(event => event.type === 'response.output_text.delta')?.data.delta).toBe('OK')
  expect(remaining.at(-1)?.type).toBe('response.completed')
})
