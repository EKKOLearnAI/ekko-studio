// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const routeMock = vi.hoisted(() => ({
  name: 'hermes.chat' as string,
  meta: {} as Record<string, unknown>,
}))
const appStoreMock = vi.hoisted(() => ({
  nodeVersion: '23.0.0',
  sidebarOpen: true,
  sidebarCollapsed: false,
  pageSidebarExpanded: true,
  toggleSidebar: vi.fn(),
  closeSidebar: vi.fn(),
  loadModels: vi.fn(),
  startHealthPolling: vi.fn(),
  stopHealthPolling: vi.fn(),
}))
const profilesStoreMock = vi.hoisted(() => ({
  activeProfileName: 'default' as string | null,
}))
const watchServerTtsSettingsHydrationMock = vi.hoisted(() => vi.fn())

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return {
    ...actual,
    useRoute: () => routeMock,
  }
})

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => params?.version ? `${key}:${params.version}` : key,
    locale: { value: 'en' },
  }),
}))

vi.mock('@/composables/useTheme', () => ({
  useTheme: () => ({
    isDark: false,
    isComic: false,
    customization: { value: { fontSize: 14, textColor: null, accentColor: null } },
    hasBackgroundImage: false,
    syncThemeFromServer: vi.fn().mockResolvedValue(undefined),
  }),
}))

vi.mock('@/composables/useKeyboard', () => ({
  useKeyboard: vi.fn(),
}))

vi.mock('@/stores/hermes/app', () => ({
  useAppStore: () => appStoreMock,
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => profilesStoreMock,
}))

vi.mock('@/composables/useTtsSettingsHydration', () => ({
  watchServerTtsSettingsHydration: watchServerTtsSettingsHydrationMock,
}))

vi.mock('@/styles/theme', () => ({
  getThemeOverrides: () => ({}),
}))

vi.mock('@/components/hermes/pets/WebPet.vue', () => ({
  default: { name: 'WebPet', template: '<div class="web-pet-test" />' },
}))

vi.mock('@/components/auth/AuthEventListener.vue', () => ({
  default: { name: 'AuthEventListener', template: '<div />' },
}))

vi.mock('@/components/auth/DefaultCredentialPrompt.vue', () => ({
  default: { name: 'DefaultCredentialPrompt', template: '<div />' },
}))

vi.mock('@/components/hermes/models/ProviderConfigurationPrompt.vue', () => ({
  default: { name: 'ProviderConfigurationPrompt', template: '<div />' },
}))

vi.mock('@/components/layout/GlobalPendingActions.vue', () => ({
  default: { name: 'GlobalPendingActions', template: '<div class="global-pending-actions-test" />' },
}))

vi.mock('@/components/layout/RuntimeRestartPrompt.vue', () => ({
  default: { name: 'RuntimeRestartPrompt', template: '<div class="runtime-restart-prompt-test" />' },
}))

vi.mock('@/components/hermes/chat/SessionSearchModal.vue', () => ({
  default: { name: 'SessionSearchModal', template: '<div />' },
}))

vi.mock('@/components/layout/AppSidebar.vue', () => ({
  default: { name: 'AppSidebar', template: '<aside />' },
}))

vi.mock('@/components/layout/DesktopTitleBar.vue', () => ({
  default: {
    name: 'DesktopTitleBar',
    props: ['standalone', 'leftOffset'],
    template: '<div />',
  },
}))

import App from '@/App.vue'

type WindowWithDesktop = typeof window & {
  hermesDesktop?: {
    isDesktop?: boolean
    platform?: string
    windowKind?: 'main' | 'pet' | 'chat'
    getWindowState?: () => Promise<{ isMaximized: boolean }>
    onWindowStateChange?: (callback: (state: { isMaximized: boolean }) => void) => () => void
  }
}

function mountApp() {
  return mount(App, {
    global: {
      stubs: {
        NConfigProvider: { template: '<div><slot /></div>' },
        NMessageProvider: { template: '<div><slot /></div>' },
        NDialogProvider: { template: '<div><slot /></div>' },
        NNotificationProvider: { template: '<div><slot /></div>' },
        AuthEventListener: true,
        AppSidebar: true,
        SessionSearchModal: true,
        DefaultCredentialPrompt: true,
        RouterView: { template: '<div class="router-view-test" />' },
      },
    },
  })
}

