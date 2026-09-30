// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'

const dynamicScrollToBottomMock = vi.hoisted(() => vi.fn())
const dynamicScrollToPositionMock = vi.hoisted(() => vi.fn())
const dynamicScrollToItemMock = vi.hoisted(() => vi.fn())
const dynamicGetItemSizeMock = vi.hoisted(() => vi.fn())

vi.mock('vue-virtual-scroller', () => ({
  DynamicScroller: defineComponent({
    name: 'DynamicScroller',
    props: {
      items: { type: Array, default: () => [] },
    },
    emits: ['scroll', 'resize', 'visible'],
    setup(_props, { expose }) {
      expose({
        scrollToBottom: dynamicScrollToBottomMock,
        scrollToPosition: dynamicScrollToPositionMock,
        scrollToItem: dynamicScrollToItemMock,
        getItemSize: dynamicGetItemSizeMock,
      })
    },
    template: `
      <div class="virtual-message-list" @scroll="$emit('scroll')">
        <slot name="before" />
        <slot v-for="(item, index) in items" :item="item" :index="index" :active="true" />
        <slot name="after" />
      </div>
    `,
  }),
  DynamicScrollerItem: defineComponent({
    name: 'DynamicScrollerItem',
    props: {
      item: { type: Object, required: true },
      index: { type: Number, required: true },
      active: { type: Boolean, default: true },
    },
    template: '<div class="virtual-row"><slot /></div>',
  }),
}))

import VirtualMessageList from '@/components/hermes/chat/VirtualMessageList.vue'

function setScrollerMetrics(el: HTMLElement, metrics: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: metrics.scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: metrics.clientHeight })
  el.scrollTop = metrics.scrollTop
}

function elementRect(top: number, bottom: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    bottom,
    left: 0,
    right: 400,
    width: 400,
    height: bottom - top,
    toJSON: () => ({}),
  } as DOMRect
}

