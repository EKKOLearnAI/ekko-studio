// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  checkCodingAgentUpdate: vi.fn(),
  deleteCodingAgent: vi.fn(),
  decideLegacyWindowsDataMigration: vi.fn(),
  fetchAgentStatusSnapshot: vi.fn(),
  fetchCodingAgentsStatus: vi.fn(),
  fetchLegacyWindowsDataMigrationStatus: vi.fn(),
  fetchRuntimeVersionStatus: vi.fn(),
  installCodingAgent: vi.fn(),
}))
const route = vi.hoisted(() => ({ query: {} as Record<string, string> }))
const replaceRoute = vi.hoisted(() => vi.fn())
const dialogWarning = vi.hoisted(() => vi.fn())
const newChat = vi.hoisted(() => vi.fn())
const restartApp = vi.hoisted(() => vi.fn())

vi.mock('@/api/coding-agents', () => ({
  checkCodingAgentUpdate: api.checkCodingAgentUpdate,
  deleteCodingAgent: api.deleteCodingAgent,
  fetchCodingAgentsStatus: api.fetchCodingAgentsStatus,
  installCodingAgent: api.installCodingAgent,
}))

vi.mock('@/api/agent-status', () => ({
  fetchAgentStatusSnapshot: api.fetchAgentStatusSnapshot,
}))

vi.mock('@/api/hermes/legacy-data-migration', () => ({
  decideLegacyWindowsDataMigration: api.decideLegacyWindowsDataMigration,
  fetchLegacyWindowsDataMigrationStatus: api.fetchLegacyWindowsDataMigrationStatus,
}))

vi.mock('@/api/hermes/runtime-versions', () => ({
  fetchRuntimeVersionStatus: api.fetchRuntimeVersionStatus,
}))

vi.mock('@/stores/hermes/app', () => ({
  useAppStore: () => ({ serverVersion: '0.7.0', setPageSidebarExpanded: vi.fn() }),
}))

vi.mock('@/stores/hermes/chat', () => ({
  useChatStore: () => ({ newChat }),
}))

vi.mock('@/components/layout/VersionManagementModal.vue', () => ({
  default: defineComponent({
    name: 'VersionManagementModal',
    props: { show: Boolean },
    template: '<div data-testid="runtime-manager-modal" />',
  }),
}))

vi.mock('vue-router', () => ({
  useRoute: () => route,
  useRouter: () => ({ push: vi.fn(), replace: replaceRoute }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, string>) => {
      if (key === 'agentManager.aiHelpPrompt') return `${key}:${JSON.stringify(values)}`
      return values?.version ? `${key}:${values.version}` : key
    },
  }),
}))

vi.mock('naive-ui', () => {
  const Slot = defineComponent({ template: '<div><slot /></div>' })
  return {
    NAlert: Slot,
    NButton: defineComponent({
      props: { disabled: Boolean, loading: Boolean },
      emits: ['click'],
      template: '<button :disabled="disabled || loading" @click="$emit(\'click\')"><slot /></button>',
    }),
    NDrawer: defineComponent({
      name: 'NDrawer',
      props: { show: Boolean, width: [String, Number] },
      emits: ['update:show'],
      template: '<aside v-if="show" data-testid="agent-ai-help-drawer"><slot /></aside>',
    }),
    NDrawerContent: defineComponent({
      name: 'NDrawerContent',
      props: { title: String },
      template: '<section><header>{{ title }}</header><slot /></section>',
    }),
    NPopconfirm: defineComponent({
      name: 'NPopconfirm',
      emits: ['positive-click'],
      template: '<div><slot name="trigger" /><slot /></div>',
    }),
    NSpin: Slot,
    NTag: defineComponent({ template: '<span><slot /></span>' }),
    useDialog: () => ({ warning: dialogWarning }),
    useMessage: () => ({ success: vi.fn(), error: vi.fn() }),
  }
})

import AgentManagerView from '@/views/hermes/AgentManagerView.vue'

