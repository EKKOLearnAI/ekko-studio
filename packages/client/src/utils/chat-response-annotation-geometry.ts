export interface ResponseAnnotationRect {
  left: number
  right: number
  top: number
  bottom: number
  width: number
  height: number
}

const GEOMETRY_IGNORE_SELECTOR = [
  '[data-annotation-ignore]',
  '.code-header',
  '.diff-line-context-fold',
  '.diff-line-number',
  'button',
  'script',
  'style',
  'textarea',
  'input',
  'select',
].join(',')

function clipRectToVisibleBounds(
  rect: DOMRect,
  startElement: Element | null,
  sourceRoot: HTMLElement,
): DOMRect | null {
  let left = Math.max(0, rect.left)
  let right = Math.min(window.innerWidth, rect.right)
  let top = Math.max(0, rect.top)
  let bottom = Math.min(window.innerHeight, rect.bottom)
  let element = startElement

  while (element && sourceRoot.contains(element)) {
    const style = window.getComputedStyle(element)
    const bounds = element.getBoundingClientRect()
    if (/^(auto|clip|hidden|scroll)$/u.test(style.overflowX)) {
      left = Math.max(left, bounds.left)
      right = Math.min(right, bounds.right)
    }
    if (/^(auto|clip|hidden|scroll)$/u.test(style.overflowY)) {
      top = Math.max(top, bounds.top)
      bottom = Math.min(bottom, bounds.bottom)
    }
    if (right <= left || bottom <= top) return null
    if (element === sourceRoot) break
    element = element.parentElement
  }

  if (right <= left || bottom <= top) return null
  return DOMRect.fromRect({ x: left, y: top, width: right - left, height: bottom - top })
}

function ignoredTextNode(node: Node): boolean {
  const parent = node.parentElement
  return !node.textContent || !parent || Boolean(parent.closest(GEOMETRY_IGNORE_SELECTOR))
}

export function collectResponseAnnotationTextRects(sourceRoot: HTMLElement): DOMRect[] {
  const rects: DOMRect[] = []
  const walker = document.createTreeWalker(sourceRoot, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (ignoredTextNode(node)) continue
    const range = document.createRange()
    range.selectNodeContents(node)
    const nodeRects = typeof range.getClientRects === 'function'
      ? Array.from(range.getClientRects())
      : []
    rects.push(...nodeRects
      .map(rect => clipRectToVisibleBounds(rect, node.parentElement, sourceRoot))
      .filter((rect): rect is DOMRect => Boolean(rect)))
  }
  return rects
}

export function collectVisibleResponseAnnotationRangeRects(
  sourceRoot: HTMLElement,
  sourceRange: Range,
): DOMRect[] {
  const rects: DOMRect[] = []
  const walker = document.createTreeWalker(sourceRoot, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (ignoredTextNode(node)) continue
    try {
      if (!sourceRange.intersectsNode(node)) continue
    } catch {
      continue
    }
    const nodeRange = document.createRange()
    nodeRange.setStart(node, node === sourceRange.startContainer ? sourceRange.startOffset : 0)
    nodeRange.setEnd(
      node,
      node === sourceRange.endContainer ? sourceRange.endOffset : node.textContent!.length,
    )
    if (nodeRange.collapsed) continue
    const nodeRects = typeof nodeRange.getClientRects === 'function'
      ? Array.from(nodeRange.getClientRects())
      : []
    rects.push(...nodeRects
      .map(rect => clipRectToVisibleBounds(rect, node.parentElement, sourceRoot))
      .filter((rect): rect is DOMRect => Boolean(rect)))
  }
  return rects
}

export function completeResponseAnnotationVisualLineRect(
  textRects: ResponseAnnotationRect[],
  anchorRect: ResponseAnnotationRect,
): ResponseAnnotationRect | null {
  const anchorCenter = anchorRect.top + anchorRect.height / 2
  const lineRects = textRects.filter(
    rect => anchorCenter >= rect.top - 1 && anchorCenter <= rect.bottom + 1,
  )
  if (lineRects.length === 0) return null
  const left = Math.min(...lineRects.map(rect => rect.left))
  const right = Math.max(...lineRects.map(rect => rect.right))
  const top = Math.min(...lineRects.map(rect => rect.top))
  const bottom = Math.max(...lineRects.map(rect => rect.bottom))
  return { left, right, top, bottom, width: right - left, height: bottom - top }
}

