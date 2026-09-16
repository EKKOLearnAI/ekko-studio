// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createTestingPinia } from '@pinia/testing'
import { defineComponent } from 'vue'
import { useChatStore } from '@/stores/hermes/chat'
import VoiceDialogueControls from '@/components/hermes/chat/VoiceDialogueControls.vue'
import ChatInput from '@/components/hermes/chat/ChatInput.vue'
import VoiceTranscriptOverlay from '@/components/hermes/chat/VoiceTranscriptOverlay.vue'

const {
  micStartMock,
  micStopMock,
  micCancelMock,
  pcmStartMock,
  pcmStopMock,
  pcmCancelMock,
  localPcmStartMock,
  localPcmStopMock,
  localPcmCancelMock,
  transcribeSpeechMock,
  startLocalSttStreamMock,
  pushLocalSttStreamChunkMock,
  finishLocalSttStreamMock,
  cancelLocalSttStreamMock,
  browserStartMock,
  browserStopMock,
  browserCancelMock,
  browserClearErrorMock,
  speechStopMock,
  micRecorderState,
  pcmRecorderStatus,
  pcmRecorderError,
  localPcmRecorderStatus,
  localPcmRecorderError,
  localPcmOnChunk,
  localPcmOptions,
  browserRecognitionStatus,
  browserRecognitionTranscript,
  browserRecognitionPartialTranscript,
  browserRecognitionError,
  browserRecognitionIsSupported,
  useVoiceDialogueOverride,
} = vi.hoisted(() => ({
  micStartMock: vi.fn(),
  micStopMock: vi.fn(),
  micCancelMock: vi.fn(),
  pcmStartMock: vi.fn(),
  pcmStopMock: vi.fn(),
  pcmCancelMock: vi.fn(),
  localPcmStartMock: vi.fn(),
  localPcmStopMock: vi.fn(),
  localPcmCancelMock: vi.fn(),
  transcribeSpeechMock: vi.fn(),
  startLocalSttStreamMock: vi.fn(),
  pushLocalSttStreamChunkMock: vi.fn(),
  finishLocalSttStreamMock: vi.fn(),
  cancelLocalSttStreamMock: vi.fn(),
  browserStartMock: vi.fn(),
  browserStopMock: vi.fn(),
  browserCancelMock: vi.fn(),
  browserClearErrorMock: vi.fn(),
  speechStopMock: vi.fn(),
  micRecorderState: {
    value: {
      status: 'idle' as 'idle' | 'requesting' | 'recording' | 'stopping' | 'error',
      error: null as Error | null,
      startedAt: null as number | null,
      mimeType: 'audio/webm' as string | null,
    },
  },
  pcmRecorderStatus: { value: 'idle' as 'idle' | 'requesting' | 'recording' | 'error' },
  pcmRecorderError: { value: null as Error | null },
  localPcmRecorderStatus: { value: 'idle' as 'idle' | 'requesting' | 'recording' | 'error' },
  localPcmRecorderError: { value: null as Error | null },
  localPcmOnChunk: {
    value: null as null | ((audio: Blob) => void),
  },
  localPcmOptions: {
    value: null as null | { continuous?: boolean },
  },
  browserRecognitionStatus: { value: 'idle' as 'idle' | 'listening' | 'stopping' | 'error' },
  browserRecognitionTranscript: { value: '' },
  browserRecognitionPartialTranscript: { value: '' },
  browserRecognitionError: { value: null as Error | null },
  browserRecognitionIsSupported: { value: true },
  useVoiceDialogueOverride: {
    value: null as null | ((deps: unknown) => unknown),
  },
}))

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })

  return { promise, resolve, reject }
}

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (!params) return key
      return `${key} ${Object.values(params).join(' ')}`
    },
  }),
}))

vi.mock('naive-ui', () => ({
  NButton: { template: '<button type="button" v-bind="$attrs"><slot /><slot name="icon" /></button>' },
  NTooltip: { template: '<div><slot name="trigger" /><slot /></div>' },
  NSwitch: { template: '<button type="button"></button>' },
  NCheckbox: {
    name: 'NCheckbox',
    props: ['checked'],
    emits: ['update:checked'],
    template: '<label><input type="checkbox" :checked="checked" /><slot /></label>',
  },
  NDropdown: { name: 'NDropdown', props: ['options'], emits: ['select'], template: '<div><slot /></div>' },
  NModal: { template: '<div><slot /><slot name="footer" /></div>' },
  NInputNumber: { template: '<input />' },
  NPopover: { template: '<div><slot name="trigger" /><slot /></div>' },
  NSlider: { template: '<div></div>' },
  useDialog: () => ({ warning: vi.fn() }),
  useMessage: () => ({ error: vi.fn(), success: vi.fn() }),
}))

vi.mock('@/api/studio/sessions', () => ({
  fetchContextLength: vi.fn().mockResolvedValue(256000),
}))

