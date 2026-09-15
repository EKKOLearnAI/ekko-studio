// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createTestingPinia } from '@pinia/testing'
import { useChatStore } from '@/stores/hermes/chat'
import { useChatAnnotationsStore } from '@/stores/hermes/chat-annotations'
import { responseAnnotationSourceHash, type ResponseAnnotation } from '@/utils/chat-response-annotations'
import ChatInput from '@/components/hermes/chat/ChatInput.vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string, params?: Record<string, unknown>) => params?.count != null ? `${key}:${params.count}` : key }),
}))

vi.mock('naive-ui', () => ({
  NButton: { template: '<button type="button" v-bind="$attrs"><slot /><slot name="icon" /></button>' },
  NTooltip: { template: '<div><slot name="trigger" /><slot /></div>' },
  NSwitch: { template: '<button type="button"></button>' },
  NDropdown: { props: ['options'], emits: ['select'], template: '<div><slot /></div>' },
  NModal: { template: '<div><slot /><slot name="footer" /></div>' },
  NInputNumber: { template: '<input />' },
  NPopover: { template: '<div><slot name="trigger" /><slot /></div>' },
  NSlider: { props: ['value'], template: '<input type="range" />' },
  useMessage: () => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn() }),
  useDialog: () => ({ warning: vi.fn() }),
}))

vi.mock('@/api/studio/sessions', () => ({
  fetchContextLength: vi.fn().mockResolvedValue(256000),
  setSessionPushEnabled: vi.fn().mockResolvedValue(true),
}))
vi.mock('@/api/hermes/model-context', () => ({ setModelContext: vi.fn() }))
vi.mock('@/api/studio/social-messages', () => ({ fetchSocialMessagePlatforms: vi.fn().mockResolvedValue([]) }))
vi.mock('@/api/hermes/skills', () => ({ fetchSkills: vi.fn().mockResolvedValue({ categories: [], archived: [] }) }))
vi.mock('@/api/hermes/skill-bundles', () => ({
  fetchSkillBundles: vi.fn().mockResolvedValue([]),
  deleteSkillBundleApi: vi.fn(),
}))
vi.mock('@/composables/useToolTraceVisibility', () => ({
  useToolTraceVisibility: () => ({ toolTraceVisible: { value: true }, toggleToolTraceVisible: vi.fn() }),
}))
vi.mock('@/components/hermes/chat/BundleCreateModal.vue', () => ({ default: { template: '<div />' } }))

function annotation(): ResponseAnnotation {
  return {
    id: 'annotation-1',
    ordinal: 1,
    selectedText: 'selected text',
    comment: 'Comment',
    sourceMessageId: 'assistant-1',
    sourceHash: responseAnnotationSourceHash('selected text in answer'),
    start: 0,
    end: 13,
    prefix: '',
    suffix: ' in answer',
    files: [],
  }
}

function mountInput() {
  const pinia = createTestingPinia({ stubActions: false, createSpy: vi.fn })
  const chatStore = useChatStore()
  chatStore.sessions = [{
    id: 'session-1', title: 'Session', source: 'cli', messages: [], createdAt: Date.now(), updatedAt: Date.now(),
  }]
  chatStore.activeSessionId = 'session-1'
  chatStore.activeSession = chatStore.sessions[0]
  return { wrapper: mount(ChatInput, { attachTo: document.body, global: { plugins: [pinia] } }), chatStore }
}

describe('ChatInput response annotations', () => {
  beforeEach(() => {
    localStorage.clear()
    document.body.innerHTML = ''
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:test-attachment'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    })
  })

  it('submits annotation-only input with owned files and clears after dispatch', async () => {
    const { wrapper, chatStore } = mountInput()
    const annotationsStore = useChatAnnotationsStore()
    annotationsStore.addAnnotation('session-1', annotation())
    const proof = new File(['proof'], 'proof.txt', { type: 'text/plain' })
    annotationsStore.addPendingFiles('session-1', 'annotation-1', [proof])
    const send = vi.spyOn(chatStore, 'sendMessage').mockResolvedValue(true)
    await flushPromises()

    await wrapper.get('.send-button').trigger('click')
    await flushPromises()

    expect(send).toHaveBeenCalledWith('', [expect.objectContaining({
      file: proof,
      annotationId: 'annotation-1',
    })], [annotation()])
    expect(annotationsStore.annotationsForSession('session-1')).toEqual([])
  })

  it('retains the complete annotation draft when dispatch fails', async () => {
    const { wrapper, chatStore } = mountInput()
    const annotationsStore = useChatAnnotationsStore()
    annotationsStore.addAnnotation('session-1', annotation())
    vi.spyOn(chatStore, 'sendMessage').mockResolvedValue(false)
    await flushPromises()

    await wrapper.get('.send-button').trigger('click')
    await flushPromises()

    expect(annotationsStore.annotationsForSession('session-1')).toHaveLength(1)
  })

  it('guards duplicate sends and clears only the originating session after acceptance', async () => {
    const { wrapper, chatStore } = mountInput()
    const annotationsStore = useChatAnnotationsStore()
    annotationsStore.addAnnotation('session-1', annotation())
    let accept!: (value: boolean) => void
    const send = vi.spyOn(chatStore, 'sendMessage').mockReturnValue(new Promise(resolve => { accept = resolve }))
    await flushPromises()

    void wrapper.get('.send-button').trigger('click')
    void wrapper.get('.send-button').trigger('click')
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))

    const sessionTwo = {
      id: 'session-2', title: 'Second', source: 'cli', messages: [], createdAt: Date.now(), updatedAt: Date.now(),
    }
    chatStore.sessions.push(sessionTwo)
    chatStore.activeSessionId = 'session-2'
    chatStore.activeSession = sessionTwo
    annotationsStore.addAnnotation('session-2', { ...annotation(), id: 'annotation-2' })
    accept(true)
    await flushPromises()

    expect(annotationsStore.annotationsForSession('session-1')).toEqual([])
    expect(annotationsStore.annotationsForSession('session-2')).toHaveLength(1)
  })

  it('preserves text and files added while an annotation send awaits acceptance', async () => {
    const { wrapper, chatStore } = mountInput()
    const annotationsStore = useChatAnnotationsStore()
    annotationsStore.addAnnotation('session-1', annotation())
    const textarea = wrapper.get('textarea')
    await textarea.setValue('submitted text')
    let accept!: (value: boolean) => void
    vi.spyOn(chatStore, 'sendMessage').mockReturnValue(new Promise(resolve => { accept = resolve }))

    void wrapper.get('.send-button').trigger('click')
    await vi.waitFor(() => expect(chatStore.sendMessage).toHaveBeenCalledTimes(1))
    await textarea.setValue('next draft')
    const lateFile = new File(['later'], 'later.txt', { type: 'text/plain' })
    ;(wrapper.vm as any).addFiles([lateFile])
    await flushPromises()

    accept(true)
    await flushPromises()

    expect((textarea.element as HTMLTextAreaElement).value).toBe('next draft')
    expect(wrapper.text()).toContain('later.txt')
  })
})
