/**
 * Knowledge plugin — content-aware text chunker.
 *
 * Two modes:
 *   - 'markdown': split at heading boundaries (##, ###). If a section
 *     exceeds `chunkFallbackSize` tokens, re-split at paragraph breaks.
 *   - 'plaintext': sliding window of `chunkSize` tokens with
 *     `chunkOverlap` tokens of overlap between consecutive windows.
 *
 * Token counting uses `js-tiktoken` / `cl100k_base` (audit fix P2-8).
 * Every chunk carries `contentHash = sha256(content)` so re-indexing
 * can detect drift without re-embedding unchanged chunks.
 *
 * Empty input produces an empty array (not an error) — the caller
 * treats zero chunks as a metadata-only document (§10.2).
 */

import { createHash } from 'crypto'
import { getEncoding, type Tiktoken } from 'js-tiktoken'

// --- Public types --------------------------------------------------------

export interface Chunk {
  content: string
  tokenCount: number
  contentHash: string
}

export type ChunkKind = 'markdown' | 'plaintext'

export interface ChunkConfig {
  /** Plain-text window size in tokens. Default 500. */
  chunkSize: number
  /** Tokens shared between consecutive plaintext windows. Default 50. */
  chunkOverlap: number
  /**
   * Markdown section overflow threshold. If a single heading section
   * exceeds this, it is split at paragraph boundaries. Default 800.
   * Must be >= chunkSize (enforced at construction).
   */
  chunkFallbackSize: number
}

export const DEFAULT_CHUNK_CONFIG: ChunkConfig = {
  chunkSize: 500,
  chunkOverlap: 50,
  chunkFallbackSize: 800,
}

// --- Tokenizer singleton -------------------------------------------------

let _encoder: Tiktoken | null = null

function encoder(): Tiktoken {
  if (!_encoder) _encoder = getEncoding('cl100k_base')
  return _encoder
}

function countTokens(text: string): number {
  if (!text) return 0
  return encoder().encode(text).length
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function makeChunk(content: string): Chunk {
  return {
    content,
    tokenCount: countTokens(content),
    contentHash: hashContent(content),
  }
}

// --- Markdown ------------------------------------------------------------

const HEADING_RE = /^(#{1,6})\s+(.*)$/m

/**
 * Split Markdown at heading boundaries. A heading of level 1-6 opens
 * a new section; the section body extends until the next heading or
 * end-of-string.
 *
 * If a section exceeds `fallbackSize` tokens, split it at paragraph
 * boundaries (`/\n\n+/`). Paragraphs are greedy: each paragraph that
 * itself exceeds `fallbackSize` is emitted as-is (with a truncation
 * marker added by the orchestrator, not here — the chunker only emits
 * whole paragraphs).
 */
function chunkMarkdown(
  text: string,
  fallbackSize: number
): Chunk[] {
  const sections = splitByHeadings(text)
  const chunks: Chunk[] = []

  for (const section of sections) {
    const tokens = countTokens(section)
    if (tokens <= fallbackSize) {
      if (section.trim()) chunks.push(makeChunk(section.trim()))
    } else {
      // Oversized section → split at paragraph boundaries.
      const paragraphs = splitByParagraphs(section)
      let buffer = ''
      for (const para of paragraphs) {
        const candidate = buffer ? `${buffer}\n\n${para}` : para
        if (countTokens(candidate) > fallbackSize && buffer) {
          if (buffer.trim()) chunks.push(makeChunk(buffer.trim()))
          buffer = para
        } else {
          buffer = candidate
        }
      }
      if (buffer.trim()) chunks.push(makeChunk(buffer.trim()))
    }
  }

  return chunks
}

function splitByHeadings(text: string): string[] {
  const lines = text.split('\n')
  const sections: string[] = []
  let current: string[] = []

  for (const line of lines) {
    if (HEADING_RE.test(line) && current.length > 0) {
      sections.push(current.join('\n'))
      current = [line]
    } else {
      current.push(line)
    }
  }
  if (current.length > 0) sections.push(current.join('\n'))

  // If there were no headings, treat the entire text as one section.
  return sections.length > 0 ? sections : [text]
}

function splitByParagraphs(text: string): string[] {
  return text
    .split(/\n\n+/)
    .map(p => p.trim())
    .filter(p => p.length > 0)
}

// --- Plain text ----------------------------------------------------------

/**
 * Sliding window of `chunkSize` tokens with `chunkOverlap` tokens of
 * overlap. Window boundaries are computed in token-space so the
 * result is deterministic regardless of character widths.
 *
 * Empty input returns an empty array.
 */
function chunkPlainText(
  text: string,
  chunkSize: number,
  chunkOverlap: number
): Chunk[] {
  if (!text.trim()) return []

  const enc = encoder()
  const tokens = enc.encode(text)
  if (tokens.length === 0) return []

  const chunks: Chunk[] = []
  let start = 0
  while (start < tokens.length) {
    const end = Math.min(start + chunkSize, tokens.length)
    const windowTokens = tokens.slice(start, end)
    // Decode the token window back to text. js-tiktoken's decode()
    // returns a string directly.
    const content = enc.decode(windowTokens)
    if (content.trim()) {
      chunks.push(makeChunk(content))
    }
    if (end >= tokens.length) break
    // Advance by (chunkSize - chunkOverlap); if overlap >= size, just
    // advance by 1 to guarantee forward progress.
    const step = Math.max(1, chunkSize - chunkOverlap)
    start += step
  }

  return chunks
}

// --- Entry point ---------------------------------------------------------

/**
 * Chunk the given text according to the declared kind and config.
 * Returns chunks in document order.
 */
export function chunkText(
  text: string,
  kind: ChunkKind = 'plaintext',
  config: Partial<ChunkConfig> = {}
): Chunk[] {
  const cfg = { ...DEFAULT_CHUNK_CONFIG, ...config }
  if (cfg.chunkOverlap >= cfg.chunkSize / 2) {
    throw new Error(
      `chunkOverlap (${cfg.chunkOverlap}) must be less than ` +
        `chunkSize/2 (${cfg.chunkSize / 2})`
    )
  }
  if (cfg.chunkFallbackSize < cfg.chunkSize) {
    throw new Error(
      `chunkFallbackSize (${cfg.chunkFallbackSize}) must be ` +
        `>= chunkSize (${cfg.chunkSize})`
    )
  }

  if (!text.trim()) return []

  if (kind === 'markdown') {
    return chunkMarkdown(text, cfg.chunkFallbackSize)
  }
  return chunkPlainText(text, cfg.chunkSize, cfg.chunkOverlap)
}