vi.mock('@/api/hermes/model-context', () => ({
  setModelContext: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/composables/useToolTraceVisibility', () => ({
  useToolTraceVisibility: () => ({ toolTraceVisible: { value: true }, toggleToolTraceVisible: vi.fn() }),
}))

vi.mock('@/composables/useMicRecorder', () => ({
  useMicRecorder: () => ({
    state: micRecorderState,
    isRecording: { value: false },
    start: micStartMock,
    stop: micStopMock,
    cancel: micCancelMock,
  }),
}))

vi.mock('@/composables/usePcmStreamRecorder', () => ({
  usePcmStreamRecorder: (options: { continuous?: boolean; onChunk?: (audio: Blob) => void }) => {
    if (options.onChunk) {
      localPcmOnChunk.value = options.onChunk
      localPcmOptions.value = options
      return {
        status: localPcmRecorderStatus,
        error: localPcmRecorderError,
        isRecording: { value: false },
        start: localPcmStartMock,
        stop: localPcmStopMock,
        cancel: localPcmCancelMock,
      }
    }

    return {
      status: pcmRecorderStatus,
      error: pcmRecorderError,
      isRecording: { value: false },
      start: pcmStartMock,
      stop: pcmStopMock,
      cancel: pcmCancelMock,
    }
  },
}))

vi.mock('@/composables/useSpeech', () => ({
  useGlobalSpeech: () => ({
    stop: speechStopMock,
  }),
}))

vi.mock('@/api/studio/stt', () => ({
  transcribeSpeech: transcribeSpeechMock,
  startLocalSttStream: startLocalSttStreamMock,
  pushLocalSttStreamChunk: pushLocalSttStreamChunkMock,
  finishLocalSttStream: finishLocalSttStreamMock,
  cancelLocalSttStream: cancelLocalSttStreamMock,
}))

vi.mock('@/composables/useBrowserSpeechRecognition', () => ({
  useBrowserSpeechRecognition: () => ({
    isSupported: browserRecognitionIsSupported,
    status: browserRecognitionStatus,
    transcript: browserRecognitionTranscript,
    partialTranscript: browserRecognitionPartialTranscript,
    error: browserRecognitionError,
    start: browserStartMock,
    stop: browserStopMock,
    cancel: browserCancelMock,
    clearError: browserClearErrorMock,
  }),
}))

vi.mock('@/composables/useVoiceDialogue', async () => {
  const actual = await vi.importActual<typeof import('@/composables/useVoiceDialogue')>('@/composables/useVoiceDialogue')

  return {
    ...actual,
    useVoiceDialogue: (deps: Parameters<typeof actual.useVoiceDialogue>[0]) =>
      useVoiceDialogueOverride.value?.(deps) ?? actual.useVoiceDialogue(deps),
  }
})

