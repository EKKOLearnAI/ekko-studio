// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import ScreenshotButton from '@/components/hermes/chat/ScreenshotButton.vue'
import { NDropdown, NRadioGroup } from 'naive-ui'
import ScreenshotShortcutSettings from '@/components/hermes/chat/ScreenshotShortcutSettings.vue'

enableAutoUnmount(afterEach)
const desktop = vi.hoisted(() => ({ bridge: undefined as any }))
vi.mock('@/utils/desktop-bridge', () => ({ desktopBridge: () => desktop.bridge }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('naive-ui', () => ({
  NButton: { template: '<button type="button" v-bind="$attrs"><slot /><slot name="icon" /></button>' },
  NTooltip: { template: '<div><slot name="trigger" /></div>' },
  NDropdown: { props: ['options', 'disabled'], emits: ['select'], template: '<div><slot /></div>' },
  NModal: { props: ['show'], template: '<div v-if="show"><slot /><slot name="footer" /></div>' },
  NRadio: { props: ['value', 'disabled'], template: '<span><slot /></span>' },
  NRadioGroup: { props: ['value', 'disabled'], emits: ['update:value'], template: '<div><slot /></div>' },
}))

beforeEach(() => { desktop.bridge = undefined })

function nativeBridge(captureRegion = vi.fn().mockResolvedValue({ dataUrl: 'data:image/png;base64,aW1hZ2U=', width: 100, height: 80 })) {
  desktop.bridge = { isDesktop: true, screenshot: { captureRegion, cancel: vi.fn().mockResolvedValue(true) } }
  return desktop.bridge.screenshot
}

function shortcutBridge() {
  const native = nativeBridge()
  let trigger!: (request: { targetId: string; hideWindows: boolean }) => void
  const stop = vi.fn()
  const shortcut = {
    getState: vi.fn().mockResolvedValue({ accelerator: 'Control+Shift+S', hideWindows: false, registered: true, error: '' }),
    save: vi.fn().mockResolvedValue({ accelerator: 'Control+Alt+S', hideWindows: true, registered: false, error: '' }),
    setEditing: vi.fn().mockResolvedValue({ error: '' }),
    setTarget: vi.fn().mockResolvedValue(true),
    onTrigger: vi.fn(callback => { trigger = callback; return stop }),
    onStateChange: vi.fn(() => stop),
  }
  native.shortcut = shortcut
  return { native, shortcut, fire: (targetId: string, hideWindows = false) => trigger({ targetId, hideWindows }), stop }
}

describe('screenshot composer button', () => {
  it('has no screenshot entry in the web UI', () => {
    const uuid = vi.spyOn(crypto, 'randomUUID').mockImplementation(() => { throw new Error('UUID unavailable on an HTTP LAN origin') })
    expect(mount(ScreenshotButton).find('button').exists()).toBe(false)
    expect(uuid).not.toHaveBeenCalled()
    uuid.mockRestore()
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

  it('disables Linux hiding with an explanation while allowing ordinary screenshots', async () => {
    const native = nativeBridge()
    native.getCapabilities = vi.fn().mockResolvedValue({ capture: 'electron', hideWindows: false })
    const wrapper = mount(ScreenshotButton)
    await flushPromises()
    expect(wrapper.getComponent(NDropdown).props('options')[0]).toMatchObject({ disabled: true, label: 'chat.screenshot.hideUnavailable' })
    wrapper.getComponent(NDropdown).vm.$emit('select', 'hide-window')
    await flushPromises()
    expect(native.captureRegion).not.toHaveBeenCalled()
    await wrapper.get('button.screenshot-button').trigger('click')
    await flushPromises()
    expect(native.captureRegion).toHaveBeenCalledWith(expect.objectContaining({ hideWindows: false }))
  })

  it('shows system waiting and allows cancelling an outstanding Portal request', async () => {
    const native = nativeBridge(vi.fn(() => new Promise(() => {})))
    native.getCapabilities = vi.fn().mockResolvedValue({ capture: 'portal-screenshot', hideWindows: false })
    const wrapper = mount(ScreenshotButton)
    await flushPromises()
    await wrapper.get('button.screenshot-button').trigger('click')
    expect(wrapper.get('[role="status"]').text()).toContain('chat.screenshot.systemWaiting')
    await wrapper.get('[role="status"] button').trigger('click')
    expect(native.cancel).toHaveBeenCalledWith(native.captureRegion.mock.calls[0][0].requestId)
  })

  it('explains unavailable system screenshots and disables capture', async () => {
    const native = nativeBridge()
    native.getCapabilities = vi.fn().mockResolvedValue({ capture: 'unavailable', hideWindows: false })
    const wrapper = mount(ScreenshotButton)
    await flushPromises()
    expect(wrapper.get('button.screenshot-button').attributes('disabled')).toBeDefined()
    expect(wrapper.getComponent(NDropdown).props('options')[0].disabled).toBe(true)
  })

  it('places shortcut settings below hiding and captures only for its own composer', async () => {
    const state = shortcutBridge()
    const onCapture = vi.fn()
    const wrapper = mount(ScreenshotButton, { props: { onCapture } })
    await flushPromises()
    expect(wrapper.getComponent(NDropdown).props('options').map((option: any) => option.key)).toEqual(['hide-window', 'shortcut-settings'])
    const targetId = state.shortcut.setTarget.mock.calls[0][0]
    state.fire('another-composer')
    expect(state.native.captureRegion).not.toHaveBeenCalled()
    state.fire(targetId, true)
    await flushPromises()
    expect(state.native.captureRegion).toHaveBeenCalledWith(expect.objectContaining({ hideWindows: true }))
    expect(onCapture).toHaveBeenCalledOnce()
    wrapper.unmount()
    expect(state.shortcut.setTarget).toHaveBeenLastCalledWith(targetId, null)
    expect(state.stop).toHaveBeenCalledTimes(2)
  })

  it('records and saves a new global shortcut without capturing while settings are open', async () => {
    const state = shortcutBridge()
    desktop.bridge.platform = 'win32'
    const wrapper = mount(ScreenshotButton)
    await flushPromises()
    const targetId = state.shortcut.setTarget.mock.calls[0][0]
    wrapper.getComponent(NDropdown).vm.$emit('select', 'shortcut-settings')
    await flushPromises()
    expect(state.shortcut.setEditing).toHaveBeenCalledWith(targetId, true)
    const settings = wrapper.getComponent(ScreenshotShortcutSettings)
    expect(settings.get('input').element.value).toBe('Ctrl + Shift + S')
    state.fire(targetId)
    expect(state.native.captureRegion).not.toHaveBeenCalled()
    await settings.get('input').trigger('keydown', { key: 's', code: 'KeyS', ctrlKey: true, altKey: true })
    settings.getComponent(NRadioGroup).vm.$emit('update:value', true)
    await settings.findAll('button').at(-1)!.trigger('click')
    await flushPromises()
    expect(state.shortcut.save).toHaveBeenCalledWith({ accelerator: 'Control+Alt+S', hideWindows: true })
    expect(state.shortcut.setEditing).toHaveBeenLastCalledWith(targetId, false)
    expect(wrapper.findComponent(ScreenshotShortcutSettings).exists()).toBe(false)
  })

  it('keeps the settings open on conflict and can clear a saved binding', async () => {
    const state = shortcutBridge()
    const wrapper = mount(ScreenshotButton)
    await flushPromises()
    state.shortcut.save.mockResolvedValueOnce({ accelerator: 'Control+Shift+S', hideWindows: false, registered: false, error: 'conflict' })
    wrapper.getComponent(NDropdown).vm.$emit('select', 'shortcut-settings')
    await flushPromises()
    const settings = wrapper.getComponent(ScreenshotShortcutSettings)
    await settings.findAll('button').at(-1)!.trigger('click')
    await flushPromises()
    expect(settings.get('[role="alert"]').text()).toBe('chat.screenshot.shortcut.conflict')
    await settings.findAll('button')[0].trigger('click')
    await settings.findAll('button').at(-1)!.trigger('click')
    await flushPromises()
    expect(state.shortcut.save).toHaveBeenLastCalledWith({ accelerator: '', hideWindows: false })
    expect(wrapper.findComponent(ScreenshotShortcutSettings).exists()).toBe(false)
  })

  it('cancels recording with Escape without saving or capturing', async () => {
    const state = shortcutBridge()
    const wrapper = mount(ScreenshotButton)
    await flushPromises()
    wrapper.getComponent(NDropdown).vm.$emit('select', 'shortcut-settings')
    await flushPromises()
    await wrapper.getComponent(ScreenshotShortcutSettings).get('input').trigger('keydown', { key: 'Escape', code: 'Escape' })
    await flushPromises()
    expect(state.shortcut.save).not.toHaveBeenCalled()
    expect(state.native.captureRegion).not.toHaveBeenCalled()
    expect(state.shortcut.setEditing).toHaveBeenLastCalledWith(state.shortcut.setTarget.mock.calls[0][0], false)
    expect(wrapper.findComponent(ScreenshotShortcutSettings).exists()).toBe(false)
  })
})
