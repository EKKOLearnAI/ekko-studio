import { describe, expect, it } from 'vitest'
import {
  TOOL_RESULT_CONTEXT_HEAD_CHARS as HEAD,
  TOOL_RESULT_CONTEXT_LIMIT as LIMIT,
  TOOL_RESULT_CONTEXT_MARKER as MARKER,
  TOOL_RESULT_CONTEXT_TAIL_CHARS as TAIL,
  truncateToolResultForContext,
} from '../../packages/server/src/modules/studio/services/chat-run/tool-result-context'

const length = LIMIT + 1_000

function withPairAt(index: number, pair: string): string {
  return 'a'.repeat(index) + pair + 'z'.repeat(length - index - pair.length)
}

describe('tool result Unicode boundaries', () => {
  for (const point of [0x10000, 0x1f600, 0x10ffff]) {
    const pair = String.fromCodePoint(point)
    for (const boundary of ['head', 'tail'] as const) {
      for (const offset of [-2, -1, 0, 1]) {
        it(`preserves scalar validity at ${boundary} ${offset} for U+${point.toString(16)}`, () => {
          const cut = boundary === 'head' ? HEAD : length - TAIL
          const input = withPairAt(cut + offset, pair)
          expect(() => encodeURIComponent(input)).not.toThrow()
          const output = truncateToolResultForContext(input)
          // JSON itself allows escaped lone surrogates; this is a stricter scalar check.
          expect(JSON.parse(JSON.stringify(output))).toBe(output)
          expect(() => encodeURIComponent(output)).not.toThrow()
          expect(output.length).toBe(LIMIT - (offset === -1 ? 1 : 0))
          expect(output.split(MARKER)).toHaveLength(2)
        })
      }
    }
    it(`handles both cuts through U+${point.toString(16)} pairs`, () => {
      const input = 'a'.repeat(HEAD - 1) + pair
        + 'm'.repeat(length - TAIL - HEAD - 2) + pair + 'z'.repeat(TAIL - 1)
      expect(input).toHaveLength(length)
      expect(truncateToolResultForContext(input)).toBe('a'.repeat(HEAD - 1) + MARKER + 'z'.repeat(TAIL - 1))
    })
  }

  it.each(['', 'short 😀 text', 'x'.repeat(LIMIT), 'x'.repeat(LIMIT - 2) + '😀'])('leaves inputs within the budget unchanged', input => {
    expect(truncateToolResultForContext(input)).toBe(input)
  })

  it('preserves the original ASCII projection and marker exactly', () => {
    const input = '0123456789'.repeat(1_000)
    expect(truncateToolResultForContext(input)).toBe(input.slice(0, HEAD) + MARKER + input.slice(-TAIL))
    expect(truncateToolResultForContext(input)).toHaveLength(LIMIT)
  })

  it('does not expand the contract to grapheme-cluster truncation', () => {
    const input = 'a'.repeat(HEAD - 1) + 'e\u0301' + 'z'.repeat(length - HEAD - 1)
    expect(truncateToolResultForContext(input)).toBe('a'.repeat(HEAD - 1) + 'e' + MARKER + 'z'.repeat(TAIL))
  })
})