export function placeResponseAnnotationMarker(
  finalLineRect: ResponseAnnotationRect,
  sourceRootRect: ResponseAnnotationRect,
  viewport: {
    viewportWidth: number
    viewportHeight: number
    markerSize: number
    gap: number
    padding: number
    textRects?: ResponseAnnotationRect[]
  },
): { left: number; top: number } {
  const minLeft = viewport.padding - sourceRootRect.left
  const maxLeft = viewport.viewportWidth
    - viewport.padding
    - viewport.markerSize
    - sourceRootRect.left
  const minTop = viewport.padding - sourceRootRect.top
  const maxTop = viewport.viewportHeight
    - viewport.padding
    - viewport.markerSize
    - sourceRootRect.top
  const clampTop = (top: number) => Math.max(minTop, Math.min(maxTop, top))
  const right = finalLineRect.right - sourceRootRect.left + viewport.gap
  const left = finalLineRect.left - sourceRootRect.left - viewport.gap - viewport.markerSize
  const centeredTop = Math.max(
    0,
    finalLineRect.top - sourceRootRect.top + (finalLineRect.height - viewport.markerSize) / 2,
  )
  if (right <= maxLeft) return { left: right, top: clampTop(centeredTop) }
  if (left >= minLeft) return { left, top: clampTop(centeredTop) }

  const fallbackLeft = Math.min(Math.max(right, minLeft), maxLeft)
  const fallbackAbsoluteLeft = sourceRootRect.left + fallbackLeft
  let fallbackAbsoluteTop = finalLineRect.bottom + viewport.gap
  for (;;) {
    const collision = viewport.textRects?.find(rect => (
      fallbackAbsoluteLeft < rect.right
      && fallbackAbsoluteLeft + viewport.markerSize > rect.left
      && fallbackAbsoluteTop < rect.bottom
      && fallbackAbsoluteTop + viewport.markerSize > rect.top
    ))
    if (!collision) break
    fallbackAbsoluteTop = collision.bottom + viewport.gap
  }
  return {
    left: fallbackLeft,
    top: clampTop(fallbackAbsoluteTop - sourceRootRect.top),
  }
}

export function avoidResponseAnnotationMarkerCollisions(
  positions: Array<{ id: string; left: number; top: number; direction?: -1 | 1 }>,
  markerSize: number,
  gap: number,
  bounds: { minLeft: number; maxLeft: number; minTop: number; maxTop: number },
  textRects: ResponseAnnotationRect[] = [],
): Record<string, { left: number; top: number }> {
  const placed: Array<{ left: number; top: number }> = []
  const result: Record<string, { left: number; top: number }> = {}
  const step = markerSize + gap
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
  const horizontalSteps = Math.max(0, Math.ceil((bounds.maxLeft - bounds.minLeft) / step))
  const verticalSteps = Math.max(0, Math.ceil((bounds.maxTop - bounds.minTop) / step))
  for (const position of [...positions].sort(
    (left, right) => left.top - right.top || left.id.localeCompare(right.id),
  )) {
    const direction = position.direction ?? 1
    const baseLeft = clamp(position.left, bounds.minLeft, bounds.maxLeft)
    const baseTop = clamp(position.top, bounds.minTop, bounds.maxTop)
    const verticalOffsets = [0]
    for (let index = 1; index <= verticalSteps + 1; index += 1) {
      verticalOffsets.push(index * step, -index * step)
    }
    let chosen: { left: number; top: number } | null = null
    const visitedTops = new Set<number>()
    for (const verticalOffset of verticalOffsets) {
      const top = clamp(baseTop + verticalOffset, bounds.minTop, bounds.maxTop)
      if (visitedTops.has(top)) continue
      visitedTops.add(top)
      const visitedLefts = new Set<number>()
      for (let index = 0; index <= horizontalSteps + 1; index += 1) {
        const left = clamp(baseLeft + direction * index * step, bounds.minLeft, bounds.maxLeft)
        if (visitedLefts.has(left)) continue
        visitedLefts.add(left)
        const markerCollision = placed.some(candidate => (
          Math.abs(candidate.left - left) < step
          && Math.abs(candidate.top - top) < step
        ))
        const textCollision = textRects.some(rect => (
          left < rect.right
          && left + markerSize > rect.left
          && top < rect.bottom
          && top + markerSize > rect.top
        ))
        if (!markerCollision && !textCollision) {
          chosen = { left, top }
          break
        }
      }
      if (chosen) break
    }
    const resolved = chosen ?? { left: baseLeft, top: baseTop }
    result[position.id] = resolved
    placed.push(resolved)
  }
  return result
}

export function scrollResponseAnnotationRangeIntoView(
  sourceRoot: HTMLElement,
  sourceRange: Range,
  behavior: ScrollBehavior = 'smooth',
): void {
  const targetRect = sourceRange.getBoundingClientRect()
  if (!Number.isFinite(targetRect.top) || targetRect.height <= 0) {
    sourceRoot.scrollIntoView({ block: 'center', behavior })
    return
  }
  const targetCenter = targetRect.top + targetRect.height / 2
  let ancestor = sourceRoot.parentElement
  while (ancestor) {
    const overflowY = window.getComputedStyle(ancestor).overflowY
    if (/^(auto|scroll)$/u.test(overflowY) && ancestor.scrollHeight > ancestor.clientHeight) {
      const ancestorRect = ancestor.getBoundingClientRect()
      ancestor.scrollBy({
        top: targetCenter - (ancestorRect.top + ancestorRect.height / 2),
        behavior,
      })
      return
    }
    ancestor = ancestor.parentElement
  }
  if (typeof window.scrollBy === 'function') {
    window.scrollBy({ top: targetCenter - window.innerHeight / 2, behavior })
  } else {
    sourceRoot.scrollIntoView({ block: 'center', behavior })
  }
}
