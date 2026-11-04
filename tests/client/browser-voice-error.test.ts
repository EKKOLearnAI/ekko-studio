// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import VoiceDialogueControls from '../../packages/client/src/components/hermes/chat/VoiceDialogueControls.vue'
import { useComposerVoiceInput } from '../../packages/client/src/composables/useComposerVoiceInput'
import { useSttSettings } from '../../packages/client/src/composables/useSttSettings'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string, values?: Record<string, string>) => `${key}${values?.error ? `: ${values.error}` : ''}` }),
}))
vi.mock('@/utils/desktop-bridge', () => ({ isDesktopShell: () => false }))
vi.mock('@/utils/device', () => ({ isMobileDevice: () => false }))
vi.mock('@/composables/useSpeech', () => ({ useGlobalSpeech: () => ({ stop: vi.fn() }) }))
vi.mock('@/api/studio/stt-settings', () => ({ fetchSttSettings: vi.fn() }))
vi.mock('@/api/studio/stt', () => ({
  transcribeSpeech: vi.fn(),
  startLocalSttStream: vi.fn(),
  pushLocalSttStreamChunk: vi.fn(),
  finishLocalSttStream: vi.fn(),
  cancelLocalSttStream: vi.fn(),
}))
vi.mock('@/composables/useMicRecorder', () => ({
  useMicRecorder: () => ({ state: ref({ status: 'idle', error: null }), cancel: vi.fn() }),
}))
vi.mock('@/composables/usePcmStreamRecorder', () => ({
  usePcmStreamRecorder: () => ({ status: ref('idle'), error: ref(null), cancel: vi.fn() }),
}))

type ResultEvent = {
  resultIndex: number
  results: { length: number; [index: number]: { isFinal: boolean; 0: { transcript: string } } }
}

let recognitions: FakeSpeechRecognition[]
class FakeSpeechRecognition {
  lang = ''
  interimResults = false
  continuous = false
  onresult: ((event: ResultEvent) => void) | null = null
  onerror: ((event: { error: string }) => void) | null = null
  onend: (() => void) | null = null
  start = vi.fn()
  stop = vi.fn(() => this.onend?.())
  abort = vi.fn()

  constructor() { recognitions.push(this) }

  result(text: string, isFinal = true) {
    this.onresult?.({ resultIndex: 0, results: { length: 1, 0: { isFinal, 0: { transcript: text } } } })
  }
}

let wrapper: VueWrapper | undefined

function setupInput() {
  const insertTranscript = vi.fn()
  let input!: ReturnType<typeof useComposerVoiceInput>
  wrapper = mount(defineComponent({
    setup() {
      input = useComposerVoiceInput({ insertTranscript })
      return () => h(VoiceDialogueControls, {
        status: input.dialogue.status.value,
        transcript: input.transcript.value,
        error: input.error.value,
        onStart: input.start,
        onStop: input.stop,
        onCancel: input.cancel,
      })
    },
  }), { attachTo: document.body })
  return { input, insertTranscript }
}

async function toggleCapture() {
  await wrapper!.get('[data-testid="voice-record-toggle"]').trigger('click')
  await flushPromises()
}

async function clickOutside() {
  document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  await flushPromises()
}

beforeEach(() => {
  recognitions = []
  vi.stubGlobal('SpeechRecognition', FakeSpeechRecognition)
  useSttSettings().reset()
  useSttSettings().setProvider('browser')
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.unstubAllGlobals()
})

