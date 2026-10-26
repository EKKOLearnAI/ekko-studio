import { describe, it, expect } from 'vitest'
import { parseThinking, countThinkingChars, detectThinkingBoundary } from '@/utils/thinking-parser'

describe('parseThinking', () => {
  it('splits a single closed <think> block from body', () => {
    const r = parseThinking('<think>inner</think>body', { streaming: false })
    expect(r.segments).toEqual(['inner'])
    expect(r.body).toBe('body')
    expect(r.pending).toBeNull()
    expect(r.hasThinking).toBe(true)
  })

  it('collects multiple closed blocks in order', () => {
    const r = parseThinking('<think>a</think>mid<thinking>b</thinking>end', { streaming: false })
    expect(r.segments).toEqual(['a', 'b'])
    expect(r.body).toBe('midend')
  })

  it('supports <thinking> and <reasoning> variants', () => {
    const r = parseThinking('<reasoning>r</reasoning>body', { streaming: false })
    expect(r.segments).toEqual(['r'])
    expect(r.body).toBe('body')
  })

  it('is case-insensitive on tag names', () => {
    const r = parseThinking('<Think>x</Think><REASONING>y</REASONING>z', { streaming: false })
    expect(r.segments).toEqual(['x', 'y'])
    expect(r.body).toBe('z')
  })

  it('returns hasThinking=false and body unchanged for plain text', () => {
    const r = parseThinking('hello world', { streaming: false })
    expect(r.hasThinking).toBe(false)
    expect(r.body).toBe('hello world')
    expect(r.segments).toEqual([])
  })

  it('returns hasThinking=false for empty content', () => {
    const r = parseThinking('', { streaming: false })
    expect(r.hasThinking).toBe(false)
    expect(r.body).toBe('')
  })

  it('treats trailing unclosed tag as pending when streaming', () => {
    const r = parseThinking('body<think>in-progress', { streaming: true })
    expect(r.pending).toBe('in-progress')
    expect(r.body).toBe('body')
    expect(r.segments).toEqual([])
    expect(r.hasThinking).toBe(true)
  })

  it('degrades trailing unclosed tag to body when NOT streaming (terminal state)', () => {
    const r = parseThinking('body<think>orphan', { streaming: false })
    expect(r.pending).toBeNull()
    expect(r.body).toBe('body<think>orphan')
    expect(r.segments).toEqual([])
    expect(r.hasThinking).toBe(false)
  })

  it.each(['think', 'thinking', 'reasoning', 'THINKING'])('keeps an unclosed leading <%s> block out of the settled body', (tag) => {
    const content = `\n\n <${tag}>private reasoning`
    const streaming = parseThinking(content, { streaming: true })
    expect(parseThinking(content, { streaming: false })).toEqual(streaming)
    expect(streaming.body.trim()).toBe('')
    expect(streaming.pending).toBe('private reasoning')
    expect(streaming.hasThinking).toBe(true)
  })

  it('recognizes a settled tag-only leading block', () => {
    expect(parseThinking('\n <thinking> ', { streaming: false })).toEqual({
      segments: [], pending: ' ', body: '\n ', hasThinking: true,
    })
  })

  it('preserves an unclosed thinking tag quoted in code', () => {
    for (const content of ['`<thinking>example`', '```text\n<thinking>example\n```']) {
      expect(parseThinking(content, { streaming: false }).body).toBe(content)
      expect(parseThinking(content, { streaming: false }).hasThinking).toBe(false)
    }
  })

  it('combines closed segments with trailing pending (streaming)', () => {
    const r = parseThinking('<think>done</think>mid<thinking>now', { streaming: true })
    expect(r.segments).toEqual(['done'])
    expect(r.pending).toBe('now')
    expect(r.body).toBe('mid')
  })

  it('does NOT recognize <think> inside fenced code block', () => {
    const src = 'before\n```\n<think>fake</think>\n```\nafter'
    const r = parseThinking(src, { streaming: false })
    expect(r.hasThinking).toBe(false)
    expect(r.body).toBe(src)
  })

  it('does NOT recognize <think> inside tilde-fenced code block', () => {
    const src = '~~~\n<think>fake</think>\n~~~'
    const r = parseThinking(src, { streaming: false })
    expect(r.hasThinking).toBe(false)
    expect(r.body).toBe(src)
  })

  it('does NOT recognize <think> inside inline code', () => {
    const src = 'the tag `<think>x</think>` is a literal'
    const r = parseThinking(src, { streaming: false })
    expect(r.hasThinking).toBe(false)
    expect(r.body).toBe(src)
  })

  it('parses real <think> outside code blocks even when code blocks contain fake ones', () => {
    const src = '<think>real</think>text\n```\n<think>fake</think>\n```'
    const r = parseThinking(src, { streaming: false })
    expect(r.segments).toEqual(['real'])
    expect(r.body).toBe('text\n```\n<think>fake</think>\n```')
  })

  it('does not leak code-protection placeholders for inline mentions of markdown fences', () => {
    const src = [
      'Previous fix kept the outer ` ```md ` block as code.',
      '',
      '````md',
      '下面是可直接手动编辑的 PR draft。',
      '```md',
      '标题',
      '```',
      '````',
    ].join('\n')
    const r = parseThinking(src, { streaming: false })
    expect(r.hasThinking).toBe(false)
    expect(r.body).toBe(src)
    expect(r.body).not.toContain('THKCODE')
    expect(r.body).not.toContain('\u0000')
  })

  it('same-name nesting: inner tag absorbed into first segment (documented limitation)', () => {
    const r = parseThinking('<think>a<think>b</think>c</think>', { streaming: false })
    expect(r.segments).toEqual(['a<think>b'])
    expect(r.body).toBe('c</think>')
  })

  it('handles chunk boundary: partial opening tag not yet identified', () => {
    const mid = parseThinking('<thin', { streaming: true })
    expect(mid.hasThinking).toBe(false)
    expect(mid.body).toBe('<thin')

    const after = parseThinking('<think>hi</think>done', { streaming: true })
    expect(after.segments).toEqual(['hi'])
    expect(after.body).toBe('done')
  })
})

