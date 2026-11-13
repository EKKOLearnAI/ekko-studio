// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { defineComponent, nextTick, ref } from 'vue'
const api = vi.hoisted(() => ({ count: vi.fn(), list: vi.fn() }))
vi.mock('../../packages/client/src/api/studio/plugin-market', () => ({ fetchPluginMarketCount: api.count, fetchPluginMarket: api.list }))
import { usePluginMarket } from '../../packages/client/src/composables/usePluginMarket'

let wrapper: VueWrapper | undefined
beforeEach(() => { vi.resetAllMocks(); api.count.mockResolvedValue(123); api.list.mockResolvedValue([]) })
afterEach(() => wrapper?.unmount())
function setup() {
  const enabled = ref(false)
  let market!: ReturnType<typeof usePluginMarket>
  wrapper = mount(defineComponent({ setup() { market = usePluginMarket(enabled); return () => null } }))
  return { enabled, market }
}

it('loads only the count on entry and refreshes it while the installed tab is active', async () => {
  const { market } = setup()
  await flushPromises()
  expect(market.total.value).toBe(123)
  expect(market.loaded.value).toBe(false)
  expect(api.list).not.toHaveBeenCalled()
  api.count.mockResolvedValueOnce(0)
  await market.refresh(true)
  expect(market.total.value).toBe(0)
  expect(api.count).toHaveBeenCalledTimes(2)
  expect(api.list).not.toHaveBeenCalled()
})
it('keeps count failures independent from lazy list loading and corrects the count after loading', async () => {
  api.count.mockRejectedValueOnce(new Error('unavailable'))
  const { enabled, market } = setup()
  await flushPromises()
  expect(market.total.value).toBeNull()
  expect(market.failed.value).toBe(false)
  enabled.value = true
  await nextTick(); await flushPromises()
  expect(api.list).toHaveBeenCalledOnce()
  expect(market.total.value).toBe(0)
  expect(market.loaded.value).toBe(true)
})
it('prevents a late count from overwriting a newer full list result', async () => {
  let resolveCount!: (value: number) => void
  api.count.mockImplementationOnce(() => new Promise<number>(resolve => { resolveCount = resolve }))
  const { enabled, market } = setup()
  const countSignal = api.count.mock.calls[0][0] as AbortSignal
  enabled.value = true
  await nextTick(); await flushPromises()
  expect(countSignal.aborted).toBe(true)
  resolveCount(123)
  await flushPromises()
  expect(market.total.value).toBe(0)
})
it('cancels pending count requests on unmount', async () => {
  let resolveCount!: (value: number) => void
  api.count.mockImplementationOnce(() => new Promise<number>(resolve => { resolveCount = resolve }))
  const { market } = setup()
  const signal = api.count.mock.calls[0][0] as AbortSignal
  wrapper!.unmount()
  expect(signal.aborted).toBe(true)
  resolveCount(123)
  await flushPromises()
  expect(market.total.value).toBeNull()
})
