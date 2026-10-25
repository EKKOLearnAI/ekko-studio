// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import PageLoading from '@/components/common/PageLoading.vue'
import GithubPreviewSettings from '@/components/hermes/settings/GithubPreviewSettings.vue'

const api = vi.hoisted(() => ({ fetchPreviewStatus: vi.fn(), fetchPreviewTags: vi.fn(), installPreview: vi.fn(), preparePreview: vi.fn(), startPreview: vi.fn(), stopPreview: vi.fn(), error: vi.fn() }))
vi.mock('@/api/studio/system', () => api)
vi.mock('naive-ui', async original => ({ ...await original<typeof import('naive-ui')>(), useMessage: () => ({ error: api.error }) }))
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks() })

it('keeps initialization covered until both requests settle when the other request fails first', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  let paint: FrameRequestCallback | undefined
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { paint = callback; return 1 })
  vi.stubGlobal('cancelAnimationFrame', () => { paint = undefined })
  let rejectStatus!: (error: Error) => void
  api.fetchPreviewStatus.mockReturnValue(new Promise((_, reject) => { rejectStatus = reject }))
  api.fetchPreviewTags.mockRejectedValue(new Error('Tags unavailable'))
  const wrapper = mount(PageLoading, { props: { show: false }, slots: { default: GithubPreviewSettings }, global: {
    plugins: [createI18n({ legacy: false, locale: 'en', messages: { en: {} }, missingWarn: false, fallbackWarn: false })],
    stubs: { NAlert: true, NButton: true, NDescriptions: true, NDescriptionsItem: true, NSelect: true, NSpace: true, NTag: true },
  } })
  try {
    await flushPromises()
    await vi.advanceTimersByTimeAsync(1200)
    paint?.(performance.now()); paint = undefined
    await nextTick()
    expect(wrapper.find('.page-loading-overlay').exists()).toBe(true)
    expect(api.error).not.toHaveBeenCalled()
    rejectStatus(new Error('Status unavailable'))
    await flushPromises()
    await vi.advanceTimersByTimeAsync(0)
    paint?.(performance.now())
    await nextTick()
    expect(wrapper.find('.page-loading-overlay').exists()).toBe(false)
    expect(api.error).toHaveBeenCalledWith('Status unavailable')
  } finally { wrapper.unmount() }
})
