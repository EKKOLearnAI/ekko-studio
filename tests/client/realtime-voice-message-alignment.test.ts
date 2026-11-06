// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { computed, h, nextTick, ref } from 'vue'
import ToolRunSummary from '../../packages/client/src/components/hermes/chat/ToolRunSummary.vue'
import { groupCompletedToolsByRun } from '../../packages/client/src/components/hermes/chat/tool-run-grouping'
import RealtimeVoiceStage from '../../packages/client/src/components/hermes/chat/RealtimeVoiceStage.vue'
import { alignWorkspaceChangeAssistantMessage, useChatStore, type Message } from '../../packages/client/src/stores/hermes/chat'
import { synthesizeSpeech } from '../../packages/client/src/api/studio/tts'
import type { RunEvent } from '../../packages/client/src/api/studio/chat'

const transport = vi.hoisted(() => ({ start: vi.fn(), resume: vi.fn(), register: vi.fn() }))
const history = vi.hoisted(() => ({ page: vi.fn() }))
vi.mock('@/api/studio/sessions', () => ({ fetchSessionMessagesPage: history.page }))
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

function snapshot() {
  const messages = chat.messages.map(message => ({
    id: message.id, role: message.role, content: message.content, timestamp: message.timestamp / 1000,
  }))
  return { session: { id: sid }, messages, total: messages.length, hasMore: false }
}

