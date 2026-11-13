/**
 * Layer-① programmatic parser: encoding sniffing, structural chunking and
 * rule-based field extraction for group-chat large documents.
 * Spec: docs/planning/group-chat-large-doc-pipeline-spec.md §2 / §4.
 *
 * All output is mechanically verifiable (regex-driven); the AI reading layer
 * only confirms, never re-extracts from scratch.
 */
import { readFileSync } from 'fs'
import { extname } from 'path'
import { countTokens } from '../context-compressor'

export type GcDocType = 'contract' | 'judgment' | 'generic'
export type GcEncoding = 'utf-8' | 'gbk' | 'gb18030'

export interface ParsedChunk {
  chunk_id: string
  idx: number
  start_offset: number
  end_offset: number
  token_estimate: number
}

export interface ExtractedField {
  field_id: string
  chunk_id: string
  field_type: string
  value: string
  quote: string
  quote_offset: number
}

export interface ParseResult {
  text: string
  encoding: GcEncoding
  docType: GcDocType
  chunks: ParsedChunk[]
  fields: ExtractedField[]
}

// ─── Encoding sniffing ────────────────────────────────────────────────────

function sniffEncoding(buffer: Buffer): GcEncoding {
  // UTF-8 BOM
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return 'utf-8'
  }
  // Strict UTF-8 decode attempt
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    return 'utf-8'
  } catch {
    /* not valid utf-8, fall through */
  }
  // GB18030 is a superset of GBK; decode leniently and count replacement chars.
  const gb18030 = new TextDecoder('gb18030').decode(buffer)
  const replacementCount = (gb18030.match(/\uFFFD/g) || []).length
  const ratio = replacementCount / Math.max(1, gb18030.length)
  return ratio > 0.01 ? 'gbk' : 'gb18030'
}

// ─── File type detection ──────────────────────────────────────────────────

const CONTRACT_ANCHOR = /(第\s*[一二三四五六七八九十百千0-9]+\s*[条章节]|Article\s+\d+|第[一二三四五六七八九十]+[、条])/
const JUDGMENT_ANCHOR = /（\d{4}）[\u4e00-\u9fa5]{2,10}\d+号|判决如下|本院认为|案号/

export function detectDocType(text: string, _fileName?: string): GcDocType {
  const sample = text.slice(0, 20000)
  const judgmentHits = (sample.match(JUDGMENT_ANCHOR) || []).length
  const contractHits = (sample.match(CONTRACT_ANCHOR) || []).length
  if (judgmentHits > contractHits && judgmentHits > 0) return 'judgment'
  if (contractHits > 0) return 'contract'
  return 'generic'
}

// ─── Structural chunking ──────────────────────────────────────────────────

const STRUCTURAL_ANCHORS = [
  /第\s*[一二三四五六七八九十百千0-9]+\s*[条章节]/g,
  /第[一二三四五六七八九十]+[、]/g,
  /Article\s+\d+/gi,
]

/**
 * Split text into chunks. Prefer structural anchors (clause/chapter markers)
 * so boundaries land at semantically complete positions; fall back to a token
 * budget when the text has no anchors.
 *
 * Greedy algorithm: candidate cut points are [0, anchor starts..., text.length].
 * Walk them, accumulating into the current chunk; cut at the current cut point
 * as soon as adding the segment up to the NEXT cut point would exceed the
 * budget. A single oversized segment is hard-split by budget.
 */
export function chunkDocument(text: string, tokenBudget: number): ParsedChunk[] {
  const chunks: ParsedChunk[] = []
  const budgetInChars = Math.max(2000, Math.floor(tokenBudget * 4)) // ~4 chars/token

  // Collect + merge dense anchors (clause numbering often clusters).
  const markers: Array<{ index: number; end: number }> = []
  const seen = new Set<number>()
  for (const re of STRUCTURAL_ANCHORS) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      if (!seen.has(m.index)) {
        seen.add(m.index)
        markers.push({ index: m.index, end: m.index + m[0].length })
      }
      if (m.index === re.lastIndex) re.lastIndex++
    }
  }
  markers.sort((a, b) => a.index - b.index)
  const merged: Array<{ index: number; end: number }> = []
  for (const marker of markers) {
    const last = merged[merged.length - 1]
    if (last && marker.index - last.end < 40) {
      last.end = Math.max(last.end, marker.end)
    } else {
      merged.push({ index: marker.index, end: marker.end })
    }
  }

  const cutPoints = [0, ...merged.map((m) => m.index)]
  if (cutPoints[cutPoints.length - 1] !== text.length) cutPoints.push(text.length)

  const pushChunk = (from: number, to: number) => {
    const seg = text.slice(from, to)
    if (!seg.trim()) return
    chunks.push({
      chunk_id: `gcc_${chunks.length}_${from}`,
      idx: chunks.length,
      start_offset: from,
      end_offset: to,
      token_estimate: countTokens(seg),
    })
  }

  let from = 0
  for (let i = 0; i < cutPoints.length; i++) {
    const boundary = cutPoints[i]
    const nextBoundary = cutPoints[i + 1] ?? text.length
    if (boundary < from) continue
    if (nextBoundary - from > budgetInChars) {
      // Segment from `from` to the next cut point won't fit → cut at `boundary`.
      if (boundary - from > budgetInChars) {
        // Even this segment is oversized → hard-split by budget.
        for (let s = from; s < boundary; s += budgetInChars) {
          pushChunk(s, Math.min(boundary, s + budgetInChars))
        }
        from = boundary
      } else if (boundary > from) {
        pushChunk(from, boundary)
        from = boundary
      }
    }
    // else: keep accumulating into the current chunk.
  }
  if (from < text.length) {
    pushChunk(from, text.length)
  }
  return chunks
}

