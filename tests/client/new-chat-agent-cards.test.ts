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

describe('new chat Agent card interior motion', () => {
  let wrapper: VueWrapper | undefined
  let visibilityMock: { mockRestore(): void } | undefined

  afterEach(() => {
    wrapper?.unmount()
    visibilityMock?.mockRestore()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('renders identical animation frames under both system motion preferences', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    visibilityMock = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)

    const sampleFrames = async (matches: boolean) => {
      let frame: FrameRequestCallback
      vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { frame = callback; return 1 }))
      vi.stubGlobal('matchMedia', vi.fn(() => ({
        matches, addEventListener: vi.fn(), removeEventListener: vi.fn(),
      })))
      wrapper = mount(NewChatAgentCards, {
        props: { value: 'ekko-agent', options: AGENT_OPTIONS.slice(0, 4) },
        attachTo: document.body,
      })
      Object.assign(wrapper.get('.agent-card-viewport').element, { scrollTo: vi.fn() })
      await nextTick()
      const layers = wrapper.findAll('.agent-card.active .agent-card-foil, .agent-card.active .agent-card-foil-beam, .agent-card.active .agent-card-sweep')
      expect(layers).toHaveLength(4)
      const samples = [0, 800, 1700, 2600].map(now => {
        frame(now)
        return layers.map(layer => {
          const { transform, opacity } = (layer.element as HTMLElement).style
          return { transform, opacity }
        })
      })
      wrapper.unmount()
      wrapper = undefined
      return samples
    }

    const normal = await sampleFrames(false)
    const reduced = await sampleFrames(true)
    expect(normal[1]).not.toEqual(normal[0])
    expect(reduced).toEqual(normal)
  })
})

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

describe('new chat Agent card wheel scrolling', () => {
  let wrapper: VueWrapper
  let viewport: HTMLElement
  let selectAgent: ReturnType<typeof vi.fn>

  function wheel(init: WheelEventInit) {
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init })
    viewport.dispatchEvent(event)
    return event
  }

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    selectAgent = vi.fn()
    wrapper = mount(NewChatAgentCards, {
      props: { value: 'ekko-agent', options: AGENT_OPTIONS.slice(0, 4), 'onUpdate:value': selectAgent },
      attachTo: document.body,
    })
    viewport = wrapper.get('.agent-card-viewport').element as HTMLElement
    Object.defineProperties(viewport, {
      clientWidth: { value: 300 }, clientHeight: { value: 250 }, scrollWidth: { value: 642 },
    })
    wrapper.findAll('.agent-card-slot').forEach((slot, index) => Object.defineProperties(slot.element, {
      offsetLeft: { value: 100 + index * 114 }, offsetWidth: { value: 100 },
    }))
    viewport.scrollTo = vi.fn((options: ScrollToOptions) => { viewport.scrollLeft = options.left! }) as typeof viewport.scrollTo
    await nextTick()
    vi.advanceTimersByTime(51)
    viewport.scrollLeft = 114
  })

  afterEach(() => {
    wrapper.unmount()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it.each([
    { deltaY: 80, expected: 194 },
    { deltaY: -80, expected: 34 },
    { deltaX: 60, deltaY: 5, expected: 174 },
    { deltaX: 5, deltaY: 60, expected: 174 },
    { deltaY: 2, deltaMode: WheelEvent.DOM_DELTA_LINE, expected: 146 },
    { deltaY: 1, deltaMode: WheelEvent.DOM_DELTA_PAGE, expected: 342 },
  ])('scrolls horizontally with $deltaMode wheel units and deltas ($deltaX, $deltaY)', ({ expected, ...init }) => {
    expect(wheel(init).defaultPrevented).toBe(true)
    expect(viewport.scrollLeft).toBe(expected)
  })

  it('selects the nearest Agent after interrupting a card centering animation', async () => {
    await wrapper.findAll('.agent-card')[2].trigger('click')
    wheel({ deltaY: -114 })
    await wrapper.get('.agent-card-viewport').trigger('scroll')
    expect(wrapper.findAll('.agent-card')[1].classes()).toContain('active')
    expect(selectAgent).toHaveBeenLastCalledWith('hermes')
  })

  it('preserves zoom gestures and lets page scrolling continue at either edge', () => {
    expect(wheel({ deltaY: 60, ctrlKey: true }).defaultPrevented).toBe(false)
    expect(viewport.scrollLeft).toBe(114)
    viewport.scrollLeft = 0
    expect(wheel({ deltaY: -60 }).defaultPrevented).toBe(false)
    expect(viewport.scrollLeft).toBe(0)
    viewport.scrollLeft = 342
    expect(wheel({ deltaY: 60 }).defaultPrevented).toBe(false)
    expect(viewport.scrollLeft).toBe(342)
  })

  it('leaves empty wheel events, disabled cards and single-option rows alone', async () => {
    expect(wheel({}).defaultPrevented).toBe(false)
    await wrapper.setProps({ disabled: true })
    expect(wheel({ deltaY: 60 }).defaultPrevented).toBe(false)
    expect(viewport.scrollLeft).toBe(114)
    await wrapper.setProps({ disabled: false, options: AGENT_OPTIONS.slice(0, 1) })
    const left = viewport.scrollLeft
    expect(wheel({ deltaY: 60 }).defaultPrevented).toBe(false)
    expect(viewport.scrollLeft).toBe(left)
  })
})
