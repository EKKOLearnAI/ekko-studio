// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  avoidResponseAnnotationMarkerCollisions,
  collectResponseAnnotationTextRects,
  completeResponseAnnotationVisualLineRect,
  placeResponseAnnotationMarker,
  scrollResponseAnnotationRangeIntoView,
  type ResponseAnnotationRect,
} from '@/utils/chat-response-annotation-geometry'

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect
}

describe('response annotation geometry', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    delete (Range.prototype as Partial<Range>).getClientRects
  })

  it('clips source text rectangles to viewport and scrollable descendants', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 80 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 60 })
    const root = document.createElement('div')
    const clipping = document.createElement('div')
    clipping.style.overflowX = 'hidden'
    clipping.style.overflowY = 'hidden'
    clipping.textContent = 'visible excerpt'
    const foldedChrome = document.createElement('div')
    foldedChrome.className = 'diff-line-context-fold'
    foldedChrome.textContent = '⋮ 12 unchanged lines'
    root.append(clipping, foldedChrome)
    document.body.appendChild(root)
    root.getBoundingClientRect = () => rect(0, 0, 100, 100)
    clipping.getBoundingClientRect = () => rect(10, 10, 50, 20)
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: vi.fn(() => ({
        0: rect(-5, 0, 100, 40),
        length: 1,
        item: (index: number) => index === 0 ? rect(-5, 0, 100, 40) : null,
        [Symbol.iterator]: function* () { yield rect(-5, 0, 100, 40) },
      } as DOMRectList)),
    })

    expect(collectResponseAnnotationTextRects(root)).toEqual([
      expect.objectContaining({ left: 10, right: 60, top: 10, bottom: 30, width: 50, height: 20 }),
    ])
  })

  it('anchors to a complete visual line and falls back below colliding text', () => {
    const textRects: ResponseAnnotationRect[] = [
      rect(8, 10, 84, 20),
      rect(72, 34, 20, 20),
    ]
    const line = completeResponseAnnotationVisualLineRect(textRects, rect(40, 10, 20, 20))
    expect(line).toEqual(expect.objectContaining({ left: 8, right: 92, top: 10, bottom: 30 }))

    expect(placeResponseAnnotationMarker(line!, rect(0, 0, 100, 100), {
      viewportWidth: 100,
      viewportHeight: 100,
      markerSize: 20,
      gap: 4,
      padding: 8,
      textRects,
    })).toEqual({ left: 72, top: 58 })
  })

  it('resolves marker-to-marker collisions inside viewport bounds', () => {
    const positions = avoidResponseAnnotationMarkerCollisions([
      { id: 'a', left: 72, top: 10, direction: 1 },
      { id: 'b', left: 72, top: 10, direction: 1 },
    ], 20, 2, { minLeft: 8, maxLeft: 72, minTop: 8, maxTop: 72 })

    expect(positions.a).toEqual({ left: 72, top: 10 })
    expect(positions.b).toEqual({ left: 72, top: 32 })
  })

  it('keeps vertically stacked markers inside the viewport bounds', () => {
    const positions = avoidResponseAnnotationMarkerCollisions([
      { id: 'a', left: 72, top: 72, direction: 1 },
      { id: 'b', left: 72, top: 72, direction: 1 },
      { id: 'c', left: 72, top: 72, direction: 1 },
    ], 20, 2, { minLeft: 72, maxLeft: 72, minTop: 8, maxTop: 72 })

    expect(Object.values(positions).every(position => position.top >= 8 && position.top <= 72)).toBe(true)
    expect(new Set(Object.values(positions).map(position => position.top)).size).toBe(3)
  })

  it('centers the exact source range inside the nearest scroll container', () => {
    const scroller = document.createElement('div')
    scroller.style.overflowY = 'auto'
    const root = document.createElement('div')
    root.textContent = 'a very long response with a selected excerpt'
    scroller.appendChild(root)
    document.body.appendChild(scroller)
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1200 })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 200 })
    scroller.getBoundingClientRect = () => rect(0, 100, 400, 200)
    const scrollBy = vi.fn()
    scroller.scrollBy = scrollBy
    const range = document.createRange()
    range.selectNodeContents(root.firstChild!)
    range.getBoundingClientRect = () => rect(20, 500, 120, 20)

    scrollResponseAnnotationRangeIntoView(root, range)

    expect(scrollBy).toHaveBeenCalledWith({ top: 310, behavior: 'smooth' })
  })
})