const claude = {
  id: 'claude-code',
  name: 'Claude Code',
  provider: 'Anthropic',
  command: 'claude',
  packageName: '@anthropic-ai/claude-code',
  installed: true,
  version: '2.0.0',
  rawVersion: '2.0.0',
}

const missing = (id: 'codex' | 'pi' | 'grok', name: string, packageName: string) => ({
  id,
  name,
  provider: name,
  command: id,
  packageName,
  installed: false,
  version: '',
  rawVersion: '',
})

function runtimeStatus() {
  return {
    active: null,
    platform: 'mac-arm64',
    activeVersionPath: '',
    remoteManifestUrl: '',
    remoteError: '',
    hermes: {
      activeVersion: '0.21.0',
      agentVersion: 'v0.21.0 (2026.8.27) · upstream 3f497e2b · local 470cf66b (+1 carried commit)',
      activeDirectory: '/runtime/0.21.0',
      pythonPath: '/runtime/0.21.0/python/venv/bin/python3',
      agentRoot: '/runtime/0.21.0/python',
      source: 'managed-runtime' as const,
      dataDirectory: '/Users/test/.hermes',
      storageDirectory: '/runtime',
      defaultStorageDirectory: '/runtime',
      pendingStorageDirectory: '',
      migrationError: '',
      activationError: '',
      cliInstallations: [{
        path: '/Users/test/.local/bin/hermes',
        version: '0.20.4',
        source: 'user-cli',
        selected: false,
      }],
      installed: [{
        version: '0.21.0',
        platform: 'mac-arm64',
        directory: '/runtime/0.21.0',
        active: true,
      }],
      remoteVersions: ['0.21.0'],
    },
    webui: {
      currentVersion: '0.7.0',
      activeVersion: '0.7.0',
      activeDirectory: '',
      installed: [],
      remoteVersions: [],
    },
  }
}

function agentStatusSnapshot() {
  return {
    revision: 1,
    updatedAt: '2026-08-27T00:00:00.000Z',
    agents: [
      {
        id: 'hermes',
        installed: true,
        source: 'managed-runtime',
        path: '/runtime/0.21.0/bin/hermes',
        version: 'v0.21.0 (2026.8.27) · upstream 3f497e2b · local 470cf66b (+1 carried commit)',
      },
      { id: 'ekko-agent', installed: true, source: 'built-in', path: '', version: '0.7.0' },
      { id: 'claude-code', installed: true, source: 'user-cli', path: '/usr/local/bin/claude', version: '2.0.0' },
      { id: 'codex', installed: false, source: 'not-installed', path: '', version: '' },
      { id: 'pi', installed: false, source: 'not-installed', path: '', version: '' },
      { id: 'grok', installed: false, source: 'not-installed', path: '', version: '' },
    ],
  }
}