describe('App web pet mounting', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.removeItem('hermes_api_key')
    routeMock.name = 'hermes.chat'
    routeMock.meta = {}
    appStoreMock.sidebarCollapsed = false
    appStoreMock.pageSidebarExpanded = true
    profilesStoreMock.activeProfileName = 'default'
    delete (window as WindowWithDesktop).hermesDesktop
  })

  it('wires TTS hydration to login and active-profile state', () => {
    mountApp()

    expect(watchServerTtsSettingsHydrationMock).toHaveBeenCalledOnce()
    const sources = watchServerTtsSettingsHydrationMock.mock.calls[0][0]
    expect(sources.isLoginPage()).toBe(false)
    expect(sources.activeProfileName()).toBe('default')
  })

  it.each(['super_admin', 'admin', null] as const)(
    'mounts pending actions but restricts the Runtime prompt for role %s', async (role) => {
      if (role) {
        const payload = btoa(JSON.stringify({ sub: '1', role }))
        localStorage.setItem('hermes_api_key', `header.${payload}.signature`)
      }
      const wrapper = mountApp()
      await flushPromises()

      expect(wrapper.findComponent({ name: 'GlobalPendingActions' }).exists()).toBe(true)
      expect(wrapper.findComponent({ name: 'RuntimeRestartPrompt' }).exists()).toBe(role === 'super_admin')
    wrapper.unmount()
    },
  )

  it('mounts the web pet in the browser web app', async () => {
    const wrapper = mountApp()
    await flushPromises()

    expect(wrapper.findComponent({ name: 'WebPet' }).exists()).toBe(true)
  })

  it('uses native macOS traffic lights without mounting custom window controls', () => {
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: { isDesktop: true, platform: 'darwin' },
    })

    const wrapper = mountApp()

    expect(wrapper.findComponent({ name: 'WebPet' }).exists()).toBe(false)
    expect(wrapper.find('.app-shell').classes()).toContain('desktop-platform-darwin')
    expect(wrapper.findComponent({ name: 'DesktopTitleBar' }).exists()).toBe(false)
  })

  it.each(['win32', 'linux'])('mounts the %s control bar above main content', async (platform) => {
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: { isDesktop: true, platform },
    })

    const wrapper = mountApp()
    await flushPromises()

    expect(wrapper.find('.app-shell').classes()).toContain(`desktop-platform-${platform}`)
    expect(wrapper.findComponent({ name: 'DesktopTitleBar' }).exists()).toBe(true)
    wrapper.unmount()
  })

  it.each(['win32', 'linux'])('expands the %s control bar when a page-owned sidebar is collapsed', async (platform) => {
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: { isDesktop: true, platform },
    })
    appStoreMock.pageSidebarExpanded = false

    const wrapper = mountApp()
    await flushPromises()

    expect(wrapper.findComponent({ name: 'DesktopTitleBar' }).props('leftOffset')).toBe(10)
    wrapper.unmount()
  })

  it.each(['win32', 'linux'])('marks the %s shell as maximized when native window state changes', async (platform) => {
    let listener: ((state: { isMaximized: boolean }) => void) | undefined
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: {
        isDesktop: true,
        platform,
        getWindowState: vi.fn().mockResolvedValue({ isMaximized: false }),
        onWindowStateChange: vi.fn((callback) => {
          listener = callback
          return vi.fn()
        }),
      },
    })

    const wrapper = mountApp()
    await flushPromises()
    expect(wrapper.find('.app-shell').classes()).not.toContain('desktop-window-maximized')

    listener?.({ isMaximized: true })
    await flushPromises()

    expect(wrapper.find('.app-shell').classes()).toContain('desktop-window-maximized')
    wrapper.unmount()
  })

  it('does not duplicate the web pet on the dedicated desktop pet route', () => {
    routeMock.name = 'desktop.pet'

    const wrapper = mountApp()

    expect(wrapper.findComponent({ name: 'WebPet' }).exists()).toBe(false)
  })

  it('leaves chat window controls to native chrome without mounting the application sidebar', async () => {
    routeMock.name = 'desktop.chat'
    routeMock.meta = { standaloneChat: true }
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: { isDesktop: true, platform: 'darwin', windowKind: 'chat' },
    })

    const wrapper = mountApp()
    await flushPromises()

    expect(wrapper.find('.app-shell').classes()).toContain('desktop-chat-window')
    expect(wrapper.findComponent({ name: 'DesktopTitleBar' }).exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'AppSidebar' }).exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'WebPet' }).exists()).toBe(false)
  })
})
