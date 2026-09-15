// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import ResponseAnnotationSource from '@/components/hermes/chat/ResponseAnnotationSource.vue'
import { useChatAnnotationsStore } from '@/stores/hermes/chat-annotations'
import { responseAnnotationSourceHash, type ResponseAnnotation } from '@/utils/chat-response-annotations'
import { resolveResponseAnnotationRange } from '@/utils/chat-response-annotation-selection'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

const rect = {
  x: 100,
  y: 120,
  left: 100,
  top: 120,
  right: 180,
  bottom: 140,
  width: 80,
  height: 20,
  toJSON: () => ({}),
} as DOMRect

describe('ResponseAnnotationSource', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    localStorage.clear()
    setActivePinia(createPinia())
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: vi.fn(() => rect),
    })
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: vi.fn(() => ({
        0: rect,
        length: 1,
        item: (index: number) => index === 0 ? rect : null,
        [Symbol.iterator]: function* () { yield rect },
      } as DOMRectList)),
    })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      ...rect,
      left: 80,
      top: 100,
      right: 480,
      bottom: 300,
      width: 400,
      height: 200,
    } as DOMRect)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('shows only Add to chat for an eligible selection and creates a numbered draft', async () => {
    const wrapper = mount(ResponseAnnotationSource, {
      attachTo: document.body,
      props: {
        sessionId: 'session-1',
        messageId: 'assistant-1',
        source: 'Alpha Beta Gamma',
        enabled: true,
      },
      slots: {
        default: '<p>Alpha <strong>Beta</strong> Gamma</p>',
      },
    })

    const selected = wrapper.get('strong').element.firstChild!
    const selection = window.getSelection()!
    const range = document.createRange()
    range.setStart(selected, 0)
    range.setEnd(selected, 4)
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    await flushPromises()
    await nextTick()

    const toolbar = document.body.querySelector<HTMLElement>('[role="toolbar"]')
    expect(toolbar).not.toBeNull()
    const actions = Array.from(toolbar!.querySelectorAll('button')).map(button => button.textContent?.trim())
    expect(actions).toEqual(['chat.annotations.addToChat'])
    expect(document.body.textContent).not.toContain('Ask in side chat')

    toolbar!.querySelector('button')!.click()
    await flushPromises()
    await nextTick()

    const store = useChatAnnotationsStore()
    expect(store.annotationsForSession('session-1')).toEqual([
      expect.objectContaining({
        ordinal: 1,
        selectedText: 'Beta',
        sourceMessageId: 'assistant-1',
      }),
    ])
    expect(store.activeEditor?.annotationId).toBe(store.annotationsForSession('session-1')[0].id)
    const marker = wrapper.get('[data-testid="response-annotation-marker"]')
    expect(marker.text()).toBe('1')
    expect(wrapper.find('[data-testid="response-annotation-highlight"]').exists()).toBe(true)

    await marker.trigger('mouseenter')
    await nextTick()
    const preview = document.body.querySelector<HTMLElement>('[data-testid="response-annotation-marker-preview"]')
    expect(preview?.textContent).toContain('Beta')
    expect(marker.attributes('aria-describedby')).toBe(preview?.id)
    await marker.trigger('mouseleave')
    ;(marker.element as HTMLButtonElement).focus()
    await nextTick()
    expect(document.body.querySelector('[data-testid="response-annotation-marker-preview"]')).not.toBeNull()
  })

  it('restores a draft highlight by source hash after optimistic message ids are replaced on reload', async () => {
    const store = useChatAnnotationsStore()
    store.addAnnotation('session-1', {
      id: 'persisted-draft',
      ordinal: 1,
      selectedText: 'Beta',
      comment: null,
      sourceMessageId: 'optimistic-assistant-id',
      sourceHash: responseAnnotationSourceHash('Alpha Beta Gamma'),
      start: 6,
      end: 10,
      prefix: 'Alpha ',
      suffix: ' Gamma',
      files: [],
    })

    const wrapper = mount(ResponseAnnotationSource, {
      attachTo: document.body,
      props: {
        sessionId: 'session-1',
        messageId: '42',
        source: 'Alpha Beta Gamma',
        enabled: true,
      },
      slots: { default: '<p>Alpha Beta Gamma</p>' },
    })
    await flushPromises()
    await nextTick()

    expect(wrapper.find('[data-testid="response-annotation-marker"]').text()).toBe('1')
    expect(wrapper.find('[data-testid="response-annotation-highlight"]').exists()).toBe(true)

    const sourceText = wrapper.get('p').element.firstChild!
    const range = document.createRange()
    range.setStart(sourceText, 6)
    range.setEnd(sourceText, 10)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    await flushPromises()
    document.body.querySelector<HTMLElement>('[role="toolbar"] button')!.click()
    await flushPromises()

    expect(store.annotationsForSession('session-1')).toHaveLength(1)
    expect(store.activeEditor?.annotationId).toBe('persisted-draft')
  })

  it('fails closed when persisted excerpt metadata contradicts the current rendered source', async () => {
    const store = useChatAnnotationsStore()
    store.addAnnotation('session-1', {
      id: 'tampered-draft', ordinal: 1, selectedText: 'Not Beta', comment: null,
      sourceMessageId: 'assistant-1', sourceHash: responseAnnotationSourceHash('Alpha Beta Gamma'),
      start: 6, end: 10, prefix: 'Alpha ', suffix: ' Gamma', files: [],
    })
    const wrapper = mount(ResponseAnnotationSource, {
      attachTo: document.body,
      props: { sessionId: 'session-1', messageId: 'assistant-1', source: 'Alpha Beta Gamma', enabled: true },
      slots: { default: '<p>Alpha Beta Gamma</p>' },
    })
    await flushPromises()
    await nextTick()
    expect(wrapper.find('[data-testid="response-annotation-marker"]').exists()).toBe(false)
  })

  it('does not hash-fallback to an ambiguous duplicate assistant body', async () => {
    const store = useChatAnnotationsStore()
    store.addAnnotation('session-1', {
      id: 'ambiguous-draft', ordinal: 1, selectedText: 'Beta', comment: null,
      sourceMessageId: 'old-optimistic-id', sourceHash: responseAnnotationSourceHash('Alpha Beta Gamma'),
      start: 6, end: 10, prefix: 'Alpha ', suffix: ' Gamma', files: [],
    })
    const first = mount(ResponseAnnotationSource, {
      attachTo: document.body,
      props: { sessionId: 'session-1', messageId: '41', source: 'Alpha Beta Gamma', enabled: true },
      slots: { default: '<p>Alpha Beta Gamma</p>' },
    })
    const second = mount(ResponseAnnotationSource, {
      attachTo: document.body,
      props: { sessionId: 'session-1', messageId: '42', source: 'Alpha Beta Gamma', enabled: true },
      slots: { default: '<p>Alpha Beta Gamma</p>' },
    })
    await flushPromises()
    await nextTick()
    expect(first.find('[data-testid="response-annotation-marker"]').exists()).toBe(false)
    expect(second.find('[data-testid="response-annotation-marker"]').exists()).toBe(false)
  })

  it('dismisses a stale toolbar when selection moves to another assistant response', async () => {
    const first = mount(ResponseAnnotationSource, {
      attachTo: document.body,
      props: { sessionId: 'session-1', messageId: 'assistant-1', source: 'First response', enabled: true },
      slots: { default: '<p>First response</p>' },
    })
    const second = mount(ResponseAnnotationSource, {
      attachTo: document.body,
      props: { sessionId: 'session-1', messageId: 'assistant-2', source: 'Second response', enabled: true },
      slots: { default: '<p>Second response</p>' },
    })

    const selectNode = async (node: Node) => {
      const range = document.createRange()
      range.selectNodeContents(node)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      await flushPromises()
      await nextTick()
    }

    await selectNode(first.get('p').element.firstChild!)
    expect(document.body.querySelectorAll('[role="toolbar"]')).toHaveLength(1)

    await selectNode(second.get('p').element.firstChild!)
    const toolbars = document.body.querySelectorAll<HTMLElement>('[role="toolbar"]')
    expect(toolbars).toHaveLength(1)
    toolbars[0].querySelector('button')!.click()
    await flushPromises()
    await nextTick()
    expect(useChatAnnotationsStore().annotationsForSession('session-1')).toEqual([
      expect.objectContaining({ sourceMessageId: 'assistant-2', selectedText: 'Second response' }),
    ])
    first.unmount()
    second.unmount()
  })

  it('repositions an open selection toolbar on scroll and dismisses it outside the viewport', async () => {
    let selectionRect = rect
    vi.mocked(Range.prototype.getBoundingClientRect).mockImplementation(() => selectionRect)
    const wrapper = mount(ResponseAnnotationSource, {
      attachTo: document.body,
      props: { sessionId: 'session-1', messageId: 'assistant-toolbar', source: 'Toolbar source', enabled: true },
      slots: { default: '<p>Toolbar source</p>' },
    })
    const range = document.createRange()
    range.selectNodeContents(wrapper.get('p').element.firstChild!)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    await nextTick()

    const toolbar = document.body.querySelector<HTMLElement>('[role="toolbar"]')!
    expect(toolbar.style.left).toBe('82px')
    selectionRect = { ...rect, left: 200, right: 280, top: 220, bottom: 240 } as DOMRect
    document.dispatchEvent(new Event('scroll', { bubbles: true }))
    await nextTick()
    expect(toolbar.style.left).toBe('182px')
    expect(toolbar.style.top).toBe('174px')

    selectionRect = { ...rect, left: 200, right: 280, top: -80, bottom: -60 } as DOMRect
    window.dispatchEvent(new Event('resize'))
    await nextTick()
    expect(document.body.querySelector('[role="toolbar"]')).toBeNull()
    wrapper.unmount()
  })

  it('opens the editor for the new source when identical responses share a range', async () => {
    const first = mount(ResponseAnnotationSource, {
      attachTo: document.body,
      props: { sessionId: 'session-1', messageId: 'assistant-1', source: 'Same response', enabled: true },
      slots: { default: '<p>Same response</p>' },
    })
    const second = mount(ResponseAnnotationSource, {
      attachTo: document.body,
      props: { sessionId: 'session-1', messageId: 'assistant-2', source: 'Same response', enabled: true },
      slots: { default: '<p>Same response</p>' },
    })
    const selectAndAdd = async (node: Node) => {
      const range = document.createRange()
      range.selectNodeContents(node)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      await flushPromises()
      document.body.querySelector<HTMLElement>('[role="toolbar"] button')!.click()
      await flushPromises()
      await nextTick()
    }

    await selectAndAdd(first.get('p').element.firstChild!)
    await selectAndAdd(second.get('p').element.firstChild!)

    const store = useChatAnnotationsStore()
    expect(store.annotationsForSession('session-1')).toHaveLength(2)
    const secondAnnotation = store.annotationsForSession('session-1')
      .find((annotation: ResponseAnnotation) => annotation.sourceMessageId === 'assistant-2')
    expect(store.activeEditor?.annotationId).toBe(secondAnnotation?.id)
    first.unmount()
    second.unmount()
  })

  it('restores a persisted marker after async markdown content populates the source', async () => {
    const store = useChatAnnotationsStore()
    store.addAnnotation('session-1', {
      id: 'async-draft', ordinal: 1, selectedText: 'Beta', comment: null,
      sourceMessageId: 'assistant-async', sourceHash: responseAnnotationSourceHash('Alpha Beta'),
      start: 6, end: 10, prefix: 'Alpha ', suffix: '', files: [],
    })
    const wrapper = mount(ResponseAnnotationSource, {
      attachTo: document.body,
      props: { sessionId: 'session-1', messageId: 'assistant-async', source: 'Alpha Beta', enabled: true },
      slots: { default: '<p data-testid="async-markdown"></p>' },
    })
    await flushPromises()
    expect(wrapper.find('[data-testid="response-annotation-marker"]').exists()).toBe(false)

    wrapper.get('[data-testid="async-markdown"]').element.textContent = 'Alpha Beta'
    await new Promise(resolve => window.setTimeout(resolve, 0))
    await flushPromises()
    await nextTick()

    expect(wrapper.find('[data-testid="response-annotation-marker"]').text()).toBe('1')
    wrapper.unmount()
  })

  it('skips layout work on scroll when a source has no visible annotations', async () => {
    const wrapper = mount(ResponseAnnotationSource, {
      attachTo: document.body,
      props: { sessionId: 'session-1', messageId: 'assistant-empty', source: 'No annotations', enabled: true },
      slots: { default: '<p>No annotations</p>' },
    })
    await flushPromises()
    await nextTick()
    const rectSpy = vi.mocked(HTMLElement.prototype.getBoundingClientRect)
    rectSpy.mockClear()

    document.dispatchEvent(new Event('scroll', { bubbles: true }))
    document.dispatchEvent(new Event('scroll', { bubbles: true }))
    await nextTick()

    expect(rectSpy).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('does not offer annotations while the assistant response is unstable', async () => {
    const wrapper = mount(ResponseAnnotationSource, {
      attachTo: document.body,
      props: {
        sessionId: 'session-1',
        messageId: 'assistant-streaming',
        source: 'Still streaming',
        enabled: false,
      },
      slots: { default: '<p>Still streaming</p>' },
    })
    const node = wrapper.get('p').element.firstChild!
    const range = document.createRange()
    range.selectNodeContents(node)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    await nextTick()

    expect(document.body.querySelector('[role="toolbar"]')).toBeNull()
    expect(useChatAnnotationsStore().annotationsForSession('session-1')).toEqual([])
  })

  it('emits feedback instead of silently dropping an oversized selection', async () => {
    const oversized = 'x'.repeat(4_001)
    const annotationError = vi.fn()
    const wrapper = mount(ResponseAnnotationSource, {
      attachTo: document.body,
      props: { sessionId: 'session-1', messageId: 'assistant-large', source: oversized, enabled: true },
      attrs: { onAnnotationError: annotationError },
      slots: { default: `<p>${oversized}</p>` },
    })
    await nextTick()
    const text = wrapper.get('p').element.firstChild!
    const selection = window.getSelection()!
    const warmup = document.createRange()
    warmup.setStart(text, 0)
    warmup.setEnd(text, 4)
    selection.removeAllRanges()
    selection.addRange(warmup)
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    await nextTick()
    expect(document.body.querySelector('[role="toolbar"]')).not.toBeNull()

    const range = document.createRange()
    range.selectNodeContents(text)
    selection.removeAllRanges()
    selection.addRange(range)
    expect(selection.isCollapsed).toBe(false)
    expect(selection.toString().length).toBe(4_001)
    expect(resolveResponseAnnotationRange(
      wrapper.get('.response-annotation-source').element as HTMLElement,
      range,
    )?.selectedText.length).toBe(4_001)
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    await nextTick()
    expect(annotationError).toHaveBeenCalledWith('selected_text_too_long')
    expect(document.body.querySelector('[role="toolbar"]')).toBeNull()
    wrapper.unmount()
  })
})
