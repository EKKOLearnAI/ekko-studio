// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'

const mockPush = vi.hoisted(() => vi.fn())
const mockFetchCurrentUser = vi.hoisted(() => vi.fn())
const mockGetApiKey = vi.hoisted(() => vi.fn())
const routeState = vi.hoisted(() => ({ fullPath: '/hermes/chat', name: 'hermes.chat' as any }))

vi.mock('vue-router', () => ({
  useRoute: () => routeState,
  useRouter: () => ({ push: mockPush }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@/api/studio/auth', () => ({
  fetchCurrentUser: mockFetchCurrentUser,
}))

vi.mock('@/api/client', () => ({
  getApiKey: mockGetApiKey,
}))

vi.mock('naive-ui', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    NModal: defineComponent({
      props: { show: Boolean, title: String },
      setup(props, { slots }) {
        return () => props.show
          ? h('div', { class: 'modal' }, [
            h('h2', props.title),
            slots.default?.(),
            h('div', { class: 'modal-actions' }, slots.action?.()),
          ])
          : null
      },
    }),
    NButton: defineComponent({
      emits: ['click'],
      setup(_props, { emit, slots }) {
        return () => h('button', { onClick: () => emit('click') }, slots.default?.())
      },
    }),
  }
})

import DefaultCredentialPrompt from '@/components/auth/DefaultCredentialPrompt.vue'

describe('DefaultCredentialPrompt', () => {
  afterEach(() => vi.unstubAllGlobals())

  beforeEach(() => {
    sessionStorage.clear()
    vi.clearAllMocks()
    routeState.fullPath = '/hermes/chat'
    routeState.name = 'hermes.chat'
    mockGetApiKey.mockReturnValue('jwt-token')
  })

  it('prompts after login when the current user still has default credentials', async () => {
    mockFetchCurrentUser.mockResolvedValue({
      id: 1,
      username: 'admin',
      role: 'super_admin',
      status: 'active',
      created_at: 1,
      updated_at: 1,
      last_login_at: 1,
      requiresCredentialChange: true,
    })

    const wrapper = mount(DefaultCredentialPrompt)
    await flushPromises()
    await nextTick()

    expect(mockFetchCurrentUser).toHaveBeenCalledOnce()
    expect(wrapper.text()).toContain('login.defaultCredentialMessage')
    await wrapper.findAll('button')[1].trigger('click')
    expect(mockPush).toHaveBeenCalledWith({ name: 'hermes.settings', query: { tab: 'account' } })
  })

  it('does not prompt on the login route', async () => {
    routeState.fullPath = '/'
    routeState.name = 'login'

    mount(DefaultCredentialPrompt)
    await Promise.resolve()

    expect(mockFetchCurrentUser).not.toHaveBeenCalled()
  })

  it.each([undefined, false])('suppresses the prompt for local desktop mode %s', async remoteMode => {
    vi.stubGlobal('hermesDesktop', { isDesktop: true, remoteMode })

    const wrapper = mount(DefaultCredentialPrompt)
    await flushPromises()

    expect(mockFetchCurrentUser).not.toHaveBeenCalled()
    expect(wrapper.find('.modal').exists()).toBe(false)
  })

  it('preserves the remote desktop warning and account-settings action', async () => {
    vi.stubGlobal('hermesDesktop', { isDesktop: true, remoteMode: true })
    mockFetchCurrentUser.mockResolvedValue({ id: 1, requiresCredentialChange: true })

    const wrapper = mount(DefaultCredentialPrompt)
    await flushPromises()

    expect(mockFetchCurrentUser).toHaveBeenCalledOnce()
    expect(wrapper.text()).toContain('login.defaultCredentialMessage')
    await wrapper.findAll('button')[1].trigger('click')
    expect(mockPush).toHaveBeenCalledWith({ name: 'hermes.settings', query: { tab: 'account' } })
  })

  it('honors a remote desktop dismissal for the current session', async () => {
    vi.stubGlobal('hermesDesktop', { isDesktop: true, remoteMode: true })
    mockFetchCurrentUser.mockResolvedValue({ id: 1, requiresCredentialChange: true })
    sessionStorage.setItem('hermes_default_credentials_prompt_dismissed_1', '1')

    const wrapper = mount(DefaultCredentialPrompt)
    await flushPromises()

    expect(mockFetchCurrentUser).toHaveBeenCalledOnce()
    expect(wrapper.find('.modal').exists()).toBe(false)
  })
})
