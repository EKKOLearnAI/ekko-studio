import { afterEach, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('../../packages/client/src/api/coding-agents', () => ({ fetchCodingAgentModels: mocks.fetch }))
vi.mock('../../packages/client/src/api/client', () => ({ getBaseUrl: () => 'fixture', getStoredUserId: () => 1, getActiveProfileName: () => 'default' }))
vi.mock('../../packages/client/src/api/auth-invalidation', () => ({ onAuthInvalidated() {} }))
import { useCodingAgentModels } from '../../packages/client/src/composables/useCodingAgentModels'

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })
it('keeps plugin model catalogs separated by Profile even when the earlier request finishes last', async () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {} })
  let finishFirst!: () => void
  const first = new Promise<void>(resolve => { finishFirst = resolve })
  mocks.fetch.mockImplementation(async ({ agent, profile }) => {
    if (profile === 'first') await first
    return { agents: [{ agentId: agent, status: 'ready', models: [{ id: profile, name: profile }] }] }
  })
  const profile = ref('first'), scope = effectScope()
  try {
    const models = scope.run(() => useCodingAgentModels(() => 'plugin:omp/omp', () => true, () => profile.value))!
    profile.value = 'second'; await nextTick()
    await vi.waitFor(() => expect(models.catalog.value?.models[0].id).toBe('second'))
    finishFirst()
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledWith({ agent: 'plugin:omp/omp', refresh: false, profile: 'first' }))
    await nextTick()
    expect(models.catalog.value?.models[0].id).toBe('second')
    expect(mocks.fetch).toHaveBeenCalledWith({ agent: 'plugin:omp/omp', refresh: false, profile: 'second' })
  } finally { finishFirst(); scope.stop() }
})
