// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import DesktopUpdateDownloadTab from '@/components/layout/DesktopUpdateDownloadTab.vue'
import en from '@/i18n/locales/en'
import type { DesktopUpdateState } from '@/utils/desktop-bridge'

const wrappers: VueWrapper[] = []
const downloading = (patch: Partial<DesktopUpdateState> = {}): DesktopUpdateState => ({
  revision: 1, status: 'downloading', version: '9.9.9', percent: 56.8,
  transferred: 568, total: 1000, bytesPerSecond: 3145728, ...patch,
})

function bridge(initial = downloading()) {
  let listener: (state: DesktopUpdateState) => void = () => undefined
  const dispose = vi.fn()
  const updater = {
    getState: vi.fn().mockResolvedValue(initial),
    cancel: vi.fn().mockResolvedValue(downloading({ revision: 2, status: 'cancelling', bytesPerSecond: 0 })),
    download: vi.fn().mockResolvedValue(downloading({ revision: 4, percent: null, bytesPerSecond: 0 })),
    install: vi.fn().mockResolvedValue(downloading({ revision: 3, status: 'installing' })),
    onStateChange: vi.fn(callback => { listener = callback; return dispose }),
  }
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { isDesktop: true, updater } })
  return { updater, dispose, emit: (next: DesktopUpdateState) => listener(next) }
}

async function render() {
  const wrapper = mount(DesktopUpdateDownloadTab, {
    global: { plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })] },
  })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}

afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  delete (window as Window & { hermesDesktop?: unknown }).hermesDesktop
})

describe('desktop update tab', () => {
  it('hides on the web and while the updater is idle', async () => {
    expect((await render()).find('.desktop-update-tab').exists()).toBe(false)
    bridge(downloading({ status: 'idle' }))
    expect((await render()).find('.desktop-update-tab').exists()).toBe(false)
  })

  it('renders real version, progress and speed, including unknown totals', async () => {
    const { emit } = bridge()
    const wrapper = await render()
    expect(wrapper.text()).toContain('v9.9.9')
    expect(wrapper.text()).toContain('56%')
    expect(wrapper.text()).toContain('3.0 MB/s')
    expect(wrapper.find('[role="progressbar"]').attributes('aria-valuenow')).toBe('56')
    emit(downloading({ revision: 2, percent: null, total: 0 }))
    await flushPromises()
    expect(wrapper.find('[role="progressbar"]').attributes('aria-valuenow')).toBeUndefined()
    expect(wrapper.find('.is-indeterminate').exists()).toBe(true)
    expect(wrapper.text()).toContain('—')
  })

  it('waits for the native cancellation before allowing a new download', async () => {
    const { updater, emit } = bridge()
    const wrapper = await render()
    await wrapper.find('button[aria-label="Stop download"]').trigger('click')
    await flushPromises()
    expect(updater.cancel).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('Stopping download')
    expect(wrapper.findAll('button')).toHaveLength(0)
    emit(downloading({ revision: 3, status: 'cancelled', bytesPerSecond: 0 }))
    await flushPromises()
    expect(wrapper.text()).toContain('Download stopped')
    expect(wrapper.find('[role="progressbar"]').exists()).toBe(false)
    await wrapper.find('button').trigger('click')
    await flushPromises()
    expect(updater.download).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('Downloading update')
  })

  it('does not let an older snapshot overwrite a newer pushed event', async () => {
    const { updater, emit } = bridge()
    let resolveSnapshot: (state: DesktopUpdateState) => void
    updater.getState.mockImplementationOnce(() => new Promise(resolve => { resolveSnapshot = resolve }))
    const wrapper = await render()
    emit(downloading({ revision: 5, percent: 81 }))
    resolveSnapshot!(downloading({ revision: 4, percent: 56 }))
    await flushPromises()
    expect(wrapper.text()).toContain('81%')
    expect(wrapper.text()).not.toContain('56%')
  })

  it('restores completed updates on mount and requests installation through the bridge', async () => {
    const { updater } = bridge(downloading({ status: 'downloaded', percent: 100 }))
    const wrapper = await render()
    expect(wrapper.text()).toContain('Update ready')
    await wrapper.find('button').trigger('click')
    await flushPromises()
    expect(updater.install).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('Restarting to update')
  })

  it('shows native preparation without a premature restart or cancellation action', async () => {
    bridge(downloading({ status: 'preparing', percent: 100, bytesPerSecond: 0 }))
    const wrapper = await render()
    expect(wrapper.text()).toContain('Preparing update')
    expect(wrapper.findAll('button')).toHaveLength(0)
    expect(wrapper.text()).not.toContain('/s')
  })

  it('keeps the native state on action failure and releases the listener on unmount', async () => {
    const { updater, dispose } = bridge()
    updater.cancel.mockRejectedValueOnce(new Error('IPC disconnected'))
    const wrapper = await render()
    await wrapper.find('button').trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="alert"]').text()).toContain('Please try again')
    expect(wrapper.text()).toContain('Downloading update')
    expect(wrapper.find('button').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})
