import { expect, it } from 'vitest'
import { assertScopedCodingAgentProviderAllowed } from '../../packages/server/src/modules/studio/contracts/provider-compat'
import { assertWorkflowImportCapabilities } from '../../packages/server/src/modules/studio/services/workflow/import-capabilities'

it.each(['openai-codex', 'xai-oauth', 'copilot'])('allows scoped %s through the Studio gateway while keeping direct-token restrictions', provider => {
  expect(() => assertScopedCodingAgentProviderAllowed('scoped', provider, true)).not.toThrow()
  expect(() => assertScopedCodingAgentProviderAllowed('scoped', provider)).toThrow('OAuth/subscription')
  expect(() => assertWorkflowImportCapabilities([{ id: 'test', data: { agent: 'codex', agentMode: 'scoped', provider, model: 'test-model', apiMode: 'anthropic_messages' } }], [{ provider, models: ['test-model'], api_mode: 'codex_responses' }])).not.toThrow()
})

it('still rejects a workflow model missing from the account gateway catalog', () => {
  expect(() => assertWorkflowImportCapabilities([{ id: 'test', data: { agent: 'codex', agentMode: 'scoped', provider: 'openai-codex', model: 'missing', apiMode: 'codex_responses' } }], [{ provider: 'openai-codex', models: ['test-model'], api_mode: 'codex_responses' }])).toThrow('target capability')
})
