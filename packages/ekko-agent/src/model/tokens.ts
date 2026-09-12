import { getEncoding } from 'js-tiktoken'

const MAX_PATHOLOGICAL_RUN = 2_000
const MAX_EXACT_TOKEN_TEXT_BYTES = 256 * 1024
const MAX_HEURISTIC_SCAN_TEXT_UNITS = 8 * 1024 * 1024
let cachedEncoder: ReturnType<typeof getEncoding> | null = null

export function countTextTokens(text: string): number {
  if (!text) return 0
  if (exceedsExactTokenBudget(text) || hasPathologicalRun(text)) return heuristicTokens(text)
  try {
    if (!cachedEncoder) cachedEncoder = getEncoding('cl100k_base')
    return cachedEncoder.encode(text).length
  } catch {
    return heuristicTokens(text)
  }
}

function heuristicTokens(text: string): number {
  if (text.length > MAX_HEURISTIC_SCAN_TEXT_UNITS) return text.length * 3
  return Buffer.byteLength(text, 'utf8')
}

function exceedsExactTokenBudget(text: string): boolean {
  if (text.length > MAX_EXACT_TOKEN_TEXT_BYTES) return true
  return text.length > MAX_EXACT_TOKEN_TEXT_BYTES / 3
    && Buffer.byteLength(text, 'utf8') > MAX_EXACT_TOKEN_TEXT_BYTES
}

function hasPathologicalRun(text: string): boolean {
  // The GPT pat_str merges contiguous characters of EACH piece class —
  // letters, digits, other symbols, and whitespace — into a single
  // pre-tokenizer piece. A long run of ANY class (not just letters) becomes
  // one huge piece whose O(n²) BPE merge loop pins the event loop without
  // ever throwing. Track the current class run and bail out past the bound.
  let run = 0
  let cls = -1
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    const next =
      code <= 0x20 ? 0 :
      (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code > 0x2e7f ? 1 :
      code >= 48 && code <= 57 ? 2 :
      3
    if (next === cls) {
      if (++run > MAX_PATHOLOGICAL_RUN) return true
    } else {
      cls = next
      run = 1
    }
  }
  return false
}
