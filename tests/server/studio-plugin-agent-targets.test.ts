import { afterEach, expect, it } from 'vitest'
import { configurePluginAgents, pluginAgentIsGlobalOnly } from '../../packages/server/src/modules/studio/services/agents/registry'
import { normalizeGroupAgentPresetInput } from '../../packages/server/src/modules/studio/services/group-chat/agent-presets'

const id = 'plugin:custom-agent/assistant'
afterEach(() => configurePluginAgents(() => []))
function register(modes: string[]) {
  configurePluginAgents(() => [{ descriptor: () => ({ id, modes }) }] as any)
}
it('preserves namespaced plugin Agent identity and native models in global presets', () => {
  register(['global', 'scoped'])
  expect(normalizeGroupAgentPresetInput({ agent: id, agentMode: 'global', profile: 'work', model: 'native-model', name: 'My Agent' }))
    .toMatchObject({ agent: id, agentMode: 'global', provider: '', model: 'native-model', apiMode: '' })
})
it('defaults global-only plugins to their native mode without requiring a Studio provider', () => {
  register(['global'])
  expect(pluginAgentIsGlobalOnly(id)).toBe(true)
  expect(normalizeGroupAgentPresetInput({ agent: id, profile: 'work', name: 'My Agent' }))
    .toMatchObject({ agent: id, agentMode: 'global', provider: '', apiMode: '' })
})
it('retains Studio provider bindings for scoped plugins', () => {
  register(['scoped'])
  expect(pluginAgentIsGlobalOnly(id)).toBe(false)
  expect(normalizeGroupAgentPresetInput({ agent: id, profile: 'work', name: 'My Agent', provider: 'custom:test', model: 'selected', apiMode: 'chat_completions' }))
    .toMatchObject({ agent: id, agentMode: 'scoped', provider: 'custom:test', model: 'selected', apiMode: 'chat_completions' })
})
