/**
 * LLM JSON Parsing Utilities
 *
 * Handles unreliable JSON output from large language models.
 * Provides extraction, tolerant parsing, and validation.
 *
 * Based on production-grade patterns for handling LLM JSON:
 * - Extract JSON from text (code blocks, plain objects)
 * - Fix common LLM mistakes (single quotes, missing quotes, trailing commas)
 * - Validate against schema (zod)
 * - Retry on failure
 */

/**
 * Extract JSON string from LLM text output.
 * Handles: ```json code blocks, plain {...} objects
 */
export function extractJSON(text: string): string {
  if (!text || typeof text !== 'string') {
    throw new Error('Invalid text: must be non-empty string')
  }

  const trimmed = text.trim()

  // Extract from ```json ... ``` code block
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim()
  }

  // Extract first {...} object (greedy match for nested objects)
  const objectMatch = trimmed.match(/\{[\s\S]*\}/)
  if (objectMatch) {
    return objectMatch[0]
  }

  // Extract first [...] array (greedy match for nested arrays)
  const arrayMatch = trimmed.match(/\[[\s\S]*\]/)
  if (arrayMatch) {
    return arrayMatch[0]
  }

  throw new Error('No JSON found in text (no code blocks, objects, or arrays detected)')
}

/**
 * Fix common LLM JSON mistakes before parsing.
 * Handles: single quotes, unquoted keys, trailing commas, Python booleans/null
 */
export function fixLLMJSON(jsonStr: string): string {
  if (!jsonStr || typeof jsonStr !== 'string') {
    throw new Error('Invalid JSON string')
  }

  let fixed = jsonStr

  // Fix 1: Python boolean/null literals
  fixed = fixed.replace(/\bTrue\b/g, 'true')
  fixed = fixed.replace(/\bFalse\b/g, 'false')
  fixed = fixed.replace(/\bNone\b/g, 'null')

  // Fix 2: Single quotes to double quotes (but be careful with escaped quotes)
  // This is a simple replacement - works for most cases but may fail on edge cases
  fixed = fixed.replace(/'/g, '"')

  // Fix 3: Unquoted object keys (e.g., {name: "value"} -> {"name": "value"})
  // Match word followed by : (not already quoted)
  fixed = fixed.replace(/(\w+):/g, '"$1":')

  // Fix 4: Trailing commas in objects
  fixed = fixed.replace(/,\s*}/g, '}')

  // Fix 5: Trailing commas in arrays
  fixed = fixed.replace(/,\s*]/g, ']')

  // Fix 6: Remove extra text before/after JSON (common in LLM outputs)
  // Find first { or [ and match to closing bracket
  const firstBrace = fixed.indexOf('{')
  const firstBracket = fixed.indexOf('[')

  if (firstBrace >= 0 && (firstBracket < 0 || firstBrace < firstBracket)) {
    // Object first
    let depth = 0
    let start = firstBrace
    let end = -1
    for (let i = start; i < fixed.length; i++) {
      if (fixed[i] === '{') depth++
      else if (fixed[i] === '}') depth--
      if (depth === 0) {
        end = i + 1
        break
      }
    }
    if (end > 0) fixed = fixed.substring(start, end)
  } else if (firstBracket >= 0) {
    // Array first
    let depth = 0
    let start = firstBracket
    let end = -1
    for (let i = start; i < fixed.length; i++) {
      if (fixed[i] === '[') depth++
      else if (fixed[i] === ']') depth--
      if (depth === 0) {
        end = i + 1
        break
      }
    }
    if (end > 0) fixed = fixed.substring(start, end)
  }

  return fixed
}

/**
 * Parse LLM JSON with fallback attempts.
 * Tries: direct parse -> fixed parse -> extracted parse
 */
export function parseLLMJSON(text: string, retries = 3): any {
  const errors: Error[] = []

  // Attempt 1: Direct parse (already valid JSON)
  try {
    return JSON.parse(text)
  } catch (e) {
    errors.push(e as Error)
  }

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      // Attempt 2: Extract and fix
      const extracted = extractJSON(text)
      const fixed = fixLLMJSON(extracted)
      return JSON.parse(fixed)
    } catch (e) {
      errors.push(e as Error)
      // If extraction failed, try fixing the whole text
      try {
        const fixed = fixLLMJSON(text)
        return JSON.parse(fixed)
      } catch (e2) {
        errors.push(e2 as Error)
      }
    }
  }

  // All attempts failed
  const error = new Error(`Failed to parse LLM JSON after ${retries + 1} attempts`)
  error.cause = errors
  throw error
}

/**
 * Parse LLM JSON with schema validation (zod).
 * Returns validated data or throws validation error.
 */
export async function parseLLMJSONWithSchema<T>(
  text: string,
  schema: { parse: (data: any) => T },
  retries = 3
): Promise<T> {
  const data = parseLLMJSON(text, retries)

  try {
    return schema.parse(data)
  } catch (e) {
    const error = new Error('LLM JSON schema validation failed')
    error.cause = e
    throw error
  }
}

/**
 * Safe parse - returns null on failure instead of throwing.
 * Useful for optional JSON fields in LLM responses.
 */
export function safeParseLLMJSON(text: string): any | null {
  try {
    return parseLLMJSON(text, 1)
  } catch {
    return null
  }
}

/**
 * Parse tool_call arguments from LLM output.
 * Specifically optimized for OpenAI-style tool calls.
 */
export function parseToolArguments(args: string | object): any {
  if (typeof args === 'object') {
    return args // Already parsed
  }

  if (typeof args !== 'string') {
    throw new Error('Invalid arguments: must be string or object')
  }

  const trimmed = args.trim()

  // Handle empty object
  if (trimmed === '{}' || trimmed === '[]') {
    return trimmed === '{}' ? {} : []
  }

  try {
    // Try direct parse first
    return JSON.parse(trimmed)
  } catch {
    // Fall back to LLM JSON parsing
    return parseLLMJSON(trimmed, 2)
  }
}

/**
 * Parse array content from LLM (common in Anthropic-style messages).
 * Handles Python-style arrays with thinking/text/tool_use blocks.
 */
export function parseAnthropicContentArray(content: string): Array<{
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: any
}> {
  if (!content || typeof content !== 'string') {
    return []
  }

  const trimmed = content.trim()

  // Handle double-serialized content: "[{...}]" -> "[{...}]"
  let contentToParse = trimmed
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    contentToParse = trimmed.slice(1, -1)
  }

  if (!contentToParse.startsWith('[') || !contentToParse.endsWith(']')) {
    throw new Error('Content is not an array')
  }

  try {
    // Parse with Python-to-JSON conversion
    const parsed = JSON.parse(
      contentToParse
        .replace(/'/g, '"') // Python single quotes
        .replace(/True/g, 'true')
        .replace(/False/g, 'false')
        .replace(/None/g, 'null')
    )

    if (!Array.isArray(parsed)) {
      throw new Error('Parsed content is not an array')
    }

    return parsed
  } catch (e) {
    // Fall back to full LLM JSON parsing
    const fixed = fixLLMJSON(contentToParse)
    const parsed = JSON.parse(fixed)

    if (!Array.isArray(parsed)) {
      throw new Error('Parsed content is not an array')
    }

    return parsed
  }
}
