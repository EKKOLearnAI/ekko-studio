// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import { useComposerVoiceInput } from '../../packages/client/src/composables/useComposerVoiceInput'
import { useSttSettings } from '../../packages/client/src/composables/useSttSettings'
import type { FetchSttSettingsResponse } from '../../packages/client/src/api/studio/stt-settings'

const mocks = vi.hoisted(() => ({
  desktop: vi.fn(),
  fetchSettings: vi.fn(),
  transcribe: vi.fn(),
  startLocal: vi.fn(),
  pushLocal: vi.fn(),
  finishLocal: vi.fn(),
  cancelLocal: vi.fn(),
}))

function recorder() {
  const status = ref('idle')
  return {
    status,
    error: ref<Error | null>(null),
    start: vi.fn(async () => { status.value = 'recording' }),
    stop: vi.fn(async (): Promise<Blob | null> => { status.value = 'idle'; return null }),
    cancel: vi.fn(() => { status.value = 'idle' }),
  }
}

let mic: ReturnType<typeof recorder>
let pcm: ReturnType<typeof recorder>
let local: ReturnType<typeof recorder>
let browser: Omit<ReturnType<typeof recorder>, 'stop'> & {
  stop: ReturnType<typeof vi.fn<() => Promise<string>>>
  clearError: ReturnType<typeof vi.fn>
}
let localChunk: (audio: Blob) => Promise<void>

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/utils/desktop-bridge', () => ({ isDesktopShell: mocks.desktop }))
vi.mock('@/utils/device', () => ({ isMobileDevice: () => false }))
vi.mock('@/composables/useSpeech', () => ({ useGlobalSpeech: () => ({ stop: vi.fn() }) }))
vi.mock('@/api/studio/stt-settings', () => ({ fetchSttSettings: mocks.fetchSettings }))
vi.mock('@/api/studio/stt', () => ({
  transcribeSpeech: mocks.transcribe,
  startLocalSttStream: mocks.startLocal,
  pushLocalSttStreamChunk: mocks.pushLocal,
  finishLocalSttStream: mocks.finishLocal,
  cancelLocalSttStream: mocks.cancelLocal,
}))
vi.mock('@/composables/useMicRecorder', () => ({
  useMicRecorder: () => {
    mic = recorder()
    return { ...mic, state: ref({ status: 'idle', error: null }) }
  },
}))
vi.mock('@/composables/usePcmStreamRecorder', () => ({
  usePcmStreamRecorder: (options: { continuous?: boolean; onChunk?: typeof localChunk }) => {
    if (options.continuous) {
      local = recorder()
      localChunk = options.onChunk!
      return local
    }
    pcm = recorder()
    return pcm
  },
}))
vi.mock('@/composables/useBrowserSpeechRecognition', () => ({
  useBrowserSpeechRecognition: () => {
    browser = { ...recorder(), stop: vi.fn(async () => ''), clearError: vi.fn() }
    return { ...browser, transcript: ref(''), partialTranscript: ref('') }
  },
}))

let wrapper: VueWrapper | undefined

function setupInput() {
  const insertTranscript = vi.fn()
  let input!: ReturnType<typeof useComposerVoiceInput>
  wrapper = mount(defineComponent({
    setup() {
      input = useComposerVoiceInput({ insertTranscript })
      return () => null
    },
  }))
  return { input, insertTranscript }
}

function cloudSettings(): FetchSttSettingsResponse {
  return {
    activeProvider: 'groq',
    providers: [{ provider: 'groq', settings: {}, secrets: { apiKey: '[stored]' }, updatedAt: 1 }],
  }
}

function expectNoCaptureStarted() {
  expect(browser.start).not.toHaveBeenCalled()
  expect(mic.start).not.toHaveBeenCalled()
  expect(pcm.start).not.toHaveBeenCalled()
  expect(local.start).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear()
  useSttSettings().reset()
  useSttSettings().setProvider('browser')
  mocks.desktop.mockReturnValue(true)
  mocks.fetchSettings.mockResolvedValue({ activeProvider: 'browser', providers: [] })
  mocks.transcribe.mockResolvedValue({ text: '  recognized   words  ' })
  mocks.startLocal.mockResolvedValue({ sessionId: 'local-session' })
  mocks.pushLocal.mockResolvedValue({ text: 'local words' })
  mocks.finishLocal.mockResolvedValue({ text: 'local final words' })
  mocks.cancelLocal.mockResolvedValue({ success: true })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})

