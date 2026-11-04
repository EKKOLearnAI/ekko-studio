import { expect, it, vi } from 'vitest'
const preset = { id: 'backend', name: '后端工程师', selection: { runtime: 'codex', mode: 'global', profile: 'default', provider: '', model: '' } }
vi.mock('../../packages/server/src/modules/studio/repositories/person-store', () => ({ personSettings: () => ({ settings: { agents: [preset] } }) }))
vi.mock('../../packages/server/src/modules/studio/services/person/catalog', () => ({ validatePersonSelection: vi.fn(), personProfiles: () => ['default'] }))
import { selectPersonExecutionAgent } from '../../packages/server/src/modules/studio/services/person/agents'
it('captures the selected preset identity without mutating the reusable preset', async () => {
  const selected = await selectPersonExecutionAgent(1, 'backend')
  expect(selected).toMatchObject({ agentId: 'backend', agentName: '后端工程师', runtime: 'codex' })
  expect(preset.selection).not.toHaveProperty('agentName')
  preset.name = '改名后的工程师'
  expect(selected.agentName).toBe('后端工程师')
  await expect(selectPersonExecutionAgent(1, 'missing')).rejects.toThrow('Choose one')
})
