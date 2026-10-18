import { describe, expect, it } from 'vitest'
import { performance } from 'node:perf_hooks'

import { countTextTokens } from '../../packages/ekko-agent/src/model/tokens'

describe('Ekko model token estimation', () => {
  it('keeps oversized estimation work bounded independently of input length', () => {
    const small = 'a'.repeat(8 * 1024 * 1024)
    const large = 'a'.repeat(128 * 1024 * 1024)
    const smallStart = performance.now()
    countTextTokens(small)
    const smallMs = performance.now() - smallStart
    const largeStart = performance.now()
    const largeTokens = countTextTokens(large)
    const largeMs = performance.now() - largeStart

    expect(largeTokens).toBe(large.length * 3)
    expect(largeMs).toBeLessThan(Math.max(100, smallMs * 4))
  })

  it('never underestimates fallback text relative to exact UTF-8 tokenization', async () => {
    const { getEncoding } = await import('js-tiktoken')
    const encoder = getEncoding('cl100k_base')
    for (const unit of ['a', '汉', '\u2E80', '\uD7AF', '\uFFEF', '😀']) {
      const text = `${unit} `.repeat(2_001)
      expect(countTextTokens(text)).toBeGreaterThanOrEqual(encoder.encode(text).length)
    }
  })

  it.each([
    ['punctuation', '!'],
    ['digits', '7'],
    ['symbols', '*'],
    ['whitespace', ' '],
  ])('does not hang on a long contiguous %s run (quadratic BPE guard)', (_label, ch) => {
    // pat_str merges contiguous digits, symbols, and whitespace into single
    // pieces too, so non-letter runs are equally pathological. A real 64 KB
    // run of '!' cost ~188 s per encode() and wedged the event loop; the
    // guard must route it to the O(n) heuristic. 30k is past the 2000 bound.
    const poison = ch.repeat(30000)
    const start = performance.now()
    const tokens = countTextTokens(poison)
    const elapsedMs = performance.now() - start
    expect(tokens).toBeGreaterThan(0)
    expect(elapsedMs).toBeLessThan(250)
  })
})