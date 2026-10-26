// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const mockReplace = vi.hoisted(() => vi.fn())
const mockFetchAuthStatus = vi.hoisted(() => vi.fn())
const mockLoginWithPassword = vi.hoisted(() => vi.fn())
const mockSetApiKey = vi.hoisted(() => vi.fn())
const mockClearApiKey = vi.hoisted(() => vi.fn())
const mockHasApiKey = vi.hoisted(() => vi.fn())
const mockIsDesktopShell = vi.hoisted(() => vi.fn())
const mockDesktopBridge = vi.hoisted(() => vi.fn())
const mockActivateUserTheme = vi.hoisted(() => vi.fn())
const mockRoute = vi.hoisted(() => ({ query: {} as Record<string, unknown> }))

vi.mock('vue-router', () => ({
  useRouter: () => ({
    replace: mockReplace,
  }),
  useRoute: () => mockRoute,
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@/api/client', () => ({
  setApiKey: mockSetApiKey,
  clearApiKey: mockClearApiKey,
  hasApiKey: mockHasApiKey,
}))

vi.mock('@/api/studio/auth', () => ({
  fetchAuthStatus: mockFetchAuthStatus,
  loginWithPassword: mockLoginWithPassword,
}))

vi.mock('@/utils/desktop-bridge', () => ({
  isDesktopShell: mockIsDesktopShell,
  desktopBridge: mockDesktopBridge,
}))

vi.mock('@/composables/useTheme', () => ({
  useTheme: () => ({
    activateUserTheme: mockActivateUserTheme,
  }),
}))

import LoginView from '@/views/LoginView.vue'

