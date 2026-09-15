import {
  responseAnnotationSourceHash,
  type ResponseAnnotation,
} from './chat-response-annotations'

const responseAnnotationRawSources = new WeakMap<HTMLElement, string>()

export function registerResponseAnnotationSource(root: HTMLElement, rawSource: string) {
  responseAnnotationRawSources.set(root, rawSource)
}

export function unregisterResponseAnnotationSource(root: HTMLElement) {
  responseAnnotationRawSources.delete(root)
}

const RESPONSE_ANNOTATION_IGNORE_SELECTOR = [
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

const SEMANTIC_BREAK_ELEMENTS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'DIV',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'LI',
  'MAIN',
  'NAV',
  'P',
  'PRE',
  'SECTION',
  'TR',
])

interface TextSegment {
  node: Text
  start: number
  end: number
  nodeStart: number
  nodeEnd: number
}

interface SemanticProjection {
  text: string
  segments: TextSegment[]
}

function shouldIgnore(element: Element): boolean {
  return element.matches(RESPONSE_ANNOTATION_IGNORE_SELECTOR)
    || Boolean(element.closest(RESPONSE_ANNOTATION_IGNORE_SELECTOR))
}

function isSemanticBreakElement(element: HTMLElement): boolean {
  return SEMANTIC_BREAK_ELEMENTS.has(element.tagName)
    || element.classList.contains('diff-line')
}

function projectSemanticText(root: HTMLElement): SemanticProjection {
  let text = ''
  const segments: TextSegment[] = []

  const visit = (node: Node) => {
    if (node instanceof Element && shouldIgnore(node)) return
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.textContent ?? ''
      if (!value) return
      const start = text.length
      text += value
      segments.push({
        node: node as Text,
        start,
        end: text.length,
        nodeStart: 0,
        nodeEnd: value.length,
      })
      return
    }
    if (node instanceof HTMLBRElement) {
      if (!text.endsWith('\n')) text += '\n'
      return
    }

    const startLength = text.length
    for (const child of Array.from(node.childNodes)) visit(child)
    if (
      node instanceof HTMLElement
      && isSemanticBreakElement(node)
      && text.length > startLength
      && !text.endsWith('\n')
    ) {
      text += '\n'
    }
  }

  visit(root)
  const leading = text.match(/^\n+/u)?.[0].length ?? 0
  const trailing = text.match(/\n+$/u)?.[0].length ?? 0
  const end = Math.max(leading, text.length - trailing)
  return {
    text: text.slice(leading, end),
    segments: segments.flatMap((segment) => {
      const clippedStart = Math.max(segment.start, leading)
      const clippedEnd = Math.min(segment.end, end)
      if (clippedEnd <= clippedStart) return []
      return [{
        ...segment,
        start: clippedStart - leading,
        end: clippedEnd - leading,
        nodeStart: clippedStart - segment.start,
        nodeEnd: clippedEnd - segment.start,
      }]
    }),
  }
}

export function responseAnnotationSemanticText(root: HTMLElement): string {
  return projectSemanticText(root).text
}

export function responseAnnotationMatchesSource(
  annotation: ResponseAnnotation,
  rawSource: string,
  semanticSource: string,
): boolean {
  if (responseAnnotationSourceHash(rawSource) !== annotation.sourceHash) return false
  if (annotation.start < 0 || annotation.end <= annotation.start || annotation.end > semanticSource.length) return false
  if (semanticSource.slice(annotation.start, annotation.end) !== annotation.selectedText) return false
  const prefixStart = Math.max(0, annotation.start - annotation.prefix.length)
  if (semanticSource.slice(prefixStart, annotation.start) !== annotation.prefix) return false
  if (semanticSource.slice(annotation.end, annotation.end + annotation.suffix.length) !== annotation.suffix) return false
  return true
}

export function resolveResponseAnnotationSourceElement(
  annotation: ResponseAnnotation,
  searchRoot: ParentNode = document,
): HTMLElement | null {
  const candidates = Array.from(
    searchRoot.querySelectorAll<HTMLElement>('[data-response-annotation-source]'),
  ).filter((candidate) => {
    const rawSource = responseAnnotationRawSources.get(candidate)
    return rawSource !== undefined
      && responseAnnotationMatchesSource(annotation, rawSource, responseAnnotationSemanticText(candidate))
  })
  const exact = candidates.filter(candidate => candidate.dataset.messageId === annotation.sourceMessageId)
  if (exact.length === 1) return exact[0]
  return candidates.length === 1 ? candidates[0] : null
}

