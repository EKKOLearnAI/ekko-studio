// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const apiMocks = vi.hoisted(() => ({
  startOrcaRouterLogin: vi.fn(),
  pollOrcaRouterLogin: vi.fn(),
  submitOrcaRouterCode: vi.fn(),
  cancelOrcaRouterLogin: vi.fn(),
  getOrcaRouterAuthStatus: vi.fn(),
}))

const messageMock = vi.hoisted(() => ({
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}))

vi.mock('@/api/hermes/orcarouter-auth', () => apiMocks)
vi.mock('@/utils/clipboard', () => ({ copyToClipboard: vi.fn(async () => true) }))
vi.mock('@/utils/orcaRouterBrand', () => ({
  ORCA_ROUTER_LOGO_URL: 'https://www.orcarouter.ai/orca-logo-classic.png',
  ORCA_ROUTER_KEY_DASHBOARD_URL: 'https://www.orcarouter.ai/console/token',
}))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('naive-ui', () => ({
  NModal: { template: '<div><slot /><slot name="footer" /></div>' },
  NButton: { template: '<button @click="$emit(\'click\')"><slot /></button>' },
  NInput: { template: '<input />' },
  NSpin: { template: '<span class="spin" />' },
  NAlert: { template: '<div class="alert"><slot /></div>' },
  useMessage: () => messageMock,
}))

import OrcaRouterLoginModal from '@/components/hermes/models/OrcaRouterLoginModal.vue'

function mountModal() {
  return mount(OrcaRouterLoginModal, { attachTo: document.body })
}

