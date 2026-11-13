/**
 * Plain-text extractor — reads raw UTF-8 text.
 *
 * Same implementation as markdown in v1; the chunker decides how to
 * split based on the caller's hint.
 */

import { readFile } from 'fs/promises'
import { ExtractError, countTokens, type ExtractResult } from './index'

export async function extractText(path: string): Promise<ExtractResult> {
  let text: string
  try {
    text = await readFile(path, 'utf-8')
  } catch (err) {
    throw new ExtractError('io', `Failed to read text file: ${path}`, err)
  }
  return { text, tokenCount: countTokens(text) }
}