describe('composer voice input on Desktop', () => {
  it('requires a backend provider instead of starting browser speech recognition', async () => {
    const { input } = setupInput()

    await input.start()

    expect(mocks.fetchSettings).toHaveBeenCalledOnce()
    expectNoCaptureStarted()
    expect(input.error.value).toBe('chat.voiceInput.backendSttRequired')
    expect(input.dialogue.status.value).toBe('idle')
    expect(input.dialogue.activeCaptureId.value).toBeNull()
  })

  it('uses the server-selected cloud provider despite a cached browser choice', async () => {
    mocks.fetchSettings.mockResolvedValue(cloudSettings())
    const { input, insertTranscript } = setupInput()
    const audio = new Blob(['wav'], { type: 'audio/wav' })
    pcm.stop.mockResolvedValue(audio)

    await input.start()
    expect(pcm.start).toHaveBeenCalledOnce()
    expect(browser.start).not.toHaveBeenCalled()
    expect(mic.start).not.toHaveBeenCalled()

    await input.stop()
    expect(mocks.transcribe).toHaveBeenCalledWith({ audio, provider: 'groq' })
    expect(insertTranscript).toHaveBeenCalledWith('recognized words')
    expect(input.dialogue.status.value).toBe('idle')
  })

  it.each<FetchSttSettingsResponse>([
    { activeProvider: null, providers: [] },
    { activeProvider: 'openai', providers: [] },
    { activeProvider: 'custom', providers: [{ provider: 'custom', settings: {}, secrets: {}, updatedAt: 1 }] },
  ])('does not record or choose another provider when settings are incomplete: %j', async (settings) => {
    mocks.fetchSettings.mockResolvedValue(settings)
    const { input } = setupInput()

    await input.start()

    expectNoCaptureStarted()
    expect(mocks.transcribe).not.toHaveBeenCalled()
    expect(input.error.value).toBe('chat.voiceInput.backendSttRequired')
  })

  it('opens a local stream before recording even without a stored provider row', async () => {
    mocks.fetchSettings.mockResolvedValue({ activeProvider: 'local', providers: [] })
    const { input, insertTranscript } = setupInput()

    await input.start()
    expect(mocks.startLocal).toHaveBeenCalledOnce()
    expect(local.start).toHaveBeenCalledOnce()
    expect(mocks.startLocal.mock.invocationCallOrder[0]).toBeLessThan(local.start.mock.invocationCallOrder[0])
    expect(browser.start).not.toHaveBeenCalled()
    expect(pcm.start).not.toHaveBeenCalled()

    const chunk = new Blob([new Uint8Array(64)], { type: 'audio/wav' })
    await localChunk(chunk)
    expect(mocks.pushLocal).toHaveBeenCalledWith('local-session', chunk)
    expect(input.transcript.value).toBe('local words')

    await input.stop()
    expect(mocks.finishLocal).toHaveBeenCalledWith('local-session')
    expect(insertTranscript).toHaveBeenCalledWith('local final words')
    expect(mocks.transcribe).not.toHaveBeenCalled()
  })

  it.each(['cancel', 'stop', 'unmount'] as const)('does not start late recording after %s during settings loading', async (action) => {
    let resolveSettings!: (settings: FetchSttSettingsResponse) => void
    mocks.fetchSettings.mockReturnValue(new Promise<FetchSttSettingsResponse>(resolve => { resolveSettings = resolve }))
    const { input } = setupInput()
    const starting = input.start()
    await flushPromises()
    expect(mocks.fetchSettings).toHaveBeenCalledOnce()

    if (action === 'unmount') {
      wrapper!.unmount()
      wrapper = undefined
    } else {
      await input[action]()
    }
    resolveSettings(cloudSettings())
    await starting

    expectNoCaptureStarted()
    expect(input.dialogue.status.value).toBe('idle')
  })

  it('shows settings fetch errors and clears them on a successful retry', async () => {
    mocks.fetchSettings.mockRejectedValueOnce(new Error('Settings unavailable'))
    const { input } = setupInput()

    await input.start()
    expect(input.error.value).toBe('Settings unavailable')
    expect(input.dialogue.status.value).toBe('idle')
    expectNoCaptureStarted()

    mocks.fetchSettings.mockResolvedValue(cloudSettings())
    await input.start()
    expect(input.error.value).toBeNull()
    expect(pcm.start).toHaveBeenCalledOnce()
  })
})

it('keeps normal browser speech recognition without fetching Desktop settings', async () => {
  mocks.desktop.mockReturnValue(false)
  const { input, insertTranscript } = setupInput()
  browser.stop.mockResolvedValue('browser words')

  await input.start()
  expect(mocks.fetchSettings).not.toHaveBeenCalled()
  expect(browser.start).toHaveBeenCalledOnce()
  expect(pcm.start).not.toHaveBeenCalled()
  expect(mic.start).not.toHaveBeenCalled()

  await input.stop()
  expect(insertTranscript).toHaveBeenCalledWith('browser words')
})
