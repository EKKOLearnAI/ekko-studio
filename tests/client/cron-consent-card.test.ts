// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import type { CronConsentRequest } from '@/api/hermes/cron-consent'

const api = vi.hoisted(() => ({
  listCronConsents: vi.fn(),
  decideCronConsent: vi.fn(),
  prepareCronConsentContext: vi.fn(),
}))
const socket = vi.hoisted(() => ({ handler: undefined as undefined | ((sessionId: string) => void) }))

vi.mock('@/api/hermes/cron-consent', () => api)
vi.mock('@/api/studio/chat', () => ({
  onCronConsentUpdated: (handler: (sessionId: string) => void) => { socket.handler = handler; return () => { socket.handler = undefined } },
}))
vi.mock('@/utils/clipboard', () => ({ copyToClipboard: vi.fn(async () => true) }))
vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string, values?: Record<string, unknown>) => values ? `${key} ${JSON.stringify(values)}` : key }),
}))
vi.mock('naive-ui', () => ({
  NButton: defineComponent({
    props: { disabled: { type: Boolean, default: false }, loading: { type: Boolean, default: false } },
    emits: ['click'],
    template: '<button class="n-button-stub" :disabled="disabled" @click="$emit(\'click\', $event)"><slot /></button>',
  }),
}))

import CronConsentCard from '@/components/hermes/chat/CronConsentCard.vue'

function makeRequest(overrides: Partial<CronConsentRequest> = {}): CronConsentRequest {
  return {
    id: 'req-1', kind: 'script_report_enrollment', mode: 'new', action: 'create_job', profile: 'default', session_id: 'chat-1',
    session_title: 'Chat one', context_kind: 'prepared', requested_via: 'model_run', created_at: Date.now(), expires_at: Date.now() + 600_000,
    name: 'Daily <b>digest</b>', schedule: 'every 1h', script: 'reports/digest.py', script_kind: 'python',
    script_sha256: 'a'.repeat(64), workdir: null, interpreter: null, resume: true, ...overrides,
  }
}

