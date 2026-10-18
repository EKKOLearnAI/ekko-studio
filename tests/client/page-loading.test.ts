// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { defineComponent, nextTick, ref } from 'vue'
import PageLoading from '@/components/common/PageLoading.vue'
import { usePageLoadingTask } from '@/composables/usePageLoading'

const global = { plugins: [createI18n({ legacy: false, locale: 'en', messages: { en: { common: { loading: 'Loading' } } } })] }
let paint: FrameRequestCallback | undefined
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  paint = undefined
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { paint = callback; return 1 })
  vi.stubGlobal('cancelAnimationFrame', () => { paint = undefined })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
async function tick(ms: number) {
  await nextTick()
  await vi.advanceTimersByTimeAsync(ms)
  paint?.(performance.now())
  paint = undefined
  await nextTick()
}

it('keeps fast loads covered for one second without unmounting the draft', async () => {
  const wrapper = mount(PageLoading, { props: { show: false }, slots: { default: '<input />' }, global })
  const input = wrapper.get('input')
  await input.setValue('Draft')
  await wrapper.setProps({ show: true })
  expect(wrapper.get('.page-loading-content').attributes('inert')).toBeDefined()
  expect(wrapper.get('.studio-loading-logo').attributes('style')).toContain('72px')
  await tick(100)
  await wrapper.setProps({ show: false })
  await tick(899)
  expect(wrapper.attributes('aria-busy')).toBe('true')
  await tick(1)
  expect(wrapper.attributes('aria-busy')).toBe('false')
  expect(wrapper.find('.page-loading-overlay').exists()).toBe(false)
  expect(wrapper.get('.page-loading-content').attributes('inert')).toBeUndefined()
  expect(wrapper.get('input').element).toBe(input.element)
  expect((input.element as HTMLInputElement).value).toBe('Draft')
  // Each subsequent load gets its own minimum display interval.
  await wrapper.setProps({ show: true })
  await wrapper.setProps({ show: false })
  await tick(999)
  expect(wrapper.attributes('aria-busy')).toBe('true')
  await tick(1)
  expect(wrapper.attributes('aria-busy')).toBe('false')
  wrapper.unmount()
})

it('waits for slow data and reveals it on the next paint without another second', async () => {
  const wrapper = mount(PageLoading, { props: { show: true }, global })
  await tick(2000)
  expect(wrapper.attributes('aria-busy')).toBe('true')
  await wrapper.setProps({ show: false })
  await tick(0)
  expect(wrapper.attributes('aria-busy')).toBe('false')
  wrapper.unmount()
})

it('cancels an obsolete hide when a new request starts, and clears timers on unmount', async () => {
  const wrapper = mount(PageLoading, { props: { show: true }, global })
  await wrapper.setProps({ show: false })
  await tick(500)
  await wrapper.setProps({ show: true })
  await tick(500)
  expect(wrapper.attributes('aria-busy')).toBe('true')
  await wrapper.setProps({ show: false })
  await nextTick()
  const stalePaint = paint!
  await wrapper.setProps({ show: true })
  stalePaint(0)
  await nextTick()
  expect(wrapper.attributes('aria-busy')).toBe('true')
  wrapper.unmount()
  expect(vi.getTimerCount()).toBe(0)

  const pending = mount(PageLoading, { props: { show: true }, global })
  await pending.setProps({ show: false })
  await nextTick()
  expect(vi.getTimerCount()).toBeGreaterThan(0)
  pending.unmount()
  expect(vi.getTimerCount()).toBe(0)
})

it('aggregates nested pages and child preparation into one full-size overlay', async () => {
  const pending = ref(true)
  const child = defineComponent({
    setup() { usePageLoadingTask(() => pending.value) },
    template: '<div>Prepared content</div>',
  })
  const nested = defineComponent({
    components: { PageLoading, child },
    template: '<PageLoading :show="false"><child /></PageLoading>',
  })
  const wrapper = mount(PageLoading, { props: { show: true }, slots: { default: nested }, global })
  await wrapper.setProps({ show: false })
  await tick(1200)
  expect(wrapper.attributes('aria-busy')).toBe('true')
  expect(wrapper.findAll('.page-loading-overlay')).toHaveLength(1)
  pending.value = false
  await tick(0)
  expect(wrapper.attributes('aria-busy')).toBe('false')
  expect(wrapper.findAll('.page-loading-overlay')).toHaveLength(0)
  wrapper.unmount()
})

it('covers initial child preparation once and keeps later session loads interactive', async () => {
  const childPending = ref(true)
  const child = defineComponent({
    setup() { usePageLoadingTask(() => childPending.value) },
    template: '<input />',
  })
  const wrapper = mount(PageLoading, { props: { show: true, initialOnly: true }, slots: { default: child }, global })
  const input = wrapper.get('input')
  await input.setValue('Keep my draft')
  await wrapper.setProps({ show: false })
  await tick(1200)
  expect(wrapper.find('.page-loading-overlay').exists()).toBe(true)
  childPending.value = false
  await tick(0)
  expect(wrapper.find('.page-loading-overlay').exists()).toBe(false)

  await wrapper.setProps({ show: true })
  childPending.value = true
  await tick(1200)
  expect(wrapper.find('.page-loading-overlay').exists()).toBe(false)
  expect(wrapper.get('.page-loading-content').attributes('inert')).toBeUndefined()
  expect(wrapper.get('input').element).toBe(input.element)
  expect((input.element as HTMLInputElement).value).toBe('Keep my draft')

  // Other content modes in the same route component can still opt into repeated loading.
  await wrapper.setProps({ initialOnly: false })
  expect(wrapper.find('.page-loading-overlay').exists()).toBe(true)
  wrapper.unmount()
})
