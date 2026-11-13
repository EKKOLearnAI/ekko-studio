/**
 * Reverse a specific form of mojibake caused by a legacy backend that read
 * UTF-8 bytes as Latin1 characters and then re-encoded them as UTF-8.
 *
 * Example: the real nickname `白云雨幕` has UTF-8 bytes `E7 99 BD E4 BA 91
 * E9 9B A8 E5 B9 95`. The upstream system read those 12 bytes as Latin1
 * characters (`ç U+0099 ½ ä º U+0091 é U+009B ¨ å ¹ U+0095`) and stored
 * / serialized that 12-character string as UTF-8 again, producing 24 bytes
 * of double-encoded output on the wire.
 *
 * Detection: every codepoint of the input must fit in a single Latin1 byte
 * (≤ 0xFF) and re-encoding the string as latin1 bytes must decode as
 * strict UTF-8 to a string that differs from the input.
 *
 * Returns the recovered string, or null if the input does not match this
 * exact mojibake pattern.
 */
export function reverseDoubleUtf8(value: string | null | undefined): string | null {
  if (!value || value.length === 0) return null
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 0xFF) return null
  }
  const bytes = Buffer.from(value, 'latin1')
  try {
    const reversed = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (reversed === value) return null
    return reversed
  } catch {
    return null
  }
}

/**
 * Apply `reverseDoubleUtf8` to every string-valued field of the input
 * object (shallow). Returns a new object with fixed fields, or the
 * original input when nothing changed.
 */
export function reverseDoubleUtf8Fields<T extends object>(
  obj: T,
): T {
  let changed = false
  const next = { ...(obj as any) } as Record<string, unknown>
  for (const key of Object.keys(obj)) {
    const v = (obj as any)[key]
    if (typeof v === 'string') {
      const fixed = reverseDoubleUtf8(v)
      if (fixed) {
        next[key] = fixed
        changed = true
      }
    }
  }
  return changed ? (next as unknown as T) : obj
}
