// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createTestingPinia } from '@pinia/testing'
import { nextTick } from 'vue'
import { useChatStore } from '@/stores/hermes/chat'
import { useSettingsStore } from '@/stores/hermes/settings'
import { useAppStore } from '@/stores/hermes/app'
import ChatInput from '@/components/hermes/chat/ChatInput.vue'

enableAutoUnmount(afterEach)

const fetchSkillsMock = vi.hoisted(() => vi.fn())
const fetchSkillBundlesMock = vi.hoisted(() => vi.fn())
const deleteSkillBundleApiMock = vi.hoisted(() => vi.fn())
const dialogWarningMock = vi.hoisted(() => vi.fn())
const extractRepresentativeVideoFramesMock = vi.hoisted(() => vi.fn())

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', () => ({
  NButton: { template: '<button type="button" v-bind="$attrs"><slot /><slot name="icon" /></button>' },
  NTooltip: { template: '<div><slot name="trigger" /><slot /></div>' },
  NSwitch: { template: '<button type="button"></button>' },
  NDropdown: { template: '<div><slot /></div>' },
  NModal: { template: '<div><slot /><slot name="footer" /></div>' },
  NSpin: { template: '<div role="status"><slot /></div>' },
  NInputNumber: { template: '<input />' },
  NPopover: {
    template: '<div class="n-popover-stub"><slot name="trigger" /><slot /></div>',
  },
  NSlider: {
    props: ['value', 'min', 'max', 'step'],
    emits: ['update:value'],
    template: `
      <input
        class="n-slider-stub"
        type="range"
        :value="value"
        :min="min"
        :max="max"
        :step="step"
        @input="$emit('update:value', Number($event.target.value))"
      />
    `,
  },
  useMessage: () => ({ error: vi.fn(), success: vi.fn() }),
  useDialog: () => ({ warning: dialogWarningMock }),
}))

vi.mock('@/api/studio/sessions', () => ({
  fetchContextLength: vi.fn().mockResolvedValue(256000),
  setSessionReasoningEffort: vi.fn().mockResolvedValue(true),
}))

vi.mock('@/api/hermes/model-context', () => ({
  setModelContext: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/api/hermes/skills', () => ({
  fetchSkills: fetchSkillsMock,
}))

vi.mock('@/api/hermes/skill-bundles', () => ({
  fetchSkillBundles: fetchSkillBundlesMock,
  deleteSkillBundleApi: deleteSkillBundleApiMock,
}))

vi.mock('@/components/hermes/chat/BundleCreateModal.vue', () => ({
  default: {
    name: 'BundleCreateModal',
    props: ['profile'],
    emits: ['close', 'created'],
    template: '<div class="bundle-create-modal">{{ profile }}</div>',
  },
}))

vi.mock('@/composables/useToolTraceVisibility', () => ({
  useToolTraceVisibility: () => ({ toolTraceVisible: { value: true }, toggleToolTraceVisible: vi.fn() }),
}))

vi.mock('@/utils/video-frame-extraction', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/utils/video-frame-extraction')>()
  return {
    ...original,
    extractRepresentativeVideoFrames: extractRepresentativeVideoFramesMock,
  }
})

function mountForSession(
  sessionId: string,
  sessionOverrides: Partial<ReturnType<typeof useChatStore>['sessions'][number]> = {},
  displayOverrides: Record<string, any> = {},
  componentProps: Partial<InstanceType<typeof ChatInput>['$props']> = {},
) {
  const pinia = createTestingPinia({ stubActions: false, createSpy: vi.fn })
  const chatStore = useChatStore()
  const settingsStore = useSettingsStore()
  chatStore.sessions = [
    { id: sessionId, title: sessionId, source: 'cli', messages: [], createdAt: Date.now(), updatedAt: Date.now(), ...sessionOverrides },
  ]
  chatStore.activeSessionId = sessionId
  chatStore.activeSession = chatStore.sessions[0]
  settingsStore.display = displayOverrides
  return mount(ChatInput, { props: componentProps, global: { plugins: [pinia] } })
}

