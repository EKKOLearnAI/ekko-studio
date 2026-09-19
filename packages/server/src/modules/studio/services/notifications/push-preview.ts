import MarkdownIt from 'markdown-it'
import type Token from 'markdown-it/lib/token.mjs'

const markdown = new MarkdownIt({ html: true })
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function tokenText(tokens: Token[]): string {
  return tokens.map(token => {
    if (token.children) return tokenText(token.children)
    if (['text', 'code_inline', 'code_block', 'fence'].includes(token.type)) return token.content
    if (token.type === 'html_block' || token.type === 'html_inline') {
      return token.content.replace(/<[^>]*>/g, ' ')
    }
    return token.block || ['softbreak', 'hardbreak'].includes(token.type) ? ' ' : ''
  }).join('')
}

/** Build a single-line preview before transport; gateway enforces the limits too. */
export function pushPreview(value: unknown, limit: number, parseMarkdown = false): string {
  if (typeof value !== 'string') return ''
  const input = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, ' ')
  const source = parseMarkdown
    ? tokenText(markdown.parse(input.replace(/<!--[^]*?-->/g, '')
      .replace(/<(script|style)\b[^>]*>[^]*?<\/\1\s*>/gi, ''), {}))
    : input
  const text = source.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/gu, ' ').trim()
  let result = '', count = 0
  for (const { segment } of segmenter.segment(text)) {
    if (count++ >= limit) break
    result += segment
  }
  return result
}
