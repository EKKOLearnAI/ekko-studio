// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  activateRuntimeVersion: vi.fn(),
  activateWebUiVersion: vi.fn(),
  deleteRuntimeVersion: vi.fn(),
  deleteWebUiVersion: vi.fn(),
  downloadRuntimeVersion: vi.fn(),
  downloadWebUiVersion: vi.fn(),
  fetchRuntimeVersionStatus: vi.fn(),
  fetchVersionDownloadJobs: vi.fn(),
  restartWebUiAfterRuntimeChange: vi.fn(),
  selectRuntimeRoot: vi.fn(),
}))

const selectRuntimeDirectory = vi.hoisted(() => vi.fn())
const message = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))

vi.mock('@/api/hermes/runtime-versions', () => api)
vi.mock('@/utils/desktop-bridge', () => ({
  desktopBridge: () => ({ selectRuntimeDirectory }),
}))
vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('naive-ui', () => ({
  NAlert: { template: '<div><slot /></div>' },
  NButton: { emits: ['click'], template: '<button v-bind="$attrs" @click="$emit(\'click\')"><slot /></button>' },
  NDrawer: { props: ['show'], template: '<div v-if="show"><slot /></div>' },
  NDrawerContent: { template: '<div><slot /></div>' },
  NPopconfirm: { template: '<div><slot name="trigger" /><slot /></div>' },
  NProgress: { template: '<div />' },
  NSpin: { template: '<div><slot /></div>' },
  NTag: { template: '<span><slot /></span>' },
  useMessage: () => message,
}))

import VersionManagementModal from '@/components/layout/VersionManagementModal.vue'
import { useRuntimeRestartPrompt } from '@/composables/useRuntimeRestartPrompt'

function runtimeStatus() {
  return {
    active: null,
    platform: 'mac-arm64',
    activeVersionPath: '/state/desktop-runtime/active-version.json',
    remoteManifestUrl: '',
    remoteError: '',
    hermes: {
      activeVersion: '0.18.0',
      agentVersion: 'v0.19.1 (2026.7.30) · upstream 3f497e2b · local 470cf66b (+1 carried commit)',
      activeDirectory: '/state/desktop-runtime/hermes/0.18.0/mac-arm64',
      pythonPath: '/state/desktop-runtime/hermes/0.18.0/mac-arm64/python/venv/bin/python3',
      agentRoot: '/state/desktop-runtime/hermes/0.18.0/mac-arm64/python',
      source: 'managed-runtime' as const,
      dataDirectory: '/state/.hermes',
      storageDirectory: '/state/desktop-runtime',
      defaultStorageDirectory: '/state/desktop-runtime',
      pendingStorageDirectory: '',
      migrationError: '',
      activationError: '',
      cliInstallations: [],
      installed: [],
      remoteVersions: [],
    },
    webui: {
      currentVersion: '0.6.31',
      activeVersion: '0.6.31',
      activeDirectory: '',
      installed: [],
      remoteVersions: [],
    },
  }
}