describe('VoiceDialogueControls', () => {
  function mountControls(overrides: Record<string, unknown> = {}) {
    return mount(VoiceDialogueControls, {
      props: {
        status: 'idle',
        transcript: '',
        error: null,
        onStart: vi.fn(),
        onStop: vi.fn(),
        onCancel: vi.fn(),
        ...overrides,
      },
    })
  }

  function mountChatInput(options: Parameters<typeof mount>[1] = {}) {
    const pinia = createTestingPinia({ stubActions: true, createSpy: vi.fn })
    const chatStore = useChatStore()
    chatStore.sessions = [
      {
        id: 'session-voice',
        title: 'session-voice',
        source: 'cli',
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]
    chatStore.activeSessionId = 'session-voice'
    chatStore.activeSession = chatStore.sessions[0]

    const wrapper = mount(ChatInput, {
      ...options,
      global: {
        plugins: [pinia],
        ...options.global,
      },
    })

    return { wrapper, chatStore }
  }

  function getButtonByText(wrapper: ReturnType<typeof mount>, text: string) {
    const button = wrapper.findAll('button').find(candidate => candidate.text().includes(text))
    if (!button) {
      throw new Error(`Button containing "${text}" not found`)
    }
    return button
  }

  beforeEach(async () => {
    localStorage.clear()
    vi.clearAllMocks()
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:mock-audio'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    })
    micRecorderState.value = { status: 'idle', error: null, startedAt: null, mimeType: 'audio/webm' }
    micStartMock.mockImplementation(async () => {
      micRecorderState.value = { status: 'recording', error: null, startedAt: Date.now(), mimeType: 'audio/webm' }
    })
    micStopMock.mockImplementation(async () => {
      micRecorderState.value = { status: 'idle', error: null, startedAt: null, mimeType: 'audio/webm' }
      return new Blob(['audio'], { type: 'audio/webm' })
    })
    micCancelMock.mockImplementation(() => undefined)
    pcmRecorderStatus.value = 'idle'
    pcmRecorderError.value = null
    pcmStartMock.mockImplementation(async () => {
      pcmRecorderStatus.value = 'recording'
    })
    pcmStopMock.mockImplementation(async () => {
      pcmRecorderStatus.value = 'idle'
      return new Blob([new Uint8Array(256)], { type: 'audio/wav' })
    })
    pcmCancelMock.mockImplementation(() => {
      pcmRecorderStatus.value = 'idle'
    })
    localPcmRecorderStatus.value = 'idle'
    localPcmRecorderError.value = null
    localPcmOnChunk.value = null
    localPcmOptions.value = null
    localPcmStartMock.mockImplementation(async () => {
      localPcmRecorderStatus.value = 'recording'
    })
    localPcmStopMock.mockImplementation(async () => {
      localPcmRecorderStatus.value = 'idle'
      return new Blob([new Uint8Array(256)], { type: 'audio/wav' })
    })
    localPcmCancelMock.mockImplementation(() => {
      localPcmRecorderStatus.value = 'idle'
    })
    startLocalSttStreamMock.mockResolvedValue({ sessionId: 'local-input-1' })
    pushLocalSttStreamChunkMock.mockResolvedValue({
      sessionId: 'local-input-1',
      text: '本地实时字幕',
      model: 'local-zipformer',
      durationMs: 1,
    })
    finishLocalSttStreamMock.mockResolvedValue({
      sessionId: 'local-input-1',
      text: '本地最终文本',
      model: 'local-zipformer',
      durationMs: 1,
    })
    cancelLocalSttStreamMock.mockResolvedValue({ success: true })
    browserStartMock.mockImplementation(async () => {
      browserRecognitionStatus.value = 'listening'
      browserRecognitionError.value = null
    })
    browserStopMock.mockImplementation(async () => {
      browserRecognitionStatus.value = 'idle'
      return 'hello hermes'
    })
    browserCancelMock.mockImplementation(() => {
      browserRecognitionStatus.value = 'idle'
    })
    browserClearErrorMock.mockImplementation(() => {
      browserRecognitionError.value = null
      if (browserRecognitionStatus.value === 'error') {
        browserRecognitionStatus.value = 'idle'
      }
    })
    speechStopMock.mockImplementation(() => undefined)
    transcribeSpeechMock.mockResolvedValue({
      text: 'hello hermes',
      provider: 'openai',
      model: 'whisper-1',
      durationMs: 1,
    })
    browserRecognitionStatus.value = 'idle'
    browserRecognitionTranscript.value = ''
    browserRecognitionPartialTranscript.value = ''
    browserRecognitionError.value = null
    browserRecognitionIsSupported.value = true
    useVoiceDialogueOverride.value = null
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: undefined,
    })

    const { useSttSettings } = await import('../../packages/client/src/composables/useSttSettings')
    useSttSettings().reset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: undefined,
    })
  })

  it('starts recording from the mic button while idle', async () => {
    const onStart = vi.fn()
    const wrapper = mountControls({ onStart })

    await wrapper.get('[data-testid="voice-record-toggle"]').trigger('click')

    expect(onStart).toHaveBeenCalledTimes(1)
  })

  it('stops recording from the mic button while active', async () => {
    const onStop = vi.fn()
    const wrapper = mountControls({ status: 'capturing', onStop })

    await wrapper.get('[data-testid="voice-record-toggle"]').trigger('click')

    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it('shows transcript text while active', () => {
    const wrapper = mountControls({ status: 'capturing', transcript: 'hello' })

    expect(wrapper.get('[data-testid="voice-transcript-overlay"]').text()).toContain('hello')
  })

  it('shows cancel only while active and calls onCancel', async () => {
    const onCancel = vi.fn()
    const idleWrapper = mountControls({ onCancel })
    expect(idleWrapper.find('[data-testid="voice-record-cancel"]').exists()).toBe(false)

    const activeWrapper = mountControls({ status: 'transcribing', onCancel })
    await activeWrapper.get('[data-testid="voice-record-cancel"]').trigger('click')

    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('shows overlay error when provided', () => {
    const wrapper = mountControls({ status: 'idle', error: 'Mic permission denied' })

    expect(wrapper.get('[data-testid="voice-transcript-overlay"]').text()).toContain('Mic permission denied')
  })

  it('renders human-readable status, transcript, and error diagnostics', () => {
    const wrapper = mount(VoiceTranscriptOverlay, {
      props: {
        status: 'capturing',
        transcript: 'hello hermes',
        error: 'Mic permission denied',
      },
    })

    const overlay = wrapper.get('[data-testid="voice-transcript-overlay"]')
    expect(overlay.text()).toContain('chat.voiceInput.statusLabel chat.voiceInput.status.capturing')
    expect(overlay.text()).toContain('chat.voiceInput.transcriptLabel hello hermes')
    expect(overlay.text()).toContain('chat.voiceInput.errorLabel Mic permission denied')
  })

  it('does not render the debug event list when debug is false or omitted', async () => {
    const events = [
      { type: 'session.started' },
      { type: 'capture.started' },
    ]

    const wrapper = mount(VoiceTranscriptOverlay, {
      props: {
        status: 'capturing',
        transcript: '',
        events,
      },
    })

    expect(wrapper.text()).not.toContain('chat.voiceInput.recentEvents')
    expect(wrapper.text()).not.toContain('session.started')
    expect(wrapper.text()).not.toContain('capture.started')

    await wrapper.setProps({ debug: false })

    expect(wrapper.text()).not.toContain('chat.voiceInput.recentEvents')
    expect(wrapper.text()).not.toContain('session.started')
    expect(wrapper.text()).not.toContain('capture.started')
  })

  it('renders only the last five event type strings in order when debug is true', () => {
    const events = [
      { type: 'session.started', payload: { apiKey: 'secret-api-key-123' } },
      { type: 'capture.started', payload: { audioBlob: 'blob:super-secret-audio' } },
      { type: 'capture.partial' },
      { type: 'transcript.done', payload: { apiKey: 'secret-api-key-123' } },
      { type: 'turn.started', payload: { audioBlob: 'blob:super-secret-audio' } },
      { type: 'turn.ended', payload: { apiKey: 'secret-api-key-123', audioBlob: 'blob:super-secret-audio' } },
    ]

    const wrapper = mount(VoiceTranscriptOverlay, {
      props: {
        status: 'sending',
        transcript: 'hello hermes',
        events,
        debug: true,
      },
    })

    const items = wrapper.findAll('[data-testid="voice-event-debug-item"]')
    expect(items).toHaveLength(5)
    expect(items.map(item => item.text())).toEqual([
      'capture.started',
      'capture.partial',
      'transcript.done',
      'turn.started',
      'turn.ended',
    ])
    expect(wrapper.text()).not.toContain('session.started')
    expect(wrapper.text()).not.toContain('secret-api-key-123')
    expect(wrapper.text()).not.toContain('blob:super-secret-audio')
  })

  it('does not treat error state as active controls', async () => {
    const onStart = vi.fn()
    const onStop = vi.fn()
    const wrapper = mountControls({ status: 'error', transcript: '', error: 'boom', onStart, onStop })

    expect(wrapper.get('[data-testid="voice-transcript-overlay"]').text()).toContain('boom')
    expect(wrapper.get('[data-testid="voice-record-toggle"]').attributes('aria-pressed')).toBe('false')
    expect(wrapper.get('[data-testid="voice-record-toggle"]').attributes('aria-label')).toBe('chat.voiceInput.startCapture')
    expect(wrapper.find('[data-testid="voice-record-cancel"]').exists()).toBe(false)

    await wrapper.get('[data-testid="voice-record-toggle"]').trigger('click')

    expect(onStart).toHaveBeenCalledTimes(1)
    expect(onStop).not.toHaveBeenCalled()
  })

  it('renders the transcript overlay as a floating anchored element', () => {
    const wrapper = mountControls({ status: 'capturing', transcript: 'hello' })
    const controls = wrapper.get('.voice-dialogue-controls')
    const overlay = wrapper.get('[data-testid="voice-transcript-overlay"]')

    expect(controls.classes()).toContain('voice-dialogue-controls--floating-overlay')
    expect(overlay.classes()).toContain('voice-transcript-overlay--floating')
  })

  it('reflects the active state in aria-pressed', async () => {
    const idleWrapper = mountControls({ status: 'idle' })
    expect(idleWrapper.get('[data-testid="voice-record-toggle"]').attributes('aria-pressed')).toBe('false')

    await idleWrapper.setProps({ status: 'sending' })
    expect(idleWrapper.get('[data-testid="voice-record-toggle"]').attributes('aria-pressed')).toBe('true')
  })

  it('mounts the voice controls in ChatInput and preserves text send behavior', async () => {
    const { wrapper, chatStore } = mountChatInput()
    await flushPromises()

    expect(wrapper.find('[data-testid="voice-record-toggle"]').exists()).toBe(true)

    await wrapper.get('textarea').setValue('typed hello')
    await getButtonByText(wrapper, 'chat.send').trigger('click')

    expect(chatStore.sendMessage).toHaveBeenCalledWith('typed hello', undefined)
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('')
  })

  it('opens realtime voice from voice mode in input settings without replacing the STT microphone', async () => {
    const { wrapper } = mountChatInput()
    await flushPromises()

    const dropdown = wrapper.getComponent({ name: 'NDropdown' })
    const options = dropdown.props('options') as Array<{ key: string; label: string }>
    expect(options.map(option => option.key)).toContain('voiceMode')
    expect(options.map(option => option.key)).not.toContain('autoPlaySpeech')

    dropdown.vm.$emit('select', 'voiceMode')
    await flushPromises()

    expect(wrapper.emitted('voiceClick')).toHaveLength(1)
    expect(micStartMock).not.toHaveBeenCalled()
  })

  it('keeps voice event debug diagnostics hidden in the normal ChatInput path', async () => {
    const { wrapper } = mountChatInput()
    await flushPromises()

    await wrapper.get('[data-testid="voice-record-toggle"]').trigger('click')
    await flushPromises()

    const overlay = wrapper.get('[data-testid="voice-transcript-overlay"]')
    expect(overlay.text()).not.toContain('chat.voiceInput.recentEvents')
    expect(overlay.text()).not.toContain('session.started')
    expect(overlay.text()).not.toContain('capture.started')
  })

  it('keeps debug diagnostics hidden by default in ChatInput even when live voice events include sensitive payloads', async () => {
    const liveEvents = [
      { id: 'voice-session:1', seq: 1, sessionId: 'voice-session', type: 'session.started', timestamp: '2026-06-06T00:00:00.000Z', payload: { apiKey: 'secret-api-key-123' } },
      { id: 'voice-session:2', seq: 2, sessionId: 'voice-session', type: 'capture.started', timestamp: '2026-06-06T00:00:01.000Z', payload: { audioBlob: 'blob:super-secret-audio' } },
      { id: 'voice-session:3', seq: 3, sessionId: 'voice-session', type: 'capture.stopped', timestamp: '2026-06-06T00:00:02.000Z' },
      { id: 'voice-session:4', seq: 4, sessionId: 'voice-session', type: 'transcript.done', timestamp: '2026-06-06T00:00:03.000Z', payload: { apiKey: 'secret-api-key-123' } },
      { id: 'voice-session:5', seq: 5, sessionId: 'voice-session', type: 'turn.started', timestamp: '2026-06-06T00:00:04.000Z', payload: { audioBlob: 'blob:super-secret-audio' } },
      { id: 'voice-session:6', seq: 6, sessionId: 'voice-session', type: 'turn.ended', timestamp: '2026-06-06T00:00:05.000Z', payload: { apiKey: 'secret-api-key-123', audioBlob: 'blob:super-secret-audio' } },
    ]

    useVoiceDialogueOverride.value = () => ({
      sessionId: 'voice-session',
      events: { value: liveEvents },
      status: { value: 'capturing' },
      activeCaptureId: { value: 'capture-1' },
      activeTurnId: { value: null },
      transcript: { value: 'hello hermes' },
      error: { value: null },
      isBusy: { value: true },
      beginCapture: vi.fn(),
      transcribeAndSend: vi.fn(),
      commitTranscript: vi.fn(),
      cancelCapture: vi.fn(),
      markOutputStarted: vi.fn(),
      markOutputDone: vi.fn(),
    })

    const { wrapper } = mountChatInput()
    await flushPromises()

    const overlay = wrapper.get('[data-testid="voice-transcript-overlay"]')
    expect(overlay.text()).toContain('chat.voiceInput.statusLabel')
    expect(overlay.text()).not.toContain('chat.voiceInput.recentEvents')
    expect(overlay.text()).not.toContain('session.started')
    expect(overlay.text()).not.toContain('capture.started')
    expect(overlay.text()).not.toContain('secret-api-key-123')
    expect(overlay.text()).not.toContain('blob:super-secret-audio')
  })

  it('passes live voice dialogue events into VoiceDialogueControls while leaving debug disabled in ChatInput', async () => {
    const liveEvents = [
      { id: 'voice-session:1', seq: 1, sessionId: 'voice-session', type: 'session.started', timestamp: '2026-06-06T00:00:00.000Z', payload: { apiKey: 'secret-api-key-123' } },
      { id: 'voice-session:2', seq: 2, sessionId: 'voice-session', type: 'capture.started', timestamp: '2026-06-06T00:00:01.000Z', payload: { audioBlob: 'blob:super-secret-audio' } },
      { id: 'voice-session:3', seq: 3, sessionId: 'voice-session', type: 'capture.stopped', timestamp: '2026-06-06T00:00:02.000Z' },
      { id: 'voice-session:4', seq: 4, sessionId: 'voice-session', type: 'transcript.done', timestamp: '2026-06-06T00:00:03.000Z', payload: { apiKey: 'secret-api-key-123' } },
      { id: 'voice-session:5', seq: 5, sessionId: 'voice-session', type: 'turn.started', timestamp: '2026-06-06T00:00:04.000Z', payload: { audioBlob: 'blob:super-secret-audio' } },
      { id: 'voice-session:6', seq: 6, sessionId: 'voice-session', type: 'turn.ended', timestamp: '2026-06-06T00:00:05.000Z', payload: { apiKey: 'secret-api-key-123', audioBlob: 'blob:super-secret-audio' } },
    ]

    useVoiceDialogueOverride.value = () => ({
      sessionId: 'voice-session',
      events: { value: liveEvents },
      status: { value: 'capturing' },
      activeCaptureId: { value: 'capture-1' },
      activeTurnId: { value: null },
      transcript: { value: 'hello hermes' },
      error: { value: null },
      isBusy: { value: true },
      beginCapture: vi.fn(),
      transcribeAndSend: vi.fn(),
      commitTranscript: vi.fn(),
      cancelCapture: vi.fn(),
      markOutputStarted: vi.fn(),
      markOutputDone: vi.fn(),
    })

    const VoiceDialogueControlsStub = defineComponent({
      props: {
        debug: { type: Boolean, required: false },
        events: { type: Array, required: false },
      },
      template: `
        <div data-testid="voice-controls-props">
          <span data-testid="voice-controls-debug">{{ String(debug ?? false) }}</span>
          <span
            v-for="event in (events ?? [])"
            :key="event.id ?? event.type"
            data-testid="voice-controls-event"
          >
            {{ event.type }}
          </span>
        </div>
      `,
    })

    const { wrapper } = mountChatInput({
      global: {
        stubs: {
          VoiceDialogueControls: VoiceDialogueControlsStub,
        },
      },
    })
    await flushPromises()

    expect(wrapper.get('[data-testid="voice-controls-debug"]').text()).toBe('false')
    expect(wrapper.findAll('[data-testid="voice-controls-event"]').map(item => item.text())).toEqual([
      'session.started',
      'capture.started',
      'capture.stopped',
      'transcript.done',
      'turn.started',
      'turn.ended',
    ])
    expect(wrapper.text()).not.toContain('secret-api-key-123')
    expect(wrapper.text()).not.toContain('blob:super-secret-audio')
  })

  it('stops output audio before starting mic capture from ChatInput', async () => {
    const { wrapper } = mountChatInput()
    await flushPromises()

    await wrapper.get('[data-testid="voice-record-toggle"]').trigger('click')
    await flushPromises()

    expect(speechStopMock).toHaveBeenCalledWith(true)
    expect(micStartMock).toHaveBeenCalledTimes(1)
    expect(speechStopMock.mock.invocationCallOrder[0]).toBeLessThan(micStartMock.mock.invocationCallOrder[0])
  })

  it('records, transcribes with the selected backend provider, and stages the transcript for editing', async () => {
    const audio = new Blob(['captured audio'], { type: 'audio/webm' })
    micStopMock.mockResolvedValueOnce(audio)

    const { useSttSettings } = await import('../../packages/client/src/composables/useSttSettings')
    const sttSettings = useSttSettings()
    sttSettings.setProvider('custom')
    sttSettings.setCustomLanguage('ja')
    sttSettings.setCustomPrompt('keep punctuation')

    const { wrapper, chatStore } = mountChatInput()
    await flushPromises()

    await wrapper.get('[data-testid="voice-record-toggle"]').trigger('click')
    await flushPromises()
    expect(micStartMock).toHaveBeenCalledTimes(1)
    expect(transcribeSpeechMock).not.toHaveBeenCalled()
    expect(startLocalSttStreamMock).not.toHaveBeenCalled()

    await wrapper.get('[data-testid="voice-record-toggle"]').trigger('click')
    await flushPromises()

    expect(micStopMock).toHaveBeenCalledTimes(1)
    expect(transcribeSpeechMock).toHaveBeenCalledWith({
      audio,
      provider: 'custom',
      language: 'ja',
      prompt: 'keep punctuation',
    })
    expect(startLocalSttStreamMock).not.toHaveBeenCalled()
    expect(localPcmStartMock).not.toHaveBeenCalled()
    expect(chatStore.sendMessage).not.toHaveBeenCalled()
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('hello hermes')
  })

  it('streams local PCM partials and stages the final transcript like browser recognition', async () => {
    const { useSttSettings } = await import('../../packages/client/src/composables/useSttSettings')
    useSttSettings().setProvider('local')

    const { wrapper, chatStore } = mountChatInput()
    await flushPromises()

    await wrapper.get('[data-testid="voice-record-toggle"]').trigger('click')
    await flushPromises()

    expect(startLocalSttStreamMock).toHaveBeenCalledOnce()
    expect(localPcmStartMock).toHaveBeenCalledOnce()
    expect(localPcmOptions.value?.continuous).toBe(true)
    expect(micStartMock).not.toHaveBeenCalled()
    expect(pcmStartMock).not.toHaveBeenCalled()

    const liveChunk = new Blob([new Uint8Array(256)], { type: 'audio/wav' })
    localPcmOnChunk.value?.(liveChunk)
    await flushPromises()

    expect(pushLocalSttStreamChunkMock).toHaveBeenCalledWith('local-input-1', liveChunk)
    expect(wrapper.get('[data-testid="voice-transcript-overlay"]').text()).toContain('本地实时字幕')

    await wrapper.get('[data-testid="voice-record-toggle"]').trigger('click')
    await flushPromises()

    expect(localPcmStopMock).toHaveBeenCalledOnce()
    expect(pushLocalSttStreamChunkMock).toHaveBeenCalledTimes(2)
    expect(finishLocalSttStreamMock).toHaveBeenCalledWith('local-input-1')
    expect(transcribeSpeechMock).not.toHaveBeenCalled()
    expect(chatStore.sendMessage).not.toHaveBeenCalled()
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('本地最终文本')
    expect(wrapper.find('[data-testid="voice-transcript-overlay"]').exists()).toBe(false)
  })

  it('cancels local streaming input without committing or running single-shot STT', async () => {
    const { useSttSettings } = await import('../../packages/client/src/composables/useSttSettings')
    useSttSettings().setProvider('local')

    const { wrapper, chatStore } = mountChatInput()
    await flushPromises()

    await wrapper.get('[data-testid="voice-record-toggle"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="voice-record-cancel"]').trigger('click')
    await flushPromises()

    expect(localPcmCancelMock).toHaveBeenCalledOnce()
    expect(cancelLocalSttStreamMock).toHaveBeenCalledWith('local-input-1')
    expect(finishLocalSttStreamMock).not.toHaveBeenCalled()
    expect(transcribeSpeechMock).not.toHaveBeenCalled()
    expect(chatStore.sendMessage).not.toHaveBeenCalled()
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('')
    expect(wrapper.find('[data-testid="voice-transcript-overlay"]').exists()).toBe(false)
  })

  it('records desktop-shell input as PCM WAV instead of MediaRecorder Opus', async () => {
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: { isDesktop: true, platform: 'win32' },
    })
    const wav = new Blob([new Uint8Array(256)], { type: 'audio/wav' })
    pcmStopMock.mockResolvedValueOnce(wav)

    const { wrapper } = mountChatInput()
    await flushPromises()

    await wrapper.get('[data-testid="voice-record-toggle"]').trigger('click')
    await flushPromises()
    expect(pcmStartMock).toHaveBeenCalledOnce()
    expect(micStartMock).not.toHaveBeenCalled()

    await wrapper.get('[data-testid="voice-record-toggle"]').trigger('click')
    await flushPromises()

    expect(pcmStopMock).toHaveBeenCalledOnce()
    expect(micStopMock).not.toHaveBeenCalled()
    expect(transcribeSpeechMock).toHaveBeenCalledWith(expect.objectContaining({
      audio: wav,
      provider: 'openai',
    }))
  })

  it('records mobile input as PCM WAV instead of MediaRecorder Opus', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/138 Mobile Safari/537.36',
      maxTouchPoints: 5,
    })
    const wav = new Blob([new Uint8Array(256)], { type: 'audio/wav' })
    pcmStopMock.mockResolvedValueOnce(wav)

    const { wrapper } = mountChatInput()
    await flushPromises()

    await wrapper.get('[data-testid="voice-record-toggle"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="voice-record-toggle"]').trigger('click')
    await flushPromises()

    expect(pcmStartMock).toHaveBeenCalledOnce()
    expect(micStartMock).not.toHaveBeenCalled()
    expect(transcribeSpeechMock).toHaveBeenCalledWith(expect.objectContaining({
      audio: wav,
      provider: 'openai',
    }))
  })

  it('uses Doubao as a server-backed STT provider without client-side credentials', async () => {
    const audio = new Blob(['captured audio'], { type: 'audio/webm' })
    micStopMock.mockResolvedValueOnce(audio)

    const { useSttSettings } = await import('../../packages/client/src/composables/useSttSettings')
    useSttSettings().setProvider('doubao')

    const { wrapper } = mountChatInput()
    await flushPromises()

    await wrapper.get('[data-testid="voice-record-toggle"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="voice-record-toggle"]').trigger('click')
    await flushPromises()

    expect(transcribeSpeechMock).toHaveBeenCalledWith({
      audio,
      provider: 'doubao',
    })
  })

  it('uses browser speech recognition when the browser provider is selected and stages the transcript', async () => {
    browserStopMock.mockResolvedValueOnce('browser hello')

    const { useSttSettings } = await import('../../packages/client/src/composables/useSttSettings')
    const sttSettings = useSttSettings()
    sttSettings.setProvider('browser')
    sttSettings.setOpenaiLanguage('en-US')

    const { wrapper, chatStore } = mountChatInput()
    await flushPromises()

    await wrapper.get('[data-testid="voice-record-toggle"]').trigger('click')
    await flushPromises()

    expect(browserStartMock).toHaveBeenCalledWith({ language: 'en-US' })
    expect(micStartMock).not.toHaveBeenCalled()
    expect(speechStopMock).toHaveBeenCalledWith(true)

    await wrapper.get('[data-testid="voice-record-toggle"]').trigger('click')
    await flushPromises()

    expect(browserStopMock).toHaveBeenCalledTimes(1)
    expect(micStopMock).not.toHaveBeenCalled()
    expect(transcribeSpeechMock).not.toHaveBeenCalled()
    expect(chatStore.sendMessage).not.toHaveBeenCalled()
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('browser hello')
    expect(wrapper.find('[data-testid="voice-transcript-overlay"]').exists()).toBe(false)
  })

  it('shows browser recognition errors only for the browser provider and clears stale browser errors before backend capture', async () => {
    const { useSttSettings } = await import('../../packages/client/src/composables/useSttSettings')
    const sttSettings = useSttSettings()

    browserRecognitionError.value = new Error('Browser speech recognition failed.')
    browserRecognitionStatus.value = 'error'
    sttSettings.setProvider('browser')

    const browserWrapper = mountChatInput().wrapper
    await flushPromises()

    expect(browserWrapper.get('[data-testid="voice-transcript-overlay"]').text()).toContain('Browser speech recognition failed.')

    browserWrapper.unmount()
    sttSettings.setProvider('openai')

    const { wrapper } = mountChatInput()
    await flushPromises()

    expect(wrapper.find('[data-testid="voice-transcript-overlay"]').exists()).toBe(false)

    await wrapper.get('[data-testid="voice-record-toggle"]').trigger('click')
    await flushPromises()

    expect(browserClearErrorMock).toHaveBeenCalledTimes(1)
    expect(browserRecognitionError.value).toBeNull()
    expect(browserRecognitionStatus.value).toBe('idle')
    expect(micStartMock).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-testid="voice-transcript-overlay"]').text()).not.toContain('Browser speech recognition failed.')
  })

  it('cancels browser speech recognition without transcribing or sending', async () => {
    const { useSttSettings } = await import('../../packages/client/src/composables/useSttSettings')
    useSttSettings().setProvider('browser')

    const { wrapper, chatStore } = mountChatInput()
    await flushPromises()

    await wrapper.get('[data-testid="voice-record-toggle"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="voice-record-cancel"]').trigger('click')
    await flushPromises()

    expect(browserCancelMock).toHaveBeenCalledTimes(1)
    expect(micCancelMock).not.toHaveBeenCalled()
    expect(transcribeSpeechMock).not.toHaveBeenCalled()
    expect(chatStore.sendMessage).not.toHaveBeenCalled()
  })

  it('stages a transcribed stop phrase for editing instead of routing it as a control intent', async () => {
    transcribeSpeechMock.mockResolvedValueOnce({
      text: 'stop',
      provider: 'openai',
      model: 'whisper-1',
      durationMs: 1,
    })

    const { wrapper, chatStore } = mountChatInput()
    await flushPromises()

    await wrapper.get('[data-testid="voice-record-toggle"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="voice-record-toggle"]').trigger('click')
    await flushPromises()

    expect(chatStore.stopStreaming).not.toHaveBeenCalled()
    expect(chatStore.sendMessage).not.toHaveBeenCalled()
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('stop')
  })

  it('appends a transcribed status phrase to the editable draft without clearing attachments', async () => {
    transcribeSpeechMock.mockResolvedValueOnce({
      text: 'status',
      provider: 'openai',
      model: 'whisper-1',
      durationMs: 1,
    })

    const { wrapper, chatStore } = mountChatInput()
    await flushPromises()

    const textarea = wrapper.get('textarea').element as HTMLTextAreaElement
    await wrapper.get('textarea').setValue('typed hello')
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)

    const attachmentInput = wrapper.get('input[type="file"]')
    const file = new File(['notes'], 'voice-notes.txt', { type: 'text/plain' })
    Object.defineProperty(attachmentInput.element, 'files', {
      configurable: true,
      value: [file],
    })
    await attachmentInput.trigger('change')
    await flushPromises()

    expect(wrapper.text()).toContain('voice-notes.txt')

    await wrapper.get('[data-testid="voice-record-toggle"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="voice-record-toggle"]').trigger('click')
    await flushPromises()

    expect(chatStore.sendMessage).not.toHaveBeenCalled()
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('typed hello status')
    expect(wrapper.text()).toContain('voice-notes.txt')
    expect(wrapper.find('[data-testid="voice-record-cancel"]').exists()).toBe(false)
  })

  it('does not transcribe or send when recording is stopped during pending mic startup', async () => {
    const startDeferred = createDeferred<void>()
    micStartMock.mockImplementationOnce(() => {
      micRecorderState.value = { status: 'requesting', error: null, startedAt: null, mimeType: 'audio/webm' }
      return startDeferred.promise
    })
    micStopMock.mockResolvedValueOnce(new Blob([], { type: 'audio/webm' }))

    const { wrapper, chatStore } = mountChatInput()
    await flushPromises()

    const startClick = wrapper.get('[data-testid="voice-record-toggle"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="voice-record-cancel"]').exists()).toBe(true)

    await wrapper.get('[data-testid="voice-record-toggle"]').trigger('click')
    await flushPromises()

    expect(transcribeSpeechMock).not.toHaveBeenCalled()
    expect(chatStore.sendMessage).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="voice-record-cancel"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="voice-record-toggle"]').attributes('aria-pressed')).toBe('false')

    startDeferred.resolve()
    await startClick
    await flushPromises()
  })

  it('cancels an active voice capture from ChatInput', async () => {
    const { wrapper, chatStore } = mountChatInput()
    await flushPromises()

    await wrapper.get('[data-testid="voice-record-toggle"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="voice-record-cancel"]').trigger('click')
    await flushPromises()

    expect(micCancelMock).toHaveBeenCalledTimes(1)
    expect(transcribeSpeechMock).not.toHaveBeenCalled()
    expect(chatStore.sendMessage).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="voice-record-cancel"]').exists()).toBe(false)
  })
})
