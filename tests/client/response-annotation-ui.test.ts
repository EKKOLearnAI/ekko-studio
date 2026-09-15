// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import ResponseAnnotationComposer from '@/components/hermes/chat/ResponseAnnotationComposer.vue'
import SentResponseAnnotations from '@/components/hermes/chat/SentResponseAnnotations.vue'
import { useChatAnnotationsStore } from '@/stores/hermes/chat-annotations'
import { responseAnnotationSourceHash, type ResponseAnnotation } from '@/utils/chat-response-annotations'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => params?.count != null ? `${key}:${params.count}` : key,
  }),
}))

function annotation(id = 'annotation-1'): ResponseAnnotation {
  return {
    id,
    ordinal: 1,
    selectedText: 'The exact selected excerpt',
    comment: null,
    sourceMessageId: 'assistant-1',
    sourceHash: responseAnnotationSourceHash('The exact selected excerpt in the answer'),
    start: 0,
    end: 26,
    prefix: '',
    suffix: ' in the answer',
    files: [],
  }
}

describe('response annotation composer and sent evidence', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    localStorage.clear()
    setActivePinia(createPinia())
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('edits an optional comment and owned file, then exposes the ordered composer card', async () => {
    const store = useChatAnnotationsStore()
    store.addAnnotation('session-1', annotation())
    store.openEditor('session-1', 'annotation-1', {
      left: 100, top: 100, right: 140, bottom: 120, width: 40, height: 20,
    })
    const wrapper = mount(ResponseAnnotationComposer, {
      attachTo: document.body,
      props: { sessionId: 'session-1' },
    })
    await nextTick()

    const editor = document.body.querySelector<HTMLElement>('[data-testid="response-annotation-editor"]')!
    const textarea = editor.querySelector<HTMLTextAreaElement>('textarea')!
    expect(document.activeElement).toBe(textarea)
    expect(textarea.placeholder).toBe('chat.annotations.optionalComment')
    textarea.value = 'What does this imply?'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))

    const file = new File(['proof'], 'proof.txt', { type: 'text/plain' })
    const fileInput = editor.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [file] })
    fileInput.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()
    expect(editor.textContent).toContain('proof.txt')

    const save = Array.from(editor.querySelectorAll('button'))
      .find(button => button.textContent?.trim() === 'chat.annotations.save')!
    save.click()
    await flushPromises()

    expect(store.annotationsForSession('session-1')[0].comment).toBe('What does this imply?')
    expect(store.pendingFilesForAnnotation('annotation-1')).toEqual([file])
    expect(store.activeEditor).toBeNull()

    expect(wrapper.get('[data-testid="response-annotation-count"]').text()).toContain('1')
    await wrapper.get('[data-testid="response-annotation-count"]').trigger('click')
    await nextTick()
    const card = document.body.querySelector<HTMLElement>('[data-testid="response-annotation-draft-card"]')!
    expect(card.textContent).toContain('The exact selected excerpt')
    expect(card.textContent).toContain('What does this imply?')
    expect(card.textContent).toContain('proof.txt')
    expect(document.body.textContent).not.toContain('Ask in side chat')
  })

  it('shows bounded details on hover or focus before click opens the ordered list', async () => {
    const store = useChatAnnotationsStore()
    store.addAnnotation('session-1', annotation('annotation-1'))
    store.addAnnotation('session-1', {
      ...annotation('annotation-2'),
      selectedText: 'A second exact excerpt',
      end: 'A second exact excerpt'.length,
      sourceMessageId: 'assistant-2',
      sourceHash: responseAnnotationSourceHash('A second exact excerpt'),
      suffix: '',
    })
    const wrapper = mount(ResponseAnnotationComposer, {
      attachTo: document.body,
      props: { sessionId: 'session-1' },
    })

    await wrapper.get('.response-annotation-composer').trigger('mouseenter')
    await nextTick()
    const preview = wrapper.get('[data-testid="response-annotation-preview"]')
    expect(preview.text()).toContain('The exact selected excerpt')
    expect(preview.text()).toContain('A second exact excerpt')
    expect(wrapper.find('[data-testid="response-annotation-draft-card"]').exists()).toBe(false)

    await wrapper.get('.response-annotation-composer').trigger('mouseleave')
    await nextTick()
    expect(wrapper.find('[data-testid="response-annotation-preview"]').exists()).toBe(false)
    ;(wrapper.get('[data-testid="response-annotation-count"]').element as HTMLButtonElement).focus()
    await nextTick()
    expect(wrapper.get('[data-testid="response-annotation-preview"]').text()).toContain('The exact selected excerpt')

    await wrapper.get('[data-testid="response-annotation-count"]').trigger('click')
    await nextTick()
    expect(wrapper.find('[data-testid="response-annotation-preview"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="response-annotation-draft-card"]').text()).toContain('A second exact excerpt')
  })

  it('keeps a tall file-heavy editor inside the available viewport side', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 300 })
    const store = useChatAnnotationsStore()
    store.addAnnotation('session-1', annotation())
    store.openEditor('session-1', 'annotation-1', {
      left: 100, top: 260, right: 140, bottom: 280, width: 40, height: 20,
    })
    mount(ResponseAnnotationComposer, {
      attachTo: document.body,
      props: { sessionId: 'session-1' },
    })
    await nextTick()

    const editor = document.body.querySelector<HTMLElement>('[data-testid="response-annotation-editor"]')!
    const files = Array.from({ length: 10 }, (_, index) => (
      new File(['proof'], `proof-${index}.txt`, { type: 'text/plain' })
    ))
    const input = editor.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, 'files', { configurable: true, value: files })
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    expect(editor.style.top).toBe('')
    expect(editor.style.bottom).toBe('48px')
    expect(editor.style.maxHeight).toBe('244px')
    expect(editor.textContent).toContain('proof-9.txt')

    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 100 })
    window.dispatchEvent(new Event('resize'))
    await nextTick()
    expect(editor.style.bottom).toBe('16px')
    expect(editor.style.maxHeight).toBe('76px')
  })

  it('keeps comment and files unchanged when Save exceeds the aggregate file limit', async () => {
    const store = useChatAnnotationsStore()
    store.addAnnotation('session-1', { ...annotation(), comment: 'Original comment' })
    store.openEditor('session-1', 'annotation-1', {
      left: 100, top: 100, right: 140, bottom: 120, width: 40, height: 20,
    })
    mount(ResponseAnnotationComposer, {
      attachTo: document.body,
      props: { sessionId: 'session-1' },
    })
    await nextTick()
    const editor = document.body.querySelector<HTMLElement>('[data-testid="response-annotation-editor"]')!
    const textarea = editor.querySelector<HTMLTextAreaElement>('textarea')!
    textarea.value = 'Changed comment'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    const files = Array.from({ length: 11 }, (_, index) => (
      new File(['proof'], `proof-${index}.txt`, { type: 'text/plain' })
    ))
    const input = editor.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, 'files', { configurable: true, value: files })
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    const save = Array.from(editor.querySelectorAll('button'))
      .find(button => button.textContent?.trim() === 'chat.annotations.save')!
    save.click()
    await nextTick()

    expect(editor.textContent).toContain('chat.annotations.tooManyFiles')
    expect(store.annotationsForSession('session-1')[0].comment).toBe('Original comment')
    expect(store.pendingFilesForAnnotation('annotation-1')).toEqual([])
    expect(store.activeEditor?.annotationId).toBe('annotation-1')
  })

  it('renders immutable sent annotations and dispatches Show source without edit controls', async () => {
    const sourceRequest = vi.fn()
    window.addEventListener('hermes:show-response-annotation-source', sourceRequest)
    const sent = annotation('sent-1')
    sent.comment = 'A persisted comment'
    sent.files = [{ id: 'file-1', name: 'proof.png', type: 'image/png', size: 42, path: '/tmp/proof.png' }]

    const wrapper = mount(SentResponseAnnotations, {
      attachTo: document.body,
      props: {
        sessionId: 'session-1',
        messageId: 'user-2',
        annotations: [sent],
      },
    })

    await wrapper.get('[data-testid="response-annotation-count"]').trigger('click')
    await nextTick()
    const card = document.body.querySelector<HTMLElement>('[data-testid="response-annotation-sent-card"]')!
    expect(card.textContent).toContain('The exact selected excerpt')
    expect(card.textContent).toContain('A persisted comment')
    expect(card.textContent).toContain('proof.png')
    expect(card.querySelector('[aria-label^="Edit"]')).toBeNull()
    expect(card.querySelector('[aria-label^="Delete"]')).toBeNull()

    const showSource = Array.from(card.querySelectorAll('button'))
      .find(button => button.textContent?.trim() === 'chat.annotations.showSource')!
    showSource.click()
    expect(sourceRequest).toHaveBeenCalledTimes(1)
    expect((sourceRequest.mock.calls[0][0] as CustomEvent).detail.annotation.id).toBe('sent-1')
    expect(useChatAnnotationsStore().inspectedSentMessageId).toBe('user-2')

    window.removeEventListener('hermes:show-response-annotation-source', sourceRequest)
    wrapper.unmount()
  })

  it('previews sent evidence on hover or focus and positions the expanded card from its measured height', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 300 })
    const sent = annotation('sent-preview')
    sent.comment = 'A persisted comment'
    const wrapper = mount(SentResponseAnnotations, {
      attachTo: document.body,
      props: { sessionId: 'session-1', messageId: 'user-preview', annotations: [sent] },
    })
    const chipRoot = wrapper.get('.sent-response-annotations')
    vi.spyOn(chipRoot.element, 'getBoundingClientRect').mockReturnValue({
      left: 400, right: 520, top: 150, bottom: 180, width: 120, height: 30,
      x: 400, y: 150, toJSON: () => ({}),
    } as DOMRect)

    await chipRoot.trigger('mouseenter')
    await nextTick()
    const hoverPreview = document.body.querySelector<HTMLElement>('[data-testid="response-annotation-sent-preview"]')!
    expect(hoverPreview.textContent).toContain('A persisted comment')
    expect(hoverPreview.style.left).toBe('140px')
    expect(hoverPreview.style.bottom).toBe('158px')
    expect(hoverPreview.style.top).toBe('')
    expect(hoverPreview.style.maxHeight).toBe('134px')
    expect(wrapper.get('[data-testid="response-annotation-count"]').attributes('aria-describedby')).toContain('user-preview')
    await chipRoot.trigger('mouseleave')
    ;(wrapper.get('[data-testid="response-annotation-count"]').element as HTMLButtonElement).focus()
    await nextTick()
    expect(document.body.querySelector<HTMLElement>('[data-testid="response-annotation-sent-preview"]')?.textContent)
      .toContain('A persisted comment')

    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 })
    await wrapper.get('[data-testid="response-annotation-count"]').trigger('click')
    await nextTick()
    const card = document.body.querySelector<HTMLElement>('[data-testid="response-annotation-sent-card"]')!
    vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({
      left: 72, right: 520, top: 32, bottom: 472, width: 448, height: 440,
      x: 72, y: 32, toJSON: () => ({}),
    } as DOMRect)
    window.dispatchEvent(new Event('resize'))
    await nextTick()
    expect(card.style.top).toBe('152px')
    wrapper.unmount()
  })
})
