// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatAnnotationsStore } from '@/stores/hermes/chat-annotations'
import { responseAnnotationSourceHash, type ResponseAnnotation } from '@/utils/chat-response-annotations'

function annotation(id: string, start: number): ResponseAnnotation {
  const selectedText = `excerpt ${id}`
  return {
    id,
    ordinal: 99,
    selectedText,
    comment: null,
    sourceMessageId: 'assistant-1',
    sourceHash: responseAnnotationSourceHash('assistant body'),
    start,
    end: start + selectedText.length,
    prefix: 'before',
    suffix: 'after',
    files: [],
  }
}

describe('chat annotation store', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('keeps ordered per-session drafts, deduplicates ranges, and renumbers after delete', () => {
    const store = useChatAnnotationsStore()

    expect(store.addAnnotation('session-1', annotation('a-1', 0))).toBeNull()
    const second = annotation('a-2', 8)
    expect(store.addAnnotation('session-1', second)).toBeNull()
    expect(store.addAnnotation('session-1', { ...second, id: 'duplicate' })).toBe('duplicate')
    expect(store.annotationsForSession('session-1').map(item => [item.id, item.ordinal])).toEqual([
      ['a-1', 1],
      ['a-2', 2],
    ])

    store.removeAnnotation('session-1', 'a-1')
    expect(store.annotationsForSession('session-1').map(item => [item.id, item.ordinal])).toEqual([
      ['a-2', 1],
    ])
  })

  it('persists excerpt/comment metadata and restores it in a fresh store', () => {
    const store = useChatAnnotationsStore()
    store.addAnnotation('session-1', annotation('a-1', 0))
    store.updateAnnotation('session-1', 'a-1', { comment: 'Why this line?' })

    setActivePinia(createPinia())
    const restored = useChatAnnotationsStore()
    restored.hydrateSession('session-1')

    expect(restored.annotationsForSession('session-1')).toEqual([
      expect.objectContaining({ id: 'a-1', ordinal: 1, comment: 'Why this line?' }),
    ])
  })

  it('preserves drafts for sessions that have not been explicitly hydrated yet', () => {
    const firstStore = useChatAnnotationsStore()
    firstStore.addAnnotation('session-a', annotation('a-1', 0))
    firstStore.addAnnotation('session-b', annotation('b-1', 20))

    setActivePinia(createPinia())
    const reloaded = useChatAnnotationsStore()
    reloaded.hydrateSession('session-a')
    reloaded.updateAnnotation('session-a', 'a-1', { comment: 'updated after reload' })

    setActivePinia(createPinia())
    const verified = useChatAnnotationsStore()
    expect(verified.annotationsForSession('session-b')).toEqual([
      expect.objectContaining({ id: 'b-1' }),
    ])
  })

  it('tracks one inspected immutable sent set without mutating drafts', () => {
    const store = useChatAnnotationsStore()
    const sent = [annotation('sent-1', 2)]

    store.inspectSentAnnotations('session-1', 'user-2', sent)
    expect(store.inspectedSentAnnotations).toEqual(sent.map(item => ({ ...item, ordinal: 1 })))
    expect(store.inspectedSentMessageId).toBe('user-2')
    expect(store.annotationsForSession('session-1')).toEqual([])

    store.clearInspectedSentAnnotations('user-2')
    expect(store.inspectedSentAnnotations).toEqual([])
  })

  it('tracks the active annotation editor and its viewport anchor', () => {
    const store = useChatAnnotationsStore()
    store.addAnnotation('session-1', annotation('a-1', 0))
    const anchor = { left: 20, top: 30, right: 60, bottom: 50, width: 40, height: 20 }

    store.openEditor('session-1', 'a-1', anchor)
    expect(store.activeEditor).toEqual({ sessionId: 'session-1', annotationId: 'a-1', anchor })

    store.closeEditor()
    expect(store.activeEditor).toBeNull()
  })

  it('owns pending files per annotation and removes them with the draft', () => {
    const store = useChatAnnotationsStore()
    store.addAnnotation('session-1', annotation('a-1', 0))
    const proof = new File(['proof'], 'proof.txt', { type: 'text/plain' })

    expect(store.addPendingFiles('session-1', 'a-1', [proof])).toBeNull()
    expect(store.pendingFilesForAnnotation('a-1')).toEqual([proof])

    store.removeAnnotation('session-1', 'a-1')
    expect(store.pendingFilesForAnnotation('a-1')).toEqual([])
  })
})
