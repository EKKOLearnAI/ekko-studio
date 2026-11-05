// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick, ref } from 'vue'
import RealtimeVoiceStage from '../../packages/client/src/components/hermes/chat/RealtimeVoiceStage.vue'
import { alignWorkspaceChangeAssistantMessage, useChatStore, type Message } from '../../packages/client/src/stores/hermes/chat'
import { synthesizeSpeech } from '../../packages/client/src/api/studio/tts'
import type { RunEvent } from '../../packages/client/src/api/studio/chat'

const transport = vi.hoisted(() => ({ start: vi.fn(), resume: vi.fn(), register: vi.fn() }))
vi.mock('@/api/studio/chat', () => ({
  startRunViaSocket: transport.start, resumeSession: transport.resume, registerSessionHandlers: transport.register,
  unregisterSessionHandlers: vi.fn(), getChatRunSocket: vi.fn(() => ({ emit: vi.fn() })),
  onUnobservedRunStarted: vi.fn(() => vi.fn()), onPeerUserMessage: vi.fn(() => vi.fn()), onSessionCommand: vi.fn(() => vi.fn()),
  onSessionTitleUpdated: vi.fn(() => vi.fn()), onSessionWorkspaceUpdated: vi.fn(() => vi.fn()),
  onSessionSettingsUpdated: vi.fn(() => vi.fn()), onRunUsageUpdated: vi.fn(() => vi.fn()),
  respondToolApproval: vi.fn(), respondClarify: vi.fn(),
}))
vi.mock('@/api/client', () => ({ getActiveProfileName: () => 'default' }))
vi.mock('@/api/studio/background-status', () => ({ observeBackgroundStatus: () => vi.fn() }))
vi.mock('@/stores/hermes/profiles', () => ({ useProfilesStore: () => ({ activeProfileName: 'default' }) }))
vi.mock('@/stores/hermes/settings', () => ({ useSettingsStore: () => ({ display: {} }) }))
vi.mock('@/utils/completion-sound', () => ({ primeCompletionSound: vi.fn(), playCompletionSound: vi.fn() }))
vi.mock('@/utils/completion-notification', () => ({ showCompletionNotification: vi.fn() }))

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/router', () => ({ default: { push: vi.fn(), replace: vi.fn() } }))
vi.mock('@/stores/hermes/app', () => ({ useAppStore: () => ({
  waitForModelsForRun: async () => {}, selectedModel: 'test', selectedProvider: 'test', modelGroups: [], profileModelGroups: [],
}) }))
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
const sid = 'voice-test'
let onEvent: (event: RunEvent) => void

function event(name: string, data: Record<string, unknown> = {}) {
  onEvent({ event: name, session_id: sid, run_id: 'test-run', ...data } as RunEvent)
}

function complete(data: Record<string, unknown> = {}) {
  event('run.completed', {
    run_usage: { runId: 'test-run', assistantMessageId: 'persisted-id' },
    ...data,
  })
}

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
  vi.clearAllMocks()
  localStorage.clear()
  setActivePinia(createPinia())
  chat = useChatStore()
  const session = { id: sid, profile: 'default', source: 'cli', agent: 'hermes', messages: [], messageCount: 1 } as NonNullable<typeof chat.activeSession>
  chat.sessions = [session]
  chat.activeSession = session
  chat.activeSessionId = sid
  transport.start.mockReturnValue({ abort: vi.fn() })
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network request') }))
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
  expect(transport.start).toHaveBeenCalledOnce()
  onEvent = transport.start.mock.calls[0]![1]
  event('run.started')
  expect(chat.isStreaming).toBe(true)
})