describe('Agent Manager page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    route.query = {}
    delete (window as typeof window & { hermesDesktop?: unknown }).hermesDesktop
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    })
    api.fetchCodingAgentsStatus.mockResolvedValue({
      tools: [
        claude,
        missing('codex', 'Codex', '@openai/codex'),
        missing('pi', 'Pi', '@earendil-works/pi-coding-agent'),
        missing('grok', 'Grok', '@xai-official/grok'),
      ],
    })
    api.fetchRuntimeVersionStatus.mockResolvedValue(runtimeStatus())
    api.fetchAgentStatusSnapshot.mockResolvedValue(agentStatusSnapshot())
    api.fetchLegacyWindowsDataMigrationStatus.mockResolvedValue({
      supported: false,
      shouldPrompt: false,
      sourceDirectory: '',
      targetDirectory: '',
      markerPath: '',
      decision: null,
    })
    api.decideLegacyWindowsDataMigration.mockResolvedValue({
      supported: true,
      shouldPrompt: false,
      sourceDirectory: '',
      targetDirectory: 'C:\\Users\\tester\\.hermes',
      markerPath: 'C:\\Users\\tester\\.hermes\\.studio-windows-appdata-migration.json',
      decision: { action: 'migrate', state: 'pending' },
    })
  })

  function mountPage() {
    return mount(AgentManagerView, {
      props: { sidebarCollapsed: false },
      global: {
        stubs: {
          VersionManagementModal: true,
          AiHelpChatPanel: defineComponent({
            name: 'AiHelpChatPanel',
            props: {
              standalone: Boolean,
              initialComposerText: String,
              composerPersistDraft: Boolean,
            },
            template: '<div data-testid="ai-help-chat">{{ initialComposerText }}</div>',
          }),
        },
      },
    })
  }

  it('shows Hermes with the same compact card structure as other Agents', async () => {
    const wrapper = mount(AgentManagerView, {
      props: { sidebarCollapsed: false },
      global: {
        stubs: {
          VersionManagementModal: true,
        },
      },
    })
    await flushPromises()

    const hermesCard = wrapper.get('[data-testid="agent-card-hermes"]')
    expect(hermesCard.text()).not.toContain('agentManager.managedRuntimeHint')
    expect(hermesCard.text()).toContain('codingAgents.installed')
    expect(hermesCard.get('.agent-version').text()).toBe('v0.21.0 (2026.8.27)')
    expect(hermesCard.text()).not.toContain('3f497e2b')
    expect(hermesCard.text()).not.toContain('470cf66b')
    expect(hermesCard.text()).not.toContain('agentManager.hermesDescription')
    expect(hermesCard.text()).not.toContain('/Users/test/.local/bin/hermes')
    expect(hermesCard.get('[data-testid="hermes-source-type"]').text()).toBe('Runtime')
    expect(hermesCard.findAll('button').map(button => button.text()))
      .toEqual(['agentManager.hermesSettings', 'agentManager.manageRuntime'])
    expect(wrapper.findComponent({ name: 'VersionManagementModal' }).exists()).toBe(true)
    expect(api.fetchAgentStatusSnapshot).toHaveBeenCalledOnce()
    expect(api.fetchRuntimeVersionStatus).not.toHaveBeenCalled()
    expect(api.fetchCodingAgentsStatus).not.toHaveBeenCalled()

    const ekkoCard = wrapper.get('[data-testid="agent-card-ekko"]')
    expect(ekkoCard.findAll('button').map(button => button.text())).toEqual(['sidebar.settings'])
    expect(ekkoCard.get('.agent-version').text()).toBe('Studio v0.7.0')
    expect(ekkoCard.text()).not.toContain('agentManager.ekkoDescription')
    const claudeCard = wrapper.get('[data-testid="agent-card-claude-code"]')
    expect(claudeCard.get('.agent-version').text()).toBe('v2.0.0')
    expect(claudeCard.text()).not.toContain('agentManager.codingAgentDescription')
    expect(wrapper.get('[data-testid="agent-card-codex"]').text()).toContain('agentManager.codingAgentDescription')
    expect(wrapper.get('[data-testid="agent-card-codex"]').text()).toContain('codingAgents.installNow')
    expect(wrapper.get('.coding-agent-grid').findAll('.agent-card').map(card => card.attributes('data-testid')))
      .toEqual(['agent-card-ekko', 'agent-card-hermes', 'agent-card-claude-code', 'agent-card-codex', 'agent-card-pi', 'agent-card-grok', 'agent-card-opencode', 'agent-card-dsh'])
  })

  it('detects the CLI before offering Runtime management in the desktop shell', async () => {
    ;(window as typeof window & { hermesDesktop?: { isDesktop: boolean } }).hermesDesktop = { isDesktop: true }
    const status = agentStatusSnapshot()
    status.agents[0] = {
      ...status.agents[0],
      source: 'user-cli',
      path: '/Users/test/.local/bin/hermes',
      version: '0.20.4',
    }
    api.fetchAgentStatusSnapshot.mockResolvedValue(status)
    const cliStatus = runtimeStatus()
    cliStatus.hermes.source = 'user-cli'
    cliStatus.hermes.pythonPath = '/Users/test/.hermes/hermes-agent/venv/bin/python'
    cliStatus.hermes.agentRoot = '/Users/test/.hermes/hermes-agent'
    cliStatus.hermes.dataDirectory = '/Users/test/.hermes'
    cliStatus.hermes.cliInstallations[0].selected = true
    api.fetchRuntimeVersionStatus.mockResolvedValue(cliStatus)
    const wrapper = mount(AgentManagerView, {
      props: { sidebarCollapsed: false },
      global: {
        stubs: {
          VersionManagementModal: true,
        },
      },
    })
    await flushPromises()

    const hermesCard = wrapper.get('[data-testid="agent-card-hermes"]')
    expect(hermesCard.text()).not.toContain('/Users/test/.local/bin/hermes')
    expect(hermesCard.get('[data-testid="hermes-source-type"]').text()).toBe('CLI')
    expect(hermesCard.findAll('button').map(button => button.text()))
      .toEqual(['agentManager.hermesSettings', 'runtimeVersions.viewCliDetails'])
    expect(api.fetchRuntimeVersionStatus).not.toHaveBeenCalled()
    expect(wrapper.getComponent({ name: 'VersionManagementModal' }).props('show')).toBe(false)

    await hermesCard.get('[data-testid="view-hermes-cli-details"]').trigger('click')
    await flushPromises()

    expect(api.fetchRuntimeVersionStatus).toHaveBeenCalledWith({ includeRemote: false })
    const details = wrapper.get('[data-testid="hermes-cli-details"]')
    expect(details.text()).toContain('/Users/test/.hermes/hermes-agent/venv/bin/python')
    expect(details.text()).toContain('/Users/test/.hermes/hermes-agent')
    expect(details.text()).toContain('/Users/test/.hermes')
    expect(details.text()).toContain('runtimeVersions.dataDirectoryEnvDescription')
    expect(details.text()).toContain('SetEnvironmentVariable("HERMES_HOME"')
    expect(details.text()).toContain('HERMES_HOME=/home/agent/.hermes')
  })

  it('does not open Runtime management when cached Hermes status is unavailable', async () => {
    ;(window as typeof window & { hermesDesktop?: { isDesktop: boolean } }).hermesDesktop = { isDesktop: true }
    const status = agentStatusSnapshot()
    status.agents[0] = {
      ...status.agents[0],
      installed: false,
      source: 'not-installed',
      path: '',
      version: '',
    }
    api.fetchAgentStatusSnapshot.mockResolvedValue(status)

    const wrapper = mount(AgentManagerView, {
      props: { sidebarCollapsed: false },
      global: {
        stubs: {
          VersionManagementModal: true,
        },
      },
    })
    await flushPromises()

    expect(api.fetchRuntimeVersionStatus).not.toHaveBeenCalled()
    const hermesCard = wrapper.get('[data-testid="agent-card-hermes"]')
    expect(hermesCard.text()).toContain('codingAgents.notInstalled')
    expect(hermesCard.text()).toContain('agentManager.hermesDescription')
    expect(hermesCard.find('.agent-version').exists()).toBe(false)
    expect(hermesCard.find('[data-testid="hermes-source-type"]').exists()).toBe(false)
    expect(hermesCard.findAll('button').map(button => button.text()))
      .toEqual(['codingAgents.installNow'])
    expect(wrapper.getComponent({ name: 'VersionManagementModal' }).props('show')).toBe(false)
  })

  it('opens Runtime management only when chat creation requests installation', async () => {
    route.query = { runtime: 'install' }
    const wrapper = mount(AgentManagerView, {
      props: { sidebarCollapsed: false },
      global: { stubs: { VersionManagementModal: true } },
    })
    await flushPromises()

    expect(wrapper.getComponent({ name: 'VersionManagementModal' }).props('show')).toBe(true)
    expect(replaceRoute).toHaveBeenCalledWith({ query: {} })
  })

  it('offers the one-time legacy Hermes data migration in the Windows desktop shell', async () => {
    restartApp.mockResolvedValue(true)
    ;(window as typeof window & { hermesDesktop?: { isDesktop: boolean; platform: string; restartApp: typeof restartApp } }).hermesDesktop = {
      isDesktop: true,
      platform: 'win32',
      restartApp,
    }
    api.fetchLegacyWindowsDataMigrationStatus.mockResolvedValue({
      supported: true,
      shouldPrompt: true,
      sourceDirectory: 'C:\\Users\\tester\\AppData\\Local\\hermes',
      targetDirectory: 'C:\\Users\\tester\\.hermes',
      markerPath: 'C:\\Users\\tester\\.hermes\\.studio-windows-appdata-migration.json',
      decision: null,
    })

    mountPage()
    await flushPromises()

    expect(api.fetchLegacyWindowsDataMigrationStatus).toHaveBeenCalledOnce()
    expect(dialogWarning).toHaveBeenCalledOnce()
    const options = dialogWarning.mock.calls[0][0]
    expect(options.title).toBe('agentManager.legacyDataMigrationTitle')
    expect(options.positiveText).toBe('agentManager.legacyDataMigrationPositive')
    expect(options.negativeText).toBe('agentManager.legacyDataMigrationNegative')
    expect(options.closable).toBe(false)
    expect(options.maskClosable).toBe(false)

    await options.onPositiveClick()
    expect(api.decideLegacyWindowsDataMigration).toHaveBeenCalledWith('migrate')
    expect(restartApp).toHaveBeenCalledOnce()
  })

  it('does not check legacy Windows data outside the Windows desktop shell', async () => {
    mountPage()
    await flushPromises()

    expect(api.fetchLegacyWindowsDataMigrationStatus).not.toHaveBeenCalled()
  })

  it('puts the available version directly on the update button', async () => {
    api.checkCodingAgentUpdate.mockResolvedValue({
      success: true,
      tool: claude,
      latestVersion: '2.1.0',
      updateAvailable: true,
    })
    const wrapper = mount(AgentManagerView, {
      props: { sidebarCollapsed: false },
      global: { stubs: { VersionManagementModal: true } },
    })
    await flushPromises()

    const claudeCard = wrapper.get('[data-testid="agent-card-claude-code"]')
    const checkButton = claudeCard.findAll('button')
      .find(button => button.text() === 'codingAgents.checkUpdate')
    expect(checkButton).toBeDefined()
    await checkButton!.trigger('click')
    await flushPromises()

    expect(claudeCard.find('.update-alert').exists()).toBe(false)
    expect(claudeCard.findAll('button').map(button => button.text()))
      .toContain('agentManager.updateToVersion:v2.1.0')
  })

  it('only probes installed Agents after the user clicks refresh', async () => {
    const wrapper = mount(AgentManagerView, {
      props: { sidebarCollapsed: false },
      global: { stubs: { VersionManagementModal: true } },
    })
    await flushPromises()

    expect(api.fetchAgentStatusSnapshot).toHaveBeenCalledOnce()
    expect(api.fetchCodingAgentsStatus).not.toHaveBeenCalled()
    expect(api.fetchRuntimeVersionStatus).not.toHaveBeenCalled()

    const refreshButton = wrapper.findAll('button')
      .find(button => button.text() === 'agentManager.refresh')
    expect(refreshButton).toBeDefined()
    await refreshButton!.trigger('click')
    await flushPromises()

    expect(api.fetchCodingAgentsStatus).toHaveBeenCalledOnce()
    expect(api.fetchRuntimeVersionStatus).toHaveBeenCalledWith({ includeRemote: false })
    expect(api.fetchAgentStatusSnapshot).toHaveBeenCalledTimes(2)
  })

  it('opens a dedicated Ekko help drawer from the Ask AI button beside refresh', async () => {
    const wrapper = mountPage()
    await flushPromises()

    const headerButtons = wrapper.get('.agent-manager-header-actions').findAll('button')
    expect(headerButtons.map(button => button.text())).toEqual([
      'agentManager.refresh',
      'agentManager.aiHelpDialogPositive',
    ])

    await headerButtons[1].trigger('click')
    await flushPromises()

    expect(dialogWarning).not.toHaveBeenCalled()
    expect(newChat).toHaveBeenCalledWith({
      source: 'coding_agent',
      agent: 'ekko-agent',
      codingAgentId: 'ekko-agent',
      codingAgentMode: 'scoped',
    })
    const chat = wrapper.getComponent({ name: 'AiHelpChatPanel' })
    expect(chat.props('initialComposerText')).toBe('agentManager.aiHelpGeneralPrompt')
    expect(chat.props('composerPersistDraft')).toBe(false)
  })

  it('offers an Ekko troubleshooting drawer with precise install context after installation fails', async () => {
    api.installCodingAgent.mockResolvedValue({
      success: false,
      message: 'npm install failed',
      tool: missing('codex', 'Codex', '@openai/codex'),
      tools: [claude, missing('codex', 'Codex', '@openai/codex'), missing('pi', 'Pi', '@earendil-works/pi-coding-agent'), missing('grok', 'Grok', '@xai-official/grok')],
    })
    const wrapper = mountPage()
    await flushPromises()

    const installButton = wrapper.get('[data-testid="agent-card-codex"]')
      .findAll('button')
      .find(button => button.text() === 'codingAgents.installNow')
    expect(installButton).toBeDefined()
    await installButton!.trigger('click')
    await flushPromises()

    expect(dialogWarning).toHaveBeenCalledOnce()
    const options = dialogWarning.mock.calls[0][0]
    expect(options.title).toBe('agentManager.aiHelpDialogTitle')
    options.onPositiveClick()
    await flushPromises()

    expect(newChat).toHaveBeenCalledWith({
      source: 'coding_agent',
      agent: 'ekko-agent',
      codingAgentId: 'ekko-agent',
      codingAgentMode: 'scoped',
    })
    const chat = wrapper.getComponent({ name: 'AiHelpChatPanel' })
    expect(chat.props('standalone')).toBe(true)
    expect(chat.props('composerPersistDraft')).toBe(false)
    expect(chat.props('initialComposerText')).toContain('"name":"Codex"')
    expect(chat.props('initialComposerText')).toContain('"operation":"agentManager.installOperation"')
    expect(chat.props('initialComposerText')).toContain('"command":"codex"')
    expect(chat.props('initialComposerText')).toContain('"package":"@openai/codex"')
    expect(chat.props('initialComposerText')).toContain('"error":"npm install failed"')
  })

  it('labels delete failures as removal problems before opening Ekko troubleshooting', async () => {
    api.deleteCodingAgent.mockResolvedValue({
      success: false,
      message: 'Delete completed but the command is still available',
      tool: claude,
      tools: [claude, missing('codex', 'Codex', '@openai/codex'), missing('pi', 'Pi', '@earendil-works/pi-coding-agent'), missing('grok', 'Grok', '@xai-official/grok')],
    })
    const wrapper = mountPage()
    await flushPromises()

    wrapper.get('[data-testid="agent-card-claude-code"]')
      .getComponent({ name: 'NPopconfirm' })
      .vm.$emit('positive-click')
    await flushPromises()

    const options = dialogWarning.mock.calls[0][0]
    options.onPositiveClick()
    await flushPromises()

    const prompt = wrapper.getComponent({ name: 'AiHelpChatPanel' }).props('initialComposerText')
    expect(prompt).toContain('"name":"Claude"')
    expect(prompt).toContain('"operation":"agentManager.deleteOperation"')
    expect(prompt).toContain('"error":"Delete completed but the command is still available"')
  })
})
