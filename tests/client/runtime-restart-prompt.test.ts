// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  fetchVersionDownloadJobs: vi.fn(),
  restartWebUiAfterRuntimeChange: vi.fn(),
}))
const desktop = vi.hoisted(() => ({
  bridge: null as null | { isDesktop: boolean; restartApp?: ReturnType<typeof vi.fn> },
}))
const auth = vi.hoisted(() => ({ isStoredSuperAdmin: vi.fn(() => true) }))
vi.mock('@/api/client', () => auth)

const message = vi.hoisted(() => ({ error: vi.fn() }))

vi.mock('@/api/hermes/runtime-versions', () => api)
vi.mock('@/utils/desktop-bridge', () => ({
  desktopBridge: () => desktop.bridge,
}))
vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => params?.version ? `${key}:${params.version}` : key,
  }),
}))
vi.mock('naive-ui', () => ({
  NButton: {
    props: ['disabled', 'loading'],
    emits: ['click'],
    template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
  },
  NCard: { template: '<section><h1><slot name="header" /></h1><slot /><footer><slot name="footer" /></footer></section>' },
  NModal: { props: ['show'], template: '<div v-if="show"><slot /></div>' },
  useMessage: () => message,
}))

import RuntimeRestartPrompt from '@/components/layout/RuntimeRestartPrompt.vue'
import { useRuntimeRestartPrompt } from '@/composables/useRuntimeRestartPrompt'

function completedRuntimeJob(id = 'runtime-job-1') {
  return {
    id,
    kind: 'runtime',
    source: 'github',
    version: '0.20.6',
    status: 'completed',
    stage: 'completed',
    message: 'runtimeVersions.jobStage.completed',
    error: '',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  }
}