describe('countThinkingChars', () => {
  it('counts all segments + pending as Unicode chars', () => {
    const n = countThinkingChars({
      segments: ['abc', '你好'],
      pending: '🎉!',
      body: '',
      hasThinking: true,
    })
    expect(n).toBe(7)
  })

  it('returns 0 when no thinking', () => {
    expect(countThinkingChars({ segments: [], pending: null, body: 'x', hasThinking: false })).toBe(0)
  })
})

describe('detectThinkingBoundary', () => {
  it('detects first appearance of opening tag', () => {
    const r = detectThinkingBoundary('', '<think>x')
    expect(r.startedAtBoundary).toBe(true)
    expect(r.endedAtBoundary).toBe(false)
  })

  it('detects first appearance of closing tag', () => {
    const r = detectThinkingBoundary('<think>hi', '<think>hi</think>')
    expect(r.startedAtBoundary).toBe(false)
    expect(r.endedAtBoundary).toBe(true)
  })

  it('detects both when both emerge in one delta', () => {
    const r = detectThinkingBoundary('', '<think>x</think>')
    expect(r.startedAtBoundary).toBe(true)
    expect(r.endedAtBoundary).toBe(true)
  })

  it('reports no boundary when neither crossed', () => {
    const r = detectThinkingBoundary('abc', 'abcdef')
    expect(r.startedAtBoundary).toBe(false)
    expect(r.endedAtBoundary).toBe(false)
  })

  it('ignores fake tags inside code blocks', () => {
    const r = detectThinkingBoundary('', '```\n<think>fake</think>\n```')
    expect(r.startedAtBoundary).toBe(false)
    expect(r.endedAtBoundary).toBe(false)
  })

  it('is idempotent for repeated open/close after initial', () => {
    const r = detectThinkingBoundary(
      '<think>a</think><think>b',
      '<think>a</think><think>b</think>',
    )
    expect(r.startedAtBoundary).toBe(false)
    expect(r.endedAtBoundary).toBe(false)
  })
})
