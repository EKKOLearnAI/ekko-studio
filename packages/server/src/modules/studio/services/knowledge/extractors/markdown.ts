/**
 * Markdown extractor — reads raw UTF-8 text.
 *
 * No transformation in v1; the chunker (Task 4) handles heading-aware
 * splitting. Future: optionally strip front-matter, normalize headings.
 */

import { readFile } from 'fs/promises'
import { ExtractError, countTokens, type ExtractResult } from './index'

export async function extractMarkdown(path: string): Promise<ExtractResult> {
  let text: string
  try {
    text = await readFile(path, 'utf-8')
  } catch (err) {
    throw new ExtractError('io', `Failed to read markdown file: ${path}`, err)
  }
  return { text, tokenCount: countTokens(text) }
}
