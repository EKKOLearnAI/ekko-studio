// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { reactive } from 'vue'
import PersonTaskChat from '@/components/hermes/person/PersonTaskChat.vue'
import PersonTaskConversation from '@/components/hermes/person/PersonTaskConversation.vue'
import SessionTasksDrawer from '@/components/hermes/tasks/SessionTasksDrawer.vue'

const mocks = vi.hoisted(() => ({
  request: vi.fn(), switchSession: vi.fn(), subscribers: new Set<(event: { session_id?: string }) => void>(),
  route: { query: {} as Record<string, string> },
}))
vi.mock('@/api/person', () => ({ personRequest: mocks.request, personTaskCanStop: () => false, stopPersonTask: vi.fn() }))
vi.mock('@/api/studio/chat', () => ({ onPersonUpdated: (fn: (event: { session_id?: string }) => void) => { mocks.subscribers.add(fn); return () => mocks.subscribers.delete(fn) } }))
vi.mock('@/stores/hermes/chat', () => ({ provideScopedChatStore: () => ({ ensureSessionLoaded: vi.fn(), switchSession: mocks.switchSession }), buildContentBlocks: vi.fn(), uploadFiles: vi.fn() }))
vi.mock('@/api/studio/session-tasks', () => ({ fetchSessionTasks: vi.fn(), updateSessionTaskStatus: vi.fn() }))
vi.mock('@/components/hermes/chat/MessageList.vue', () => ({ default: { template: '<div class="test-messages" />' } }))
vi.mock('@/components/hermes/chat/ChatInput.vue', () => ({ default: { template: '<div class="test-input" />' } }))
vi.mock('@/components/hermes/chat/MessageQueueFloatPanel.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/components/hermes/person/PersonWorkspaceFiles.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/components/hermes/tasks/useTaskDrawerLayout', () => ({ useTaskDrawerLayout: () => ({ drawerWidth: 800, isMobile: false }) }))
vi.mock('@/utils/chat-agent-avatar', () => ({ PERSON_AVATAR: { label: 'Person' }, chatSessionAgentAvatar: () => ({ src: '/logo.png', label: 'Person' }) }))
vi.mock('vue-router', () => ({ useRoute: () => mocks.route, useRouter: () => ({ replace: vi.fn() }) }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: { value: 'en' } }) }))
vi.mock('naive-ui', () => {
  const pass = { template: '<section><slot name="header" /><slot /></section>' }
  return { NDrawer: pass, NDrawerContent: pass, NButton: { template: '<button><slot /></button>' }, NAlert: { template: '<div role="alert"><slot /></div>' },
    NSpin: { template: '<div role="progressbar" />' }, NSelect: pass, NDropdown: pass, NEmpty: pass, NInput: pass, NPagination: pass, useMessage: () => ({ error: vi.fn() }) }
})

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const response = { task: { id: 'task', title: 'Loaded task', status: 'open', revision: 1 }, session: null, execution: null, executions: [] }
const row = (title: string) => ({ id: title, title, summary: 'Summary', status: 'open', updated_at: 1, session_id: 'main', selection_json: '{}' })
const emitUpdate = () => { for (const fn of mocks.subscribers) fn({ session_id: 'main' }) }
let wrapper: VueWrapper | undefined
beforeEach(() => { mocks.request.mockReset(); mocks.switchSession.mockReset().mockResolvedValue(true); mocks.subscribers.clear(); mocks.route = reactive({ query: {} }) })
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.useRealTimers() })

