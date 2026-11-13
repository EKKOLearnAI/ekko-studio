import { cleanTtsText } from '../voice/tts/providers/text'

const PARAGRAPH_END_RE = /[。！？!?.…][\s"'”’）)\]】》]*$/

export interface McuSpeechSegmenter {
  pushDelta(delta: string): string[]
  flush(): string | null
  reset(): void
}

export interface McuSpeechSegmenterOptions {
  maxChars?: number
}

export function normalizeMcuSpeechText(text: string): string {
  const withoutTables = text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/[^\s<>)\]]+/gi, ' ')
    .replace(/www\.[^\s<>)\]]+/gi, ' ')
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim()
      if (!trimmed) return true
      const pipeCount = (trimmed.match(/\|/g) || []).length
      if (pipeCount >= 2) return false
      if (/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(trimmed)) return false
      return true
    })
    .join('\n')

  return cleanTtsText(withoutTables)
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/[*_#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function paragraphEndsNormally(text: string): boolean {
  return PARAGRAPH_END_RE.test(text.trimEnd())
}

function findReadyParagraphBoundary(text: string): number {
  let inFence = false
  let inInlineCode = false
  let inLinkText = false
  let inLinkUrl = false
  let inUrl = false

  for (let i = 0; i < text.length; i += 1) {
    const rest = text.slice(i)

    if (rest.startsWith('```')) {
      inFence = !inFence
      i += 2
      continue
    }

    if (inFence) continue

    const char = text[i]

    if (char === '`') {
      inInlineCode = !inInlineCode
      continue
    }
    if (inInlineCode) continue

    if (inLinkUrl) {
      if (char === ')') inLinkUrl = false
      continue
    }

    if (inUrl) {
      if (/\s/.test(char)) inUrl = false
      else continue
    }

    if (rest.startsWith('http://') || rest.startsWith('https://') || rest.startsWith('www.')) {
      inUrl = true
      if (rest.startsWith('https://')) i += 7
      else if (rest.startsWith('http://')) i += 6
      else i += 3
      continue
    }
    if (inLinkText) {
      if (char === ']' && text[i + 1] === '(') {
        inLinkText = false
        inLinkUrl = true
        i += 1
      }
      continue
    }
    if (char === '[') {
      inLinkText = true
      continue
    }

    if (char === '\n' || char === '\r') {
      let end = i + 1
      if (char === '\r' && text[i + 1] === '\n') {
        end += 1
        i += 1
      }
      if (paragraphEndsNormally(text.slice(0, end))) return end
    }
  }

  return -1
}

export function createMcuSpeechSegmenter(options: McuSpeechSegmenterOptions = {}): McuSpeechSegmenter {
  void options
  let buffer = ''

  function takeReadySegments(force = false): string[] {
    const segments: string[] = []

    while (buffer.length > 0) {
      let end = findReadyParagraphBoundary(buffer)
      if (end < 0 && force) {
        end = buffer.length
      }
      if (end < 0) break

      const rawSegment = buffer.slice(0, end)
      buffer = buffer.slice(end)
      const segment = normalizeMcuSpeechText(rawSegment)
      if (segment) segments.push(segment)
    }

    return segments
  }

  return {
    pushDelta(delta: string) {
      if (!delta) return []
      buffer += delta
      return takeReadySegments(false)
    },
    flush() {
      const segments = takeReadySegments(true)
      return segments.length > 0 ? segments.join(' ') : null
    },
    reset() {
      buffer = ''
    },
  }
}