describe('browser voice errors after recording has started', () => {
  it.each(['not-allowed', 'network', 'no-speech'])('makes %s errors idle, retryable and dismissible', async (error) => {
    const { input, insertTranscript } = setupInput()
    await toggleCapture()
    expect(input.dialogue.status.value).toBe('capturing')

    recognitions[0].onerror?.({ error })
    await flushPromises()

    expect(input.dialogue.status.value).toBe('idle')
    expect(input.dialogue.activeCaptureId.value).toBeNull()
    expect(wrapper!.get('[data-testid="voice-record-toggle"]').attributes('aria-pressed')).toBe('false')
    expect(wrapper!.get('[role="alert"]').text()).toContain(error)
    expect(insertTranscript).not.toHaveBeenCalled()

    await clickOutside()
    expect(wrapper!.find('[data-testid="voice-transcript-overlay"]').exists()).toBe(false)
    expect(input.error.value).toContain(error)
  })

  it('starts a fresh recognition session after a permission error and inserts its result', async () => {
    const { input, insertTranscript } = setupInput()
    await toggleCapture()
    recognitions[0].onerror?.({ error: 'not-allowed' })
    await flushPromises()
    await clickOutside()

    await toggleCapture()
    expect(recognitions).toHaveLength(2)
    expect(recognitions[1].start).toHaveBeenCalledOnce()
    expect(input.error.value).toBeNull()
    recognitions[1].result('  recognition   recovered  ')
    await toggleCapture()

    expect(insertTranscript).toHaveBeenCalledOnce()
    expect(insertTranscript).toHaveBeenCalledWith('recognition recovered')
    expect(input.dialogue.status.value).toBe('idle')
  })

  it('retains finalized text when an error ends active recognition', async () => {
    const { input, insertTranscript } = setupInput()
    await toggleCapture()
    recognitions[0].result('keep these words')

    recognitions[0].onerror?.({ error: 'network' })
    await flushPromises()

    expect(insertTranscript).toHaveBeenCalledOnce()
    expect(insertTranscript).toHaveBeenCalledWith('keep these words')
    expect(input.dialogue.status.value).toBe('idle')
    expect(input.error.value).toContain('network')
  })

  it('keeps active recording visible when clicking outside', async () => {
    const { input } = setupInput()
    await toggleCapture()

    await clickOutside()

    expect(input.dialogue.status.value).toBe('capturing')
    expect(wrapper!.get('[data-testid="voice-transcript-overlay"]').attributes('data-status')).toBe('capturing')
    expect(recognitions[0].stop).not.toHaveBeenCalled()
    expect(recognitions[0].abort).not.toHaveBeenCalled()
  })

  it('ignores an old recognition error callback after cancellation', async () => {
    const { input, insertTranscript } = setupInput()
    await toggleCapture()
    const staleError = recognitions[0].onerror
    input.cancel()

    staleError?.({ error: 'network' })
    await flushPromises()

    expect(input.dialogue.status.value).toBe('idle')
    expect(input.error.value).toBeNull()
    expect(insertTranscript).not.toHaveBeenCalled()
    expect(recognitions[0].abort).toHaveBeenCalledOnce()
  })

  it('inserts finalized text once when an error rejects a pending stop', async () => {
    const { input, insertTranscript } = setupInput()
    let finishInsert!: () => void
    insertTranscript.mockImplementation(() => new Promise<void>(resolve => { finishInsert = resolve }))
    await toggleCapture()
    recognitions[0].result('keep these words')
    recognitions[0].result('unfinished words', false)
    recognitions[0].stop.mockImplementation(() => undefined)
    const stopping = input.stop()
    const repeatedStop = input.stop()

    recognitions[0].onerror?.({ error: 'network' })
    await flushPromises()

    expect(input.dialogue.status.value).toBe('sending')
    expect(input.error.value).toContain('network')
    expect(insertTranscript).toHaveBeenCalledOnce()
    expect(insertTranscript).toHaveBeenCalledWith('keep these words')
    expect(recognitions[0].stop).toHaveBeenCalledOnce()

    finishInsert()
    await Promise.all([stopping, repeatedStop])
    await flushPromises()
    expect(input.dialogue.status.value).toBe('idle')
    expect(insertTranscript).toHaveBeenCalledOnce()
  })

  it('does not insert interim text when an error rejects a pending stop without final text', async () => {
    const { input, insertTranscript } = setupInput()
    await toggleCapture()
    recognitions[0].result('unfinished words', false)
    recognitions[0].stop.mockImplementation(() => undefined)
    const stopping = input.stop()

    recognitions[0].onerror?.({ error: 'network' })
    await stopping
    await flushPromises()

    expect(input.dialogue.status.value).toBe('idle')
    expect(input.error.value).toContain('network')
    expect(insertTranscript).not.toHaveBeenCalled()
  })

  it.each(['cancel', 'unmount'] as const)('does not insert a pending stop after %s', async (action) => {
    const { input, insertTranscript } = setupInput()
    await toggleCapture()
    recognitions[0].result('discard these words')
    recognitions[0].stop.mockImplementation(() => undefined)
    const stopping = input.stop()

    recognitions[0].onerror?.({ error: 'network' })
    if (action === 'unmount') {
      wrapper!.unmount()
      wrapper = undefined
    } else {
      input.cancel()
    }
    await stopping
    await flushPromises()

    expect(input.dialogue.status.value).toBe('idle')
    expect(input.dialogue.activeCaptureId.value).toBeNull()
    expect(insertTranscript).not.toHaveBeenCalled()
  })

  it('does not let an old stop or error callback affect a new capture', async () => {
    const { input, insertTranscript } = setupInput()
    await toggleCapture()
    recognitions[0].result('discard these words')
    recognitions[0].stop.mockImplementation(() => undefined)
    const staleError = recognitions[0].onerror
    const stopping = input.stop()

    await input.start()
    staleError?.({ error: 'network' })
    await stopping
    await flushPromises()

    expect(input.dialogue.status.value).toBe('capturing')
    expect(input.activeCaptureMode.value).toBe('browser')
    expect(input.error.value).toBeNull()
    expect(insertTranscript).not.toHaveBeenCalled()

    recognitions[1].result('new capture words')
    await input.stop()
    expect(insertTranscript).toHaveBeenCalledOnce()
    expect(insertTranscript).toHaveBeenCalledWith('new capture words')
    expect(input.dialogue.status.value).toBe('idle')
  })

  it('keeps an insertion failure visible without retrying the finalized text', async () => {
    const { input, insertTranscript } = setupInput()
    insertTranscript.mockRejectedValue(new Error('Insertion failed'))
    await toggleCapture()
    recognitions[0].result('keep these words')
    recognitions[0].stop.mockImplementation(() => undefined)
    const stopping = input.stop()

    recognitions[0].onerror?.({ error: 'network' })
    await stopping
    await flushPromises()

    expect(insertTranscript).toHaveBeenCalledOnce()
    expect(insertTranscript).toHaveBeenCalledWith('keep these words')
    expect(input.dialogue.status.value).toBe('error')
    expect(input.error.value).toBe('Insertion failed')
  })
})
