// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import ScreenshotButton from '@/components/hermes/chat/ScreenshotButton.vue'
import { NDropdown } from 'naive-ui'

enableAutoUnmount(afterEach)
const desktop = vi.hoisted(() => ({ bridge: undefined as any }))
vi.mock('@/utils/desktop-bridge', () => ({ desktopBridge: () => desktop.bridge }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('naive-ui', () => ({
  NButton: { template: '<button type="button" v-bind="$attrs"><slot /><slot name="icon" /></button>' },
  NTooltip: { template: '<div><slot name="trigger" /></div>' },
  NDropdown: { props: ['options', 'disabled'], emits: ['select'], template: '<div><slot /></div>' },
  NModal: { props: ['show'], template: '<div v-if="show"><slot /></div>' },
}))

beforeEach(() => { desktop.bridge = undefined })

function nativeBridge(captureRegion = vi.fn().mockResolvedValue({ dataUrl: 'data:image/png;base64,aW1hZ2U=', width: 100, height: 80 })) {
  desktop.bridge = { isDesktop: true, screenshot: { captureRegion, cancel: vi.fn().mockResolvedValue(true) } }
  return desktop.bridge.screenshot
}

describe('screenshot composer button', () => {
  it('has no screenshot entry in the web UI', () => {
    expect(mount(ScreenshotButton).find('button').exists()).toBe(false)
  })

  it('emits a PNG attachment immediately after native region confirmation', async () => {
    const native = nativeBridge()
    const onCapture = vi.fn()
    const wrapper = mount(ScreenshotButton, { props: { onCapture } })
    await wrapper.get('button').trigger('click')
    await flushPromises()
    expect(native.captureRegion).toHaveBeenCalledWith({
      requestId: expect.any(String), hideWindows: false, labels: {
        hint: 'chat.screenshot.regionHint', confirm: 'chat.screenshot.done',
        cancel: 'common.cancel', reset: 'chat.screenshot.reset',
        tools: expect.objectContaining({ rectangle: 'chat.screenshot.tools.rectangle', mosaic: 'chat.screenshot.tools.mosaic' }),
      },
    })
    expect(onCapture).toHaveBeenCalledOnce()
    const file = onCapture.mock.calls[0][0] as File
    expect(file.type).toBe('image/png')
    expect(file.name).toMatch(/^screenshot-.*\.png$/)
    expect(file.size).toBe(5)
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })

  it('hides windows only when selecting the dropdown action, then returns to the default for the next click', async () => {
    const native = nativeBridge()
    const wrapper = mount(ScreenshotButton)
    await wrapper.get('button[aria-haspopup="menu"]').trigger('click')
    expect(native.captureRegion).not.toHaveBeenCalled()
    wrapper.getComponent(NDropdown).vm.$emit('select', 'hide-window')
    await flushPromises()
    expect(native.captureRegion).toHaveBeenLastCalledWith(expect.objectContaining({ hideWindows: true }))
    await wrapper.get('button.screenshot-button').trigger('click')
    await flushPromises()
    expect(native.captureRegion).toHaveBeenLastCalledWith(expect.objectContaining({ hideWindows: false }))
  })

  it('does not attach an image or show an error after Esc cancellation', async () => {
    nativeBridge(vi.fn().mockResolvedValue(null))
    const onCapture = vi.fn()
    const wrapper = mount(ScreenshotButton, { props: { onCapture } })
    await wrapper.get('button').trigger('click')
    await flushPromises()
    expect(onCapture).not.toHaveBeenCalled()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })

  it('cancels the native overlay and ignores a late image after changing sessions', async () => {
    let resolve!: (value: unknown) => void
    const native = nativeBridge(vi.fn(() => new Promise(done => { resolve = done })))
    const onCapture = vi.fn()
    const wrapper = mount(ScreenshotButton, { props: { onCapture } })
    await wrapper.get('button').trigger('click')
    const id = native.captureRegion.mock.calls[0][0].requestId
    wrapper.unmount()
    expect(native.cancel).toHaveBeenCalledWith(id)
    resolve({ dataUrl: 'data:image/png;base64,aW1hZ2U=', width: 100, height: 80 })
    await flushPromises()
    expect(onCapture).not.toHaveBeenCalled()
  })

  it('shows screen permission guidance and allows another attempt', async () => {
    nativeBridge(vi.fn().mockRejectedValue(new Error('SCREENSHOT_PERMISSION_DENIED')))
    const wrapper = mount(ScreenshotButton)
    await wrapper.get('button').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toBe('chat.screenshot.permissionDenied')
    expect(wrapper.get('button').attributes('disabled')).toBeUndefined()
  })
})
