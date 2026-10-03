// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createTestingPinia } from '@pinia/testing'
import { nextTick } from 'vue'
import { useChatStore } from '@/stores/hermes/chat'
import { useSettingsStore } from '@/stores/hermes/settings'
import ChatInput from '@/components/hermes/chat/ChatInput.vue'

enableAutoUnmount(afterEach)
afterEach(() => {
  if (vi.isMockFunction(Date.now)) vi.mocked(Date.now).mockRestore()
  vi.useRealTimers()
})

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
  componentProps: { initialText?: string; persistDraft?: boolean } = {},
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
    Object.assign(chatStore.activeSession!, { agent: 'ekko-agent', codingAgentId: 'ekko-agent', contextManager: 'native', contextSource: 'estimate', contextManagerStatus: 'native' })
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

  it('shows context source and degradation without substituting billing counters', async () => {
    const wrapper = mountForSession('session-context', {
      inputTokens: 900000, outputTokens: 100000, cacheReadTokens: 700000,
      contextTokens: 0, contextManager: 'bili', contextSource: 'usage', contextManagerStatus: 'active',
      model: 'test-model', contextWindow: 32000, contextObservedAt: Date.now(), contextGeneration: 'g2', contextModel: 'test-model',
    })
    await flushPromises()
    expect(wrapper.get('.context-info').text()).toMatch(/^0\s+\//)
    expect(wrapper.get('.context-info').text()).toContain('32.0k')
    expect(wrapper.get('.context-status').attributes('title')).toContain('contextManager.sourceUsage')
    expect(wrapper.get('.context-status').attributes('title')).toContain('test-model')
    Object.assign(useChatStore().activeSession!, { contextSource: 'unavailable', contextManagerStatus: 'unavailable' })
    await nextTick()
    expect(wrapper.get('.context-info').text()).toContain('contextManager.unavailable')
    expect(wrapper.find('.context-bar').exists()).toBe(false)
    Object.assign(useChatStore().activeSession!, { contextManager: 'native', contextFallback: true, contextSource: 'estimate', contextManagerStatus: 'native', contextTokens: 1200 })
    await nextTick()
    expect(wrapper.get('.context-status').text()).toContain('contextManager.fallback')
    expect(wrapper.get('.context-status').attributes('title')).toContain('contextManager.sourceEstimate')
    expect(wrapper.get('.context-info').text()).toMatch(/^1.2k\s+\//)
  })

  it('shows unknown native context rather than legacy or cumulative billing tokens', async () => {
    const wrapper = mountForSession('session-native-unknown', {
      agent: 'hermes', contextTokens: 2000, inputTokens: 900000, outputTokens: 100000,
    })
    await flushPromises()
    expect(wrapper.get('.context-info').text()).toBe('contextManager.unknown')
    expect(wrapper.find('.context-bar').exists()).toBe(false)
    expect(wrapper.find('.context-limit-editable').exists()).toBe(false)
    useChatStore().activeSession!.contextTokens = undefined
    await nextTick()
    expect(wrapper.get('.context-info').text()).toBe('contextManager.unknown')
  })

  it.each([
    ['expired', { contextObservedAt: Date.now() - 900001 }],
    ['future', { contextObservedAt: Date.now() + 60001 }],
    ['other model', { contextModel: 'other-model' }],
    ['missing generation', { contextGeneration: undefined }],
    ['missing window', { contextWindow: undefined }],
    ['wrong generation type', { contextGeneration: 2 }],
  ])('hides %s external observations without leaking their limit or source', async (_name, invalid) => {
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    if (_name === 'future') invalid.contextObservedAt = now + 60001
    if (_name === 'expired') invalid.contextObservedAt = now - 900001
    const wrapper = mountForSession('session-invalid-context', {
      model: 'test-model', inputTokens: 900000, contextManager: 'bili', contextSource: 'usage', contextManagerStatus: 'active',
      contextTokens: 1200, contextObservedAt: Date.now(), contextGeneration: 'g2', contextModel: 'test-model', contextWindow: 32000,
      ...invalid as any,
    })
    await flushPromises()
    expect(wrapper.get('.context-info').text()).toBe('contextManager.unknown')
    expect(wrapper.get('.context-status').text()).toContain('contextManager.unavailable')
    expect(wrapper.get('.context-status').attributes('title')).toContain('contextManager.sourceUnavailable')
    expect(wrapper.find('.context-limit-observed').exists()).toBe(false)
    expect(wrapper.find('.context-bar').exists()).toBe(false)
  })

  it('expires a visible observation without waiting for another usage event', async () => {
    vi.useFakeTimers()
    const wrapper = mountForSession('session-expiring-context', {
      model: 'test-model', contextManager: 'bili', contextSource: 'usage', contextManagerStatus: 'active',
      contextTokens: 1200, contextObservedAt: Date.now() - 900000, contextGeneration: 'g2', contextModel: 'test-model', contextWindow: 32000,
    })
    await nextTick()
    expect(wrapper.get('.context-info').text()).toMatch(/^1.2k/)
    await vi.advanceTimersByTimeAsync(1000)
    await nextTick()
    expect(wrapper.get('.context-info').text()).toBe('contextManager.unknown')
    expect(wrapper.find('.context-bar').exists()).toBe(false)
  })

  it('shows reasoning effort selector for coding-agent sessions', async () => {
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
    expect(wrapper.get('.reasoning-effort-button').attributes('style')).toContain('--reasoning-effort-accent-color: #ef4444')
    expect(wrapper.get('.n-slider-stub').classes()).toContain('reasoning-effort-slider--max')
  })

  it('stores the selected reasoning effort for the active session', async () => {
    const wrapper = mountForSession('session-reasoning')
    const store = useChatStore()

    await wrapper.get('.n-slider-stub').setValue('5')
    await nextTick()

    expect(store.sessions[0].reasoningEffort).toBe('high')
    expect(wrapper.get('.reasoning-effort-button').attributes('style')).toContain('--reasoning-effort-accent-color: #f9c33c')
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
    textarea.element.setSelectionRange(4, 4)
    await textarea.trigger('input')
    await nextTick()

    await vi.waitFor(() => {
      expect(wrapper.find('.slash-command-dropdown').exists()).toBe(false)
    })
  })
})