// ─── Rule-based field extraction ──────────────────────────────────────────

const AMOUNT_RE = /人民币\s*[¥￥]?\s*[\d,，]+(?:\.\d+)?\s*元|\d{1,3}(?:,\d{3})+(?:\.\d+)?\s*元|[¥￥]\s*\d[\d,，]*(?:\.\d+)?/g
const DATE_RE = /(20\d{2})\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日/g
const STATUTE_RE = /(《[^》]{1,40}》\s*第\s*[\d〇一二三四五六七八九十百千]+\s*条)/g
const PARTY_RE = /(甲方|乙方|丙方|原告|被告|申请人|被申请人|出卖人|买受人|出租人|承租人)[：:]\s*([^\s，。；;、\n]{2,30})/g

/**
 * Extract high-risk fields (amounts/dates/parties/statute refs) with regexes.
 * Each field carries a quote + offset for provenance; the AI layer later
 * confirms rather than re-extracts.
 */
/** Hard cap on rule-extracted fields per file. Dense generated contracts can
 *  otherwise produce millions of near-identical rows that bloat the DB and slow
 *  the aggregate report; a bounded sample is enough for risk review. */
const MAX_EXTRACTED_FIELDS = 4000

export function extractFields(text: string, chunks: ParsedChunk[]): ExtractedField[] {
  const fields: ExtractedField[] = []
  const rules: Array<[RegExp, string]> = [
    [AMOUNT_RE, 'amount'],
    [DATE_RE, 'date'],
    [STATUTE_RE, 'statute'],
    [PARTY_RE, 'party'],
  ]
  // Dedupe by (rule, absolute offset): the same value matched by two anchors or
  // repeated in overlapping chunks must only be stored once.
  const seen = new Set<string>()

  outer:
  for (const chunk of chunks) {
    const chunkText = text.slice(chunk.start_offset, chunk.end_offset)
    const chunkBase = chunk.start_offset
    for (const [re, reName] of rules) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(chunkText)) !== null) {
        const absoluteOffset = chunkBase + m.index
        const dedupeKey = `${reName}\u0000${absoluteOffset}`
        if (seen.has(dedupeKey)) {
          if (m.index === re.lastIndex) re.lastIndex++
          continue
        }
        seen.add(dedupeKey)
        if (fields.length >= MAX_EXTRACTED_FIELDS) break outer
        const isParty = reName === 'party'
        const value = isParty ? (m[2] ?? m[0]).trim() : m[0].trim()
        fields.push({
          field_id: `gcf_${chunkBase}_${absoluteOffset}_${reName}`,
          chunk_id: chunk.chunk_id,
          field_type: reName,
          value,
          quote: m[0].trim().slice(0, 120),
          quote_offset: absoluteOffset,
        })
        if (m.index === re.lastIndex) re.lastIndex++
      }
    }
  }
  return fields
}

// ─── docx extraction ──────────────────────────────────────────────────────

function extractDocxText(buffer: Buffer): string {
  // docx is a zip container; extract word/document.xml and strip tags.
  // adm-zip is a server dependency already used for file handling.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const AdmZip = require('adm-zip')
    const zip = new AdmZip(buffer)
    const entry = zip.getEntry('word/document.xml')
    if (!entry) {
      throw Object.assign(new Error('Not a valid .docx (missing word/document.xml)'), { code: 'doc_docx_invalid', status: 400 })
    }
    const xml = entry.getData().toString('utf-8')
    const withBreaks = xml
      .replace(/<w:p[^>]*>/g, '\n')
      .replace(/<w:br[^>]*\/>/g, '\n')
      .replace(/<w:tab[^>]*\/>/g, '\t')
    const stripped = withBreaks
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    if (!stripped.trim()) {
      throw Object.assign(new Error('docx contains no extractable text'), { code: 'doc_docx_empty', status: 400 })
    }
    return stripped
  } catch (err: any) {
    if (err?.code) throw err
    throw Object.assign(new Error(`Failed to extract .docx text: ${err?.message || err}`), { code: 'doc_docx_invalid', status: 400 })
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────

/**
 * Parse an uploaded document file into text + chunks + rule-extracted fields.
 * Supported: txt / md / docx (text-typed). PDF text extraction is out of MVP
 * scope and returns a clear error. Throws Object.assign(err, {code, status}).
 */
export function parseDocumentFile(filePath: string, fileName: string, tokenBudget = 40000): ParseResult {
  const ext = extname(fileName || '').toLowerCase()
  const buffer = readFileSync(filePath)

  let text: string
  let encoding: GcEncoding
  if (ext === '.docx') {
    text = extractDocxText(buffer)
    encoding = 'utf-8'
  } else if (ext === '.pdf') {
    throw Object.assign(new Error('PDF text extraction is not supported yet'), { code: 'doc_pdf_unsupported', status: 400 })
  } else {
    encoding = sniffEncoding(buffer)
    text = new TextDecoder(encoding === 'gb18030' ? 'gb18030' : encoding === 'gbk' ? 'gbk' : 'utf-8').decode(buffer)
  }

  const chunks = chunkDocument(text, tokenBudget)
  const fields = extractFields(text, chunks)
  return {
    text,
    encoding,
    docType: detectDocType(text, fileName),
    chunks,
    fields,
  }
}