describe('VirtualMessageList scroll behavior', () => {
  let rafCallbacks: FrameRequestCallback[]
  let resizeCallbacks: ResizeObserverCallback[]

  beforeEach(() => {
    vi.clearAllMocks()
    dynamicGetItemSizeMock.mockReturnValue(0)
    rafCallbacks = []
    resizeCallbacks = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      rafCallbacks.push(callback)
      return rafCallbacks.length
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      rafCallbacks[id - 1] = () => undefined
    })
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback)
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    })
  })

  it('cancels queued bottom scrolling when the user scrolls away from the bottom', async () => {
    const wrapper = mount(VirtualMessageList, {
      props: {
        messages: [{ id: 'message-1' }],
      },
      slots: {
        item: '<div>message</div>',
      },
    })
    await nextTick()

    const scroller = wrapper.find<HTMLElement>('.virtual-message-list')
    setScrollerMetrics(scroller.element, {
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTop: 600,
    })

    ;(wrapper.vm as any).scrollToBottom({ frames: 5, keepAliveMs: 700 })
    await nextTick()
    expect(rafCallbacks.length).toBeGreaterThan(0)

    scroller.element.scrollTop = 120
    await scroller.trigger('scroll')
    rafCallbacks.splice(0).forEach(callback => callback(performance.now()))

    expect(dynamicScrollToBottomMock).not.toHaveBeenCalled()
    expect(scroller.element.scrollTop).toBe(120)
  })

  it.each(['scrollToMessage', 'scrollToAnchor'])('lets %s override pending bottom scrolling', async (method) => {
    const wrapper = mount(VirtualMessageList, { props: { messages: [{ id: 'hit' }] } })
    await nextTick()
    setScrollerMetrics(wrapper.get<HTMLElement>('.virtual-message-list').element, {
      scrollHeight: 2000, clientHeight: 400, scrollTop: 800,
    })
    ;(wrapper.vm as any).scrollToBottom({ frames: 5, keepAliveMs: 1200 })
    ;(wrapper.vm as any)[method]('hit', 'anchor-hit')
    await nextTick()
    rafCallbacks.splice(0).forEach(callback => callback(performance.now()))
    resizeCallbacks.forEach(callback => callback([], {} as ResizeObserver))
    rafCallbacks.splice(0).forEach(callback => callback(performance.now()))
    expect(dynamicScrollToBottomMock).not.toHaveBeenCalled()
    expect(dynamicScrollToItemMock).toHaveBeenCalled()
    expect((wrapper.vm as any).shouldAutoFollowBottom()).toBe(false)
    wrapper.unmount()
  })

  it.each([true, false])('waits for rendered target and quiet geometry (virtualized: %s)', async virtualized => {
    let now = 0
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    const wrapper = mount(VirtualMessageList, {
      attachTo: document.body,
      props: { messages: [{ id: 'hit' }], virtualized },
      slots: { item: '<div id="message-hit">hit</div>' },
    })
    await nextTick()
    const scroller = wrapper.get<HTMLElement>('.virtual-message-list').element
    setScrollerMetrics(scroller, { scrollHeight: 2000, clientHeight: 400, scrollTop: 500 })
    vi.spyOn(scroller, 'getBoundingClientRect').mockImplementation(() => elementRect(0, 400))
    let targetHeight = 0
    let targetOffset = 600
    vi.spyOn(wrapper.get<HTMLElement>('#message-hit').element, 'getBoundingClientRect')
      .mockImplementation(() => elementRect(targetOffset - scroller.scrollTop, targetOffset - scroller.scrollTop + targetHeight))
    let processed = 0
    const frame = async (time: number) => {
      now = time
      const end = rafCallbacks.length
      while (processed < end) rafCallbacks[processed++](now)
      await nextTick()
    }
    const settled = vi.fn()
    const positioning = wrapper.vm.scrollToMessage('hit').then(settled)
    await nextTick()
    await frame(0)
    await frame(300)
    expect(settled).not.toHaveBeenCalled() // Zero-sized DOM isn't rendered yet.

    targetHeight = 80
    await frame(316)
    await frame(516)
    expect(settled).not.toHaveBeenCalled()
    targetOffset += 120 // A preceding row finishes rendering.
    await frame(532)
    await frame(732)
    expect(settled).not.toHaveBeenCalled()
    await frame(800)
    await positioning
    expect(settled).toHaveBeenCalledWith(true)
    const scrollTop = scroller.scrollTop
    await frame(1200)
    expect(scroller.scrollTop).toBe(scrollTop)
    wrapper.unmount()
    clock.mockRestore()
  })

  it('keeps the rendered window still until boundary rows finish measuring', async () => {
    let now = 0
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    let boundarySize = 92
    dynamicGetItemSizeMock.mockImplementation(item => item.id === 'boundary' ? boundarySize : 80)
    const wrapper = mount(VirtualMessageList, {
      attachTo: document.body,
      props: { messages: [{ id: 'boundary' }, { id: 'hit' }] },
      slots: { item: ({ message }) => h('div', { id: `message-${message.id}` }, message.id) },
    })
    await nextTick()
    const scroller = wrapper.get<HTMLElement>('.virtual-message-list').element
    setScrollerMetrics(scroller, { scrollHeight: 2000, clientHeight: 400, scrollTop: 500 })
    vi.spyOn(scroller, 'getBoundingClientRect').mockImplementation(() => elementRect(0, 400))
    vi.spyOn(wrapper.get<HTMLElement>('[data-message-id="boundary"]').element, 'getBoundingClientRect')
      .mockImplementation(() => elementRect(0, 239))
    vi.spyOn(wrapper.get<HTMLElement>('[data-message-id="hit"]').element, 'getBoundingClientRect')
      .mockImplementation(() => elementRect(600 - scroller.scrollTop, 680 - scroller.scrollTop))
    vi.spyOn(wrapper.get<HTMLElement>('#message-hit').element, 'getBoundingClientRect')
      .mockImplementation(() => elementRect(600 - scroller.scrollTop, 680 - scroller.scrollTop))
    let processed = 0
    const frame = async (time: number) => {
      now = time
      const end = rafCallbacks.length
      while (processed < end) rafCallbacks[processed++](now)
      await nextTick()
    }
    const settled = vi.fn()
    const positioning = wrapper.vm.scrollToMessage('hit').then(settled)
    await nextTick()
    await frame(0)
    await frame(300)
    expect(scroller.scrollTop).toBe(500)
    expect(settled).not.toHaveBeenCalled()

    boundarySize = 239
    await frame(316)
    expect(scroller.scrollTop).toBe(440)
    await frame(600)
    await positioning
    expect(settled).toHaveBeenCalledWith(true)
    wrapper.unmount()
    clock.mockRestore()
  })

  it('resolves superseded, removed and unmounted anchor requests without leaving pending work', async () => {
    const wrapper = mount(VirtualMessageList, { props: { messages: [{ id: 'first' }, { id: 'second' }] } })
    await nextTick()
    const first = wrapper.vm.scrollToMessage('first')
    const second = wrapper.vm.scrollToMessage('second')
    await expect(first).resolves.toBe(false)
    await wrapper.setProps({ messages: [{ id: 'first' }] })
    await expect(second).resolves.toBe(false)
    const last = wrapper.vm.scrollToMessage('first')
    wrapper.unmount()
    await expect(last).resolves.toBe(false)
  })

  it('times out if a target never renders, stopping all alignment retries', async () => {
    vi.useFakeTimers()
    const wrapper = mount(VirtualMessageList, { props: { messages: [{ id: 'missing-dom' }] } })
    const positioning = wrapper.vm.scrollToMessage('missing-dom')
    await nextTick()
    await vi.advanceTimersByTimeAsync(5000)
    await expect(positioning).resolves.toBe(false)
    dynamicScrollToItemMock.mockClear()
    rafCallbacks.forEach(callback => callback(performance.now()))
    expect(dynamicScrollToItemMock).not.toHaveBeenCalled()
    wrapper.unmount()
    vi.useRealTimers()
  })

  it('locks auto-follow as soon as the user scrolls upward during streaming', async () => {
    const wrapper = mount(VirtualMessageList, {
      props: {
        messages: [{ id: 'message-1' }],
      },
      slots: {
        item: '<div>message</div>',
      },
    })
    await nextTick()

    const scroller = wrapper.find<HTMLElement>('.virtual-message-list')
    setScrollerMetrics(scroller.element, {
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTop: 600,
    })
    await scroller.trigger('scroll')

    scroller.element.scrollTop = 580
    await scroller.trigger('scroll')

    expect((wrapper.vm as any).isNearBottom(100)).toBe(true)
    expect((wrapper.vm as any).shouldAutoFollowBottom(100)).toBe(false)

    scroller.element.scrollTop = 600
    await scroller.trigger('scroll')

    expect((wrapper.vm as any).shouldAutoFollowBottom(100)).toBe(true)
  })

  it('does not keep scrolling every animation frame for the whole keep-alive window', async () => {
    const wrapper = mount(VirtualMessageList, {
      props: {
        messages: [{ id: 'message-1' }],
      },
      slots: {
        item: '<div>message</div>',
      },
    })
    await nextTick()

    const scroller = wrapper.find<HTMLElement>('.virtual-message-list')
    setScrollerMetrics(scroller.element, {
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTop: 600,
    })

    ;(wrapper.vm as any).scrollToBottom({ frames: 2, keepAliveMs: 1200 })
    await nextTick()

    for (let i = 0; i < 2; i += 1) {
      const callback = rafCallbacks.shift()
      expect(callback).toBeTypeOf('function')
      callback?.(performance.now())
    }

    expect(dynamicScrollToBottomMock).toHaveBeenCalledTimes(2)
    expect(rafCallbacks).toHaveLength(0)
  })

  it('cancels bottom scrolling when the user scrolls upward during a programmatic scroll window', async () => {
    const wrapper = mount(VirtualMessageList, {
      props: {
        messages: [{ id: 'message-1' }],
      },
      slots: {
        item: '<div>message</div>',
      },
    })
    await nextTick()

    const scroller = wrapper.find<HTMLElement>('.virtual-message-list')
    setScrollerMetrics(scroller.element, {
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTop: 600,
    })

    ;(wrapper.vm as any).scrollToBottom({ frames: 5, keepAliveMs: 400 })
    await nextTick()

    const firstFrame = rafCallbacks.shift()
    firstFrame?.(performance.now())
    expect(dynamicScrollToBottomMock).toHaveBeenCalledTimes(1)

    scroller.element.scrollTop = 560
    await scroller.trigger('scroll')

    rafCallbacks.splice(0).forEach(callback => callback(performance.now()))
    expect(dynamicScrollToBottomMock).toHaveBeenCalledTimes(1)
    expect((wrapper.vm as any).shouldAutoFollowBottom(100)).toBe(false)
  })

  it('uses native scroll positioning when virtualization is disabled', async () => {
    const wrapper = mount(VirtualMessageList, {
      props: {
        messages: [{ id: 'message-1' }],
        virtualized: false,
      },
      slots: {
        item: '<div>message</div>',
      },
    })
    await nextTick()

    const scroller = wrapper.find<HTMLElement>('.virtual-message-list')
    setScrollerMetrics(scroller.element, {
      scrollHeight: 1200,
      clientHeight: 400,
      scrollTop: 0,
    })

    ;(wrapper.vm as any).scrollToBottom({ frames: 1, keepAliveMs: 0 })
    await nextTick()
    rafCallbacks.splice(0).forEach(callback => callback(performance.now()))

    expect(dynamicScrollToBottomMock).not.toHaveBeenCalled()
    expect(scroller.element.scrollTop).toBe(800)
  })

  it('keeps a bottom-following transcript pinned when rendered content grows later', async () => {
    const wrapper = mount(VirtualMessageList, {
      props: {
        messages: [{ id: 'message-1' }],
        virtualized: false,
      },
      slots: {
        item: '<div>message</div>',
      },
    })
    await nextTick()

    const scroller = wrapper.find<HTMLElement>('.virtual-message-list')
    setScrollerMetrics(scroller.element, {
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTop: 600,
    })
    await scroller.trigger('scroll')

    Object.defineProperty(scroller.element, 'scrollHeight', { configurable: true, value: 1400 })
    resizeCallbacks.forEach(callback => callback([], {} as ResizeObserver))
    while (rafCallbacks.length > 0) {
      rafCallbacks.shift()?.(performance.now())
    }

    expect(scroller.element.scrollTop).toBe(1000)
  })

  it('captures the top visible message as the viewport anchor', async () => {
    const wrapper = mount(VirtualMessageList, {
      props: {
        messages: [{ id: 'message-a' }, { id: 'message-b' }, { id: 'message-c' }],
        virtualized: false,
      },
      slots: {
        item: '<div>message</div>',
      },
    })
    await nextTick()

    const scroller = wrapper.find<HTMLElement>('.virtual-message-list')
    const rows = wrapper.findAll<HTMLElement>('.virtual-row')
    setScrollerMetrics(scroller.element, {
      scrollHeight: 1200,
      clientHeight: 400,
      scrollTop: 300,
    })
    vi.spyOn(scroller.element, 'getBoundingClientRect').mockReturnValue(elementRect(100, 500))
    vi.spyOn(rows[0].element, 'getBoundingClientRect').mockReturnValue(elementRect(40, 140))
    vi.spyOn(rows[1].element, 'getBoundingClientRect').mockReturnValue(elementRect(140, 300))
    vi.spyOn(rows[2].element, 'getBoundingClientRect').mockReturnValue(elementRect(300, 520))

    expect((wrapper.vm as any).captureViewportPosition()).toMatchObject({
      anchorMessageId: 'message-a',
      anchorOffset: -60,
      wasNearBottom: false,
    })
  })

  it('restores a changed layout by aligning the saved message anchor', async () => {
    const wrapper = mount(VirtualMessageList, {
      props: {
        messages: [{ id: 'message-before' }, { id: 'message-anchor' }, { id: 'message-after' }],
        virtualized: false,
      },
      slots: {
        item: '<div>message</div>',
      },
    })
    await nextTick()

    const scroller = wrapper.find<HTMLElement>('.virtual-message-list')
    const anchorRow = wrapper.findAll<HTMLElement>('.virtual-row')[1]
    setScrollerMetrics(scroller.element, {
      scrollHeight: 2000,
      clientHeight: 400,
      scrollTop: 0,
    })
    vi.spyOn(scroller.element, 'getBoundingClientRect').mockReturnValue(elementRect(100, 500))
    vi.spyOn(anchorRow.element, 'getBoundingClientRect').mockImplementation(() =>
      elementRect(620 - scroller.element.scrollTop, 820 - scroller.element.scrollTop),
    )

    const restored = (wrapper.vm as any).restoreViewportPosition({
      anchorMessageId: 'message-anchor',
      anchorOffset: -24,
      scrollTop: 320,
      scrollHeight: 1200,
      clientHeight: 400,
      wasNearBottom: false,
    })
    expect(restored).toBe(true)
    await nextTick()
    while (rafCallbacks.length > 0) {
      rafCallbacks.shift()?.(performance.now())
    }

    expect(scroller.element.scrollTop).toBe(544)
  })

  it('falls back to the bottom when the saved message anchor is missing', async () => {
    const wrapper = mount(VirtualMessageList, {
      props: {
        messages: [{ id: 'message-current' }],
        virtualized: false,
      },
      slots: {
        item: '<div>message</div>',
      },
    })
    await nextTick()

    const scroller = wrapper.find<HTMLElement>('.virtual-message-list')
    setScrollerMetrics(scroller.element, {
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTop: 100,
    })

    const restored = (wrapper.vm as any).restoreViewportPosition({
      anchorMessageId: 'message-missing',
      anchorOffset: 0,
      scrollTop: 100,
      scrollHeight: 900,
      clientHeight: 400,
      wasNearBottom: false,
    })
    expect(restored).toBe(false)
    await nextTick()
    while (rafCallbacks.length > 0) {
      rafCallbacks.shift()?.(performance.now())
    }

    expect(scroller.element.scrollTop).toBe(600)
  })
})
