/**
 * Knowledge plugin — text extractor registry.
 *
 * Dispatches file extraction by lowercased extension. Unknown
 * extensions return a sentinel result (empty text, zero tokens) —
 * the caller treats those as metadata-only documents (architecture
 * doc §10.2: "Unsupported file type → metadata-only row, status=indexed").
 *
 * Token counting uses `js-tiktoken` with the `cl100k_base` encoding
 * (audit fix P2-8). No ad-hoc heuristics.
 *
 * Error contract: every extractor throws `ExtractError` on failure.
 * The orchestrator (Task 6) maps `kind: 'corrupt'` to
 * `status=failed, error=extract:<kind>` in the DB row.
 */

import { extname } from 'path'
import { getEncoding, type Tiktoken } from 'js-tiktoken'

// --- Public types --------------------------------------------------------

export interface ExtractResult {
  text: string
  tokenCount: number
}

export type ExtractErrorKind =
  | 'corrupt'
  | 'unsupported'
  | 'io'
  | 'unknown'

export class ExtractError extends Error {
  readonly kind: ExtractErrorKind
  readonly cause?: unknown

  constructor(kind: ExtractErrorKind, message: string, cause?: unknown) {
    super(message)
    this.name = 'ExtractError'
    this.kind = kind
    this.cause = cause
  }
}

export type Extractor = (path: string) => Promise<ExtractResult>

// --- Tokenizer singleton -------------------------------------------------

let _encoder: Tiktoken | null = null

function encoder(): Tiktoken {
  if (!_encoder) {
    _encoder = getEncoding('cl100k_base')
  }
  return _encoder
}

export function countTokens(text: string): number {
  if (!text) return 0
  return encoder().encode(text).length
}

// --- Registry ------------------------------------------------------------

const registry = new Map<string, Extractor>()

export function registerExtractor(ext: string, extractor: Extractor): void {
  registry.set(ext.toLowerCase(), extractor)
}

export function getExtractor(ext: string): Extractor | undefined {
  return registry.get(ext.toLowerCase())
}

/**
 * Extract text from a file at the given path.
 *
 * Unknown extension → `{ text: '', tokenCount: 0 }` (metadata-only).
 * Corrupt or unreadable → throws `ExtractError`.
 */
export async function extract(path: string): Promise<ExtractResult> {
  const ext = extname(path).toLowerCase()
  const fn = registry.get(ext)
  if (!fn) {
    return { text: '', tokenCount: 0 }
  }
  return fn(path)
}

// --- Wire up v1 extractors -----------------------------------------------

// Lazy imports — each extractor module is loaded once, on first call.
// This avoids pulling pdfjs-dist / jszip into memory until needed.

async function loadMarkdown(): Promise<Extractor> {
  const mod = await import('./markdown')
  return mod.extractMarkdown
}

async function loadText(): Promise<Extractor> {
  const mod = await import('./text')
  return mod.extractText
}

async function loadPdf(): Promise<Extractor> {
  const mod = await import('./pdf')
  return mod.extractPdf
}

async function loadDocx(): Promise<Extractor> {
  const mod = await import('./docx')
  return mod.extractDocx
}

// Register the four v1 extractors. The wrapper functions lazily load
// the implementation modules on first call, so server boot stays fast.
registerExtractor('.md', (p) => loadMarkdown().then(fn => fn(p)))
registerExtractor('.markdown', (p) => loadMarkdown().then(fn => fn(p)))
registerExtractor('.txt', (p) => loadText().then(fn => fn(p)))
registerExtractor('.pdf', (p) => loadPdf().then(fn => fn(p)))
registerExtractor('.docx', (p) => loadDocx().then(fn => fn(p)))