function startPayload(sessionId: string) {
  return {
    session_id: sessionId,
    authorization_url: `https://www.orcarouter.ai/auth?state=s&code_challenge=c&code_challenge_method=S256`,
    callback_mode: 'loopback',
    expires_in: 900,
    scope: 'api',
    key_dashboard_url: 'https://www.orcarouter.ai/console/token',
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('open', vi.fn())
  for (const fn of Object.values(apiMocks)) fn.mockReset()
  for (const fn of Object.values(messageMock)) fn.mockReset()
  apiMocks.cancelOrcaRouterLogin.mockResolvedValue({ status: 'cancelled' })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('OrcaRouterLoginModal', () => {
  it('starts the loopback flow on mount and shows both authentication modes', async () => {
    apiMocks.startOrcaRouterLogin.mockResolvedValue(startPayload('sess-1'))
    apiMocks.pollOrcaRouterLogin.mockResolvedValue({ status: 'pending', error: null })

    const wrapper = mountModal()
    await flushPromises()

    expect(apiMocks.startOrcaRouterLogin).toHaveBeenCalledWith('loopback')
    expect(wrapper.find('[data-testid="orca-router-mode-loopback"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="orca-router-mode-oob"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="orca-router-open-link"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('opens the authorization URL in a new tab and never in an iframe', async () => {
    apiMocks.startOrcaRouterLogin.mockResolvedValue(startPayload('sess-2'))
    apiMocks.pollOrcaRouterLogin.mockResolvedValue({ status: 'pending', error: null })

    const wrapper = mountModal()
    await flushPromises()

    expect(window.open).toHaveBeenCalledWith(
      expect.stringContaining('https://www.orcarouter.ai/auth'),
      '_blank',
    )
    expect(wrapper.find('iframe').exists()).toBe(false)
    wrapper.unmount()
  })

  it('releases the login lock on pagehide without remounting, so a second login can start', async () => {
    apiMocks.startOrcaRouterLogin.mockResolvedValue(startPayload('sess-3'))
    apiMocks.pollOrcaRouterLogin.mockResolvedValue({ status: 'pending', error: null })

    const wrapper = mountModal()
    await flushPromises()
    expect(apiMocks.startOrcaRouterLogin).toHaveBeenCalledTimes(1)

    // The browser parks the page in the back-forward cache.
    window.dispatchEvent(new Event('pagehide'))
    await flushPromises()

    // The server-side task is cancelled with keepalive so a restored page does
    // not hold the lock.
    expect(apiMocks.cancelOrcaRouterLogin).toHaveBeenCalledWith('sess-3', { keepalive: true })

    // The restored page must be able to start a fresh attempt immediately.
    apiMocks.startOrcaRouterLogin.mockResolvedValue(startPayload('sess-4'))
    await (wrapper.vm as any).startLogin('loopback')
    await flushPromises()

    expect(apiMocks.startOrcaRouterLogin).toHaveBeenCalledTimes(2)
    expect(apiMocks.startOrcaRouterLogin).toHaveBeenLastCalledWith('loopback')
    wrapper.unmount()
  })

  it('does not let a late poll from the hidden page settle the new attempt', async () => {
    apiMocks.startOrcaRouterLogin.mockResolvedValue(startPayload('sess-5'))
    apiMocks.pollOrcaRouterLogin.mockResolvedValue({ status: 'pending', error: null })

    const wrapper = mountModal()
    await flushPromises()

    window.dispatchEvent(new Event('pagehide'))
    await flushPromises()

    apiMocks.startOrcaRouterLogin.mockResolvedValue(startPayload('sess-6'))
    await (wrapper.vm as any).startLogin('loopback')
    await flushPromises()

    // Drain every pending poll: the stale generation must not emit success.
    await vi.advanceTimersByTimeAsync(10_000)
    await flushPromises()
    expect(wrapper.emitted('success')).toBeFalsy()
    wrapper.unmount()
  })

  it('releases the lock when the user switches authentication mode', async () => {
    apiMocks.startOrcaRouterLogin.mockResolvedValue(startPayload('sess-7'))
    apiMocks.pollOrcaRouterLogin.mockResolvedValue({ status: 'pending', error: null })

    const wrapper = mountModal()
    await flushPromises()
    await wrapper.find('[data-testid="orca-router-mode-oob"]').trigger('click')
    await flushPromises()

    expect(apiMocks.cancelOrcaRouterLogin).toHaveBeenCalledWith('sess-7', { keepalive: false })
    expect(apiMocks.startOrcaRouterLogin).toHaveBeenLastCalledWith('oob')
    wrapper.unmount()
  })

  it('releases the lock when the modal is closed', async () => {
    apiMocks.startOrcaRouterLogin.mockResolvedValue(startPayload('sess-8'))
    apiMocks.pollOrcaRouterLogin.mockResolvedValue({ status: 'pending', error: null })

    const wrapper = mountModal()
    await flushPromises()
    await wrapper.find('[data-testid="orca-router-cancel"]').trigger('click')
    await flushPromises()

    expect(apiMocks.cancelOrcaRouterLogin).toHaveBeenCalledWith('sess-8', { keepalive: false })
    await vi.advanceTimersByTimeAsync(500)
    expect(wrapper.emitted('close')).toBeTruthy()
    wrapper.unmount()
  })

  it('releases the lock on unmount without writing component state', async () => {
    apiMocks.startOrcaRouterLogin.mockResolvedValue(startPayload('sess-9'))
    apiMocks.pollOrcaRouterLogin.mockResolvedValue({ status: 'pending', error: null })

    const wrapper = mountModal()
    await flushPromises()
    wrapper.unmount()
    await flushPromises()

    // Unmount releases the server lock; the explicit-cancel form is used
    // because the component may already be detached.
    expect(apiMocks.cancelOrcaRouterLogin).toHaveBeenCalledWith('sess-9')
  })

  it('emits success once the poll reports an approved authorization', async () => {
    apiMocks.startOrcaRouterLogin.mockResolvedValue(startPayload('sess-10'))
    apiMocks.pollOrcaRouterLogin.mockResolvedValue({ status: 'approved', error: null })

    const wrapper = mountModal()
    await flushPromises()
    await vi.advanceTimersByTimeAsync(2500)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(1500)
    await flushPromises()

    expect(messageMock.success).toHaveBeenCalledWith('models.orcaRouterApproved')
    expect(wrapper.emitted('success')).toBeTruthy()
    wrapper.unmount()
  })

  it('surfaces a denial without emitting success', async () => {
    apiMocks.startOrcaRouterLogin.mockResolvedValue(startPayload('sess-11'))
    apiMocks.pollOrcaRouterLogin.mockResolvedValue({ status: 'denied', error: 'access_denied' })

    const wrapper = mountModal()
    await flushPromises()
    await vi.advanceTimersByTimeAsync(2500)
    await flushPromises()

    expect(wrapper.find('[data-testid="orca-router-error"]').exists()).toBe(true)
    expect(wrapper.emitted('success')).toBeFalsy()
    wrapper.unmount()
  })

  it('stops polling once the attempt is settled', async () => {
    apiMocks.startOrcaRouterLogin.mockResolvedValue(startPayload('sess-12'))
    apiMocks.pollOrcaRouterLogin.mockResolvedValue({ status: 'expired', error: null })

    const wrapper = mountModal()
    await flushPromises()
    await vi.advanceTimersByTimeAsync(2500)
    await flushPromises()
    const callsAfterSettle = apiMocks.pollOrcaRouterLogin.mock.calls.length
    await vi.advanceTimersByTimeAsync(30_000)
    await flushPromises()

    expect(apiMocks.pollOrcaRouterLogin.mock.calls.length).toBe(callsAfterSettle)
    wrapper.unmount()
  })

  it('reports a start failure instead of leaving the modal busy forever', async () => {
    apiMocks.startOrcaRouterLogin.mockRejectedValue(new Error('gateway unreachable'))

    const wrapper = mountModal()
    await flushPromises()

    expect(wrapper.find('[data-testid="orca-router-error"]').exists()).toBe(true)
    // The retry control must be usable: busy state was released.
    expect(wrapper.find('[data-testid="orca-router-retry"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('submits a pasted out-of-band code and emits success on approval', async () => {
    apiMocks.startOrcaRouterLogin.mockResolvedValue({ ...startPayload('sess-13'), callback_mode: 'oob' })
    apiMocks.submitOrcaRouterCode.mockResolvedValue({ status: 'approved', error: null, error_code: null, callback_mode: 'oob' })

    const wrapper = mountModal()
    await flushPromises()
    await (wrapper.vm as any).startLogin('oob')
    await flushPromises()
    // The user pastes the code the consent screen displayed.
    ;(wrapper.vm as any).pastedCode = 'consent-code'
    await (wrapper.vm as any).submitCode()
    await flushPromises()

    expect(apiMocks.submitOrcaRouterCode).toHaveBeenCalledWith('sess-13', 'consent-code')
    await vi.advanceTimersByTimeAsync(1500)
    await flushPromises()
    expect(wrapper.emitted('success')).toBeTruthy()
    wrapper.unmount()
  })

  it('does not submit an empty out-of-band code', async () => {
    apiMocks.startOrcaRouterLogin.mockResolvedValue({ ...startPayload('sess-15'), callback_mode: 'oob' })

    const wrapper = mountModal()
    await flushPromises()
    await (wrapper.vm as any).startLogin('oob')
    await flushPromises()
    await (wrapper.vm as any).submitCode()
    await flushPromises()

    expect(apiMocks.submitOrcaRouterCode).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('never renders a verifier or a key in the modal', async () => {
    apiMocks.startOrcaRouterLogin.mockResolvedValue(startPayload('sess-14'))
    apiMocks.pollOrcaRouterLogin.mockResolvedValue({ status: 'pending', error: null })

    const wrapper = mountModal()
    await flushPromises()

    expect(wrapper.html()).not.toMatch(/sk-orca-[A-Za-z0-9]{8,}/)
    expect(wrapper.html()).not.toMatch(/code_verifier/)
    wrapper.unmount()
  })
})
