import { expect, it, vi } from 'vitest'

vi.mock('../../packages/server/src/modules/studio/public/provider-account', () => ({ withProviderAccount: (_id: number, run: () => unknown) => run() }))
vi.mock('../../packages/server/src/modules/studio/repositories/users-store', () => ({
  findUserById: (id: number) => ({ id, status: 'active', role: 'admin' }),
  listUserProfiles: () => [{ profile_name: 'work' }], userCanAccessProfile: () => true, getDefaultProfileForUser: () => 'work',
}))
vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({ getActiveProfileName: () => 'work', listProfileNamesFromDisk: () => ['work'] }))
vi.mock('../../packages/server/src/modules/studio/public/agent-status-registry', () => ({ getAgentAvailabilitySnapshot: () => ({ agents: [{ id: 'hermes', installed: true }, { id: 'ekko-agent', installed: true }] }) }))
vi.mock('../../packages/server/src/modules/studio/services/agents/registry', () => ({ agentDescriptors: () => [], isPluginAgentId: () => false }))
vi.mock('../../packages/server/src/modules/studio/public/session-agent-runtime', () => ({ getSessionAvailableModelGroups: async () => [{
  provider: 'custom:relay', models: ['old-model', 'new-model'], api_mode: 'chat_completions',
  api_mode_by_model: { 'old-model': 'anthropic_messages', 'new-model': 'codex_responses' },
}] }))
vi.mock('../../packages/server/src/modules/studio/repositories/person-store', () => ({ personSettings: () => ({ settings: { agents: [] } }) }))
vi.mock('../../packages/server/src/modules/studio/services/compression-policy', () => ({ readCompressionPolicy: () => ({}) }))
vi.mock('../../packages/server/src/modules/studio/public/provider-runtime', () => ({ getModelContextLength: () => 64000 }))
vi.mock('../../packages/server/src/modules/studio/public/model-routing', () => ({ logicalModelSelection: (_profile: string, provider: string, model: string) => ({ provider, model }) }))

import { personSelectionApiMode, validatePersonSelection } from '../../packages/server/src/modules/studio/services/person/catalog'
import { validatePersonAgents } from '../../packages/server/src/modules/studio/services/person/agents'

it.each(['hermes', 'ekko'])('saves a changed %s Bot model alongside an existing Hermes preset with a different HTTP protocol', async runtime => {
  const agents = [
    { id: 'existing', name: 'Existing Hermes', description: 'Keep this preset', selection: {
      runtime: 'hermes', mode: 'scoped' as const, profile: 'work', provider: 'custom:relay', model: 'old-model', apiMode: 'chat_completions', reasoningEffort: 'high',
    } },
    { id: 'edited', name: 'Edited executor', description: 'Use the new model', selection: {
      runtime, mode: 'scoped' as const, profile: 'work', provider: 'custom:relay', model: 'new-model', apiMode: 'codex_responses', reasoningEffort: '',
    } },
  ]
  expect(await validatePersonAgents(2, agents)).toEqual(agents)
  await expect(validatePersonSelection(2, agents[0]!.selection)).resolves.toBeUndefined()
})

it.each(['chat_completions', 'codex_responses', 'anthropic_messages'])('keeps a saved Hermes %s choice through the HTTP gateway', requested => {
  const configured = requested === 'chat_completions' ? 'anthropic_messages' : 'chat_completions'
  expect(personSelectionApiMode({ provider: 'custom:relay', api_mode: configured }, 'model', requested, 'hermes')).toBe(requested)
})

it('accepts a Hermes HTTP protocol for an OAuth provider', () => {
  expect(personSelectionApiMode({ provider: 'openai-codex' }, 'model', 'anthropic_messages', 'hermes')).toBe('anthropic_messages')
})

it('inherits the per-model protocol when an older Hermes preset has no saved protocol', async () => {
  const agents = await validatePersonAgents(2, [{ id: 'legacy', name: 'Legacy', description: 'Inherited protocol', selection: {
    runtime: 'hermes', mode: 'scoped', profile: 'work', provider: 'custom:relay', model: 'old-model',
  } }])
  expect(agents[0]!.selection.apiMode).toBe('anthropic_messages')
})

it.each(['bedrock_converse', 'codex_app_server'])('preserves native %s restrictions', configured => {
  const group = { provider: 'native', api_mode: configured }
  expect(personSelectionApiMode(group, 'model', configured, 'hermes')).toBe(configured)
  expect(() => personSelectionApiMode(group, 'model', 'chat_completions', 'hermes')).toThrow('Runtime does not support this model protocol')
  expect(() => personSelectionApiMode(group, 'model', 'codex_responses', 'ekko')).toThrow('Runtime does not support this model protocol')
})

it('rejects unknown protocols instead of treating them as gateway modes', () => {
  expect(() => personSelectionApiMode({ provider: 'custom:relay', api_mode: 'chat_completions' }, 'model', 'unknown', 'hermes')).toThrow('Unsupported model protocol')
})
