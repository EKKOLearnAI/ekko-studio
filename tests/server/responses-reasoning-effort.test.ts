import { expect, it } from 'vitest'
import { responsesToOpenAiChat } from '../../packages/server/src/modules/coding-agents/protocol/adapters/responses'

it.each([false, true])('maps the Responses request effort without mutating input (stream=%s)', stream => {
  const body = { model: 'gemini-4-argon', input: 'ping', reasoning: { effort: 'high', summary: 'auto' } }
  const original = structuredClone(body)
  const result = responsesToOpenAiChat(body, { model: 'gemini-4-argon' }, stream)
  expect(result.reasoning_effort).toBe('high')
  expect(result.stream).toBe(stream)
  expect(body).toEqual(original)
})

it.each(['none', 'low', 'high'])('keeps explicit route effort %s ahead of the request', reasoningEffort => {
  const target = { model: 'gemini-4-argon', reasoningEffort }
  expect(responsesToOpenAiChat({ input: 'ping', reasoning: { effort: 'medium' } }, target).reasoning_effort).toBe(reasoningEffort)
})

it.each([undefined, null, '', 'unknown', {}, 42])('omits unsupported request effort %j', effort => {
  expect(responsesToOpenAiChat({ input: 'ping', reasoning: { effort } }, { model: 'model' })).not.toHaveProperty('reasoning_effort')
})

it('normalizes a request value using the existing effort policy', () => {
  expect(responsesToOpenAiChat({ input: 'ping', reasoning: { effort: ' low ' } }, { model: 'model' }).reasoning_effort).toBe('low')
})