describe('VersionManagementModal Runtime storage selector', () => {
  afterEach(() => vi.useRealTimers())
  beforeEach(() => {
    useRuntimeRestartPrompt().clearRuntimeRestart()
    for (const mock of Object.values(api)) mock.mockReset()
    selectRuntimeDirectory.mockReset()
    message.success.mockReset()
    message.error.mockReset()
    api.fetchRuntimeVersionStatus.mockResolvedValue(runtimeStatus())
    api.fetchVersionDownloadJobs.mockResolvedValue({ jobs: [] })
    api.selectRuntimeRoot.mockResolvedValue({ success: true, active: {} })
    api.restartWebUiAfterRuntimeChange.mockResolvedValue({ success: true })
  })

  it('explains how to update Hermes Runtime from the command line', async () => {
    const wrapper = mount(VersionManagementModal, { props: { show: false } })
    await wrapper.setProps({ show: true })
    await flushPromises()

    const note = wrapper.get('[data-testid="runtime-cli-update-note"]')
    expect(note.text()).toContain('runtimeVersions.cliUpdateDescription')
    expect(note.text()).toContain('ekko-studio cli update')
    expect(api.fetchRuntimeVersionStatus).toHaveBeenCalledWith()
  })

  it('hides the CLI update hint in a portable build', async () => {
    api.fetchRuntimeVersionStatus.mockResolvedValue({ ...runtimeStatus(), portable: true })
    const wrapper = mount(VersionManagementModal, { props: { show: false } })
    await wrapper.setProps({ show: true })
    await flushPromises()

    expect(wrapper.find('[data-testid="runtime-cli-update-note"]').exists()).toBe(false)
  })

  it('shows the installed Hermes Agent version instead of the Runtime package version', async () => {
    const wrapper = mount(VersionManagementModal, { props: { show: false } })
    await wrapper.setProps({ show: true })
    await flushPromises()

    const activeVersion = wrapper.get('[data-testid="active-hermes-agent-version"]')
    expect(activeVersion.text()).toContain('v0.19.1 (2026.7.30)')
    expect(activeVersion.text()).not.toContain('upstream')
    expect(activeVersion.text()).not.toContain('0.18.0')
    expect(activeVersion.attributes('title')).toContain('local 470cf66b')

    const runtimeDirectory = wrapper.get('[data-testid="active-runtime-directory"]')
    expect(runtimeDirectory.text()).toContain('/state/desktop-runtime/hermes/0.18.0/mac-arm64')

    const pythonPath = wrapper.get('[data-testid="active-python-path"]')
    expect(pythonPath.text()).toContain('/state/desktop-runtime/hermes/0.18.0/mac-arm64/python/venv/bin/python3')

    const agentRoot = wrapper.get('[data-testid="active-agent-root"]')
    expect(agentRoot.text()).toContain('/state/desktop-runtime/hermes/0.18.0/mac-arm64/python')

    const dataDirectory = wrapper.get('[data-testid="active-data-directory"]')
    expect(dataDirectory.text()).toContain('/state/.hermes')
    const dataDirectoryHint = wrapper.get('[data-testid="hermes-data-directory-env-hint"]')
    expect(dataDirectoryHint.text()).toContain('runtimeVersions.dataDirectoryEnvDescription')
    expect(dataDirectoryHint.text()).toContain('HERMES_HOME')
  })

  it('shows Runtime versions returned by the Studio version API', async () => {
    const status = runtimeStatus()
    status.hermes.remoteVersions = ['0.20.4', '0.20.0']
    api.fetchRuntimeVersionStatus.mockResolvedValue(status)
    const wrapper = mount(VersionManagementModal, { props: { show: false } })

    await wrapper.setProps({ show: true })
    await flushPromises()

    expect(wrapper.text()).toContain('0.20.4')
    expect(wrapper.text()).toContain('0.20.0')
  })

  it('shows a failed Runtime as downloadable even when remote version lookup is unavailable', async () => {
    const status = {
      ...runtimeStatus(),
      active: {
        schema: 1,
        runtimeValidationFailures: [{
          version: '0.20.0',
          platform: 'mac-arm64',
          directory: '/state/desktop-runtime/hermes/0.20.0/mac-arm64',
          reason: 'hermes --version timed out after 5000ms',
          failedAt: new Date(0).toISOString(),
        }],
      },
    }
    api.fetchRuntimeVersionStatus.mockResolvedValue(status)
    const wrapper = mount(VersionManagementModal, { props: { show: false } })

    await wrapper.setProps({ show: true })
    await flushPromises()

    expect(wrapper.text()).toContain('0.20.0')
    expect(wrapper.text()).toContain('runtimeVersions.downloadGithub')
    expect(wrapper.text()).toContain('runtimeVersions.downloadCf')
    expect(wrapper.text()).not.toContain('runtimeVersions.installed')
    expect(wrapper.text()).not.toContain('runtimeVersions.useVersion')
  })

  it('shows selected user CLI paths in a read-only details drawer', async () => {
    const status = runtimeStatus()
    delete (status.hermes as { source?: string }).source
    status.hermes.cliInstallations = [{
      path: '/Users/test/.local/bin/hermes',
      version: 'v0.20.6',
      source: 'user-cli',
      selected: true,
    }]
    status.hermes.pythonPath = '/Users/test/.hermes/hermes-agent/venv/bin/python3'
    status.hermes.agentRoot = '/Users/test/.hermes/hermes-agent'
    status.hermes.dataDirectory = '/Users/test/.hermes'
    api.fetchRuntimeVersionStatus.mockResolvedValue(status)
    const wrapper = mount(VersionManagementModal, { props: { show: false } })

    await wrapper.setProps({ show: true })
    await flushPromises()

    expect(wrapper.find('[data-testid="active-python-path"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="active-agent-root"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="active-data-directory"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="cli-details"]').exists()).toBe(false)

    await wrapper.get('[data-testid="view-cli-details"]').trigger('click')

    const details = wrapper.get('[data-testid="cli-details"]')
    expect(details.text()).toContain('/Users/test/.hermes/hermes-agent/venv/bin/python3')
    expect(details.text()).toContain('/Users/test/.hermes/hermes-agent')
    expect(details.text()).toContain('/Users/test/.hermes')
    expect(details.text()).toContain('runtimeVersions.dataDirectoryEnvDescription')
    expect(details.text()).toContain('launchctl setenv HERMES_HOME')
    expect(details.text()).toContain('HERMES_HOME=/home/agent/.hermes')
  })

  it('shows the Runtime fallback reason and hides Web UI version switching', async () => {
    const status = runtimeStatus()
    status.hermes.activationError = 'Selected Runtime 0.20.0 is missing node/node.exe.'
    status.webui.remoteVersions = ['0.6.32']
    api.fetchRuntimeVersionStatus.mockResolvedValue(status)
    const wrapper = mount(VersionManagementModal, { props: { show: false } })
    await wrapper.setProps({ show: true })
    await flushPromises()

    expect(wrapper.get('[data-testid="runtime-activation-error"]').text())
      .toContain('Selected Runtime 0.20.0 is missing node/node.exe.')
    expect(wrapper.text()).not.toContain('runtimeVersions.webUiTitle')
    expect(wrapper.text()).not.toContain('0.6.32')
  })

  it('opens the desktop picker and schedules migration to the selected directory', async () => {
    selectRuntimeDirectory.mockResolvedValue('/Volumes/HermesRuntime')
    const wrapper = mount(VersionManagementModal, { props: { show: false } })
    await wrapper.setProps({ show: true })
    await flushPromises()

    await wrapper.get('[data-testid="select-runtime-directory"]').trigger('click')
    await flushPromises()

    expect(selectRuntimeDirectory).toHaveBeenCalledWith('/state/desktop-runtime')
    expect(api.selectRuntimeRoot).toHaveBeenCalledWith('/Volumes/HermesRuntime')
    expect(message.success).toHaveBeenCalledWith('runtimeVersions.runtimeDirectorySaved')
  })

  it('does not schedule migration when the desktop picker is canceled', async () => {
    selectRuntimeDirectory.mockResolvedValue(null)
    const wrapper = mount(VersionManagementModal, { props: { show: false } })
    await wrapper.setProps({ show: true })
    await flushPromises()

    await wrapper.get('[data-testid="select-runtime-directory"]').trigger('click')
    await flushPromises()

    expect(api.selectRuntimeRoot).not.toHaveBeenCalled()
  })

  it('schedules migration back to the system default directory', async () => {
    const status = runtimeStatus()
    status.hermes.storageDirectory = '/Volumes/HermesRuntime'
    api.fetchRuntimeVersionStatus.mockResolvedValue(status)
    const wrapper = mount(VersionManagementModal, { props: { show: false } })
    await wrapper.setProps({ show: true })
    await flushPromises()

    await wrapper.get('[data-testid="reset-runtime-directory"]').trigger('click')
    await flushPromises()

    expect(api.selectRuntimeRoot).toHaveBeenCalledWith('/state/desktop-runtime')
    expect(message.success).toHaveBeenCalledWith('runtimeVersions.runtimeDirectorySaved')
  })

  it('requests global restart confirmation after selecting an installed Runtime', async () => {
    const status = runtimeStatus()
    status.hermes.remoteVersions = ['0.20.4']
    status.hermes.installed = [{
      version: '0.20.4',
      platform: 'mac-arm64',
      directory: '/state/desktop-runtime/hermes/0.20.4/mac-arm64',
      active: false,
    }]
    api.fetchRuntimeVersionStatus.mockResolvedValue(status)
    api.activateRuntimeVersion.mockResolvedValue({ success: true, active: {} })
    const wrapper = mount(VersionManagementModal, { props: { show: false } })
    await wrapper.setProps({ show: true })
    await flushPromises()

    const useVersion = wrapper.findAll('button').find(button => button.text() === 'runtimeVersions.useVersion')
    expect(useVersion).toBeDefined()
    await useVersion!.trigger('click')
    await flushPromises()

    expect(api.activateRuntimeVersion).toHaveBeenCalledWith('0.20.4')
    expect(api.restartWebUiAfterRuntimeChange).not.toHaveBeenCalled()
    expect(useRuntimeRestartPrompt().pendingRuntimeRestart.value?.version).toBe('0.20.4')
    wrapper.unmount()
  })

  it('notifies the global monitor when starting a Runtime download before the drawer closes', async () => {
    vi.useFakeTimers()
    const status = {
      ...runtimeStatus(),
      hermes: { ...runtimeStatus().hermes, remoteVersions: ['0.20.6'] },
    }
    api.fetchRuntimeVersionStatus.mockResolvedValue(status)
    api.downloadRuntimeVersion.mockResolvedValue({ success: true, job: {
      id: 'new-runtime-job', kind: 'runtime', version: '0.20.6', status: 'queued',
      source: 'github', stage: 'queued', message: '', error: '', createdAt: '', updatedAt: '',
    } })
    const monitor = useRuntimeRestartPrompt()
    const wrapper = mount(VersionManagementModal, { props: { show: false } })
    await wrapper.setProps({ show: true })
    await flushPromises()
    const beforeDownload = monitor.runtimeDownloadCheckRevision.value
    const download = wrapper.findAll('button').find(button => button.text() === 'runtimeVersions.downloadGithub')!
    await download.trigger('click')
    await flushPromises()
    expect(api.downloadRuntimeVersion).toHaveBeenCalledWith('0.20.6', 'github')
    expect(monitor.runtimeDownloadCheckRevision.value).toBeGreaterThan(beforeDownload)
    await wrapper.setProps({ show: false })
    wrapper.unmount()
  })

})
