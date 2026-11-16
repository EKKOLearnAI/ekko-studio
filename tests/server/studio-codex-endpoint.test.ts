import { expect, it } from 'vitest'
import { responsesUrl } from '../../packages/server/src/modules/coding-agents/protocol/endpoint-resolver'
import { codexInferenceBody, isCodexInferenceRequest } from '../../packages/server/src/modules/studio/services/providers/codex-requests'

it.each([
  ['https://chatgpt.com/backend-api/codex', 'https://chatgpt.com/backend-api/codex/responses'],
  ['https://chatgpt.com/backend-api/codex/', 'https://chatgpt.com/backend-api/codex/responses'],
  ['https://chatgpt.com/backend-api/codex/responses', 'https://chatgpt.com/backend-api/codex/responses'],
  ['https://api.openai.com/v1', 'https://api.openai.com/v1/responses'],
  ['https://relay.invalid', 'https://relay.invalid/v1/responses'],
  ['http://127.0.0.1:8648/api/ekko-studio/models/v1', 'http://127.0.0.1:8648/api/ekko-studio/models/v1/responses'],
])('resolves the Responses endpoint from %s', (base, expected) => expect(responsesUrl(base)).toBe(expected))

it('applies subscription constraints only to Codex requests and keeps its reasoning and tool fields', () => {
  expect(isCodexInferenceRequest({ provider: 'openai-codex', url: 'https://relay.invalid/responses' })).toBe(true)
  expect(isCodexInferenceRequest({ provider: 'custom:relay', url: 'https://chatgpt.com/backend-api/codex/responses' })).toBe(true)
  expect(isCodexInferenceRequest({ provider: 'openai', url: 'https://api.openai.com/v1/responses' })).toBe(false)
  const body = codexInferenceBody({ input: 'hi', instructions: 'policy', temperature: 0.5, max_output_tokens: 10, stream: false, store: true, tools: [{ type: 'function', name: 'read' }], reasoning: { effort: 'high' } })
  expect(body).toMatchObject({ instructions: 'policy', stream: true, store: false, reasoning: { effort: 'high' }, tools: [{ type: 'function', name: 'read' }] })
  expect(body).not.toHaveProperty('temperature')
  expect(body).not.toHaveProperty('max_output_tokens')
  expect(codexInferenceBody(body)).toEqual(body)
})
