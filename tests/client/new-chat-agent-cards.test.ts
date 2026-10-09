// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import NewChatAgentCards from '@/components/hermes/chat/NewChatAgentCards.vue'
import { AGENT_OPTIONS } from '@/utils/agent-options'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))

function dispatchPointer(target: EventTarget, type: string, clientX = 100, buttons = 1, pointerId = 1) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons, clientX })
  Object.defineProperties(event, { pointerId: { value: pointerId }, pointerType: { value: 'mouse' } })
  target.dispatchEvent(event)
}

describe('new chat Agent card dragging', () => {
  let wrapper: VueWrapper
  let viewport: HTMLElement
  let captured: number | null
  let releaseCapture: ReturnType<typeof vi.fn>
  let selectAgent: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    selectAgent = vi.fn()
    wrapper = mount(NewChatAgentCards, {
      props: { value: 'ekko-agent', options: AGENT_OPTIONS.slice(0, 4), 'onUpdate:value': selectAgent },
      attachTo: document.body,
    })
    viewport = wrapper.get('.agent-card-viewport').element as HTMLElement
    captured = null
    releaseCapture = vi.fn(() => { captured = null })
    Object.assign(viewport, {
      scrollTo: vi.fn(),
      setPointerCapture: vi.fn((id: number) => { captured = id }),
      hasPointerCapture: (id: number) => captured === id,
      releasePointerCapture: releaseCapture,
    })
    await nextTick()
    viewport.scrollLeft = 500
  })

  afterEach(() => {
    wrapper.unmount()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('ends an uncaptured drag when mouseup outside the list stops bubbling', () => {
    const outside = document.createElement('div')
    document.body.append(outside)
    outside.addEventListener('pointerup', event => event.stopPropagation())
    dispatchPointer(viewport, 'pointerdown')
    dispatchPointer(outside, 'pointerup', 200, 0)
    // A new press outside the list must not resume the previous drag either.
    dispatchPointer(outside, 'pointerdown', 200)
    dispatchPointer(viewport, 'pointermove', 150)
    expect(viewport.scrollLeft).toBe(500)
  })

  it('stops before scrolling when a move arrives without the primary button pressed', () => {
    dispatchPointer(viewport, 'pointerdown')
    dispatchPointer(viewport, 'pointermove', 150, 0)
    expect(viewport.scrollLeft).toBe(500)
    expect(viewport.setPointerCapture).not.toHaveBeenCalled()
  })

  it.each(['pointercancel', 'lostpointercapture', 'blur'])('ends a captured drag on %s', event => {
    dispatchPointer(viewport, 'pointerdown')
    dispatchPointer(viewport, 'pointermove', 130)
    expect(viewport.scrollLeft).toBe(470)
    if (event === 'blur') window.dispatchEvent(new Event('blur'))
    else dispatchPointer(event === 'pointercancel' ? window : viewport, event)
    dispatchPointer(viewport, 'pointermove', 180)
    expect(viewport.scrollLeft).toBe(470)
    expect(releaseCapture).toHaveBeenCalledWith(1)
  })

  it('ignores another pointer ending and suppresses the drag click until a new press', async () => {
    dispatchPointer(viewport, 'pointerdown')
    dispatchPointer(viewport, 'pointermove', 130)
    dispatchPointer(window, 'pointerup', 130, 0, 2)
    dispatchPointer(viewport, 'pointermove', 150)
    expect(viewport.scrollLeft).toBe(450)
    dispatchPointer(viewport, 'pointerup', 150, 0)
    await wrapper.findAll('.agent-card')[1].trigger('click')
    expect(selectAgent).not.toHaveBeenCalled()
    dispatchPointer(viewport, 'pointerdown')
    dispatchPointer(viewport, 'pointerup', 100, 0)
    await wrapper.findAll('.agent-card')[1].trigger('click')
    expect(selectAgent).toHaveBeenCalledOnce()
    expect(selectAgent).toHaveBeenCalledWith('hermes')
  })
})
