// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { enableAutoUnmount, flushPromises, shallowMount } from '@vue/test-utils'
import { NAlert, NButton, NInputNumber, NSelect } from 'naive-ui'

const api = vi.hoisted(() => ({ request: vi.fn(), fetchAvailableModelsForProfile: vi.fn() }))
const profile = vi.hoisted(() => ({ activeProfileName: 'research' }))

vi.mock('@/api/client', () => ({ request: api.request }))
vi.mock('@/api/hermes/system', () => ({ fetchAvailableModelsForProfile: api.fetchAvailableModelsForProfile }))
vi.mock('@/stores/hermes/profiles', () => ({ useProfilesStore: () => profile }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))

import UsagePricing from '@/components/hermes/usage/UsagePricing.vue'

enableAutoUnmount(afterEach)

const groups = [
  { provider: 'custom:relay', label: 'My Relay', models: ['added-model'], available_models: ['added-model', 'hidden-model'] },
  { provider: 'custom:other', label: 'Other Relay', models: ['other-model'] },
]

function mountPricing() {
  return shallowMount(UsagePricing, {
    global: {
      renderStubDefaultSlot: true,
      stubs: {
        NModal: defineComponent({
          props: ['show'],
          template: '<div v-if="show"><slot /><slot name="footer" /></div>',
        }),
      },
    },
  })
}

type PricingWrapper = ReturnType<typeof mountPricing>

async function clickButton(wrapper: PricingWrapper, label: string) {
  wrapper.findAllComponents(NButton).find(button => button.text() === label)!.vm.$emit('click')
  await flushPromises()
}

describe('UsagePricing provider and model selection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    profile.activeProfileName = 'research'
    api.request.mockResolvedValue({ rates: [] })
    api.fetchAvailableModelsForProfile.mockResolvedValue({ groups })
  })

  it('loads the active Profile and saves the configured provider and canonical model IDs', async () => {
    const wrapper = mountPricing()
    await clickButton(wrapper, 'usage.pricing.title')
    expect(api.fetchAvailableModelsForProfile).toHaveBeenCalledWith('research')
    await clickButton(wrapper, 'common.add')
    const [provider, model] = wrapper.findAllComponents(NSelect)
    expect(provider.props('options')).toEqual([
      { label: 'global', value: 'global' },
      { label: 'My Relay', value: 'custom:relay' },
      { label: 'Other Relay', value: 'custom:other' },
    ])
    provider.vm.$emit('update:value', 'custom:relay')
    await flushPromises()
    expect(model.props('options')).toEqual([
      { label: 'added-model', value: 'added-model' },
      { label: 'hidden-model', value: 'hidden-model' },
    ])
    model.vm.$emit('update:value', 'added-model')
    const [input, output] = wrapper.findAllComponents(NInputNumber)
    input.vm.$emit('update:value', 2)
    output.vm.$emit('update:value', 8)
    await clickButton(wrapper, 'common.save')
    expect(api.request).toHaveBeenLastCalledWith('/api/studio/usage/pricing', {
      method: 'PUT', body: JSON.stringify({ rates: [{ provider: 'custom:relay', model: 'added-model', input: 2, output: 8 }] }),
    })
  })

  it('clears the model when switching providers and offers all configured models for global', async () => {
    api.request.mockResolvedValue({ rates: [{ provider: 'custom:relay', model: 'added-model', input: 2, output: 8 }] })
    const wrapper = mountPricing()
    await clickButton(wrapper, 'usage.pricing.title')
    const [provider, model] = wrapper.findAllComponents(NSelect)
    provider.vm.$emit('update:value', 'custom:relay')
    await flushPromises()
    expect(model.props('value')).toBe('added-model')
    provider.vm.$emit('update:value', 'custom:other')
    await flushPromises()
    expect(model.props('value')).toBe('')
    expect(model.props('options')).toEqual([{ label: 'other-model', value: 'other-model' }])
    provider.vm.$emit('update:value', 'global')
    await flushPromises()
    expect(model.props('options')).toEqual([
      { label: 'added-model', value: 'added-model' },
      { label: 'hidden-model', value: 'hidden-model' },
      { label: 'other-model', value: 'other-model' },
    ])
  })

  it('keeps saved pricing for removed providers and models', async () => {
    const rates = [{ provider: 'retired-provider', model: 'retired-model', input: 0, output: 8, cacheRead: 0 }]
    api.request.mockResolvedValue({ rates })
    const wrapper = mountPricing()
    await clickButton(wrapper, 'usage.pricing.title')
    const [provider, model] = wrapper.findAllComponents(NSelect)
    expect(provider.props('options')).toContainEqual({ label: 'retired-provider', value: 'retired-provider' })
    expect(model.props('options')).toEqual([{ label: 'retired-model', value: 'retired-model' }])
    await clickButton(wrapper, 'common.save')
    expect(api.request).toHaveBeenLastCalledWith('/api/studio/usage/pricing', {
      method: 'PUT', body: JSON.stringify({ rates }),
    })
  })

  it('allows manual IDs when the catalog fails and reloads the catalog on reopening', async () => {
    api.fetchAvailableModelsForProfile.mockRejectedValueOnce(new Error('offline'))
    const wrapper = mountPricing()
    await clickButton(wrapper, 'usage.pricing.title')
    expect(wrapper.findComponent(NAlert).text()).toBe('usage.pricing.catalogError')
    await clickButton(wrapper, 'common.add')
    const [provider, model] = wrapper.findAllComponents(NSelect)
    expect(provider.props('tag')).toBe(true)
    expect(model.props('tag')).toBe(true)
    provider.vm.$emit('update:value', 'manual-provider')
    await flushPromises()
    model.vm.$emit('update:value', 'manual-model')
    const [input, output] = wrapper.findAllComponents(NInputNumber)
    input.vm.$emit('update:value', 0)
    output.vm.$emit('update:value', 0)
    await clickButton(wrapper, 'common.save')
    expect(api.request).toHaveBeenLastCalledWith('/api/studio/usage/pricing', {
      method: 'PUT', body: JSON.stringify({ rates: [{ provider: 'manual-provider', model: 'manual-model', input: 0, output: 0 }] }),
    })
    profile.activeProfileName = 'default'
    await clickButton(wrapper, 'usage.pricing.title')
    expect(api.fetchAvailableModelsForProfile).toHaveBeenLastCalledWith('default')
    expect(wrapper.findComponent(NAlert).exists()).toBe(false)
  })
})