describe('ChatInput draft persistence', () => {
  beforeEach(() => {
    localStorage.clear()
    window.innerWidth = 1024
    fetchSkillsMock.mockReset()
    fetchSkillsMock.mockResolvedValue({ categories: [], archived: [] })
    fetchSkillBundlesMock.mockReset()
    fetchSkillBundlesMock.mockResolvedValue([])
    deleteSkillBundleApiMock.mockReset()
    deleteSkillBundleApiMock.mockResolvedValue(undefined)
    dialogWarningMock.mockReset()
    extractRepresentativeVideoFramesMock.mockReset()
    extractRepresentativeVideoFramesMock.mockResolvedValue([])
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:chat-attachment'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    })
  })

  it('isolates the new-chat composer from the active session draft and reference', async () => {
    localStorage.setItem('hermes_chat_input_drafts_v1', JSON.stringify({ 'existing': 'Keep this draft' }))
    const wrapper = mountForSession('existing', { inputTokens: 900, reasoningEffort: 'high' }, {}, { draft: true, persistDraft: false })
    const store = useChatStore()
    store.setMessageReference('existing', { id: 'reference', role: 'assistant', content: 'Previous answer', timestamp: 1 })
    await nextTick()
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('')
    expect(wrapper.find('.message-reference-preview').exists()).toBe(false)
    expect(wrapper.find('.context-usage-row').exists()).toBe(false)
    expect(wrapper.find('.reasoning-effort-button').exists()).toBe(false)
    await wrapper.get('textarea').setValue('New conversation')
    expect(JSON.parse(localStorage.getItem('hermes_chat_input_drafts_v1')!)).toEqual({ existing: 'Keep this draft' })
  })

  it('keeps the first message when creation fails and prevents duplicate submissions', async () => {
    let finish!: (value: boolean) => void
    const submit = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve }))
    const wrapper = mountForSession('existing', {}, {}, { draft: true, persistDraft: false, submit })
    const send = vi.spyOn(useChatStore(), 'sendMessage').mockResolvedValue(undefined)
    await wrapper.get('textarea').setValue('First message')
    await wrapper.get('.send-button').trigger('click')
    await wrapper.get('textarea').trigger('keydown', { key: 'Enter' })
    expect(submit).toHaveBeenCalledOnce()
    expect(send).not.toHaveBeenCalled()
    finish(false)
    await flushPromises()
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('First message')
    await wrapper.setProps({ submit: vi.fn().mockResolvedValue(true) })
    await wrapper.get('.send-button').trigger('click')
    await flushPromises()
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('')
  })

  it('uses the draft model effort levels and value without inheriting existing session settings', async () => {
    const wrapper = mountForSession('existing', { provider: 'old-provider', model: 'old-model', reasoningEffort: 'low' }, {}, {
      draft: true,
      draftConfig: { provider: 'draft-provider', model: 'draft-model', profile: 'research' },
    })
    const app = useAppStore()
    app.profileModelGroups = [{ profile: 'research', default: 'draft-model', default_provider: 'draft-provider', groups: [{
      provider: 'draft-provider', label: 'Draft provider', models: ['draft-model', 'simple-model'],
      model_meta: { 'draft-model': { reasoning_efforts: ['high', 'max'] }, 'simple-model': { reasoning: false } },
    }] }]
    await nextTick()
    expect(wrapper.get('.n-slider-stub').attributes('max')).toBe('2')
    expect(useChatStore().setSessionReasoningEffort).not.toHaveBeenCalled()
    expect(useChatStore().activeSession?.reasoningEffort).toBe('low')
    await wrapper.setProps({ reasoningEffort: 'max' })
    expect(wrapper.get('.reasoning-effort-button').classes()).toContain('active')
    expect(wrapper.get('.reasoning-effort-slider-popover').attributes('style')).toContain('#ef4444')
    await wrapper.setProps({ draftConfig: { provider: 'draft-provider', model: 'simple-model', profile: 'research' } })
    expect(wrapper.get('.n-slider-stub').attributes('max')).toBe('0')
    await wrapper.setProps({ draftConfig: { provider: 'moa', model: 'ensemble', profile: 'research' } })
    expect(wrapper.find('.reasoning-effort-button').exists()).toBe(false)
    await wrapper.setProps({ draftConfig: { provider: 'draft-provider', model: 'draft-model', codingAgentMode: 'global' }, reasoningEffort: '' })
    expect(wrapper.find('.reasoning-effort-button').exists()).toBe(false)
  })

  it('blocks Enter submission until the new-chat configuration is ready', async () => {
    const submit = vi.fn().mockResolvedValue(true)
    const wrapper = mountForSession('existing', {}, {}, { draft: true, sendDisabled: true, submit })
    await wrapper.get('textarea').setValue('First message')
    await wrapper.get('textarea').trigger('keydown', { key: 'Enter' })
    expect(submit).not.toHaveBeenCalled()
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('First message')
  })

  it('uses the global draft native effort choices without changing the active conversation', async () => {
    const onEffortChange = vi.fn()
    const wrapper = mountForSession('existing', { reasoningEffort: 'low' }, {}, {
      draft: true, draftConfig: { codingAgentMode: 'global', model: 'native-model' },
      nativeReasoningEfforts: ['low', 'high'], reasoningEffort: 'high',
      'onUpdate:reasoningEffort': onEffortChange,
    })
    await nextTick()
    expect(wrapper.find('.reasoning-effort-button').exists()).toBe(true)
    expect(wrapper.get('.n-slider-stub').attributes('max')).toBe('2')
    await wrapper.get('.n-slider-stub').setValue('1')
    expect(onEffortChange).toHaveBeenCalledWith('low')
    expect(useChatStore().activeSession?.reasoningEffort).toBe('low')
    expect(useChatStore().setSessionReasoningEffort).not.toHaveBeenCalled()
  })

  it('adds a pasted non-image file to the attachment list', async () => {
    const wrapper = mountForSession('session-file-paste')
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' })
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', {
      value: {
        items: [{ kind: 'file', type: file.type, getAsFile: () => file }],
        files: [file],
      },
    })

    wrapper.get('textarea').element.dispatchEvent(paste)
    await nextTick()

    expect(paste.defaultPrevented).toBe(true)
    expect(wrapper.get('.attachment-file').text()).toContain('notes.txt')
  })

  it('shows the full uploaded image in a lightbox before sending', async () => {
    const wrapper = mountForSession('session-image-preview')
    const image = new File(['image'], 'wide-screenshot.png', { type: 'image/png' })
    const input = wrapper.get('input[type="file"]')
    Object.defineProperty(input.element, 'files', { configurable: true, value: [image] })

    await input.trigger('change')
    await nextTick()

    const thumb = wrapper.get('.attachment-thumb')
    expect(thumb.attributes('src')).toBe('blob:chat-attachment')
    expect(wrapper.get('.attachment-thumb-button').attributes('aria-label')).toBe('wide-screenshot.png')

    await wrapper.get('.attachment-thumb-button').trigger('click')
    await nextTick()

    const lightbox = document.body.querySelector('.image-preview-overlay')
    expect(lightbox).not.toBeNull()
    expect(lightbox?.querySelector('img')?.getAttribute('src')).toBe('blob:chat-attachment')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(document.body.querySelector('.image-preview-overlay')).toBeNull()
  })

  it('sends extracted video frames to the model without showing them as separate attachments', async () => {
    const wrapper = mountForSession('session-video')
    const chatStore = useChatStore()
    const sendMessage = vi.spyOn(chatStore, 'sendMessage').mockResolvedValue(undefined)
    const video = new File(['video'], 'demo.mp4', { type: 'video/mp4' })
    const frame = new File(['frame'], 'demo-video-frame-01.jpg', { type: 'image/jpeg' })
    let resolveFrames!: (frames: File[]) => void
    extractRepresentativeVideoFramesMock.mockReturnValue(new Promise<File[]>((resolve) => {
      resolveFrames = resolve
    }))
    const input = wrapper.get('input[type="file"]')
    Object.defineProperty(input.element, 'files', { configurable: true, value: [video] })

    await input.trigger('change')
    await nextTick()

    expect(wrapper.findAll('.attachment-preview')).toHaveLength(1)
    expect(wrapper.get('.attachment-preview').text()).toContain('demo.mp4')

    await wrapper.get('.send-button').trigger('click')
    expect(sendMessage).not.toHaveBeenCalled()
    resolveFrames([frame])
    await flushPromises()

    expect(sendMessage).toHaveBeenCalledWith('', [
      expect.objectContaining({ name: 'demo.mp4', type: 'video/mp4' }),
      expect.objectContaining({
        name: 'demo-video-frame-01.jpg',
        type: 'image/jpeg',
        videoFrameFor: expect.any(String),
      }),
    ])
  })

  it('restores unsent text for the active session after the chat view is remounted', async () => {
    const wrapper = mountForSession('session-a')
    const textarea = wrapper.get('textarea')

    await textarea.setValue('draft before tab switch')
    await nextTick()
    wrapper.unmount()

    const remounted = mountForSession('session-a')
    await nextTick()

    expect((remounted.get('textarea').element as HTMLTextAreaElement).value).toBe('draft before tab switch')
  })

  it('stores drafts under one localStorage key mapped by session id', async () => {
    const wrapperA = mountForSession('session-a')
    await wrapperA.get('textarea').setValue('draft for session a')
    await nextTick()
    wrapperA.unmount()

    const wrapperB = mountForSession('session-b')
    await wrapperB.get('textarea').setValue('draft for session b')
    await nextTick()
    wrapperB.unmount()

    expect(localStorage.getItem('hermes_chat_input_draft_v1')).toBeNull()
    expect(JSON.parse(localStorage.getItem('hermes_chat_input_drafts_v1') || '{}')).toEqual({
      'session-a': 'draft for session a',
      'session-b': 'draft for session b',
    })

    const remountedA = mountForSession('session-a')
    await nextTick()
    expect((remountedA.get('textarea').element as HTMLTextAreaElement).value).toBe('draft for session a')
  })

  it('prefills a transient help prompt without overwriting the session draft', async () => {
    localStorage.setItem('hermes_chat_input_drafts_v1', JSON.stringify({
      'session-help': 'existing user draft',
    }))
    const wrapper = mountForSession('session-help', {}, {}, {
      initialText: 'diagnose this installation error',
      persistDraft: false,
    })
    await nextTick()

    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value)
      .toBe('diagnose this installation error')
    await wrapper.get('textarea').setValue('edited help prompt')
    await nextTick()

    expect(JSON.parse(localStorage.getItem('hermes_chat_input_drafts_v1') || '{}'))
      .toEqual({ 'session-help': 'existing user draft' })
  })

  it('shows and cancels the active session message reference', async () => {
    const wrapper = mountForSession('session-reference')
    const chatStore = useChatStore()

    chatStore.setMessageReference('session-reference', {
      id: 'assistant-1',
      role: 'assistant',
      content: 'A referenced assistant response',
    })
    await nextTick()

    expect(wrapper.get('.message-reference-preview').text()).toContain('A referenced assistant response')
    expect(wrapper.get('.message-reference-preview').element.parentElement?.classList.contains('input-wrapper')).toBe(false)
    expect(chatStore.activeMessageReference?.id).toBe('assistant-1')

    await wrapper.get('.message-reference-remove').trigger('click')

    expect(wrapper.find('.message-reference-preview').exists()).toBe(false)
    expect(chatStore.activeMessageReference).toBeNull()
  })

  it('applies the configured desktop input height from display settings', async () => {
    const wrapper = mountForSession('session-a', {}, { chat_input_height: 180 })
    await flushPromises()
    await nextTick()

    expect((wrapper.get('textarea').element as HTMLTextAreaElement).style.height).toBe('180px')
    expect((wrapper.get('.input-wrapper').element as HTMLElement).style.minHeight).toBe('251px')
  })

  it('applies display setting changes after a manual resize', async () => {
    const wrapper = mountForSession('session-a')
    const settingsStore = useSettingsStore()
    const resizeHandle = wrapper.get('.resize-handle')

    await resizeHandle.trigger('mousedown', { clientY: 100 })
    document.dispatchEvent(new MouseEvent('mousemove', { clientY: 50 }))
    document.dispatchEvent(new MouseEvent('mouseup'))
    await nextTick()

    settingsStore.display.chat_input_height = 220
    await nextTick()

    expect((wrapper.get('textarea').element as HTMLTextAreaElement).style.height).toBe('220px')
    expect((wrapper.get('.input-wrapper').element as HTMLElement).style.minHeight).toBe('291px')
  })

  it('keeps mobile chat input behavior even when a desktop height is configured', async () => {
    window.innerWidth = 640
    const wrapper = mountForSession('session-mobile', {}, { chat_input_height: 180 })
    await flushPromises()
    await nextTick()

    expect((wrapper.get('textarea').element as HTMLTextAreaElement).style.height).not.toBe('180px')
  })

  it('shows only cumulative native usage including caches while retaining Hermes and Ekko context', async () => {
    const wrapper = mountForSession('session-codex', {
      source: 'coding_agent',
      agent: 'codex',
      codingAgentId: 'codex',
      inputTokens: 1200,
      outputTokens: 800,
      cacheReadTokens: 3000,
      cacheWriteTokens: 100,
      contextTokens: 2000,
    })
    await nextTick()

    expect(wrapper.get('.context-info').text()).toBe('chat.sessionUsage 5.1k')
    expect(wrapper.find('.context-limit-editable').exists()).toBe(false)
    expect(wrapper.find('.context-bar').exists()).toBe(false)

    const chatStore = useChatStore()
    Object.assign(chatStore.activeSession!, { agent: 'cursor', codingAgentId: 'cursor' })
    await nextTick()
    expect(wrapper.get('.context-info').text()).toBe('chat.sessionUsage 5.1k')
    Object.assign(chatStore.activeSession!, { inputTokens: 24_003, outputTokens: 474, cacheReadTokens: 20_736, cacheWriteTokens: 0, contextTokens: 0 })
    await nextTick()
    expect(wrapper.get('.context-info').text()).toBe('chat.sessionUsage 45.2k')
    Object.assign(chatStore.activeSession!, { contextTokens: 24_477 })
    await nextTick()
    expect(wrapper.get('.context-info').text()).toBe('chat.sessionUsage 45.2k')
    Object.assign(chatStore.activeSession!, { inputTokens: 1200, outputTokens: 800, contextTokens: 2000 })
    Object.assign(chatStore.activeSession!, { agent: 'ekko-agent', codingAgentId: 'ekko-agent' })
    await flushPromises()

    expect(wrapper.get('.context-info').text()).toMatch(/2\.0k\s+\//)
    expect(wrapper.get('.context-limit-editable').text()).toBe('256.0k')
    expect(wrapper.get('.context-info').text()).toContain('chat.contextRemaining 254.0k')
    expect(wrapper.find('.context-bar').exists()).toBe(true)

    Object.assign(chatStore.activeSession!, { source: 'cli', agent: 'hermes', codingAgentId: undefined })
    await nextTick()

    expect(wrapper.get('.context-info').text()).toMatch(/2\.0k\s+\//)
    expect(wrapper.get('.context-limit-editable').text()).toBe('256.0k')
    expect(wrapper.find('.context-bar').exists()).toBe(true)
  })

  it.each(['cursor', 'codex', 'claude-code', 'pi', 'grok', 'opencode', 'dsh'])('shows only this session cumulative usage for %s', async agent => {
    const wrapper = mountForSession('session-usage', {
      source: 'coding_agent', agent, codingAgentId: agent as any,
      inputTokens: 1_800_000_000, outputTokens: 1_200_000, cacheReadTokens: 56_000_000,
      cacheWriteTokens: 0, contextTokens: 50_000,
    })
    await nextTick()
    expect(wrapper.get('.context-info').text()).toBe('chat.sessionUsage 1857.2M')
    expect(wrapper.find('.context-limit-editable').exists()).toBe(false)
    expect(wrapper.find('.context-bar').exists()).toBe(false)
    expect(wrapper.get('.context-usage-row').text()).not.toContain('chat.contextUsed')
    useChatStore().activeSession!.contextTokens = 0
    await nextTick()
    expect(wrapper.get('.context-info').text()).toBe('chat.sessionUsage 1857.2M')
  })

  it('allows reasoning effort changes in scoped coding-agent sessions', async () => {
    const wrapper = mountForSession('session-codex', {
      source: 'coding_agent',
      agent: 'codex',
      codingAgentId: 'codex',
      codingAgentMode: 'scoped',
    })
    await nextTick()

    expect(wrapper.find('.n-popover-stub').exists()).toBe(true)
    expect(wrapper.find('.n-slider-stub').exists()).toBe(true)
    expect(wrapper.get('.n-slider-stub').attributes('min')).toBe('0')
    expect(wrapper.get('.n-slider-stub').attributes('max')).toBe('7')
    expect(wrapper.get('.reasoning-effort-button').attributes('disabled')).toBeUndefined()
    await wrapper.get('.n-slider-stub').setValue('5')
    expect(useChatStore().setSessionReasoningEffort).toHaveBeenCalledWith('session-codex', 'high')
    expect(useChatStore().activeSession?.reasoningEffort).toBe('high')
  })

  it.each([
    ['', 'chat.reasoningEffort.defaultLabel'],
    ['high', 'chat.reasoningEffort.options.high'],
    ['unlisted-effort', 'unlisted-effort'],
  ])('keeps Ekko run-detail effort %s read-only without rewriting the saved value', async (effort, label) => {
    const wrapper = mountForSession('ekko-run-detail', {
      source: 'workflow', codingAgentId: 'ekko-agent', codingAgentMode: 'scoped',
      provider: 'test-provider', model: 'historical-model', reasoningEffort: effort,
    }, {}, { reasoningEffortDisabled: true })
    await nextTick()
    expect(wrapper.get('.reasoning-effort-button').attributes('disabled')).toBeDefined()
    expect(wrapper.get('.reasoning-effort-button').text()).toContain(label)
    await wrapper.get('.n-slider-stub').setValue('1')
    expect(useChatStore().setSessionReasoningEffort).not.toHaveBeenCalled()
    expect(useChatStore().activeSession?.reasoningEffort).toBe(effort)
  })

  it('hides the reasoning effort selector for global coding-agent sessions', async () => {
    const wrapper = mountForSession('session-global-codex', {
      source: 'coding_agent',
      agent: 'codex',
      codingAgentId: 'codex',
      codingAgentMode: 'global',
    })
    await nextTick()

    expect(wrapper.find('.reasoning-effort-button').exists()).toBe(false)
    expect(wrapper.find('.n-slider-stub').exists()).toBe(false)
  })

  it('displays and preserves the saved global effort while native capabilities are unavailable', async () => {
    const wrapper = mountForSession('session-global-saved', {
      source: 'coding_agent', codingAgentId: 'codex', codingAgentMode: 'global', reasoningEffort: 'high',
    })
    await nextTick()
    expect(wrapper.get('.reasoning-effort-button').text()).toContain('chat.reasoningEffort.options.high')
    expect(wrapper.get('.reasoning-effort-button').attributes('disabled')).toBeDefined()
    await wrapper.setProps({ nativeReasoningEfforts: [] })
    expect(useChatStore().activeSession?.reasoningEffort).toBe('high')
    await wrapper.setProps({ nativeReasoningEfforts: ['low', 'high'] })
    expect(wrapper.get('.reasoning-effort-button').attributes('disabled')).toBeDefined()
    expect(wrapper.get('.n-slider-stub').attributes('max')).toBe('2')
    await wrapper.get('.n-slider-stub').setValue('1')
    expect(useChatStore().activeSession?.reasoningEffort).toBe('high')
    expect(useChatStore().setSessionReasoningEffort).not.toHaveBeenCalled()
    await wrapper.setProps({ nativeReasoningEfforts: undefined })
    expect(wrapper.get('.reasoning-effort-button').text()).toContain('chat.reasoningEffort.options.high')
    expect(useChatStore().activeSession?.reasoningEffort).toBe('high')
  })

  it('shows a fixed native effort as read-only when its family has only one variant', async () => {
    const wrapper = mountForSession('fixed-native-effort', { codingAgentMode: 'global', model: 'gpt-oss-medium' }, {}, {
      nativeReasoningEfforts: ['medium'], nativeEffortChoices: [{ model: 'gpt-oss-medium', effort: 'medium' }],
    })
    await nextTick()
    expect(wrapper.get('.reasoning-effort-button').text()).toContain('chat.reasoningEffort.options.medium')
    expect(wrapper.get('.reasoning-effort-button').attributes('disabled')).toBeDefined()
    expect(useChatStore().setSessionReasoningEffort).not.toHaveBeenCalled()
  })

  it('keeps native ID and effort fixed in an existing coding-agent conversation', async () => {
    const wrapper = mountForSession('native-effort-variant', { codingAgentId: 'antigravity', codingAgentMode: 'global', model: 'gemini-high' }, {}, {
      nativeReasoningEfforts: ['low', 'high'], nativeEffortChoices: [{ model: 'gemini-low', effort: 'low' }, { model: 'gemini-high', effort: 'high' }],
    })
    await nextTick()
    expect(wrapper.get('.reasoning-effort-button').text()).toContain('chat.reasoningEffort.options.high')
    expect(wrapper.get('.n-slider-stub').attributes('max')).toBe('1')
    await wrapper.get('.n-slider-stub').setValue('0')
    expect(wrapper.get('.reasoning-effort-button').attributes('disabled')).toBeDefined()
    expect(useChatStore().setSessionReasoningEffort).not.toHaveBeenCalled()
    expect(useChatStore().activeSession?.model).toBe('gemini-high')
  })

  it.each(['codex', 'grok', 'zcode', 'cursor'])('allows a scoped %s session to switch among supported model efforts', async agent => {
    const wrapper = mountForSession('editable-scoped', { source: 'coding_agent', agent, codingAgentId: agent as any, codingAgentMode: 'scoped', model: 'reasoning-model', provider: 'test', reasoningEffort: 'high' })
    useAppStore().modelGroups = [{ provider: 'test', label: 'Test', models: ['reasoning-model'], model_meta: { 'reasoning-model': { reasoning: true, reasoning_efforts: ['low', 'high', 'max'] } } }]
    await nextTick()
    expect(wrapper.get('.reasoning-effort-button').text()).toContain('chat.reasoningEffort.options.high')
    expect(wrapper.get('.reasoning-effort-button').attributes('disabled')).toBeUndefined()
    expect(wrapper.get('.n-slider-stub').attributes('max')).toBe('3')
    await wrapper.get('.n-slider-stub').setValue('1')
    expect(useChatStore().setSessionReasoningEffort).toHaveBeenCalledWith('editable-scoped', 'low')
    expect(useChatStore().activeSession?.reasoningEffort).toBe('low')
    expect(useChatStore().activeSession?.model).toBe('reasoning-model')
  })

  it('allows a new native draft to select effort while the existing coding-agent session is read-only', async () => {
    const change = vi.fn()
    const wrapper = mountForSession('existing-agent', { codingAgentId: 'cursor', codingAgentMode: 'global', reasoningEffort: 'high' }, {}, {
      draft: true, draftConfig: { codingAgentMode: 'global', model: 'gemini-high' }, reasoningEffort: 'high',
      nativeReasoningEfforts: ['low', 'high'], nativeEffortChoices: [{ model: 'gemini-low', effort: 'low' }, { model: 'gemini-high', effort: 'high' }],
      'onUpdate:reasoningEffort': change,
    })
    await nextTick()
    expect(wrapper.get('.reasoning-effort-button').attributes('disabled')).toBeUndefined()
    await wrapper.get('.n-slider-stub').setValue('0')
    expect(change).toHaveBeenCalledWith('low')
    expect(useChatStore().activeSession?.reasoningEffort).toBe('high')
    expect(useChatStore().setSessionReasoningEffort).not.toHaveBeenCalled()
  })

  it('keeps a saved native effort that is absent from a refreshed catalog', async () => {
    const wrapper = mountForSession('session-global-native-level', {
      source: 'coding_agent', codingAgentId: 'codex', codingAgentMode: 'global', reasoningEffort: 'high',
    }, {}, { nativeReasoningEfforts: ['low'] })
    await nextTick()
    expect(wrapper.get('.reasoning-effort-button').text()).toContain('chat.reasoningEffort.options.high')
    expect(wrapper.get('.reasoning-effort-button').attributes('disabled')).toBeDefined()
    expect(useChatStore().activeSession?.reasoningEffort).toBe('high')
  })

  it('hides the reasoning effort selector for MoA sessions', async () => {
    const wrapper = mountForSession('session-moa', {
      provider: 'moa',
      model: 'research-team',
    })
    await nextTick()

    expect(wrapper.find('.n-popover-stub').exists()).toBe(false)
  })

  it('stores maximum reasoning effort for the active session', async () => {
    const wrapper = mountForSession('session-reasoning-max')
    const store = useChatStore()

    await wrapper.get('.n-slider-stub').setValue('7')
    await nextTick()

    expect(store.sessions[0].reasoningEffort).toBe('max')
    expect(wrapper.get('.reasoning-effort-slider-popover').attributes('style')).toContain('--reasoning-effort-accent-color: #ef4444')
    expect(wrapper.get('.n-slider-stub').classes()).toContain('reasoning-effort-slider--max')
  })

  it('uses the selected model effort ladder and resets an unsupported effort after switching models', async () => {
    const wrapper = mountForSession('session-model-efforts', { provider: 'custom:work', model: 'glm', profile: 'research' })
    const appStore = useAppStore()
    appStore.profileModelGroups = [{ profile: 'research', default: 'glm', default_provider: 'custom:work', groups: [{
      provider: 'custom:work', label: 'Work', base_url: 'https://api.z.ai/v1', api_key: '', models: ['glm', 'fast'],
      model_meta: { glm: { reasoning: true, reasoning_efforts: ['low', 'high', 'max'] }, fast: { reasoning: false } },
    }] }]
    await nextTick()
    expect(wrapper.get('.n-slider-stub').attributes('max')).toBe('3')
    await wrapper.get('.n-slider-stub').setValue('3')
    expect(wrapper.get('.reasoning-effort-slider-popover').attributes('style')).toContain('--reasoning-effort-accent-color: #ef4444')
    await wrapper.get('.n-slider-stub').setValue('2')
    const store = useChatStore()
    expect(store.sessions[0].reasoningEffort).toBe('high')
    store.sessions[0].model = 'fast'
    await flushPromises()
    expect(wrapper.get('.n-slider-stub').attributes('max')).toBe('0')
    expect(store.sessions[0].reasoningEffort).toBeUndefined()
  })

  it('stores the selected reasoning effort for the active session', async () => {
    const wrapper = mountForSession('session-reasoning')
    const store = useChatStore()

    await wrapper.get('.n-slider-stub').setValue('5')
    await nextTick()

    expect(store.sessions[0].reasoningEffort).toBe('high')
    expect(wrapper.get('.reasoning-effort-slider-popover').attributes('style')).toContain('--reasoning-effort-accent-color: #f9c33c')
    expect(wrapper.get('.n-slider-stub').classes()).not.toContain('reasoning-effort-slider--max')
  })

  it.each(['opencode', 'cursor', 'codex', 'claude', 'pi', 'grok'] as const)('shows the supported commands for %s', async agent => {
    const wrapper = mountForSession(`session-commands-${agent}`, { source: 'coding_agent', agent })
    await wrapper.get('textarea').setValue('/')
    await nextTick()
    const commands = wrapper.findAll('.slash-command-item').map(item => item.text())
    for (const name of ['usage', 'status']) {
      expect(commands.some(text => text.includes(`/${name}`))).toBe(true)
    }
    expect(commands.some(text => text.includes('/context'))).toBe(agent !== 'cursor')
    expect(commands.some(text => text.includes('/compact'))).toBe(agent !== 'opencode' && agent !== 'cursor')
    wrapper.unmount()
  })

  it('opens the skill picker from /skill and inserts the selected skill command', async () => {
    fetchSkillsMock.mockResolvedValue({
      categories: [
        {
          name: 'review',
          description: '',
          skills: [
            { name: 'github-pr-review', description: 'Review pull requests', enabled: true },
            { name: 'disabled-skill', description: 'Hidden', enabled: false },
          ],
        },
      ],
      archived: [],
    })
    const wrapper = mountForSession('session-skills', { profile: 'work' })
    const textarea = wrapper.get('textarea')

    await textarea.setValue('/skill')
    await nextTick()

    await wrapper.get('.slash-command-item').trigger('mousedown')
    await flushPromises()
    await nextTick()

    expect(fetchSkillsMock).toHaveBeenCalledWith('work')
    expect(wrapper.text()).toContain('/skill github-pr-review')
    expect(wrapper.text()).toContain('Review pull requests')
    expect(wrapper.text()).not.toContain('disabled-skill')

    await wrapper.get('.skill-picker-item').trigger('click')
    await nextTick()

    expect((textarea.element as HTMLTextAreaElement).value).toBe('/skill github-pr-review ')
  })

  it('opens the profile-scoped bundle picker from /bundles and inserts the selected bundle command', async () => {
    fetchSkillBundlesMock.mockResolvedValue([
      {
        name: 'PR Review Team',
        commandName: 'pr-review-team',
        description: 'Review a pull request',
        skills: ['github-pr-review', 'security-review'],
      },
    ])
    const wrapper = mountForSession('session-bundles', { profile: 'work' })
    const textarea = wrapper.get('textarea')

    await textarea.setValue('/bundles')
    await nextTick()
    await wrapper.findAll('.slash-command-item')[0].trigger('mousedown')
    await flushPromises()
    await nextTick()

    expect(fetchSkillBundlesMock).toHaveBeenCalledWith('work')
    expect(wrapper.text()).toContain('/bundles pr-review-team')
    expect(wrapper.text()).toContain('Review a pull request')
    expect(wrapper.text()).toContain('github-pr-review, security-review')

    await wrapper.get('.bundle-picker-select').trigger('click')
    await nextTick()

    expect((textarea.element as HTMLTextAreaElement).value).toBe('/bundles pr-review-team ')
  })

  it('opens the bundle creator when /bundles create is submitted', async () => {
    const wrapper = mountForSession('session-bundle-create', { profile: 'research' })
    const textarea = wrapper.get('textarea')

    await textarea.setValue('/bundles create')
    await nextTick()
    await wrapper.get('.send-button').trigger('click')
    await nextTick()

    expect(wrapper.get('.bundle-create-modal').text()).toBe('research')
  })

  it('deletes a bundle from the current profile after confirmation', async () => {
    fetchSkillBundlesMock.mockResolvedValue([
      {
        name: 'PR Review Team',
        commandName: 'pr-review-team',
        description: '',
        skills: ['github-pr-review'],
      },
    ])
    const wrapper = mountForSession('session-bundle-delete', { profile: 'work' })
    const textarea = wrapper.get('textarea')

    await textarea.setValue('/bundles')
    await nextTick()
    await wrapper.findAll('.slash-command-item')[0].trigger('mousedown')
    await flushPromises()
    await wrapper.get('.bundle-picker-delete').trigger('click')

    expect(dialogWarningMock).toHaveBeenCalledOnce()
    await dialogWarningMock.mock.calls[0][0].onPositiveClick()
    await flushPromises()

    expect(deleteSkillBundleApiMock).toHaveBeenCalledWith('work', 'pr-review-team')
    expect(wrapper.text()).not.toContain('/bundles pr-review-team')
  })

  it('hides bridge autocomplete for non-Hermes slash prefixes', async () => {
    const wrapper = mountForSession('session-prefixes')
    const textarea = wrapper.get('textarea')

    await textarea.setValue('/')
    await nextTick()
    expect(wrapper.findAll('.slash-command-item').length).toBeGreaterThan(0)

    await textarea.setValue('/ter')
    await nextTick()

    expect(wrapper.find('.slash-command-dropdown').exists()).toBe(false)
  })
})