describe('RuntimeRestartPrompt', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    auth.isStoredSuperAdmin.mockReturnValue(true)
    sessionStorage.clear()
    localStorage.clear()
    useRuntimeRestartPrompt().clearRuntimeRestart()
    api.fetchVersionDownloadJobs.mockReset()
    api.restartWebUiAfterRuntimeChange.mockReset()
    api.fetchVersionDownloadJobs.mockResolvedValue({ jobs: [completedRuntimeJob()] })
    api.restartWebUiAfterRuntimeChange.mockResolvedValue({ success: true })
    desktop.bridge = null
    message.error.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits for confirmation after a Runtime download completes', async () => {
    const wrapper = mount(RuntimeRestartPrompt)
    await flushPromises()

    expect(wrapper.get('[data-testid="runtime-restart-prompt"]').text()).toContain('0.20.6')
    expect(api.restartWebUiAfterRuntimeChange).not.toHaveBeenCalled()

    await wrapper.get('[data-testid="runtime-restart-later"]').trigger('click')

    expect(wrapper.find('[data-testid="runtime-restart-prompt"]').exists()).toBe(false)
    expect(api.restartWebUiAfterRuntimeChange).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('restarts only the Desktop client when confirmed in Desktop', async () => {
    const restartApp = vi.fn().mockResolvedValue(true)
    desktop.bridge = { isDesktop: true, restartApp }
    const wrapper = mount(RuntimeRestartPrompt)
    await flushPromises()

    await wrapper.get('[data-testid="runtime-restart-now"]').trigger('click')
    await flushPromises()

    expect(restartApp).toHaveBeenCalledTimes(1)
    expect(api.restartWebUiAfterRuntimeChange).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('restarts only the standalone Web UI when confirmed in a browser', async () => {
    const wrapper = mount(RuntimeRestartPrompt)
    await flushPromises()

    await wrapper.get('[data-testid="runtime-restart-now"]').trigger('click')
    await flushPromises()

    expect(api.restartWebUiAfterRuntimeChange).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('keeps handled Runtime downloads suppressed after an app relaunch', async () => {
    const first = mount(RuntimeRestartPrompt)
    await flushPromises()

    await first.get('[data-testid="runtime-restart-later"]').trigger('click')
    expect(first.find('[data-testid="runtime-restart-prompt"]').exists()).toBe(false)
    first.unmount()

    sessionStorage.clear()

    const second = mount(RuntimeRestartPrompt)
    await flushPromises()

    expect(second.find('[data-testid="runtime-restart-prompt"]').exists()).toBe(false)
    expect(api.restartWebUiAfterRuntimeChange).not.toHaveBeenCalled()
    second.unmount()
  })

  it('never queries jobs for an ordinary administrator, even after a download notification', async () => {
    auth.isStoredSuperAdmin.mockReturnValue(false)
    const wrapper = mount(RuntimeRestartPrompt)
    useRuntimeRestartPrompt().checkRuntimeDownloads()
    await flushPromises()
    await vi.advanceTimersByTimeAsync(10000)
    expect(api.fetchVersionDownloadJobs).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('never queries jobs when no user role is stored', async () => {
    auth.isStoredSuperAdmin.mockReturnValue(false)
    const wrapper = mount(RuntimeRestartPrompt)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(10000)
    expect(api.fetchVersionDownloadJobs).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('checks once on mount and stays idle when no Runtime download is active', async () => {
    api.fetchVersionDownloadJobs.mockResolvedValue({ jobs: [] })
    const wrapper = mount(RuntimeRestartPrompt)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(10000)
    expect(api.fetchVersionDownloadJobs).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it.each(['completed', 'failed'])('resumes on a new download and stops when it is %s', async (status) => {
    api.fetchVersionDownloadJobs.mockResolvedValue({ jobs: [] })
    const wrapper = mount(RuntimeRestartPrompt)
    await flushPromises()
    api.fetchVersionDownloadJobs.mockResolvedValue({ jobs: [{ ...completedRuntimeJob(), status: 'running' }] })
    useRuntimeRestartPrompt().checkRuntimeDownloads()
    await flushPromises()
    await vi.advanceTimersByTimeAsync(2000)
    expect(api.fetchVersionDownloadJobs).toHaveBeenCalledTimes(3)
    api.fetchVersionDownloadJobs.mockResolvedValue({ jobs: [{ ...completedRuntimeJob(), status }] })
    await vi.advanceTimersByTimeAsync(2000)
    expect(wrapper.find('[data-testid="runtime-restart-prompt"]').exists()).toBe(status === 'completed')
    await vi.advanceTimersByTimeAsync(10000)
    expect(api.fetchVersionDownloadJobs).toHaveBeenCalledTimes(4)
    wrapper.unmount()
  })

  it('restores a queued download after a page reload', async () => {
    api.fetchVersionDownloadJobs.mockResolvedValue({ jobs: [{ ...completedRuntimeJob(), status: 'queued' }] })
    const wrapper = mount(RuntimeRestartPrompt)
    await flushPromises()
    api.fetchVersionDownloadJobs.mockResolvedValue({ jobs: [completedRuntimeJob()] })
    await vi.advanceTimersByTimeAsync(2000)
    expect(wrapper.find('[data-testid="runtime-restart-prompt"]').exists()).toBe(true)
    await vi.advanceTimersByTimeAsync(6000)
    expect(api.fetchVersionDownloadJobs).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('stops after a forbidden response instead of repeatedly triggering permission errors', async () => {
    api.fetchVersionDownloadJobs.mockResolvedValueOnce({ jobs: [{ ...completedRuntimeJob(), status: 'running' }] })
    api.fetchVersionDownloadJobs.mockRejectedValue(Object.assign(new Error('Forbidden'), { status: 403 }))
    const wrapper = mount(RuntimeRestartPrompt)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(10000)
    expect(api.fetchVersionDownloadJobs).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('does not overlap slow requests and rechecks a download started during an in-flight check', async () => {
    let resolve!: (value: { jobs: ReturnType<typeof completedRuntimeJob>[] }) => void
    api.fetchVersionDownloadJobs.mockReturnValueOnce(new Promise(done => { resolve = done }))
    const wrapper = mount(RuntimeRestartPrompt)
    await flushPromises()
    useRuntimeRestartPrompt().checkRuntimeDownloads()
    await vi.advanceTimersByTimeAsync(10000)
    expect(api.fetchVersionDownloadJobs).toHaveBeenCalledTimes(1)
    resolve({ jobs: [] })
    await flushPromises()
    expect(api.fetchVersionDownloadJobs).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-testid="runtime-restart-prompt"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('ignores a response received after unmounting', async () => {
    let resolve!: (value: { jobs: ReturnType<typeof completedRuntimeJob>[] }) => void
    api.fetchVersionDownloadJobs.mockReturnValueOnce(new Promise(done => { resolve = done }))
    const wrapper = mount(RuntimeRestartPrompt)
    wrapper.unmount()
    resolve({ jobs: [completedRuntimeJob()] })
    await flushPromises()
    expect(useRuntimeRestartPrompt().pendingRuntimeRestart.value).toBeNull()
    await vi.advanceTimersByTimeAsync(6000)
    expect(api.fetchVersionDownloadJobs).toHaveBeenCalledTimes(1)
  })

})