describe('LoginView password login', () => {
  beforeEach(() => {
    delete (window as any).__LOGIN_TOKEN__
    vi.clearAllMocks()
    mockIsDesktopShell.mockReturnValue(false)
    mockDesktopBridge.mockReturnValue(undefined)
    mockRoute.query = {}
    mockHasApiKey.mockReturnValue(false)
    mockFetchAuthStatus.mockResolvedValue({ hasPasswordLogin: true, username: 'admin' })
  })

  it('keeps the web login redirect when a token already exists', () => {
    mockHasApiKey.mockReturnValue(true)

    mount(LoginView)

    expect(mockClearApiKey).not.toHaveBeenCalled()
    expect(mockReplace).toHaveBeenCalledWith('/hermes/chat')
  })

  it('clears stale tokens when the desktop login page is opened', () => {
    mockIsDesktopShell.mockReturnValue(true)
    mockHasApiKey.mockReturnValue(true)

    mount(LoginView)

    expect(mockClearApiKey).toHaveBeenCalledOnce()
    expect(mockReplace).not.toHaveBeenCalledWith('/hermes/chat')
  })

  it('preserves a remote desktop login and redirects as a web client', () => {
    mockIsDesktopShell.mockReturnValue(true)
    mockDesktopBridge.mockReturnValue({ isDesktop: true, remoteMode: true })
    mockHasApiKey.mockReturnValue(true)
    mount(LoginView)
    expect(mockClearApiKey).not.toHaveBeenCalled()
    expect(mockReplace).toHaveBeenCalledWith('/hermes/chat')
  })

  it('logs in with username and password', async () => {
    const theme = {
      fontSize: 16,
      textColor: '#202020',
      accentColor: '#3366ff',
      background: null,
      updatedAt: 42,
    }
    mockLoginWithPassword.mockResolvedValue({ token: 'jwt-token', userId: 7, theme })
    const wrapper = mount(LoginView)

    const inputs = wrapper.findAll('input.login-input')
    await inputs[0].setValue('admin')
    await inputs[1].setValue('123456')
    await wrapper.find('form.login-form').trigger('submit')

    expect(mockLoginWithPassword).toHaveBeenCalledWith('admin', '123456')
    expect(mockSetApiKey).toHaveBeenCalledWith('jwt-token')
    expect(mockActivateUserTheme).toHaveBeenCalledWith(7, theme)
    expect(mockReplace).toHaveBeenCalledWith('/hermes/chat')
  })

  it('returns to the Agent link page after the first login', async () => {
    const redirect = '/group-chat-link?cloudOrigin=http%3A%2F%2F47.243.215.84%3A8088&requestId=handoff-id'
    mockRoute.query = { redirect }
    mockLoginWithPassword.mockResolvedValue({ token: 'jwt-token', userId: 7, theme: null })
    const wrapper = mount(LoginView)

    const inputs = wrapper.findAll('input.login-input')
    await inputs[0].setValue('admin')
    await inputs[1].setValue('123456')
    await wrapper.find('form.login-form').trigger('submit')

    expect(mockReplace).toHaveBeenCalledWith(redirect)
  })

  it('shows the default login hint', () => {
    const wrapper = mount(LoginView)

    expect(wrapper.text()).toContain('login.defaultCredentialsHint')
  })

  it('shows an error when password login fails', async () => {
    mockLoginWithPassword.mockRejectedValue(new Error('Invalid username or password'))
    const wrapper = mount(LoginView)

    const inputs = wrapper.findAll('input.login-input')
    await inputs[0].setValue('admin')
    await inputs[1].setValue('bad-password')
    await wrapper.find('form.login-form').trigger('submit')

    expect(wrapper.find('.login-error').text()).toBe('Invalid username or password')
    expect(mockSetApiKey).not.toHaveBeenCalled()
    expect(mockReplace).not.toHaveBeenCalled()
  })

  it('shows the reset command hint when the login IP is locked', async () => {
    const err: any = new Error('Too many login attempts')
    err.status = 429
    mockLoginWithPassword.mockRejectedValue(err)
    const wrapper = mount(LoginView)

    const inputs = wrapper.findAll('input.login-input')
    await inputs[0].setValue('admin')
    await inputs[1].setValue('123456')
    await wrapper.find('form.login-form').trigger('submit')

    expect(wrapper.find('.login-error').text()).toBe('login.tooManyAttempts')
    expect(wrapper.find('.login-lock-hint').text()).toContain('login.lockResetHint')
    expect(wrapper.find('.login-lock-hint').text()).toContain('login.defaultLoginResetHint')
    const commands = wrapper.findAll('.login-lock-hint code').map(command => command.text())
    expect(commands).toEqual([
      'hermes-web-ui clear-login-locks --restart',
      'hermes-web-ui reset-default-login',
    ])
  })

  it('shows the tray reset hint for locked desktop logins', async () => {
    mockIsDesktopShell.mockReturnValue(true)
    const err: any = new Error('Too many login attempts')
    err.status = 429
    mockLoginWithPassword.mockRejectedValue(err)
    const wrapper = mount(LoginView)

    const inputs = wrapper.findAll('input.login-input')
    await inputs[0].setValue('admin')
    await inputs[1].setValue('123456')
    await wrapper.find('form.login-form').trigger('submit')

    expect(wrapper.find('.login-error').text()).toBe('login.tooManyAttempts')
    expect(wrapper.find('.login-lock-hint').text()).toContain('login.desktopLockResetHint')
    expect(wrapper.findAll('.login-lock-hint code')).toHaveLength(0)
  })

  it('shows server recovery commands for a locked remote desktop login', async () => {
    mockIsDesktopShell.mockReturnValue(true)
    mockDesktopBridge.mockReturnValue({ isDesktop: true, remoteMode: true })
    mockLoginWithPassword.mockRejectedValue(Object.assign(new Error('Locked'), { status: 429 }))
    const wrapper = mount(LoginView)
    const inputs = wrapper.findAll('input.login-input')
    await inputs[0].setValue('admin')
    await inputs[1].setValue('123456')
    await wrapper.find('form.login-form').trigger('submit')
    expect(wrapper.find('.login-lock-hint').text()).toContain('login.lockResetHint')
    expect(wrapper.find('.login-lock-hint').text()).not.toContain('login.desktopLockResetHint')
    expect(wrapper.findAll('.login-lock-hint code')).toHaveLength(2)
  })
})
