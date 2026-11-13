/**
 * DOCX extractor — parses the OOXML inside the DOCX ZIP.
 *
 * A .docx file is a ZIP archive containing XML. The main document
 * text lives in `word/document.xml`. We unzip it with `jszip` and
 * walk the XML to extract paragraph text runs.
 *
 * This is a best-effort v1 extractor — no formatting, no tables, no
 * footnotes. Good enough to produce a searchable corpus from most
 * user-authored documents.
 */

import { readFile } from 'fs/promises'
import { ExtractError, countTokens, type ExtractResult } from './index'

// WordprocessingML namespace for the body paragraphs and runs.
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

export async function extractDocx(path: string): Promise<ExtractResult> {
  let buffer: Buffer
  try {
    buffer = await readFile(path)
  } catch (err) {
    throw new ExtractError('io', `Failed to read DOCX file: ${path}`, err)
  }

  // Dynamic import returns the module namespace; the constructor is on
  // the `default` export for CJS→ESM interop. Minimal structural types
  // for the subset of the JSZip API this extractor uses.
  interface JSZipEntry {
    async(type: 'string'): Promise<string>
  }
  interface JSZipInstance {
    file(name: string): JSZipEntry | null
  }
  let JSZip: { loadAsync(data: Buffer | Uint8Array): Promise<JSZipInstance> }
  try {
    const mod = await import('jszip')
    JSZip = (mod.default ?? mod) as { loadAsync(data: Buffer | Uint8Array): Promise<JSZipInstance> }
  } catch (err) {
    throw new ExtractError(
      'unsupported',
      'jszip is not installed. Run: npm install jszip',
      err
    )
  }

  let zip: JSZipInstance
  try {
    zip = await JSZip.loadAsync(buffer)
  } catch (err) {
    throw new ExtractError(
      'corrupt',
      `Failed to unzip DOCX: ${path}`,
      err
    )
  }

  const docXml = zip.file('word/document.xml')
  if (!docXml) {
    throw new ExtractError(
      'corrupt',
      `DOCX missing word/document.xml: ${path}`
    )
  }

  let xmlString: string
  try {
    xmlString = await docXml.async('string')
  } catch (err) {
    throw new ExtractError(
      'corrupt',
      `Failed to read word/document.xml: ${path}`,
      err
    )
  }

  const text = extractTextFromXml(xmlString)
  return { text: text.trim(), tokenCount: countTokens(text.trim()) }
}

/**
 * Minimal XML walker that extracts text from <w:p>/<w:r>/<w:t> chains.
 *
 * Uses a regex-based scanner rather than a full XML parser because the
 * document structure we care about is flat paragraphs of runs of text.
 * This is safe because <w:t> content is always plain text (no nested
 * markup) in valid OOXML.
 */
function extractTextFromXml(xml: string): string {
  const paragraphs: string[] = []

  // Match every <w:p ...>...</w:p> block.
  const pRegex = new RegExp(`<w:p\\b[^>]*>([\\s\\S]*?)</w:p>`, 'g')
  let pMatch
  while ((pMatch = pRegex.exec(xml)) !== null) {
    const pContent = pMatch[1]
    // Collect all <w:t ...>text</w:t> runs inside this paragraph.
    const tRegex = new RegExp(`<w:t\\b[^>]*>([\\s\\S]*?)</w:t>`, 'g')
    const runs: string[] = []
    let tMatch
    while ((tMatch = tRegex.exec(pContent)) !== null) {
      runs.push(decodeXmlEntities(tMatch[1]))
    }
    if (runs.length > 0) {
      paragraphs.push(runs.join(''))
    }
  }

  return paragraphs.join('\n')
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}