function semanticOffsetForBoundary(
  root: HTMLElement,
  container: Node,
  offset: number,
  edge: 'start' | 'end',
): number | null {
  const projection = projectSemanticText(root)
  const atSegmentStart = (segmentIndex: number) => {
    const segment = projection.segments[segmentIndex]
    const previous = projection.segments[segmentIndex - 1]
    return edge === 'end' && previous && previous.end < segment.start
      ? previous.end
      : segment.start
  }
  const atSegmentEnd = (segmentIndex: number) => {
    const segment = projection.segments[segmentIndex]
    const next = projection.segments[segmentIndex + 1]
    return edge === 'start' && next && next.start > segment.end
      ? next.start
      : segment.end
  }
  if (container.nodeType === Node.TEXT_NODE) {
    const segmentIndex = projection.segments.findIndex(candidate => candidate.node === container)
    const segment = projection.segments[segmentIndex]
    if (!segment) return null
    const nodeOffset = Math.max(segment.nodeStart, Math.min(segment.nodeEnd, offset))
    if (nodeOffset === segment.nodeStart) return atSegmentStart(segmentIndex)
    if (nodeOffset === segment.nodeEnd) return atSegmentEnd(segmentIndex)
    return segment.start + nodeOffset - segment.nodeStart
  }
  if (!(container instanceof Element || container instanceof DocumentFragment)) return null

  const child = container.childNodes[offset] ?? null
  if (child) {
    const nextIndex = projection.segments.findIndex(segment => child === segment.node || (child instanceof Element && child.contains(segment.node)))
    if (nextIndex >= 0) return atSegmentStart(nextIndex)
  }
  const previous = offset > 0 ? container.childNodes[offset - 1] ?? null : null
  if (previous) {
    const priorIndex = projection.segments.findLastIndex(
      segment => previous === segment.node || (previous instanceof Element && previous.contains(segment.node)),
    )
    if (priorIndex >= 0) return atSegmentEnd(priorIndex)
  }
  if (container === root && offset === 0) return 0
  if (container === root && offset === root.childNodes.length) return projection.text.length
  return null
}

export interface ResolvedResponseAnnotationRange {
  selectedText: string
  start: number
  end: number
  prefix: string
  suffix: string
}

export function resolveResponseAnnotationRange(
  root: HTMLElement,
  range: Range,
  contextLength = 48,
): ResolvedResponseAnnotationRange | null {
  if (range.collapsed) return null
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null
  const start = semanticOffsetForBoundary(root, range.startContainer, range.startOffset, 'start')
  const end = semanticOffsetForBoundary(root, range.endContainer, range.endOffset, 'end')
  if (start === null || end === null || end <= start) return null
  const source = responseAnnotationSemanticText(root)
  const selectedText = source.slice(start, end)
  if (!selectedText.trim()) return null
  return {
    selectedText,
    start,
    end,
    prefix: source.slice(Math.max(0, start - contextLength), start),
    suffix: source.slice(end, end + contextLength),
  }
}

function boundaryForOffset(
  root: HTMLElement,
  offset: number,
  edge: 'start' | 'end',
): { container: Node; offset: number } | null {
  const projection = projectSemanticText(root)
  if (offset < 0 || offset > projection.text.length) return null
  for (const segment of projection.segments) {
    if (offset >= segment.start && offset <= segment.end) {
      return {
        container: segment.node,
        offset: Math.max(
          segment.nodeStart,
          Math.min(segment.nodeEnd, segment.nodeStart + offset - segment.start),
        ),
      }
    }
  }
  if (edge === 'start') {
    const next = projection.segments.find(segment => segment.start > offset)
    if (next) return { container: next.node, offset: 0 }
  } else {
    const previous = [...projection.segments].reverse().find(segment => segment.end < offset)
    if (previous) return { container: previous.node, offset: previous.node.data.length }
  }
  return null
}

export function restoreResponseAnnotationRange(
  root: HTMLElement,
  start: number,
  end: number,
): Range | null {
  if (end <= start) return null
  const startBoundary = boundaryForOffset(root, start, 'start')
  const endBoundary = boundaryForOffset(root, end, 'end')
  if (!startBoundary || !endBoundary) return null
  const range = document.createRange()
  try {
    range.setStart(startBoundary.container, startBoundary.offset)
    range.setEnd(endBoundary.container, endBoundary.offset)
  } catch {
    return null
  }
  return range.collapsed ? null : range
}
