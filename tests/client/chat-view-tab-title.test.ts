// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import ChatView from '@/views/hermes/ChatView.vue'
import { useAppStore } from '@/stores/hermes/app'
import { useChatStore, type Session } from '@/stores/hermes/chat'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useSettingsStore } from '@/stores/hermes/settings'

vi.mock('@/components/common/PageLoading.vue', () => ({
  default: { props: ['show'], template: '<div><slot /></div>' },
}))

vi.mock('@/components/hermes/chat/ChatPanel.vue', () => ({
  default: {
    name: 'ChatPanel',
    props: { standalone: Boolean, contentMode: String },
    template: '<div data-testid="chat-panel" />',
  },
}))

const mockRoute = {
  name: 'hermes.session' as string,
  params: {} as Record<string, string>,
  query: {} as Record<string, string>,
  meta: {} as Record<string, unknown>,
}

vi.mock('vue-router', () => ({
  useRoute: () => mockRoute,
  useRouter: () => ({ replace: vi.fn() }),
}))

vi.mock('@/api/studio/chat', () => ({
  startRunViaSocket: vi.fn(),
  resumeSession: vi.fn(),
  registerSessionHandlers: vi.fn(),
  unregisterSessionHandlers: vi.fn(),
  getChatRunSocket: vi.fn(() => ({ emit: vi.fn() })),
  respondToolApproval: vi.fn(),
  respondClarify: vi.fn(),
  onPeerUserMessage: vi.fn(() => vi.fn()),
  onSessionCommand: vi.fn(() => vi.fn()),
  onSessionTitleUpdated: vi.fn(() => vi.fn()),
  onRunUsageUpdated: vi.fn(() => vi.fn()),
  onSessionWorkspaceUpdated: vi.fn(() => vi.fn()),
  onSessionSettingsUpdated: vi.fn(() => vi.fn()),
}))

vi.mock('@/api/studio/sessions', () => ({
  archiveSession: vi.fn(),
  fetchSessions: vi.fn(),
  fetchSessionMessagesPage: vi.fn(),
  fetchWorkspaceRunChangesForSession: vi.fn(async () => []),
  fetchWorkspaceRunChangeFile: vi.fn(async () => null),
  deleteSession: vi.fn(),
  setSessionModel: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  getActiveProfileName: () => 'default',
}))

vi.mock('@/api/studio/download', () => ({
  getDownloadUrl: (_path: string, name: string) => `/download/${name}`,
}))

vi.mock('@/utils/completion-sound', () => ({
  primeCompletionSound: vi.fn(),
  playCompletionSound: vi.fn(),
}))

vi.mock('@/utils/session-sync', () => ({
  subscribeSessionSync: vi.fn(() => vi.fn()),
  publishSessionSync: vi.fn(),
}))

function makeSession(title: string): Session {
  return {
    id: 'session-1',
    profile: 'default',
    title,
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

describe('ChatView tab title', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    document.title = 'Ekko Studio'
    mockRoute.name = 'hermes.session'
    mockRoute.params = {}
    mockRoute.query = {}
    mockRoute.meta = {}
    setActivePinia(createPinia())

    const appStore = useAppStore()
    const profilesStore = useProfilesStore()
    const settingsStore = useSettingsStore()
    const chatStore = useChatStore()

    vi.spyOn(appStore, 'loadModels').mockImplementation(() => undefined)
    vi.spyOn(profilesStore, 'fetchProfiles').mockResolvedValue()
    vi.spyOn(settingsStore, 'fetchSettings').mockResolvedValue(undefined as any)
    vi.spyOn(chatStore, 'loadSessions').mockResolvedValue()
  })

  it('reflects the active session title in the browser tab', async () => {
    const chatStore = useChatStore()
    chatStore.activeSession = makeSession('Research Plan')

    const wrapper = mount(ChatView)
    expect(document.title).toBe('Research Plan')

    chatStore.activeSession = makeSession('Implementation Notes')
    await nextTick()

    expect(document.title).toBe('Implementation Notes')

    wrapper.unmount()
    expect(document.title).toBe('Ekko Studio')
  })

  it('falls back to the product title when the session title is blank', () => {
    const chatStore = useChatStore()
    chatStore.activeSession = makeSession('   ')

    const wrapper = mount(ChatView)

    expect(document.title).toBe('Ekko Studio')
    wrapper.unmount()
  })

  it('renders the desktop chat route in standalone mode without forking chat logic', () => {
    mockRoute.name = 'desktop.chat'
    mockRoute.params = { sessionId: 'session-1' }
    mockRoute.meta = { standaloneChat: true }

    const chatStore = useChatStore()
    chatStore.activeSession = makeSession('Desktop Chat')

    const wrapper = mount(ChatView)

    expect(wrapper.getComponent({ name: 'ChatPanel' }).props('standalone')).toBe(true)
    expect(wrapper.get('.chat-view').classes()).toContain('chat-view--standalone')
    expect(document.title).toBe('Desktop Chat')
    wrapper.unmount()
  })

  it('renders Agent management inside the shared single-chat shell', () => {
    mockRoute.name = 'hermes.agentManager'

    const wrapper = mount(ChatView)

    expect(wrapper.getComponent({ name: 'ChatPanel' }).props('contentMode')).toBe('agents')
    wrapper.unmount()
  })
})
