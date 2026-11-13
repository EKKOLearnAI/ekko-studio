/**
 * PDF extractor — uses pdfjs-dist legacy build for Node.js.
 *
 * Reads every page's text content and concatenates with page
 * separators. Heading metadata is not preserved in v1 — the chunker
 * treats it as plain text with page boundaries noted as `\n\n`.
 *
 * pdfjs-dist v5 requires the `legacy` build in Node environments
 * because the default build relies on browser globals (DOMMatrix).
 */

import { readFile } from 'fs/promises'
import { ExtractError, countTokens, type ExtractResult } from './index'

export async function extractPdf(path: string): Promise<ExtractResult> {
  let buffer: Buffer
  try {
    buffer = await readFile(path)
  } catch (err) {
    throw new ExtractError('io', `Failed to read PDF file: ${path}`, err)
  }

  let pdfjs: typeof import('pdfjs-dist/legacy/build/pdf.mjs')
  try {
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  } catch (err) {
    throw new ExtractError(
      'unsupported',
      'pdfjs-dist is not installed. Run: npm install pdfjs-dist',
      err
    )
  }

  let pdfDocument
  let loadingTask: ReturnType<typeof pdfjs.getDocument> | undefined
  try {
    loadingTask = pdfjs.getDocument({
      data: new Uint8Array(buffer),
      useSystemFonts: true,
      stopAtErrors: true,
      isEvalSupported: false,
      useWorkerFetch: false,
    } as Parameters<typeof pdfjs.getDocument>[0])
    pdfDocument = await loadingTask.promise
  } catch (err) {
    throw new ExtractError(
      'corrupt',
      `Failed to parse PDF: ${path}`,
      err
    )
  }

  const pages: string[] = []
  try {
    for (let pageNum = 1; pageNum <= pdfDocument.numPages; pageNum++) {
      const page = await pdfDocument.getPage(pageNum)
      const content = await page.getTextContent()
      const pageText = content.items
        .map(item => ('str' in item ? item.str : ''))
        .join(' ')
      pages.push(pageText)
      page.cleanup()
    }
  } catch (err) {
    throw new ExtractError(
      'corrupt',
      `Failed to extract text from PDF page: ${path}`,
      err
    )
  } finally {
    await loadingTask?.destroy()
  }

  const text = pages.join('\n\n').trim()
  return { text, tokenCount: countTokens(text) }
}