function audioResult() {
  return { audio: new Blob(['audio']), engine: 'edge', provider: 'edge' }
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
  vi.mocked(synthesizeSpeech).mockReset().mockResolvedValue(audioResult())
  played.mockReset()
  vi.stubGlobal('Audio', class {
    onended: (() => void) | null = null
    onerror: (() => void) | null = null
    pause() {}
    async play() { played(); queueMicrotask(() => this.onended?.()) }
  })
  vi.stubGlobal('requestAnimationFrame', vi.fn())
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = vi.fn((audio: Blob) => {
      expect(audio).toBeInstanceOf(Blob)
      return 'blob:voice-test'
    })
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
  it.each([false, true])('keeps a pending sentence through reconnect (pending synthesis: %s)', async pending => {
    let finish: ((audio: ReturnType<typeof audioResult>) => void) | undefined
    if (pending) vi.mocked(synthesizeSpeech).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    event('message.delta', { delta: 'First sentence. A partial' })
    event('workspace.diff.completed', { change: { assistant_message_id: 'persisted-id' } })
    await settle()
    const previous = chat.messages.at(-1)!
    const data = snapshot()
    const options = transport.start.mock.calls[0]![5]
    options.onReconnectResume({ session_id: sid, ...data, isWorking: true, events: [] })
    await settle()
    expect(chat.messages.at(-1)).not.toBe(previous)
    expect(spoken()).toEqual(['First sentence.'])
    event('message.delta', { delta: ' sentence without punctuation' })
    await settle()
    complete()
    await settle()
    finish?.(audioResult())
    await settle()
    expect(spoken()).toEqual(['First sentence.', 'A partial sentence without punctuation'])
    expect(played).toHaveBeenCalledTimes(2)
  })

  it('does not replay after a foreground refresh while completed audio is pending', async () => {
    let finish!: (audio: ReturnType<typeof audioResult>) => void
    vi.mocked(synthesizeSpeech).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    event('message.delta', { delta: 'First sentence. Tail' })
    await settle()
    complete()
    await settle()
    history.page.mockResolvedValueOnce(snapshot())
    await chat.refreshActiveSession()
    event('workspace.diff.completed', { change: { assistant_message_id: 'later-persisted-id' } })
    await settle()
    finish(audioResult())
    await settle()
    expect(spoken()).toEqual(['First sentence.', 'Tail'])
    expect(played).toHaveBeenCalledTimes(2)
  })

  it('ignores older replies prepended during the voice turn', async () => {
    event('message.delta', { delta: 'Current sentence. A partial' })
    await settle()
    chat.activeSession!.hasMoreBefore = true
    chat.activeSession!.loadedMessageCount = chat.messages.length
    history.page.mockResolvedValueOnce({
      messages: [{ id: 'older-reply', role: 'assistant', content: 'Historical sentence. ', timestamp: 1 }],
      total: chat.messages.length + 1, hasMore: false,
    })
    expect(await chat.loadOlderMessages(sid)).toBe(true)
    await settle()
    expect(spoken()).toEqual(['Current sentence.'])
    event('message.delta', { delta: ' sentence' })
    complete()
    await settle()
    expect(spoken()).toEqual(['Current sentence.', 'A partial sentence'])
  })

  it('reactively renders ordinary chat completion without a voice subscriber', async () => {
    wrapper.unmount()
    wrapper = mount({ setup: () => () => h('output', chat.messages.map(m => `${m.role}:${m.content}:${!!m.isStreaming}`).join('|')) })
    event('message.delta', { delta: 'Visible reply' })
    await settle()
    const reply = chat.messages.at(-1)!
    expect(wrapper.text()).toContain('assistant:Visible reply:true')
    complete({ parsed_content: 'Visible reply with final content', parsed_reasoning: 'Final reasoning' })
    await settle()
    expect(wrapper.text()).toContain('assistant:Visible reply with final content:false')
    expect(reply.content).toBe('Visible reply with final content')
    expect(reply.reasoning).toBe('Final reasoning')
    expect(chat.messages.at(-1)).toBe(reply)
    expect(spoken()).toEqual([])
  })

  it.each(['tool.completed', 'tool.failed'] as const)('reactively settles and groups a tool on %s without changing historical rows', async terminal => {
    wrapper.unmount()
    const historical: Message = { id: 'old-tool', role: 'tool', content: '', timestamp: 1,
      toolName: 'read_file', toolCallId: 'tool-id', runMarker: 'old-run', toolStatus: 'done', toolResult: 'old result' }
    chat.messages.unshift(historical)
    const savedHistory = structuredClone(historical)
    const tools = computed(() => chat.messages.filter(m => m.role === 'tool' && m.runMarker === 'test-run'))
    wrapper = mount({ setup: () => () => h(ToolRunSummary, { runId: 'test-run', tools: tools.value, active: tools.value.some(m => m.toolStatus === 'running') }) })
    event('tool.started', { tool: 'read_file', tool_call_id: 'tool-id', arguments: { path: '/fixture' } })
    await settle()
    const tool = tools.value[0]!
    expect(wrapper.find('[aria-busy]').exists()).toBe(true)
    event('tool.started', { tool: 'read_file', tool_call_id: 'tool-id', preview: 'Reading fixture' })
    event(terminal, { tool: 'read_file', tool_call_id: 'tool-id', result: 'new result', error: terminal === 'tool.failed' ? 'failed' : undefined })
    await settle()
    expect(tools.value).toHaveLength(1)
    expect(tools.value[0]).toBe(tool)
    expect(tool.toolStatus).toBe(terminal === 'tool.failed' ? 'error' : 'done')
    expect(tool.toolResult).toBe('new result')
    expect(tool.toolArgs).toEqual({ path: '/fixture' })
    expect(wrapper.find('[aria-busy]').exists()).toBe(false)
    expect(wrapper.find(terminal === 'tool.failed' ? '.tool-run-error' : '.tool-run-success').exists()).toBe(true)
    expect(groupCompletedToolsByRun(chat.messages).find(m => m.toolRunId === 'test-run')?.toolMessages).toEqual([tool])
    expect(chat.messages[0]).toEqual(savedHistory)
  })

  it('updates a subagent row and telemetry without speaking its private output', async () => {
    event('message.delta', { delta: 'Parent sentence. ' })
    await settle()
    event('subagent.start', { subagent_id: 'worker', goal: 'Inspect fixture', task_index: 0, task_count: 1 })
    await settle()
    const row = chat.messages.find(m => m.toolCallId === 'subagent:worker')!
    expect(row.toolStatus).toBe('running')
    event('subagent.text', { subagent_id: 'worker', text: 'Private worker answer.' })
    event('subagent.complete', { subagent_id: 'worker', status: 'completed', summary: 'Fixture checked' })
    await settle()
    expect(chat.messages.find(m => m.toolCallId === 'subagent:worker')).toBe(row)
    expect(row.toolStatus).toBe('done')
    expect(row.toolResult).toContain('Fixture checked')
    expect(chat.getSubagentStream(sid, 'worker')?.status).toBe('completed')
    expect(spoken()).toEqual(['Parent sentence.'])
    complete()
    await settle()
    expect(spoken()).toEqual(['Parent sentence.'])
  })

  it('updates MoA reference/aggregation rows and speaks only the parent answer', async () => {
    event('moa.reference', { index: 0, model: 'reference', text: 'Private reference.' })
    await settle()
    const reference = chat.messages.find(m => m.toolName === 'moa_reference')!
    event('moa.reference', { index: 0, model: 'reference', text: 'Updated private reference.' })
    event('moa.aggregating', { aggregator: 'first' })
    await settle()
    const aggregation = chat.messages.find(m => m.toolName === 'moa_aggregating')!
    event('moa.aggregating', { aggregator: 'final' })
    await settle()
    expect(chat.messages.find(m => m.toolName === 'moa_reference')).toBe(reference)
    expect(reference.toolResult).toBe('Updated private reference.')
    expect(chat.messages.find(m => m.toolName === 'moa_aggregating')).toBe(aggregation)
    expect(aggregation.toolArgs).toEqual({ aggregator: 'final' })
    event('message.delta', { delta: 'Aggregated sentence. ' })
    complete()
    await settle()
    expect(chat.messages.find(m => m.toolName === 'moa_aggregating')!.toolStatus).toBe('done')
    expect(spoken()).toEqual(['Aggregated sentence.'])
  })

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
    let finish!: (audio: ReturnType<typeof audioResult>) => void
    vi.mocked(synthesizeSpeech).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    event('message.delta', { delta: 'First sentence. Tail' })
    await settle()
    complete()
    await settle()
    expect(spoken()).toEqual(['First sentence.', 'Tail'])
    expect(played).not.toHaveBeenCalled()
    finish(audioResult())
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
    let finish!: (audio: ReturnType<typeof audioResult>) => void
    vi.mocked(synthesizeSpeech).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    chat.messages.push(assistant('interrupted', 'Same sentence. '))
    await settle()
    await stage.stopActiveTurn()
    event('abort.completed')
    finish(audioResult())
    await settle()
    expect(played).not.toHaveBeenCalled()
    await stage.submitTranscript('Repeat it')
    chat.messages.push(assistant('next-turn', 'Same sentence. '))
    await settle()
    expect(played).toHaveBeenCalledTimes(1)
    expect(spoken()).toEqual(['Same sentence.', 'Same sentence.'])
  })
})
