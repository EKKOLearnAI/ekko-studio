/**
 * FTS5 tokenizer helper for CJK text.
 *
 * FTS5's `porter` tokenizer splits on whitespace/punctuation then
 * applies English stemming. For CJK ideographs, porter treats each
 * character as an isolated token — useless for multi-character word
 * matching. We pre-process CJK text into 2-character sliding windows
 * (bigrams) separated by spaces. After porter tokenization, each
 * bigram becomes a single FTS token:
 *
 *   "深圳今天的天气" → "深圳 圳今 今天 天今 天气"
 *   Query "深圳"     → matches the first bigram.
 *
 * Non-CJK text passes through unchanged (whitespace split).
 * Mixed text is handled per-run: CJK runs get bigrams, non-CJK runs
 * are kept as-is.
 *
 * This file is imported by both the write path (insertChunks) and
 * the read path (buildFtsQuery) — both must apply the same
 * transformation for FTS5 MATCH to hit.
 */

// Unicode ranges for CJK ideographs:
//   \u2E80-\u2FDF  CJK Radicals Supplement + Kangxi Radicals
//   \u3040-\u31FF  Hiragana + Katakana + Bopomofo + CJK Symbols
//   \u3400-\u4DBF  CJK Unified Ideographs Extension A
//   \u4E00-\u9FFF  CJK Unified Ideographs (main block)
//   \uF900-\uFAFF  CJK Compatibility Ideographs
//
// This deliberately excludes Hangul syllables (\uAC00-\uD7AF) because
// Korean is typically searched by syllable blocks rather than bigrams.
// If Korean bigram support is needed later, extend the range.
const CJK_RE = /[\u2E80-\u2FDF\u3040-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/

/** True if the string contains at least one CJK ideograph. */
export function containsCjk(s: string): boolean {
  return CJK_RE.test(s)
}

/**
 * Tokenize text for FTS5 indexing/searching.
 *
 * Walks the string in runs: contiguous CJK chars produce (N-1) bigrams;
 * contiguous non-CJK chars are split on whitespace. Single CJK chars
 * (at string boundaries) are emitted as-is so they remain searchable.
 *
 * The returned tokens should be space-joined before inserting into the
 * FTS5 content column (write side) or used as-is for building the
 * MATCH query (read side).
 */
export function tokenizeForFts(text: string): string[] {
  const tokens: string[] = []
  let i = 0
  while (i < text.length) {
    if (CJK_RE.test(text[i])) {
      // CJK run — collect all contiguous CJK chars.
      const cjkStart = i
      while (i < text.length && CJK_RE.test(text[i])) i++
      const cjkRun = text.slice(cjkStart, i)
      if (cjkRun.length === 1) {
        // Single CJK char at boundary — emit as-is.
        tokens.push(cjkRun)
      } else {
        // 2-char sliding window.
        for (let j = 0; j < cjkRun.length - 1; j++) {
          tokens.push(cjkRun[j] + cjkRun[j + 1])
        }
      }
    } else {
      // Non-CJK run — collect until next CJK char.
      const nonCjkStart = i
      while (i < text.length && !CJK_RE.test(text[i])) i++
      const nonCjkRun = text.slice(nonCjkStart, i)
      const words = nonCjkRun.split(/\s+/).filter(w => w.length > 0)
      tokens.push(...words)
    }
  }
  return tokens
}

/**
 * Build an FTS5 MATCH query from user input.
 *
 * Applies `tokenizeForFts` so CJK queries produce bigrams that match
 * the bigram-indexed content. Strips FTS5 special characters that
 * could break the MATCH syntax (`"`, `*`, `(`, `)`, `^`, `~`, `+`, `-`).
 * Each token is quoted and tokens are joined with OR for max recall.
 */
export function buildFtsQuery(query: string): string {
  const MAX_TOKENS = 64
  const tokens = tokenizeForFts(query)
    .map(t => t.replace(/["*()^~+\-\\]/g, '').trim())
    .filter(t => t.length > 0)
    .slice(0, MAX_TOKENS)

  if (tokens.length === 0) return '""'
  return tokens.map(t => `"${t}"`).join(' OR ')
}
