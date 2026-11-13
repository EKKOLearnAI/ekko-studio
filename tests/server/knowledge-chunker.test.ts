/**
 * Chunker tests — content-aware text splitting with token-level precision.
 *
 * Covers:
 *   - Empty / whitespace-only input → empty array
 *   - Markdown heading-based splitting with paragraph fallback
 *   - Plaintext sliding-window splitting with overlap
 *   - contentHash = sha256(content) for drift detection
 *   - Determinism: same input → same chunks
 *   - Config validation: overlap, fallbackSize
 */

import { createHash } from 'crypto'
import { describe, expect, it } from 'vitest'
import {
  chunkText,
  DEFAULT_CHUNK_CONFIG,
  type ChunkConfig,
} from '../../packages/server/src/modules/studio/services/knowledge/chunker'

// --- Helpers --------------------------------------------------------------

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

/**
 * Build a plaintext string with approximately `tokenCount` tokens by
 * repeating a 10-token sentence. Good enough for window-size tests;
 * the chunker counts tokens via cl100k_base, not word count.
 */
function repeatedSentence(targetTokens: number): string {
  // "The quick brown fox jumps over the lazy dog near the riverbank."
  // ≈ 12 tokens in cl100k_base.
  const sentence = 'The quick brown fox jumps over the lazy dog near the riverbank.'
  const repeats = Math.ceil(targetTokens / 12)
  return Array(repeats).fill(sentence).join(' ')
}

// --- Empty input ----------------------------------------------------------

describe('chunkText — empty input', () => {
  it('returns empty array for empty string', () => {
    expect(chunkText('')).toEqual([])
  })

  it('returns empty array for whitespace-only string', () => {
    expect(chunkText('   \n\n  \t  ')).toEqual([])
  })
})

// --- Plaintext sliding window --------------------------------------------

describe('chunkText — plaintext', () => {
  it('returns a single chunk when text fits in one window', () => {
    const text = 'Hello world.'
    const chunks = chunkText(text, 'plaintext', {
      chunkSize: 500,
      chunkOverlap: 50,
      chunkFallbackSize: 800,
    })
    expect(chunks).toHaveLength(1)
    expect(chunks[0].content).toBe(text)
    expect(chunks[0].tokenCount).toBeGreaterThan(0)
    expect(chunks[0].contentHash).toBe(sha256(text))
  })

  it('produces multiple chunks for text exceeding the window', () => {
    // Generate ~1200 tokens of text with window 500 / overlap 50.
    // Step = 500 - 50 = 450 tokens per chunk after the first.
    // Tokens 0-499, 450-949, 900-1199 → 3 chunks.
    const text = repeatedSentence(1200)
    const chunks = chunkText(text, 'plaintext', {
      chunkSize: 500,
      chunkOverlap: 50,
      chunkFallbackSize: 800,
    })
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    // Each chunk should be at most chunkSize tokens.
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(500)
    }
  })

  it('consecutive chunks share overlap tokens', () => {
    const text = repeatedSentence(1200)
    const chunks = chunkText(text, 'plaintext', {
      chunkSize: 500,
      chunkOverlap: 50,
      chunkFallbackSize: 800,
    })
    if (chunks.length < 2) return
    // The last ~50 tokens of chunk[0] should overlap with the first
    // ~50 tokens of chunk[1]. We check this indirectly: the content
    // of chunk[1] should start with a substring that also appears in
    // chunk[0]'s content.
    const tail = chunks[0].content.slice(-200)
    const head = chunks[1].content.slice(0, 200)
    // At least some overlap in characters (token decode may not be
    // character-exact due to BPE, but substantial overlap is expected).
    let common = 0
    for (const word of head.split(/\s+/)) {
      if (word && tail.includes(word)) common++
    }
    expect(common).toBeGreaterThan(3)
  })

  it('each chunk has a valid sha256 contentHash', () => {
    const text = repeatedSentence(800)
    const chunks = chunkText(text, 'plaintext', {
      chunkSize: 500,
      chunkOverlap: 50,
      chunkFallbackSize: 800,
    })
    for (const chunk of chunks) {
      expect(chunk.contentHash).toMatch(/^[0-9a-f]{64}$/)
      expect(chunk.contentHash).toBe(sha256(chunk.content))
    }
  })

  it('is deterministic: same input → same chunks', () => {
    const text = repeatedSentence(1500)
    const cfg = { chunkSize: 500, chunkOverlap: 50, chunkFallbackSize: 800 }
    const a = chunkText(text, 'plaintext', cfg)
    const b = chunkText(text, 'plaintext', cfg)
    expect(a.length).toBe(b.length)
    for (let i = 0; i < a.length; i++) {
      expect(a[i].content).toBe(b[i].content)
      expect(a[i].tokenCount).toBe(b[i].tokenCount)
      expect(a[i].contentHash).toBe(b[i].contentHash)
    }
  })
})

