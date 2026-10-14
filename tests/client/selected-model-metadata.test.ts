// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref, type EffectScope } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { useSelectedModelMetadata } from '@/composables/useSelectedModelMetadata'
import { modelReasoningEfforts, hasModelReasoningMetadata } from '@/utils/model-reasoning-effort'
import type { AvailableModelGroup } from '@/api/hermes/system'

const mocks = vi.hoisted(() => ({ load: vi.fn(), invalidate: undefined as (() => void) | undefined }))
vi.mock('@/api/hermes/system', () => ({ fetchModelMetadata: mocks.load }))
vi.mock('@/api/client', () => ({ getBaseUrl: () => 'test-server', getStoredUserId: () => 1, hasApiKey: () => true }))
vi.mock('@/api/auth-invalidation', () => ({ onAuthInvalidated: (fn: () => void) => { mocks.invalidate = fn } }))
const scopes: EffectScope[] = []
function use(groups: () => AvailableModelGroup[], selections: () => any[], enabled?: () => boolean) {
  const scope = effectScope(); scopes.push(scope)
  return scope.run(() => useSelectedModelMetadata(groups, selections, enabled))!
}
beforeEach(() => { mocks.invalidate?.(); mocks.load.mockReset() })
afterEach(() => { scopes.splice(0).forEach(scope => scope.stop()) })

describe('selected model metadata', () => {
  it('loads only selected models, deduplicates consumers, and preserves display metadata', async () => {
    mocks.load.mockResolvedValue({ reasoning: true, reasoning_efforts: ['low', 'high'] })
    const groups = ref<AvailableModelGroup[]>([{ provider: 'custom:gateway', label: 'Gateway', api_key: '', base_url: 'https://gateway.test',
      models: Array.from({ length: 3000 }, (_, i) => `model-${i}`), model_meta: { 'model-0': { alias: 'Work', preview: true }, 'model-1': { disabled: true } } }])
    const selection = () => [{ profile: 'research', provider: 'custom:gateway', model: 'model-0' }]
    const first = use(() => groups.value, selection)
    const second = use(() => groups.value, selection)
    expect(mocks.load).toHaveBeenCalledOnce()
    expect(mocks.load).toHaveBeenCalledWith({ ...selection()[0], baseUrl: 'https://gateway.test' })
    expect(hasModelReasoningMetadata(first.value, 'custom:gateway', 'model-0')).toBe(false)
    await flushPromises()
    expect(modelReasoningEfforts(first.value, 'custom:gateway', 'model-0')).toEqual(['low', 'high'])
    expect(second.value[0].model_meta?.['model-0']).toEqual({ alias: 'Work', preview: true, reasoning: true, reasoning_efforts: ['low', 'high'] })
    expect(first.value[0].model_meta?.['model-1']).toEqual({ disabled: true })
    expect(groups.value[0].model_meta?.['model-0']).toEqual({ alias: 'Work', preview: true })
  })
  it('isolates profile and endpoint changes and ignores late results from the old selection', async () => {
    let complete!: (value: any) => void
    mocks.load.mockImplementationOnce(() => new Promise(resolve => { complete = resolve })).mockResolvedValue({ reasoning: false })
    const profile = ref('first')
    const groups = ref<AvailableModelGroup[]>([{ provider: 'custom:gateway', label: 'Gateway', api_key: '', base_url: 'https://first.test', models: ['model'] }])
    const result = use(() => groups.value, () => [{ profile: profile.value, provider: 'custom:gateway', model: 'model' }])
    profile.value = 'second'; groups.value[0].base_url = 'https://second.test'
    await nextTick(); await flushPromises()
    expect(modelReasoningEfforts(result.value, 'custom:gateway', 'model')).toEqual([])
    complete({ reasoning_efforts: ['ultra'] }); await flushPromises()
    expect(modelReasoningEfforts(result.value, 'custom:gateway', 'model')).toEqual([])
    expect(mocks.load).toHaveBeenCalledTimes(2)
  })
  it('does no work for inactive editors, virtual MoA models, or already known capabilities', async () => {
    const enabled = ref(false)
    const model = ref('known')
    const provider = ref('provider')
    const groups = ref<AvailableModelGroup[]>([{ provider: 'provider', label: '', api_key: '', base_url: '', models: ['known'], model_meta: { known: { reasoning: false } } }])
    use(() => groups.value, () => [{ provider: provider.value, model: model.value }], () => enabled.value)
    enabled.value = true; await nextTick()
    provider.value = 'moa'; model.value = 'team'; await nextTick()
    expect(mocks.load).not.toHaveBeenCalled()
  })
  it('keeps capability validation pending on errors and caches unknown results', async () => {
    mocks.load.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({})
    const model = ref('first')
    const groups = () => [{ provider: 'provider', label: '', api_key: '', base_url: '', models: ['first', 'private'] }]
    const result = use(groups, () => [{ provider: 'provider', model: model.value }])
    await flushPromises()
    expect(hasModelReasoningMetadata(result.value, 'provider', 'first')).toBe(false)
    model.value = 'private'; await nextTick(); await flushPromises()
    use(groups, () => [{ provider: 'provider', model: 'private' }])
    expect(mocks.load).toHaveBeenCalledTimes(2)
    expect(hasModelReasoningMetadata(result.value, 'provider', 'private')).toBe(false)
  })
})