describe('CronConsentCard', () => {
  beforeEach(() => {
    api.listCronConsents.mockReset()
    api.decideCronConsent.mockReset()
    api.prepareCronConsentContext.mockReset()
  })

  it('stays hidden without pending requests', async () => {
    api.listCronConsents.mockResolvedValue([])
    const wrapper = mount(CronConsentCard, { props: { sessionId: 'chat-1', profile: 'default' } })
    await flushPromises()
    expect(api.listCronConsents).toHaveBeenCalledWith('default', 'chat-1')
    expect(wrapper.find('[data-testid="cron-consent-card"]').exists()).toBe(false)
  })

  it('shows the frozen operation as text and approves it with the session profile', async () => {
    api.listCronConsents.mockResolvedValueOnce([makeRequest()]).mockResolvedValue([])
    api.decideCronConsent.mockResolvedValue({ status: 'approved' })
    const wrapper = mount(CronConsentCard, { props: { sessionId: 'chat-1', profile: 'default' } })
    await flushPromises()
    const card = wrapper.find('[data-testid="cron-consent-request"]')
    expect(card.text()).toContain('chat.cronConsent.action.create_job')
    expect(card.text()).toContain('reports/digest.py')
    expect(card.text()).toContain('Daily <b>digest</b>')
    expect(card.find('b').exists()).toBe(false)
    expect(card.text()).toContain('aaaaaaaaaaaaaaaa…')
    await wrapper.find('[data-testid="cron-consent-approve"]').trigger('click')
    await flushPromises()
    expect(api.decideCronConsent).toHaveBeenCalledWith('default', 'req-1', 'approve')
    expect(wrapper.find('[data-testid="cron-consent-outcome"]').text()).toContain('chat.cronConsent.approved')
  })

  it('reports a refused decision and refetches on a socket hint for its session only', async () => {
    api.listCronConsents.mockResolvedValue([makeRequest({ action: 'subscribe_job', kind: 'cron_session_binding', script: undefined, prompt: 'Summarize', prior_binding: { session_id: 'chat-2', session_title: 'Chat two' } })])
    api.decideCronConsent.mockRejectedValue(Object.assign(new Error('API Error 409'), { code: 'binding_changed' }))
    const wrapper = mount(CronConsentCard, { props: { sessionId: 'chat-1', profile: 'default' } })
    await flushPromises()
    expect(wrapper.text()).toContain('chat.cronConsent.movesFrom')
    await wrapper.find('[data-testid="cron-consent-deny"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="cron-consent-outcome"]').text()).toContain('binding_changed')
    const calls = api.listCronConsents.mock.calls.length
    socket.handler?.('other-session')
    await flushPromises()
    expect(api.listCronConsents.mock.calls.length).toBe(calls)
    socket.handler?.('chat-1')
    await flushPromises()
    expect(api.listCronConsents.mock.calls.length).toBe(calls + 1)
  })

  it('discards a list response for a session the user has left', async () => {
    let resolveFirst!: (value: CronConsentRequest[]) => void
    api.listCronConsents.mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve })).mockResolvedValue([])
    const wrapper = mount(CronConsentCard, { props: { sessionId: 'chat-1', profile: 'default' } })
    await wrapper.setProps({ sessionId: 'chat-2' })
    resolveFirst([makeRequest()])
    await flushPromises()
    expect(wrapper.find('[data-testid="cron-consent-request"]').exists()).toBe(false)
  })

  it('a decision still in flight when the user switches session reports nothing in the new session', async () => {
    let finish!: (value: unknown) => void
    api.listCronConsents.mockResolvedValueOnce([makeRequest()]).mockResolvedValue([])
    api.decideCronConsent.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const wrapper = mount(CronConsentCard, { props: { sessionId: 'chat-1', profile: 'default' } })
    await flushPromises()
    await wrapper.find('[data-testid="cron-consent-approve"]').trigger('click')
    await wrapper.setProps({ sessionId: 'chat-2', profile: 'research' })
    finish({ status: 'approved' })
    await flushPromises()
    // The decision was sent for its own request and profile, and its outcome stays with that session.
    expect(api.decideCronConsent).toHaveBeenCalledWith('default', 'req-1', 'approve')
    expect(wrapper.find('[data-testid="cron-consent-outcome"]').exists()).toBe(false)
    expect(api.listCronConsents).toHaveBeenLastCalledWith('research', 'chat-2')
  })

  it('prepares a model-free setup context for this session and shows its id', async () => {
    api.listCronConsents.mockResolvedValue([])
    api.prepareCronConsentContext.mockResolvedValue({ context_id: 'ctx-123', profile: 'default', session_id: 'chat-1', expires_at: Date.now() + 600_000 })
    const wrapper = mount(CronConsentCard, { props: { sessionId: 'chat-1', profile: 'default' } })
    await flushPromises()
    await (wrapper.vm as any).prepare()
    await flushPromises()
    expect(api.prepareCronConsentContext).toHaveBeenCalledWith('default', 'chat-1')
    expect(wrapper.find('[data-testid="cron-consent-context"]').text()).toBe('ctx-123')
    // A failed re-prepare never leaves the superseded context on screen.
    api.prepareCronConsentContext.mockRejectedValueOnce(Object.assign(new Error('API Error 429'), { code: 'consent_capacity' }))
    await (wrapper.vm as any).prepare()
    await flushPromises()
    expect(wrapper.find('[data-testid="cron-consent-context"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('consent_capacity')
  })

  function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
    return { promise, resolve, reject }
  }
  const context = (id: string, sessionId = 'chat-1', profile = 'default') => ({ context_id: id, profile, session_id: sessionId, expires_at: Date.now() + 600_000 })

  it('keeps the newest setup context when an older preparation answers last', async () => {
    api.listCronConsents.mockResolvedValue([])
    const first = deferred<any>(), second = deferred<any>()
    api.prepareCronConsentContext.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const wrapper = mount(CronConsentCard, { props: { sessionId: 'chat-1', profile: 'default' } })
    await flushPromises()
    void (wrapper.vm as any).prepare()
    void (wrapper.vm as any).prepare()
    second.resolve(context('ctx-new'))
    await flushPromises()
    first.resolve(context('ctx-old'))
    await flushPromises()
    expect(wrapper.find('[data-testid="cron-consent-context"]').text()).toBe('ctx-new')
  })

  it('ignores a stale preparation failure after a newer one succeeded', async () => {
    api.listCronConsents.mockResolvedValue([])
    const first = deferred<any>(), second = deferred<any>()
    api.prepareCronConsentContext.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const wrapper = mount(CronConsentCard, { props: { sessionId: 'chat-1', profile: 'default' } })
    await flushPromises()
    void (wrapper.vm as any).prepare()
    void (wrapper.vm as any).prepare()
    second.resolve(context('ctx-new'))
    await flushPromises()
    first.reject(Object.assign(new Error('late'), { code: 'late' }))
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="cron-consent-context"]').text()).toBe('ctx-new')
  })

  for (const [label, next] of [['session', { sessionId: 'chat-2', profile: 'default' }], ['profile', { sessionId: 'chat-1', profile: 'other' }]] as const) {
    it(`drops a setup context or error that answers after a ${label} switch, and clears a shown one`, async () => {
      api.listCronConsents.mockResolvedValue([])
      api.prepareCronConsentContext.mockResolvedValueOnce(context('ctx-shown'))
      const pending = deferred<any>(), failing = deferred<any>()
      api.prepareCronConsentContext.mockReturnValueOnce(pending.promise).mockReturnValueOnce(failing.promise)
      const wrapper = mount(CronConsentCard, { props: { sessionId: 'chat-1', profile: 'default' } })
      await flushPromises()
      await (wrapper.vm as any).prepare()
      await flushPromises()
      expect(wrapper.find('[data-testid="cron-consent-context"]').text()).toBe('ctx-shown')
      void (wrapper.vm as any).prepare()
      void (wrapper.vm as any).prepare()
      await wrapper.setProps(next)
      await flushPromises()
      expect(wrapper.find('[data-testid="cron-consent-setup"]').exists()).toBe(false)
      pending.resolve(context('ctx-stale'))
      failing.reject(Object.assign(new Error('stale'), { code: 'stale' }))
      await flushPromises()
      expect(wrapper.find('[data-testid="cron-consent-setup"]').exists()).toBe(false)
      expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    })
  }

  it('shows a preparation failure while a pending request keeps the card open', async () => {
    api.listCronConsents.mockResolvedValue([makeRequest()])
    api.prepareCronConsentContext.mockRejectedValue(Object.assign(new Error('refused'), { code: 'refused' }))
    const wrapper = mount(CronConsentCard, { props: { sessionId: 'chat-1', profile: 'default' } })
    await flushPromises()
    await (wrapper.vm as any).prepare()
    await flushPromises()
    expect(wrapper.find('[data-testid="cron-consent-request"]').exists()).toBe(true)
    expect(wrapper.find('[role="alert"]').text()).toContain('chat.cronConsent.setupFailed')
  })

})
