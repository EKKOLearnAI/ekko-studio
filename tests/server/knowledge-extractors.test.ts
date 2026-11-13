/**
 * Extractor tests.
 *
 * Fixtures are generated on the fly where the format is trivially
 * constructible (markdown, text). For PDF and DOCX we use `pdf-lib`
 * and a minimal ZIP builder (no external fixture files to maintain).
 *
 * The `extract()` dispatcher is tested with:
 *   - A known extension → returns non-empty text and deterministic
 *     token count.
 *   - An unknown extension → returns metadata-only sentinel.
 *   - A corrupt file → throws ExtractError with kind='corrupt'.
 */

import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import {
  ExtractError,
  countTokens,
  extract,
  getExtractor,
  registerExtractor,
} from '../../packages/server/src/modules/studio/services/knowledge/extractors/index'

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'knowledge-extractors-'))
})

afterEach(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

describe('extractor registry', () => {
  it('returns a metadata-only result for unknown extensions', async () => {
    const unknown = join(tempDir, 'mystery.xyz')
    writeFileSync(unknown, 'content')
    const result = await extract(unknown)
    expect(result.text).toBe('')
    expect(result.tokenCount).toBe(0)
  })

  it('registers a custom extractor', async () => {
    registerExtractor('.custom', async () => ({
      text: 'hello custom',
      tokenCount: 2,
    }))
    const p = join(tempDir, 'thing.custom')
    writeFileSync(p, 'placeholder')
    const result = await extract(p)
    expect(result.text).toBe('hello custom')
  })

  it('getExtractor is case-insensitive', () => {
    expect(typeof getExtractor('.md')).toBe('function')
    expect(typeof getExtractor('.MD')).toBe('function')
  })
})

describe('markdown extractor', () => {
  it('extracts text and counts tokens deterministically', async () => {
    const md = join(tempDir, 'doc.md')
    writeFileSync(
      md,
      '# Heading\n\nSome paragraph text here.\n\n## Sub\n\nMore text.'
    )
    const result = await extract(md)
    expect(result.text).toContain('Heading')
    expect(result.text).toContain('Sub')
    expect(result.tokenCount).toBeGreaterThan(0)
    // Determinism: same content → same count.
    expect(result.tokenCount).toBe(countTokens(result.text))
  })

  it('throws ExtractError io on unreadable file', async () => {
    const missing = join(tempDir, 'missing.md')
    await expect(extract(missing)).rejects.toThrow(ExtractError)
  })
})

describe('plain-text extractor', () => {
  it('reads utf-8 content', async () => {
    const txt = join(tempDir, 'note.txt')
    writeFileSync(txt, 'plain text here')
    const result = await extract(txt)
    expect(result.text).toBe('plain text here')
    expect(result.tokenCount).toBeGreaterThan(0)
  })
})

describe('pdf extractor', () => {
  it('extracts text from a valid PDF', async () => {
    const pdfLib = await import('pdf-lib')
    const pdfDoc = await pdfLib.PDFDocument.create()
    const page = pdfDoc.addPage([200, 200])
    page.drawText('Hello PDF world', { x: 50, y: 150, size: 12 })
    page.drawText('Second line here', { x: 50, y: 130, size: 12 })
    const bytes = await pdfDoc.save()
    const pdfPath = join(tempDir, 'test.pdf')
    writeFileSync(pdfPath, bytes)

    const result = await extract(pdfPath)
    // pdfjs-dist should recover the text content.
    expect(result.text.length).toBeGreaterThan(0)
    expect(result.tokenCount).toBeGreaterThan(0)
  }, 30_000)

  it('throws ExtractError corrupt on invalid PDF', async () => {
    const corrupt = join(tempDir, 'corrupt.pdf')
    writeFileSync(corrupt, 'this is not a pdf')
    await expect(extract(corrupt)).rejects.toThrow(ExtractError)
    try {
      await extract(corrupt)
    } catch (err) {
      expect(err).toBeInstanceOf(ExtractError)
      expect((err as ExtractError).kind).toBe('corrupt')
    }
  })
})

describe('docx extractor', () => {
  it('extracts text from a valid DOCX', async () => {
    const zip = new JSZip()
    zip.file(
      '[Content_Types].xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml"
    ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
    )
    zip.file(
      'word/document.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Hello </w:t></w:r><w:r><w:t>DOCX </w:t></w:r><w:r><w:t>world</w:t></w:r></w:p>
    <w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p>
  </w:body>
</w:document>`
    )
    const docxPath = join(tempDir, 'test.docx')
    const buf = await zip.generateAsync({ type: 'nodebuffer' })
    writeFileSync(docxPath, buf)

    const result = await extract(docxPath)
    expect(result.text).toContain('Hello')
    expect(result.text).toContain('DOCX')
    expect(result.text).toContain('Second paragraph')
    expect(result.tokenCount).toBeGreaterThan(0)
  })

  it('throws ExtractError corrupt on invalid DOCX', async () => {
    const corrupt = join(tempDir, 'corrupt.docx')
    writeFileSync(corrupt, 'not a zip')
    await expect(extract(corrupt)).rejects.toThrow(ExtractError)
    try {
      await extract(corrupt)
    } catch (err) {
      expect(err).toBeInstanceOf(ExtractError)
      expect((err as ExtractError).kind).toBe('corrupt')
    }
  })
})

describe('countTokens', () => {
  it('returns zero for empty string', () => {
    expect(countTokens('')).toBe(0)
  })

  it('matches cl100k_base encoding length', () => {
    // "Hello world" → 2 tokens in cl100k_base.
    expect(countTokens('Hello world')).toBe(2)
  })
})