describe('Person task loading and recovery', () => {
  it('replaces a failed initial detail spinner with retry and recovers without reopening', async () => {
    mocks.request.mockRejectedValueOnce(new Error('HTTP 503')).mockResolvedValueOnce(response)
    wrapper = mount(PersonTaskChat, { props: { taskId: 'task', mainSessionId: 'main' } })
    await flushPromises()
    expect(wrapper.find('[role="progressbar"]').exists()).toBe(false)
    expect(wrapper.get('[role="alert"]').text()).toContain('sessionTasks.loadFailed')
    await wrapper.get('[role="alert"] button').trigger('click'); await flushPromises()
    expect(wrapper.text()).toContain('Loaded task')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(mocks.request).toHaveBeenCalledTimes(2)
  })

  it('allows update-driven recovery after the initial detail failure', async () => {
    mocks.request.mockRejectedValueOnce(new Error('HTTP 503')).mockResolvedValueOnce(response)
    wrapper = mount(PersonTaskChat, { props: { taskId: 'task', mainSessionId: 'main' } })
    await flushPromises(); emitUpdate(); await flushPromises()
    expect(wrapper.text()).toContain('Loaded task')
    expect(wrapper.find('[role="progressbar"]').exists()).toBe(false)
  })

  it('ends a hung detail read and keeps late data from replacing a successful retry', async () => {
    vi.useFakeTimers()
    const hung = deferred<typeof response>()
    mocks.request.mockReturnValueOnce(hung.promise).mockResolvedValueOnce(response)
    wrapper = mount(PersonTaskChat, { props: { taskId: 'task', mainSessionId: 'main' } })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(wrapper.find('[role="progressbar"]').exists()).toBe(false)
    expect(mocks.request.mock.calls[0][3].aborted).toBe(true)
    await wrapper.get('[role="alert"] button').trigger('click'); await flushPromises()
    hung.resolve({ ...response, task: { ...response.task, title: 'Stale' } }); await flushPromises()
    expect(wrapper.text()).toContain('Loaded task'); expect(wrapper.text()).not.toContain('Stale')
  })

  it('shows the completed list during an event burst before its one follow-up finishes', async () => {
    const first = deferred<{ tasks: ReturnType<typeof row>[] }>(), next = deferred<{ tasks: ReturnType<typeof row>[] }>()
    mocks.request.mockReturnValueOnce(first.promise).mockReturnValueOnce(next.promise)
    wrapper = mount(SessionTasksDrawer, { props: { show: true, person: true, personSessionId: 'main' } })
    await flushPromises()
    for (let i = 0; i < 20; i++) emitUpdate()
    expect(mocks.request).toHaveBeenCalledTimes(1)
    first.resolve({ tasks: [row('First result')] }); await flushPromises()
    expect(wrapper.find('[role="progressbar"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('First result')
    expect(mocks.request).toHaveBeenCalledTimes(2)
    next.resolve({ tasks: [row('Latest result')] }); await flushPromises()
    expect(wrapper.text()).toContain('Latest result')
    expect(mocks.request).toHaveBeenCalledTimes(2)
  })

  it('cancels hidden lists and discards responses from a previous conversation', async () => {
    const old = deferred<{ tasks: ReturnType<typeof row>[] }>(), current = deferred<{ tasks: ReturnType<typeof row>[] }>()
    mocks.request.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    wrapper = mount(SessionTasksDrawer, { props: { show: true, person: true, personSessionId: 'main' } })
    await flushPromises()
    await wrapper.setProps({ personSessionId: 'other' }); await flushPromises()
    expect(mocks.request.mock.calls[0][3].aborted).toBe(true)
    old.resolve({ tasks: [row('Obsolete')] }); await flushPromises()
    expect(wrapper.text()).not.toContain('Obsolete')
    await wrapper.setProps({ show: false }); await flushPromises()
    expect(mocks.request.mock.calls[1][3].aborted).toBe(true)
    current.resolve({ tasks: [row('Hidden')] }); await flushPromises()
    expect(wrapper.find('.task-row').exists()).toBe(false)
  })

  it('retains the published list when a background refresh fails and accepts the next update', async () => {
    mocks.request.mockResolvedValueOnce({ tasks: [row('Published')] }).mockRejectedValueOnce(new Error('HTTP 503'))
      .mockResolvedValueOnce({ tasks: [row('Recovered')] })
    wrapper = mount(SessionTasksDrawer, { props: { show: true, person: true, personSessionId: 'main' } })
    await flushPromises(); emitUpdate(); await flushPromises()
    expect(wrapper.text()).toContain('Published')
    expect(wrapper.find('[role="progressbar"]').exists()).toBe(false)
    emitUpdate(); await flushPromises()
    expect(wrapper.text()).toContain('Recovered')
  })

  it('offers retry when message resume returns false, then displays the conversation on success', async () => {
    mocks.switchSession.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    wrapper = mount(PersonTaskConversation, { props: { session: { id: 'task-session' } as any, pending: [], send: vi.fn(), disabled: false, canInsert: false,
      requestingInsertion: '', insert: vi.fn(), stopControl: { active: false, allowSend: true, pending: false, request: vi.fn() } } })
    await flushPromises()
    expect(wrapper.find('[role="progressbar"]').exists()).toBe(false)
    expect(wrapper.find('.test-messages').exists()).toBe(false)
    await wrapper.get('[role="alert"] button').trigger('click'); await flushPromises()
    expect(wrapper.find('.test-messages').exists()).toBe(true)
    expect(wrapper.find('.test-input').exists()).toBe(true)
  })
})
