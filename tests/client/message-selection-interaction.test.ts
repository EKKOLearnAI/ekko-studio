// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, effectScope, nextTick, reactive } from 'vue'

const mocks = vi.hoisted(() => ({ store: null as any, fetch: vi.fn(), success: vi.fn(), error: vi.fn() }))
vi.mock('@/stores/hermes/chat', () => ({ useChatStore: () => mocks.store }))
vi.mock('@/api/studio/sessions', () => ({ fetchMessageSelection: mocks.fetch }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('naive-ui', () => ({ useMessage: () => ({ success: mocks.success, error: mocks.error }) }))
import { useMessageSelection } from '@/components/hermes/chat/useMessageSelection'

describe('message selection and compression state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.store = reactive({
      activeSessionId: 's', activeSession: { id: 's', source: 'cli', agent: 'hermes', profile: 'default' },
      isLoadingMessages: false, focusMessageId: null, isSessionWorking: () => false,
      compressionState: { compressing: false, compressed: true, beforeTokens: 1200, afterTokens: 400 },
      refreshActiveSession: vi.fn(async () => true),
      deleteMessages: vi.fn(async () => ({ deletedGroups: 1 })),
      messages: [
        { id: '1', role: 'user' }, { id: '2', role: 'assistant' },
        { id: '3', role: 'user' }, { id: '4', role: 'assistant' },
      ],
    })
    mocks.fetch.mockResolvedValue({ historyRevision: 0, groups: [
      { id: 1, kind: 'message', messageIds: [1], deleteBlockedReason: 'compressed' },
      { id: 2, kind: 'run', messageIds: [2], deleteBlockedReason: 'compressed' },
      { id: 3, kind: 'message', messageIds: [3] },
      { id: 4, kind: 'run', messageIds: [4] },
    ] })
  })

  it('leaves compression untouched when entering, checking, cancelling and deleting; locked groups cannot be selected', async () => {
    const scope = effectScope()
    const selection = scope.run(() => useMessageSelection(computed(() => mocks.store.messages)))!
    const compression = mocks.store.compressionState
    try {
      await selection.start()
      selection.toggle(2, true)
      expect(selection.selected.value.size).toBe(0)
      selection.toggle(3, true)
      selection.toggle(4, true)
      expect([...selection.selected.value]).toEqual([3, 4])
      selection.cancel()
      expect(mocks.store.compressionState).toBe(compression)
      await selection.start()
      selection.toggle(4, true)
      await selection.remove()
      expect(mocks.store.deleteMessages).toHaveBeenCalledWith('s', [4], 0)
      expect(mocks.store.compressionState).toBe(compression)
      expect(compression.compressed).toBe(true)
    } finally { scope.stop() }
  })

  it('cancels stale selection when compression starts and blocks a new selection', async () => {
    const scope = effectScope()
    const selection = scope.run(() => useMessageSelection(computed(() => mocks.store.messages)))!
    try {
      await selection.start()
      selection.toggle(4, true)
      mocks.store.compressionState.compressing = true
      await nextTick()
      expect(selection.selecting.value).toBe(false)
      expect(selection.selected.value.size).toBe(0)
      await selection.start()
      expect(mocks.fetch).toHaveBeenCalledTimes(1)
    } finally { scope.stop() }
  })

  it('keeps the selection when the temporary successful compression indicator expires', async () => {
    const scope = effectScope()
    const selection = scope.run(() => useMessageSelection(computed(() => mocks.store.messages)))!
    try {
      await selection.start()
      selection.toggle(4, true)
      mocks.store.compressionState = null
      await nextTick()
      expect(selection.selecting.value).toBe(true)
      expect([...selection.selected.value]).toEqual([4])
    } finally { scope.stop() }
  })

  it.each(['working', 'aborting', 'queued'])('blocks selection and cancels it immediately while %s', async phase => {
    mocks.store.working = false
    mocks.store.isSessionWorking = () => mocks.store.working
    mocks.store.isAborting = false
    mocks.store.queueLengths = new Map()
    const scope = effectScope()
    const selection = scope.run(() => useMessageSelection(computed(() => mocks.store.messages)))!
    try {
      await selection.start()
      selection.toggle(4, true)
      if (phase === 'working') mocks.store.working = true
      if (phase === 'aborting') mocks.store.isAborting = true
      if (phase === 'queued') mocks.store.queueLengths.set('s', 1)
      expect(selection.selecting.value).toBe(false)
      expect(selection.selected.value.size).toBe(0)
      await selection.start()
      selection.toggle(4, true)
      await selection.remove()
      expect(mocks.fetch).toHaveBeenCalledTimes(1)
      expect(selection.selected.value.size).toBe(0)
      expect(mocks.store.deleteMessages).not.toHaveBeenCalled()
    } finally { scope.stop() }
  })

  it('discards selection reads if a run starts and finishes before the response arrives', async () => {
    mocks.store.working = false
    mocks.store.isSessionWorking = () => mocks.store.working
    const result = await mocks.fetch()
    let resolve!: (value: any) => void
    mocks.fetch.mockReturnValueOnce(new Promise(done => { resolve = done }))
    const scope = effectScope()
    const selection = scope.run(() => useMessageSelection(computed(() => mocks.store.messages)))!
    try {
      const pending = selection.start()
      await nextTick()
      mocks.store.working = true
      mocks.store.working = false
      resolve(result)
      await pending
      expect(selection.selecting.value).toBe(false)
    } finally { scope.stop() }
  })
})
