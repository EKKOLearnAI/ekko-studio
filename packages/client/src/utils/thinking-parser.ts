export interface ParsedThinking {
  segments: string[]
  pending: string | null
  body: string
  hasThinking: boolean
}

export interface ParseOptions {
  streaming: boolean
}

const TAG_RE = /<(think|thinking|reasoning)>([\s\S]*?)<\/\1>/gi

const PLACEHOLDER_PREFIX = '\u0000THKCODE'
const PLACEHOLDER_SUFFIX = '\u0000'

const FENCED_RE = /(^|\n)( {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\2\3[ \t]*(?=\n|$)/g
const INLINE_CODE_RE = /`[^`\n]*`/g

function protectCodeBlocks(input: string): { masked: string; blocks: string[] } {
  const blocks: string[] = []
  let masked = input.replace(FENCED_RE, (m) => {
    blocks.push(m)
    return `${PLACEHOLDER_PREFIX}${blocks.length - 1}${PLACEHOLDER_SUFFIX}`
  })
  masked = masked.replace(INLINE_CODE_RE, (m) => {
    blocks.push(m)
    return `${PLACEHOLDER_PREFIX}${blocks.length - 1}${PLACEHOLDER_SUFFIX}`
  })
  return { masked, blocks }
}

function restoreCodeBlocks(text: string, blocks: string[]): string {
  if (blocks.length === 0) return text

  const placeholderRe = new RegExp(`${PLACEHOLDER_PREFIX}(\\d+)${PLACEHOLDER_SUFFIX}`, 'g')
  let restored = text

  for (let i = 0; i < blocks.length; i += 1) {
    const next = restored.replace(
      placeholderRe,
      (_, idx) => blocks[Number(idx)] ?? '',
    )
    if (next === restored) break
    restored = next
  }

  return restored
}

export function parseThinking(content: string, opts: ParseOptions): ParsedThinking {
  const { masked, blocks } = protectCodeBlocks(content)

  const segments: string[] = []
  let pending: string | null = null
  let body = ''
  let lastIndex = 0

  TAG_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TAG_RE.exec(masked)) !== null) {
    body += masked.slice(lastIndex, m.index)
    segments.push(m[2])
    lastIndex = m.index + m[0].length
  }
  const rest = masked.slice(lastIndex)

  const openRe = /<(think|thinking|reasoning)>([\s\S]*)$/i
  const openMatch = rest.match(openRe)
  if (openMatch) {
    body += rest.slice(0, openMatch.index)
    if (opts.streaming || (lastIndex === 0 && body.trim() === '')) {
      pending = openMatch[2]
    } else {
      body += rest.slice(openMatch.index!)
    }
  } else {
    body += rest
  }

  return {
    segments: segments.map(s => restoreCodeBlocks(s, blocks)),
    pending: pending === null ? null : restoreCodeBlocks(pending, blocks),
    body: restoreCodeBlocks(body, blocks),
    hasThinking: segments.length > 0 || pending !== null,
  }
}

export function countThinkingChars(parsed: ParsedThinking): number {
  const len = (s: string) => [...s].length
  return parsed.segments.reduce((a, s) => a + len(s), 0) + len(parsed.pending || '')
}

export interface ThinkingBoundary {
  startedAtBoundary: boolean
  endedAtBoundary: boolean
}

const ANY_OPEN_RE = /<(think|thinking|reasoning)>/i
const ANY_CLOSE_RE = /<\/(think|thinking|reasoning)>/i

export function detectThinkingBoundary(prev: string, next: string): ThinkingBoundary {
  const prevMasked = protectCodeBlocks(prev).masked
  const nextMasked = protectCodeBlocks(next).masked
  return {
    startedAtBoundary: !ANY_OPEN_RE.test(prevMasked) && ANY_OPEN_RE.test(nextMasked),
    endedAtBoundary: !ANY_CLOSE_RE.test(prevMasked) && ANY_CLOSE_RE.test(nextMasked),
  }
}
