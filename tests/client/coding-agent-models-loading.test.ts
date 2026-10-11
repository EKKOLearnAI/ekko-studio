// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { useCodingAgentModels } from '../../packages/client/src/composables/useCodingAgentModels'
import { invalidateAuth } from '@/api/auth-invalidation'
import type { CodingAgentId, CodingAgentModelCatalog } from '../../packages/client/src/api/coding-agents'

const fetchModels = vi.hoisted(() => vi.fn())
vi.mock('@/api/coding-agents', () => ({ fetchCodingAgentModels: fetchModels }))
vi.mock('@/api/client', () => ({
  getBaseUrl: () => localStorage.getItem('hermes_server_url') || '',
  getStoredUserId: () => Number(localStorage.getItem('test_account') || 1),
}))
beforeEach(() => { invalidateAuth(); localStorage.clear() })
afterEach(() => vi.resetAllMocks())

function response(agentId: CodingAgentId = 'codex', id = 'native-model', status: CodingAgentModelCatalog['status'] = 'ready') {
  return { agents: [{ agentId, name: agentId, status, source: 'cli', scope: 'available', models: [{ id, name: id }] }] }
}

describe('native model catalog loading', () => {
  it('ignores an older agent response after the user switches agents', async () => {
    let finishCodex!: (value: any) => void
    fetchModels.mockImplementation(({ agent }) => agent === 'codex'
      ? new Promise(resolve => { finishCodex = resolve })
      : Promise.resolve(response('pi', 'pi-native')))
    const agent = ref<CodingAgentId>('codex'), scope = effectScope()
    const state = scope.run(() => useCodingAgentModels(() => agent.value, () => true))!
    agent.value = 'pi'
    await nextTick()
    await vi.waitFor(() => expect(state.catalog.value?.agentId).toBe('pi'))
    finishCodex(response('codex', 'old-native'))
    await nextTick()
    expect(state.catalog.value?.agentId).toBe('pi')
    expect(state.loading.value).toBe(false)
    scope.stop()
  })

  it('clears loading on failures and bypasses the server cache on refresh', async () => {
    fetchModels.mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValueOnce(response())
    const scope = effectScope(), state = scope.run(() => useCodingAgentModels(() => 'codex', () => true))!
    await vi.waitFor(() => expect(state.loading.value).toBe(false))
    expect(state.catalog.value).toBeUndefined()
    await state.reload(true)
    expect(fetchModels).toHaveBeenLastCalledWith({ agent: 'codex', refresh: true })
    expect(state.catalog.value?.agentId).toBe('codex')
    scope.stop()
  })

  it('shows the first successful catalog immediately on reopen while refreshing in the background', async () => {
    let finishRefresh!: (value: any) => void
    fetchModels.mockResolvedValueOnce(response()).mockImplementationOnce(() => new Promise(resolve => { finishRefresh = resolve }))
    const enabled = ref(true), scope = effectScope()
    const state = scope.run(() => useCodingAgentModels(() => 'codex', () => enabled.value))!
    await vi.waitFor(() => expect(state.catalog.value?.models[0].id).toBe('native-model'))
    enabled.value = false
    await nextTick()
    enabled.value = true
    await nextTick()
    expect(state.catalog.value?.models[0].id).toBe('native-model')
    expect(state.loading.value).toBe(true)
    finishRefresh(response('codex', 'updated-model'))
    await vi.waitFor(() => expect(state.catalog.value?.models[0].id).toBe('updated-model'))
    scope.stop()
  })

  it('hydrates successful discoveries from storage after client memory is discarded', async () => {
    fetchModels.mockResolvedValueOnce(response())
    const first = effectScope()
    const state = first.run(() => useCodingAgentModels(() => 'codex', () => true))!
    await vi.waitFor(() => expect(state.loading.value).toBe(false))
    first.stop()
    invalidateAuth()
    let finishRefresh!: (value: any) => void
    fetchModels.mockImplementationOnce(() => new Promise(resolve => { finishRefresh = resolve }))
    const second = effectScope()
    const restored = second.run(() => useCodingAgentModels(() => 'codex', () => true))!
    expect(restored.catalog.value?.models[0].id).toBe('native-model')
    expect(restored.loading.value).toBe(true)
    finishRefresh(response())
    await restored.reload()
    second.stop()
  })

  it.each(['network', 'timeout', 'missing'])('retains cached models when background refresh fails: %s', async failure => {
    fetchModels.mockResolvedValueOnce(response())
    const scope = effectScope(), state = scope.run(() => useCodingAgentModels(() => 'codex', () => true))!
    await vi.waitFor(() => expect(state.loading.value).toBe(false))
    if (failure === 'network') fetchModels.mockRejectedValueOnce(new Error('Offline'))
    else fetchModels.mockResolvedValueOnce(failure === 'missing' ? { agents: [] } : response('codex', 'ignored', 'timeout'))
    await state.reload(true)
    expect(state.catalog.value?.models[0].id).toBe('native-model')
    expect(state.refreshFailed.value).toBe(true)
    expect(state.loading.value).toBe(false)
    scope.stop()
  })

  it('shares discovery and refresh requests between draft and active conversation consumers', async () => {
    let finish!: (value: any) => void
    fetchModels.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const first = effectScope(), second = effectScope()
    const a = first.run(() => useCodingAgentModels(() => 'codex', () => true))!
    const b = second.run(() => useCodingAgentModels(() => 'codex', () => true))!
    const refresh = b.reload(true)
    expect(fetchModels).toHaveBeenCalledTimes(1)
    first.stop()
    finish(response())
    await refresh
    expect(b.catalog.value?.models[0].id).toBe('native-model')
    expect(a.catalog.value?.models[0].id).toBe('native-model')
    second.stop()
  })

  it.each(['server', 'account'])('isolates catalogs when the %s changes', async identity => {
    fetchModels.mockResolvedValueOnce(response()).mockResolvedValueOnce(response('codex', 'other-model'))
    const scope = effectScope(), enabled = ref(true)
    const state = scope.run(() => useCodingAgentModels(() => 'codex', () => enabled.value))!
    await vi.waitFor(() => expect(state.loading.value).toBe(false))
    enabled.value = false
    await nextTick()
    localStorage.setItem(identity === 'server' ? 'hermes_server_url' : 'test_account', identity === 'server' ? 'https://another.invalid' : '2')
    enabled.value = true
    await nextTick()
    expect(state.catalog.value?.models[0].id).not.toBe('native-model')
    await vi.waitFor(() => expect(state.catalog.value?.models[0].id).toBe('other-model'))
    scope.stop()
  })
})