afterEach(() => {
  wrapper?.unmount()
  chat.$dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('realtime voice message alignment', () => {
  it.each(['usage', 'workspace', 'task-return'] as const)('does not replay through the real run.completed handler (%s metadata)', async (metadata) => {
    event('message.delta', { delta: 'First sentence. ' })
    await settle()
    event('message.delta', { delta: 'Second sentence. Tail without punctuation' })
    await settle()
    expect(spoken()).toEqual(['First sentence.', 'Second sentence.'])

    const payload = metadata === 'usage'
      ? { run_usage: { runId: 'test-run', assistantMessageId: 'persisted-id' } }
      : metadata === 'workspace'
        ? { workspace_run_change: { assistant_message_id: 'persisted-id' } }
        : { person_task_return: { assistantMessageId: 'persisted-id' } }
    event('run.completed', payload)
    await settle()
    expect(chat.isStreaming).toBe(false)
    expect(chat.messages.at(-1)!.id).toBe('persisted-id')
    expect(chat.messages.at(-1)!.isStreaming).toBe(false)
    expect(spoken()).toEqual(['First sentence.', 'Second sentence.', 'Tail without punctuation'])
    expect(played).toHaveBeenCalledTimes(3)
  })

  it.each(['alignment-first', 'delta-first', 'same-tick'] as const)('keeps the pending sentence intact for %s event ordering', async (order) => {
    event('message.delta', { delta: 'First sentence. A partial' })
    await settle()
    const alignEvent = () => event('workspace.diff.completed', { change: { assistant_message_id: 'persisted-id' } })
    if (order === 'delta-first') {
      event('message.delta', { delta: ' sentence' })
      await settle()
      alignEvent()
    } else {
      alignEvent()
      if (order === 'alignment-first') {
        await settle()
        expect(spoken()).toEqual(['First sentence.'])
      }
      event('message.delta', { delta: ' sentence' })
    }
    await settle()
    expect(chat.isStreaming).toBe(true)
    expect(spoken()).toEqual(['First sentence.'])
    event('message.delta', { delta: '. ' })
    await settle()
    expect(spoken()).toEqual(['First sentence.', 'A partial sentence.'])
    complete()
    await settle()
    expect(spoken()).toEqual(['First sentence.', 'A partial sentence.'])
    expect(played).toHaveBeenCalledTimes(2)
  })

  it('flushes a partial sentence once at a tool boundary, then speaks a distinct identical reply', async () => {
    event('message.delta', { delta: 'First sentence. A partial' })
    await settle()
    expect(spoken()).toEqual(['First sentence.'])
    event('tool.started', { tool: 'test-tool', tool_call_id: 'tool-1', arguments: {} })
    await settle()
    expect(chat.isStreaming).toBe(true)
    expect(spoken()).toEqual(['First sentence.', 'A partial'])
    event('tool.completed', { tool: 'test-tool', tool_call_id: 'tool-1', result: 'ok' })
    event('message.delta', { delta: 'First sentence. ' })
    await settle()
    complete()
    await settle()
    expect(spoken()).toEqual(['First sentence.', 'A partial', 'First sentence.'])
    expect(played).toHaveBeenCalledTimes(3)
  })

  it('flushes the final suffix once when completion supplies parsed content', async () => {
    event('message.delta', { delta: 'First sentence. A partial' })
    await settle()
    complete({ parsed_content: 'First sentence. A partial sentence without punctuation' })
    await settle()
    expect(spoken()).toEqual(['First sentence.', 'A partial sentence without punctuation'])
    expect(played).toHaveBeenCalledTimes(2)
  })

  it('does not replay on transport completion followed by late ID alignment', async () => {
    event('message.delta', { delta: 'First sentence. Tail' })
    await settle()
    const onDone = transport.start.mock.calls[0]![2] as () => void
    onDone()
    await settle()
    align('persisted-id')
    await settle()
    expect(spoken()).toEqual(['First sentence.', 'Tail'])
    expect(played).toHaveBeenCalledTimes(2)
  })

  it('speaks a response supplied only at completion once', async () => {
    complete({ output: 'Final response without streamed deltas' })
    await settle()
    expect(spoken()).toEqual(['Final response without streamed deltas'])
    expect(played).toHaveBeenCalledOnce()
  })

  it('keeps speech progress through the resumed-run terminal handler', async () => {
    const onDone = transport.start.mock.calls[0]![2] as () => void
    onDone()
    await settle()
    transport.resume.mockImplementation((_id, callback) => callback({
      session_id: sid, messages: [], isWorking: true, events: [],
    }))
    await chat.switchSession(sid)
    expect(transport.register).toHaveBeenCalledOnce()
    const handlers = transport.register.mock.calls[0]![1]
    onEvent = (data) => {
      const handler = {
        'run.started': handlers.onRunStarted,
        'message.delta': handlers.onMessageDelta,
        'workspace.diff.completed': handlers.onWorkspaceDiffCompleted,
        'run.completed': handlers.onRunCompleted,
      }[data.event]
      expect(handler).toBeTypeOf('function')
      handler(data)
    }
    event('run.started')
    event('message.delta', { delta: 'First sentence. A partial' })
    await settle()
    event('workspace.diff.completed', { change: { assistant_message_id: 'persisted-id' } })
    await settle()
    expect(spoken()).toEqual(['First sentence.'])
    event('message.delta', { delta: ' sentence without punctuation' })
    await settle()
    expect(spoken()).toEqual(['First sentence.'])
    complete()
    await settle()
    expect(chat.isStreaming).toBe(false)
    expect(spoken()).toEqual(['First sentence.', 'A partial sentence without punctuation'])
    expect(played).toHaveBeenCalledTimes(2)
  })

  it('does not enqueue a second copy while synthesis is pending at completion', async () => {
    let finish!: (audio: Blob) => void
    vi.mocked(synthesizeSpeech).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    event('message.delta', { delta: 'First sentence. Tail' })
    await settle()
    complete()
    await settle()
    expect(spoken()).toEqual(['First sentence.', 'Tail'])
    expect(played).not.toHaveBeenCalled()
    finish(new Blob(['audio']))
    await settle()
    expect(played).toHaveBeenCalledTimes(2)
    expect(spoken()).toEqual(['First sentence.', 'Tail'])
  })

  it.each(['run.failed', 'abort.completed'])('does not replay earlier sentences on %s', async (terminal) => {
    event('message.delta', { delta: 'First sentence. Tail' })
    await settle()
    expect(spoken()).toEqual(['First sentence.'])
    event(terminal, {
      error: 'Test failure',
      run_usage: { runId: 'test-run', assistantMessageId: 'persisted-id' },
    })
    await settle()
    expect(chat.isStreaming).toBe(false)
    expect(spoken()).toEqual(['First sentence.', 'Tail'])
    expect(played).toHaveBeenCalledTimes(2)
  })

  it('does not replay streamed sentences when terminal metadata aligns the message ID', async () => {
    chat.messages.push(assistant('stream-id', 'First sentence. '))
    await settle()
    chat.messages.at(-1)!.content += 'Second sentence. '
    await settle()
    align('persisted-id')
    const onDone = transport.start.mock.calls[0]![2] as () => void
    onDone()
    await settle()
    expect(chat.messages.at(-1)!.id).toBe('persisted-id')
    expect(spoken()).toEqual(['First sentence.', 'Second sentence.'])
    expect(played).toHaveBeenCalledTimes(2)
  })

  it('keeps a partial sentence together across ID alignment and later stream deltas', async () => {
    chat.messages.push(assistant('stream-id', 'First sentence. A partial'))
    await settle()
    align('persisted-id')
    await settle()
    expect(spoken()).toEqual(['First sentence.'])
    chat.messages.at(-1)!.content += ' sentence. '
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
    event('message.delta', { delta: 'Same sentence. ' })
    await settle()
    complete()
    await settle()
    await stage.submitTranscript('Repeat it')
    event('run.started', { run_id: 'next-run' })
    event('message.delta', { delta: 'Same sentence. ' })
    await settle()
    expect(spoken()).toEqual(['Same sentence.', 'Same sentence.'])
  })

  it('discards interrupted synthesis and still speaks the next turn', async () => {
    let finish!: (audio: Blob) => void
    vi.mocked(synthesizeSpeech).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    chat.messages.push(assistant('interrupted', 'Same sentence. '))
    await settle()
    await stage.stopActiveTurn()
    event('abort.completed')
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
