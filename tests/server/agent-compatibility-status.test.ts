import { afterEach, expect, it } from 'vitest'
import { getAgentStatusSnapshot, getAgentAvailabilitySnapshot, resetAgentStatusRegistryForTests, updateAgentStatus } from '../../packages/server/src/modules/studio/public/agent-status-registry'
afterEach(resetAgentStatusRegistryForTests)
it('keeps compatibility controls available in cached status and isolates snapshot edits', () => {
  updateAgentStatus('dsh', { installed: true, compatibility: { adapterRevision: 5, verifiedVersion: '0.2.2-rc.1', pinnedVersion: '', previousVersion: '0.2.1-rc.5' } })
  const first = getAgentStatusSnapshot().agents.find(agent => agent.id === 'dsh')!
  expect(first.compatibility?.previousVersion).toBe('0.2.1-rc.5')
  first.compatibility!.previousVersion = 'mutated'
  expect(getAgentStatusSnapshot().agents.find(agent => agent.id === 'dsh')?.compatibility?.previousVersion).toBe('0.2.1-rc.5')
  expect(getAgentAvailabilitySnapshot().agents.find(agent => agent.id === 'dsh')).not.toHaveProperty('compatibility')
})