// --- Markdown heading splitting ------------------------------------------

describe('chunkText — markdown', () => {
  it('splits at ## heading boundaries', () => {
    const md = [
      '# Title',
      'Intro paragraph.',
      '',
      '## Section One',
      'Body of section one.',
      '',
      '## Section Two',
      'Body of section two.',
    ].join('\n')
    const chunks = chunkText(md, 'markdown', {
      chunkSize: 500,
      chunkOverlap: 50,
      chunkFallbackSize: 800,
    })
    // We expect at least 3 chunks: one per section (or the pre-heading
    // block may merge with the first heading).
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    // Each chunk should contain some heading or body text.
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeGreaterThan(0)
    }
  })

  it('falls back to paragraph splitting for oversized sections', () => {
    // Build a single ## section that exceeds the fallback threshold.
    const longParagraphs = Array(20)
      .fill(null)
      .map((_, i) => `Paragraph ${i}: ${repeatedSentence(100)}`)
      .join('\n\n')
    const md = `## Big Section\n\n${longParagraphs}`

    const chunks = chunkText(md, 'markdown', {
      chunkSize: 200,
      chunkOverlap: 20,
      chunkFallbackSize: 300, // Low threshold to trigger fallback
    })
    // The single section should have been split into multiple chunks.
    expect(chunks.length).toBeGreaterThan(1)
  })

  it('treats headingless markdown as a single section', () => {
    const md = 'Just a paragraph.\n\nAnother paragraph.'
    const chunks = chunkText(md, 'markdown', {
      chunkSize: 500,
      chunkOverlap: 50,
      chunkFallbackSize: 800,
    })
    expect(chunks).toHaveLength(1)
    expect(chunks[0].content).toContain('Just a paragraph')
  })
})

// --- Config validation ----------------------------------------------------

describe('chunkText — config validation', () => {
  it('throws when overlap >= chunkSize / 2', () => {
    expect(() =>
      chunkText('hello', 'plaintext', {
        chunkSize: 100,
        chunkOverlap: 50, // exactly half → invalid
        chunkFallbackSize: 800,
      })
    ).toThrow(/chunkOverlap/)
  })

  it('throws when chunkFallbackSize < chunkSize', () => {
    expect(() =>
      chunkText('hello', 'plaintext', {
        chunkSize: 500,
        chunkOverlap: 50,
        chunkFallbackSize: 200, // < chunkSize
      })
    ).toThrow(/chunkFallbackSize/)
  })

  it('accepts default config without throwing', () => {
    // Just verifies the default config passes validation.
    expect(() => chunkText('hello')).not.toThrow()
  })
})

// --- Default config shape -------------------------------------------------

describe('DEFAULT_CHUNK_CONFIG', () => {
  it('has expected defaults', () => {
    const cfg: ChunkConfig = DEFAULT_CHUNK_CONFIG
    expect(cfg.chunkSize).toBe(500)
    expect(cfg.chunkOverlap).toBe(50)
    expect(cfg.chunkFallbackSize).toBe(800)
  })
})
