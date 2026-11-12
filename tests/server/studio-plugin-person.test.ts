import { beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ id: 'plugin:omp/omp', modes: ['global', 'scoped'], surfaces: ['chat'], status: vi.fn(), models: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/repositories/users-store', () => ({
  findUserById: (id: number) => ({ id, status: 'active', role: 'admin', profiles: ['work', 'other'] }),
  listUserProfiles: () => [{ profile_name: 'work' }, { profile_name: 'other' }], userCanAccessProfile: () => true, getDefaultProfileForUser: () => 'work',
}))
vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({ getActiveProfileName: () => 'work', listProfileNamesFromDisk: () => ['work', 'other'] }))
vi.mock('../../packages/server/src/modules/studio/public/agent-status-registry', () => ({ getAgentAvailabilitySnapshot: () => ({ agents: [{ id: 'ekko-agent', installed: true }, { id: 'codex', installed: true }] }) }))
vi.mock('../../packages/server/src/modules/studio/public/session-agent-runtime', () => ({ getSessionAvailableModelGroups: async () => [{ provider: 'custom:fixture', models: ['fixture'], api_mode: 'chat_completions' }] }))
vi.mock('../../packages/server/src/modules/studio/public/person-runtime', () => ({ personRuntime: () => ({ nativeModels: state.models }) }))
vi.mock('../../packages/server/src/modules/studio/repositories/person-store', () => ({ personSettings: () => ({ settings: {} }) }))
vi.mock('../../packages/server/src/modules/studio/services/compression-policy', () => ({ readCompressionPolicy: () => ({}) }))
vi.mock('../../packages/server/src/modules/studio/public/provider-runtime', () => ({ getModelContextLength: () => 64000 }))
vi.mock('../../packages/server/src/modules/studio/services/agents/registry', () => {
  const descriptor = () => ({ id: state.id, name: 'OMP', origin: 'plugin', modes: state.modes, surfaces: state.surfaces })
  return { agentDescriptors: () => [descriptor()], agentDescriptor: (id: string) => id === state.id ? descriptor() : undefined,
    agentStatus: state.status, isPluginAgentId: (id: string) => id.startsWith('plugin:') }
})
import { personCapabilities, validatePersonSelection } from '../../packages/server/src/modules/studio/services/person/catalog'
import { validatePersonAgents } from '../../packages/server/src/modules/studio/services/person/agents'
const selection = () => ({ runtime: state.id, mode: 'global' as const, profile: 'work', provider: '', model: 'custom/fixture', reasoningEffort: '' })
beforeEach(() => {
  vi.clearAllMocks(); state.id = 'plugin:omp/omp'; state.modes = ['global', 'scoped']; state.surfaces = ['chat']
  state.status.mockImplementation(async (_id, identity) => ({ installed: identity.profile === 'work' }))
  state.models.mockResolvedValue({ status: 'ready', models: [{ id: 'custom/fixture', name: 'Fixture' }] })
})
it('exposes plugin Bot executors with metadata and installation status in the actual Profile', async () => {
  expect(await personCapabilities(2)).toContainEqual(expect.objectContaining({ runtime: state.id, installed: true, descriptor: expect.objectContaining({ id: state.id }) }))
  expect(await personCapabilities(2, 'other')).toContainEqual(expect.objectContaining({ runtime: state.id, installed: false }))
  expect(state.status).toHaveBeenCalledWith(state.id, { userId: 2, profile: 'other', surface: 'ui' })
})
it('validates native plugin models using the selected user and Profile without granting native CLI credentials', async () => {
  await validatePersonSelection(2, selection())
  expect(state.models).toHaveBeenCalledWith(state.id, { userId: 2, profile: 'work' })
  await expect(validatePersonSelection(2, { ...selection(), runtime: 'codex' })).rejects.toThrow('Native machine credentials')
})
it('rejects unsupported modes, surfaces, unavailable installations and changed models', async () => {
  state.modes = ['scoped']
  await expect(validatePersonSelection(2, selection())).rejects.toThrow('does not support this mode')
  state.modes = ['global']; state.surfaces = ['workflow']
  await expect(validatePersonSelection(2, selection())).rejects.toThrow('not installed')
  state.surfaces = ['chat']
  await expect(validatePersonSelection(2, { ...selection(), profile: 'other' })).rejects.toThrow('not installed')
  await expect(validatePersonSelection(2, { ...selection(), model: 'missing' })).rejects.toThrow('Native model unavailable')
})
it('accepts full plugin IDs when saving a Bot execution preset', async () => {
  state.id = `plugin:${'p'.repeat(40)}/assistant`
  expect(await validatePersonAgents(2, [{ id: 'developer', name: '开发者', description: '开发任务', selection: selection() }])).toMatchObject([{ selection: { runtime: state.id } }])
})
