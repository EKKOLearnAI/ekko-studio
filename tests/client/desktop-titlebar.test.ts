// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import DesktopTitleBar from '@/components/layout/DesktopTitleBar.vue'

type DesktopBridge = {
  platform?: string
  getWindowState?: () => Promise<{ isMaximized: boolean }>
  windowControl?: (action: 'minimize' | 'toggle-maximize' | 'close') => Promise<{ isMaximized: boolean }>
  onWindowStateChange?: (callback: (state: { isMaximized: boolean }) => void) => () => void
}

function setDesktopBridge(bridge: DesktopBridge) {
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: bridge,
  })
}

describe('DesktopTitleBar', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    delete (window as typeof window & { hermesDesktop?: DesktopBridge }).hermesDesktop
  })

  it('does not render desktop controls in an ordinary browser', () => {
    const wrapper = mount(DesktopTitleBar)

    expect(wrapper.find('.desktop-titlebar').exists()).toBe(false)
  })

  it('does not render custom chrome on macOS because native traffic lights sit in the sidebar', () => {
    setDesktopBridge({ platform: 'darwin' })

    const wrapper = mount(DesktopTitleBar)

    expect(wrapper.find('.desktop-titlebar').exists()).toBe(false)
  })

  it.each(['win32', 'linux'])('renders custom window controls on %s frameless windows', (platform) => {
    setDesktopBridge({
      platform,
      getWindowState: vi.fn().mockResolvedValue({ isMaximized: false }),
      windowControl: vi.fn().mockResolvedValue({ isMaximized: false }),
    })

    const wrapper = mount(DesktopTitleBar)

    expect(wrapper.find('.desktop-titlebar').exists()).toBe(true)
    expect(wrapper.findAll('.desktop-window-btn')).toHaveLength(3)
    expect(wrapper.find('.desktop-titlebar__brand').exists()).toBe(false)
  })

  it.each(['win32', 'linux'])('keeps %s controls interactive in the control bar', async (platform) => {
    const windowControl = vi.fn().mockResolvedValue({ isMaximized: true })
    setDesktopBridge({
      platform,
      getWindowState: vi.fn().mockResolvedValue({ isMaximized: false }),
      windowControl,
    })

    const wrapper = mount(DesktopTitleBar)
    await flushPromises()
    await wrapper.findAll('.desktop-window-btn')[1].trigger('click')
    await flushPromises()

    expect(windowControl).toHaveBeenCalledWith('toggle-maximize')
    expect(wrapper.find('.desktop-window-btn[aria-label="Restore"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('keeps the restore button in sync with native window changes and removes the listener', async () => {
    let listener: ((state: { isMaximized: boolean }) => void) | undefined
    const stop = vi.fn()
    setDesktopBridge({
      platform: 'linux',
      getWindowState: vi.fn().mockResolvedValue({ isMaximized: false }),
      onWindowStateChange: callback => { listener = callback; return stop },
    })
    const wrapper = mount(DesktopTitleBar, { props: { flush: true } })
    await flushPromises()

    listener?.({ isMaximized: true })
    await flushPromises()
    expect(wrapper.find('.desktop-window-btn[aria-label="Restore"]').exists()).toBe(true)

    listener?.({ isMaximized: false })
    await flushPromises()
    expect(wrapper.find('.desktop-window-btn[aria-label="Maximize"]').exists()).toBe(true)
    wrapper.unmount()
    expect(stop).toHaveBeenCalledOnce()
  })
})
