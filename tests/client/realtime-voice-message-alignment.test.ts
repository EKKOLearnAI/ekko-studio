// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick, ref } from 'vue'
import RealtimeVoiceStage from '../../packages/client/src/components/hermes/chat/RealtimeVoiceStage.vue'
import { alignWorkspaceChangeAssistantMessage, useChatStore, type Message } from '../../packages/client/src/stores/hermes/chat'
import { synthesizeSpeech } from '../../packages/client/src/api/studio/tts'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/router', () => ({ default: { push: vi.fn(), replace: vi.fn() } }))
vi.mock('@/stores/hermes/app', () => ({ useAppStore: vi.fn() }))
vi.mock('@/utils/desktop-bridge', () => ({ isDesktopShell: () => false }))
vi.mock('@/utils/device', () => ({ isMobileDevice: () => false }))
vi.mock('@/api/studio/tts', () => ({ isServerTtsProvider: () => true, synthesizeSpeech: vi.fn() }))
vi.mock('@/composables/useVoiceSettings', () => ({ useVoiceSettings: () => ({
  provider: ref('edge'), edgeUrl: ref(''), edgeVoice: ref('test'), edgeRate: ref(1), edgePitchHz: ref(0),
}) }))
vi.mock('@/composables/useSpeech', () => ({ useGlobalSpeech: () => ({
  stop: vi.fn(), isPlaying: ref(false), isCustomPlaying: ref(false), isSupported: ref(false),
}) }))
vi.mock('@/composables/useBrowserSpeechRecognition', () => ({ useBrowserSpeechRecognition: () => ({
  transcript: ref(''), partialTranscript: ref(''), error: ref(null), cancel: vi.fn(),
}) }))
vi.mock('@/composables/useMicRecorder', () => ({ useMicRecorder: () => ({ cancel: vi.fn() }) }))
vi.mock('@/composables/usePcmStreamRecorder', () => ({ usePcmStreamRecorder: () => ({
  level: ref(0), hasSpeech: ref(false), cancel: vi.fn(),
}) }))

let wrapper: VueWrapper
let chat: ReturnType<typeof useChatStore>
let stage: { submitTranscript: (text: string) => Promise<void>; stopActiveTurn: () => Promise<void> }
const played = vi.fn()
let streaming = true

function assistant(id: string, content: string): Message {
  return { id, role: 'assistant', content, timestamp: Date.now(), isStreaming: true } as Message
}

async function settle() {
  await nextTick()
  await flushPromises()
}

function spoken() {
  return vi.mocked(synthesizeSpeech).mock.calls.map(([request]) => request.text)
}

function align(id: string) {
  const message = chat.messages.at(-1)!
  alignWorkspaceChangeAssistantMessage(chat.messages, { assistant_message_id: id } as Parameters<typeof alignWorkspaceChangeAssistantMessage>[1], message.id)
}

beforeEach(async () => {
  vi.useFakeTimers()
  setActivePinia(createPinia())
  chat = useChatStore()
  chat.activeSession = { id: 'voice-test', messages: [] } as NonNullable<typeof chat.activeSession>
  vi.spyOn(chat, 'sendMessage').mockResolvedValue(undefined)
  vi.spyOn(chat, 'stopStreaming').mockResolvedValue(undefined)
  // Hold only the transport's streaming flag while exercising the actual message store.
  streaming = true
  vi.spyOn(chat, 'isStreaming', 'get').mockImplementation(() => streaming)
  vi.mocked(synthesizeSpeech).mockReset().mockResolvedValue(new Blob(['audio']))
  played.mockReset()
  vi.stubGlobal('Audio', class {
    onended: (() => void) | null = null
    onerror: (() => void) | null = null
    pause() {}
    async play() { played(); queueMicrotask(() => this.onended?.()) }
  })
  vi.stubGlobal('requestAnimationFrame', vi.fn())
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = vi.fn(() => 'blob:voice-test')
    static revokeObjectURL = vi.fn()
  })
  wrapper = mount(RealtimeVoiceStage)
  stage = (wrapper.vm as unknown as { $: { setupState: typeof stage } }).$.setupState
  await stage.submitTranscript('Test prompt')
})

afterEach(() => {
  wrapper?.unmount()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('realtime voice message alignment', () => {
  it('does not replay streamed sentences when terminal metadata aligns the message ID', async () => {
    chat.messages.push(assistant('stream-id', 'First sentence. '))
    await settle()
    chat.messages[0]!.content += 'Second sentence. '
    await settle()
    align('persisted-id')
    streaming = false
    await settle()
    expect(chat.messages[0]!.id).toBe('persisted-id')
    expect(spoken()).toEqual(['First sentence.', 'Second sentence.'])
    expect(played).toHaveBeenCalledTimes(2)
  })

  it('keeps a partial sentence together across ID alignment and later stream deltas', async () => {
    chat.messages.push(assistant('stream-id', 'First sentence. A partial'))
    await settle()
    align('persisted-id')
    await settle()
    chat.messages[0]!.content += ' sentence. '
    await settle()
    expect(spoken()).toEqual(['First sentence.', 'A partial sentence.'])
  })

  it('speaks identical text from distinct assistant messages', async () => {
    chat.messages.push(assistant('first', 'Same sentence. '))
    await settle()
    chat.messages.push(assistant('second', 'Same sentence. '))
    await settle()
    expect(spoken()).toEqual(['Same sentence.', 'Same sentence.'])
  })

  it('speaks identical text again in a new turn', async () => {
    chat.messages.push(assistant('first', 'Same sentence. '))
    await settle()
    await stage.submitTranscript('Repeat it')
    chat.messages.push(assistant('second', 'Same sentence. '))
    await settle()
    expect(spoken()).toEqual(['Same sentence.', 'Same sentence.'])
  })

  it('discards interrupted synthesis and still speaks the next turn', async () => {
    let finish!: (audio: Blob) => void
    vi.mocked(synthesizeSpeech).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    chat.messages.push(assistant('interrupted', 'Same sentence. '))
    await settle()
    await stage.stopActiveTurn()
    finish(new Blob(['stale audio']))
    await settle()
    expect(played).not.toHaveBeenCalled()
    await stage.submitTranscript('Repeat it')
    chat.messages.push(assistant('next-turn', 'Same sentence. '))
    await settle()
    expect(played).toHaveBeenCalledTimes(1)
    expect(spoken()).toEqual(['Same sentence.', 'Same sentence.'])
  })
})
